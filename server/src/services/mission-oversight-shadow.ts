import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { activityLog, agentWakeupRequests, approvals, heartbeatRuns, issueApprovals, issues, missions,
  operatorDecisions, toolExecutionHeartbeats, workflowRecoveryAuthorities, workflowRuns, workflowStepRuns, workflowTerminalDecisions, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { toolProgressPolicySchema } from "@paperclipai/shared";
import { evaluateMissionOversightCadence, type CadenceSnapshot, type CadenceVerdict } from "./mission-oversight-cadence.js";
import { loadExecutionDefinition } from "./workflow/execution-definition.js";
import { classifyStepActivation, resolveEdges } from "./workflow/control-flow/edge-condition.js";
import { buildPredFactsMap, buildStepRunMap } from "./workflow/reconciler-edge-helpers.js";
import { readWorkflowRetryMetadata } from "./workflow/retry-metadata.js";
import { readControlNodeGraceWait } from "./workflow/control-flow/gate-work-product-grace.js";
import { resolveQaStepActiveExecutionTimeoutMs, resolveStepAwareActiveExecutionTimeoutMs } from "./heartbeat-stability.js";
import { loadRevisionBoardWait } from "./missions/revision-board-wait.js";
import { logger } from "../middleware/logger.js";

export const OVERSIGHT_SHADOW_ACTION = "mission.oversight_cadence_shadow_v1";
const NOISE_ISSUE_KINDS = new Set(["mission_main_executor_oversight", "mission_main_executor_unblock"]);
const date = (v: unknown): Date | null => typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v) : null;
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** SELECT-only, repeatable-read snapshot; no held execution locks, no reconciliation.
 * Only typed table columns and existing machine metadata readers are inspected.
 * Missing execution heartbeat is not replaced with an agent's last-completed heartbeat.
 * Legacy heartbeat updatedAt is the existing reaper freshness signal (15m base,
 * raised by explicit step timeout/QA class); it is NEVER a progress timestamp.
 */
export async function readMissionCadenceSnapshot(db: Db, companyId: string, missionId: string): Promise<CadenceSnapshot | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '2000ms'`);
    const [mission] = await tx.select({ id: missions.id, companyId: missions.companyId, status: missions.status, createdAt: missions.createdAt })
      .from(missions).where(and(eq(missions.companyId, companyId), eq(missions.id, missionId)));
    if (!mission || !["active", "planning"].includes(mission.status)) return null;
    const s: CadenceSnapshot = { mission, runs: [], steps: [], heartbeats: [], events: [], waits: [] };
    const runRows = await tx.select().from(workflowRuns).where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.missionId, missionId)))
      .orderBy(asc(workflowRuns.createdAt), asc(workflowRuns.id));
    const runIds = runRows.map((r) => r.id);
    const stepRows = runIds.length ? await tx.select().from(workflowStepRuns).where(inArray(workflowStepRuns.workflowRunId, runIds)) : [];
    const issueRows = await tx.select({ id: issues.id, status: issues.status, originKind: issues.originKind,
      createdAt: issues.createdAt, startedAt: issues.startedAt, completedAt: issues.completedAt })
      .from(issues).where(and(eq(issues.companyId, companyId), eq(issues.missionId, missionId), isNull(issues.hiddenAt)));
    const workIssues = issueRows.filter((i) => !NOISE_ISSUE_KINDS.has(i.originKind));
    const workIds = workIssues.map((i) => i.id), allIds = issueRows.map((i) => i.id);
    const events = await tx.select({ id: workflowTransitionEvents.id, at: workflowTransitionEvents.createdAt,
      type: workflowTransitionEvents.eventType, layer: workflowTransitionEvents.layer,
      fromStatus: workflowTransitionEvents.fromStatus, toStatus: workflowTransitionEvents.toStatus,
      stepId: workflowTransitionEvents.workflowStepRunId, transitionVersion: sql<number | null>`${workflowTransitionEvents.payload}->>'transitionVersion'` })
      .from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.companyId, companyId),
        or(eq(workflowTransitionEvents.missionId, missionId), ...(runIds.length ? [inArray(workflowTransitionEvents.workflowRunId, runIds)] : []))))
      .orderBy(asc(workflowTransitionEvents.createdAt), asc(workflowTransitionEvents.id));
    s.events = events.map(({ stepId: _step, transitionVersion: _version, ...event }) => event);
    const decisions = await tx.select({ id: operatorDecisions.id, issueId: operatorDecisions.issueId, status: operatorDecisions.status })
      .from(operatorDecisions).where(and(eq(operatorDecisions.companyId, companyId), eq(operatorDecisions.status, "pending"),
        or(sql`${operatorDecisions.sourceContext}->>'missionId' = ${missionId}`,
          ...(allIds.length ? [inArray(operatorDecisions.issueId, allIds)] : []))));
    const approvalRows = workIds.length ? await tx.select({ id: approvals.id, issueId: issueApprovals.issueId,
      status: approvals.status, decidedAt: approvals.decidedAt }).from(issueApprovals).innerJoin(approvals, eq(approvals.id, issueApprovals.approvalId))
      .where(and(eq(approvals.companyId, companyId), inArray(issueApprovals.issueId, workIds))) : [];
    const waitingIssueIds = new Set(decisions.map((d) => d.issueId).filter((id): id is string => id !== null));
    for (const a of approvalRows) {
      const pending = ["pending", "revision_requested"].includes(a.status);
      if (pending) waitingIssueIds.add(a.issueId);
      if (pending || a.decidedAt) s.waits.push({ id: a.id, kind: "approval", until: null, satisfiedAt: pending ? null : a.decidedAt });
    }
    for (const d of decisions) s.waits.push({ id: d.id, kind: "operator_decision", until: null, satisfiedAt: null });
    const boardWait = await loadRevisionBoardWait(tx as unknown as Db, companyId, missionId);
    if (boardWait) s.waits.push({ id: boardWait.planArtifactId, kind: "approval", until: null, satisfiedAt: null });
    const replacements = runIds.length ? await tx.select({ id: workflowRecoveryAuthorities.workflowRunId }).from(workflowRecoveryAuthorities)
      .where(and(eq(workflowRecoveryAuthorities.companyId, companyId), inArray(workflowRecoveryAuthorities.workflowRunId, runIds),
        eq(workflowRecoveryAuthorities.recoveryKind, "replacement_from_start_v1"))) : [];
    const terminalDecisions = runIds.length ? await tx.select({ runId: workflowTerminalDecisions.workflowRunId,
      version: workflowTerminalDecisions.decidedAuthorityVersion, at: workflowTerminalDecisions.createdAt }).from(workflowTerminalDecisions)
      .where(and(eq(workflowTerminalDecisions.companyId, companyId), inArray(workflowTerminalDecisions.workflowRunId, runIds))) : [];
    const latestByWorkflow = new Map(runRows.map((r) => [r.workflowId, r.id]));
    const currentRuns = new Set(runRows.filter((r) => !replacements.some((p) => p.id === r.id)
      && (["running", "pending"].includes(r.status) || latestByWorkflow.get(r.workflowId) === r.id)).map((r) => r.id));
    const timeoutByStep = new Map<string, number>();
    for (const r of runRows) {
      const current = currentRuns.has(r.id);
      const rows = stepRows.filter((step) => step.workflowRunId === r.id);
      const childWait = current && r.status === "pending" && !r.childStartMaterializedAt ? r.childStartDeadlineAt : null;
      if (childWait) s.waits.push({ id: r.id, kind: "child_start", until: childWait, satisfiedAt: null });
      s.runs.push({ id: r.id, status: r.status, version: r.dispatchAuthorityVersion, current,
        createdAt: r.createdAt, startedAt: r.startedAt,
        readySince: current && r.status === "pending" && rows.length === 0 && !childWait ? r.createdAt : null,
        completedAt: r.completedAt ? terminalDecisions.find((d) => d.runId === r.id && d.version === r.dispatchAuthorityVersion)?.at ?? r.completedAt : null });
      const definition = await loadExecutionDefinition(tx, r.id, { requireHistorical: false });
      const preds = buildPredFactsMap(definition.steps, buildStepRunMap(rows));
      for (const step of rows) {
        const def = definition.steps.find((d) => d.id === step.stepId);
        // Never use labels/names/prose to decide timeout class.
        timeoutByStep.set(step.id, resolveStepAwareActiveExecutionTimeoutMs({ baseMs: 15 * 60_000,
          contract: { stepTimeoutSeconds: def?.timeoutSeconds, isQaStep: def?.qaType === "semantic" || def?.qaType === "structural" },
          qaStepActiveExecutionTimeoutMs: resolveQaStepActiveExecutionTimeoutMs() }));
        const retry = readWorkflowRetryMetadata(step.metadata.workflowRetry);
        const grace = readControlNodeGraceWait(step.metadata);
        const waitUntil = retry?.state === "waiting" ? date(retry.nextEligibleAt) : date(grace?.nextEvaluateAt);
        const waiting = current && ((step.issueId !== null && waitingIssueIds.has(step.issueId)) || waitUntil !== null);
        if (current && waitUntil) s.waits.push({ id: step.id, kind: retry ? "retry_backoff" : "control_node_grace", until: waitUntil, satisfiedAt: null });
        const transition = events.find((e) => e.stepId === step.id && e.type === "workflow_step_status_transition"
          && Number(e.transitionVersion) === step.statusTransitionVersion && e.toStatus === step.status);
        const completedAt = transition?.at ?? step.completedAt;
        // Readiness is the actual forward dependency predicate, not pending status alone.
        const ready = current && step.status === "pending" && !waiting && def && def.triggerOn !== "escalation"
          && classifyStepActivation(def, preds).runnable;
        const dependencies = def ? resolveEdges(def).filter((edge) => !edge.isBackEdge).map((edge) => rows.find((sr) => sr.stepId === edge.stepId)) : [];
        const retryEvent = events.filter((e) => e.stepId === step.id && e.type === "workflow_step_retry_scheduled").at(-1);
        const readySince = ready ? new Date(Math.max(r.createdAt.getTime(), retryEvent?.at.getTime() ?? 0,
          ...approvalRows.filter((a) => a.issueId === step.issueId).map((a) => a.decidedAt?.getTime() ?? 0),
          ...dependencies.map((p) => events.find((e) => e.stepId === p?.id && Number(e.transitionVersion) === p?.statusTransitionVersion)?.at.getTime()
            ?? p?.completedAt?.getTime() ?? 0))) : null;
        const result = record(step.metadata.toolResult), resultAt = date(result.completedAt);
        if (resultAt && typeof result.success === "boolean" && typeof result.requestId === "string" && result.requestId === step.lastDispatchRequestId) {
          s.events.push({ id: `tool-result:${step.id}:${result.requestId}`, at: resultAt, type: "tool_result", layer: "workflow_tool",
            fromStatus: null, toStatus: result.success ? "succeeded" : "failed" });
        }
        s.steps.push({ id: step.id, status: step.status, version: step.statusTransitionVersion, generation: step.executionGeneration,
          retryCount: step.retryCount, iterationIndex: step.iterationIndex, startedAt: step.startedAt, completedAt,
          current, readySince, waiting });
      }
    }
    // Mission-only wakes (including the monitor's real periodic-review path) and
    // issue-less typed workflow heartbeats must not vanish at an issue-only join.
    const hbs = await tx.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, issueId: heartbeatRuns.issueId, status: heartbeatRuns.status,
      observedAt: heartbeatRuns.updatedAt, createdAt: heartbeatRuns.createdAt, startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt,
      stepId: heartbeatRuns.workflowStepRunId, generation: heartbeatRuns.workflowExecutionGeneration,
      wakeupRequestId: heartbeatRuns.wakeupRequestId, wakeReason: agentWakeupRequests.reason })
      .from(heartbeatRuns).leftJoin(agentWakeupRequests, and(eq(agentWakeupRequests.id, heartbeatRuns.wakeupRequestId), eq(agentWakeupRequests.companyId, companyId)))
      .where(and(eq(heartbeatRuns.companyId, companyId), or(
        and(isNull(heartbeatRuns.issueId), eq(agentWakeupRequests.missionId, missionId)),
        ...(allIds.length ? [inArray(heartbeatRuns.issueId, allIds)] : []),
        ...(stepRows.length ? [inArray(heartbeatRuns.workflowStepRunId, stepRows.map((sr) => sr.id))] : []))))
      .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id));
    const group = (hb: typeof hbs[number]) => hb.stepId ?? hb.issueId ?? hb.agentId;
    const latestHb = new Map(hbs.map((hb) => [group(hb), hb.id]));
    const observe = (id: string, at: Date) => s.events.push({ id, at, type: "owner_diagnosis", layer: "mission_owner_supervision", fromStatus: null, toStatus: null });
    for (const hb of hbs) {
      if (hb.wakeReason === "mission_owner_periodic_review" || issueRows.some((i) => i.id === hb.issueId && NOISE_ISSUE_KINDS.has(i.originKind))) {
        observe(`heartbeat-observation:${hb.id}`, hb.observedAt); continue;
      }
      const step = stepRows.find((sr) => sr.id === hb.stepId || (!hb.stepId && hb.issueId !== null && sr.issueId === hb.issueId && currentRuns.has(sr.workflowRunId)));
      const issue = workIssues.find((i) => i.id === hb.issueId);
      const current = (!hb.stepId || Boolean(step)) && (["queued", "running"].includes(hb.status) || latestHb.get(group(hb)) === hb.id)
        && !["done", "cancelled"].includes(issue?.status ?? "")
        && (!step || (currentRuns.has(step.workflowRunId) && (hb.generation === null || hb.generation === step.executionGeneration)
          && (step.startedAt === null || hb.createdAt >= step.startedAt) && readWorkflowRetryMetadata(step.metadata.workflowRetry)?.state !== "waiting"));
      s.heartbeats.push({ id: hb.id, status: hb.status, current, stepId: step?.id ?? null,
        observedAt: hb.status === "queued" ? hb.createdAt : hb.observedAt, startedAt: hb.startedAt, finishedAt: hb.finishedAt,
        allowedIntervalMs: timeoutByStep.get(step?.id ?? "") ?? 15 * 60_000, waiting: hb.issueId !== null && waitingIssueIds.has(hb.issueId) });
    }
    // Typed requests prove queue admission before a heartbeat row exists. The
    // exact machine reason code below is emitted by app.ts, not parsed prose.
    const wakes = await tx.select({ id: agentWakeupRequests.id, issueId: agentWakeupRequests.issueId, reason: agentWakeupRequests.reason,
      stepId: agentWakeupRequests.workflowStepRunId, generation: agentWakeupRequests.workflowExecutionGeneration,
      requestedAt: agentWakeupRequests.requestedAt }).from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.missionId, missionId), inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"])));
    for (const wake of wakes) {
      if (wake.reason === "mission_owner_periodic_review" || (wake.issueId !== null && !workIds.includes(wake.issueId))) {
        observe(`wake-observation:${wake.id}`, wake.requestedAt); continue;
      }
      if (hbs.some((hb) => hb.wakeupRequestId === wake.id)) continue;
      const step = s.steps.find((sr) => sr.id === wake.stepId);
      if (wake.stepId && (!step?.current || wake.generation !== step.generation)) continue;
      s.heartbeats.push({ id: wake.id, stepId: wake.stepId, status: "queued", current: true, observedAt: wake.requestedAt,
        startedAt: null, finishedAt: null, allowedIntervalMs: 15 * 60_000, waiting: wake.issueId !== null && waitingIssueIds.has(wake.issueId) });
    }
    for (const issue of workIssues.filter((i) => !stepRows.some((sr) => sr.issueId === i.id))) {
      if (!["todo", "in_progress", "blocked"].includes(issue.status)) continue;
      s.steps.push({ id: issue.id, status: issue.status === "todo" ? "pending" : issue.status === "blocked" ? "blocked" : "running", version: 0, generation: 0,
        retryCount: 0, iterationIndex: 0, current: true, startedAt: issue.startedAt, completedAt: issue.completedAt,
        readySince: issue.status === "todo" ? new Date(Math.max(issue.createdAt.getTime(),
          ...approvalRows.filter((a) => a.issueId === issue.id).map((a) => a.decidedAt?.getTime() ?? 0))) : null, waiting: waitingIssueIds.has(issue.id) });
      for (const hb of s.heartbeats.filter((h) => hbs.some((raw) => raw.id === h.id && raw.issueId === issue.id))) hb.stepId = issue.id;
    }
    const tools = runIds.length ? await tx.select({ id: toolExecutionHeartbeats.id, stepId: toolExecutionHeartbeats.stepRunId,
      generation: toolExecutionHeartbeats.executionGeneration, retryCount: toolExecutionHeartbeats.retryCount, iterationIndex: toolExecutionHeartbeats.iterationIndex,
      state: toolExecutionHeartbeats.state, startedAt: toolExecutionHeartbeats.startedAt, observedAt: toolExecutionHeartbeats.lastProgressAt,
      finishedAt: toolExecutionHeartbeats.finishedAt, policy: toolExecutionHeartbeats.policy }).from(toolExecutionHeartbeats)
      .where(and(eq(toolExecutionHeartbeats.companyId, companyId), inArray(toolExecutionHeartbeats.workflowRunId, runIds))) : [];
    for (const tool of tools) {
      const step = s.steps.find((sr) => sr.id === tool.stepId);
      const policy = toolProgressPolicySchema.parse(tool.policy);
      s.heartbeats.push({ id: tool.id, stepId: tool.stepId, status: tool.state === "active" ? "running" : tool.state,
        current: Boolean(step?.current && step.generation === tool.generation && step.retryCount === tool.retryCount && step.iterationIndex === tool.iterationIndex),
        observedAt: tool.observedAt, startedAt: tool.startedAt, finishedAt: tool.finishedAt,
        allowedIntervalMs: Math.min(policy.idleTimeoutMs, tool.startedAt.getTime() + policy.maxDurationMs - tool.observedAt.getTime()) });
    }
    return s;
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** Existing structured audit stream, isolated entity type (not mission/issue), no
 * live/plugin events. Deterministic UUID primary key + ON CONFLICT DO NOTHING:
 * exactly one immutable verdict per company/mission/5m tick/input fingerprint.
 * Different ticks retain separate observations; same-tick changed inputs retain
 * separate generations. No migration/db:migrate required. Fingerprints exclude
 * shadow records, so the observer cannot invalidate its own input generation.
 */
export async function persistMissionCadenceShadow(db: Db, s: CadenceSnapshot, sweepAt: Date, verdict: CadenceVerdict): Promise<void> {
  const sweepTick = Math.floor(sweepAt.getTime() / (5 * 60_000));
  const hex = createHash("sha256").update(JSON.stringify([OVERSIGHT_SHADOW_ACTION, s.mission.companyId,
    s.mission.id, sweepTick, verdict.inputGeneration.fingerprint])).digest("hex");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '2000ms'`);
    await tx.execute(sql`set local lock_timeout = '2000ms'`);
    await tx.insert(activityLog).values({ id, companyId: s.mission.companyId, actorType: "system", actorId: "mission-oversight-shadow",
      action: OVERSIGHT_SHADOW_ACTION, entityType: "mission_oversight_shadow", entityId: s.mission.id,
      details: { ...verdict, companyId: s.mission.companyId, missionId: s.mission.id, sweepTick, sweepAt: sweepAt.toISOString() }, createdAt: sweepAt })
      .onConflictDoNothing({ target: activityLog.id });
  });
}

export async function recordActiveMissionCadenceShadow(db: Db, sweepAt: Date): Promise<void> {
  const active = await db.select({ id: missions.id, companyId: missions.companyId }).from(missions)
    .where(inArray(missions.status, ["active", "planning"]));
  for (const mission of active) {
    try {
      const snapshot = await readMissionCadenceSnapshot(db, mission.companyId, mission.id);
      if (snapshot) await persistMissionCadenceShadow(db, snapshot, sweepAt, evaluateMissionOversightCadence(snapshot, sweepAt));
    } catch (err) {
      // A bad input/store for one mission cannot prevent observations of others.
      logger.warn({ err, missionId: mission.id }, "Mission oversight cadence shadow mission observation failed");
    }
  }
}

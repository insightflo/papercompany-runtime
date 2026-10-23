import { and, eq, or, sql } from "drizzle-orm";
import { heartbeatRuns, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import type { MissionRow, MissionServiceDeps } from "../missions.js";
import type { WorkflowStep } from "../workflow/dag-engine.js";
import type { IssueCreateInput, IssueRow } from "./shared-types.js";
import { classifyToolStepFailure, getWorkflowStepToolNames } from "./tool-step-failure.js";
import { buildToolStepRecoveryDescription } from "./tool-step-recovery-description.js";
import { conflict } from "../../errors.js";
import { toolRecoveryOwnsStepFailure } from "./tool-step-recovery-authority.js";
import { lockOwnerHumanRequestAuthority, readOwnerToolIdentity } from "./owner-human-request-authority.js";
import { loadLatestMissionOwnerDecision } from "./mission-owner-recovery-ledger.js";
import { ownerDecisionRequestsHuman } from "./owner-tool-recovery-eligibility.js";
import { ownerHumanCurrentKey, ownerHumanCurrentSchema, ownerHumanLifetimeSchema,
  sameOwnerHumanValue } from "./owner-human-request-contract.js";
import { readOwnerHumanCurrent } from "./owner-human-request-state.js";
import { renewOwnerHumanRequestWithCard } from "./owner-human-request-renew.js";
import { logger } from "../../middleware/logger.js";
import { loadToolRecoveryBriefFacts } from "./tool-recovery-brief-facts.js";

/** Identity link only, not permission to execute. Creation and link commit together. */
export async function ensureToolRecoveryCard(db: Db, deps: MissionServiceDeps, input: {
  mission: MissionRow; oversightIssue: IssueRow; run: typeof workflowRuns.$inferSelect;
  stepRun: typeof workflowStepRuns.$inferSelect; step: WorkflowStep | null; workflowName: string;
}, createIssue: (tx: Db, companyId: string, data: IssueCreateInput) => Promise<IssueRow>) {
  const fail = (): never => { throw conflict("Tool recovery card authority mismatch"); };
  const result = await db.transaction(async (tx) => {
    const [mission] = await tx.select().from(missions).where(and(eq(missions.id, input.mission.id),
      eq(missions.companyId, input.mission.companyId))).for("update");
    if (!mission || !mission.ownerAgentId || mission.ownerAgentId !== input.mission.ownerAgentId
      || ["completed", "cancelled"].includes(mission.status)) return fail();
    const [run] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, input.run.id)).for("update");
    if (!run || run.companyId !== mission.companyId || run.missionId !== mission.id
      || run.workflowId !== input.run.workflowId) return fail();
    const [definition] = await tx.select().from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, run.workflowId)).for("share");
    // Discover by all identity columns, including damaged headers. Never limit to the first link.
    const links = await tx.select().from(workflowTransitionEvents).where(and(
      or(eq(workflowTransitionEvents.workflowStepRunId, input.stepRun.id),
        sql`${workflowTransitionEvents.payload}->>'stepRunId' = ${input.stepRun.id}`,
        eq(workflowTransitionEvents.idempotencyKey, `owner-tool-card:${input.stepRun.id}`),
        sql`${workflowTransitionEvents.idempotencyKey} like ${`owner-tool-card:v2:${input.stepRun.id}:%`}`),
      or(eq(workflowTransitionEvents.eventType, "owner_tool_recovery_target_v1"),
        sql`${workflowTransitionEvents.payload}->>'kind' = 'tool_step'`,
        sql`${workflowTransitionEvents.idempotencyKey} like 'owner-tool-card:%'`)));
    if (links.some((link) => !link.issueId)) return fail();
    const scope = { companyId: mission.companyId, missionId: mission.id,
      target: { kind: "tool_step" as const, workflowRunId: run.id, stepRunId: input.stepRun.id } };
    const pointers = await tx.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, mission.companyId),
      or(eq(workflowTransitionEvents.idempotencyKey, ownerHumanCurrentKey(scope)), and(
        eq(workflowTransitionEvents.eventType, "owner_human_current_v1"),
        sql`${workflowTransitionEvents.payload}->'scope' = ${JSON.stringify(scope)}::jsonb`))));
    if (pointers.length > 1) return fail();
    const pointerRow = pointers[0];
    const pointer = pointerRow ? ownerHumanCurrentSchema.safeParse(pointerRow.payload) : null;
    if (pointer && (!pointer.success || !sameOwnerHumanValue(pointer.data.scope, scope))) return fail();
    const [origin] = pointer?.success ? await tx.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.id, pointer.data.lifetimeId)) : [];
    const lifetime = pointer?.success ? ownerHumanLifetimeSchema.safeParse(origin?.payload) : null;
    if (lifetime && !lifetime.success) return fail();
    if (!pointerRow) {
      const [orphan] = await tx.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, mission.companyId),
        eq(workflowTransitionEvents.eventType, "owner_human_lifetime_v1"),
        sql`${workflowTransitionEvents.payload}->'scope' = ${JSON.stringify(scope)}::jsonb`)).limit(1);
      if (orphan) return fail();
    }
    const heartbeat = lifetime?.success ? (await tx.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, lifetime.data.heartbeatRunId)).for("share"))[0] : undefined;
    if (lifetime?.success && !heartbeat) return fail();
    const locked = new Map<string, IssueRow>();
    const issueIds = [input.oversightIssue.id, ...links.map((link) => link.issueId!)];
    for (const id of [...new Set(issueIds)].sort()) {
      const [row] = await tx.select().from(issues).where(eq(issues.id, id)).for("update");
      if (!row || row.companyId !== mission.companyId || row.missionId !== mission.id) return fail();
      locked.set(id, row);
    }
    const source = locked.get(input.oversightIssue.id)!;
    if (source.hiddenAt || source.originKind !== "mission_main_executor_oversight"
      || source.assigneeAgentId !== mission.ownerAgentId || ["done", "cancelled"].includes(source.status)) return fail();
    const [stepRun] = await tx.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, input.stepRun.id)).for("update");
    const steps = Array.isArray(definition?.stepsJson) ? definition.stepsJson as WorkflowStep[] : [];
    const matching = steps.filter((step) => step?.id === stepRun?.stepId), step = matching[0] ?? null;
    if (!definition || definition.companyId !== mission.companyId || matching.length !== 1 || !stepRun
      || stepRun.workflowRunId !== run.id || input.stepRun.workflowRunId !== run.id || stepRun.stepId !== input.stepRun.stepId
      || input.run.companyId !== mission.companyId || input.run.missionId !== mission.id) return fail();
    const anchors: IssueRow[] = [];
    for (const link of links.sort((a, b) => String(a.issueId).localeCompare(String(b.issueId)))) {
      const anchor = locked.get(link.issueId!);
      const identity = await readOwnerToolIdentity(tx, mission.companyId, mission.id, link.issueId!);
      if (!anchor || !identity || identity.workflowRunId !== run.id || identity.stepRunId !== stepRun.id
        || identity.sourceIssueId !== source.id || anchor.hiddenAt || anchor.assigneeAgentId !== mission.ownerAgentId
        || anchors.some((old) => old.id === anchor.id)) return fail();
      anchors.push(anchor);
    }
    const open = anchors.filter((anchor) => !["done", "cancelled"].includes(anchor.status));
    if (open.length > 1) return fail();
    const classification = classifyToolStepFailure(input.step, stepRun), toolNames = getWorkflowStepToolNames(input.step);
    let current: Awaited<ReturnType<typeof readOwnerHumanCurrent>> = null;
    if (pointer?.success && lifetime?.success) {
      if (!heartbeat?.issueId || !anchors.some((anchor) => anchor.id === pointer.data.anchorIssueId)
        || !anchors.some((anchor) => anchor.id === heartbeat.issueId)) return fail();
      const auth = await lockOwnerHumanRequestAuthority(tx, { companyId: mission.companyId, missionId: mission.id,
        agentId: mission.ownerAgentId, ownerActionIssueId: heartbeat.issueId,
        heartbeatRunId: lifetime.data.heartbeatRunId, recoveryTarget: lifetime.data.submission.recoveryTarget, purpose: "settle" });
      current = await readOwnerHumanCurrent(auth);
      if (!current || current.lifetime.authorAgentId !== mission.ownerAgentId
        || current.lifetime.sourceIssueId !== source.id) return fail();
    }
    if (open.length === 1) {
      if (current?.pointer.recoveryNeeded && current.pointer.anchorIssueId !== open[0]!.id) return fail();
      return { issue: open[0]!, created: false, classification, toolNames };
    }
    if (!current && anchors.length) {
      const decided: Array<{ issue: IssueRow; human: boolean }> = [];
      for (const anchor of anchors) {
        const decision = await loadLatestMissionOwnerDecision({ db: tx, companyId: mission.companyId,
          ownerActionIssueId: anchor.id });
        if (!decision) continue;
        if (decision.authorAgentId !== mission.ownerAgentId || decision.missionId !== mission.id
          || decision.sourceIssueId !== source.id) return fail();
        decided.push({ issue: anchor, human: ownerDecisionRequestsHuman(decision.decision.decision) });
      }
      if (decided.some((entry) => entry.human) || decided.length > 1) return fail();
      if (decided.length === 1) return { issue: decided[0]!.issue, created: false, classification, toolNames };
    }
    const recurring = anchors.length > 0;
    if (recurring && (run.status !== "failed" || run.dispatchAuthorityVersion !== input.run.dispatchAuthorityVersion
      || stepRun.statusTransitionVersion !== input.stepRun.statusTransitionVersion
      || stepRun.executionGeneration !== input.stepRun.executionGeneration
      || stepRun.lastDispatchRequestId !== input.stepRun.lastDispatchRequestId
      || input.step?.id !== step?.id || !toolRecoveryOwnsStepFailure(step, stepRun))) return fail();
    const fresh = recurring
      ? { mission, oversightIssue: source, run, stepRun, step: input.step, workflowName: definition.name }
      : { mission, oversightIssue: source, run: input.run, stepRun: input.stepRun,
        step: input.step, workflowName: input.workflowName };
    // All optional context reads use nested SAVEPOINTs in this creation transaction.
    const facts = await loadToolRecoveryBriefFacts(tx as unknown as Db, fresh);
    const issue = await createIssue(tx as unknown as Db, mission.companyId, {
      assigneeAgentId: mission.ownerAgentId,
      description: buildToolStepRecoveryDescription({ marker: `tool-step-recovery:${run.id}:${stepRun.stepId}`,
        missionTitle: mission.title, workflowName: definition.name, workflowRunId: run.id,
        stepId: stepRun.stepId, displayStepName: input.step?.name?.trim() || stepRun.stepId, toolNames, classification, facts }),
      missionId: mission.id, originKind: "mission_main_executor_unblock", originId: source.id,
      parentId: source.parentId ? undefined : source.id,
      priority: "high", status: "todo", title: `[Owner Action] Tool step failed: ${stepRun.stepId}`,
    });
    const [link] = await tx.insert(workflowTransitionEvents).values({ companyId: mission.companyId, missionId: mission.id,
      issueId: issue.id, workflowRunId: run.id, workflowStepRunId: stepRun.id,
      layer: "mission_owner_recovery", eventType: "owner_tool_recovery_target_v1",
      idempotencyKey: recurring ? `owner-tool-card:v2:${stepRun.id}:${issue.id}` : `owner-tool-card:${stepRun.id}`,
      payload: recurring ? { schemaVersion: 2, kind: "tool_step", companyId: mission.companyId, missionId: mission.id,
        anchorIssueId: issue.id, sourceIssueId: source.id, workflowRunId: run.id, stepRunId: stepRun.id }
        : { schemaVersion: 1, kind: "tool_step", workflowRunId: run.id, stepRunId: stepRun.id } }).returning();
    if (!link || !await readOwnerToolIdentity(tx, mission.companyId, mission.id, issue.id)
      || issue.originId !== source.id || issue.assigneeAgentId !== mission.ownerAgentId || issue.hiddenAt
      || ["done", "cancelled"].includes(issue.status)) return fail();
    if (current?.pointer.recoveryNeeded) {
      await renewOwnerHumanRequestWithCard(tx, { companyId: mission.companyId,
        previousLifetimeId: current.lifetime.lifetimeId, anchorIssueId: issue.id,
        requestKey: `owner-tool-renewal:v2:${stepRun.id}:${issue.id}` });
    }
    return { issue, created: true, classification, toolNames };
  });
  if (result.created && deps.onOwnerActionCreated) {
    void Promise.resolve(deps.onOwnerActionCreated({ mission: input.mission, issue: result.issue,
      sourceIssue: input.oversightIssue, reason: "tool_step_failure_recovery_created" }))
      .catch((err) => logger.warn({ err, issueId: result.issue.id }, "failed to notify owner about tool recovery"));
  }
  return result;
}

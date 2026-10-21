// C04: called only inside the transaction that consumed the official recovery authority.
// Historical booleans are not causes: adopt only a snapshot-backed, current transition chain.
import { and, eq, inArray } from "drizzle-orm";
import {
  issues, workflowRecoveryAuthorities, workflowRunDefinitions, workflowRuns,
  workflowStepRuns, workflowTerminalDecisions, workflowTransitionEvents, type Db,
} from "@paperclipai/db";
import { loadExecutionDefinition } from "./execution-definition.js";
import { resolveEdges } from "./control-flow/edge-condition.js";
import { reviveConditionalSkip } from "./conditional-skip-settlement.js";
import { WORKFLOW_SYNC_SOURCES } from "./workflow-sync-source.js";
import { orderedGraph, permitsRecordedCascadeRecovery } from "./failure-cascade-provenance.js";
import type { WorkflowRecoveryAuthorityRow } from "./run-recovery-authority.js";

type Step = typeof workflowStepRuns.$inferSelect;
type Run = typeof workflowRuns.$inferSelect;
type Event = typeof workflowTransitionEvents.$inferSelect;

function unlaunched(row: Step): boolean {
  return row.startedAt === null && row.lastDispatchAttemptAt === null
    && row.lastDispatchAcceptedAt === null && row.lastDispatchRequestId === null
    && row.dispatchOwnerWakeupRequestId === null && row.dispatchOwnerHeartbeatRunId === null
    && row.evidenceReadyAt === null && row.metadata?.toolResult == null;
}

/** Missing/ambiguous history is deliberately not upgraded into a failure cause. */
function currentTransition(events: Event[], run: Run, row: Step): Event | undefined {
  if (row.statusTransitionVersion < 1) return undefined;
  const matches = events.filter(event => event.eventType === "workflow_step_status_transition"
    && event.layer === "workflow_sync" && event.missionId === run.missionId
    && WORKFLOW_SYNC_SOURCES.some(source => source === event.reasonCode)
    && event.workflowStepRunId === row.id && event.issueId === row.issueId
    && event.toStatus === row.status && typeof event.fromStatus === "string" && event.fromStatus !== row.status
    && event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload)
    && event.payload.priorStatus === event.fromStatus && event.payload.source === event.reasonCode
    && event.payload.transitionVersion === row.statusTransitionVersion
    && event.idempotencyKey === `wf-step-status:${row.id}:${row.status}:${row.statusTransitionVersion}`
    && (event.executionGeneration === null || event.executionGeneration === row.executionGeneration - 1));
  const event = matches.length === 1 ? matches[0] : undefined;
  if (!event || events.some(later => later.eventType === "workflow_authority_transition"
    && later.workflowStepRunId === row.id && later.createdAt >= event.createdAt
    && (later.payload?.transition === "generation_advanced" || later.reasonCode === "workflow_resume_reset"
      || (later.executionGeneration !== null && later.executionGeneration !== row.executionGeneration - 1)))) return undefined;
  return event;
}

export async function reviveAuthorizedFailureCascade(db: Db, input: {
  observedRun: Run; failedStep: Step; authority: WorkflowRecoveryAuthorityRow;
}): Promise<void> {
  const { observedRun, failedStep, authority } = input;
  const fail = (): never => { throw new Error("failure_cascade_recovery_proof_lost"); };
  async function readCurrent() {
    const [run] = await db.select().from(workflowRuns).where(and(
      eq(workflowRuns.id, observedRun.id), eq(workflowRuns.companyId, observedRun.companyId),
    )).for("update");
    if (!run || run.status !== "running" || run.missionId !== observedRun.missionId
      || run.dispatchAuthorityVersion !== authority.resultingAuthorityVersion) return fail();
    const rows = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, run.id))
      .orderBy(workflowStepRuns.stepId, workflowStepRuns.id).for("update");
    return { run, rows };
  }
  const { run, rows } = await readCurrent();
  const [receipt] = await db.select().from(workflowRecoveryAuthorities).where(and(
    eq(workflowRecoveryAuthorities.id, authority.id), eq(workflowRecoveryAuthorities.companyId, run.companyId),
    eq(workflowRecoveryAuthorities.workflowRunId, run.id), eq(workflowRecoveryAuthorities.status, "consumed"),
  ));
  const target = rows.find(row => row.id === failedStep.id);
  if (!receipt || receipt.targetAuthorityVersion !== observedRun.dispatchAuthorityVersion
    || receipt.resultingAuthorityVersion !== run.dispatchAuthorityVersion
    || receipt.resultingAuthorityVersion !== receipt.targetAuthorityVersion + 1
    || receipt.targetDecisionId !== authority.targetDecisionId || !receipt.consumedAt
    || observedRun.status !== "failed" || failedStep.workflowRunId !== run.id || failedStep.status !== "failed"
    || !target || target.stepId !== failedStep.stepId || target.issueId !== failedStep.issueId
    || target.status !== "failed" || target.statusTransitionVersion !== failedStep.statusTransitionVersion
    || target.executionGeneration !== failedStep.executionGeneration + 1
    || target.lastDispatchRequestId !== failedStep.lastDispatchRequestId) return fail();
  const [decision] = await db.select().from(workflowTerminalDecisions).where(and(
    eq(workflowTerminalDecisions.id, receipt.targetDecisionId),
    eq(workflowTerminalDecisions.companyId, run.companyId), eq(workflowTerminalDecisions.workflowRunId, run.id),
    eq(workflowTerminalDecisions.decidedAuthorityVersion, receipt.targetAuthorityVersion),
    eq(workflowTerminalDecisions.decision, "failed"),
  ));
  if (!decision) return fail();
  // No transient current-definition fallback: a missing snapshot leaves historical skips sticky.
  const [snapshot] = await db.select().from(workflowRunDefinitions).where(and(
    eq(workflowRunDefinitions.workflowRunId, run.id), eq(workflowRunDefinitions.companyId, run.companyId),
  ));
  if (!snapshot) return;
  const definition = await loadExecutionDefinition(db, run.id, { requireHistorical: true });
  if (definition.executionMode !== "static_dag") return;
  const ordered = orderedGraph(definition.steps, rows);
  if (!ordered) return;
  const events = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, run.companyId), eq(workflowTransitionEvents.workflowRunId, run.id),
  ));
  const failure = currentTransition(events, run, target);
  if (!failure || snapshot.capturedAt > failure.createdAt || failure.createdAt > decision.createdAt) return;
  const history = await db.select().from(workflowRecoveryAuthorities).where(and(
    eq(workflowRecoveryAuthorities.companyId, run.companyId), eq(workflowRecoveryAuthorities.workflowRunId, run.id),
  ));
  if (history.some(row => row.id !== receipt.id && row.status === "consumed"
    && (!row.consumedAt || row.consumedAt >= failure.createdAt))) return;
  const issueIds = rows.flatMap(row => row.issueId ? [row.issueId] : []);
  const linked = issueIds.length ? await db.select().from(issues).where(and(
    eq(issues.companyId, run.companyId), inArray(issues.id, issueIds),
  )) : [];
  const byStep = new Map(rows.map(row => [row.stepId, row]));
  const affected = new Map<string, Event>([[target.stepId, failure]]);
  const selected: Step[] = [];
  for (const step of ordered) {
    const row = byStep.get(step.id)!;
    if (row.status !== "skipped" || !unlaunched(row)
      || (step.type && !["agent", "tool"].includes(step.type))
      || (step.triggerOn && step.triggerOn !== "normal")) continue;
    const event = currentTransition(events, run, row);
    if (!event || event.fromStatus !== "pending" || event.createdAt < failure.createdAt
      || event.createdAt > decision.createdAt) continue;
    const metadata = row.metadata ?? {};
    const cascade = event.reasonCode === "workflow_reconciler"
      && metadata.failureCascadeSkipped === true && metadata.controlFlowSkipped !== true;
    const deadlock = event.reasonCode === "workflow_deadlock_reconciler"
      && metadata.controlFlowSkipped === true && metadata.failureCascadeSkipped !== true;
    if (!cascade && !deadlock) continue;
    if (!permitsRecordedCascadeRecovery(row, failedStep, observedRun, definition.definitionHash, event.reasonCode)) continue;
    if (row.issueId) {
      const issue = linked.find(issue => issue.id === row.issueId && issue.missionId === run.missionId);
      if (!issue || ["done", "cancelled"].includes(issue.status)) continue;
    }
    const edges = resolveEdges(step);
    if (!edges.length || edges.some(edge => edge.isBackEdge || (edge.when && edge.when !== "success"))) continue;
    let dependsOnFailure = false;
    const uniqueCause = edges.every(edge => {
      const upstream = affected.get(edge.stepId);
      if (upstream) {
        dependsOnFailure = true;
        return upstream.createdAt <= event.createdAt;
      }
      const predecessor = byStep.get(edge.stepId)!;
      const completed = predecessor.status === "completed" ? currentTransition(events, run, predecessor) : undefined;
      return completed !== undefined && completed.createdAt < event.createdAt;
    });
    if (uniqueCause && dependsOnFailure) {
      selected.push(row);
      affected.set(step.id, event);
    }
  }
  for (const expected of selected) {
    // The authority core already advanced EVERY generation. Re-read after consumption and
    // after each revival so the next predecessor observation includes earlier pending rows.
    const current = await readCurrent();
    const row = current.rows.find(row => row.id === expected.id);
    if (!row || JSON.stringify(row) !== JSON.stringify(expected)) return fail();
    const metadata = { ...row.metadata };
    if (metadata.failureCascadeSkipped === true) metadata.failureCascadeSkipped = false;
    if (metadata.controlFlowSkipped === true) metadata.controlFlowSkipped = false;
    const result = await reviveConditionalSkip(db, {
      observedRun: current.run, target: row, nextMetadata: metadata,
      observedPredecessors: current.rows.filter(predecessor => predecessor.id !== row.id),
      invalidateGeneration: false,
    });
    if (result.kind !== "settled") return fail();
  }
  if (selected.length) {
    const current = await readCurrent();
    if (JSON.stringify(current.rows.find(row => row.id === target.id)) !== JSON.stringify(target)) return fail();
    for (const expected of selected) {
      const row = current.rows.find(row => row.id === expected.id);
      if (!row || row.status !== "pending" || !unlaunched(row)
        || row.executionGeneration !== expected.executionGeneration
        || row.statusTransitionVersion <= expected.statusTransitionVersion
        || row.metadata?.failureCascadeSkipped === true || row.metadata?.controlFlowSkipped === true) return fail();
    }
  }
}

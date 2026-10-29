import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueWorkProducts, issues, missions, workflowRuns,
  workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { loadExecutionDefinition } from "../workflow/execution-definition.js";
import type { WorkflowStep } from "../workflow/dag-engine.js";
import { loadLatestMissionOwnerDecision, MISSION_OWNER_DECISION_EVENT_TYPE,
  MISSION_OWNER_DECISION_SOURCE, MISSION_OWNER_RECOVERY_LAYER } from "./mission-owner-recovery-ledger.js";
import { buildMissionOwnerDecisionWakeupIdempotencyKey } from "./mission-owner-recovery-events.js";
import { authorizeProducerRework } from "./producer-rework-authorization.js";
import { isQaLikeStep, resolveProducerStepIdFromDag } from "./supervision-helpers.js";
import { isQaRecoveryLive, resolveRecoveryOwnership } from "./recovery-ownership-guard.js";
import { readExactOwnerRetryHumanWait, type OwnerRetryHumanWaitContext,
  type OwnerRetryHumanWaitVerdict } from "./owner-retry-human-wait.js";

export async function isCapOverrideRetryCandidate(db: Db, companyId: string, sourceIssueId: string): Promise<boolean> {
  const [stepRun] = await db.select({ status: workflowStepRuns.status, workflowRunId: workflowStepRuns.workflowRunId })
    .from(workflowStepRuns).where(eq(workflowStepRuns.issueId, sourceIssueId))
    .orderBy(desc(workflowStepRuns.startedAt), desc(workflowStepRuns.completedAt)).limit(1);
  if (!stepRun || stepRun.status !== "completed") return false;
  const [run] = await db.select({ status: workflowRuns.status }).from(workflowRuns)
    .where(and(eq(workflowRuns.id, stepRun.workflowRunId), eq(workflowRuns.companyId, companyId))).limit(1);
  return Boolean(run && run.status === "failed");
}

export async function loadQaGateVerdictMap(db: Db, companyId: string, qaGateIssueId: string | null) {
  const map = new Map<string, { verdict: string | null; observedAt: Date | null }>();
  if (!qaGateIssueId) return map;
  const rows = await db.select({ verdict: workflowTransitionEvents.verdict,
    observedAt: workflowTransitionEvents.createdAt }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.issueId, qaGateIssueId),
    eq(workflowTransitionEvents.eventType, "workflow_validation_verdict")))
    .orderBy(desc(workflowTransitionEvents.createdAt)).limit(5);
  if (rows.length) map.set(qaGateIssueId, { verdict: rows[0]!.verdict, observedAt: rows[0]!.observedAt });
  return map;
}

export async function loadLatestFailureReasonCode(db: Db, companyId: string, issueId: string): Promise<string | null> {
  const [row] = await db.select({ errorCode: heartbeatRuns.errorCode }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.issueId, issueId),
    inArray(heartbeatRuns.status, ["failed", "timed_out"]))).orderBy(desc(heartbeatRuns.createdAt)).limit(1);
  return row?.errorCode ?? null;
}

type CheckInput = OwnerRetryHumanWaitContext & {
  ownerAgentId: string;
  ownerActionStatus: string;
};
const notCurrent = (reasonCode: string): OwnerRetryHumanWaitVerdict =>
  ({ kind: "unresolved", reasonCode, checkedScopes: [] });
async function hasStructuredDecision(tx: CheckInputTx, input: CheckInput) {
  if (await loadLatestMissionOwnerDecision({ db: tx, companyId: input.companyId,
    ownerActionIssueId: input.ownerActionIssueId })) return true;
  return (await tx.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, input.companyId), eq(workflowTransitionEvents.missionId, input.missionId),
    eq(workflowTransitionEvents.issueId, input.ownerActionIssueId), eq(workflowTransitionEvents.eventType, MISSION_OWNER_DECISION_EVENT_TYPE),
    eq(workflowTransitionEvents.layer, MISSION_OWNER_RECOVERY_LAYER), eq(workflowTransitionEvents.reason, MISSION_OWNER_DECISION_SOURCE))).limit(1)).length > 0;
}

/** Selection hint only; Transaction A repeats this under the same mission lock as its writes. */
export async function checkAutomaticOwnerRetryWait(db: Db, input: CheckInput): Promise<OwnerRetryHumanWaitVerdict> {
  return db.transaction(async (tx) => {
    const [mission] = await tx.select({ status: missions.status, ownerAgentId: missions.ownerAgentId }).from(missions)
      .where(and(eq(missions.id, input.missionId), eq(missions.companyId, input.companyId))).for("update");
    if (!mission || mission.status !== "active" || mission.ownerAgentId !== input.ownerAgentId) return notCurrent("mission_changed");
    const [owner] = await tx.select({ originKind: issues.originKind, originId: issues.originId,
      status: issues.status, hiddenAt: issues.hiddenAt, assigneeAgentId: issues.assigneeAgentId }).from(issues)
      .where(and(eq(issues.id, input.ownerActionIssueId), eq(issues.companyId, input.companyId),
        eq(issues.missionId, input.missionId)));
    if (!owner || ["done", "cancelled", "canceled"].includes(owner.status)
      || owner.originKind !== "mission_main_executor_unblock" || owner.originId !== input.originalSourceIssueId
      || owner.hiddenAt || owner.assigneeAgentId !== input.ownerAgentId || owner.status !== input.ownerActionStatus) {
      return notCurrent("owner_action_changed");
    }
    if (await hasStructuredDecision(tx, input)) return notCurrent("owner_decision_changed");
    return readExactOwnerRetryHumanWait(tx, input);
  });
}

type ProducerContext = {
  originStepRunId: string;
  producerStepRunId: string;
  qaGateIssueId: string | null;
  missionHasNativeLoop: boolean;
};
export type AutomaticOwnerRetryApplyInput = CheckInput & {
  db: Db;
  retryKey: string;
  applyKey: string;
  now: Date;
  graceMs: number;
  retryTargetId: string;
  dispatchRequested: boolean;
  callbackAvailable: boolean;
  producerRework: boolean;
  producer?: ProducerContext | null;
};
export type AutomaticOwnerRetryApplyResult =
  | { kind: "applied"; sourceIssue: typeof issues.$inferSelect; reopened: boolean }
  | { kind: "not_applied"; reason: string };
const rejected = (reason: string): AutomaticOwnerRetryApplyResult => ({ kind: "not_applied", reason });

async function producerReworkAllowed(tx: CheckInputTx, input: AutomaticOwnerRetryApplyInput,
  source: typeof issues.$inferSelect): Promise<{ allowed: boolean; reopenDone: boolean }> {
  const context = input.producer;
  if (!context) return { allowed: false, reopenDone: false };
  const [originRunRow] = await tx.select({ stepId: workflowStepRuns.stepId, workflowRunId: workflowStepRuns.workflowRunId })
    .from(workflowStepRuns).where(and(eq(workflowStepRuns.id, context.originStepRunId),
      eq(workflowStepRuns.issueId, input.originalSourceIssueId)));
  const [producerRunRow] = await tx.select().from(workflowStepRuns)
    .where(and(eq(workflowStepRuns.id, context.producerStepRunId), eq(workflowStepRuns.issueId, source.id))).for("share");
  if (!originRunRow || !producerRunRow || originRunRow.workflowRunId !== producerRunRow.workflowRunId) {
    return { allowed: false, reopenDone: false };
  }
  const [run] = await tx.select().from(workflowRuns).where(and(eq(workflowRuns.id, producerRunRow.workflowRunId),
    eq(workflowRuns.companyId, input.companyId), eq(workflowRuns.missionId, input.missionId))).for("share");
  if (!run) return { allowed: false, reopenDone: false };
  const execution = await loadExecutionDefinition(tx as unknown as Db, run.id, { requireHistorical: false });
  const steps: WorkflowStep[] = execution.steps;
  const originStep = steps.find((step) => step.id === originRunRow.stepId);
  const producerStep = steps.find((step) => step.id === producerRunRow.stepId);
  if (!originStep || !producerStep || resolveProducerStepIdFromDag(originRunRow.stepId ?? "", steps)
    !== producerRunRow.stepId) return { allowed: false, reopenDone: false };
  const hasLoop = steps.some((step) =>
    (step.conditionalDependencies ?? []).some((edge) => edge.isBackEdge === true));
  if (hasLoop !== context.missionHasNativeLoop) return { allowed: false, reopenDone: false };
  const edges = producerStep.conditionalDependencies ?? [];
  const maxIterations = edges.filter((edge) => edge.isBackEdge && typeof edge.maxIterations === "number")
    .reduce((max, edge) => Math.max(max, edge.maxIterations ?? 0), 0);
  if (hasLoop && maxIterations > (producerRunRow.iterationIndex ?? 0)) return { allowed: false, reopenDone: false };
  if (context.qaGateIssueId) {
    const [qaRunRow] = await tx.select({ stepId: workflowStepRuns.stepId }).from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.issueId, context.qaGateIssueId), eq(workflowStepRuns.workflowRunId, run.id)));
    const qaStep = qaRunRow && execution.steps.find((step) => step.id === qaRunRow.stepId);
    if (!qaStep || !isQaLikeStep(qaStep)) return { allowed: false, reopenDone: false };
  }
  const [product] = await tx.select({ updatedAt: issueWorkProducts.updatedAt }).from(issueWorkProducts).where(and(
    eq(issueWorkProducts.companyId, input.companyId), eq(issueWorkProducts.issueId, source.id),
    eq(issueWorkProducts.status, "active"))).orderBy(desc(issueWorkProducts.updatedAt)).limit(1);
  const auth = authorizeProducerRework({
    failureReasonCode: await loadLatestFailureReasonCode(tx as unknown as Db, input.companyId, source.id),
    qaIssueId: context.qaGateIssueId,
    validationVerdictsByIssueId: await loadQaGateVerdictMap(tx as unknown as Db, input.companyId, context.qaGateIssueId),
    producerCompletedAt: product?.updatedAt ?? source.completedAt });
  return { allowed: auth.authorized,
    reopenDone: auth.authorized && (auth.reason === "explicit_rework_target" || auth.reason === "fresh_request_changes_verdict") };
}

type CheckInputTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
class RollbackAutomaticRetry extends Error {}

/** Transaction A: all authority/currentness reads and the existing source/apply writes share one mission lock. */
export async function applyAutomaticOwnerRetryIfClear(input: AutomaticOwnerRetryApplyInput): Promise<AutomaticOwnerRetryApplyResult> {
  try { return await input.db.transaction(async (tx) => {
    const [mission] = await tx.select({ status: missions.status, ownerAgentId: missions.ownerAgentId }).from(missions)
      .where(and(eq(missions.id, input.missionId), eq(missions.companyId, input.companyId))).for("update");
    if (!mission || mission.status !== "active" || mission.ownerAgentId !== input.ownerAgentId) return rejected("mission_changed");
    const [owner] = await tx.select().from(issues).where(and(eq(issues.id, input.ownerActionIssueId),
      eq(issues.companyId, input.companyId), eq(issues.missionId, input.missionId))).for("share");
    if (!owner || ["done", "cancelled", "canceled"].includes(owner.status) || owner.hiddenAt
      || owner.originKind !== "mission_main_executor_unblock"
      || owner.originId !== input.originalSourceIssueId || owner.assigneeAgentId !== input.ownerAgentId
      || owner.status !== input.ownerActionStatus || Date.now() - owner.createdAt.getTime() < input.graceMs) {
      return rejected("owner_action_changed");
    }
    if (await hasStructuredDecision(tx, input)) return rejected("owner_decision_changed");
    const [original] = await tx.select({ id: issues.id, missionId: issues.missionId, hiddenAt: issues.hiddenAt }).from(issues)
      .where(and(eq(issues.id, input.originalSourceIssueId), eq(issues.companyId, input.companyId), eq(issues.missionId, input.missionId)));
    if (!original || original.hiddenAt || input.retryKey !== buildMissionOwnerDecisionWakeupIdempotencyKey({
      missionId: input.missionId, ownerActionIssueId: input.ownerActionIssueId, sourceIssueId: input.retryTargetId })) {
      return rejected("source_binding_changed");
    }
    const wait = await readExactOwnerRetryHumanWait(tx, { companyId: input.companyId, missionId: input.missionId,
      ownerActionIssueId: input.ownerActionIssueId, originalSourceIssueId: input.originalSourceIssueId,
      retryIssueId: input.retryTargetId });
    if (wait.kind !== "clear") return rejected(wait.kind === "waiting" ? "human_wait" : `human_wait_${wait.reasonCode}`);
    const [source] = await tx.select().from(issues).where(and(eq(issues.id, input.retryTargetId),
      eq(issues.companyId, input.companyId), eq(issues.missionId, input.missionId))).for("share");
    if (!source || source.hiddenAt) return rejected("source_unavailable");
    const keys = await tx.select({ id: workflowTransitionEvents.id, key: workflowTransitionEvents.idempotencyKey,
      toStatus: workflowTransitionEvents.toStatus }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, input.companyId), inArray(workflowTransitionEvents.idempotencyKey,
        [input.retryKey, input.applyKey])));
    const wakes = await tx.select({ id: agentWakeupRequests.id, key: agentWakeupRequests.idempotencyKey }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, input.companyId), inArray(agentWakeupRequests.idempotencyKey,
        [input.retryKey, input.applyKey])));
    if (input.applyKey !== `${input.retryKey}:apply` || keys.some((row) => row.key === input.applyKey)
      || wakes.some((row) => row.key === input.applyKey) || wakes.some((row) => row.key === input.retryKey)
      || keys.some((row) => row.key === input.retryKey && ["dispatched", "workflow_already_dispatched"].includes(row.toStatus ?? ""))) {
      return rejected("retry_key_changed");
    }
    const [activeHeartbeat] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.issueId, source.id),
      inArray(heartbeatRuns.status, ["queued", "running"]))).limit(1);
    const failedHeartbeats = await tx.select({ id: heartbeatRuns.id, status: heartbeatRuns.status,
      error: heartbeatRuns.error, errorCode: heartbeatRuns.errorCode, exitCode: heartbeatRuns.exitCode })
      .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.issueId, source.id)));
    const [activeProduct] = await tx.select({ id: issueWorkProducts.id }).from(issueWorkProducts).where(and(
      eq(issueWorkProducts.companyId, input.companyId), eq(issueWorkProducts.issueId, source.id),
      eq(issueWorkProducts.status, "active"))).limit(1);
    const sourceIsRetryableQueue = (source.status === "todo" || source.status === "backlog") && !activeHeartbeat
      && (failedHeartbeats.some((row) => row.status === "failed" || row.status === "timed_out" || row.error
        || row.errorCode || (row.exitCode != null && row.exitCode !== 0))
        || Boolean(activeProduct));
    const producerStatusAllowed = ["blocked", "todo", "backlog", "done"].includes(source.status);
    if (activeHeartbeat || (input.producerRework ? !producerStatusAllowed
      : source.status !== "blocked" && !sourceIsRetryableQueue)) {
      return rejected("source_not_retryable");
    }
    if (input.producerRework) {
      const ownership = await resolveRecoveryOwnership(tx as unknown as Db, { companyId: input.companyId,
        missionId: input.missionId, sourceIssueId: source.id, qaGateIssueId: input.producer?.qaGateIssueId });
      if (isQaRecoveryLive(ownership)) return rejected("qa_recovery_live");
      const auth = await producerReworkAllowed(tx, input, source);
      if (!auth.allowed) return rejected("producer_rework_not_current");
      if (!auth.reopenDone && source.status === "done") return rejected("producer_rework_not_current");
    }
    const capOverride = input.producerRework
      && await isCapOverrideRetryCandidate(tx as unknown as Db, input.companyId, source.id);
    const workflowBacked = (await tx.select({ id: workflowStepRuns.id }).from(workflowStepRuns)
      .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId)).where(and(
        eq(workflowStepRuns.issueId, source.id), eq(workflowRuns.companyId, input.companyId),
        eq(workflowRuns.missionId, input.missionId))).limit(1)).length > 0;
    const shouldReopen = !capOverride && (input.producerRework
      || (input.dispatchRequested && input.callbackAvailable && Boolean(source.assigneeAgentId) && workflowBacked));
    let appliedSource = source;
    if (shouldReopen) {
      const statuses = input.producerRework ? ["blocked", "todo", "backlog", "done"] : ["blocked", "todo", "backlog"];
      const [updated] = await tx.update(issues).set({ status: "todo", updatedAt: input.now, completedAt: null })
        .where(and(eq(issues.id, source.id), eq(issues.companyId, input.companyId), eq(issues.missionId, input.missionId),
          inArray(issues.status, statuses), isNull(issues.hiddenAt))).returning();
      if (!updated) return rejected("source_settled");
      appliedSource = updated;
    }
    const resultStatus = shouldReopen ? "todo" : source.status;
    const inserted = await tx.insert(workflowTransitionEvents).values({ companyId: input.companyId,
      missionId: input.missionId, issueId: input.ownerActionIssueId, eventType: "mission_owner_retry_apply",
      layer: "mission_owner_recovery", decision: "retry_source_issue", reason: "owner_recovery_api",
      reasonCode: "owner_recovery_api", toStatus: resultStatus, idempotencyKey: input.applyKey,
      payload: { kind: "mission_owner_retry_apply", ownerActionIssueId: input.ownerActionIssueId,
        resultStatus, sourceIssueId: source.id },
    }).onConflictDoNothing().returning({ id: workflowTransitionEvents.id });
    if (!inserted.length) throw new RollbackAutomaticRetry("retry_key_changed");
    return { kind: "applied", sourceIssue: appliedSource, reopened: shouldReopen };
  }); } catch (error) {
    if (error instanceof RollbackAutomaticRetry) return rejected(error.message);
    throw error;
  }
}

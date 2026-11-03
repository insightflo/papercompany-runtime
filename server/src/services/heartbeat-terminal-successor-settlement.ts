import { and, asc, eq, inArray, or } from "drizzle-orm";
import { withTxTimeout, type Db } from "@paperclipai/db";
import {
  agentWakeupRequests, heartbeatRuns, issues, missions, workflowRecoveryAuthorities, workflowRuns,
  workflowStepRuns, workflowTransitionEvents,
} from "@paperclipai/db";
import { isDeepStrictEqual } from "node:util";
import {
  acknowledgeTerminalReleaseObligation,
  readReadyTerminalReleaseContinuation,
  readTerminalReleaseAcknowledgment,
  terminalReleaseMatchesRun,
  TERMINAL_RELEASE_EVENT_TYPE,
  type TerminalReleaseManifest,
} from "./heartbeat-terminal-release-continuation.js";
import { readWorkflowAttemptProof } from "./heartbeat-finalization/workflow-attempt-proof.js";
import {
  QA_REMEDIATION_COMPLETION_SCHEMA_VERSION,
  QA_REMEDIATION_COMPLETION_EVENT_TYPE,
  qaRemediationCompletionKey,
  qaRemediationRefireV2WakeKey,
} from "./workflow/control-flow/qa-remediation-completion.js";
import { validateQaRemediationCompletionEvidence } from "./workflow/control-flow/qa-remediation-completion-evidence.js";
import {
  QA_REMEDIATION_PREPARATION_EVENT_TYPE,
  QA_REMEDIATION_PREPARATION_SCHEMA_VERSION,
  parseQaRemediationPreparation,
  qaRemediationPreparationKey,
} from "./workflow/control-flow/qa-remediation-preparation-contract.js";
import { workflowQaRemediationsSchema } from "@paperclipai/shared";

const SOURCE_CHANGED = "terminal_continuation_source_or_authority_changed";
const ACTUAL_DRAIN_EVENT_TYPE = "heartbeat_actual_drained_v1";
const ACTUAL_DRAIN_KEY = (source: TerminalReleaseManifest["source"]) =>
  `heartbeat-actual-drained:v1:${source.heartbeatRunId}:${source.identityDigest}`;
const ALLOWED_SETTLEMENT_ACTIONS = new Set(["sync_issue", "promote_agent_queue", "reevaluate_source"]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const held = (reason: string) => ({ kind: "held" as const, reason });

type ReadDb = Pick<Db, "select">;
type SourceRows = {
  run: typeof heartbeatRuns.$inferSelect;
  workflow: typeof workflowRuns.$inferSelect;
  step: typeof workflowStepRuns.$inferSelect;
  wake: typeof agentWakeupRequests.$inferSelect;
  issue: typeof issues.$inferSelect;
};
export type TerminalContinuationSourceRead =
  | { kind: "ready"; eventId: string; manifest: TerminalReleaseManifest;
      actualOutcome: "fulfilled" | "rejected"; sourceRow: SourceRows }
  | { kind: "held"; reason: string };

/** Strict execution-source check shared by normal drain and the settlement transaction. */
export async function readTerminalContinuationSource(eventId: string, readDb: ReadDb): Promise<TerminalContinuationSourceRead> {
  const receipt = await readReadyTerminalReleaseContinuation(readDb, eventId);
  if (receipt.kind !== "ready") return receipt;
  const { source } = receipt.manifest;
  const [run] = await readDb.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, source.heartbeatRunId), eq(heartbeatRuns.companyId, source.companyId),
  ));
  const [workflow] = await readDb.select().from(workflowRuns).where(and(
    eq(workflowRuns.id, source.workflowRunId), eq(workflowRuns.companyId, source.companyId),
  ));
  const [step] = await readDb.select().from(workflowStepRuns).where(and(
    eq(workflowStepRuns.id, source.workflowStepRunId), eq(workflowStepRuns.workflowRunId, source.workflowRunId),
  ));
  const [wake] = await readDb.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, source.wakeupRequestId), eq(agentWakeupRequests.companyId, source.companyId),
  ));
  const [issue] = await readDb.select().from(issues).where(and(
    eq(issues.id, source.issueId), eq(issues.companyId, source.companyId),
  ));
  if (!run || !workflow || !step || !wake || !issue || !terminalReleaseMatchesRun(source, run)
    || workflow.missionId !== source.missionId || workflow.dispatchAuthorityVersion !== source.dispatchAuthorityVersion
    || !["running", "completed"].includes(workflow.status)
    || step.stepId !== source.stepId || step.issueId !== source.issueId
    || step.status !== "completed"
    || step.retryCount !== source.retryCount || step.iterationIndex !== source.iterationIndex
    || step.executionGeneration !== source.executionGeneration
    || step.dispatchOwnerHeartbeatRunId !== source.heartbeatRunId
    || step.dispatchOwnerWakeupRequestId !== source.wakeupRequestId
    || issue.missionId !== source.missionId || wake.runId !== source.heartbeatRunId
    || wake.agentId !== source.agentId || wake.issueId !== source.issueId || wake.missionId !== source.missionId
    || wake.workflowRunId !== source.workflowRunId || wake.workflowStepRunId !== source.workflowStepRunId
    || wake.workflowExecutionGeneration !== source.executionGeneration || wake.status === "coalesced"
    || !["succeeded", "failed", "timed_out", "cancelled"].includes(run.status)) {
    return held(SOURCE_CHANGED);
  }
  const replacementOwner = issue.executionRunId ?? issue.checkoutRunId;
  if (replacementOwner && replacementOwner !== source.heartbeatRunId) {
    const [promotedWake] = await readDb.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, source.companyId), eq(agentWakeupRequests.issueId, source.issueId),
      eq(agentWakeupRequests.runId, replacementOwner), eq(agentWakeupRequests.reason, "issue_execution_promoted"),
    ));
    if (!promotedWake) return held("terminal_continuation_replacement_owner_changed");
  }
  try {
    const proof = readWorkflowAttemptProof(wake);
    if (proof.retryCount !== source.retryCount || proof.iterationIndex !== source.iterationIndex
      || proof.parentHeartbeatRunId !== source.retryOfRunId || proof.companyId !== source.companyId
      || proof.missionId !== source.missionId || proof.workflowRunId !== source.workflowRunId
      || proof.stepRunId !== source.workflowStepRunId || proof.executionGeneration !== source.executionGeneration) {
      return held("terminal_continuation_reserved_attempt_changed");
    }
  } catch {
    return held("terminal_continuation_reserved_attempt_unproven");
  }
  return { ...receipt, sourceRow: { run, workflow, step, wake, issue } };
}

type Discovery = {
  original: Awaited<ReturnType<typeof readReadyTerminalReleaseContinuation>> & { kind: "ready" };
  preparation: ReturnType<typeof parseQaRemediationPreparation>;
  successorWake: typeof agentWakeupRequests.$inferSelect;
  successorRun: typeof heartbeatRuns.$inferSelect;
  successorContinuationEventId: string;
  successor: Awaited<ReturnType<typeof readReadyTerminalReleaseContinuation>> & { kind: "ready" };
  pending: TerminalReleaseManifest["obligations"];
  proofEventIds: string[];
  lockSet: { missionId: string; workflowRunId: string; heartbeatIds: string[]; issueId: string;
    stepIds: string[]; wakeIds: string[] };
};

type DiscoveryResult = { kind: "ready"; value: Discovery } | { kind: "complete" } | { kind: "held"; reason: string };

function exactSourceAttempt(source: TerminalReleaseManifest["source"], other: TerminalReleaseManifest["source"]) {
  return source.companyId === other.companyId && source.missionId === other.missionId
    && source.workflowRunId === other.workflowRunId && source.dispatchAuthorityVersion === other.dispatchAuthorityVersion
    && source.workflowStepRunId === other.workflowStepRunId && source.stepId === other.stepId
    && source.issueId === other.issueId && source.agentId === other.agentId
    && source.executionGeneration === other.executionGeneration && source.retryCount === other.retryCount
    && source.iterationIndex === other.iterationIndex;
}

function officialVerdictBound(row: typeof workflowTransitionEvents.$inferSelect,
  expected: { companyId: string; missionId: string; workflowRunId: string; workflowStepRunId: string;
    issueId: string; heartbeatRunId: string; wakeupRequestId: string; executionGeneration: number },
  expectedVerdict: "pass" | "request_changes") {
  const payload = isRecord(row.payload) ? row.payload : null;
  const remediations = payload ? workflowQaRemediationsSchema.safeParse(payload.remediations) : null;
  const exactExecutionBinding = row.wakeupRequestId === expected.wakeupRequestId
    && row.executionGeneration === expected.executionGeneration;
  const ordinaryOriginalBinding = expectedVerdict === "request_changes"
    && row.wakeupRequestId === null && row.executionGeneration === null;
  if (!payload || (expectedVerdict === "request_changes" && !remediations?.success)
    || (expectedVerdict === "pass" && Object.hasOwn(payload, "remediations"))) return false;
  return row.companyId === expected.companyId && row.missionId === expected.missionId
    && row.workflowRunId === expected.workflowRunId && row.workflowStepRunId === expected.workflowStepRunId
    && row.issueId === expected.issueId && row.heartbeatRunId === expected.heartbeatRunId
    && (exactExecutionBinding || ordinaryOriginalBinding)
    && row.idempotencyKey === `workflow-validation-verdict:${expected.companyId}:${expected.issueId}:${expected.workflowStepRunId}:run:${expected.heartbeatRunId}`
    && row.eventType === "workflow_validation_verdict" && row.layer === "workflow_validation"
    && row.reason === "workflow_api" && row.reasonCode === "workflow_api"
    && row.verdict === expectedVerdict && row.decision === expectedVerdict
    && payload.kind === "workflow_validation_verdict" && payload.workflowRunId === expected.workflowRunId
    && payload.stepRunId === expected.workflowStepRunId && payload.issueId === expected.issueId
    && payload.verdict === expectedVerdict;
}

async function discover(db: ReadDb, eventId: string): Promise<DiscoveryResult> {
  const original = await readReadyTerminalReleaseContinuation(db, eventId);
  if (original.kind !== "ready") return original;
  if (original.actualOutcome !== "fulfilled") return held("terminal_successor_original_actual_not_fulfilled");
  const source = original.manifest.source;
  const strictOriginal = await readTerminalContinuationSource(eventId, db);
  if (strictOriginal.kind !== "held" || strictOriginal.reason !== SOURCE_CHANGED) {
    return strictOriginal.kind === "held" ? strictOriginal : held("terminal_successor_settlement_source_not_changed");
  }
  const [run] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, source.heartbeatRunId), eq(heartbeatRuns.companyId, source.companyId),
  ));
  const [workflow] = await db.select().from(workflowRuns).where(and(
    eq(workflowRuns.id, source.workflowRunId), eq(workflowRuns.companyId, source.companyId),
  ));
  const [mission] = await db.select().from(missions).where(and(
    eq(missions.id, source.missionId), eq(missions.companyId, source.companyId),
  ));
  const [step] = await db.select().from(workflowStepRuns).where(and(
    eq(workflowStepRuns.id, source.workflowStepRunId), eq(workflowStepRuns.workflowRunId, source.workflowRunId),
  ));
  const [wake] = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, source.wakeupRequestId), eq(agentWakeupRequests.companyId, source.companyId),
  ));
  const [issue] = await db.select().from(issues).where(and(
    eq(issues.id, source.issueId), eq(issues.companyId, source.companyId),
  ));
  if (workflow && workflow.dispatchAuthorityVersion !== source.dispatchAuthorityVersion) return held(SOURCE_CHANGED);
  if (!run || !workflow || !mission || !step || !wake || !issue || !terminalReleaseMatchesRun(source, run)
    || run.status !== "succeeded" || run.terminalOutcome !== "succeeded" || !run.startedAt || !run.finishedAt
    || run.resultJson === null || !run.executorOwnerReleasedAt
    || !["running", "completed"].includes(workflow.status) || workflow.missionId !== source.missionId
    || !["active", "completed"].includes(mission.status)
    || step.status !== "completed" || step.stepId !== source.stepId || step.issueId !== source.issueId
    || step.retryCount !== source.retryCount
    || step.iterationIndex !== source.iterationIndex || step.executionGeneration !== source.executionGeneration
    || issue.missionId !== source.missionId || issue.cancelledAt !== null || issue.status === "cancelled"
    || !["backlog", "todo", "in_progress", "in_review", "blocked", "done"].includes(issue.status)
    || wake.runId !== source.heartbeatRunId || wake.status !== "completed" || wake.agentId !== source.agentId
    || wake.issueId !== source.issueId || wake.missionId !== source.missionId || wake.workflowRunId !== source.workflowRunId
    || wake.workflowStepRunId !== source.workflowStepRunId || wake.workflowExecutionGeneration !== source.executionGeneration) {
    return held("terminal_successor_original_scope_or_actual_invalid");
  }
  let originalAttempt;
  try { originalAttempt = readWorkflowAttemptProof(wake); }
  catch { return held("terminal_successor_original_attempt_unproven"); }
  if (originalAttempt.retryCount !== source.retryCount || originalAttempt.iterationIndex !== source.iterationIndex
    || originalAttempt.executionGeneration !== source.executionGeneration || originalAttempt.parentHeartbeatRunId !== source.retryOfRunId) {
    return held("terminal_successor_original_attempt_changed");
  }
  const metadata = workflow.metadata ?? {};
  if (Object.hasOwn(metadata, "replacementAuthorityId") || Object.hasOwn(metadata, "replacementStart")) {
    return held("terminal_successor_replacement_marker_present");
  }
  const recoveries = await db.select({ id: workflowRecoveryAuthorities.id }).from(workflowRecoveryAuthorities).where(or(
    and(eq(workflowRecoveryAuthorities.companyId, source.companyId),
      eq(workflowRecoveryAuthorities.workflowRunId, source.workflowRunId)),
    and(eq(workflowRecoveryAuthorities.companyId, source.companyId),
      eq(workflowRecoveryAuthorities.replacementRunId, source.workflowRunId)),
  ));
  if (recoveries.length) return held("terminal_successor_replacement_authority_present");

  const originalAcks = await Promise.all(original.manifest.obligations.map(obligation =>
    readTerminalReleaseAcknowledgment(db, eventId, obligation.effectKey)));
  if (originalAcks.some(ack => ack.kind === "held")) {
    const ack = originalAcks.find(item => item.kind === "held");
    return held(ack?.kind === "held" ? ack.reason : "terminal_successor_original_ack_invalid");
  }
  const pending = original.manifest.obligations.filter((_, index) => originalAcks[index]!.kind === "pending");
  if (!pending.length) return { kind: "complete" };
  if (pending.some(item => !ALLOWED_SETTLEMENT_ACTIONS.has(item.action.kind))) {
    return held("terminal_successor_pending_action_not_settleable");
  }

  const verdictRows = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, source.companyId), eq(workflowTransitionEvents.workflowRunId, source.workflowRunId),
    eq(workflowTransitionEvents.workflowStepRunId, source.workflowStepRunId), eq(workflowTransitionEvents.issueId, source.issueId),
    eq(workflowTransitionEvents.heartbeatRunId, source.heartbeatRunId),
    eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
  ));
  if (verdictRows.length !== 1) return held("terminal_successor_request_changes_verdict_missing_or_ambiguous");
  const verdictRow = verdictRows[0]!;
  const payload = isRecord(verdictRow.payload) ? verdictRow.payload : null;
  const remediations = payload ? workflowQaRemediationsSchema.safeParse(payload.remediations) : null;
  if (!payload || !remediations?.success || !officialVerdictBound(verdictRow, {
    companyId: source.companyId, missionId: source.missionId, workflowRunId: source.workflowRunId,
    workflowStepRunId: source.workflowStepRunId, issueId: source.issueId, heartbeatRunId: source.heartbeatRunId,
    wakeupRequestId: source.wakeupRequestId, executionGeneration: source.executionGeneration,
  }, "request_changes")) {
    return held("terminal_successor_request_changes_verdict_malformed_or_mismatched");
  }

  const preparationRows = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, source.companyId), eq(workflowTransitionEvents.workflowRunId, source.workflowRunId),
    eq(workflowTransitionEvents.eventType, QA_REMEDIATION_PREPARATION_EVENT_TYPE),
  ));
  const candidates: Array<{ row: typeof workflowTransitionEvents.$inferSelect;
    preparation: ReturnType<typeof parseQaRemediationPreparation> }> = [];
  for (const row of preparationRows) {
    let preparation: ReturnType<typeof parseQaRemediationPreparation>;
    try { preparation = parseQaRemediationPreparation(row.payload); }
    catch { return held("terminal_successor_preparation_malformed"); }
    if (row.id !== preparation.preparationId || row.eventType !== QA_REMEDIATION_PREPARATION_EVENT_TYPE
      || row.layer !== "workflow_validation" || row.companyId !== preparation.companyId
      || row.missionId !== preparation.missionId || row.workflowRunId !== preparation.workflowRunId
      || row.workflowStepRunId !== preparation.producer.stepRunId || row.issueId !== preparation.producer.issueId
      || row.executionGeneration !== preparation.producer.executionGeneration
      || row.idempotencyKey !== qaRemediationPreparationKey(preparation)) {
      return held("terminal_successor_preparation_row_mismatch");
    }
    if (preparation.verdicts.some(item => item.eventId === verdictRow.id)) candidates.push({ row, preparation });
  }
  if (candidates.length !== 1) return held("terminal_successor_preparation_missing_or_ambiguous");
  const { row: preparationRow, preparation } = candidates[0]!;
  if (preparation.schemaVersion !== QA_REMEDIATION_PREPARATION_SCHEMA_VERSION
    || preparation.companyId !== source.companyId || preparation.missionId !== source.missionId
    || preparation.workflowRunId !== source.workflowRunId
    || preparation.dispatchAuthorityVersion !== source.dispatchAuthorityVersion || preparation.verdicts.length !== 1) {
    return held("terminal_successor_preparation_scope_or_version_mismatch");
  }
  const preparedVerdict = preparation.verdicts[0]!;
  const expectedAttempt = { stepRunId: source.workflowStepRunId, stepId: source.stepId, issueId: source.issueId,
    executionGeneration: source.executionGeneration, retryCount: source.retryCount, iterationIndex: source.iterationIndex };
  if (preparedVerdict.eventId !== verdictRow.id || preparedVerdict.heartbeatRunId !== source.heartbeatRunId
    || !isDeepStrictEqual(preparedVerdict.qa, expectedAttempt)
    || !isDeepStrictEqual(preparedVerdict.items, remediations.data.items)) {
    return held("terminal_successor_preparation_verdict_mismatch");
  }

  const completionRows = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, source.companyId), eq(workflowTransitionEvents.workflowRunId, source.workflowRunId),
    eq(workflowTransitionEvents.workflowStepRunId, preparation.producer.stepRunId),
    eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE),
    eq(workflowTransitionEvents.idempotencyKey, qaRemediationCompletionKey(preparation)),
  ));
  if (completionRows.length !== 1) return held("terminal_successor_completion_missing_or_ambiguous");
  const completionRow = completionRows[0]!;
  const validation = await validateQaRemediationCompletionEvidence(db as Db, completionRow, preparation);
  if (!validation.ok || validation.completion.schemaVersion !== QA_REMEDIATION_COMPLETION_SCHEMA_VERSION
    || validation.completion.wakes.length !== 1 || validation.completion.verdicts.length !== 1) {
    return held(validation.ok ? "terminal_successor_completion_version_or_wake_mismatch"
      : `terminal_successor_completion_${validation.reason}`);
  }
  const wakeReceipt = validation.completion.wakes[0]!;
  if (wakeReceipt.sourceVerdictEventId !== verdictRow.id || wakeReceipt.issueId !== source.issueId
    || wakeReceipt.stepRunId !== source.workflowStepRunId || wakeReceipt.stepId !== source.stepId
    || wakeReceipt.executionGeneration !== source.executionGeneration) {
    return held("terminal_successor_completion_receipt_mismatch");
  }
  const [successorWake] = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, wakeReceipt.wakeupRequestId), eq(agentWakeupRequests.companyId, source.companyId),
  ));
  if (!successorWake || successorWake.status !== "completed" || !successorWake.runId
    || successorWake.idempotencyKey !== qaRemediationRefireV2WakeKey(preparation, preparedVerdict.qa.stepRunId, verdictRow.id)) {
    return held("terminal_successor_completion_wake_not_fulfilled");
  }
  const [successorRun] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, successorWake.runId), eq(heartbeatRuns.companyId, source.companyId),
  ));
  if (!successorRun || successorRun.status !== "succeeded" || successorRun.terminalOutcome !== "succeeded"
    || !successorRun.startedAt || !successorRun.finishedAt || successorRun.resultJson === null
    || successorRun.agentId !== source.agentId || successorRun.issueId !== source.issueId
    || successorRun.wakeupRequestId !== successorWake.id || successorRun.workflowStepRunId !== source.workflowStepRunId
    || successorRun.workflowExecutionGeneration !== source.executionGeneration) {
    return held("terminal_successor_run_not_fulfilled_same_agent_attempt");
  }
  let successorProof;
  try { successorProof = readWorkflowAttemptProof(successorWake); }
  catch { return held("terminal_successor_wake_attempt_unproven"); }
  if (successorProof.companyId !== source.companyId || successorProof.agentId !== source.agentId
    || successorProof.issueId !== source.issueId || successorProof.missionId !== source.missionId
    || successorProof.workflowRunId !== source.workflowRunId || successorProof.stepRunId !== source.workflowStepRunId
    || successorProof.executionGeneration !== source.executionGeneration || successorProof.retryCount !== source.retryCount
    || successorProof.iterationIndex !== source.iterationIndex
    || successorProof.parentHeartbeatRunId !== originalAttempt.parentHeartbeatRunId) {
    return held("terminal_successor_wake_attempt_changed");
  }

  const reciprocalHeartbeatRows = await db.select().from(heartbeatRuns)
    .where(eq(heartbeatRuns.wakeupRequestId, successorWake.id));
  const reciprocalWakeRows = await db.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.runId, successorRun.id));
  if (reciprocalHeartbeatRows.length !== 1 || reciprocalHeartbeatRows[0]!.id !== successorRun.id
    || !isDeepStrictEqual(reciprocalHeartbeatRows[0]!, successorRun)
    || reciprocalWakeRows.length !== 1 || reciprocalWakeRows[0]!.id !== successorWake.id
    || !isDeepStrictEqual(reciprocalWakeRows[0]!, successorWake)) {
    return held("terminal_successor_reciprocal_wake_run_missing_or_ambiguous");
  }

  const successorManifests = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, source.companyId),
    eq(workflowTransitionEvents.heartbeatRunId, successorRun.id),
    eq(workflowTransitionEvents.eventType, TERMINAL_RELEASE_EVENT_TYPE),
  ));
  if (successorManifests.length !== 1) return held("terminal_successor_manifest_missing_or_ambiguous");
  const successorContinuationEventId = successorManifests[0]!.id;
  const successor = await readReadyTerminalReleaseContinuation(db, successorContinuationEventId);
  if (successor.kind !== "ready" || successor.actualOutcome !== "fulfilled"
    || !exactSourceAttempt(source, successor.manifest.source)
    || successor.manifest.source.heartbeatRunId !== successorRun.id
    || successor.manifest.source.wakeupRequestId !== successorWake.id) {
    return held(successor.kind === "held" ? successor.reason : "terminal_successor_manifest_source_mismatch");
  }
  const strictSuccessor = await readTerminalContinuationSource(successorContinuationEventId, db);
  if (strictSuccessor.kind !== "ready" || !exactSourceAttempt(source, strictSuccessor.manifest.source)
    || strictSuccessor.sourceRow.run.id !== successorRun.id || strictSuccessor.sourceRow.wake.id !== successorWake.id) {
    return held(strictSuccessor.kind === "held" ? strictSuccessor.reason : "terminal_successor_current_owner_mismatch");
  }

  const passRows = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, source.companyId), eq(workflowTransitionEvents.workflowRunId, source.workflowRunId),
    eq(workflowTransitionEvents.workflowStepRunId, source.workflowStepRunId), eq(workflowTransitionEvents.issueId, source.issueId),
    eq(workflowTransitionEvents.heartbeatRunId, successorRun.id),
    eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
  ));
  if (passRows.length !== 1 || !officialVerdictBound(passRows[0]!, {
    companyId: source.companyId, missionId: source.missionId, workflowRunId: source.workflowRunId,
    workflowStepRunId: source.workflowStepRunId, issueId: source.issueId, heartbeatRunId: successorRun.id,
    wakeupRequestId: successorWake.id, executionGeneration: source.executionGeneration,
  }, "pass")) {
    return held("terminal_successor_official_pass_missing_or_mismatched");
  }

  const successorAckIds: string[] = [];
  for (const obligation of pending) {
    const matches = successor.manifest.obligations.filter(item => item.stage === obligation.stage
      && isDeepStrictEqual(item.action, obligation.action));
    if (matches.length !== 1) return held("terminal_successor_obligation_missing_or_ambiguous");
    const ack = await readTerminalReleaseAcknowledgment(db, successorContinuationEventId, matches[0]!.effectKey);
    if (ack.kind !== "acknowledged") return held(ack.kind === "held" ? ack.reason : "terminal_successor_obligation_pending");
    successorAckIds.push(ack.eventId);
  }
  const originalAckIds = originalAcks.flatMap(ack => ack.kind === "acknowledged" ? [ack.eventId] : []);
  const originalActual = await db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, source.companyId),
    eq(workflowTransitionEvents.heartbeatRunId, source.heartbeatRunId),
    eq(workflowTransitionEvents.eventType, ACTUAL_DRAIN_EVENT_TYPE),
    eq(workflowTransitionEvents.idempotencyKey, ACTUAL_DRAIN_KEY(source)),
  ));
  const successorActual = await db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, source.companyId),
    eq(workflowTransitionEvents.heartbeatRunId, successorRun.id),
    eq(workflowTransitionEvents.eventType, ACTUAL_DRAIN_EVENT_TYPE),
    eq(workflowTransitionEvents.idempotencyKey, ACTUAL_DRAIN_KEY(successor.manifest.source)),
  ));
  if (originalActual.length !== 1 || successorActual.length !== 1) return held("terminal_successor_actual_event_missing_or_ambiguous");
  const proofEventIds = [...new Set([eventId, originalActual[0]!.id, verdictRow.id, preparationRow.id,
    completionRow.id, successorManifests[0]!.id, successorActual[0]!.id, passRows[0]!.id,
    ...originalAckIds, ...successorAckIds])].sort();
  const lockSet = {
    missionId: source.missionId, workflowRunId: source.workflowRunId,
    heartbeatIds: [source.heartbeatRunId, successorRun.id].sort(), issueId: source.issueId,
    stepIds: [...new Set([source.workflowStepRunId, preparation.producer.stepRunId])].sort(),
    wakeIds: [source.wakeupRequestId, successorWake.id].sort(),
  };
  return { kind: "ready", value: { original, preparation,
    successorWake, successorRun, successorContinuationEventId, successor,
    pending, proofEventIds, lockSet } };
}

async function lockLineage(tx: Parameters<Parameters<Db["transaction"]>[0]>[0], value: Discovery) {
  const { missionId, workflowRunId, heartbeatIds, issueId, stepIds, wakeIds } = value.lockSet;
  const missionRows = await tx.select({ id: missions.id }).from(missions).where(and(
    eq(missions.id, missionId), eq(missions.companyId, value.original.manifest.source.companyId),
  )).for("no key update");
  const workflowRows = await tx.select({ id: workflowRuns.id }).from(workflowRuns).where(and(
    eq(workflowRuns.id, workflowRunId), eq(workflowRuns.companyId, value.original.manifest.source.companyId),
  )).for("no key update");
  const heartbeatRows = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, value.original.manifest.source.companyId), inArray(heartbeatRuns.id, heartbeatIds),
  )).orderBy(asc(heartbeatRuns.id)).for("update");
  const issueRows = await tx.select({ id: issues.id }).from(issues).where(and(
    eq(issues.id, issueId), eq(issues.companyId, value.original.manifest.source.companyId),
  )).for("update");
  const stepRows = await tx.select({ id: workflowStepRuns.id }).from(workflowStepRuns).where(and(
    eq(workflowStepRuns.workflowRunId, workflowRunId), inArray(workflowStepRuns.id, stepIds),
  )).orderBy(asc(workflowStepRuns.id)).for("update");
  const wakeRows = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
    .where(inArray(agentWakeupRequests.id, wakeIds)).orderBy(asc(agentWakeupRequests.id)).for("update");
  const eventRows = await tx.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents)
    .where(inArray(workflowTransitionEvents.id, value.proofEventIds)).orderBy(asc(workflowTransitionEvents.id)).for("share");
  return missionRows.length === 1 && workflowRows.length === 1 && heartbeatRows.length === heartbeatIds.length
    && issueRows.length === 1 && stepRows.length === stepIds.length && wakeRows.length === wakeIds.length
    && eventRows.length === value.proofEventIds.length;
}

class SettlementAbort extends Error {
  constructor(readonly reason: string) { super(reason); }
}

/** Settle only original pending records already proven by the lawful current QA successor. */
export async function settleTerminalContinuationFromQaSuccessor(db: Db, eventId: string): Promise<
  { kind: "complete" } | { kind: "held"; reason: string }> {
  try {
    return await withTxTimeout(db, async tx => {
      const first = await discover(tx, eventId);
      if (first.kind === "held") return first;
      if (first.kind === "complete") return { kind: "complete" };
      if (!await lockLineage(tx, first.value)) return held("terminal_successor_lock_scope_changed");
      const locked = await discover(tx, eventId);
      if (locked.kind === "held") return locked;
      if (locked.kind === "complete") return { kind: "complete" };
      if (!isDeepStrictEqual(first.value.lockSet, locked.value.lockSet)
        || !isDeepStrictEqual(first.value.proofEventIds, locked.value.proofEventIds)) {
        return held("terminal_successor_lineage_changed_while_locking");
      }
      const finalOwner = await readTerminalContinuationSource(locked.value.successorContinuationEventId, tx);
      if (finalOwner.kind !== "ready" || !exactSourceAttempt(first.value.original.manifest.source, finalOwner.manifest.source)) {
        throw new SettlementAbort(finalOwner.kind === "held" ? finalOwner.reason : "terminal_successor_current_owner_changed");
      }
      for (const obligation of locked.value.pending) {
        const ack = await acknowledgeTerminalReleaseObligation(tx, eventId, obligation.effectKey);
        if (ack.kind === "held") throw new SettlementAbort(ack.reason);
        const reread = await readTerminalReleaseAcknowledgment(tx, eventId, obligation.effectKey);
        if (reread.kind !== "acknowledged") {
          throw new SettlementAbort(reread.kind === "held" ? reread.reason : "terminal_successor_original_ack_not_durable");
        }
      }
      return { kind: "complete" };
    }, { label: "heartbeat:terminal-successor-settlement" });
  } catch (error) {
    if (error instanceof SettlementAbort) return held(error.reason);
    throw error;
  }
}

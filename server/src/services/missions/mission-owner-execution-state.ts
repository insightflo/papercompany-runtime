// server/src/services/missions/mission-owner-execution-state.ts
//
// [목적] 미션 오너 실행의 intent/applied 원장·멱등 key·결과 투영과 실제 실행 현재성 펜스.
// facade와 dag-engine은 같은 잠금 순서(mission→run→step)로 machine contract만 재확인한다.
import { and, desc, eq } from "drizzle-orm";
import {
  missions, workflowRecoveryAuthorities, workflowRuns, workflowStepRuns, workflowTransitionEvents, type Db,
} from "@paperclipai/db";
import type { MissionOwnerAction } from "@paperclipai/shared/validators/mission-owner-authority";
import { OWNER_HUMAN_LAYER, OWNER_HUMAN_SOURCE } from "./owner-human-request-contract.js";
export type OwnerActionResult = {
  schemaVersion: 1; actionId: string; operation: MissionOwnerAction["operation"];
  state: "accepted" | "applied" | "delivery_pending" | "executing" | "needs_evidence" | "resolved" | "blocked" | "superseded";
  reasonCode: string | null;
  evidence: Array<{ kind: "authority" | "dispatch" | "heartbeat" | "artifact" | "qa" | "plan";
    recordId: string; workflowRunId: string | null; stepRunId: string | null;
    executionGeneration: number | null; requestId: string | null }>;
  requiredAction: null | { kind: "submit_artifact" | "submit_qa_verdict" | "wait_active_execution"
    | "request_access" | "board_resume" | "board_revision_start" | "submit_corrected_plan";
    targetId: string; reasonCode: string };
};
export type OwnerExecutionAdmission = { schemaVersion: 1; actionId: string;
  expectedAuthorityVersion: number; expectedExecutionGeneration: number };
export const INTENT_EVENT = "owner_execute_intent_v1", APPLIED_EVENT = "owner_execute_applied_v1";
const CONSUMED_EVENT = "owner_human_consumed_v1";
const LAYER = "mission_owner_authority";
const SOURCE = "mission_owner_execute";
const REFERENCE_PREFIX = "mission-owner-execute:";
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const num = (value: unknown): number | null => typeof value === "number" && Number.isInteger(value) ? value : null;
type OwnerResponse = { lifetimeId: string | null; operatorDecisionId: string; responseRunId: string; responseWake: { id: string }; actualWake: { id: string } } | null;
export function ownerIntentResponseSource(response: OwnerResponse, heartbeatRunId: string) {
  return response?.lifetimeId ? { schemaVersion: 1, lifetimeId: response.lifetimeId,
    operatorDecisionId: response.operatorDecisionId, heartbeatRunId, wakeupRequestId: response.actualWake.id,
    responseHeartbeatRunId: response.responseRunId, responseWakeupRequestId: response.responseWake.id } : null;
}
async function intentResponseSourceValid(db: Db, companyId: string, missionId: string, issueId: string, heartbeatRunId: string | null, lifetimeId: string | null, value: unknown) {
  if (value === null || value === undefined) return lifetimeId === null;
  const source = record(value);
  if (typeof lifetimeId !== "string" || source.schemaVersion !== 1 || source.lifetimeId !== lifetimeId
    || typeof source.operatorDecisionId !== "string" || source.heartbeatRunId !== heartbeatRunId
    || typeof source.wakeupRequestId !== "string" || typeof source.responseHeartbeatRunId !== "string"
    || typeof source.responseWakeupRequestId !== "string") return false;
  const [consumed] = await db.select({ missionId: workflowTransitionEvents.missionId, issueId: workflowTransitionEvents.issueId,
    wakeupRequestId: workflowTransitionEvents.wakeupRequestId, layer: workflowTransitionEvents.layer, reason: workflowTransitionEvents.reason, reasonCode: workflowTransitionEvents.reasonCode, payload: workflowTransitionEvents.payload }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.eventType, CONSUMED_EVENT),
    eq(workflowTransitionEvents.heartbeatRunId, heartbeatRunId!), eq(workflowTransitionEvents.idempotencyKey, `${CONSUMED_EVENT}:${source.lifetimeId}:${heartbeatRunId}`))).limit(1);
  const payload = record(consumed?.payload);
  return consumed?.missionId === missionId && consumed.issueId === issueId && consumed.wakeupRequestId === source.wakeupRequestId
    && consumed.layer === OWNER_HUMAN_LAYER && consumed.reason === OWNER_HUMAN_SOURCE && consumed.reasonCode === OWNER_HUMAN_SOURCE
    && payload.schemaVersion === 1 && payload.kind === CONSUMED_EVENT
    && payload.lifetimeId === source.lifetimeId && payload.operatorDecisionId === source.operatorDecisionId
    && payload.heartbeatRunId === source.heartbeatRunId && payload.wakeupRequestId === source.wakeupRequestId
    && payload.responseHeartbeatRunId === source.responseHeartbeatRunId
    && payload.responseWakeupRequestId === source.responseWakeupRequestId;
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
export const intentIdempotencyKey = (companyId: string, missionId: string,
  ownerActionIssueId: string, actionRequestId: string): string =>
  `mission-owner-execute:v1:${companyId}:${missionId}:${ownerActionIssueId}:${actionRequestId}`;
export const intentKeyWhere = (companyId: string, idempotencyKey: string) => and(eq(workflowTransitionEvents.companyId, companyId),
  eq(workflowTransitionEvents.idempotencyKey, idempotencyKey), eq(workflowTransitionEvents.eventType, INTENT_EVENT), eq(workflowTransitionEvents.layer, LAYER));
export async function latestIntentEventId(db: Db, companyId: string, ownerActionIssueId: string): Promise<string | null> {
  const [latest] = await db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents)
    .where(and(eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.issueId, ownerActionIssueId),
      eq(workflowTransitionEvents.eventType, INTENT_EVENT), eq(workflowTransitionEvents.layer, LAYER),
      eq(workflowTransitionEvents.reason, SOURCE)))
    .orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id)).limit(1);
  return latest && await loadIntentEvent(db, companyId, latest.id) ? latest.id : null;
}
async function loadIntentEvent(db: Db, companyId: string, actionId: string): Promise<{
  issueId: string; missionId: string; agentId: string | null; bodyFingerprint: unknown;
} | null> {
  const [intent] = await db.select({ issueId: workflowTransitionEvents.issueId, missionId: workflowTransitionEvents.missionId,
    heartbeatRunId: workflowTransitionEvents.heartbeatRunId, correlationId: workflowTransitionEvents.correlationId,
    payload: workflowTransitionEvents.payload })
    .from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.id, actionId),
      eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.eventType, INTENT_EVENT),
      eq(workflowTransitionEvents.layer, LAYER), eq(workflowTransitionEvents.reason, SOURCE))).limit(1);
  if (!intent?.issueId || !intent.missionId) return null;
  if (!(await intentResponseSourceValid(db, companyId, intent.missionId, intent.issueId,
    intent.heartbeatRunId, intent.correlationId,
    record(intent.payload).ownerHumanResponse))) return null;
  return { issueId: intent.issueId, missionId: intent.missionId,
    agentId: typeof record(intent.payload).agentId === "string" ? record(intent.payload).agentId as string : null,
    bodyFingerprint: record(intent.payload).bodyFingerprint };
}
export async function loadAppliedPayload(db: Db, companyId: string, actionId: string): Promise<Record<string, unknown> | null> {
  const [applied] = await db.select({ payload: workflowTransitionEvents.payload }).from(workflowTransitionEvents)
    .where(and(eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.eventType, APPLIED_EVENT),
      eq(workflowTransitionEvents.layer, LAYER), eq(workflowTransitionEvents.reason, SOURCE),
      eq(workflowTransitionEvents.correlationId, actionId))).limit(1);
  return applied ? record(applied.payload) : null;
}
export async function recordAppliedEvent(db: Db, companyId: string, input: {
  actionId: string; operation: MissionOwnerAction["operation"]; missionId: string;
  workflowRunId: string; stepRunId: string; authorityId: string | null;
  authorityVersion: number | null; executionGeneration: number | null; dispatchRequestId: string | null;
}): Promise<void> {
  await db.insert(workflowTransitionEvents).values({ companyId,
    missionId: input.missionId, workflowRunId: input.workflowRunId, workflowStepRunId: input.stepRunId,
    eventType: APPLIED_EVENT, layer: LAYER, reason: SOURCE, reasonCode: SOURCE, correlationId: input.actionId,
    idempotencyKey: `mission-owner-applied:v1:${companyId}:${input.actionId}`,
    payload: { schemaVersion: 1, kind: APPLIED_EVENT, actionId: input.actionId, operation: input.operation,
      authorityId: input.authorityId, authorityVersion: input.authorityVersion, executionGeneration: input.executionGeneration,
      workflowRunId: input.workflowRunId, stepRunId: input.stepRunId, dispatchRequestId: input.dispatchRequestId } }).onConflictDoNothing();
}
const evidenceItem = (kind: "authority" | "dispatch" | "heartbeat", recordId: string | null,
  workflowRunId: string | null, stepRunId: string | null, executionGeneration: number | null, requestId: string | null) =>
  ({ kind, recordId: recordId ?? "", workflowRunId, stepRunId, executionGeneration, requestId });
export async function projectOwnerActionResult(db: Db, companyId: string, missionId: string, actionId: string,
  operation: MissionOwnerAction["operation"]): Promise<OwnerActionResult> {
  const base = { schemaVersion: 1 as const, actionId, operation, requiredAction: null };
  const applied = await loadAppliedPayload(db, companyId, actionId);
  if (!applied) return { ...base, state: "blocked", reasonCode: "action_not_applied",
    evidence: [evidenceItem("heartbeat", actionId, null, null, null, null)] };
  const workflowRunId = typeof applied.workflowRunId === "string" ? applied.workflowRunId : "";
  const stepRunId = typeof applied.stepRunId === "string" ? applied.stepRunId : "";
  const authorityId = typeof applied.authorityId === "string" ? applied.authorityId : null;
  const evidence = [evidenceItem("authority", authorityId, workflowRunId, stepRunId, null, null)];
  const [row] = await db.select({ stepRun: workflowStepRuns, run: workflowRuns }).from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId)).where(and(
      eq(workflowStepRuns.id, stepRunId), eq(workflowRuns.companyId, companyId),
      eq(workflowRuns.missionId, missionId))).limit(1);
  if (!row) return { ...base, state: "needs_evidence", reasonCode: "attempt_record_missing", evidence,
    requiredAction: { kind: "wait_active_execution", targetId: stepRunId, reasonCode: "attempt_record_missing" } };
  const receipt = record(row.stepRun.metadata).ownerToolRetry;
  if (num(applied.authorityVersion) !== row.run.dispatchAuthorityVersion || record(receipt).authorityId !== authorityId
    || num(applied.executionGeneration) !== row.stepRun.executionGeneration) { return { ...base, state: "superseded", reasonCode: "attempt_superseded", evidence }; }
  evidence.push(evidenceItem("dispatch", row.stepRun.lastDispatchRequestId, workflowRunId,
    stepRunId, row.stepRun.executionGeneration, row.stepRun.lastDispatchRequestId));
  const toolResult = record(record(row.stepRun.metadata).toolResult);
  if (row.stepRun.status === "completed") {
    if (toolResult.success === true) return { ...base, state: "resolved", reasonCode: null, evidence };
    if (typeof toolResult.completedAt === "string") return { ...base, state: "blocked", reasonCode: "tool_execution_failed", evidence };
    return { ...base, state: "needs_evidence", reasonCode: "current_tool_result_missing", evidence,
      requiredAction: { kind: "wait_active_execution", targetId: stepRunId, reasonCode: "current_tool_result_missing" } };
  }
  if (row.stepRun.status === "failed") return { ...base, state: "blocked", reasonCode: "tool_execution_failed", evidence };
  if (row.stepRun.status === "pending") return { ...base, state: "delivery_pending", reasonCode: null, evidence };
  if (row.stepRun.status === "running") return { ...base, state: "executing", reasonCode: null, evidence };
  return { ...base, state: "blocked", reasonCode: "attempt_inactive", evidence };
}
/** [owner plan admission fence] run metadata 에 저장된 owner 계획 연결(ownerPlanExecution.actionId)
 *  이 아직 현재 소유 intent 인지 재확인한다 — 미션 활성·오너 일치·이슈-국소 최신 intent.
 *  무연결 run(ordinary 계획 포함)과 ownerToolRetry 영수증이 지배하는 스텝은 항상 현재다
 *  (receipt/authority 검사가 그 admission 을 소유한다). 실제 실행 admission(tools 큐·도구 발사·
 *  wake)은 이 펜스에서 연기·거부된다 — 오래된 소유 intent 아래 실행을 승인하지 않는다. */
export async function ownerPlanExecutionIntentCurrent(db: Db, companyId: string,
  input: { runMetadata: unknown; stepMetadata?: unknown }): Promise<boolean> {
  if (typeof record(record(input.stepMetadata).ownerToolRetry).authorityId === "string") return true;
  const stored = record(record(input.runMetadata).ownerPlanExecution);
  const actionId = typeof stored.actionId === "string" ? stored.actionId : null;
  if (!actionId) return true;
  const intent = await loadIntentEvent(db, companyId, actionId);
  if (!intent) return false;
  const [mission] = await db.select({ status: missions.status, ownerAgentId: missions.ownerAgentId })
    .from(missions).where(and(eq(missions.id, intent.missionId), eq(missions.companyId, companyId))).limit(1);
  if (!mission || mission.status !== "active" || typeof intent.agentId !== "string"
    || mission.ownerAgentId !== intent.agentId) return false;
  return await latestIntentEventId(db, companyId, intent.issueId) === actionId;
}
/** [invocation fence] owner-execute 연결 시도만 임계구간에서 현재 intent/권한버전/세대를 재확인한다. */
export async function withCurrentOwnerToolAttempt<T>(input: { db: Db; companyId: string; requestId?: string | null;
  workflowRunId?: string | null; stepRunId?: string | null; }, launch: () => Promise<T>): Promise<T> {
  if (!input.stepRunId) return launch();
  const [row] = await input.db.select({ stepRun: workflowStepRuns, run: workflowRuns }).from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
    .where(and(eq(workflowStepRuns.id, input.stepRunId), eq(workflowRuns.companyId, input.companyId))).limit(1);
  const receipt = record(row?.stepRun.metadata).ownerToolRetry;
  const authorityId = record(receipt).authorityId;
  if (!row || typeof authorityId !== "string") {
    // [owner plan admission] ownerToolRetry 영수증이 없는 도구 발사는 저장된 계획 연결의 현재성을
    //   재확인한다 — 오래된 소유 intent 아래 첫 실제 실행은 거부한다(무연결 도구는 무변화 통과).
    if (row && !(await ownerPlanExecutionIntentCurrent(input.db, input.companyId,
      { runMetadata: row.run.metadata, stepMetadata: row.stepRun.metadata }))) throw new Error("owner_plan_execution_stale");
    return launch();
  }
  const [authority] = await input.db.select({ requestReference: workflowRecoveryAuthorities.requestReference })
    .from(workflowRecoveryAuthorities).where(and(eq(workflowRecoveryAuthorities.id, authorityId),
      eq(workflowRecoveryAuthorities.companyId, input.companyId))).limit(1);
  const reference = authority?.requestReference ?? "";
  if (!reference.startsWith(REFERENCE_PREFIX)) return launch(); // unrelated tools keep existing behavior
  const actionId = reference.slice(REFERENCE_PREFIX.length);
  const receiptAuthorityVersion = num(record(receipt).authorityVersion);
  const receiptGeneration = num(record(receipt).executionGeneration);
  const current = await input.db.transaction(async (tx) => {
    const intent = await loadIntentEvent(tx as unknown as Db, input.companyId, actionId);
    if (!intent) return false;
    const [mission] = await tx.select({ status: missions.status, ownerAgentId: missions.ownerAgentId })
      .from(missions).where(and(eq(missions.id, intent.missionId), eq(missions.companyId, input.companyId))).for("update");
    if (!mission || mission.status !== "active" || typeof intent.agentId !== "string"
      || mission.ownerAgentId !== intent.agentId) return false;
    const [run] = await tx.select({ dispatchAuthorityVersion: workflowRuns.dispatchAuthorityVersion,
      status: workflowRuns.status }).from(workflowRuns).where(and(eq(workflowRuns.id, row.run.id),
      eq(workflowRuns.companyId, input.companyId))).for("update");
    if (!run || run.status !== "running" || receiptAuthorityVersion !== run.dispatchAuthorityVersion) return false;
    const [step] = await tx.select({ status: workflowStepRuns.status,
      executionGeneration: workflowStepRuns.executionGeneration }).from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, row.stepRun.id)).for("update");
    if (!step || !["pending", "running"].includes(step.status) || receiptGeneration !== step.executionGeneration) return false;
    return await latestIntentEventId(tx as unknown as Db, input.companyId, intent.issueId) === actionId;
  });
  if (!current) throw new Error("owner_attempt_stale");
  return launch();
}
/** [admission fence] 승인 직전 현재 소유자·최신 intent·권한버전·실행세대·스텝 상태를 같은 잠금
 *  순서(mission→run→step)로 재확인한다. 불일치 시 throw — 호출자는 만들려던 durable 부작용을 중단한다. */
export async function assertCurrentOwnerExecution(db: Db, input: {
  companyId: string; missionId: string; workflowRunId: string; stepRunId: string;
  admission: OwnerExecutionAdmission;
}): Promise<void> {
  const intent = await loadIntentEvent(db, input.companyId, input.admission.actionId);
  if (!intent || intent.missionId !== input.missionId) throw new Error("owner_execution_admission_stale");
  const current = await db.transaction(async (tx) => {
    const [mission] = await tx.select({ status: missions.status, ownerAgentId: missions.ownerAgentId })
      .from(missions).where(and(eq(missions.id, input.missionId), eq(missions.companyId, input.companyId))).for("update");
    if (!mission || mission.status !== "active" || typeof intent.agentId !== "string"
      || mission.ownerAgentId !== intent.agentId) return false;
    const [run] = await tx.select({ status: workflowRuns.status, dispatchAuthorityVersion: workflowRuns.dispatchAuthorityVersion })
      .from(workflowRuns).where(and(eq(workflowRuns.id, input.workflowRunId),
        eq(workflowRuns.companyId, input.companyId), eq(workflowRuns.missionId, input.missionId))).for("update");
    if (!run || run.status !== "running" || run.dispatchAuthorityVersion !== input.admission.expectedAuthorityVersion) return false;
    const [step] = await tx.select({ status: workflowStepRuns.status, executionGeneration: workflowStepRuns.executionGeneration })
      .from(workflowStepRuns).where(and(eq(workflowStepRuns.id, input.stepRunId),
        eq(workflowStepRuns.workflowRunId, input.workflowRunId))).for("update");
    if (!step || !["pending", "running", "completed"].includes(step.status)
      || step.executionGeneration !== input.admission.expectedExecutionGeneration) return false;
    return await latestIntentEventId(tx as unknown as Db, input.companyId, intent.issueId) === input.admission.actionId;
  });
  if (!current) throw new Error("owner_execution_admission_stale");
}
/** [wake admission] 저장된 owner-execute 연결 영수증(metadata.ownerToolRetry + authority
 *  requestReference prefix)에서 owner-linked 여부를 판별한다. caller 가 인자를 생략해도
 *  검사가 우회되지 않으며, 무연결 run(사람 경로 포함)은 기존 동작 그대로 통과한다.
 *  현재 run 상태와 일치하는 영수증만 지배한다 — 이후 다른 복구가 버전/세대를 옮겼으면
 *  그 복구의 규칙이 지배하며 옛 영수증은 이 wake 를 막지 않는다. */
export async function admitOwnerLinkedStepWake(db: Db, input: {
  companyId: string; workflowRunId: string; stepRunId: string | null;
  ownerExecution: OwnerExecutionAdmission | null;
}): Promise<boolean> {
  if (input.ownerExecution) {
    if (!input.stepRunId) return false; // typed admission without its step target cannot be verified
    const typed = await loadIntentEvent(db, input.companyId, input.ownerExecution.actionId);
    if (!typed) return false;
    try { await assertCurrentOwnerExecution(db, { companyId: input.companyId, missionId: typed.missionId,
      workflowRunId: input.workflowRunId, stepRunId: input.stepRunId, admission: input.ownerExecution });
    } catch { return false; }
  }
  const authorities = await db.select({ id: workflowRecoveryAuthorities.id,
    requestReference: workflowRecoveryAuthorities.requestReference })
    .from(workflowRecoveryAuthorities).where(and(eq(workflowRecoveryAuthorities.companyId, input.companyId),
      eq(workflowRecoveryAuthorities.workflowRunId, input.workflowRunId),
      eq(workflowRecoveryAuthorities.recoveryKind, "supervision_tool_retry")));
  const linked = authorities.filter((authority): authority is { id: string; requestReference: string } =>
    typeof authority.requestReference === "string" && authority.requestReference.startsWith(REFERENCE_PREFIX));
  if (linked.length === 0) {
    // [owner plan admission] 복구 권한이 지배하지 않는 run 은 저장된 계획 연결(metadata.ownerPlanExecution)
    //   이 wake 승인을 소유한다 — 오래된 소유 intent 의 wake 는 연기한다(무연결 run 은 무변화 통과).
    const [planRun] = await db.select({ metadata: workflowRuns.metadata }).from(workflowRuns)
      .where(and(eq(workflowRuns.id, input.workflowRunId), eq(workflowRuns.companyId, input.companyId))).limit(1);
    if (planRun && !(await ownerPlanExecutionIntentCurrent(db, input.companyId,
      { runMetadata: planRun.metadata }))) return false;
    return true; // unrelated workflows keep existing behavior
  }
  const [run] = await db.select({ dispatchAuthorityVersion: workflowRuns.dispatchAuthorityVersion })
    .from(workflowRuns).where(and(eq(workflowRuns.id, input.workflowRunId),
      eq(workflowRuns.companyId, input.companyId)));
  if (!run) return false;
  const stepRuns = await db.select({ id: workflowStepRuns.id, status: workflowStepRuns.status,
    executionGeneration: workflowStepRuns.executionGeneration, metadata: workflowStepRuns.metadata })
    .from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, input.workflowRunId));
  for (const authority of linked) {
    const actionId = authority.requestReference.slice(REFERENCE_PREFIX.length);
    const receiptStep = stepRuns.find((candidate) => record(record(candidate.metadata).ownerToolRetry).authorityId === authority.id);
    const receipt = receiptStep ? record(record(receiptStep.metadata).ownerToolRetry) : null;
    const authorityVersion = num(receipt?.authorityVersion);
    const generation = num(receipt?.executionGeneration);
    if (!receiptStep || authorityVersion === null || generation === null) continue;
    if (run.dispatchAuthorityVersion !== authorityVersion || receiptStep.executionGeneration !== generation
      || !["pending", "running", "completed"].includes(receiptStep.status)) continue;
    try {
      const intent = await loadIntentEvent(db, input.companyId, actionId);
      if (!intent) return false;
      await assertCurrentOwnerExecution(db, { companyId: input.companyId, missionId: intent.missionId,
        workflowRunId: input.workflowRunId, stepRunId: receiptStep.id,
        admission: { schemaVersion: 1, actionId, expectedAuthorityVersion: authorityVersion,
          expectedExecutionGeneration: generation } });
    } catch { return false; }
  }
  return true;
}

// server/src/services/missions/mission-owner-delegate-fix.ts
//
// [Stage 7] 오너 수정 위임(delegate_fix) 실행: 공식 QA verdict 이벤트의 구조화 finding 만을 읽어 담당 경로로
//   연결한다. artifact 계열(유효 계층 — 재발 승격 반영)은 run 의 native back-edge 재작업(syncWorkflowRunState →
//   applyBackEdgeReworkPass → producer reset/재발사)로, source_data 계열은 stage 6 재수집 경로(same: exact collector
//   재시도 / changed: 제한된 계획 unit)로 연결하며 혼재는 각 finding 에 정확히 분배한다. 적용 가능한 back-edge 가
//   없는 artifact 수정은 stage 5 계획 unit, failed run 은 stage 4 재개 안내로 남는다 — 오너가 산출물을 직접
//   덮어쓰지 않는다. 해결은 새 producer 산출물 + 독립 현재 QA(생산자와 다른 actor 의 스코프 판정)만 근거로 삼는다.
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  agentWakeupRequests, heartbeatRuns, issueWorkProducts, workflowDefinitions, workflowRuns, workflowStepRuns,
  workflowTransitionEvents, type Db } from "@paperclipai/db";
import { workflowVerdictFindingsSchema } from "@paperclipai/shared";
import type { MissionOwnerAction, MissionOwnerExecuteRequest } from "@paperclipai/shared/validators/mission-owner-authority";
import { resolveEdges } from "../workflow/control-flow/edge-condition.js";
import { applyRecurrencePromotion } from "../workflow/control-flow/rework-contract.js";
import { readCapBoostAmount } from "../workflow/control-flow/types.js";
import { loadPriorRejectedFindings } from "../workflow/validation-verdict-ledger.js";
import { syncWorkflowRunState } from "../workflow/dag-engine.js";
import { loadAppliedPayload, projectOwnerActionResult, recordAppliedEvent, stable, type OwnerActionResult } from "./mission-owner-execution-state.js";
import { OwnerActionRefusalError, type OwnerExecutionContext } from "./mission-owner-execute.js";
import { executeOwnerPlanAction, projectOwnerPlanActionResult } from "./mission-owner-plan-action.js";
import { executeOwnerRecollect, preflightOwnerRecollect } from "./mission-owner-recollect.js";

export type OwnerDelegateFixAction = Extract<MissionOwnerAction, { operation: "delegate_fix" }>;
type StepRunRow = typeof workflowStepRuns.$inferSelect;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const refusal = (status: 403 | 404 | 409 | 422, reasonCode: string): never => { throw new OwnerActionRefusalError(status, reasonCode); };
const evidence = (kind: "authority" | "dispatch" | "heartbeat" | "artifact" | "qa", recordId: string | null,
  workflowRunId: string | null, stepRunId: string | null, executionGeneration: number | null, requestId: string | null) =>
  ({ kind, recordId: recordId ?? "", workflowRunId, stepRunId, executionGeneration, requestId });
function stringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringLeaves(item, out);
  else if (value && typeof value === "object")
    for (const key of Object.keys(value as Record<string, unknown>).sort())
      stringLeaves((value as Record<string, unknown>)[key], out);
  return out;
}
const sameSet = (left: string[], right: string[]): boolean => {
  const a = [...new Set(left)].sort(), b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
};
const relabelDelegateFix = (result: OwnerActionResult): OwnerActionResult =>
  result.operation === "delegate_fix" ? result : { ...result, operation: "delegate_fix" as const };

/** 공식 verdict 이벤트(workflow_api + 반려 + 스코프 heartbeat)에서 구조화 findings 를 읽는다. 자유문 파싱 금지. */
async function loadOfficialVerdict(db: Db, companyId: string, qaVerdictEventId: string) {
  const [row] = await db.select({ event: workflowTransitionEvents }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.id, qaVerdictEventId), eq(workflowTransitionEvents.companyId, companyId),
    eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
    eq(workflowTransitionEvents.layer, "workflow_validation"),
    eq(workflowTransitionEvents.reason, "workflow_api"),
    eq(workflowTransitionEvents.verdict, "request_changes"))).limit(1);
  const event = row?.event;
  if (!event || !event.heartbeatRunId || !event.issueId || !event.workflowRunId || !event.workflowStepRunId) return null;
  const [heartbeat] = await db.select({ companyId: heartbeatRuns.companyId, issueId: heartbeatRuns.issueId }).from(heartbeatRuns).where(eq(heartbeatRuns.id, event.heartbeatRunId)).limit(1);
  if (!heartbeat || heartbeat.companyId !== companyId || heartbeat.issueId !== event.issueId) return null;
  const parsed = workflowVerdictFindingsSchema.safeParse(record(event.payload).findings);
  if (!parsed.success || parsed.data.length === 0) return null;
  return { event, findings: parsed.data };
}

type DelegateFixRouting = {
  producerRun: StepRunRow; runStatus: string; runAuthorityVersion: number;
  producerAgentId: string | null; backEdges: Array<{ stepId: string; maxIterations: number }>;
  maxIterations: number; capBoost: number; iteration: number;
  qaSiblings: Array<{ stepRun: StepRunRow; issueId: string }>;
};
/** producer 의 고정 정의에서 back-edge/QA 형제/cap 사실을 유도한다(투영·실행이 같은 판정을 공유). */
async function deriveRouting(db: Db, companyId: string, action: OwnerDelegateFixAction): Promise<DelegateFixRouting | null> {
  const [row] = await db.select({ stepRun: workflowStepRuns, run: workflowRuns }).from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId)).where(and(eq(workflowStepRuns.id, action.producerTarget.stepRunId),
      eq(workflowRuns.companyId, companyId), eq(workflowRuns.id, action.producerTarget.workflowRunId))).limit(1);
  if (!row) return null;
  const [definition] = await db.select({ stepsJson: workflowDefinitions.stepsJson }).from(workflowDefinitions).where(and(eq(workflowDefinitions.id, row.run.workflowId), eq(workflowDefinitions.companyId, companyId))).limit(1);
  const steps = Array.isArray(definition?.stepsJson) ? definition!.stepsJson as Array<Record<string, unknown>> : [];
  const producerStep = steps.find((step) => step.id === row.stepRun.stepId) ?? {};
  const backEdges = resolveEdges(producerStep as unknown as Parameters<typeof resolveEdges>[0])
    .filter((edge) => edge.isBackEdge === true && typeof edge.maxIterations === "number" && edge.maxIterations >= 1)
    .map((edge) => ({ stepId: edge.stepId, maxIterations: edge.maxIterations! }));
  const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, row.run.id));
  const qaSiblings = backEdges.flatMap((edge) => stepRuns.filter((sr) => sr.stepId === edge.stepId && sr.issueId)
    .map((sr) => ({ stepRun: sr, issueId: sr.issueId! })));
  return { producerRun: row.stepRun, runStatus: row.run.status, runAuthorityVersion: row.run.dispatchAuthorityVersion,
    producerAgentId: typeof producerStep.agentId === "string" ? producerStep.agentId : null,
    backEdges, maxIterations: backEdges.reduce((max, edge) => Math.max(max, edge.maxIterations), 0),
    capBoost: readCapBoostAmount(row.stepRun.metadata), iteration: row.stepRun.iterationIndex ?? 0, qaSiblings };
}

/** 유효 계층 findings: 직전 세대 재발 승격을 native 와 같은 세대 경계 가드로 반영한다(loop-driver §2b). */
async function effectiveFindings(db: Db, companyId: string, verdict: NonNullable<Awaited<ReturnType<typeof loadOfficialVerdict>>>,
  producerCompletedAt: Date | null) {
  const prior = producerCompletedAt ? await loadPriorRejectedFindings({ db, companyId, issueId: verdict.event.issueId!,
    workflowRunId: verdict.event.workflowRunId!, workflowStepRunId: verdict.event.workflowStepRunId!, notAfter: producerCompletedAt }) : null;
  return applyRecurrencePromotion(verdict.findings, prior).findings;
}

/** 선언 sourceRefs 와 frozen toolArgs 잎값이 정확 일치하는 collector 스텝런을 이 run 에서 찾는다. */
async function findCollectorStepRun(db: Db, companyId: string, workflowRunId: string,
  sourceRefs: string[]): Promise<StepRunRow | null | "ambiguous"> {
  const [run] = await db.select({ workflowId: workflowRuns.workflowId }).from(workflowRuns).where(and(eq(workflowRuns.id, workflowRunId), eq(workflowRuns.companyId, companyId))).limit(1);
  if (!run) return null;
  const [definition] = await db.select({ stepsJson: workflowDefinitions.stepsJson }).from(workflowDefinitions).where(and(eq(workflowDefinitions.id, run.workflowId), eq(workflowDefinitions.companyId, companyId))).limit(1);
  const steps = Array.isArray(definition?.stepsJson) ? definition!.stepsJson as Array<Record<string, unknown>> : [];
  const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, workflowRunId));
  const matches = steps.filter((step) => sameSet(sourceRefs, stringLeaves(step.toolArgs)))
    .flatMap((step) => rows.filter((sr) => sr.stepId === step.id));
  if (matches.length > 1) return "ambiguous";
  return matches[0] ?? null;
}

/** source_data 부를 stage 6 재수집 계약(same/changed)의 정확한 action 모양으로 옮긴다. */
function recollectActionFor(action: OwnerDelegateFixAction, collector: StepRunRow | null,
  routing: DelegateFixRouting): MissionOwnerAction {
  const collection = action.collection!;
  if (collection.plan) return { operation: "recollect", collectorTarget: action.producerTarget, // changed: 대상 심사는 plan 소관
    sourceRefs: collection.sourceRefs, mode: "changed_collection", plan: collection.plan };
  const target = collector!;
  return { operation: "recollect", sourceRefs: collection.sourceRefs, mode: "same_configuration",
    collectorTarget: target.issueId
      ? { kind: "issue_step", issueId: target.issueId, workflowRunId: target.workflowRunId, stepRunId: target.id,
          expectedAuthorityVersion: routing.runAuthorityVersion, expectedExecutionGeneration: target.executionGeneration,
          failedDispatchRequestId: target.lastDispatchRequestId }
      : { kind: "tool_step", workflowRunId: target.workflowRunId, stepRunId: target.id,
          expectedAuthorityVersion: routing.runAuthorityVersion, expectedExecutionGeneration: target.executionGeneration,
          failedDispatchRequestId: target.lastDispatchRequestId } };
}

/** [preflight] intent 기록 전 구조 검증(전부 읽기 전용 — 위반은 404/422 부작용 0 거부). */
export async function preflightOwnerDelegateFix(context: OwnerExecutionContext,
  request: MissionOwnerExecuteRequest): Promise<void> {
  const action = request.action;
  if (action.operation !== "delegate_fix") return;
  const verdict = await loadOfficialVerdict(context.db, context.companyId, action.qaVerdictEventId);
  if (!verdict || verdict.event.workflowRunId !== action.producerTarget.workflowRunId)
    throw new OwnerActionRefusalError(404, "qa_verdict_not_found");
  const requested = [...new Set(action.findingIds)].sort(), actual = verdict.findings.map((finding) => finding.id).sort();
  if (requested.length !== action.findingIds.length || stable(requested) !== stable(actual))
    throw new OwnerActionRefusalError(422, "finding_mismatch");
  const routing = await deriveRouting(context.db, context.companyId, action);
  if (!routing) throw new OwnerActionRefusalError(404, "target_not_found");
  const effective = await effectiveFindings(context.db, context.companyId, verdict, routing.producerRun.completedAt);
  if (effective.some((finding) => finding.layer === "source_data")) {
    if (!action.collection) throw new OwnerActionRefusalError(422, "collection_required");
    if (action.collection.plan) {
      await preflightOwnerRecollect(context, { ...request, action: recollectActionFor(action, null, routing) });
    } else {
      const collector = await findCollectorStepRun(context.db, context.companyId,
        action.producerTarget.workflowRunId, action.collection.sourceRefs);
      if (collector === "ambiguous") throw new OwnerActionRefusalError(422, "collector_target_ambiguous");
      if (!collector) throw new OwnerActionRefusalError(404, "collector_not_found");
      await preflightOwnerRecollect(context, { ...request, action: recollectActionFor(action, collector, routing) });
    }
  }
  if (effective.some((finding) => finding.layer === "artifact") && routing.backEdges.length === 0 && !action.plan)
    refusal(422, "plan_required"); // 적용 가능한 back-edge 없음 → 제한된 계획 unit 이 필수다
}

/** 생산자가 재완료한 이후 관측된, 생산자와 다른 actor 의 공식 판정만 읽는다(독립 현재 QA). */
async function freshIndependentVerdict(db: Db, companyId: string, qa: { stepRun: StepRunRow; issueId: string },
  after: Date, producerAgentId: string | null): Promise<{ verdict: "pass" | "request_changes"; eventId: string } | null> {
  const rows = await db.select({ id: workflowTransitionEvents.id, verdict: workflowTransitionEvents.verdict,
    createdAt: workflowTransitionEvents.createdAt, heartbeatRunId: workflowTransitionEvents.heartbeatRunId })
    .from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.issueId, qa.issueId),
    eq(workflowTransitionEvents.workflowRunId, qa.stepRun.workflowRunId),
    eq(workflowTransitionEvents.workflowStepRunId, qa.stepRun.id),
    eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
    eq(workflowTransitionEvents.reason, "workflow_api")))
    .orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id)).limit(5);
  for (const row of rows) {
    if (!row.heartbeatRunId || !row.createdAt || row.createdAt.getTime() <= after.getTime()) continue;
    const [heartbeat] = await db.select({ agentId: heartbeatRuns.agentId, issueId: heartbeatRuns.issueId })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, row.heartbeatRunId)).limit(1);
    if (!heartbeat || heartbeat.issueId !== qa.issueId || heartbeat.agentId === producerAgentId) continue;
    if (row.verdict === "pass" || row.verdict === "request_changes") return { verdict: row.verdict, eventId: row.id };
    return null; // 최신 판정이 확정적이지 않다(insufficient_evidence)
  }
  return null;
}

/** [투영] intent 원문에서 경로를 재유도해 현재 상태만 읽는다 — 옛 판정·파일 존재·댓글은 근거가 아니다. */
export async function projectOwnerDelegateFixResult(db: Db, companyId: string, missionId: string,
  actionId: string): Promise<OwnerActionResult> {
  const [intent] = await db.select({ payload: workflowTransitionEvents.payload }).from(workflowTransitionEvents)
    .where(and(eq(workflowTransitionEvents.id, actionId), eq(workflowTransitionEvents.companyId, companyId),
      eq(workflowTransitionEvents.eventType, "owner_execute_intent_v1"),
      eq(workflowTransitionEvents.layer, "mission_owner_authority"))).limit(1);
  const action = record(record(intent?.payload).action);
  const typed = action as unknown as OwnerDelegateFixAction;
  const routing = action.operation === "delegate_fix" ? await deriveRouting(db, companyId, typed) : null;
  const verdict = action.operation === "delegate_fix" ? await loadOfficialVerdict(db, companyId, String(action.qaVerdictEventId ?? "")) : null;
  const effective = routing && verdict ? await effectiveFindings(db, companyId, verdict, routing.producerRun.completedAt) : [];
  const base = { schemaVersion: 1 as const, actionId, operation: "delegate_fix" as const, requiredAction: null };
  const workflowRunId = routing?.producerRun.workflowRunId ?? String(record(action.producerTarget).workflowRunId ?? "");
  const stepRunId = routing?.producerRun.id ?? String(record(action.producerTarget).stepRunId ?? "");
  // [mixed 병합] source 부가 변경 수집 계획(collection.plan)이면 계획 투영을 함께 계산해 artifact 부와 병합한다.
  const planPart = effective.some((finding) => finding.layer === "source_data")
    && Object.keys(record(record(action.collection).plan)).length > 0
    ? relabelDelegateFix(await projectOwnerPlanActionResult(db, companyId, missionId, actionId)) : null;
  if (effective.length > 0 && !effective.some((finding) => finding.layer === "artifact")) // source-only 경로
    return planPart ?? await projectOwnerActionResult(db, companyId, missionId, actionId, "delegate_fix"); // same: collector 영수증 투영
  const artifactPart = await (async (): Promise<OwnerActionResult> => {
  const applied = await loadAppliedPayload(db, companyId, actionId);
  if (!applied) return { ...base, state: "blocked", reasonCode: "action_not_applied",
    evidence: [evidence("heartbeat", actionId, workflowRunId, stepRunId, null, null)] };
  if (!routing) return { ...base, state: "needs_evidence", reasonCode: "attempt_record_missing",
    evidence: [evidence("authority", actionId, workflowRunId, stepRunId, null, null)],
    requiredAction: { kind: "wait_active_execution", targetId: stepRunId, reasonCode: "attempt_record_missing" } };
  const ev = [evidence("authority", actionId, workflowRunId, stepRunId, null, null)];
  const [producer] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, routing.producerRun.id)).limit(1);
  if (!producer) return { ...base, state: "needs_evidence", reasonCode: "attempt_record_missing", evidence: ev,
    requiredAction: { kind: "wait_active_execution", targetId: stepRunId, reasonCode: "attempt_record_missing" } };
  if (producer.status === "failed") return { ...base, state: "blocked", reasonCode: "producer_execution_failed", evidence: ev };
  if (producer.status === "completed") {
    ev.push(evidence("dispatch", producer.lastDispatchRequestId, workflowRunId, stepRunId, producer.executionGeneration, producer.lastDispatchRequestId));
    if (producer.issueId) { // 새 산출물 등록 확인 — 등록 누락은 정확한 제출 요청
      const products = await db.select({ id: issueWorkProducts.id }).from(issueWorkProducts)
        .where(and(eq(issueWorkProducts.companyId, companyId), eq(issueWorkProducts.issueId, producer.issueId),
          eq(issueWorkProducts.status, "active"))).limit(1);
      if (products.length === 0) return { ...base, state: "needs_evidence", reasonCode: "producer_artifact_missing", evidence: ev,
        requiredAction: { kind: "submit_artifact", targetId: producer.issueId, reasonCode: "producer_artifact_missing" } };
      ev.push(evidence("artifact", producer.issueId, workflowRunId, stepRunId, null, null));
    }
    const completedAt = producer.completedAt ?? new Date(0);
    const verdicts: Array<{ verdict: "pass" | "request_changes"; eventId: string } | null> = [];
    for (const qa of routing.qaSiblings) verdicts.push(await freshIndependentVerdict(db, companyId, qa, completedAt, routing.producerAgentId));
    const latest = verdicts.find((value) => value !== null) ?? null;
    if (latest?.verdict === "pass") return { ...base, state: "resolved", reasonCode: null,
      evidence: [...ev, evidence("qa", latest.eventId, workflowRunId, routing.qaSiblings[0]?.stepRun.id ?? null, null, null)] };
    if (latest?.verdict === "request_changes") return { ...base, state: "blocked", reasonCode: "qa_request_changes_outstanding", evidence: ev };
    return { ...base, state: "needs_evidence", reasonCode: "current_qa_verdict_missing", evidence: ev,
      requiredAction: { kind: "submit_qa_verdict", targetId: routing.qaSiblings[0]?.issueId ?? stepRunId,
        reasonCode: "current_qa_verdict_missing" } };
  }
  if ((producer.status === "pending" || producer.status === "running") && producer.issueId) { // 재작업 진행 — live wake/heartbeat 로 executing 구분(전달은 됐는가)
    const [liveWake] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.issueId, producer.issueId),
      inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution", "coalesced"]))).limit(1);
    const [liveHeartbeat] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.issueId, producer.issueId),
      inArray(heartbeatRuns.status, ["queued", "running"]))).limit(1);
    if (liveWake || liveHeartbeat) return { ...base, state: "executing", reasonCode: null, evidence: ev };
  }
  return { ...base, state: producer.status === "running" ? "executing" : "delivery_pending", reasonCode: null, evidence: ev };
  })();
  if (!planPart) return artifactPart; // 순수 artifact 경로 — 계획부 없음
  if (planPart.state === "resolved") return artifactPart; // 계획부 완료 — artifact 부가 전체를 지배
  if (artifactPart.state === "resolved") return planPart; // [미병합 해소] artifact 부 완료만으로 전체 해제 아님 — 계획부가 지배
  if (artifactPart.reasonCode === "action_not_applied") return artifactPart; // 미적용은 재실행(재생) 경로가 소유한다
  return planPart.requiredAction && !artifactPart.requiredAction ? { ...artifactPart, requiredAction: planPart.requiredAction } : artifactPart;
}

/** [실행] artifact 부: 적용 가능한 back-edge 가 있으면 공식 verdict 반영 상태에서 native sync 가
 *  producer reset/재발사를 소유하게 한다(facade 는 predFacts 조작·loop 직접 호출 금지). 이미 시작된
 *  재작업은 다시 reset 되지 않는다(엔진은 terminal 만 리셋). cap 소진·failed run 은 정확한 결정 요청. */
export async function executeOwnerDelegateFix(context: OwnerExecutionContext, request: MissionOwnerExecuteRequest,
  actionId: string, validateIntent: (tx: Db) => Promise<boolean>): Promise<OwnerActionResult> {
  const action = request.action;
  if (action.operation !== "delegate_fix") throw new Error("delegate_fix_operation_required");
  const routing = await deriveRouting(context.db, context.companyId, action);
  if (!routing) throw new OwnerActionRefusalError(404, "target_not_found");
  const verdict = await loadOfficialVerdict(context.db, context.companyId, action.qaVerdictEventId);
  if (!verdict) throw new OwnerActionRefusalError(404, "qa_verdict_not_found");
  const effective = await effectiveFindings(context.db, context.companyId, verdict, routing.producerRun.completedAt);
  const hasArtifact = effective.some((finding) => finding.layer === "artifact");
  const hasSource = effective.some((finding) => finding.layer === "source_data");
  const blocked = (reasonCode: string, requiredAction: OwnerActionResult["requiredAction"]): OwnerActionResult => ({
    schemaVersion: 1, actionId, operation: "delegate_fix", state: "blocked", reasonCode,
    evidence: [evidence("heartbeat", actionId, action.producerTarget.workflowRunId, action.producerTarget.stepRunId, routing.producerRun.executionGeneration, null)], requiredAction });
  if (hasSource && action.collection) { // (a) source_data 계열: stage 6 재수집 — producer reset·cap 소모 없음. 혼재면 source 부가 시작 못할 때 정확한 보고로 멈춘다.
    const collector = action.collection.plan ? null : await findCollectorStepRun(context.db, context.companyId, action.producerTarget.workflowRunId, action.collection.sourceRefs);
    if (collector === "ambiguous") throw new OwnerActionRefusalError(422, "collector_target_ambiguous");
    if (!action.collection.plan && !collector) return blocked("collector_not_found", null);
    const recollect = await executeOwnerRecollect(context, { ...request,
      action: recollectActionFor(action, collector, routing) }, actionId, validateIntent);
    if (!hasArtifact || recollect.state === "blocked") return relabelDelegateFix(recollect);
  }
  if (hasArtifact) { // (b) artifact 계열: native back-edge 재작업 경로
    if (routing.runStatus === "failed") return blocked("run_failed_requires_resume", null); // stage 4 적격 재개 안내 — 자동 재개 없음
    if (routing.backEdges.length === 0) { // 적용 가능한 edge 없음 → stage 5 제한된 계획 unit(plan 필수는 preflight 보증)
      if (!action.plan) throw new OwnerActionRefusalError(422, "plan_required");
      return relabelDelegateFix(await executeOwnerPlanAction(context, action.plan, actionId));
    }
    if (routing.iteration >= routing.maxIterations + routing.capBoost)
      return blocked("rework_cap_exhausted", { kind: "submit_corrected_plan", targetId: action.producerTarget.stepRunId,
        reasonCode: "rework_cap_exhausted" }); // canonical lineage/iteration 공유 — 새 요청 이름으로 초기화 금지
    if (!(await validateIntent(context.db))) throw new OwnerActionRefusalError(409, "stale_intent"); // 실제 작업 전달 경계 재확인
    await recordAppliedEvent(context.db, context.companyId, { actionId, operation: "delegate_fix",
      missionId: request.missionId, workflowRunId: action.producerTarget.workflowRunId, stepRunId: action.producerTarget.stepRunId,
      authorityId: null, authorityVersion: routing.runAuthorityVersion,
      executionGeneration: routing.producerRun.executionGeneration, dispatchRequestId: routing.producerRun.lastDispatchRequestId });
    await syncWorkflowRunState(context.db, action.producerTarget.workflowRunId);
  }
  return await projectOwnerDelegateFixResult(context.db, context.companyId, request.missionId, actionId);
}

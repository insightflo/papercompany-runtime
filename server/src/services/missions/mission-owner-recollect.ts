// server/src/services/missions/mission-owner-recollect.ts
//
// [Stage 6] 오너 재수집(recollect) 실행.
//   - same_configuration: 선언된 sourceRefs 와 collector 의 실제 typed args/입출력 계약을
//     frozen/native unit(스텝 정의 + 실패 시도의 toolInvocation 스냅숏)과 정확 비교한 뒤
//     (preflight — intent 기록 전, 부작용 0) 해당 스텝의 exact native 재시도(stage 1/3 경로)로
//     실제 재실행한다. request_input(사람 입력)은 재수집 실행에 사용하지 않는다.
//   - changed_collection: 동일 목표의 제한된 계획 unit(add/clone 에만 collectionScope:oneShot 허용)을
//     stage 5 실제 계획 체인(executeOwnerPlanAction: 제출→독립 PLAN-QA→물화→실행)으로 연결한다.
//   자료원/도구/권한 부족은 정확한 대상의 request_access 로 보고한다. 파일 존재·"수집 완료" 댓글·
//   옛 QA 는 resolved 근거가 아니다(투영은 현재 실행의 구조 기록만 읽는다).
import { and, eq, inArray } from "drizzle-orm";
import {
  agentToolGrants, issues, toolDefinitions, workflowDefinitions, workflowRuns, workflowStepRuns,
  workflowTransitionEvents, type Db,
} from "@paperclipai/db";
import { missionRevisionDeltaSchema } from "@paperclipai/shared/validators/mission-revision";
import type { MissionOwnerAction, MissionOwnerExecuteRequest } from "@paperclipai/shared/validators/mission-owner-authority";
import { projectOwnerActionResult, stable, type OwnerActionResult } from "./mission-owner-execution-state.js";
import {
  dispatchOwnerExactRetry, OwnerActionRefusalError, projectIssueActionResult, type OwnerExecutionContext,
} from "./mission-owner-execute.js";
import { executeOwnerPlanAction, projectOwnerPlanActionResult } from "./mission-owner-plan-action.js";

export type OwnerRecollectAction = Extract<MissionOwnerAction, { operation: "recollect" }>;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** frozen unit 의 typed args 에서 문자열 잎값(수집 대상 인자 원문)을 정렬 수집한다. */
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
const unitToolNames = (step: Record<string, unknown>): string[] =>
  [...(Array.isArray(step.toolNames) ? step.toolNames : []), ...(Array.isArray(step.tools) ? step.tools : [])]
    .filter((name): name is string => typeof name === "string");

/** [frozen/native unit] run 의 동결 정의에서 collector step 정의와 스텝런 스냅숏을 함께 읽는다. */
async function loadFrozenCollectorUnit(db: Db, companyId: string, workflowRunId: string, stepRunId: string) {
  const [row] = await db.select({ stepRun: workflowStepRuns, workflowId: workflowRuns.workflowId })
    .from(workflowStepRuns).innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
    .where(and(eq(workflowStepRuns.id, stepRunId), eq(workflowRuns.id, workflowRunId),
      eq(workflowRuns.companyId, companyId))).limit(1);
  if (!row) return null;
  const [definition] = await db.select({ stepsJson: workflowDefinitions.stepsJson }).from(workflowDefinitions)
    .where(and(eq(workflowDefinitions.id, row.workflowId), eq(workflowDefinitions.companyId, companyId))).limit(1);
  const steps = Array.isArray(definition?.stepsJson) ? definition!.stepsJson : [];
  const step = steps.find((candidate) => record(candidate).id === row.stepRun.stepId);
  return step ? { step: record(step), stepRun: row.stepRun } : null;
}

/** [preflight] intent 기록 전 구조 검증(전부 읽기 전용 — 위반은 422/404 부작용 0 거부).
 *  same_configuration: sourceRefs·실패 시도의 typed args/도구가 frozen unit 과 정확히 같은지 비교한다.
 *  changed_collection: plan 필수 + oneShot/permanentChange 선언이 add/clone 단위에만 있는지, 그리고
 *  동일 company/mission 의 mission_main_executor_plan planning issue 가 실재하는지 확인한다. */
export async function preflightOwnerRecollect(context: OwnerExecutionContext,
  request: MissionOwnerExecuteRequest): Promise<void> {
  const action = request.action;
  if (action.operation !== "recollect") return;
  if (action.mode === "changed_collection") {
    if (!action.plan) throw new OwnerActionRefusalError(422, "plan_required");
    const parsed = missionRevisionDeltaSchema.safeParse(record(action.plan.decision).revisionDelta);
    if (parsed.success) for (const unit of parsed.data.units) {
      if (unit.collectionScope !== undefined && unit.operation !== "add" && unit.operation !== "clone")
        throw new OwnerActionRefusalError(422, "collection_scope_misplaced"); // 수집 범위 구분 선언은 add/clone 단위 전용이다
    }
    const [planning] = await context.db.select({ id: issues.id }).from(issues).where(and(
      eq(issues.id, action.plan.planningIssueId), eq(issues.companyId, context.companyId),
      eq(issues.missionId, request.missionId), eq(issues.originKind, "mission_main_executor_plan"))).limit(1);
    if (!planning) throw new OwnerActionRefusalError(404, "planning_issue_not_found");
    return;
  }
  const unit = await loadFrozenCollectorUnit(context.db, context.companyId,
    action.collectorTarget.workflowRunId, action.collectorTarget.stepRunId);
  if (!unit) throw new OwnerActionRefusalError(404, "target_not_found");
  // 선언된 sourceRefs 는 frozen typed args 의 수집 대상 인자(문자열 잎값 전체)와 정확히 같아야 한다.
  if (!sameSet(action.sourceRefs, stringLeaves(unit.step.toolArgs)))
    throw new OwnerActionRefusalError(422, "collector_configuration_changed");
  const invocation = record(record(unit.stepRun.metadata).toolInvocation);
  if (Object.keys(invocation).length > 0) { // 실패 시도의 실제 typed args/도구 스냅숏과의 드리프트 비교
    if (typeof invocation.toolName === "string" && !unitToolNames(unit.step).includes(invocation.toolName))
      throw new OwnerActionRefusalError(422, "collector_configuration_changed");
    if (stable(invocation.args ?? null) !== stable(unit.step.toolArgs ?? null))
      throw new OwnerActionRefusalError(422, "collector_configuration_changed");
  }
}

/** [same_configuration] collector 도구·실행 agent 권한 확인 — 부족하면 정확한 대상의 request_access
 *  (실행 부작용 0). 도구 선언이 없는 수집 스텝은 stage 1/3 native 경로의 자체 검증이 소유한다. */
async function collectorAccessGap(context: OwnerExecutionContext, action: OwnerRecollectAction,
  actionId: string): Promise<OwnerActionResult | null> {
  const unit = await loadFrozenCollectorUnit(context.db, context.companyId,
    action.collectorTarget.workflowRunId, action.collectorTarget.stepRunId);
  const toolNames = unit ? unitToolNames(unit.step) : [];
  if (toolNames.length === 0) return null;
  const tools = await context.db.select().from(toolDefinitions).where(and(
    eq(toolDefinitions.companyId, context.companyId), inArray(toolDefinitions.name, toolNames)));
  const unavailable = toolNames.find((name) => !tools.some((tool) => tool.name === name && tool.enabled));
  const blocked = (reasonCode: string, targetId: string): OwnerActionResult => ({
    schemaVersion: 1, actionId, operation: "recollect", state: "blocked", reasonCode,
    evidence: [{ kind: "heartbeat", recordId: actionId, workflowRunId: action.collectorTarget.workflowRunId,
      stepRunId: action.collectorTarget.stepRunId, executionGeneration: null, requestId: null }],
    requiredAction: { kind: "request_access", targetId, reasonCode } });
  if (unavailable) return blocked("collector_tool_unavailable", unavailable);
  const agentId = typeof unit?.step.agentId === "string" ? unit.step.agentId : null;
  if (agentId) {
    const grants = await context.db.select({ toolId: agentToolGrants.toolId }).from(agentToolGrants)
      .where(and(eq(agentToolGrants.companyId, context.companyId), eq(agentToolGrants.agentId, agentId),
        inArray(agentToolGrants.toolId, tools.map((tool) => tool.id))));
    const missingGrant = tools.find((tool) => !grants.some((grant) => grant.toolId === tool.id));
    if (missingGrant) return blocked("collector_grant_missing", agentId);
  }
  return null;
}

/** [투영] intent 원문의 mode/collectorTarget 에 따라 stage 5 계획 투영 또는 stage 1/3 결과 투영으로
 *  연결한다. 저장된 투영은 현재 실행의 구조 기록만 읽는다 — 옛 자료·댓글·옛 QA 는 근거가 아니다. */
export async function projectOwnerRecollectResult(db: Db, companyId: string, missionId: string,
  actionId: string): Promise<OwnerActionResult> {
  const [intent] = await db.select({ payload: workflowTransitionEvents.payload }).from(workflowTransitionEvents)
    .where(and(eq(workflowTransitionEvents.id, actionId), eq(workflowTransitionEvents.companyId, companyId),
      eq(workflowTransitionEvents.eventType, "owner_execute_intent_v1"),
      eq(workflowTransitionEvents.layer, "mission_owner_authority"))).limit(1);
  const action = record(record(intent?.payload).action);
  if (action.mode === "changed_collection") {
    const projected = await projectOwnerPlanActionResult(db, companyId, missionId, actionId);
    return projected.operation === "recollect" ? projected : { ...projected, operation: "recollect" };
  }
  const target = record(action.collectorTarget);
  if (target.kind === "issue_step" && typeof target.issueId === "string") {
    const projected = await projectIssueActionResult(db, companyId, missionId, actionId, target.issueId, "recollect");
    return projected.operation === "recollect" ? projected : { ...projected, operation: "recollect" };
  }
  const projected = await projectOwnerActionResult(db, companyId, missionId, actionId, "recollect");
  return projected.operation === "recollect" ? projected : { ...projected, operation: "recollect" };
}

export async function executeOwnerRecollect(context: OwnerExecutionContext, request: MissionOwnerExecuteRequest,
  actionId: string, validateIntent: (tx: Db) => Promise<boolean>): Promise<OwnerActionResult> {
  const action = request.action;
  if (action.operation !== "recollect") throw new Error("recollect_operation_required");
  if (action.mode === "changed_collection") { // 계획의 스니펫: stage 5 실제 계획 체인으로 연결한다
    if (!action.plan) throw new OwnerActionRefusalError(422, "plan_required"); // preflight 와 같은 계약 재확인
    const projected = await executeOwnerPlanAction(context, action.plan, actionId);
    return projected.operation === "recollect" ? projected : { ...projected, operation: "recollect" };
  }
  const access = await collectorAccessGap(context, action, actionId);
  if (access) return access; // 자료원/도구/권한 부족 — 실행 부작용 0, 정확한 대상의 request_access
  return dispatchOwnerExactRetry(context, request, action.collectorTarget, actionId, validateIntent);
}

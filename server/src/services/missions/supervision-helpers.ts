// server/src/services/missions/supervision-helpers.ts
//
// [파일 목적] mission owner supervision(감독/회복) 전용 순수 helper. db/deps 무, 파라미터 기반.
//   missions.ts 클로저 분해(P1)로 이동. runMainExecutorSupervision이 호출.
// [외부 연결] consumer: missions.ts(supervision). deps: shared-types/mission-execution-sources/mission-supervision-context/utils.
// [수정시 주의] 여기엔 db/deps/상태 접근 금지. 순수 함수만.
import { asStringArray } from "./utils.js";
import { isUuidLike } from "@paperclipai/shared";
import type { IssueRow, JsonRecord } from "./shared-types.js";
import type { MissionExecutionUnit } from "./mission-execution-sources.js";
import type { MissionSupervisionPlanArtifact, MissionSupervisionWorkflowStepRow } from "./mission-supervision-context.js";
import type { ConditionalEdge } from "../workflow/control-flow/types.js";

export function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : {};
}

export function asRecordArray(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonRecord => typeof item === "object" && item !== null && !Array.isArray(item))
    : [];
}

export function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function normalizedPlanStatus(value: unknown): string {
  return trimmedString(value)?.toLowerCase() ?? "";
}

export function executionUnitKeyFromSourceRef(sourceRef: unknown): string | null {
  const ref = asRecord(sourceRef);
  const type = trimmedString(ref.type);
  const id = trimmedString(ref.id);
  return type && id ? `${type}:${id}` : null;
}

export function executionUnitKey(unit: Pick<MissionExecutionUnit, "sourceRef">): string {
  return `${unit.sourceRef.type}:${unit.sourceRef.id}`;
}

export function textContainsAny(value: unknown, needles: string[]): boolean {
  const text = JSON.stringify(value ?? "").toLowerCase();
  return needles.some((needle) => text.includes(needle));
}

export function unitRequiresGovernedAction(unit: JsonRecord): boolean {
  return textContainsAny(unit, ["external", "cost", "legal", "destructive", "delete", "spend", "payment", "production"]);
}

export function isApprovalRuleMode(mode: unknown): boolean {
  const normalized = normalizedPlanStatus(mode);
  return normalized === "approval_gate" || normalized === "hard_gate";
}

export function hasDiagnosisSignal(...bodies: string[]): boolean {
  const body = bodies.join("\n").toLowerCase();
  return body.includes("diagnos")
    || body.includes("root cause")
    || body.includes("replan")
    || body.includes("re-plan")
    || body.includes("recover")
    || body.includes("escalat")
    || body.includes("impossible")
    || body.includes("failure:")
    || body.includes("failed_unit_without_diagnosis");
}

export function jsonArrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export function sourceRefMatchesIssue(sourceRef: unknown, issue: Pick<IssueRow, "id">): boolean {
  const ref = asRecord(sourceRef);
  const type = trimmedString(ref.type);
  const id = trimmedString(ref.id);
  const issueId = trimmedString(ref.issueId);
  return issueId === issue.id || (type === "mission_issue" && id === issue.id);
}

export function materializedRefMatchesIssue(materializedRef: unknown, issue: Pick<IssueRow, "id">): boolean {
  const ref = asRecord(materializedRef);
  return trimmedString(ref.type) === "mission_issue" && trimmedString(ref.id) === issue.id;
}

export function activePlanPaqoStepMatchesIssue(
  activePlan: MissionSupervisionPlanArtifact,
  stepRowsForIssue: MissionSupervisionWorkflowStepRow[],
): boolean {
  const refs = asRecord(activePlan.refs);
  const paqoWorkflow = asRecord(refs.paqoWorkflow);
  const workflowRunId = trimmedString(paqoWorkflow.workflowRunId);
  const stepIds = new Set(asStringArray(paqoWorkflow.stepIds));
  if (!workflowRunId || stepIds.size === 0) return false;
  return stepRowsForIssue.some((row) => row.run.id === workflowRunId && stepIds.has(row.stepRun.stepId));
}

export function activePlanRecoveryGateReason(
  activePlan: MissionSupervisionPlanArtifact | null,
  issue: IssueRow,
  stepRowsForIssue: MissionSupervisionWorkflowStepRow[] = [],
): string | null {
  if (!activePlan) return null;
  if (issue.originKind === "mission_main_executor_plan" || issue.originKind === "mission_main_executor_oversight" || issue.originKind === "mission_main_executor_unblock") {
    return null;
  }
  if (activePlanPaqoStepMatchesIssue(activePlan, stepRowsForIssue)) return null;

  const stepCount = jsonArrayLength(activePlan.steps);
  if (stepCount === 0) {
    return `active plan revision=${activePlan.revision} has no high-level step skeleton; mission owner must finish the plan before source/QA recovery can execute`;
  }

  const refs = asRecord(activePlan.refs);
  const selectedExecutionUnits = asRecordArray(refs.selectedExecutionUnits);
  if (selectedExecutionUnits.length > 0) {
    const selectedUnit = selectedExecutionUnits.find((unit) => (
      sourceRefMatchesIssue(unit.sourceRef, issue) || materializedRefMatchesIssue(unit.materializedRef, issue)
    ));
    if (!selectedUnit) {
      if (activePlanPaqoStepMatchesIssue(activePlan, stepRowsForIssue)) return null;
      return `active plan revision=${activePlan.revision} does not select this issue as an execution unit; blocked status alone is not enough to launch recovery`;
    }
    const selectionState = normalizedPlanStatus(selectedUnit.selectionState);
    if (selectionState !== "selected") {
      return `active plan revision=${activePlan.revision} marks this issue selectionState=${selectionState || "unknown"}; only selected units can be unblocked or retried`;
    }
    const dependencyTreatment = normalizedPlanStatus(selectedUnit.dependencyTreatment);
    if (dependencyTreatment === "blocked") {
      return `active plan revision=${activePlan.revision} says this issue's prerequisites are blocked; wait for the upstream artifact/decision before running QA or recovery`;
    }
    const executionState = normalizedPlanStatus(selectedUnit.executionState);
    if (executionState === "not_materialized" || executionState === "completed" || executionState === "cancelled" || executionState === "canceled") {
      return `active plan revision=${activePlan.revision} marks this issue executionState=${executionState}; recovery is not runnable at this point`;
    }
    return null;
  }

  return null;
}

export function hasArtifactMissingSignal(...bodies: string[]): boolean {
  const body = bodies.join("\n").toLowerCase();
  return body.includes("required workflow artifact missing")
    || body.includes("required source artifact is missing")
    || body.includes("artifact missing")
    || body.includes("블로그 파일 누락")
    || body.includes("markdown 파일로 저장")
    || body.includes("파일로만 저장");
}

export function hasRecoverableArtifactComment(...bodies: string[]): boolean {
  const body = bodies.join("\n");
  const lower = body.toLowerCase();
  return hasArtifactMissingSignal(body)
    && (lower.includes(".md") || lower.includes("markdown"))
    && /^#{1,3}\s+\S+/m.test(body);
}

export function parseToolStepRecoveryMarker(description: string | null): { runId: string; stepId: string } | null {
  const match = description?.match(/<!--\s*tool-step-recovery:([0-9a-f-]{36}):([\s\S]*?)\s*-->/i);
  if (!match) return null;
  const runId = match[1]?.trim();
  const stepId = match[2]?.trim();
  if (!runId || !stepId || !isUuidLike(runId)) return null;
  return { runId, stepId };
}

export function toolStepRecoveryMarkerKey(marker: { runId: string; stepId: string }): string {
  return `${marker.runId}:${marker.stepId}`;
}

export function findCanonicalToolStepRecoveryIssue(input: {
  marker: { runId: string; stepId: string };
  missionIssues: IssueRow[];
}): IssueRow | null {
  const markerKey = toolStepRecoveryMarkerKey(input.marker);
  return input.missionIssues
    .filter((candidate) =>
      candidate.originKind === "mission_main_executor_unblock"
      && !candidate.hiddenAt
      && parseToolStepRecoveryMarker(candidate.description)
      && toolStepRecoveryMarkerKey(parseToolStepRecoveryMarker(candidate.description)!) === markerKey
    )
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))[0] ?? null;
}

export function buildNativeToolStepRetryAppliedMarker(input: {
  ownerActionIssueId: string;
  workflowRunId: string;
  stepId: string;
}): string {
  return `<!-- native-tool-step-retry-applied:${JSON.stringify(input)} -->`;
}

export function hasNativeToolStepRetryAppliedMarker(comments: string[], input: {
  ownerActionIssueId: string;
  workflowRunId: string;
  stepId: string;
}): boolean {
  return comments.some((comment) => comment.includes(buildNativeToolStepRetryAppliedMarker(input)));
}

/**
 * [목적] QA-gate 회복의 rework 타겟(수정 지시를 받을 upstream 생산자) 해석 helper.
 *   QA가 산출물을 반렸으면 고쳐야 할 대상은 산출물을 만든 생산자(synthesis 등)이지 QA 본인이 아니다.
 *   B(사장 지목) → A(DAG 역참조) 순으로 생산자를 찾는다.
 */
export interface DagStepLike {
  id: string;
  dependencies?: string[];
  dependsOn?: string[];
  name?: string;
  title?: string;
  type?: string;
}

/** step이 QA/검수 계열인지(step id 접두 qa-/validate-/verify-/audit- 또는 이름에 qa/validate/verify/review/check/audit 계열 어근). */
export function isQaLikeStep(step: DagStepLike): boolean {
  const id = step.id.toLowerCase();
  if (id.startsWith("qa") || id.startsWith("validate") || id.startsWith("verify") || id.startsWith("audit")) return true;
  const name = `${step.name ?? ""} ${step.title ?? ""} ${step.type ?? ""}`.toLowerCase();
  return /\b(qa|audit\w*|validat\w*|verif\w*|review\w*|check\w*)/i.test(name);
}

/**
 * [목적] A(DAG 역참조): QA step의 dependency 중 non-QA 생산자를 찾는다.
 * [입력] qaStepId(반려한 QA step), steps(워크플로우 정의 전체 step).
 * [출력] 생산자 step id. QA 의존성 중 (a)QA 게이트가 아니고 (b)의존성이 가장 많아
 *   위상적으로 가장 아래(=산출물을 최종 합성한 step, 예: synthesis)인 것을 생산자로 삼는다.
 * [주의] 생산자 후보가 없거나 모두 QA면 null.
 */
export function resolveProducerStepIdFromDag(qaStepId: string | null, steps: DagStepLike[]): string | null {
  if (!qaStepId) return null;
  const byId = new Map(steps.map((step) => [step.id, step]));
  const qaStep = byId.get(qaStepId);
  if (!qaStep) return null;
  const deps = qaStep.dependencies ?? qaStep.dependsOn ?? [];
  const producers = deps
    .map((depId) => byId.get(depId))
    .filter((step): step is DagStepLike => Boolean(step))
    .filter((step) => !isQaLikeStep(step));
  if (producers.length === 0) return null;
  producers.sort(
    (a, b) =>
      (b.dependencies?.length ?? b.dependsOn?.length ?? 0) -
      (a.dependencies?.length ?? a.dependsOn?.length ?? 0),
  );
  return producers[0]!.id;
}

/**
 * [파일 목적에서 연장] control-flow back-edge 를 저작(합성)할 수 있는 step 의 최소 구조.
 *   DagStepLike(resolveProducerStepIdFromDag 입력) 에 conditionalDependencies 를 더한 것.
 *   dag-engine 의 WorkflowStep 이 구조적 호환(제네릭 T 로 보존).
 */
export interface BackEdgeCapableStep extends DagStepLike {
  conditionalDependencies?: ConditionalEdge[];
}

/** PAQO 미션 QA rework back-edge 의 기본 maxIterations(가즈아 무한 loop 방지 hard cap). */
export const QA_REWORK_DEFAULT_MAX_ITERATIONS = 2;

/**
 * [목적] PLAN/build 시 미션 QA step 이 산출물 생산자(producer) 로 보내는 bounded rework back-edge 를
 *   자동 합성한다(P5). QA 가 request_changes 할 때 P4 loop-driver 가 producer 를 rework 하게 한다.
 *   legacy dependencies[] (forward) 는 건드리지 않고 producer 의 conditionalDependencies 에 back-edge 만 추가.
 * [입력] steps(전체 step; T 는 WorkflowStep 등 BackEdgeCapableStep 의 상위 타입), qaStepId(미션 최종 QA step id),
 *   maxIterations(기본 QA_REWORK_DEFAULT_MAX_ITERATIONS=2).
 * [출력] producer 의 conditionalDependencies 에 back-edge 가 추가된 새 steps 배열(불변 rebuild). producer 가
 *   없거나(null), 이미 동일 back-edge 가 있으면 입력을 그대로 반환.
 * [주의]
 *   - **생산자 식별은 resolveProducerStepIdFromDag 에 위임**(PLAN 설계). 이 함수는 rework 타겟을 다시
 *     정의하지 않는다. 선형 chain(a→b→c)에서 의존성 수 동점이면 resolveProducerStepIdFromDag 가 QA 의
 *     dependencies 배열에서 가장 앞의 동점 step 을 고른다(=중간 step 일 수 있음). fan-in/synthesis 구조
 *     (PAQO 일반적)에선 정확히 synthesis step 이 선택된다. 선형 chain 한계는 별도 follow-up으로.
 *   - **합성 대상은 호출자가 지정한 단일 qaStepId 만**(모든 QA-like step 스캔 ❌). 중간 단계 QA 게이트의
 *     회복은 runtime supervision 이 담당하므로 여기서 다루지 않는다 — 다중 loop interleaving 회피.
 *   - **중복 제거**: {stepId:qaStepId, when:'qa_request_changes', isBackEdge:true} 가 이미 있으면(maxIterations
 *     무관) skip — 저작자가 직접 넣은 back-edge 를 보존한다.
 *   - **무한 loop 금지**: 합성 edge 는 항상 maxIterations>=1. normalize/cycle-validator 가 없는 back-edge 를
 *     drop/거부하므로, 이 함수가 내는 edge 는 반드시 maxIterations 를 동반해야 한다.
 */
export function synthesizeQaReworkBackEdge<T extends BackEdgeCapableStep>(
  steps: T[],
  qaStepId: string,
  maxIterations: number = QA_REWORK_DEFAULT_MAX_ITERATIONS,
): T[] {
  if (!qaStepId || steps.length === 0) return steps;
  const effectiveMaxIterations = typeof maxIterations === "number" && maxIterations >= 1 ? Math.floor(maxIterations) : QA_REWORK_DEFAULT_MAX_ITERATIONS;
  const producerId = resolveProducerStepIdFromDag(qaStepId, steps);
  if (!producerId) return steps;
  const producer = steps.find((step) => step.id === producerId);
  if (!producer) return steps;
  const existing = producer.conditionalDependencies ?? [];
  const alreadyHasBackEdge = existing.some(
    (edge) => edge.stepId === qaStepId && edge.when === "qa_request_changes" && edge.isBackEdge === true,
  );
  if (alreadyHasBackEdge) return steps;
  const backEdge: ConditionalEdge = {
    stepId: qaStepId,
    when: "qa_request_changes",
    isBackEdge: true,
    maxIterations: effectiveMaxIterations,
  };
  return steps.map((step) => (step.id === producerId ? ({ ...step, conditionalDependencies: [...existing, backEdge] } as T) : step));
}

/**
 * [목적] B(사장 지목) 보조: 결정의 Next action 에서 rework 타겟 identifier를 파싱.
 *   사장이 "Rework target" 필드를 안 적었어도 "Next action: revise RES-1329 ..." 처럼 적으면
 *   그 생산자 identifier를 추출한다. identifier 형태: RES-1234, CMPA-1234 등(영문 접두-숫자).
 */
const REWORK_TARGET_IN_NEXT_ACTION =
  /\b(?:revise|redo|rework|update|fix|correct|re-open|reopen)\s+(?:the\s+|issue\s+)?([A-Z][A-Z0-9_]*-\d+)\b/i;
export function parseReworkTargetRefFromNextAction(nextAction: string | undefined | null): string | null {
  if (!nextAction) return null;
  const match = nextAction.match(REWORK_TARGET_IN_NEXT_ACTION);
  return match ? match[1]! : null;
}

// server/src/services/missions/revision-reuse-plan.ts
//
// [파일 목적] 수정 재사용(원문 복사) 계약의 순수 파싱/검증/투영 조립(변경지도 §3–§5).
//   실행 권한은 구조화된 revisionDelta 의 operation:"reuse" 마커뿐이다 — 문구·주석 파싱에서
//   권위를 만들지 않는다(규칙 8). 재사용 A 항목은 신원만(id/sourceStepId, id===sourceStepId)
//   선언할 수 있고, 실제 구성은 서버가 원본 실행 스냅샷에서 복사한다. 이 모듈은 DB 를 읽지
//   않는다(역사 로딩/자격/충돌은 revision-reuse-materialization.ts).
import {
  missionRevisionDeltaSchema,
  missionRevisionIdentityOnlyUnitSchema,
} from "@paperclipai/shared/validators/mission-revision";
import { classifyWorkflowStepRole } from "../workflow-step-role.js";
import { resolveEdges } from "../workflow/control-flow/edge-condition.js";
import type { PersistedWorkflowStep } from "../workflow/execution-steps.js";
import type { WorkflowStep } from "../workflow/dag-engine.js";

export type RevisionReuseDiagnostic = { code: string; message: string; severity: "invalid" };

const reuseInvalid = (message: string): RevisionReuseDiagnostic =>
  ({ code: "mission_revision_reuse_invalid", message, severity: "invalid" });

export const REUSE_PLAN_REFS_SCHEMA_VERSION = "mission-revision-reuse.v1";

/** 활성 계획 refs 에 보존되는 서버 소유 재사용 지도(기계 판독 전용; 클라이언트 플래그 아님). */
export type RevisionReusePlanRecord = {
  schemaVersion: typeof REUSE_PLAN_REFS_SCHEMA_VERSION;
  sourceWorkflowRunId: string;
  roots: string[];
  closureUnitIds: string[];
};

export function parseRevisionReusePlanRecord(refs: unknown): RevisionReusePlanRecord | null {
  if (!refs || typeof refs !== "object" || Array.isArray(refs)) return null;
  const stored = (refs as Record<string, unknown>).revisionReusePlan;
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  const record = stored as Record<string, unknown>;
  const sourceWorkflowRunId = typeof record.sourceWorkflowRunId === "string" ? record.sourceWorkflowRunId : null;
  const roots = Array.isArray(record.roots) ? record.roots.filter((v): v is string => typeof v === "string" && v !== "") : null;
  const closure = Array.isArray(record.closureUnitIds)
    ? record.closureUnitIds.filter((v): v is string => typeof v === "string" && v !== "") : null;
  if (record.schemaVersion !== REUSE_PLAN_REFS_SCHEMA_VERSION || !sourceWorkflowRunId || !roots?.length || !closure?.length) return null;
  if (roots.some(id => !closure.includes(id))) return null;
  return { schemaVersion: REUSE_PLAN_REFS_SCHEMA_VERSION, sourceWorkflowRunId, roots, closureUnitIds: closure };
}

/** [A 신원 전용] 에이전트가 저작한 재사용 A 항목이 신원 외 다른 필드를 싣지 않았는지 검증한다. */
export function collectIdentityOnlyViolations(
  authoredUnits: readonly Record<string, unknown>[],
  reuseUnitIds: ReadonlySet<string>,
): RevisionReuseDiagnostic[] {
  const diagnostics: RevisionReuseDiagnostic[] = [];
  for (const unit of authoredUnits) {
    const unitId = typeof unit.id === "string" ? unit.id : null;
    if (!unitId || !reuseUnitIds.has(unitId)) continue;
    const parsed = missionRevisionIdentityOnlyUnitSchema.safeParse(unit);
    if (!parsed.success) {
      const unknown = Object.keys(unit).filter(key => key !== "id" && key !== "sourceStepId");
      diagnostics.push(reuseInvalid(
        unknown.length > 0
          ? `재사용 단위 ${unitId} 는 신원(id/sourceStepId)만 선언할 수 있습니다 — 저작 구성 필드(${unknown.join(", ")}) 가 함께 선언되었습니다. 변경이 필요하면 modify 로 제출하세요.`
          : `재사용 단위 ${unitId} 의 신원 계약이 올바르지 않습니다(id === sourceStepId).`));
    }
  }
  return diagnostics;
}

/**
 * [변경 B 보호] 서버가 원문 복사로 포함하는 모든 대상(루트+암묵적 조상)을 원문 제출과 대조한다.
 *   클로저의 일부인데 저작된 계획 항목이나 modify/rerun/add 등의 변경안 항목이 함께 있으면
 *   충돌이다 — 조용히 투영으로 대체하면 변경한 B 가 원본 재사용으로 바뀐다(같은 원본이라 동일성
 *   검사도 못 잡는다). 명시 루트는 신원 전용 검사가 이미 적용되므로 제외한다.
 */
export function collectClosureConflicts(input: {
  closureUnitIds: readonly string[];
  reuseRootUnitIds: ReadonlySet<string>;
  authoredUnits: readonly Record<string, unknown>[];
  deltaUnits: ReadonlyArray<{ unitId: string; operation: string }>;
}): RevisionReuseDiagnostic[] {
  const diagnostics: RevisionReuseDiagnostic[] = [];
  for (const id of input.closureUnitIds) {
    if (input.reuseRootUnitIds.has(id)) continue;
    const authored = input.authoredUnits.some(unit => unit.id === id);
    const deltaEntry = input.deltaUnits.find(unit => unit.unitId === id);
    if (!authored && !deltaEntry) continue;
    const claims = [authored ? "저작된 계획 항목" : null, deltaEntry ? `변경안 ${deltaEntry.operation} 항목` : null]
      .filter(Boolean).join(" 과(와) ");
    diagnostics.push({
      code: "mission_revision_reuse_dependency_invalid",
      message: `단계 ${id} 은(는) 재사용 클로저의 일부로 서버가 원본 실행에서 그대로 복사합니다 — `
        + `${claims}이(가) 이 단계를 다르게 실행하려 합니다. 충돌 항목을 제거하거나 해당 단계를 재사용(reuse) 로 표시하세요.`,
      severity: "invalid",
    });
  }
  return diagnostics;
}

/** 구조화 decision.steps 가 A 배선을 덮어쓰지 않는지 확인한다(자유 텍스트는 검사 대상이 아니다). */
export function collectStepOverrideViolations(
  decisionSteps: unknown,
  closureUnitIds: ReadonlySet<string>,
): RevisionReuseDiagnostic[] {
  if (!Array.isArray(decisionSteps)) return [];
  const diagnostics: RevisionReuseDiagnostic[] = [];
  for (const [index, entry] of decisionSteps.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const unitId = (entry as Record<string, unknown>).unitId ?? (entry as Record<string, unknown>).id;
    if (typeof unitId === "string" && closureUnitIds.has(unitId)) {
      diagnostics.push(reuseInvalid(
        `decision.steps[${index}] 이(가) 재사용 단위 ${unitId} 의 배선을 덮어쓰려 합니다 — A 는 원본 실행 구성만 따릅니다.`));
    }
  }
  return diagnostics;
}

/**
 * 원본 스냅샷 순서를 보존한 의존 클로저(비-back-edge 정방향 의존만 따른다).
 * 공유 조상은 한 번만, 정방향 순환은 dependency_invalid 로 거절한다.
 */
export function resolveReuseClosure(
  sourceSteps: readonly WorkflowStep[],
  roots: readonly string[],
): { ok: true; closure: string[] } | { ok: false; diagnostics: RevisionReuseDiagnostic[] } {
  const byId = new Map(sourceSteps.map(step => [step.id, step]));
  const snapshotOrder = new Map(sourceSteps.map((step, index) => [step.id, index]));
  const closureSet = new Set<string>();
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, path: string[]): string | null => {
    const marked = state.get(id);
    if (marked === "done") return null;
    if (marked === "visiting") return id;
    const step = byId.get(id);
    if (!step) return null;
    state.set(id, "visiting");
    for (const dependency of resolveEdges(step)) {
      if (dependency.isBackEdge) continue;
      const cycle = visit(dependency.stepId, [...path, dependency.stepId]);
      if (cycle) return cycle;
    }
    state.set(id, "done");
    closureSet.add(id);
    return null;
  };
  for (const root of roots) {
    if (!byId.has(root)) {
      return { ok: false, diagnostics: [reuseInvalid(`재사용 루트 ${root} 이(가) 원본 실행 스냅샷에 없습니다.`)] };
    }
    const cycle = visit(root, [root]);
    if (cycle) {
      return { ok: false, diagnostics: [{
        code: "mission_revision_reuse_dependency_invalid",
        message: `재사용 클로저에 정방향 순환이 있습니다(${cycle}).`, severity: "invalid",
      }] };
    }
  }
  // 원본 스냅샷 순서를 그대로 보존한다(공유 조상 중복 제거 포함).
  const closure = [...closureSet].sort((left, right) => (snapshotOrder.get(left) ?? 0) - (snapshotOrder.get(right) ?? 0));
  return { ok: true, closure };
}

/** 원본 스텝을 서버 소유 계획 투영으로 만든다(검토/배치 지원용 — 복사 입력은 copiedSteps 다). */
export function projectReuseStepToUnit(step: WorkflowStep): Record<string, unknown> {
  const persisted = step as PersistedWorkflowStep;
  const forwardDependencies = resolveEdges(step).filter(edge => !edge.isBackEdge).map(edge => edge.stepId);
  const unit: Record<string, unknown> = {
    id: step.id,
    sourceStepId: step.id,
    title: step.name,
    selectionState: "selected",
    // 활성 계획 refs 보존 계약(asSelectedExecutionUnits)이 채워진 reason 을 요구한다 — 서버 소유 표시 문구다(실행 권한 아님).
    reason: `Verbatim reuse copied by server from source run step ${step.id}`,
    sourceRef: { type: "mission_plan_unit", id: step.id },
    dependencies: forwardDependencies,
  };
  if (typeof step.agentId === "string" && step.agentId.trim() !== "") unit.assigneeAgentId = step.agentId;
  if (typeof step.type === "string") unit.type = step.type;
  if (Array.isArray(step.toolNames) && step.toolNames.length > 0) unit.toolNames = [...step.toolNames];
  if (persisted.toolArgs !== undefined) unit.toolArgs = persisted.toolArgs;
  if (persisted.workProductSelectors !== undefined) unit.workProductSelectors = persisted.workProductSelectors;
  if (step.knowledgeBaseIds !== undefined) unit.knowledgeBaseIds = step.knowledgeBaseIds;
  if (step.contract !== undefined) unit.contract = step.contract;
  return unit;
}

/**
 * 예약된 과거 QA ID 배정: 복사 A 의 기존 back-edge 참조가 가리키는 과거 QA ID 중
 * B 단위가 구조적 sourceStepId 로 명시적으로 이어받은 것은 그 B 에, 남은 1개는 미션
 * 최종 QA 가 이어받는다(과거 QA 구성·판정·산출 복사는 없다 — QA 는 신규 실행).
 */
export function assignReservedQaStepIds(input: {
  reservedQaStepIds: readonly string[];
  authoredUnits: readonly Record<string, unknown>[];
}): { ok: true; qaStepIdByUnitId: Map<string, string>; finalQaStepId: string | null } | { ok: false; diagnostics: RevisionReuseDiagnostic[] } {
  const reserved = new Set(input.reservedQaStepIds);
  const qaStepIdByUnitId = new Map<string, string>();
  for (const unit of input.authoredUnits) {
    const unitId = typeof unit.id === "string" ? unit.id : null;
    const sourceStepId = typeof unit.sourceStepId === "string" ? unit.sourceStepId : null;
    if (!unitId || !sourceStepId || !reserved.has(sourceStepId)) continue;
    if (qaStepIdByUnitId.has(sourceStepId)) {
      return { ok: false, diagnostics: [{
        code: "mission_revision_reuse_id_collision",
        message: `과거 QA 단계 ${sourceStepId} 를 여러 B 단위가 동시에 이어받으려 합니다(${[...qaStepIdByUnitId.values()]}).`,
        severity: "invalid",
      }] };
    }
    if (classifyWorkflowStepRole(unit) !== "qa") {
      return { ok: false, diagnostics: [{
        code: "mission_revision_reuse_dependency_invalid",
        message: `과거 QA 단계 ${sourceStepId} 를 이어받는 단위 ${unitId} 는 QA 단위여야 합니다(QA 가 아닌 단위는 과거 QA ID 를 쓸 수 없습니다).`,
        severity: "invalid",
      }] };
    }
    qaStepIdByUnitId.set(unitId, sourceStepId);
  }
  const consumed = new Set(qaStepIdByUnitId.values());
  const remaining = [...reserved].filter(id => !consumed.has(id));
  if (remaining.length > 1) {
    return { ok: false, diagnostics: [{
      code: "mission_revision_reuse_dependency_invalid",
      message: `A 의 back-edge 가 참조하는 과거 QA ID 가 여러 개(${remaining.join(", ")}) 남았습니다 — 이어받을 QA 단위를 sourceStepId 로 명시하거나 참조를 정리하세요.`,
      severity: "invalid",
    }] };
  }
  return { ok: true, qaStepIdByUnitId, finalQaStepId: remaining[0] ?? null };
}

/** 원문 delta 에 암묵적 조상의 재사용 항목을 보태 표준 변경안을 만든다(원본 delta 는 불변). */
export function buildCanonicalRevisionDelta(
  rawDelta: Record<string, unknown>,
  closureUnitIds: readonly string[],
): Record<string, unknown> {
  const parsed = missionRevisionDeltaSchema.safeParse(rawDelta);
  if (!parsed.success) return rawDelta;
  const existing = new Set(parsed.data.units.map(unit => unit.unitId));
  const added = closureUnitIds
    .filter(id => !existing.has(id))
    .map(id => ({ unitId: id, operation: "reuse" as const, sourceStepId: id }));
  return { ...rawDelta, units: [...parsed.data.units, ...added] };
}

export { missionRevisionDeltaSchema };

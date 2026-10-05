// server/src/services/missions/revision-plan-collection-scope.ts
//
// [파일 목적] 수정 변경안(mission-revision-delta.v1) 의 수집 대상 추가 단계 구분 계약과 별도 범위
//   조각(변경지도 R2/R5 — 슬라이스 Q5). (1) 계약 검사: collectionScope 는 추가(add)/복제(clone) 단계에만
//   선언할 수 있고 선언 단계는 수집 대상 인자(toolArgs)를 명시해야 한다 — 기준 템플릿 수집기 인자(정기
//   수집 상태 토큰 포함)를 조용히 물려받아 정기 호출을 그대로 반복하는 것을 막는다(revision-plan-delta
//   호출부). (2) 별도 범위: collectionScope:"permanentChange" 는 정기 수집 정의의 영구 변경 '요구'로,
//   이 수정 실행의 권한 밖이다(변경지도 §1 제외 항목). 해당 단계를 안전하게 읽어 배치 검사에서 제외하고,
//   구조화 결과(outcome)를 만들어 활성 계획 refs(revisionSeparateScopeRequests) 에 보존한다. oneShot
//   (또는 미지정) 수집 추가는 기존 추가 단계 경로 그대로 이 수정 실행 초안에만 물화되며 정기 정의·수집
//   상태(워터마크)는 어떤 경로에서도 변경되지 않는다.
// [연결] revision-plan-delta.ts(계약 검사 진단), mission-owner-plan-decisions.ts(실행 배치 검사에서 별도
//   범위 단위 제외·물화 필터), revision-plan-decision-state.ts(검증 통과 뒤 마킹·평가 — 배제 참조 traversal 은
//   revision-plan-blocked-outcomes 의 공틀을 종류 문구와 함께 사용).
// [수정시 주의] outcome 은 표시·감사 데이터이지 실행 권한이 아니다. 정기 정의·워터마크를 수정하는 경로나
//   별도 범위 요청을 이 실행에 조용히 적용하는 경로를 이 모듈에서 만들지 않는다.
import { missionRevisionDeltaSchema } from "@paperclipai/shared/validators/mission-revision";
import type { RevisionPlanDeltaDiagnostic } from "./revision-plan-delta.js";
import type { RevisionExcludedUnitKind } from "./revision-plan-blocked-outcomes.js";
import { readUnitId } from "./revision-plan-declaration-targets.js";

/** 별도 범위 요청 단계의 구조화 결과 — 표시/감사로만 소비된다(정기 정의 변경 적용이 아니다). */
export type RevisionSeparateScopeOutcome = {
  readonly unitId: string;
  readonly label: string;
  readonly collectionScope: "permanentChange";
  readonly code: "mission_revision_permanent_change_separate_scope";
  readonly message: string;
};

/** [슬라이스 Q5] 별도 범위 단위 종류 — 배제 참조 무결성 진단의 코드·문구를 차단 단위와 구분한다. */
export const revisionSeparateScopeUnitKind: RevisionExcludedUnitKind = {
  dependencyCode: "mission_revision_separate_scope_unit_dependency",
  selectorCode: "mission_revision_separate_scope_unit_selector",
  noun: "별도 범위(permanentChange) 단위",
  dependencyRemedy: "해당 수집을 이 실행 1회 수집(oneShot)으로 제출하거나 계획을 다시 구성하세요.",
  selectorRemedy: "해당 연결을 제거하거나 해당 수집을 이 실행 1회 수집(oneShot)으로 제출하세요.",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readUnitLabel(unit: Record<string, unknown>): string {
  for (const key of ["title", "name", "id"] as const) {
    const value = unit[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return "(unnamed unit)";
}

/** [Q5 계약 검사] 수집 범위 구분(collectionScope) 은 추가(add)/복제(clone) 단계에만 선언할 수 있고,
 *   선언 단계는 수집 대상 인자(toolArgs/toolArguments)를 명시해야 한다. 위반은 구조화 거절 진단이 된다. */
export function collectRevisionCollectionScopeDiagnostics(
  unit: { readonly unitId: string; readonly operation: string; readonly collectionScope?: "oneShot" | "permanentChange" },
  selectedExecutionUnits: readonly Record<string, unknown>[],
): RevisionPlanDeltaDiagnostic[] {
  if (unit.collectionScope === undefined) return [];
  const diagnostics: RevisionPlanDeltaDiagnostic[] = [];
  if (unit.operation !== "add" && unit.operation !== "clone") {
    diagnostics.push({
      code: "mission_revision_delta_invalid",
      message: `수집 범위 구분(collectionScope=${unit.collectionScope}) 은 추가(add)/복제(clone) 단위에만 선언할 수 있습니다. `
        + `단위 ${unit.unitId} 의 operation(${unit.operation}) 과는 함께 선언할 수 없습니다.`,
      severity: "invalid",
    });
  }
  const planUnit = selectedExecutionUnits.find(candidate => readUnitId(candidate) === unit.unitId);
  const declaresCollectionArgs = planUnit !== undefined
    && (Object.prototype.hasOwnProperty.call(planUnit, "toolArgs")
      || Object.prototype.hasOwnProperty.call(planUnit, "toolArguments"));
  if (!declaresCollectionArgs) {
    diagnostics.push({
      code: "mission_revision_delta_invalid",
      message: `수집 범위 구분(collectionScope) 단위 ${unit.unitId} 은(는) 수집 대상 인자(toolArgs)를 명시해야 합니다.`,
      severity: "invalid",
    });
  }
  return diagnostics;
}

/** 결정의 revisionDelta 에서 permanentChange 로 선언된 단위 id 를 안전하게 읽는다(파싱 실패/미선언 → 빈 집합). */
export function readDeclaredSeparateScopeRevisionUnitIds(decision: Record<string, unknown>): Set<string> {
  const raw = "revisionDelta" in decision ? decision.revisionDelta : undefined;
  if (!isPlainObject(raw)) return new Set();
  return readSeparateScopeRevisionUnitIds(raw);
}

/** 검증 통과한 변경안 원본에서 별도 범위(permanentChange) 단위 id 집합을 읽는다(파싱 실패 → 빈 집합). */
export function readSeparateScopeRevisionUnitIds(delta: Record<string, unknown>): Set<string> {
  const parsed = missionRevisionDeltaSchema.safeParse(delta);
  if (!parsed.success) return new Set();
  return new Set(parsed.data.units
    .filter(unit => unit.collectionScope === "permanentChange")
    .map(unit => unit.unitId));
}

/** [실행 배치 검사 제외] 별도 범위 선언 단위는 이 실행에 물화되지 않으므로 사전 도구/권한 거절 대상이 아니다. */
export function withoutDeclaredSeparateScopeRevisionUnits(
  units: readonly Record<string, unknown>[],
  decision: Record<string, unknown>,
): Record<string, unknown>[] {
  const separateScopeUnitIds = readDeclaredSeparateScopeRevisionUnitIds(decision);
  if (separateScopeUnitIds.size === 0) return [...units];
  return units.filter(unit => {
    const unitId = readUnitId(unit);
    return unitId === null || !separateScopeUnitIds.has(unitId);
  });
}

/** [Q5 별도 범위 결과] permanentChange 선언 단위는 정기 정의 영구 변경 '요청'으로만 기록된다(적용 아님). */
export function assessRevisionSeparateScopeOutcomes(
  units: readonly Record<string, unknown>[],
  separateScopeUnitIds: ReadonlySet<string>,
): RevisionSeparateScopeOutcome[] {
  const outcomes: RevisionSeparateScopeOutcome[] = [];
  for (const unit of units) {
    const unitId = readUnitId(unit);
    if (unitId === null || !separateScopeUnitIds.has(unitId)) continue;
    const label = readUnitLabel(unit);
    outcomes.push({
      unitId,
      label,
      collectionScope: "permanentChange",
      code: "mission_revision_permanent_change_separate_scope",
      message: `단위 ${label} 은(는) 정기 수집 정의의 영구 변경(permanentChange) 요구입니다. `
        + `이 수정 실행은 정기 정의와 수집 상태(워터마크)를 변경하지 않으며, 해당 요청은 별도 범위로 기록만 남습니다.`,
    });
  }
  return outcomes;
}

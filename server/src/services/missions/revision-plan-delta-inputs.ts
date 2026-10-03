// server/src/services/missions/revision-plan-delta-inputs.ts
//
// [파일 목적] 검증을 통과한 revisionDelta(mission-revision-delta.v1) 단위가 선언한 실행 입력
//   (instructions·interpretedInputs) 를 같은 unitId 의 유효 선택 유닛(현재 템플릿 상속 적용 결과)에
//   적용한다(변경지도 슬라이스1 — 변경안 입력 반영). 변경안 단위가 입력을 선언한 대응 유닛만 새 객체로
//   복제해 해당 필드를 검증된 원본 값으로 채운다. 선언하지 않은 유닛·reuse 단위·변경안 없는 제출의
//   유닛은 객체 그대로 돌아가므로 명시 wiring·생략·unit-ID 대응이 보존된다. 이 입력은 agent 입력
//   데이터다: autofill/PLAN-QA 명세/활성 refs/물화(buildPaqoWorkflowSteps 의 description·
//   interpretedInputs)가 같은 유효 유닛에서 관찰하며, 문구에서 실행 권위를 만들지 않는다(규칙 8).
// [연결] revision-plan-decision-state.ts validateRevisionPlanDeltaOrRecordRejection — 상속·입력연결
//   검증 통과 직후, autofill/PLAN-QA/구조 검증/물화가 같은 초안을 보기 전에 적용한다.
// [수정시 주의] 원본 delta 객체와 유닛 순서를 바꾸지 않고, 입력 유닛 배열을 제자리에서 바꾸지 않는다.
import { missionRevisionDeltaSchema } from "@paperclipai/shared/validators/mission-revision";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readUnitId(unit: Record<string, unknown>): string | null {
  return typeof unit.id === "string" && unit.id.trim() !== "" ? unit.id : null;
}

/** 검증 통과 변경안 단위의 지시·해석 입력을 대응 유닛에 적용한다(선언된 필드만, 나머지 필드는 불변). */
export function applyRevisionDeltaUnitInputs(
  delta: Record<string, unknown>,
  units: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const parsed = missionRevisionDeltaSchema.safeParse(delta);
  // 같은 호출에서 검증을 통과한 객체만 들어온다(방어 경로 — 원본 유닛을 그대로 돌려준다).
  if (!parsed.success) return [...units];
  const deltaUnitById = new Map(parsed.data.units.map((unit) => [unit.unitId, unit] as const));
  return units.map((unit) => {
    const unitId = readUnitId(unit);
    const deltaUnit = unitId !== null ? deltaUnitById.get(unitId) : undefined;
    if (deltaUnit === undefined) return unit;
    const instructions = typeof deltaUnit.instructions === "string" && deltaUnit.instructions.trim() !== ""
      ? deltaUnit.instructions
      : null;
    const interpretedInputs = isPlainObject(deltaUnit.interpretedInputs) ? deltaUnit.interpretedInputs : null;
    if (instructions === null && interpretedInputs === null) return unit;
    return {
      ...unit,
      ...(instructions !== null ? { instructions } : {}),
      ...(interpretedInputs !== null ? { interpretedInputs } : {}),
    };
  });
}

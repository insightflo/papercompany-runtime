// server/src/services/missions/revision-plan-declaration-targets.ts
//
// [파일 목적] decision.steps 구조화 의존성 선언의 '명시 대상 판정' 계약을 응집된 작은 helper 로
//   제공한다(revision-plan-template-inheritance.ts 에서 추출 — 새 파일 300줄 상한 준수). 계약은 기존
//   normalizer(mission-plan-dependency-graph.ts readDraftTargets/resolve) 와 정확히 같다:
//   - 비어 있지 않은 steps.units 배열이 선언되면 그것이 대상 전부다. id/unitId/executionUnitId/
//     selectedExecutionUnitId 는 대상에 더하지 않는다(units 가 빈 배열이면 이 키들로 내려간다).
//   - 대상 해석은 canonical unit id 가 별칭(alias)보다 우선한다. canonical 이 아닌 별칭은 소유자가
//     유일할 때만 해석한다(모호/미해결 별칭은 게이트 시점 normalizer 가 이미 거절했다 — 여기서는
//     보수적으로 명시 대상에서 뺀다).
//   - 잘못된 형태의 units(배열 아님/빈 문자열 항목)는 구조화 선언으로 치지 않는다. 문자열 steps 는
//     구조화 선언이 아니므로 파싱하지 않는다(자연어 파싱 금지).
// [연결] revision-plan-template-inheritance.ts — 상속의 명시 의존성 선언 판정
//   (readStepDeclaredDependencyUnitIds) 이 이 계약을 그대로 쓴다.
// [수정시 주의] 이 계약을 normalizer 와 다르게 바꾸면 steps 선언이 상속 게이트에서 다른 유닛에
//   적용되어 생략된 필수 템플릿 연결이 조용히 누락된다(2026-10-03 revision-mission 확정 결함).
type PlanRecord = Record<string, unknown>;

const UNIT_ALIAS_KEYS = ["id", "unitId", "stepId", "executionUnitId", "selectedExecutionUnitId"] as const;
const SOURCE_ALIAS_KEYS = ["id", "issueId", "stepId", "unitId", "executionUnitId", "selectedExecutionUnitId"] as const;

function isPlainObject(value: unknown): value is PlanRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function readUnitId(unit: PlanRecord): string | null {
  return readNonEmptyString(unit.id);
}

export function hasDependencyDeclaration(unit: PlanRecord): boolean {
  return ["dependencies", "dependsOn", "after"].some((key) => Object.prototype.hasOwnProperty.call(unit, key));
}

// 유닛 별칭 표면(normalizer UNIT_ALIAS_KEYS + sourceRef 별칭과 같은 의미)을 정규 유닛 id 로 모은다.
function readUnitAliases(unit: PlanRecord): string[] {
  const aliases = UNIT_ALIAS_KEYS.map((key) => readNonEmptyString(unit[key]));
  const sourceRef = isPlainObject(unit.sourceRef) ? unit.sourceRef : null;
  if (sourceRef) aliases.push(...SOURCE_ALIAS_KEYS.map((key) => readNonEmptyString(sourceRef[key])));
  return Array.from(new Set(aliases.filter((alias): alias is string => alias !== null)));
}

// [목적] 구조화 steps 선언 하나의 대상을 읽는다(normalizer readDraftTargets 와 동일 우선순위:
//   비어 있지 않은 units 배열이 대상 전부).
function readStepDeclarationTargets(step: PlanRecord): string[] {
  if (Object.prototype.hasOwnProperty.call(step, "units")) {
    // 형태가 올바르지 않은 units 는 선언이 아니다(normalizer 진단은 게이트 시점에 이미 발생했다).
    if (!Array.isArray(step.units) || step.units.some((entry) => readNonEmptyString(entry) === null)) return [];
    const units = step.units.map((entry) => readNonEmptyString(entry)!);
    if (units.length > 0) return Array.from(new Set(units));
  }
  const targets: string[] = [];
  for (const key of ["unitId", "executionUnitId", "selectedExecutionUnitId", "id"] as const) {
    const target = readNonEmptyString(step[key]);
    if (target !== null) targets.push(target);
  }
  return Array.from(new Set(targets));
}

// [목적] steps 에서 명시적으로 의존성을 선언받은 canonical 유닛 id 집합. 대상 해석은 normalizer
//   resolve 와 동일하게 canonical id 우선 + 유일 소유자 별칭만 허용한다(다른 유닛의 legacy 별칭이
//   canonical id 와 겹쳐도 canonical 유닛에만 적용한다).
export function readStepDeclaredDependencyUnitIds(
  decision: PlanRecord,
  declaredUnits: readonly PlanRecord[],
): Set<string> {
  const canonicalUnitIds = new Set<string>();
  const unitIdsByAlias = new Map<string, Set<string>>();
  for (const unit of declaredUnits) {
    const unitId = readUnitId(unit);
    if (!unitId) continue;
    canonicalUnitIds.add(unitId);
    for (const alias of readUnitAliases(unit)) {
      const owners = unitIdsByAlias.get(alias) ?? new Set<string>();
      owners.add(unitId);
      unitIdsByAlias.set(alias, owners);
    }
  }
  // canonical unit id 가 별칭보다 우선한다. canonical 이 아닌 별칭은 유일 소유자일 때만 해석한다.
  const resolveTarget = (ref: string): string | null => {
    if (canonicalUnitIds.has(ref)) return ref;
    const owners = unitIdsByAlias.get(ref);
    if (owners === undefined || owners.size !== 1) return null;
    return owners.values().next().value ?? null;
  };
  const explicit = new Set<string>();
  const steps = decision.steps;
  if (!Array.isArray(steps)) return explicit;
  for (const raw of steps) {
    if (!isPlainObject(raw) || !hasDependencyDeclaration(raw)) continue;
    for (const target of readStepDeclarationTargets(raw)) {
      const unitId = resolveTarget(target);
      if (unitId !== null) explicit.add(unitId);
    }
  }
  return explicit;
}

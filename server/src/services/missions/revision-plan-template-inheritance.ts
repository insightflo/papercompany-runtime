// server/src/services/missions/revision-plan-template-inheritance.ts
//
// [파일 목적] 검증을 통과한 revisionDelta(mission-revision-delta.v1) 의 templateStepId 대응이 유일한
//   선택 유닛이 dependencies/workProductSelectors/toolArgs 를 생략했을 때, 변경안이 명시적으로 선택한
//   기준 템플릿(revisionDelta.base, 같은-회사 정의 + 스냅샷 해시)에서 해당 연결을 상속해 선택 유닛
//   좌표(unit id)로 재매핑한다(변경지도 슬라이스1 — 현재 템플릿 적용). 이후 기존 builder/물화가 unit id
//   를 새 단계 ID 로 다시 매핑한다. 현재 템플릿은 기획 입력이지 실행 권위가 아니므로:
//   - 상속은 '생략'에만 적용된다. 사용자가 명시한 값(빈 배열/빈 객체 포함)은 truthiness 없이 그대로 둔다.
//     정규화(normalizeMissionPlanDependencyGraph) 는 모든 유닛에 canonical dependencies 를 채우므로 생략
//     여부는 사용자가 제출한 원본 decision 유닛으로만 판정한다.
//   - 의존성 생략 판정은 decision.steps 의 구조화된 선언까지 반영한다(readDraftTargets 와 같은 대상/
//     별칭 의미: units/unitId/executionUnitId/selectedExecutionUnitId/id 대상 + dependencies/dependsOn/
//     after 선언). 대상 유닛이 steps 에서 연결을 명시했다면 이미 canonical 화된 연결을 유지하고 상속으로
//     덮지 않는다(빈 배열 선언도 명시다). 자연어 steps 문자열은 파싱하지 않는다.
//   - 기준은 delta.base.workflowDefinitionId 로 읽은 정의뿐이다(승인 후 최신 템플릿으로 조용히 전환하지
//     않는다). 정의가 없거나 스냅샷 해시가 다르면 구조화 거절한다.
//   - 템플릿 연결이 가리키는 생산 단계가 기준 템플릿에 없거나(unknown) 유일하게 선택된 유닛으로 대응되지
//     않으면(missing/ambiguous) 생산자를 발명하거나 필수 간선을 조용히 끊지 않고 구조화 거절한다.
//     toolArgs 검사는 재작성 '전' 원본 문자열 값의 STEP_REF_TOKEN 으로 한다 — rewriteToolArgsStepReferences
//     는 object key 를 바꾸지 않으므로 검사도 실제 문자열 값만 순회하고, 검증 후에는 한 번만 재작성하며
//     재작성된 선택 좌표를 다시 템플릿 좌표로 해석하지 않는다(유닛 id 가 미선택 템플릿 단계 id 와 같아도
//     정상 대응을 오거절하지 않는다). 모호한 A+B 매핑·QA 상속은 이 제출 범위 밖이다.
//   - templateStepId 대응이 없는 유닛·변경안 없는 제출은 그대로 통과한다(일반 미션 회귀 없음).
// [연결] revision-plan-decision-state.ts validateRevisionPlanDeltaOrRecordRejection — 변경안 검증 통과
//   직후, 입력 연결 검사/autofill/PLAN-QA/구조 검증/물화가 같은 유효 유닛을 보기 전에 적용한다.
// [수정시 주의] 유닛 순서와 상속 대상 외 필드·원본 delta 객체를 바꾸지 않는다. 거부 진단은 기존 코드
//   (mission_revision_delta_invalid / mission_revision_unit_reference_ambiguous)를 재사용한다.
import { and, eq } from "drizzle-orm";
import { workflowDefinitions, type Db } from "@paperclipai/db";
import { missionRevisionDeltaSchema } from "@paperclipai/shared/validators/mission-revision";
import { computePaqoDefinitionHash } from "../workflow/paqo-definition-identity.js";
import { STEP_REF_TOKEN, rewriteToolArgsStepReferences } from "./structural-materialization.js";
import type { RevisionPlanDeltaDiagnostic } from "./revision-plan-delta.js";

/** [슬라이스1] 현재 템플릿 상속 결과: 통과하면 상속이 적용된 유효 유닛, 실패하면 구조화 거절 진단. */
export type RevisionTemplateInheritance =
  | { ok: true; units: Record<string, unknown>[] }
  | { ok: false; reason: string; diagnostics: RevisionPlanDeltaDiagnostic[] };

type TemplateStep = {
  readonly id: string;
  readonly dependencies: readonly string[];
  readonly workProductSelectors: Record<string, unknown> | null;
  readonly toolArgs: unknown;
};

const deltaInvalid = (message: string): RevisionPlanDeltaDiagnostic =>
  ({ code: "mission_revision_delta_invalid", message, severity: "invalid" });

const unitAmbiguous = (message: string): RevisionPlanDeltaDiagnostic =>
  ({ code: "mission_revision_unit_reference_ambiguous", message, severity: "invalid" });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readUnitId(unit: Record<string, unknown>): string | null {
  return typeof unit.id === "string" && unit.id.trim() !== "" ? unit.id.trim() : null;
}

function hasDependencyDeclaration(unit: Record<string, unknown>): boolean {
  return ["dependencies", "dependsOn", "after"].some((key) => Object.prototype.hasOwnProperty.call(unit, key));
}

function readTemplateSteps(stepsJson: unknown): TemplateStep[] {
  if (!Array.isArray(stepsJson)) return [];
  const steps: TemplateStep[] = [];
  for (const raw of stepsJson) {
    if (!isPlainObject(raw) || typeof raw.id !== "string" || raw.id.trim() === "") continue;
    steps.push({
      id: raw.id,
      dependencies: Array.isArray(raw.dependencies)
        ? raw.dependencies.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
        : [],
      workProductSelectors: isPlainObject(raw.workProductSelectors) ? raw.workProductSelectors : null,
      toolArgs: raw.toolArgs,
    });
  }
  return steps;
}

// decision.steps 의 구조화된 선언에서 대상을 읽는다(mission-plan-dependency-graph readDraftTargets 와
//   같은 대상 키 의미). 문자열 steps 는 구조화 선언이 아니므로 파싱하지 않는다.
function readStepDeclarationTargets(step: Record<string, unknown>): string[] {
  const targets: string[] = [];
  if (Array.isArray(step.units)) {
    for (const entry of step.units) if (typeof entry === "string" && entry.trim() !== "") targets.push(entry.trim());
  }
  for (const key of ["unitId", "executionUnitId", "selectedExecutionUnitId", "id"] as const) {
    const value = step[key];
    if (typeof value === "string" && value.trim() !== "") targets.push(value.trim());
  }
  return Array.from(new Set(targets));
}

// 유닛 별칭 표면(normalizer UNIT_ALIAS_KEYS + sourceRef 별칭과 같은 의미)을 정규 유닛 id 로 모은다.
function readUnitAliases(unit: Record<string, unknown>): string[] {
  const aliases: string[] = [];
  for (const key of ["id", "unitId", "stepId", "executionUnitId", "selectedExecutionUnitId"] as const) {
    const value = unit[key];
    if (typeof value === "string" && value.trim() !== "") aliases.push(value.trim());
  }
  const sourceRef = isPlainObject(unit.sourceRef) ? unit.sourceRef : null;
  if (sourceRef) {
    for (const key of ["id", "issueId", "stepId", "unitId", "executionUnitId", "selectedExecutionUnitId"] as const) {
      const value = sourceRef[key];
      if (typeof value === "string" && value.trim() !== "") aliases.push(value.trim());
    }
  }
  return Array.from(new Set(aliases));
}

// steps 에서 명시적으로 의존성을 선언받은 유닛 id 집합. 대상은 유닛 별칭으로 정규 유닛에 해석한다
//   (게이트 시점엔 normalizer 가 모호/미해결 별칭을 이미 거절했으므로 해석은 유일하다).
function readStepDeclaredDependencyUnitIds(
  decision: Record<string, unknown>,
  declaredUnits: readonly Record<string, unknown>[],
): Set<string> {
  const unitIdsByAlias = new Map<string, Set<string>>();
  for (const unit of declaredUnits) {
    const unitId = readUnitId(unit);
    if (!unitId) continue;
    for (const alias of readUnitAliases(unit)) {
      const owners = unitIdsByAlias.get(alias) ?? new Set<string>();
      owners.add(unitId);
      unitIdsByAlias.set(alias, owners);
    }
  }
  const explicit = new Set<string>();
  const steps = decision.steps;
  if (!Array.isArray(steps)) return explicit;
  for (const raw of steps) {
    if (!isPlainObject(raw) || !hasDependencyDeclaration(raw)) continue;
    for (const target of readStepDeclarationTargets(raw)) {
      for (const unitId of unitIdsByAlias.get(target) ?? []) explicit.add(unitId);
    }
  }
  return explicit;
}

// [Astra 교정] 원본 toolArgs 문자열 값에서 STEP_REF_TOKEN 생산자를 모은다. rewriteToolArgsStepReferences
//   는 object key 를 바꾸지 않으므로 검사도 실제 문자열 값만 순회한다(키는 검사 대상이 아니다).
function collectStepRefProducers(value: unknown, producers: string[]): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(STEP_REF_TOKEN)) producers.push(match[1]!);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStepRefProducers(item, producers);
    return;
  }
  if (isPlainObject(value)) {
    for (const child of Object.values(value)) collectStepRefProducers(child, producers);
  }
}

// [목적] 유일한 templateStepId 대응에 따라 생략된 연결(dependencies/workProductSelectors/toolArgs)을
//   명시적으로 선택한 기준 템플릿 정의에서 상속해 선택 유닛 좌표로 재매핑한다.
// [입력] db(회사 스코프 select)/companyId/delta(같은 호출에서 검증을 통과한 원본)/selectedExecutionUnits
//   (정규화 유닛, 상속 결과가 기록되는 대상)/decision(사용자가 제출한 원본 — 생략 판정용).
// [출력] ok+units(상속 적용 유닛, 입력 순서 불변) 또는 ok=false+reason+diagnostics(구조화 거절).
// [연결] validateRevisionPlanDeltaOrRecordRejection — 거부 기록/invalid 응답은 호출자가 맡는다.
export async function inheritCurrentTemplateWiring(input: {
  readonly db: Pick<Db, "select">;
  readonly companyId: string;
  readonly delta: Record<string, unknown>;
  readonly selectedExecutionUnits: readonly Record<string, unknown>[];
  readonly decision: Record<string, unknown>;
}): Promise<RevisionTemplateInheritance> {
  const parsed = missionRevisionDeltaSchema.safeParse(input.delta);
  if (!parsed.success) {
    // 같은 호출에서 검증을 통과한 객체만 들어온다(방어 오류 — 정상 경로가 아니다).
    return {
      ok: false,
      reason: "mission_revision_delta_invalid",
      diagnostics: [deltaInvalid("변경안이 검증 통과 형태와 일치하지 않아 현재 템플릿 상속을 적용할 수 없습니다.")],
    };
  }
  const delta = parsed.data;
  const claims = new Map<string, string[]>();
  for (const deltaUnit of delta.units) {
    if (!deltaUnit.templateStepId) continue;
    const claimants = claims.get(deltaUnit.templateStepId) ?? [];
    claimants.push(deltaUnit.unitId);
    claims.set(deltaUnit.templateStepId, claimants);
  }
  if (claims.size === 0) return { ok: true, units: [...input.selectedExecutionUnits] };

  // 기준은 명시적으로 선택한 정의뿐이다. 승인 후 정의가 바뀌었으면 최신을 조용히 쓰지 않고 거절한다.
  const [baseDefinition] = await input.db
    .select({ stepsJson: workflowDefinitions.stepsJson })
    .from(workflowDefinitions)
    .where(and(
      eq(workflowDefinitions.companyId, input.companyId),
      eq(workflowDefinitions.id, delta.base.workflowDefinitionId),
    ))
    .limit(1);
  if (!baseDefinition) {
    return {
      ok: false,
      reason: "mission_revision_delta_invalid",
      diagnostics: [deltaInvalid(`기준 템플릿 정의(${delta.base.workflowDefinitionId}) 가 이 회사에서 발견되지 않습니다.`)],
    };
  }
  const currentSnapshotHash = computePaqoDefinitionHash(
    baseDefinition.stepsJson as Parameters<typeof computePaqoDefinitionHash>[0]);
  if (currentSnapshotHash !== delta.base.snapshotHash) {
    return {
      ok: false,
      reason: "mission_revision_delta_invalid",
      diagnostics: [deltaInvalid(
        `기준 템플릿이 변경되었습니다. 변경안을 다시 작성하세요(제출 ${delta.base.snapshotHash.slice(0, 12)} / 현재 ${currentSnapshotHash.slice(0, 12)}).`)],
    };
  }

  const templateStepById = new Map(readTemplateSteps(baseDefinition.stepsJson).map((step) => [step.id, step] as const));
  const unitByTemplateStep = new Map<string, string>(); // 유일한 대응만 선택 유닛 좌표로 쓴다.
  for (const [templateStepId, claimants] of claims) {
    if (claimants.length === 1) unitByTemplateStep.set(templateStepId, claimants[0]!);
  }
  const declaredUnits = Array.isArray(input.decision.selectedExecutionUnits)
    && input.decision.selectedExecutionUnits.every(isPlainObject)
    ? input.decision.selectedExecutionUnits
    : [];
  const declaredUnitById = new Map(
    declaredUnits.map((unit) => { const id = readUnitId(unit); return id ? [id, unit] as const : null; })
      .filter((entry): entry is readonly [string, Record<string, unknown>] => entry !== null),
  );
  const stepDeclaredDependencyUnitIds = readStepDeclaredDependencyUnitIds(input.decision, declaredUnits);
  const deltaUnitByUnitId = new Map(delta.units.map((deltaUnit) => [deltaUnit.unitId, deltaUnit] as const));
  const diagnostics: RevisionPlanDeltaDiagnostic[] = [];

  // 템플릿 좌표 → 선택 유닛 좌표. 유일하게 대응되지 않으면 생산자를 발명하지 않고 거절 진단을 쌓는다.
  const resolveClaimant = (label: string, field: string, templateStepId: string): string | null => {
    const claimant = unitByTemplateStep.get(templateStepId);
    if (claimant !== undefined) return claimant;
    const claimants = claims.get(templateStepId);
    if (claimants && claimants.length > 1) {
      diagnostics.push(unitAmbiguous(
        `단위 ${label} 의 상속된 ${field} 이(가) 여러 유닛(${claimants.join(", ")}) 이(가) 가리키는 템플릿 단계 ${templateStepId} 를 모호하게 참조합니다.`));
    } else {
      diagnostics.push(deltaInvalid(
        `단위 ${label} 의 상속된 ${field} 이(가) 가리키는 템플릿 단계 ${templateStepId} 가 선택된 유닛으로 유일하게 대응되지 않습니다.`));
    }
    return null;
  };

  const units = [...input.selectedExecutionUnits];
  for (let index = 0; index < units.length; index++) {
    const unit = units[index]!;
    const unitId = readUnitId(unit);
    const label = unitId ?? String(index);
    const deltaUnit = unitId ? deltaUnitByUnitId.get(unitId) : undefined;
    const templateStepId = typeof deltaUnit?.templateStepId === "string" ? deltaUnit.templateStepId : undefined;
    if (!templateStepId) continue; // 대응 없음 — 상속 대상이 아니다(일반 유닛 경로 회귀 없음).
    const step = templateStepById.get(templateStepId);
    if (!step) {
      diagnostics.push(deltaInvalid(`단위 ${label} 의 templateStepId(${templateStepId}) 가 기준 템플릿에 없습니다.`));
      continue;
    }
    // 생략 판정은 사용자가 제출한 원본 유닛으로 한다. 원본을 찾지 못하면 정규화 유닛(항상
    // dependencies 가 채워진다)을 기준으로 삼아 보수적으로 상속하지 않는다.
    const declared = unitId ? declaredUnitById.get(unitId) : undefined;
    const omissionSource = declared ?? unit;
    const stepDeclaredDependencies = unitId !== null && stepDeclaredDependencyUnitIds.has(unitId);
    const inheritsDependencies = !hasDependencyDeclaration(omissionSource)
      && !stepDeclaredDependencies && step.dependencies.length > 0;
    const inheritsSelectors = !Object.prototype.hasOwnProperty.call(omissionSource, "workProductSelectors")
      && step.workProductSelectors !== null && Object.keys(step.workProductSelectors).length > 0;
    const inheritsToolArgs = !Object.prototype.hasOwnProperty.call(omissionSource, "toolArgs")
      && !Object.prototype.hasOwnProperty.call(omissionSource, "toolArguments") && step.toolArgs !== undefined;
    if (!inheritsDependencies && !inheritsSelectors && !inheritsToolArgs) continue;
    const claimants = claims.get(templateStepId) ?? [];
    if (claimants.length > 1) {
      // 이 제출은 유일한 대응만 다룬다. 모호한 A+B 매핑 상속은 별도 필수 작업으로 남는다.
      diagnostics.push(unitAmbiguous(
        `템플릿 단계 ${templateStepId} 가 여러 유닛(${claimants.join(", ")}) 에게 대응되어 단위 ${label} 의 생략된 연결을 유일하게 상속할 수 없습니다.`));
      continue;
    }
    const inherited: Record<string, unknown> = {};
    if (inheritsDependencies) {
      const dependencies: string[] = [];
      let resolved = true;
      for (const templateDependencyId of step.dependencies) {
        const claimant = resolveClaimant(label, "dependencies", templateDependencyId);
        if (claimant === null) { resolved = false; break; }
        dependencies.push(claimant);
      }
      if (!resolved) continue;
      inherited.dependencies = Array.from(new Set(dependencies));
    }
    if (inheritsSelectors) {
      const selectors: Record<string, unknown> = {};
      let resolved = true;
      for (const [templateProducerId, selector] of Object.entries(step.workProductSelectors!)) {
        const claimant = resolveClaimant(label, "workProductSelectors", templateProducerId);
        if (claimant === null) { resolved = false; break; }
        if (Object.prototype.hasOwnProperty.call(selectors, claimant)) {
          diagnostics.push(unitAmbiguous(
            `단위 ${label} 의 상속된 결과 선택자 키들이 같은 생산 단위 ${claimant} 로 합쳐집니다.`));
          resolved = false;
          break;
        }
        selectors[claimant] = selector;
      }
      if (!resolved) continue;
      inherited.workProductSelectors = selectors;
    }
    if (inheritsToolArgs) {
      // [Astra 교정] 재작성 '전' 원본 템플릿 좌표로 검증한다: 모든 생산자는 기준 템플릿에 있어야 하고
      //   유일한 선택 유닛에 대응해야 한다. 검증 후 한 번만 재작성하며, 재작성된 선택 유닛 좌표를 다시
      //   템플릿 좌표로 해석하지 않는다(유닛 id == 미선택 템플릿 단계 id 충돌 시 오거절 방지).
      const producers: string[] = [];
      collectStepRefProducers(step.toolArgs, producers);
      let resolved = true;
      for (const templateProducerId of producers) {
        if (!templateStepById.has(templateProducerId)) {
          diagnostics.push(deltaInvalid(
            `단위 ${label} 의 상속된 toolArgs 참조({$steps.${templateProducerId}.*}) 가 기준 템플릿에 없는 생산 단계를 가리킵니다.`));
          resolved = false;
          break;
        }
        if (resolveClaimant(label, "toolArgs", templateProducerId) === null) { resolved = false; break; }
      }
      if (!resolved) continue;
      inherited.toolArgs = rewriteToolArgsStepReferences(step.toolArgs, unitByTemplateStep);
    }
    units[index] = { ...unit, ...inherited };
  }
  if (diagnostics.length > 0) return { ok: false, reason: diagnostics[0]!.code, diagnostics };
  return { ok: true, units };
}

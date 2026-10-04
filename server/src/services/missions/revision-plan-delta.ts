// server/src/services/missions/revision-plan-delta.ts
//
// [파일 목적] 버전 있는 수정 변경안(mission-revision-delta.v1) 공개 제출 검증(변경지도 R1/R2/R5, 슬라이스1).
//   decision.revisionDelta 는 선택 계약이다. 없으면 기존 제출 경로(일반 미션·레거시)를 그대로
//   통과시키고, 있으면 PLAN-QA 생성·의도 검사·구조 검증·물화 이전에 다음을 구조화 거절한다:
//   - 지원하지 않는 schemaVersion / 계약 위반 모양(mission_revision_delta_invalid)
//   - 원본 실행·기준 템플릿의 같은-회사 관계 및 실제 스냅샷 드리프트
//   - reuse + 변경된 지시/해석 입력 모순
//   - 계획 단위 ↔ 변경안 단위 불일치, 알 수 없는 참조
//   - 서로 다른 별칭이 같은 생산 단위로 합쳐지는 모호한 매핑(mission_revision_unit_reference_ambiguous)
//   - 변경안이 선언한 필수 입력(requiredInputs)을 계획의 결과 선택자가 소비하지 않음, 또는 필수 입력의
//     selector 값이 실제 선택자 값과 다름(같은 생산자의 다른 파일 혼동) — 이 입력 연결 검사는
//     validateRevisionPlanDeltaWiring 으로 분리되어 현재 템플릿 상속 적용 후 실행된다
//   - 선언된 필수 기능(capabilityRequirements)을 활성 도구가 제공하지 않음(mission_revision_capability_gap)
// [연결] mission-owner-plan-decisions.ts recordLatestAuthorizedMissionOwnerPlanDecision — 실행 배치(도구/권한)
//   검증 통과 직후 호출되고, 검증을 통과한 원본 delta 객체를 활성 plan refs 보존에 돌려준다.
// [수정시 주의] 예상 진단만 반환하고 예외를 삼키지 않는다. 스냅샷 해시는 워크플로 정의 동결 규칙
//   (computePaqoDefinitionHash, 키 순서 무관)을 그대로 재사용한다.
import { and, eq } from "drizzle-orm";
import { workflowDefinitions, type Db } from "@paperclipai/db";
import {
  MISSION_REVISION_DELTA_SCHEMA_VERSION,
  missionRevisionDeltaSchema,
} from "@paperclipai/shared/validators/mission-revision";
import { computePaqoDefinitionHash } from "../workflow/paqo-definition-identity.js";
import type { PlanningArtifactTool } from "./mission-plan-publication-contract.js";

export type RevisionPlanDeltaDiagnostic = { code: string; message: string; severity: "invalid" };

export type RevisionPlanDeltaValidation =
  | { ok: true; delta: Record<string, unknown> | null }
  | { ok: false; reason: string; diagnostics: RevisionPlanDeltaDiagnostic[] };

const deltaInvalid = (message: string): RevisionPlanDeltaDiagnostic =>
  ({ code: "mission_revision_delta_invalid", message, severity: "invalid" });

const unitAmbiguous = (message: string): RevisionPlanDeltaDiagnostic =>
  ({ code: "mission_revision_unit_reference_ambiguous", message, severity: "invalid" });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readUnitId(unit: Record<string, unknown>): string | null {
  return typeof unit.id === "string" && unit.id.trim() !== "" ? unit.id : null;
}

function readUnitSourceStepId(unit: Record<string, unknown>): string | null {
  return typeof unit.sourceStepId === "string" && unit.sourceStepId.trim() !== "" ? unit.sourceStepId : null;
}

function toolCapabilities(tool: PlanningArtifactTool | undefined): string[] {
  const capabilities = tool && Array.isArray(tool.adapterConfig.capabilities) ? tool.adapterConfig.capabilities : [];
  return capabilities.filter((capability): capability is string => typeof capability === "string");
}

// [선택자 값 동등성 — Q12] 결과 선택자 값은 JSON 계약 값(workProductSelectorsSchema — {type,title}
//   strict, 선택 필드 없음) 이다. 키 순서 무관 정규형 직렬화로 동등성을 판정하고 진단 메시지에도 같은
//   정규형을 쓴다. 스키마가 선택 필드를 갖지 않으므로 '생략 vs 기본값' 호환 형태는 존재하지 않는다 —
//   정규형이 다르면 다른 값이다(완화 없음).
function canonicalSelectorJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSelectorJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalSelectorJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// [목적] 공개 제출된 revisionDelta 를 검증하고 활성 계획 refs 보존용 원본을 반환한다.
// [입력] db(회사 스코프 select)/companyId/missionSourceWorkflowRunId/decision/selectedExecutionUnits/tools(활성).
// [출력] ok+delta(변경안이 없으면 null) 또는 ok=false+reason+diagnostics(구조화 거절).
// [연결] recordLatestAuthorizedMissionOwnerPlanDecision — 배치 검증 통과 직후, PLAN-QA/물화 이전.
export async function validateRevisionPlanDelta(input: {
  readonly db: Pick<Db, "select">;
  readonly companyId: string;
  readonly missionSourceWorkflowRunId: string | null;
  readonly decision: Record<string, unknown>;
  readonly selectedExecutionUnits: readonly Record<string, unknown>[];
  readonly tools: readonly PlanningArtifactTool[];
}): Promise<RevisionPlanDeltaValidation> {
  const rawDelta = "revisionDelta" in input.decision ? input.decision.revisionDelta : undefined;
  if (rawDelta === undefined || rawDelta === null) return { ok: true, delta: null };

  const parsed = missionRevisionDeltaSchema.safeParse(rawDelta);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "mission_revision_delta_invalid",
      diagnostics: [deltaInvalid(
        `revisionDelta 가 ${MISSION_REVISION_DELTA_SCHEMA_VERSION} 계약과 일치하지 않습니다: `
        + parsed.error.issues.map(issue => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "),
      )],
    };
  }
  const delta = parsed.data;
  const diagnostics: RevisionPlanDeltaDiagnostic[] = [];

  // [출처 관계] 변경안의 원본 실행은 이 미션의 원본 실행(같은 회사 스코프)과 같아야 한다.
  if (input.missionSourceWorkflowRunId === null || delta.sourceWorkflowRunId !== input.missionSourceWorkflowRunId) {
    diagnostics.push(deltaInvalid(
      `revisionDelta.sourceWorkflowRunId(${delta.sourceWorkflowRunId}) 가 이 미션의 원본 실행과 일치하지 않습니다.`));
  }

  // [기준 스냅샷] 같은 회사의 현재 템플릿 정의를 실제로 읽어 동결 규칙 해시로 드리프트를 검증한다.
  const [baseDefinition] = await input.db
    .select({ stepsJson: workflowDefinitions.stepsJson })
    .from(workflowDefinitions)
    .where(and(
      eq(workflowDefinitions.companyId, input.companyId),
      eq(workflowDefinitions.id, delta.base.workflowDefinitionId),
    ))
    .limit(1);
  if (!baseDefinition) {
    diagnostics.push(deltaInvalid(
      `기준 템플릿 정의(${delta.base.workflowDefinitionId}) 가 이 회사에서 발견되지 않습니다.`));
  } else {
    const currentSnapshotHash = computePaqoDefinitionHash(
      baseDefinition.stepsJson as Parameters<typeof computePaqoDefinitionHash>[0]);
    if (currentSnapshotHash !== delta.base.snapshotHash) {
      diagnostics.push(deltaInvalid(
        `기준 템플릿이 변경되었습니다. 변경안을 다시 작성하세요(제출 ${delta.base.snapshotHash.slice(0, 12)} / 현재 ${currentSnapshotHash.slice(0, 12)}).`));
    }
  }

  // [단위 색인] 계획 단위 id 와 원본 단계 대응(sourceStepId) 별칭을 정규 단위 id 로 모은다.
  const planUnitIds = new Set<string>();
  const aliasToUnitId = new Map<string, string>();
  for (const unit of input.selectedExecutionUnits) {
    const unitId = readUnitId(unit);
    if (!unitId) continue;
    planUnitIds.add(unitId);
    aliasToUnitId.set(unitId, unitId);
    const sourceStepId = readUnitSourceStepId(unit);
    if (!sourceStepId) continue;
    const existing = aliasToUnitId.get(sourceStepId);
    if (existing !== undefined && existing !== unitId) {
      diagnostics.push(unitAmbiguous(
        `원본 단계 ${sourceStepId} 가 계획 단위 ${existing} 와(과) ${unitId} 로 모호하게 대응됩니다.`));
      continue;
    }
    aliasToUnitId.set(sourceStepId, unitId);
  }

  // [커버리지·모순] 변경안은 계획의 모든 단위를 다루고, 재사용 후보는 변경을 함께 선언하지 않는다.
  const deltaUnitById = new Map(delta.units.map(unit => [unit.unitId, unit]));
  for (const unitId of planUnitIds) {
    if (!deltaUnitById.has(unitId)) {
      diagnostics.push(deltaInvalid(`계획 단위 ${unitId} 에 대한 변경안 항목이 없습니다.`));
    }
  }
  for (const unit of delta.units) {
    if (!planUnitIds.has(unit.unitId)) {
      diagnostics.push(deltaInvalid(`변경안 단위 ${unit.unitId} 가 계획에 없습니다.`));
    }
    if (unit.operation === "reuse" && (unit.instructions !== undefined || unit.interpretedInputs !== undefined)) {
      diagnostics.push(deltaInvalid(
        `재사용(reuse) 단위 ${unit.unitId} 가 변경된 지시/해석 입력을 함께 선언했습니다. modify 로 제출하세요.`));
    }
  }

  // [대응 일치] 변경안의 sourceStepId 는 계획 단위의 명시적 대응과 같아야 한다(서신 관계, 승인 아님).
  for (const unit of input.selectedExecutionUnits) {
    const unitId = readUnitId(unit);
    const deltaUnit = unitId ? deltaUnitById.get(unitId) : undefined;
    if (!unitId || !deltaUnit) continue;
    const claimed = deltaUnit.sourceStepId ?? null;
    const declared = readUnitSourceStepId(unit);
    if (claimed !== declared) {
      diagnostics.push(deltaInvalid(
        `변경안 단위 ${unitId} 의 sourceStepId(${claimed ?? "없음"}) 가 계획 단위의 대응(${declared ?? "없음"}) 와(과) 다릅니다.`));
    }
  }

  // [입력 연결·별칭 모호성] 이 검사는 validateRevisionPlanDeltaWiring 으로 분리되어, 현재 템플릿 상속이
  //   적용된 effective units 에 대해 게이트에서 실행된다(상속 전 초안에서 requiredInputs 를 거절하면
  //   생략된 selector 를 상속해 소비하는 정상 계획이 막힌다). 검사 내용·진단 코드는 그대로 유지된다.

  // [필수 기능] 등록·활성 도구가 요청 capability 를 실제로 제공해야 한다(등록만으로 충족되지 않는다).
  for (const requirement of delta.capabilityRequirements ?? []) {
    if (!planUnitIds.has(requirement.unitId)) {
      diagnostics.push(deltaInvalid(`기능 요구가 계획에 없는 단위 ${requirement.unitId} 를 참조합니다.`));
      continue;
    }
    const tool = input.tools.find(candidate => candidate.name === requirement.toolName);
    if (!toolCapabilities(tool).includes(requirement.capability)) {
      diagnostics.push({
        code: "mission_revision_capability_gap",
        message: `단위 ${requirement.unitId} 의 필수 결과(${requirement.requiredOutcomeId}) 에 필요한 기능 `
          + `${requirement.capability} 을(를) 활성 도구 ${requirement.toolName} 이(가) 제공하지 않습니다.`,
        severity: "invalid",
      });
    }
  }

  if (diagnostics.length > 0) {
    return { ok: false, reason: diagnostics[0]!.code, diagnostics };
  }
  // 검증을 통과한 원본 변경안을 그대로 돌려준다(decisionHash·활성 refs·후속 소비가 같은 객체를 본다).
  return { ok: true, delta: rawDelta as Record<string, unknown> };
}

// [입력 연결·별칭 모호성 — 상속 후 검사 단계] 선택자 키는 단위 id/원본 단계 별칭으로 해석된다. 서로 다른
//   키가 같은 생산 단위로 합쳐지면 모호하고, 변경안이 선언한 필수 입력은 실제 선택자 연결로 소비되어야
//   한다. 필수 입력의 selector 값도 해당 생산 단위를 향한 실제 선택자 값과 정규형 동등해야 한다 — 같은
//   생산자의 다른 파일(다른 type/title)을 가리키는 필수 입력은 혼동 가능 연결로 구조화 거절한다. 이 검사는
//   현재 템플릿 상속(inheritCurrentTemplateWiring) 이 적용된 effective units 에 대해 실행된다 — 상속 전
//   초안에서 requiredInputs 를 거절하면 생략된 selector 를 상속해 소비할 수 있는 정상 계획이 막힌다.
//   명시적 {} 로 필수 입력을 없앤 제출도 여기서 계속 거절된다.
// [연결] revision-plan-decision-state.ts validateRevisionPlanDeltaOrRecordRejection — 상속 적용 직후.
export function validateRevisionPlanDeltaWiring(input: {
  readonly delta: Record<string, unknown>;
  readonly selectedExecutionUnits: readonly Record<string, unknown>[];
}): RevisionPlanDeltaDiagnostic[] {
  const parsed = missionRevisionDeltaSchema.safeParse(input.delta);
  if (!parsed.success) {
    // 같은 호출에서 검증을 통과한 객체만 들어온다(방어 오류 — 정상 경로가 아니다).
    return [deltaInvalid("변경안이 검증 통과 형태와 일치하지 않아 입력 연결 검증을 적용할 수 없습니다.")];
  }
  const deltaUnitById = new Map(parsed.data.units.map(unit => [unit.unitId, unit]));
  const aliasToUnitId = new Map<string, string>();
  for (const unit of input.selectedExecutionUnits) {
    const unitId = readUnitId(unit);
    if (!unitId) continue;
    aliasToUnitId.set(unitId, unitId);
    const sourceStepId = readUnitSourceStepId(unit);
    if (!sourceStepId) continue;
    const existing = aliasToUnitId.get(sourceStepId);
    if (existing !== undefined && existing !== unitId) continue; // 모호한 별칭은 상위 검증([단위 색인]) 이 이미 거절했다.
    aliasToUnitId.set(sourceStepId, unitId);
  }
  const diagnostics: RevisionPlanDeltaDiagnostic[] = [];
  for (const unit of input.selectedExecutionUnits) {
    const unitId = readUnitId(unit);
    const deltaUnit = unitId ? deltaUnitById.get(unitId) : undefined;
    if (!unitId || !deltaUnit) continue;
    const selectorByProducer = new Map<string, unknown>();
    if (isPlainObject(unit.workProductSelectors)) {
      for (const key of Object.keys(unit.workProductSelectors)) {
        const producer = aliasToUnitId.get(key);
        if (producer === undefined) {
          diagnostics.push(deltaInvalid(
            `단위 ${unitId} 의 결과 선택자 키 ${key} 가 알 수 없는 단계 참조입니다.`));
          continue;
        }
        if (selectorByProducer.has(producer)) {
          diagnostics.push(unitAmbiguous(
            `단위 ${unitId} 의 선택자 별칭 ${key} 이(가) 같은 생산 단위 ${producer} 로 합쳐집니다.`));
          continue;
        }
        selectorByProducer.set(producer, unit.workProductSelectors[key]);
      }
    }
    for (const requirement of deltaUnit.requiredInputs ?? []) {
      const producer = aliasToUnitId.get(requirement.fromUnitId);
      if (producer === undefined) {
        diagnostics.push(deltaInvalid(
          `단위 ${unitId} 의 필수 입력이 알 수 없는 단위 ${requirement.fromUnitId} 를 참조합니다.`));
        continue;
      }
      const actualSelector = selectorByProducer.get(producer);
      if (actualSelector === undefined) {
        diagnostics.push(deltaInvalid(
          `변경안이 선언한 필수 입력(${requirement.fromUnitId}) 이 계획 단위 ${unitId} 의 결과 선택자에서 소비되지 않습니다.`));
        continue;
      }
      // [Q12 — 값 동등성] 생산 단위 존재만으로 충분하지 않다: selector 값까지 같아야 같은 파일이다.
      if (canonicalSelectorJson(requirement.selector) !== canonicalSelectorJson(actualSelector)) {
        diagnostics.push(deltaInvalid(
          `단위 ${unitId} 의 필수 입력(${requirement.fromUnitId}) 선택자가 계획의 결과 선택자 값과 다릅니다 `
          + `(변경안 ${canonicalSelectorJson(requirement.selector)} / 계획 ${canonicalSelectorJson(actualSelector)}).`));
      }
    }
  }
  return diagnostics;
}

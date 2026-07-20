/**
 * [파일 목적] mission owner plan decision 의 selectedExecutionUnits 가 사용자 brief intent 를 충족하는지
 *   deterministic 하게 검사(plan-time QA checklist). DB/Date 없이 순수. mission-owner-plan-decisions
 *   gate(materialization 직전) 가 호출. LLM critique 는 hook 자리만 두고 MVP에선 no-op(full 확장점).
 * [설계 원칙]
 *   - enforcement 는 이 module, discovery 는 mission-owner-planning-context, runtime recovery 는 supervision.
 *     artifact QA 를 supervision 에 넣지 않는다(reactive가 되므로).
 *   - delivery 계열 위반은 severity:"invalid"(materialization 차단). audience/scenario 위반은
 *     "needs_clarification"(MVP에선 log/attach, full 에서 Hermes Ops 가 사용자 질문으로 전환).
 *   - diagnostic 는 operator 가 이해 가능하게: code + "어떤 user intent 가 어떤 unit 을 필요로 하는지" message.
 * [외부 연결] consumer: mission-owner-plan-decisions(recordLatestAuthorizedMissionOwnerPlanDecision).
 *   입력: mission-intent(extractMissionIntent) + draft.refs.selectedExecutionUnits + successCriteria.
 * [수정시 주의]
 *   - delivery 여부는 tool/action 이름으로만 판정한다. 제목/설명 텍스트는 readback/audience/scenario 보조 신호다.
 *   - 새 checklist 규칙 추가 시 reviewPlanAgainstIntent 에 추가하고 PlanQaDiagnosticCode/테스트 확장.
 *   - critiqueHook 은 async outsider — 순수 함수가 아닌 주입점. 기본 undefined(no-op).
 */
import { intentSignalsByCategory, type MissionIntent } from "./mission-intent.js";
import {
  hasDeliveryActionRole,
  hasArtifactProducerRole,
  hasArtifactQaRole,
  reviewDeliveryToolPreflightMarkers,
  reviewArtifactWorkProductMarkers,
} from "./mission-plan-artifact-contract.js";
import { buildDependencyIndex, unitDependsOn } from "./mission-plan-unit-dependencies.js";
import { reviewManualOnboardingVerificationTopology } from "./mission-plan-manual-onboarding-contract.js";
import { extractUnitRoles, hasPostDeliveryReadbackQa, type PlanQaUnitRole } from "./mission-plan-unit-roles.js";

export { extractUnitRoles } from "./mission-plan-unit-roles.js";
export type { PlanQaUnitRole } from "./mission-plan-unit-roles.js";

export type PlanQaDiagnosticCode =
  | "missing_publish_unit"
  | "missing_publish_readback_qa"
  | "missing_manual_onboarding_verify_tool"
  | "missing_artifact_qa_before_delivery"
  | "invalid_artifact_qa_delivery_order"
  | "invalid_artifact_workproduct_marker"
  | "invalid_delivery_tool_preflight_unit"
  | "missing_audience_split"
  | "missing_scenario_taxonomy";

export type PlanQaDiagnosticSeverity = "invalid" | "needs_clarification";

export interface PlanQaDiagnostic {
  code: PlanQaDiagnosticCode;
  severity: PlanQaDiagnosticSeverity;
  message: string;
}

function successCriteriaText(successCriteria: unknown[] | undefined): string {
  if (!Array.isArray(successCriteria)) return "";
  return successCriteria
    .map((item) => (typeof item === "string" ? item : item && typeof item === "object" ? JSON.stringify(item) : String(item ?? "")))
    .join("\n");
}

function reviewArtifactQaDeliveryOrder(input: {
  intent: MissionIntent;
  selectedExecutionUnits: ReadonlyArray<Record<string, unknown>>;
}): PlanQaDiagnostic[] {
  if (!input.intent.publish) return [];

  const deliveryIndexes = input.selectedExecutionUnits
    .map((unit, index) => ({ unit, index }))
    .filter(({ unit }) => hasDeliveryActionRole(unit))
    .map(({ index }) => index);
  if (deliveryIndexes.length === 0) return [];

  const artifactProducerIndexes = input.selectedExecutionUnits
    .map((unit, index) => ({ unit, index }))
    .filter(({ unit }) => hasArtifactProducerRole(unit))
    .map(({ index }) => index);
  if (artifactProducerIndexes.length === 0) return [];

  const artifactQaIndexes = input.selectedExecutionUnits
    .map((unit, index) => ({ unit, index }))
    .filter(({ unit }) => hasArtifactQaRole(unit))
    .map(({ index }) => index);

  if (artifactQaIndexes.length === 0) {
    return [{
      code: "missing_artifact_qa_before_delivery",
      severity: "invalid",
      message: "배포할 산출물을 만드는 plan 이지만 배포 전에 산출물 자체(내용/형식/필수 조건/근거/템플릿 적용 등)를 검증하는 QA unit 이 없습니다. 산출물 작성 후, 배포 전에 [QA] 산출물 검증 unit 을 추가하세요.",
    }];
  }

  const dependencyIndex = buildDependencyIndex(input.selectedExecutionUnits);
  const ordered = deliveryIndexes.every((deliveryIndex) =>
    artifactQaIndexes.some((qaIndex) =>
      unitDependsOn(dependencyIndex, deliveryIndex, qaIndex) &&
      artifactProducerIndexes.some((producerIndex) => unitDependsOn(dependencyIndex, qaIndex, producerIndex)),
    ),
  );
  const reversed = artifactProducerIndexes.some((producerIndex) =>
    artifactQaIndexes.some((qaIndex) => unitDependsOn(dependencyIndex, producerIndex, qaIndex)));

  if (!ordered || reversed) {
    return [{
      code: "invalid_artifact_qa_delivery_order",
      severity: "invalid",
      message: "산출물 배포 workflow 의 순서가 잘못되었습니다. 조건 확인/사전 조사 → 산출물 작성 → [QA] 산출물 자체 검증 → 배포 → 배포 readback/최종 QA 순서가 되도록 dependsOn 을 수정하세요.",
    }];
  }

  return [];
}

/**
 * [목적] intent 대 checklist 규칙을 적용해 diagnostic 들을 반환. 순수.
 * [규칙]
 *   - publish intent + publish/stage/deploy/readback unit 없음 → missing_publish_unit (invalid).
 *   - publish intent + publish unit 은 있으나 readback/QA 검증 unit 없음 → missing_publish_readback_qa (invalid).
 *   - audienceSplit intent + 대상 분기 근거 unit 없음(또는 successCriteria 에도 없음) → missing_audience_split (needs_clarification).
 *   - scenario intent + 시나리오/상황별 unit 없음(successCriteria 에도 없음) → missing_scenario_taxonomy (needs_clarification).
 * [입력] intent(extractMissionIntent), selectedExecutionUnits, successCriteria(선택).
 */
export function reviewPlanAgainstIntent(input: {
  intent: MissionIntent;
  selectedExecutionUnits: ReadonlyArray<Record<string, unknown>>;
  successCriteria?: unknown[];
}): PlanQaDiagnostic[] {
  const { intent, selectedExecutionUnits, successCriteria } = input;
  const diagnostics: PlanQaDiagnostic[] = [
    ...reviewArtifactWorkProductMarkers(selectedExecutionUnits),
    ...reviewDeliveryToolPreflightMarkers(selectedExecutionUnits),
    ...reviewManualOnboardingVerificationTopology(selectedExecutionUnits),
  ];
  if (!intent.publish && !intent.audienceSplit && !intent.scenario) {
    return diagnostics;
  }

  const roles = selectedExecutionUnits.map(extractUnitRoles);
  const hasRole = (key: keyof PlanQaUnitRole): boolean => roles.some((role) => role[key]);
  const scText = successCriteriaText(successCriteria);

  if (intent.publish) {
    const publishTokens = intentSignalsByCategory(intent, "publish");
    const why = publishTokens.length > 0 ? `(사용자 표현: ${publishTokens.join(", ")})` : "(사용자 게시 의도 감지)";
    if (!hasRole("publish")) {
      diagnostics.push({
        code: "missing_publish_unit",
        severity: "invalid",
        message: `Mission brief 에 게시/배포 의도가 있지만 ${why} selectedExecutionUnits 에 publish/stage/deploy/readback 성격의 unit 이 없습니다. 최소 하나의 게시/배포 unit 을 추가하세요.`,
      });
    } else if (!hasPostDeliveryReadbackQa(selectedExecutionUnits)) {
      diagnostics.push({
        code: "missing_publish_readback_qa",
        severity: "invalid",
        message: `게시/배포 unit 은 있으나 게시물 검증(QA/readback) unit 이 없습니다 ${why}. 게시 후 산출물을 검증하는 [QA] unit 또는 readback 단계를 추가하세요.`,
      });
    }
    diagnostics.push(...reviewArtifactQaDeliveryOrder({ intent, selectedExecutionUnits }));
  }

  if (intent.audienceSplit) {
    const audiences = intent.audiences.length > 0 ? intent.audiences.join(", ") : "복수 대상";
    const audienceInSc = /대상별|분기|각각|audience|경우에?\s*따라/iu.test(scText);
    if (!hasRole("audienceSplit") && !audienceInSc) {
      diagnostics.push({
        code: "missing_audience_split",
        severity: "needs_clarification",
        message: `Brief 가 복수 대상(${audiences})을 구분하지만 selectedExecutionUnits/successCriteria 에 대상별 분기 근거가 없습니다. 각 대상별 가이드를 다루는 unit 또는 success criteria 를 추가하거나, 단일 대상으로 한정하려면 그 의도를 명시하세요.`,
      });
    }
  }

  if (intent.scenario) {
    const scenarioInSc = /시나리오|상황별|케이스|경우의?\s*수|scenario|case/iu.test(scText);
    if (!hasRole("scenario") && !scenarioInSc) {
      diagnostics.push({
        code: "missing_scenario_taxonomy",
        severity: "needs_clarification",
        message: `Brief 가 상황별/케이스별 처리를 요구하지만 시나리오 taxonomy unit 또는 success criteria 가 없습니다. 상황별 케이스를 다루는 unit 이나 success criteria 를 추가하세요.`,
      });
    }
  }

  return diagnostics;
}

/**
 * [목적] LLM critique 확장점. deterministic checklist 이후 2순회로 호출되어 체크리스트가 못 잡는
 *   뉘앙스를 보충한다. 실제 LLM 백엔드는 runtime 에 LLM client 가 없어 injectable 로 둔다(
 *   setMissionPlanQaCritiqueHook). production 은 hook 미등록 → no-op(→ warn 수준).
 * [주의] 반환 diagnostic 의 severity 를 그대로 병합한다. 단 deterministic invalid 는 critique 가
 *   완화할 수 없다(병합은 additive). 명백한 critique invalid 는 차단 허용.
 */
export type PlanQaCritiqueHook = (input: {
  intent: MissionIntent;
  selectedExecutionUnits: ReadonlyArray<Record<string, unknown>>;
  /** deterministic 1순회 결과. critique 가 중복을 피/참고할 수 있게 전달. */
  priorDiagnostics: ReadonlyArray<PlanQaDiagnostic>;
}) => Promise<PlanQaDiagnostic[]>;

let missionPlanQaCritiqueHook: PlanQaCritiqueHook | null = null;

/**
 * [목적] LLM critique hook 등록/해제. dag-engine 의 setWorkflowToolStepExecutor 패턴과 동일(module-level).
 *   테스트는 fake hook 주입, production 은 미등록(→ critique unavailable, warn).
 */
export function setMissionPlanQaCritiqueHook(hook: PlanQaCritiqueHook | null): void {
  missionPlanQaCritiqueHook = hook;
}

/** gate 가 사용할 현재 hook(미등록 시 null). */
export function getMissionPlanQaCritiqueHook(): PlanQaCritiqueHook | null {
  return missionPlanQaCritiqueHook;
}

// ---------------------------------------------------------------------------
// Hermes Ops clarification handoff contract
// ---------------------------------------------------------------------------

/** clarification 질문 하나. needs_clarification diagnostic → 사용자 질문 전환 단위. */
export interface MissionPlanClarificationQuestion {
  code: PlanQaDiagnosticCode;
  /** 질문의 근거가 된 사용자 intent 토큰(진단 맥락). */
  intentContext: string[];
  /** operator/사용자에게 보낼 질문 문장. */
  question: string;
}

/**
 * [목적] needs_clarification diagnostic 들을 Hermes Ops 가 소비할 사용자 질문 contract 로 변환(순수).
 *   gate 가 activity log(structured payload) 로 surface 하고, Hermes Ops liaison 가 이를 사용자
 *   질문(Telegram 등)으로 전환한다. 본 MVP 에선 contract + log 까지; 직접 발송은 Hermes 경로 확정 후.
 */
export function buildClarificationRequest(input: {
  diagnostics: ReadonlyArray<PlanQaDiagnostic>;
  intent: MissionIntent;
}): MissionPlanClarificationQuestion[] {
  const { intent } = input;
  const questions: MissionPlanClarificationQuestion[] = [];
  for (const diagnostic of input.diagnostics) {
    if (diagnostic.severity !== "needs_clarification") continue;
    const intentContext = intentContextForCode(diagnostic.code, intent);
    questions.push({
      code: diagnostic.code,
      intentContext,
      question: clarificationQuestionForCode(diagnostic.code, intent),
    });
  }
  return questions;
}

function intentContextForCode(code: PlanQaDiagnosticCode, intent: MissionIntent): string[] {
  if (code === "missing_audience_split") return intent.audiences;
  if (code === "missing_scenario_taxonomy") return intentSignalsByCategory(intent, "scenario");
  if (code === "missing_publish_unit" || code === "missing_publish_readback_qa") {
    return intentSignalsByCategory(intent, "publish");
  }
  return [];
}

function clarificationQuestionForCode(code: PlanQaDiagnosticCode, intent: MissionIntent): string {
  switch (code) {
    case "missing_audience_split":
      return `복수 대상(${intent.audiences.join(", ")}) 각각에 대한 가이드가 필요한가요, 아니면 단일 대상으로 한정할까요? 대상별 분기가 필요하면 각 대상을 다루는 unit/success criteria 를 추가해 주세요.`;
    case "missing_scenario_taxonomy":
      return `상황별/케이스별 처리가 필요한가요? 그렇다면 다뤄야 할 시나리오 목록이나 상황별 success criteria 를 알려 주세요.`;
    case "missing_publish_unit":
      return `산출물을 사이트에 게시/배포해야 하나요? 그렇다면 게시 대상(site/cloudflare)을 확인해 게시 unit 을 추가해 주세요.`;
    case "missing_publish_readback_qa":
      return `게시 후 산출물 검증(QA/readback)이 필요한가요? 그렇다면 검증 unit 을 추가해 주세요.`;
    default:
      return "계획에 누락된 항목이 있는지 확인해 주세요.";
  }
}

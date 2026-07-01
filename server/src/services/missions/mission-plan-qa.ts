/**
 * [파일 목적] mission owner plan decision 의 selectedExecutionUnits 가 사용자 brief intent 를 충족하는지
 *   deterministic 하게 검사(plan-time QA checklist). DB/Date 없이 순수. mission-owner-plan-decisions
 *   gate(materialization 직전) 가 호출. LLM critique 는 hook 자리만 두고 MVP에선 no-op(full 확장점).
 * [설계 원칙]
 *   - enforcement 는 이 module, discovery 는 mission-owner-planning-context, runtime recovery 는 supervision.
 *     artifact QA 를 supervision 에 넣지 않는다(reactive가 되므로).
 *   - publish 계열 위반은 severity:"invalid"(materialization 차단). audience/scenario 위반은
 *     "needs_clarification"(MVP에선 log/attach, full 에서 Hermes Ops 가 사용자 질문으로 전환).
 *   - diagnostic 는 operator 가 이해 가능하게: code + "어떤 user intent 가 어떤 unit 을 필요로 하는지" message.
 * [외부 연결] consumer: mission-owner-plan-decisions(recordLatestAuthorizedMissionOwnerPlanDecision).
 *   입력: mission-intent(extractMissionIntent) + draft.refs.selectedExecutionUnits + successCriteria.
 * [수정시 주의]
 *   - extractUnitRoles 의 키워드 테이블(UNIT_ROLE_SIGNALS) 과 mission-intent 의 SIGNALS 를 함께 유지.
 *   - 새 checklist 규칙 추가 시 reviewPlanAgainstIntent 에 추가하고 PlanQaDiagnosticCode/테스트 확장.
 *   - critiqueHook 은 async outsider — 순수 함수가 아닌 주입점. 기본 undefined(no-op).
 */
import { intentSignalsByCategory, type MissionIntent } from "./mission-intent.js";

export type PlanQaDiagnosticCode =
  | "missing_publish_unit"
  | "missing_publish_readback_qa"
  | "missing_artifact_qa_before_delivery"
  | "invalid_artifact_qa_delivery_order"
  | "missing_audience_split"
  | "missing_scenario_taxonomy";

export type PlanQaDiagnosticSeverity = "invalid" | "needs_clarification";

export interface PlanQaDiagnostic {
  code: PlanQaDiagnosticCode;
  severity: PlanQaDiagnosticSeverity;
  message: string;
}

/** 단일 실행 unit 이 어떤 역할(발행/검증/대상분기/시나리오)을 담당하는지 판정 결과. */
export interface PlanQaUnitRole {
  publish: boolean;
  readbackQa: boolean;
  audienceSplit: boolean;
  scenario: boolean;
}

/**
 * unit 의 문자열 필드(title, reason, kind, description, sourceRef.type)를 한 덩어리로 모아 역할 키워드 매칭.
 * selectedExecutionUnits entry 는 Record<string, unknown> 자유형이므로, 스키마 변형에 robust 하게
 * 등장하는 모든 문자열을 모아 검사한다.
 */
function unitText(unit: Record<string, unknown>): string {
  const parts: string[] = [];
  const pushIfString = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) parts.push(value);
  };
  pushIfString(unit.title);
  pushIfString(unit.name);
  pushIfString(unit.kind);
  pushIfString(unit.reason);
  pushIfString(unit.description);
  if (unit.sourceRef && typeof unit.sourceRef === "object") {
    const sourceRef = unit.sourceRef as Record<string, unknown>;
    pushIfString(sourceRef.type);
    pushIfString(sourceRef.kind);
  }
  pushIfString(unit.toolName);
  if (Array.isArray(unit.toolNames)) {
    for (const toolName of unit.toolNames) pushIfString(toolName);
  }
  return parts.join("\n");
}

/** unit 역할 판정용 신호. [정규식, 역할 키]. mission-intent 의 publish/scenario 토큰과 의미 정렬. */
const UNIT_ROLE_SIGNALS: ReadonlyArray<readonly [regexp: RegExp, role: keyof PlanQaUnitRole]> = [
  // publish/stage/deploy 계열 unit
  [/\bpublish(?:ed|ing)?\b|\bdeploy(?:ed|ing|ment)?\b|\bstage(?:d|ing)?\b|\bupload(?:ed|ing)?\b|\bship(?:ped|ping)?\b|\brelease(?:d)?\b|\bhost(?:ed|ing)?\b/iu, "publish"],
  [/\bhtml\b|\blanding\b|\bwebpage?\b|\bwebsite\b|cloudflare|publisher|배포|게시|업로드|출간|올리|사이트|웹사이트|호스팅/u, "publish"],
  // readback / QA 검증 unit. [QA] title prefix 도 포함.
  [/^\s*\[qa\]/iu, "readbackQa"],
  [/\bread[-\s]?back\b|\bverif(y|ied|ication)\b|\bvalid(?:ation|ate|ated)?\b|\bqa\b|\bcheck(?:ed|ing)?\b|검증|리뷰|확인\s*리포트|회독/u, "readbackQa"],
  // audience split 근거가 든 unit(대상별 분기/각 대상 언급)
  [/\baudience[s]?\b|대상별|분기|각각|경우에?\s*따라|타겟별|타깃별/u, "audienceSplit"],
  [/\bAI\b|디자이너|개발자|비개발자|초보자|기획자|마케터/u, "audienceSplit"],
  // scenario taxonomy unit
  [/\bscenario[s]?\b|\bcases?\b|상황별|케이스별|여러\s*가지\s*상황|다양한\s*상황|경우의?\s*수/u, "scenario"],
];

/** [목적] 단일 unit 의 역할 판정. [출력] 4 역할 불리언. */
export function extractUnitRoles(unit: Record<string, unknown>): PlanQaUnitRole {
  const text = unitText(unit);
  const role: PlanQaUnitRole = { publish: false, readbackQa: false, audienceSplit: false, scenario: false };
  for (const [regexp, key] of UNIT_ROLE_SIGNALS) {
    if (regexp.test(text)) role[key] = true;
  }
  return role;
}

function successCriteriaText(successCriteria: unknown[] | undefined): string {
  if (!Array.isArray(successCriteria)) return "";
  return successCriteria
    .map((item) => (typeof item === "string" ? item : item && typeof item === "object" ? JSON.stringify(item) : String(item ?? "")))
    .join("\n");
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function readUnitIdRefs(unit: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const key of ["id", "unitId", "executionUnitId", "selectedExecutionUnitId"]) {
    const value = unit[key];
    if (typeof value === "string" && value.trim().length > 0) ids.push(value.trim());
  }
  if (unit.sourceRef && typeof unit.sourceRef === "object" && !Array.isArray(unit.sourceRef)) {
    const sourceRef = unit.sourceRef as Record<string, unknown>;
    for (const key of ["id", "issueId", "stepId", "unitId"]) {
      const value = sourceRef[key];
      if (typeof value === "string" && value.trim().length > 0) ids.push(value.trim());
    }
  }
  return Array.from(new Set(ids));
}

function readUnitDependencyRefs(unit: Record<string, unknown>): string[] {
  return Array.from(new Set([
    ...readStringArray(unit.dependsOn),
    ...readStringArray(unit.dependencies),
    ...readStringArray(unit.after),
  ]));
}

function buildDependencyIndex(selectedExecutionUnits: ReadonlyArray<Record<string, unknown>>): number[][] {
  const idToIndex = new Map<string, number>();
  selectedExecutionUnits.forEach((unit, index) => {
    for (const id of readUnitIdRefs(unit)) {
      idToIndex.set(id, index);
    }
  });

  return selectedExecutionUnits.map((unit, index) => {
    const dependencyIndexes = readUnitDependencyRefs(unit)
      .map((ref) => idToIndex.get(ref))
      .filter((target): target is number => target !== undefined && target !== index);
    return Array.from(new Set(dependencyIndexes));
  });
}

function unitDependsOn(dependencyIndex: number[][], fromIndex: number, targetIndex: number): boolean {
  const visited = new Set<number>();
  const stack = [...(dependencyIndex[fromIndex] ?? [])];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === targetIndex) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    stack.push(...(dependencyIndex[current] ?? []));
  }
  return false;
}

const STRICT_PUBLISH_UNIT_RE =
  /\bmanual[-_\s]?onboarding\b|\bpublisher\b|\bcloudflare\b|\bpages\b|\bR2\b|\bpublish(?:ed|ing)?\b|\bdeploy(?:ed|ing|ment)?\b|\bupload(?:ed|ing)?\b|\bhost(?:ed|ing)?\b|게시|배포|업로드|출간|출판|올리(?!픽)|사이트\s*(?:게시|배포|업로드)|웹사이트\s*(?:게시|배포|업로드)/iu;
const ARTIFACT_PRODUCER_DIRECT_RE =
  /\breport[-_\s]?for[-_\s]?beginners\b|\bhtml[-_\s]?for[-_\s]?beginners\b|\bsynth(?:esis|esize)?\b|합성|종합/iu;
const ARTIFACT_NOUN_RE =
  /\bwork[-_\s]?product\b|\bartifact\b|\bdeliverable\b|\boutput\b|\basset\b|\btemplate\b|\breport\b|\bhtml\b|\bpdf\b|\bdeck\b|\bpptx\b|\bmarkdown\b|\bjson\b|\bcsv\b|\bdashboard\b|\bpage\b|\bfile\b|\bdocument\b|산출물|결과물|템플릿|자료|초안|원고|보고서|리포트|문서|페이지|대시보드|이미지|파일/iu;
const ARTIFACT_PRODUCTION_VERB_RE =
  /\bwrite\b|\bbuild\b|\bcreate\b|\bgenerate\b|\brender\b|\bcompile\b|\bpackage\b|\bdraft\b|\bproduce\b|작성|생성|제작|빌드|렌더|초안|만들|꾸리/iu;
const QA_UNIT_RE =
  /^\s*\[qa\]/iu;
const QA_TEXT_RE =
  /\bqa\b|\bverif(?:y|ied|ication)\b|\bvalid(?:ate|ated|ation)\b|\breview\b|검증|리뷰|확인/u;
const ARTIFACT_QA_TEXT_RE =
  /\bqa\b|\bverif(?:y|ied|ication)\b|\bvalid(?:ate|ated|ation)\b|\breview\b|\baudit\b|\bquality\b|검증|리뷰|검수|품질/u;
const ARTIFACT_QA_RE =
  /\bwork[-_\s]?product\b|\bartifact\b|\bdeliverable\b|\boutput\b|\basset\b|\btemplate\b|\bclaim\b|\bevidence\b|\bsource\b|\bcitation\b|\brubric\b|\bsuccess\s*criteria\b|\bacceptance\b|\bquality\b|\bcoverage\b|\bcontent\b|\bformat\b|\bfile\b|\bpreview\b|\brender\b|산출물|결과물|템플릿|자료|본문|내용|주장|근거|출처|품질|성공기준|수용기준|커버리지|형식|파일|미리보기|렌더|동작|검수/iu;

function hasStrictPublishRole(unit: Record<string, unknown>): boolean {
  return STRICT_PUBLISH_UNIT_RE.test(unitText(unit));
}

function hasArtifactProducerRole(unit: Record<string, unknown>): boolean {
  const text = unitText(unit);
  const producesArtifact =
    ARTIFACT_PRODUCER_DIRECT_RE.test(text) ||
    (ARTIFACT_NOUN_RE.test(text) && ARTIFACT_PRODUCTION_VERB_RE.test(text));
  return producesArtifact && !QA_UNIT_RE.test(text) && !QA_TEXT_RE.test(text) && !hasStrictPublishRole(unit);
}

function hasArtifactQaRole(unit: Record<string, unknown>): boolean {
  const text = unitText(unit);
  return (QA_UNIT_RE.test(text) || ARTIFACT_QA_TEXT_RE.test(text)) && ARTIFACT_QA_RE.test(text);
}

function reviewArtifactQaDeliveryOrder(input: {
  intent: MissionIntent;
  selectedExecutionUnits: ReadonlyArray<Record<string, unknown>>;
}): PlanQaDiagnostic[] {
  if (!input.intent.publish) return [];

  const publishIndexes = input.selectedExecutionUnits
    .map((unit, index) => ({ unit, index }))
    .filter(({ unit }) => hasStrictPublishRole(unit))
    .map(({ index }) => index);
  if (publishIndexes.length === 0) return [];

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
  const ordered = publishIndexes.every((publishIndex) =>
    artifactQaIndexes.some((qaIndex) =>
      unitDependsOn(dependencyIndex, publishIndex, qaIndex) &&
      artifactProducerIndexes.some((producerIndex) => unitDependsOn(dependencyIndex, qaIndex, producerIndex)),
    ),
  );
  const reversed = artifactQaIndexes.some((qaIndex) =>
    publishIndexes.some((publishIndex) => unitDependsOn(dependencyIndex, qaIndex, publishIndex))) ||
    artifactProducerIndexes.some((producerIndex) =>
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
  if (!intent.publish && !intent.audienceSplit && !intent.scenario) {
    return []; // intent 없는 legacy/순수 research mission → 회귀 없이 pass
  }

  const diagnostics: PlanQaDiagnostic[] = [];
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
    } else if (!hasRole("readbackQa")) {
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

/**
 * [파일 목적] mission owner plan decision 의 selectedExecutionUnits 가 사용자 brief intent 를 충족하는지
 *   deterministic 하게 검사(plan-time QA checklist). DB/Date 없이 순수. mission-owner-plan-decisions
 *   gate(materialization 직전) 가 호출. LLM critique 는 hook 자리만 두고 MVP에선 no-op(full 확장점).
 * [설계 원칙]
 *   - enforcement 는 이 module, discovery 는 mission-owner-planning-context, runtime recovery 는 supervision.
 *     content QA 를 supervision 에 넣지 않는다(reactive가 되므로).
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
 * [목적] LLM critique 확장점(full). MVP에선 호출하지 않거나 no-op hook 주입.
 *   full 구현에서는 plan gap 의 뉘앙스(체크리스트가 못 잡는 것)를 LLM 2순회로 보충한다.
 *   호출자는 async hook 을 주입하고, 반환 diagnostic 를 reviewPlanAgainstIntent 결과에 병합한다.
 */
export type PlanQaCritiqueHook = (input: {
  intent: MissionIntent;
  selectedExecutionUnits: ReadonlyArray<Record<string, unknown>>;
}) => Promise<PlanQaDiagnostic[]>;

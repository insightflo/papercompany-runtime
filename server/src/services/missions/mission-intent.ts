/**
 * [파일 목적] mission brief(title + description)에서 실행 계획에 영향을 주는 *intent taxonomy* 를
 *   순수 함수로 추출한다. DB/Date/부작용 없음. mission-plan-qa(checklist) 와 planning-context
 *   (capability manifest 주입) 가 공유 소비.
 * [주요 흐름] extractMissionIntent(title, description) → { publish, audienceSplit, scenario, audiences, matchedSignals }.
 * [외부 연결] consumer: mission-plan-qa.ts(checklist 판정 입력), mission-owner-planning-context.ts
 *   (intent-scoped capability discovery — full 확장점).
 * [수정시 주의]
 *   - signal table(SIGNALS) 을 상단에 두었다. full 구현에서 tools/site resources/company skills 전반의
 *     intent-scoped top-K discovery 로 확장할 때 이 테이블과 extractUnitRoles(mission-plan-qa) 의 키워드를
 *     함께 늘리면 된다.
 *   - 한국어 활용어(올리→올려/올리도록/올리는) 처리를 위해 어간 매칭을 쓴다. 오탐 가능성(예: 올림픽)이
 *     있으나 mission brief 범위에선 허용치로 둔다 — full 에서 정밀화.
 *   - 본 모듈은 판정만 내린다. "무엇을 할지"(diagnostic/clarification 발생)는 mission-plan-qa/gate 결정.
 */

/** intent 신호 카테고리. diagnostic code 와 1:1 대응은 아님(조합으로 진단). */
export type MissionIntentCategory = "publish" | "audience" | "scenario";

/** 추출된 intent 토큰 하나. diagnostic 메시지가 "어떤 사용자 표현 때문에" 근거를 보여주게 한다. */
export interface MissionIntentSignal {
  category: MissionIntentCategory;
  /** audience 카테고리에선 audience label(AI/웹 디자이너/...). 그 외엔 매치된 표현 텍스트. */
  token: string;
}

export interface MissionIntent {
  /** 사이트/게시/배포 의도(HTML, landing, site, 올려, 게시, 배포...). */
  publish: boolean;
  /** 복수의 구분된 대상 독자(recipient)가 감지됨(→ 대상별 분기/유닛 필요). */
  audienceSplit: boolean;
  /** 상황별/케이스별 시나리오 의도(→ 시나리오 taxonomy/success criteria 필요). */
  scenario: boolean;
  /** 감지된 recipient label 들(예: ["AI", "웹 디자이너"]). audienceSplit 판정 근거.
   *  beneficiary(수혜자/주어)는 제외 — 산출물을 소비하는 대상만 split 대상. */
  audiences: string[];
  /** 감지된 beneficiary/user label 들(예: ["비전문가"]). 주어/수혜자로, audienceSplit 에서 제외.
   *  diagnostic 맥락 표시용. "를 위한/에게" 수식어가 없으면 recipient 로 취급하지 않는다. */
  beneficiary: string[];
  /** 매치된 모든 신호(진단 근거 표시용). */
  matchedSignals: MissionIntentSignal[];
}

/**
 * intent 신호 테이블. 순서 무관. 각 엔트리는 [정규식 소스, 표현 라벨].
 * - publish: 사이트/게시/배포 의도. '올리' 어간으로 올려/올리도록/올리는 흡수.
 * - scenario: 상황/케이스 다수 처리 의도.
 */
const PUBLISH_SIGNALS: ReadonlyArray<readonly [regexp: RegExp, label: string]> = [
  [/\bsite\b/iu, "site"],
  [/사이트|웹사이트|홈페이지|웹\s*페이지/u, "사이트"],
  [/\bpublish(?:ed|ing)?\b/iu, "publish"],
  [/\bdeploy(?:ed|ing|ment)?\b/iu, "deploy"],
  [/\bupload(?:ed|ing)?\b/iu, "upload"],
  [/\bhost(?:ed|ing)?\b/iu, "host"],
  [/게시|배포|업로드|출간|출판/u, "게시/배포"],
  [/올리(?!픽)/u, "올리(게시)"], // 올려/올리도록/올리는/올릴. (?!픽) 로 올림픽 오탐 회피
  [/\bhtml\b/iu, "HTML"],
  [/\blanding\b/iu, "landing"],
];

const SCENARIO_SIGNALS: ReadonlyArray<readonly [regexp: RegExp, label: string]> = [
  [/여러\s*가지\s*상황|여러\s*상황|다양한\s*상황|상황별|케이스별|경우의?\s*수|상황에?\s*따라|시나리오/u, "상황별/케이스"],
  [/\bscenarios?\b/iu, "scenario"],
  [/\bcases?\b/iu, "case"],
];

/**
 * recipient(산출물을 소비하는 대상) label 테이블. practitioner + client.
 * 이 라벨들만 audienceSplit 판정에 들어간다. 동의어는 같은 label 로 정규화.
 * (예: "AI 또는 웹 디자이너에게 전달" → recipient = {AI, 웹 디자이너})
 */
const AUDIENCE_RECIPIENT_SIGNALS: ReadonlyArray<readonly [regexp: RegExp, label: string]> = [
  [/\bAI\b|에이전트|인공지능|AI\s*에이전트/u, "AI"],
  [/웹\s*디자이너|웹디자이너/u, "웹 디자이너"],
  [/(?<!웹\s)(?<!웹)디자이너/u, "디자이너"],
  [/개발자|\bdeveloper[s]?\b|\bengineer[s]?\b|프로그래머/u, "개발자"],
  [/기획자|\bPM\b|프로덕트\s*매니저/u, "기획자"],
  [/작가|라이터|\bwriter[s]?\b|에디터|편집자/u, "작가/에디터"],
  [/마케터|\bmarketer[s]?\b/u, "마케터"],
  [/클라이언트|고객|\bclient[s]?\b/u, "클라이언트/고객"],
];

/**
 * subject/beneficiary(수혜자/사용자) label 테이블. brief 의 주어(예: "디자인 경험 없는 사람이 ...").
 * recipient 가 아니므로 audienceSplit 에서 제외한다. 단 "를 위한/에게" 수식어가 붙으면 recipient 로
 * 승격할 수 있으나(full 정밀화), P1에선 beneficiary 로만 분류해 맥락을 제공한다.
 */
const AUDIENCE_SUBJECT_SIGNALS: ReadonlyArray<readonly [regexp: RegExp, label: string]> = [
  [/비개발자|일반인|초보자|디자인\s*경험\s*없는|코딩\s*못하는|비전문가| 입문자/u, "비전문가/초보자"],
];

function collectSignals(
  text: string,
  table: ReadonlyArray<readonly [RegExp, string]>,
  category: MissionIntentCategory,
  sink: MissionIntentSignal[],
): void {
  for (const [regexp, label] of table) {
    if (regexp.test(text)) {
      sink.push({ category, token: label });
    }
  }
}

/**
 * [목적] brief 에서 intent taxonomy 추출.
 * [입력] title, description(선택). 둘을 공백으로 이어 매칭.
 * [출력] MissionIntent. 빈 brief면 모두 false.
 */
export function extractMissionIntent(title: string, description?: string | null): MissionIntent {
  const text = `${title ?? ""}\n${description ?? ""}`;
  const matchedSignals: MissionIntentSignal[] = [];

  collectSignals(text, PUBLISH_SIGNALS, "publish", matchedSignals);
  collectSignals(text, SCENARIO_SIGNALS, "scenario", matchedSignals);

  // recipient(산출물 소비 대상)만 split 판정에 사용. beneficiary(주어/수혜자)는 제외.
  const recipientSet = new Set<string>();
  for (const [regexp, label] of AUDIENCE_RECIPIENT_SIGNALS) {
    if (regexp.test(text)) recipientSet.add(label);
  }
  const beneficiarySet = new Set<string>();
  for (const [regexp, label] of AUDIENCE_SUBJECT_SIGNALS) {
    if (regexp.test(text)) beneficiarySet.add(label);
  }
  const audiences = Array.from(recipientSet);
  const beneficiary = Array.from(beneficiarySet);
  if (audiences.length >= 2) {
    for (const label of audiences) matchedSignals.push({ category: "audience", token: label });
  }

  return {
    publish: matchedSignals.some((signal) => signal.category === "publish"),
    audienceSplit: audiences.length >= 2,
    scenario: matchedSignals.some((signal) => signal.category === "scenario"),
    audiences,
    beneficiary,
    matchedSignals,
  };
}

/** 진단 메시지에 근거 표현을 넣기 위한 헬퍼. category 별 매치된 토큰을 중복 제거해 반환. */
export function intentSignalsByCategory(
  intent: MissionIntent,
  category: MissionIntentCategory,
): string[] {
  return Array.from(new Set(
    intent.matchedSignals.filter((signal) => signal.category === category).map((signal) => signal.token),
  ));
}

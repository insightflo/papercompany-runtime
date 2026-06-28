// mission goal 에서 품질 수식어(초보자/심층/실행가능/report)를 역추적해 Mission Quality Contract 를 도출.
// PLAN-QA description + qa-rubric 주입용. 판정은 LLM QA 가 rubric 로(본 helper 는 판정 안 함).
// goal 모호 → hardStopRules 비움(과차단 방지). reviewPlanAgainstIntent deterministic invalid 추가 금지.

export type MissionQualitySignals = {
  beginnerFacing: boolean;
  actionableReport: boolean;
  deepResearch: boolean;
  publishHtml: boolean;
};

export type MissionQualityContract = {
  purpose: string;
  targetUser: string;
  useCase: string;
  mustDeliver: string[];
  failureCriteria: string[];
  evaluationAxes: string[];
  hardStopRules: string[];
  signals: MissionQualitySignals;
  /** goal 이 모호해 contract 가 빈약하면 true + clarify note */
  underspecified: boolean;
  clarifyNote: string | null;
};

const BEGINNER_RE = /초보자|비전문가|입문|beginner|for-beginners?|report-for-beginners/iu;
const ACTIONABLE_RE = /판단 가능|결정|다음 행동|실행|가이드|manual|onboarding/iu;
const DEEP_RESEARCH_RE = /심층|상세|대충 조사 하지 말|충분히 많은 자료|출처|근거|반론|회의|deep|in-depth/iu;
const PUBLISH_HTML_RE = /publish|게시|html|온보딩|manual-onboarding/iu;

// mission goal/title/description → MissionQualityContract. 모호 goal → underspecified, hardStopRules 비움.
export function extractMissionQualityContract(input: {
  missionGoal: string;
  missionTitle?: string | null;
  missionDescription?: string | null;
}): MissionQualityContract {
  const goal = (input.missionGoal ?? "").trim();
  const text = `${goal} ${input.missionTitle ?? ""} ${input.missionDescription ?? ""}`.trim();
  const signals: MissionQualitySignals = {
    beginnerFacing: BEGINNER_RE.test(text),
    actionableReport: ACTIONABLE_RE.test(text),
    deepResearch: DEEP_RESEARCH_RE.test(text),
    publishHtml: PUBLISH_HTML_RE.test(text),
  };
  const anySignal =
    signals.beginnerFacing || signals.actionableReport || signals.deepResearch || signals.publishHtml;

  const evaluationAxes = [
    "purposeFitness",
    "userProblemSolving",
    "contextFit",
    "executability",
    "formatProcessQuality",
  ];
  const mustDeliver: string[] = [];
  const failureCriteria: string[] = [];
  const hardStopRules: string[] = [];

  if (signals.beginnerFacing || signals.actionableReport) {
    mustDeliver.push(
      "A deliverable a non-expert can understand and act on (what / why / how / example / misconception / judgment criterion).",
    );
    failureCriteria.push(
      "Well-structured but a non-expert still cannot understand it or judge what to do next.",
    );
  }
  if (signals.deepResearch) {
    mustDeliver.push("Sufficient source breadth and depth, with contradictions and skepticism addressed.");
    failureCriteria.push("Surface-level research: few sources, contradictions unexamined, or claims unsupported.");
  }

  // hardStopRules 은 CLEAR 신호 있을 때만(과차단 방지). 이 규칙은 description/rubric 의 LLM 지시로
  // 주입되며, reviewPlanAgainstIntent 의 deterministic invalid 와 무관하다.
  if (signals.beginnerFacing) {
    hardStopRules.push(
      "Beginner/report-for-beginners artifact but the plan/successCriteria/QA unit has NO beginner-comprehension criterion (what/why/how/example/misconception/judgment) — REQUEST_CHANGES.",
    );
  }
  if (signals.deepResearch) {
    hardStopRules.push(
      "Deep-research artifact but no source-breadth/depth/contradiction/skeptic criterion — REQUEST_CHANGES.",
    );
  }

  const underspecified = !anySignal;
  const clarifyNote = underspecified
    ? "Quality requirements are underspecified in the mission goal. The owner should clarify the target audience, depth, and what 'done well' means before this contract can fully judge purpose-fitness."
    : null;

  return {
    purpose: goal || (input.missionTitle ?? "").trim() || "(unspecified mission purpose)",
    targetUser: signals.beginnerFacing ? "non-expert / beginner" : "(unspecified audience)",
    useCase: signals.actionableReport ? "decide and act on the deliverable" : "(unspecified use case)",
    mustDeliver,
    failureCriteria,
    evaluationAxes,
    hardStopRules,
    signals,
    underspecified,
    clarifyNote,
  };
}

// [목적] contract 를 description/rubric 삽입용 텍스트 라인들로 렌더.
export function renderMissionQualityContractSection(contract: MissionQualityContract): string[] {
  const lines: string[] = ["## Mission quality contract", ""];
  lines.push(`- purpose: ${contract.purpose}`);
  lines.push(`- target user: ${contract.targetUser}`);
  lines.push(`- use case: ${contract.useCase}`);
  if (contract.mustDeliver.length > 0) {
    lines.push("- must deliver:");
    for (const item of contract.mustDeliver) lines.push(`  - ${item}`);
  }
  if (contract.failureCriteria.length > 0) {
    lines.push("- failure criteria:");
    for (const item of contract.failureCriteria) lines.push(`  - ${item}`);
  }
  lines.push(`- evaluation axes: ${contract.evaluationAxes.join(", ")}`);
  if (contract.clarifyNote) lines.push(`- note: ${contract.clarifyNote}`);
  if (contract.hardStopRules.length > 0) {
    lines.push("- hard-stop rules (judge against this; REQUEST_CHANGES if clearly violated):");
    for (const item of contract.hardStopRules) lines.push(`  - ${item}`);
  }
  lines.push("");
  return lines;
}

// [목적] QA rubric 용 고정 문구 + 5축 점수 라인. writeQaRubricMarkdown/buildPlanQaReviewDescription 공용.
export const MISSION_QUALITY_PURPOSE_FITNESS_SENTENCE =
  "This QA is purpose-fitness first. Do not pass a deliverable merely because it is well-structured, published, or source-backed if it does not solve the original mission goal.";

export function renderMissionQualityScoringLines(): string[] {
  return [
    "## 5-axis scoring (0-5)",
    "- purposeFitness, userProblemSolving, contextFit, executability, formatProcessQuality.",
    "- purposeFitness <= 3 or userProblemSolving <= 3 => REQUEST_CHANGES.",
    "",
  ];
}

export const VERIFICATION_BEFORE_COMPLETION_MARKER = "## Verification Before Completion";

export function renderVerificationBeforeCompletionGateLines(): string[] {
  return [
    VERIFICATION_BEFORE_COMPLETION_MARKER,
    "",
    "No PASS is allowed without fresh evidence gathered in this QA run.",
    "- Identify every completion claim from the mission goal, success criteria, dependency workProducts, delivery manifests, and final user-visible or machine-consumed output contract.",
    "- For each claim, name the proof surface and probe: browser/API/CLI/database/file/hash/content check, as appropriate to the declared output path.",
    "- Run the probe now. Do not rely on upstream agent reports, issue status, registered workProducts, or earlier QA comments as completion proof.",
    "- Read the full result: exit code, HTTP status, response body/HTML marker, database row, file metadata, object key, hash, or other objective output.",
    "- Verify the evidence supports the exact claim. Mark partial, stale, ambiguous, missing, or adjacent-surface evidence as notVerified.",
    "- If the proof surface is missing or ambiguous, REQUEST_CHANGES and state which claim cannot be verified. Do not infer a provider or substitute a nearby surface.",
    "- PASS only when every required claim has fresh supporting evidence. Otherwise REQUEST_CHANGES with the exact missing or failed claim.",
    "",
    "Verdict evidence shape:",
    "- verified: concrete claims with evidence and source/probe used.",
    "- notVerified: required claims that failed, were stale, or had only adjacent evidence.",
    "- unresolved: claims that could not be checked because the destination contract or access path is missing.",
    "- finalVerdict: PASS or REQUEST_CHANGES.",
    "",
  ];
}

export function buildVerificationBeforeCompletionCriteria(): string {
  return renderVerificationBeforeCompletionGateLines().join("\n").trimEnd();
}

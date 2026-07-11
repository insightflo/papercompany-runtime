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

export const EVIDENCE_CHAIN_FORMAT = "source content -> observation -> interpretation -> conclusion";

export const EVIDENCE_CHAIN_DELIVERABLE_PLANNING_LINE =
  `For written/report/manual/analysis deliverables, plan and write evidence as ${EVIDENCE_CHAIN_FORMAT}; treat storage paths, evidence repositories, and workProducts as traceability, not the proof itself.`;

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
    "intentFidelity",
    "outcomeUsefulness",
    "executionFeasibility",
    "verificationStrength",
    "integrationCompleteness",
  ];
  const mustDeliver: string[] = [];
  const failureCriteria: string[] = [];
  const hardStopRules: string[] = [];

  if (signals.beginnerFacing || signals.actionableReport) {
    mustDeliver.push(
      "A deliverable the intended audience can understand and use for the mission's stated decision or action.",
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
      "Beginner-facing artifact but the plan has no audience-appropriate comprehension or usability criterion tied to the requested outcome — REQUEST_CHANGES.",
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

export function renderAdaptiveQualityProfileLines(): string[] {
  return [
    "## Adaptive quality profile",
    "",
    "Infer the mission's work type, user context, risk, and final use from the original request. Select only the relevant quality dimensions:",
    "- Research / opportunity discovery: source authority, freshness, coverage, eligibility, deduplication, and selection rationale.",
    "- Proposal / business plan: requirement compliance, evaluator alignment, evidence, numerical consistency, feasibility, and submission readiness.",
    "- Software delivery: requirement behavior, tests, security, deployment, regression risk, and observed runtime behavior.",
    "- Operations / maintenance: reproducibility, root cause, recovery, control evidence, and service continuity.",
    "- Manual / beginner-facing guidance: audience comprehension, procedural reproducibility, examples only where useful, and result accuracy.",
    "- General business output: decision usefulness, factual accuracy, completeness, and fitness for the receiving work system.",
    "- Add or combine dimensions when the mission does not fit these examples.",
    "- Do not apply a profile merely because its terms appear in this guidance. Derive it from the mission itself.",
    "",
  ];
}

export const MISSION_QUALITY_PURPOSE_FITNESS_SENTENCE =
  "This QA is purpose-fitness first. Do not pass a deliverable merely because it is well-structured, published, or source-backed if it does not solve the original mission goal.";

export function renderMissionQualityReviewLines(): string[] {
  return [
    "## Outcome review standard",
    "- Use only the dimensions relevant to this action, its mission-specific quality profile, and its declared acceptance criteria.",
    "- Judge observable fitness for use, factual or behavioral correctness, evidence strength, integration with downstream work, and material risk.",
    "- REQUEST_CHANGES only for an observed blocking defect that prevents safe or useful use, downstream consumption, or verification.",
    "- Keep optional improvements separate from the verdict so they do not create a rework loop.",
    "",
  ];
}

export const EVIDENCE_EXPLANATION_QUALITY_MARKER = "## Evidence explanation quality";

export function renderEvidenceExplanationWritingLines(): string[] {
  return [
    EVIDENCE_EXPLANATION_QUALITY_MARKER,
    "",
    "Write evidence chains, not source-container pointers.",
    `- For each important conclusion, write: ${EVIDENCE_CHAIN_FORMAT}.`,
    "- Source content is the reader-visible material behind the claim: provider, dataset/source material, URL when available, metric/event/text excerpt, timestamp/freshness, and limitation.",
    "- If a table is useful, make its columns match that chain: source content, observation, interpretation, conclusion, confidence/gap.",
    "- Keep storage details such as `source_name`, `path_or_url`, internal filenames, manifests, and workProduct paths as private traceability, not public evidence.",
    "- If the evidence is weak, indirect, or only partially relevant, state that limitation instead of strengthening the conclusion.",
    "",
  ];
}

export function renderEvidenceExplanationQaLines(): string[] {
  return [
    EVIDENCE_EXPLANATION_QUALITY_MARKER,
    "",
    "Verify evidence chains before PASS.",
    `- Each important conclusion should show: ${EVIDENCE_CHAIN_FORMAT}.`,
    "- PASS when public prose, references, and evidence tables name the reader-visible material and connect it to the report's observation, interpretation, and conclusion.",
    "- REQUEST_CHANGES when the artifact mostly lists source containers, storage fields, internal filenames, manifests, or workProduct paths instead of that chain.",
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
    ...renderEvidenceExplanationQaLines(),
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

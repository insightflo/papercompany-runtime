/**
 * [파일 목적] Quality Board UI 순수 헬퍼. 사람이 읽는 문장/판단 안내/보고서 해석.
 *   React 의존 없이 순수 함수 → unit test 가능. pages/Quality.tsx 가 소비.
 * [외부 연결] @paperclipai/shared Quality* 타입.
 * [수정시 주의] recommendAction 은 보수적·상태파생만(LLM 없음). 과단정 금지.
 */
import type {
  QualityDailyReport,
  QualityEvaluatorAnchorCase,
  QualityReviewItemListItem,
  QualityVerdict,
} from "@paperclipai/shared";

export const UNRESOLVED_EVIDENCE_STATUSES = ["missing", "failed", "stale", "insufficient"];

export function isUnresolvedEvidence(ref: { status: string; blocking: boolean }): boolean {
  return ref.blocking || UNRESOLVED_EVIDENCE_STATUSES.includes(ref.status);
}

/** triggerMetadata.reason 추출(자동 trigger 가 왜 등록됐는지). */
export function triggerReason(meta: Record<string, unknown> | undefined): string | null {
  const r = meta?.reason;
  return typeof r === "string" && r.trim() ? r.trim() : null;
}

/** smoke/test 데이터 신호 → badge 표시(숨김 X). */
export function isSmokeSignal(input: { triggerMetadata?: Record<string, unknown>; title: string }): boolean {
  return input.triggerMetadata?.smokeTest === true || /smoke|a1-smoke|codex-a1-smoke/i.test(input.title);
}

const CLOSED_STATUSES = new Set(["resolved_pass", "resolved_fail", "dismissed", "closed", "evaluator_promoted", "evaluator_rejected"]);

export function isClosedStatus(status: string): boolean {
  return CLOSED_STATUSES.has(status);
}

export function qualityItemDisplayTitle(item: QualityReviewItemListItem): string {
  const missionTitle = cleanText(item.missionTitle);
  const isMissionQualityItem =
    item.triggerSource === "final_qa_failure" ||
    item.triggerSource === "plan_qa_failure" ||
    item.failureType === "plan_goal_mismatch";
  if (missionTitle && isMissionQualityItem) {
    const qaKind = item.triggerSource === "plan_qa_failure" ? "Plan QA" : "Final QA";
    return `${qaKind} / purpose-fitness failure - ${missionTitle}`;
  }
  return item.title;
}

/** 상태별 "지금 무엇을 판단/해야 하나" 안내. */
export function decisionPrompt(status: string): string {
  switch (status) {
    case "awaiting_review":
      return "Review and judge: pass / fail / request_changes / needs_evidence / dismissed.";
    case "detected":
      return "Newly detected — review and judge: pass / fail / request_changes / needs_evidence / dismissed.";
    case "evidence_collecting":
      return "Evidence is being collected. Record results below; the item returns here once all blocking surfaces resolve.";
    case "changes_requested":
      return "Rework requested. Confirm the correction is in, then pass (or re-request changes).";
    case "anchor_candidate":
      return "Promotable to an anchor (company precedent). Promote if this is a recurring lesson worth remembering.";
    case "evaluator_replay_queued":
      return "An evaluator candidate is replaying. Await the replay result, then promote the evaluator to production.";
    case "resolved_pass":
    case "resolved_fail":
    case "dismissed":
    case "closed":
    case "evaluator_promoted":
    case "evaluator_rejected":
      return "Closed — no action needed.";
    default:
      return "Review and decide.";
  }
}

/** REQUEST_CHANGES 신호 감지(자동 trigger 가 rework 를 요구했는지).
 * [입력] reason=triggerMetadata.reason 원문, failureType=자동 trigger 파생 실패유형.
 * [출력] true 면 추천 액션을 request_changes 로 통일(needs_evidence 억제).
 * [주의] failureType 집합은 heartbeat/loop-driver/plan-QA 의 request_changes 게이트와 1:1. 추가 시 양쪽 확인.
 */
const REQUEST_CHANGES_REASON_RE = /request[_\s-]?changes|rework|재작업|수정\s*(필요|요청|해야)|changes?\s+requested|fix\s+required/i;
const REQUEST_CHANGES_FAILURE_TYPES = new Set(["final_qa_failure", "plan_qa_failure", "delivery_verification"]);

export function indicatesRequestChanges(input: { reason: string | null; failureType: string | null }): boolean {
  return (
    (!!input.reason && REQUEST_CHANGES_REASON_RE.test(input.reason)) ||
    (input.failureType !== null && REQUEST_CHANGES_FAILURE_TYPES.has(input.failureType))
  );
}

/** why 문장을 사람 판단용으로 정리. raw reason 이 판단 근거로 충분하면(길이 적당) 그대로, 아니면 게이트 출처 fallback. */
function requestChangesWhy(item: QualityReviewItemListItem, reason: string | null): string {
  const source =
    item.failureType === "final_qa_failure" ? "Final QA" :
    item.failureType === "plan_qa_failure" ? "Plan QA" :
    item.failureType === "delivery_verification" ? "Delivery QA" :
    null;
  if (reason && reason.length <= 240) return reason;
  if (source) return `${source} already requested changes with a concrete reason; send this back for rework instead of requesting fresh evidence.`;
  return "A prior review step already requested changes; send this back for rework instead of requesting fresh evidence.";
}

/** 보수적·상태파생 추천 액션(LLM 없음). action = 강조할 verdict(없으면 null).
 * [수정시 영향] REQUEST_CHANGES 신호가 needs_evidence 보다 우선 → reason/failureType 기반 rework 권장.
 */
export type RecommendedVerdict = QualityVerdict | null;

export function recommendAction(item: QualityReviewItemListItem): { action: RecommendedVerdict; why: string; tone: "info" | "warn" } {
  if (isClosedStatus(item.status)) return { action: null, why: "No action — item is closed.", tone: "info" };
  if (item.status === "evidence_collecting") return { action: null, why: "Evidence is being collected. Keep this open until probes return.", tone: "info" };
  if (item.status === "evaluator_replay_queued") return { action: null, why: "Await evaluator replay before promoting.", tone: "info" };

  const reason = triggerReason(item.triggerMetadata);
  if (indicatesRequestChanges({ reason, failureType: item.failureType })) {
    return { action: "request_changes", why: requestChangesWhy(item, reason), tone: "warn" };
  }

  const unresolved = item.evidenceRefs.filter(isUnresolvedEvidence);
  if (unresolved.length > 0) {
    return { action: "request_changes", why: `${unresolved.length} blocking/failed evidence surface(s) — fix or re-probe, then re-review.`, tone: "warn" };
  }
  if (item.evidenceRefs.length === 0) {
    return { action: "needs_evidence", why: "No structured evidence and no rework signal — request a fresh probe before judging.", tone: "warn" };
  }
  return { action: null, why: "Evidence resolved — review the target, then pass or dismiss.", tone: "info" };
}

export type QualityDecisionFocusRow = {
  label: string;
  value: string;
  tone?: "default" | "warn" | "muted";
  mono?: boolean;
};

export type QualityDecisionFocus = {
  rows: QualityDecisionFocusRow[];
  source: "structured" | "fallback";
};

function cleanText(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function compact(value: string, max = 420): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function requestChangesSummary(reason: string | null): string | null {
  if (!reason) return null;
  const requestChanges = reason.match(/REQUEST[_\s-]?CHANGES:\s*([\s\S]+)/i)?.[1]?.trim();
  return compact(requestChanges || reason);
}

function firstIssueIdentifierFromText(text: string | null): string | null {
  return text?.match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/)?.[0] ?? null;
}

function targetStepLabel(target: NonNullable<NonNullable<QualityReviewItemListItem["qualityContext"]>["target"]>): string | null {
  const issue = [cleanText(target.identifier), cleanText(target.title)].filter(Boolean).join(" - ");
  const step = cleanText(target.stepId);
  if (issue && step) return `${issue} (${step})`;
  return issue || step;
}

/**
 * Human decision focus for Queue cards. This must answer:
 * target step, planned output, mission goal, mismatch, and recommended action.
 */
export function qualityDecisionFocus(item: QualityReviewItemListItem): QualityDecisionFocus | null {
  const ctx = item.qualityContext;
  const rows: QualityDecisionFocusRow[] = [];
  const target = ctx?.target ?? null;
  const targetLabel = target ? targetStepLabel(target) : null;
  const reason = triggerReason(item.triggerMetadata);
  const fallbackIssue = firstIssueIdentifierFromText(reason);
  const rec = recommendAction(item);

  if (targetLabel) {
    rows.push({ label: "Target step", value: targetLabel, tone: "default" });
  } else if (fallbackIssue) {
    rows.push({ label: "Target item", value: fallbackIssue, tone: "default", mono: true });
  }

  const plannedOutput = cleanText(target?.plannedOutput);
  if (plannedOutput) rows.push({ label: "Planned output", value: compact(plannedOutput), tone: "default" });

  const workProduct = [cleanText(target?.workProductTitle), cleanText(target?.workProductPath)].filter(Boolean).join(" - ");
  if (workProduct) rows.push({ label: "Work product", value: compact(workProduct, 320), tone: "muted" });

  const sourceReview = ctx?.sourceReview
    ? [cleanText(ctx.sourceReview.identifier), cleanText(ctx.sourceReview.title), cleanText(ctx.sourceReview.stepId)].filter(Boolean).join(" - ")
    : null;
  if (sourceReview) rows.push({ label: "QA gate", value: compact(sourceReview, 320), tone: "muted" });

  const missionGoal = cleanText(ctx?.missionGoal) ?? cleanText(item.missionTitle);
  if (missionGoal) rows.push({ label: "Mission goal", value: compact(missionGoal), tone: "default" });

  const mismatch = cleanText(ctx?.mismatchSummary) ?? requestChangesSummary(reason);
  if (mismatch) rows.push({ label: "Mismatch", value: mismatch, tone: "warn" });

  if (rec.action || ctx?.recommendedAction) {
    const action = ctx?.recommendedAction
      ? compact(ctx.recommendedAction)
      : `${recommendedActionLabel(rec.action)} - ${rec.why}`;
    rows.push({ label: "Recommended action", value: action, tone: rec.tone === "warn" ? "warn" : "default" });
  }

  const focusNote = cleanText(ctx?.focusNote);
  if (focusNote) rows.push({ label: "Where to inspect", value: compact(focusNote, 320), tone: "muted" });

  const shouldShowFallback =
    item.failureType === "plan_goal_mismatch" ||
    item.triggerSource === "final_qa_failure" ||
    item.triggerSource === "plan_qa_failure";
  if (rows.length === 0 || (!ctx && !shouldShowFallback)) return null;
  return { rows, source: ctx ? "structured" : "fallback" };
}

/** 추천 verdict → 사람이 읽는 라벨(Queue 강조 라벨용). */
export function recommendedActionLabel(action: RecommendedVerdict): string {
  switch (action) {
    case "request_changes": return "Request changes";
    case "needs_evidence": return "Needs evidence";
    case "pass": return "Pass";
    case "fail": return "Fail";
    case "dismissed": return "Dismiss";
    default: return "Review and judge";
  }
}

/** evidence ref 한 줄 요약(surface: status [+blocking] [+sourceUrl]). */
export function evidenceLine(ref: QualityReviewItemListItem["evidenceRefs"][number]): string {
  const parts = [`${ref.surface}: ${ref.status}`];
  if (ref.blocking) parts.push("blocking");
  if (ref.sourceUrl) parts.push(`(${ref.sourceUrl})`);
  else if (ref.sourceRunId) parts.push(`(run ${ref.sourceRunId.slice(0, 8)})`);
  return parts.join(" ");
}

/** anchor 가 evaluator version 으로 반영됐는지(versions 의 sourceAnchorCaseId 매칭). */
export function anchorReflectionStatus(anchor: QualityEvaluatorAnchorCase, versions: { sourceAnchorCaseId: string | null; status: string }[]): {
  reflected: boolean;
  versionStatus: string | null;
} {
  const v = versions.find((x) => x.sourceAnchorCaseId === anchor.id);
  return { reflected: !!v, versionStatus: v?.status ?? null };
}

/** candidate run replay 를 사람 문장으로. */
export function replaySentence(run: { status: string; resultSummary: string | null; replayResult: Record<string, unknown> }): string {
  const regressions = typeof run.replayResult?.regressions === "number" ? run.replayResult.regressions : null;
  const base = run.resultSummary?.trim();
  if (base) return base;
  if (run.status === "passed") return "Replay passed with no regressions.";
  if (run.status === "failed") return `Replay found ${regressions ?? ""} regression(s).`.trim();
  if (run.status === "running") return "Replay in progress…";
  return `Replay ${run.status}.`;
}

/** 일일 보고서 summary(JSONB) → 사람이 읽는 줄들. */
export function renderReportLines(summary: QualityDailyReport["summary"]): string[] {
  const lines: string[] = [];
  const s = summary as Record<string, unknown>;
  const pending = typeof s.pendingReviewItems === "number" ? s.pendingReviewItems : null;
  const needs = typeof s.needsEvidenceOutstanding === "number" ? s.needsEvidenceOutstanding : null;
  const gaps = typeof s.anchorCoverageGaps === "number" ? s.anchorCoverageGaps : null;
  const candidates = typeof s.improvementCandidates === "number" ? s.improvementCandidates : null;
  if (pending !== null) lines.push(`Pending review items: ${pending}.`);
  if (needs !== null) lines.push(`Needs-evidence items still outstanding: ${needs}.`);
  if (gaps !== null) lines.push(`Anchor coverage gaps: ${gaps}.`);
  if (candidates !== null) lines.push(`Evaluator improvement candidates: ${candidates}.`);
  const ftc = s.failureTypeCounts as Record<string, number> | undefined;
  if (ftc && Object.keys(ftc).length > 0) {
    lines.push("Failure types: " + Object.entries(ftc).map(([k, v]) => `${k}×${v}`).join(", ") + ".");
  }
  const ess = s.evidenceSurfaceStats as Record<string, { failed: number; missing: number; total: number }> | undefined;
  if (ess && Object.keys(ess).length > 0) {
    lines.push("Evidence surfaces: " + Object.entries(ess).map(([k, v]) => `${k} ${v.failed}failed/${v.missing}missing of ${v.total}`).join(", ") + ".");
  }
  if (lines.length === 0) lines.push("No summary fields available.");
  return lines;
}

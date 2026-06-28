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

/** 보수적·상태파생 추천 액션(LLM 없음). */
export function recommendAction(item: QualityReviewItemListItem): { action: string; tone: "info" | "warn" } {
  if (isClosedStatus(item.status)) return { action: "No action — closed.", tone: "info" };
  if (item.status === "evidence_collecting") return { action: "Awaiting evidence collection. Keep this open until probes return.", tone: "info" };
  if (item.status === "evaluator_replay_queued") return { action: "Await evaluator replay before promoting.", tone: "info" };
  const unresolved = item.evidenceRefs.filter(isUnresolvedEvidence);
  if (item.evidenceRefs.length === 0) {
    return { action: "No structured evidence — consider needs_evidence to request a fresh probe before judging.", tone: "warn" };
  }
  if (unresolved.length > 0) {
    return { action: `${unresolved.length} blocking/failed evidence surface(s) — consider fail or request_changes.`, tone: "warn" };
  }
  return { action: "Evidence resolved — review the target, then pass or dismiss.", tone: "info" };
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

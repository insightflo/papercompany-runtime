// [목적] quality-ui-helpers 순수 함수 unit test. React 의존 없음.
import { describe, expect, it } from "vitest";
import {
  anchorReflectionStatus,
  decisionPrompt,
  evidenceLine,
  isClosedStatus,
  isSmokeSignal,
  isUnresolvedEvidence,
  recommendAction,
  renderReportLines,
  replaySentence,
  triggerReason,
} from "./quality-ui-helpers";
import type { QualityReviewItemListItem } from "@paperclipai/shared";

function item(overrides: Partial<QualityReviewItemListItem> = {}): QualityReviewItemListItem {
  return {
    id: "i1",
    companyId: "c1",
    missionId: null,
    title: "t",
    status: "awaiting_review",
    targetType: "work_product",
    targetId: null,
    triggerSource: "manual",
    triggerMetadata: {},
    failureType: null,
    priority: "medium",
    createdAt: "2026-06-29T00:00:00.000Z",
    updatedAt: "2026-06-29T00:00:00.000Z",
    evidenceRefs: [],
    ...overrides,
  };
}

describe("quality-ui-helpers", () => {
  it("triggerReason extracts a trimmed reason string from triggerMetadata", () => {
    expect(triggerReason({ reason: "  QA failed readability.  " })).toBe("QA failed readability.");
    expect(triggerReason({})).toBeNull();
    expect(triggerReason(undefined)).toBeNull();
    expect(triggerReason({ reason: 123 })).toBeNull();
  });

  it("isSmokeSignal flags smokeTest metadata or title heuristics", () => {
    expect(isSmokeSignal({ title: "x", triggerMetadata: { smokeTest: true } })).toBe(true);
    expect(isSmokeSignal({ title: "codex-a1-smoke run" })).toBe(true);
    expect(isSmokeSignal({ title: "real production finding" })).toBe(false);
  });

  it("isClosedStatus covers resolved/dismissed/evaluator terminal states", () => {
    expect(isClosedStatus("resolved_pass")).toBe(true);
    expect(isClosedStatus("evaluator_promoted")).toBe(true);
    expect(isClosedStatus("awaiting_review")).toBe(false);
  });

  it("decisionPrompt gives actionable guidance per status", () => {
    expect(decisionPrompt("awaiting_review")).toMatch(/pass \/ fail/);
    expect(decisionPrompt("anchor_candidate")).toMatch(/anchor/i);
    expect(decisionPrompt("resolved_pass")).toMatch(/no action/i);
  });

  it("recommendAction warns when there is no structured evidence", () => {
    const rec = recommendAction(item({ status: "awaiting_review", evidenceRefs: [] }));
    expect(rec.tone).toBe("warn");
    expect(rec.action).toMatch(/needs_evidence/);
  });

  it("recommendAction warns on blocking/failed evidence", () => {
    const rec = recommendAction(item({ evidenceRefs: [{ id: "e1", surface: "public_url", status: "failed", blocking: true }] as never }));
    expect(rec.tone).toBe("warn");
    expect(rec.action).toMatch(/blocking/i);
  });

  it("recommendAction is informational when evidence resolves and for closed items", () => {
    expect(recommendAction(item({ status: "resolved_pass" })).action).toMatch(/no action/i);
    expect(recommendAction(item({ evidenceRefs: [{ id: "e1", surface: "public_url", status: "verified", blocking: false }] as never })).tone).toBe("info");
  });

  it("isUnresolvedEvidence treats blocking + missing/failed/stale/insufficient as unresolved", () => {
    expect(isUnresolvedEvidence({ status: "verified", blocking: false })).toBe(false);
    expect(isUnresolvedEvidence({ status: "missing", blocking: false })).toBe(true);
    expect(isUnresolvedEvidence({ status: "verified", blocking: true })).toBe(true);
  });

  it("evidenceLine surfaces status, blocking, and source url/run", () => {
    expect(evidenceLine({ surface: "public_url", status: "failed", blocking: true, sourceUrl: null, sourceRunId: null } as never)).toBe("public_url: failed blocking");
    expect(evidenceLine({ surface: "public_url", status: "verified", blocking: false, sourceUrl: "https://x.test", sourceRunId: null } as never)).toContain("https://x.test");
  });

  it("anchorReflectionStatus maps anchor to a version via sourceAnchorCaseId", () => {
    const out = anchorReflectionStatus(
      { id: "a1", sourceAnchorCaseId: null } as never,
      [{ sourceAnchorCaseId: "a1", status: "production" }],
    );
    expect(out).toEqual({ reflected: true, versionStatus: "production" });
    expect(anchorReflectionStatus({ id: "a2" } as never, [{ sourceAnchorCaseId: "a1", status: "candidate" }]).reflected).toBe(false);
  });

  it("replaySentence prefers resultSummary, falls back to status sentence", () => {
    expect(replaySentence({ status: "passed", resultSummary: "custom", replayResult: {} })).toBe("custom");
    expect(replaySentence({ status: "failed", resultSummary: null, replayResult: { regressions: 2 } })).toMatch(/2 regression/);
    expect(replaySentence({ status: "running", resultSummary: null, replayResult: {} })).toMatch(/in progress/);
  });

  it("renderReportLines renders human-readable summary lines", () => {
    const lines = renderReportLines({
      pendingReviewItems: 3,
      needsEvidenceOutstanding: 1,
      anchorCoverageGaps: 2,
      failureTypeCounts: { delivery_url_404: 2 },
      evidenceSurfaceStats: { public_url: { failed: 1, missing: 2, total: 4 } },
    });
    expect(lines.join("\n")).toContain("Pending review items: 3");
    expect(lines.join("\n")).toContain("delivery_url_404×2");
    expect(lines.join("\n")).toContain("public_url 1failed/2missing of 4");
  });

  it("renderReportLines handles empty summary", () => {
    expect(renderReportLines({})).toContain("No summary fields available.");
  });
});

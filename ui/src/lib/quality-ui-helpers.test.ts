// [목적] quality-ui-helpers 순수 함수 unit test. React 의존 없음.
import { describe, expect, it } from "vitest";
import {
  anchorReflectionStatus,
  decisionPrompt,
  evidenceLine,
  indicatesRequestChanges,
  isClosedStatus,
  isSmokeSignal,
  isUnresolvedEvidence,
  qualityDecisionFocus,
  qualityAnchorTitleDraft,
  qualityItemDisplayTitle,
  qualityVerdictCommentDraft,
  qualityVerdictCommentPlaceholder,
  recommendAction,
  recommendedActionLabel,
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
    expect(decisionPrompt("awaiting_review")).toMatch(/Pass \/ Fail/);
    expect(decisionPrompt("anchor_candidate")).toMatch(/anchor/i);
    expect(decisionPrompt("resolved_pass")).toMatch(/no action/i);
  });

  it("qualityItemDisplayTitle replaces raw mission ids with the mission name for mission quality items", () => {
    expect(qualityItemDisplayTitle(item({
      title: "Final QA / purpose-fitness failure - mission fb9d5e0c-c61a-4cf3-b153-b63aa306642c",
      triggerSource: "final_qa_failure",
      failureType: "plan_goal_mismatch",
      missionTitle: "2026-06-29 tech-scout",
    }))).toBe("Final QA / purpose-fitness failure - 2026-06-29 tech-scout");

    expect(qualityItemDisplayTitle(item({ title: "Manual review", missionTitle: "Mission A" }))).toBe("Manual review");
  });

  it("recommendAction recommends needs_evidence when no evidence and no rework signal", () => {
    const rec = recommendAction(item({ status: "awaiting_review", evidenceRefs: [] }));
    expect(rec.action).toBe("needs_evidence");
    expect(rec.tone).toBe("warn");
    expect(rec.why).toMatch(/cannot judge/i);
  });

  it("recommendAction recommends request_changes on blocking/failed evidence", () => {
    const rec = recommendAction(item({ evidenceRefs: [{ id: "e1", surface: "public_url", status: "failed", blocking: true }] as never }));
    expect(rec.action).toBe("request_changes");
    expect(rec.tone).toBe("warn");
    expect(rec.why).toMatch(/blocking/i);
  });

  it("recommendAction is informational when evidence resolves and for closed items", () => {
    const closed = recommendAction(item({ status: "resolved_pass" }));
    expect(closed.action).toBeNull();
    expect(closed.why).toMatch(/no action/i);
    const resolved = recommendAction(item({ evidenceRefs: [{ id: "e1", surface: "public_url", status: "verified", blocking: false }] as never }));
    expect(resolved.action).toBeNull();
    expect(resolved.tone).toBe("info");
  });

  it("recommendAction recommends request_changes when reason requests changes, even with no structured evidence (acceptance case)", () => {
    const rec = recommendAction(item({
      status: "awaiting_review",
      triggerMetadata: { reason: "REQUEST_CHANGES: glossary terms PoC, AppSec, ToS are missing from the report." },
      evidenceRefs: [],
    }));
    expect(rec.action).toBe("request_changes");
    expect(rec.tone).toBe("warn");
    // why must not steer toward needs_evidence
    expect(rec.why).not.toMatch(/needs_evidence/i);
    // raw concrete reason surfaces as the why
    expect(rec.why).toMatch(/PoC|glossary/i);
  });

  it("recommendAction recommends request_changes for final_qa_failure failureType without a reason", () => {
    const rec = recommendAction(item({ status: "awaiting_review", failureType: "final_qa_failure", triggerMetadata: {}, evidenceRefs: [] }));
    expect(rec.action).toBe("request_changes");
    expect(rec.why).toMatch(/Final QA/i);
  });

  it("qualityDecisionFocus explains the target step, planned output, mismatch, and action for final QA items", () => {
    const focus = qualityDecisionFocus(item({
      title: "Final QA / purpose-fitness failure - mission fb9d5e0c",
      triggerSource: "final_qa_failure",
      failureType: "plan_goal_mismatch",
      missionTitle: "2026-06-29 tech-scout",
      missionStatus: "completed",
      triggerMetadata: {
        reason: "I validated RES-614's report draft. REQUEST_CHANGES: glossary definitions for PoC, AppSec, ToS are missing.",
      },
      qualityContext: {
        missionGoal: "Create a Korean Tech Scout report that operators can judge.",
        target: {
          identifier: "RES-614",
          title: "Synthesize Tech Scout report draft",
          status: "done",
          stepId: "synthesize-tech-scout-report-draft",
          plannedOutput: "Synthesis Editor step. Write approved-source Korean Tech Scout markdown draft and save as report.md.",
          workProductTitle: "report.md",
          workProductPath: "/srv/papercompany/report.md",
        },
        mismatchSummary: "glossary definitions for PoC, AppSec, ToS are missing.",
        recommendedAction: "Request changes and route the affected producer step for rework.",
        focusNote: "The mission may already be terminal. Judge this quality finding by the target step and QA evidence, not by the mission status badge.",
      },
    }));

    expect(focus?.source).toBe("structured");
    const text = focus?.rows.map((row) => `${row.label}: ${row.value}`).join("\n") ?? "";
    expect(text).toContain("Target step: RES-614 - Synthesize Tech Scout report draft");
    expect(text).toContain("Planned output: Synthesis Editor step");
    expect(text).toContain("Mission goal: Create a Korean Tech Scout report");
    expect(text).toContain("Mismatch: glossary definitions for PoC, AppSec, ToS are missing.");
    expect(text).toContain("Recommended action: Request changes");
    expect(text).toContain("mission may already be terminal");
  });

  it("qualityDecisionFocus falls back to the request-changes reason when structured context is absent", () => {
    const focus = qualityDecisionFocus(item({
      triggerSource: "final_qa_failure",
      failureType: "plan_goal_mismatch",
      triggerMetadata: {
        reason: "I validated RES-614's report draft. REQUEST_CHANGES: glossary definitions for PoC, AppSec, ToS are missing.",
      },
    }));

    expect(focus?.source).toBe("fallback");
    const text = focus?.rows.map((row) => `${row.label}: ${row.value}`).join("\n") ?? "";
    expect(text).toContain("Target item: RES-614");
    expect(text).toContain("Mismatch: glossary definitions for PoC, AppSec, ToS are missing.");
    expect(text).toContain("Recommended action: Request changes");
  });

  it("qualityVerdictCommentDraft pre-fills a rework instruction for request_changes", () => {
    const draft = qualityVerdictCommentDraft(item({
      title: "Final QA / purpose-fitness failure - mission fb9d5e0c",
      triggerSource: "final_qa_failure",
      failureType: "plan_goal_mismatch",
      missionTitle: "2026-06-29 tech-scout",
      triggerMetadata: {
        reason: "I validated RES-614's report draft. REQUEST_CHANGES: glossary definitions for PoC, AppSec, ToS are missing.",
      },
      qualityContext: {
        missionGoal: "Create a Korean Tech Scout report that operators can judge.",
        target: {
          identifier: "RES-614",
          title: "Synthesize Tech Scout report draft",
          status: "done",
          stepId: "synthesize-tech-scout-report-draft",
          plannedOutput: "Synthesis Editor step. Write approved-source Korean Tech Scout markdown draft and save as report.md.",
          workProductTitle: "report.md",
        },
        mismatchSummary: "glossary definitions for PoC, AppSec, ToS are missing.",
        recommendedAction: "Request changes and route the affected producer step for rework.",
      },
    }), "request_changes");

    expect(draft).toContain("Request changes for RES-614 - Synthesize Tech Scout report draft");
    expect(draft).toContain("Planned output: Synthesis Editor step");
    expect(draft).toContain("Work product: report.md");
    expect(draft).toContain("Reason: glossary definitions for PoC, AppSec, ToS are missing.");
    expect(draft).toContain("Route the affected producer step for rework");
    expect(draft).toContain("No fresh evidence is needed");
  });

  it("qualityAnchorTitleDraft pre-fills an editable evaluator learning title from the verdict context", () => {
    const draft = qualityAnchorTitleDraft(item({
      title: "Final QA / purpose-fitness failure - mission fb9d5e0c",
      triggerSource: "final_qa_failure",
      failureType: "plan_goal_mismatch",
      missionTitle: "2026-06-29 tech-scout",
      triggerMetadata: {
        reason: "I validated RES-614's report draft. REQUEST_CHANGES: glossary definitions for PoC, AppSec, ToS are missing.",
      },
      qualityContext: {
        target: {
          identifier: "RES-614",
          title: "Synthesize Tech Scout report draft",
          status: "done",
          stepId: "synthesize-tech-scout-report-draft",
        },
        mismatchSummary: "glossary definitions for PoC, AppSec, ToS are missing.",
      },
    }), "request_changes");

    expect(draft).toBe("Request changes: glossary definitions for PoC, AppSec, ToS are missing.");
  });

  it("qualityVerdictCommentPlaceholder tells request_changes users to write rework, not evidence", () => {
    expect(qualityVerdictCommentPlaceholder("request_changes")).toMatch(/rework/i);
    expect(qualityVerdictCommentPlaceholder("request_changes")).toMatch(/fresh evidence/i);
    expect(qualityVerdictCommentPlaceholder("needs_evidence")).toMatch(/evidence surface/i);
    expect(qualityVerdictCommentPlaceholder("needs_evidence")).toMatch(/evidence request/i);
  });

  it("qualityVerdictCommentDraft frames needs_evidence as the evidence request flow", () => {
    const draft = qualityVerdictCommentDraft(item({
      title: "Unverified public URL",
      triggerMetadata: {
        reason: "Published report has no browser readback.",
      },
    }), "needs_evidence");

    expect(draft).toContain("Need more evidence before judging Unverified public URL.");
    expect(draft).toContain("Missing evidence:");
    expect(draft).toContain("collect the named evidence surfaces");
  });

  it("indicatesRequestChanges detects reason text and request-changes failure types", () => {
    expect(indicatesRequestChanges({ reason: "please rework the output", failureType: null })).toBe(true);
    expect(indicatesRequestChanges({ reason: "REQUEST_CHANGES issued", failureType: null })).toBe(true);
    expect(indicatesRequestChanges({ reason: null, failureType: "plan_qa_failure" })).toBe(true);
    expect(indicatesRequestChanges({ reason: null, failureType: "delivery_verification" })).toBe(true);
    expect(indicatesRequestChanges({ reason: null, failureType: "oversight_stall" })).toBe(false);
    expect(indicatesRequestChanges({ reason: "all good", failureType: null })).toBe(false);
    expect(indicatesRequestChanges({ reason: null, failureType: null })).toBe(false);
  });

  it("recommendedActionLabel maps verdicts to human-readable labels", () => {
    expect(recommendedActionLabel("request_changes")).toBe("Request changes");
    expect(recommendedActionLabel("needs_evidence")).toBe("Needs evidence");
    expect(recommendedActionLabel("pass")).toBe("Pass");
    expect(recommendedActionLabel(null)).toBe("Review and judge");
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

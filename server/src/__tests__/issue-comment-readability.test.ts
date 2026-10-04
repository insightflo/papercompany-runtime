import { describe, expect, it } from "vitest";
import { buildPaperclipRuntimeBrief } from "@paperclipai/adapter-utils";
import {
  buildRetrySourceIssueComment,
  buildRetrySourceIssueWakeupResultComment,
  buildRetrySourceIssueRequestChangesContextComment,
  extractLatestRequestChangesSummary,
} from "../services/missions/mission-owner-recovery-comments.js";

const source = { missionId: "mission-1", ownerActionIssueId: "owner-1", ownerActionLabel: "OWN-1", sourceIssueId: "source-1", sourceLabel: "SRC-1", targetAgentId: "agent-1", idempotencyKey: "key-1" };

describe("new issue comment readability", () => {
  it.each(["ko", "en"])("delivers comment guidance without changing %s machine contracts", (language) => {
    const brief = buildPaperclipRuntimeBrief({ paperclipUserFacingLanguage: language });
    expect(brief).toContain(`summaries in ${language}`);
    expect(brief).toContain("Use im-human for new human-facing issue comments and final output");
    expect(brief).toContain("follow company language");
    expect(brief).not.toContain("status → reason/impact → next action → necessary evidence");
  });

  it.each([
    ["dispatched", "The retry wakeup was requested; execution is not confirmed by this comment."],
    ["workflow_already_dispatched", "An existing workflow resume request already covers this issue; no second wakeup was requested."],
    ["not_requested", "No retry wakeup was queued. Check the queue result and validation detail before requesting recovery again."],
  ] as const)("explains %s without claiming the retry ran", (status, explanation) => {
    const comment = buildRetrySourceIssueWakeupResultComment({ ...source, status, detailReason: "raw detail" });
    expect(comment).toContain(explanation);
    for (const value of ["OWN-1", "owner-1", "SRC-1", "source-1", "key-1"]) expect(comment).toContain(value);
    if (status !== "not_requested") expect(comment).toContain("mission-owner-decision-wakeup-dispatched");
    else expect(comment).toContain("raw detail");
  });

  it.each(["dispatched", "workflow_already_dispatched", "not_requested"] as const)("renders Korean recovery result %s with unchanged markers", (status) => {
    const body = buildRetrySourceIssueWakeupResultComment({ ...source, language: "ko", status });
    expect(body).toContain("다음 행동");
    expect(body).toContain("Source issue: SRC-1 (source-1)");
    if (status !== "not_requested") expect(body).toContain("mission-owner-decision-wakeup-dispatched");
  });

  it("keeps Korean retry evidence and REQUEST_CHANGES consumer bytes", () => {
    const summary = "REQUEST_CHANGES: fix https://example.test/a?id=1";
    const comment = buildRetrySourceIssueComment({ ...source, language: "ko", decisionReason: "raw reason", requestChangesSummary: summary });
    expect(comment).toContain("재시도를 요청했습니다. 실제 실행 여부는 실행 기록에서 확인해 주세요.");
    expect(comment).toContain("Decision: retry_source_issue");
    expect(comment).toContain("Reason: raw reason");
    expect(comment).toContain("Latest REQUEST_CHANGES summary:");
    expect(extractLatestRequestChangesSummary([comment])).toBe(summary);
    const context = buildRetrySourceIssueRequestChangesContextComment({ ...source, requestChangesSummary: summary });
    expect(context).toContain("Next action: address the validation feedback below before requesting another review.");
    expect(extractLatestRequestChangesSummary([context])).toBe(summary);
  });
});

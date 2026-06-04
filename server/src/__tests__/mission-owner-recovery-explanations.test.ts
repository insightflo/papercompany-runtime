import { describe, expect, it } from "vitest";
import { buildOwnerActionExplanations, computeMissionOwnerActionExplanation } from "../services/missions/mission-owner-recovery-explanations.js";
import { buildMissionOwnerDecisionAppliedMarker } from "../services/missions/mission-owner-recovery-events.js";

describe("mission owner recovery explanations", () => {
  const sourceIssue = { id: "source-id", identifier: "SRC-1", status: "blocked" };

  it("computes decision-required explanations without source description input", () => {
    const result = computeMissionOwnerActionExplanation({
      retryApplied: false,
      latestDecision: null,
      sourceIssue,
      ownerActionOriginId: "source-id",
    });

    expect(result.status).toBe("decision_required");
    expect(result.explanation).toContain("Owner decision required for source issue SRC-1");
  });

  it("computes read-only recorded decisions and preserves source identifier labels", () => {
    const result = computeMissionOwnerActionExplanation({
      retryApplied: false,
      latestDecision: {
        decision: "retry_source_issue",
        reason: "source evidence is ready",
      },
      sourceIssue,
    });

    expect(result.status).toBe("decision_recorded_read_only");
    expect(result.explanation).toContain("Mission owner decision retry_source_issue was recorded but not applied");
    expect(result.explanation).toContain("source issue SRC-1");
  });

  it("computes applied retry explanations before any other state", () => {
    const result = computeMissionOwnerActionExplanation({
      retryApplied: true,
      latestDecision: null,
      sourceIssue,
    });

    expect(result.status).toBe("retry_applied_no_wakeup");
    expect(result.explanation).toContain("no heartbeat wakeup was created");
  });

  it("computes invalid decisions conservatively", () => {
    const result = computeMissionOwnerActionExplanation({
      retryApplied: false,
      latestDecision: {
        decision: null,
        invalidDecision: "auto_magic",
      },
      sourceIssue,
    });

    expect(result.status).toBe("not_applicable_or_invalid");
    expect(result.explanation).toContain("invalid (auto_magic)");
  });

  it("computes terminal source issues as informational only", () => {
    const result = computeMissionOwnerActionExplanation({
      retryApplied: false,
      latestDecision: {
        decision: "retry_source_issue",
      },
      sourceIssue: { ...sourceIssue, status: "done" },
    });

    expect(result.status).toBe("not_applicable_or_invalid");
    expect(result.explanation).toContain("Source issue SRC-1 is terminal");
  });

  it("computes missing source issues using origin id or unknown-source fallback", () => {
    const withOrigin = computeMissionOwnerActionExplanation({
      retryApplied: false,
      latestDecision: null,
      sourceIssue: null,
      ownerActionOriginId: "missing-source-id",
    });
    const withoutOrigin = computeMissionOwnerActionExplanation({
      retryApplied: false,
      latestDecision: null,
      sourceIssue: null,
    });

    expect(withOrigin.status).toBe("not_applicable_or_invalid");
    expect(withOrigin.explanation).toContain("Source issue missing-source-id is unavailable");
    expect(withoutOrigin.explanation).toContain("Source issue unknown source is unavailable");
  });

  it("builds owner-action explanations from injected issue/comment resolvers", async () => {
    const result = await buildOwnerActionExplanations({
      ownerActionIssues: [{
        id: "owner-action-id",
        identifier: "OWN-1",
        title: "Owner unblock",
        status: "done",
        originKind: "mission_main_executor_unblock",
        originId: "source-id",
      }],
      commentsByIssueId: new Map([
        ["owner-action-id", [[
          "### Mission owner decision",
          "Decision: retry_source_issue",
          "Source issue: SRC-1",
          "Reason: retry after correction",
        ].join("\n")]],
      ]),
      resolveSourceIssue: async () => ({
        id: "source-id",
        identifier: "SRC-1",
        title: "Source issue",
        status: "todo",
        assigneeAgentId: "agent-id",
      }),
      resolveSourceComments: async () => [buildMissionOwnerDecisionAppliedMarker({
        ownerActionIssueId: "owner-action-id",
        sourceIssueId: "source-id",
        decision: "retry_source_issue",
      })],
    });

    expect(result).toEqual([
      expect.objectContaining({
        ownerActionIssue: expect.objectContaining({ id: "owner-action-id" }),
        sourceIssue: expect.objectContaining({ id: "source-id", assigneeAgentId: "agent-id" }),
        latestDecision: expect.objectContaining({ decision: "retry_source_issue" }),
        retryApplied: true,
        status: "retry_applied_no_wakeup",
        explanation: expect.stringContaining("no heartbeat wakeup was created"),
      }),
    ]);
  });
});

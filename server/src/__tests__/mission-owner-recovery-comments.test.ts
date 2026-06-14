import { describe, expect, it } from "vitest";
import {
  buildMissionOwnerUnblockDescription,
  buildRetrySourceIssueComment,
  buildRetrySourceIssueWakeupDispatchedComment,
  buildStaleSourceIssueWakeupDispatchedComment,
  buildValidatorRetryEvidenceComment,
  extractLatestMissionOwnerDecision,
  isTerminalIssueStatus,
  summarizeOwnerDecisionNotApplied,
} from "../services/missions/mission-owner-recovery-comments.js";

describe("mission owner recovery comments", () => {
  it("extracts latest decision and formats owner action comments with markers", () => {
    const latest = extractLatestMissionOwnerDecision([
      "### Mission owner decision\nDecision: request_input\nSource issue: SRC-1\nReason: earlier",
      "### Mission owner decision\nDecision: retry_source_issue\nSource issue: SRC-2\nReason: latest",
    ]);

    expect(latest).toEqual(expect.objectContaining({
      decision: "retry_source_issue",
      sourceIssueRef: "SRC-2",
      reason: "latest",
    }));

    const retryComment = buildRetrySourceIssueComment({
      ownerActionIssueId: "owner-1",
      ownerActionLabel: "OWN-1",
      sourceIssueId: "source-1",
      sourceLabel: "SRC-1",
      decisionReason: "owner approved retry",
    });
    expect(retryComment).toContain("mission-owner-decision-applied");
    expect(retryComment).toContain("Decision: retry_source_issue");
    expect(retryComment).toContain("owner approved retry");
  });

  it("formats wakeup and validator recovery comments", () => {
    const wakeup = buildRetrySourceIssueWakeupDispatchedComment({
      missionId: "mission-1",
      ownerActionIssueId: "owner-1",
      ownerActionLabel: "OWN-1",
      sourceIssueId: "source-1",
      sourceLabel: "SRC-1",
      targetAgentId: "agent-1",
      idempotencyKey: "key-1",
    });
    expect(wakeup).toContain("mission-owner-decision-wakeup-dispatched");
    expect(wakeup).toContain("Target agent: agent-1");
    expect(wakeup).toContain("Idempotency key: key-1");

    const staleWakeup = buildStaleSourceIssueWakeupDispatchedComment({
      missionId: "mission-1",
      sourceIssueId: "source-1",
      sourceLabel: "SRC-1",
      failedRunId: "run-1",
      failedRunStatus: "timed_out",
      targetAgentId: "agent-1",
      idempotencyKey: "stale-key-1",
    });
    expect(staleWakeup).toContain("mission-stale-source-wakeup-dispatched");
    expect(staleWakeup).toContain("Terminal heartbeat run: run-1 status=timed_out");

    const validatorEvidence = buildValidatorRetryEvidenceComment({
      sourceLabel: "SRC-1",
      childLabel: "CHILD-1",
      evidenceLines: ["artifact repaired", "tests passed"],
    });
    expect(validatorEvidence).toContain("### Validator retry evidence");
    expect(validatorEvidence).toContain("- artifact repaired");
    expect(validatorEvidence).toContain("- tests passed");
  });

  it("formats unblock descriptions and conservative status summaries", () => {
    const description = buildMissionOwnerUnblockDescription(
      { id: "mission-1", title: "Mission" },
      {
        id: "source-1",
        identifier: "SRC-1",
        title: "Blocked source",
        status: "blocked",
        assigneeAgentId: "worker-1",
      },
      {
        governanceEvidence: ["  blocker evidence  ", ""],
        missionExecutionDigest: [
          "Mission description: Daily research workflow",
          "Workflow run: tech-ai-news status=failed",
          "Remaining workflow steps: validate-ai-news-artifact:failed, send-telegram:skipped",
        ],
      },
    );

    expect(description).toContain("mission-owner-action");
    expect(description).toContain("Original assignee agent: worker-1");
    expect(description).toContain("Mission execution digest:");
    expect(description).toContain("- Mission description: Daily research workflow");
    expect(description).toContain("- Workflow run: tech-ai-news status=failed");
    expect(description).toContain("- Remaining workflow steps: validate-ai-news-artifact:failed, send-telegram:skipped");
    expect(description).toContain("Allowed decision options:");
    expect(description).toContain("- retry_source_issue");
    expect(description).toContain("- blocker evidence");

    expect(isTerminalIssueStatus("done")).toBe(true);
    expect(isTerminalIssueStatus("cancelled")).toBe(true);
    expect(isTerminalIssueStatus("blocked")).toBe(false);
    expect(summarizeOwnerDecisionNotApplied({
      ownerActionLabel: "OWN-1",
      sourceLabel: "SRC-1",
      reason: "source already terminal",
    })).toBe("owner_action_decision_not_applied: OWN-1 retry_source_issue source=SRC-1 — source already terminal");
  });
});

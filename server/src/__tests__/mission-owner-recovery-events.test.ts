import { describe, expect, it } from "vitest";
import {
  buildMissionOwnerActionMarker,
  buildMissionOwnerDecisionAppliedMarker,
  buildMissionOwnerDecisionWakeupIdempotencyKey,
  buildMissionOwnerDecisionWakeupDispatchedMarker,
  buildStaleSourceIssueWakeupDispatchedMarker,
  extractMissionOwnerDecisionFromText,
  hasMissionOwnerDecisionAppliedMarker,
  hasMissionOwnerDecisionWakeupDispatchedMarker,
  hasStaleSourceIssueWakeupDispatchedMarker,
  parseMissionOwnerActionMarker,
} from "../services/missions/mission-owner-recovery-events.js";

describe("mission owner recovery events", () => {
  it("parses mission owner action markers without depending on heartbeat internals", () => {
    const marker = buildMissionOwnerActionMarker({
      missionId: "mission-1",
      sourceIssueId: "issue-1",
      actionType: "unblock",
      status: "decision_required",
    });

    expect(parseMissionOwnerActionMarker(`before\n${marker}\nafter`)).toEqual({
      missionId: "mission-1",
      sourceIssueId: "issue-1",
      actionType: "unblock",
      status: "decision_required",
    });
    expect(parseMissionOwnerActionMarker("<!-- mission-owner-action:{bad json} -->")).toBeNull();
  });

  it("keeps owner decision parsing and idempotency marker checks centralized", () => {
    expect(extractMissionOwnerDecisionFromText([
      "### Mission owner decision",
      "Decision: retry_source_issue",
      "Source issue: PAP-12",
      "Reason: transient failure cleared",
      "Next action: retry current assignee",
      "Evidence: operator comment",
    ].join("\n"))).toEqual({
      decision: "retry_source_issue",
      sourceIssueRef: "PAP-12",
      reason: "transient failure cleared",
      nextAction: "retry current assignee",
      evidence: "operator comment",
    });

    const applied = buildMissionOwnerDecisionAppliedMarker({
      ownerActionIssueId: "owner-1",
      sourceIssueId: "source-1",
      decision: "retry_source_issue",
    });
    expect(hasMissionOwnerDecisionAppliedMarker([applied], {
      ownerActionIssueId: "owner-1",
      sourceIssueId: "source-1",
      decision: "retry_source_issue",
    })).toBe(true);

    const idempotencyKey = buildMissionOwnerDecisionWakeupIdempotencyKey({
      missionId: "mission-1",
      ownerActionIssueId: "owner-1",
      sourceIssueId: "source-1",
    });
    const wakeup = buildMissionOwnerDecisionWakeupDispatchedMarker({
      missionId: "mission-1",
      ownerActionIssueId: "owner-1",
      sourceIssueId: "source-1",
      decision: "retry_source_issue",
      idempotencyKey,
    });
    expect(hasMissionOwnerDecisionWakeupDispatchedMarker([wakeup], {
      missionId: "mission-1",
      ownerActionIssueId: "owner-1",
      sourceIssueId: "source-1",
      decision: "retry_source_issue",
      idempotencyKey,
    })).toBe(true);
  });

  it("centralizes stale-source wakeup markers", () => {
    const idempotencyKey = "stale-wakeup-key";
    const stale = buildStaleSourceIssueWakeupDispatchedMarker({
      missionId: "mission-1",
      sourceIssueId: "source-1",
      failedRunId: "run-1",
      idempotencyKey,
    });
    expect(hasStaleSourceIssueWakeupDispatchedMarker([stale], {
      missionId: "mission-1",
      sourceIssueId: "source-1",
      failedRunId: "run-1",
      idempotencyKey,
    })).toBe(true);
  });
});

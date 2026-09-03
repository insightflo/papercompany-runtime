import { describe, expect, it } from "vitest";
import { buildSessionHandoffArtifact } from "../services/session-handoff-artifact.js";

describe("buildSessionHandoffArtifact", () => {
  it("builds a minimal structured handoff artifact from the same source fields as markdown", () => {
    expect(
      buildSessionHandoffArtifact({
        previousSessionId: "sess-1",
        previousRunId: "run-1",
        issueId: "issue-1",
        rotationReason: "session exceeded 1 runs",
        lastRunSummaryText: "Last run summarized the issue state",
      }),
    ).toEqual({
      version: 1,
      previousSessionId: "sess-1",
      previousRunId: "run-1",
      issueId: "issue-1",
      rotationReason: "session exceeded 1 runs",
      lastRunSummaryText: "Last run summarized the issue state",
    });
  });

  it("carries a mission decision log pointer with revision when provided", () => {
    expect(
      buildSessionHandoffArtifact({
        previousSessionId: "sess-1",
        previousRunId: "run-1",
        issueId: "issue-1",
        rotationReason: "session exceeded 1 runs",
        lastRunSummaryText: null,
        missionDecisionLogPointer: { missionId: "mission-1", revision: 7 },
      }),
    ).toEqual({
      version: 1,
      previousSessionId: "sess-1",
      previousRunId: "run-1",
      issueId: "issue-1",
      rotationReason: "session exceeded 1 runs",
      lastRunSummaryText: null,
      missionDecisionLogPointer: { missionId: "mission-1", revision: 7 },
    });
  });

  it("omits the mission decision log pointer by default for backward compatibility", () => {
    const artifact = buildSessionHandoffArtifact({
      previousSessionId: "sess-1",
      previousRunId: "run-1",
      issueId: "issue-1",
      rotationReason: "session exceeded 1 runs",
      lastRunSummaryText: null,
    });
    expect("missionDecisionLogPointer" in artifact).toBe(false);
  });
});

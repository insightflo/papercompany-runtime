import { describe, expect, it } from "vitest";
import { HANDOFF_TEXT_CAP, truncateHandoffText } from "../services/missions/handoff-text-cap.js";
import { capHandoffJsonText } from "../services/missions/mission-runtime-manager.js";

// [목적] mission_issue_handoffs 의 goal/summary 가 cap 이상으로 늘어나지 않는지 검증.
describe("truncateHandoffText", () => {
  it("returns trimmed text unchanged when under the cap", () => {
    expect(truncateHandoffText("  short goal  ")).toBe("short goal");
    expect(truncateHandoffText("short goal").length).toBeLessThanOrEqual(HANDOFF_TEXT_CAP);
  });

  it("truncates with an ellipsis when exceeding the cap", () => {
    const long = "x".repeat(HANDOFF_TEXT_CAP + 200);
    const truncated = truncateHandoffText(long);
    expect(truncated.length).toBeLessThanOrEqual(HANDOFF_TEXT_CAP);
    expect(truncated.endsWith("…")).toBe(true);
    expect(truncated.length).toBe(HANDOFF_TEXT_CAP);
  });

  it("treats null/undefined as empty string", () => {
    expect(truncateHandoffText(null)).toBe("");
    expect(truncateHandoffText(undefined)).toBe("");
  });

  it("honors a custom cap", () => {
    expect(truncateHandoffText("abcdefghij", 5)).toBe("abcd…");
  });

  it("buildMissionIssueHandoffMarkdown applies the cap to a long goal", async () => {
    const { buildMissionIssueHandoffMarkdown } = await import("../services/missions/mission-runtime-manager.js");
    const longGoal = "G".repeat(HANDOFF_TEXT_CAP + 500);
    const markdown = buildMissionIssueHandoffMarkdown({
      missionId: "m1",
      issueId: "i1",
      agentId: "a1",
      runId: "r1",
      status: "done",
      issueGoal: longGoal,
      summaryText: "S".repeat(HANDOFF_TEXT_CAP + 500),
    });
    // cap 이하로 잘리고 말줄임표로 끝난 goal/summary 라인이 존재해야 한다.
    const goalLine = markdown.split("\n").find((line) => /^G/.test(line));
    const summaryLine = markdown.split("\n").find((line) => /^S/.test(line));
    expect(goalLine?.endsWith("…")).toBe(true);
    expect(goalLine?.length).toBe(HANDOFF_TEXT_CAP);
    expect(summaryLine?.endsWith("…")).toBe(true);
    expect(summaryLine?.length).toBe(HANDOFF_TEXT_CAP);
  });
});

describe("capHandoffJsonText (run-level handoff cap)", () => {
  it("caps a long issueGoal and each actionsTaken entry like the terminal handoff does", () => {
    const longGoal = "G".repeat(HANDOFF_TEXT_CAP + 800);
    const longAction = "A".repeat(HANDOFF_TEXT_CAP + 300);
    const capped = capHandoffJsonText({
      issueGoal: longGoal,
      actionsTaken: [longAction, "short action"],
      evidence: [{ type: "heartbeat_run", id: "r1", description: "Run ended with succeeded" }],
      importantCaveats: ["verify evidence refs"],
      stateDelta: { status: "succeeded", runId: "r1" },
      recommendedNextPrompt: "continue",
    });

    expect(capped.issueGoal?.length).toBe(HANDOFF_TEXT_CAP);
    expect(capped.issueGoal?.endsWith("…")).toBe(true);
    expect(capped.actionsTaken?.[0]?.length).toBe(HANDOFF_TEXT_CAP);
    expect(capped.actionsTaken?.[0]?.endsWith("…")).toBe(true);
    expect(capped.actionsTaken?.[1]).toBe("short action");
    expect(capped.evidence?.[0]?.id).toBe("r1");
    expect(capped.stateDelta?.status).toBe("succeeded");
  });

  it("returns empty object for undefined json", () => {
    expect(capHandoffJsonText(undefined)).toEqual({});
  });
});

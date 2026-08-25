import { describe, expect, it } from "vitest";
import { formatOperatorDecisionSummary } from "../services/missions/operator-card-summary.js";

const AGENT_PAYLOAD = {
  decision: "escalate" as const,
  missionTitle: "2026-08-25 tech-ai-news daily report",
  issueIdentifier: "RES-3638",
  issueTitle: "[Unblock] RES-3637: Synthesize multi-source AI news report draft",
  issueId: "c70bc2a9-b34a-4ee5-960d-2dbc1605e01f",
  reason:
    "The accepted reassign_source_issue event 423304dd-9f5b-4c88-b4c5-7c17d67865ab did not materialize. RES-3637 remains blocked under the failed Synthesis Editor.",
  nextAction:
    "Assign RES-3637 to the idle Technology Research Agent 751281f0-c613-4e7d-a5e9-63124da338ea and dispatch its workflow wakeup.",
  evidence:
    "Fresh source heartbeat-context shows RES-3637 status=blocked and assignee=8d57b1e0-d086-4f10-961a-bccb1a136e12.",
};

describe("formatOperatorDecisionSummary", () => {
  it("formats an agent decision payload into a Korean structured operator card", () => {
    const summary = formatOperatorDecisionSummary(AGENT_PAYLOAD);

    const lines = summary.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^무엇이: /);
    expect(lines[1]).toMatch(/^왜 막힘: /);
    expect(lines[2]).toMatch(/^운영자 할 일: /);
    expect(lines[3]).toMatch(/^근거: /);

    expect(lines[0]).toContain("미션 2026-08-25 tech-ai-news daily report");
    expect(lines[0]).toContain("이슈 RES-3638 — [Unblock] RES-3637: Synthesize multi-source AI news report draft");
    expect(lines[1]).toContain("The accepted reassign_source_issue event");
    expect(lines[2]).toContain("Assign RES-3637 to the idle Technology Research Agent");
    expect(lines[3]).toContain("RES-3637 status=blocked");
  });

  it("does not repeat the card title when the reason already starts with it", () => {
    const summary = formatOperatorDecisionSummary({
      ...AGENT_PAYLOAD,
      reason: "Mission blocker escalated: the source issue cannot progress without operator input.",
    });

    expect(summary).not.toContain("Mission blocker escalated");
    expect(summary).toContain("the source issue cannot progress without operator input.");
  });

  it("shortens raw UUIDs to readable 8-char prefixes", () => {
    const summary = formatOperatorDecisionSummary(AGENT_PAYLOAD);

    expect(summary).toContain("423304dd");
    expect(summary).not.toContain("423304dd-9f5b-4c88-b4c5-7c17d67865ab");
    expect(summary).toContain("751281f0");
    expect(summary).not.toContain("751281f0-c613-4e7d-a5e9-63124da338ea");
  });

  it("truncates long prose at a sentence boundary, never mid-word", () => {
    const sentence = "This sentence is deliberately long so that several of them exceed the budget. ";
    const summary = formatOperatorDecisionSummary({
      ...AGENT_PAYLOAD,
      reason: sentence.repeat(12),
      nextAction: undefined,
      evidence: undefined,
    });

    const whyLine = summary.split("\n")[1]!;
    expect(whyLine.length).toBeLessThanOrEqual(361);
    expect(whyLine.endsWith(".")).toBe(true);
    expect(whyLine).not.toMatch(/\bThis\b[^.]*$/); // no partial trailing sentence fragment
  });

  it("falls back to a word boundary with an ellipsis when no sentence end fits", () => {
    const summary = formatOperatorDecisionSummary({
      ...AGENT_PAYLOAD,
      reason: `unbreakable ${"wordwordword ".repeat(60)}`,
      nextAction: undefined,
      evidence: undefined,
    });

    const whyLine = summary.split("\n")[1]!;
    expect(whyLine.length).toBeLessThanOrEqual(362);
    expect(whyLine.endsWith("…")).toBe(true);
    expect(whyLine).not.toMatch(/\w…$/); // ellipsis never glued to a partial word
  });

  it("unpacks a system terminal-report markdown reason into labeled fields", () => {
    const summary = formatOperatorDecisionSummary({
      decision: "escalate",
      missionTitle: "2026-08-25 gazua-evening",
      issueIdentifier: "GAZ-1352",
      issueTitle: "[Unblock] GAZ-1350: 2026-08-25 미국시장 시그널 해석",
      reason: [
        "### Mission owner decision",
        "Decision: escalate",
        "Source issue: GAZ-1350",
        "Reason: Mission cannot continue automatically. The workflow or its owner-action recovery reached a terminal failure.",
        "Next action: Human operator must choose a recovery path (retry with revised input, replan, reassign, or cancel).",
        "Evidence: mission=2026-08-25 gazua-evening; owner-action=GAZ-1352; source=GAZ-1350; failed-run-count=2; continuation=none",
      ].join("\n"),
    });

    expect(summary).not.toContain("###");
    expect(summary).not.toContain("Decision: escalate");
    expect(summary.split("\n")[1]).toContain("Mission cannot continue automatically.");
    expect(summary.split("\n")[2]).toContain("Human operator must choose a recovery path");
    expect(summary.split("\n")[3]).toContain("mission=2026-08-25 gazua-evening");
  });

  it("falls back to Korean defaults when reason and nextAction are missing", () => {
    const summary = formatOperatorDecisionSummary({
      decision: "escalate",
      missionTitle: "Some mission",
      issueId: "c70bc2a9-b34a-4ee5-960d-2dbc1605e01f",
    });

    const lines = summary.split("\n");
    expect(lines[1]).toBe("왜 막힘: (사유 기록 없음)");
    expect(lines[2]).toContain("운영자");
    expect(lines[2]).toContain("재시도");
    expect(lines).toHaveLength(3);
  });

  it("names the issue by shortened id when title and identifier are missing", () => {
    const summary = formatOperatorDecisionSummary({
      decision: "request_input",
      missionTitle: "Some mission",
      issueId: "86079e86-e6ee-43f4-bf6d-543bbb0909f5",
      reason: "needs input",
    });

    expect(summary.split("\n")[0]).toContain("이슈 (86079e86)");
  });
});

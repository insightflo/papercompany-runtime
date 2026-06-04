import { describe, expect, it } from "vitest";
import { buildAssignedIssuePromptSection } from "../services/missions/mission-issue-envelope.js";

describe("mission issue envelope", () => {
  it("builds a compact assigned issue prompt", () => {
    const prompt = buildAssignedIssuePromptSection({
      id: "issue-1",
      identifier: "PAP-1",
      title: "Collect sources",
      description: "Post a source-backed comment.",
    });

    expect(prompt).toContain("## Assigned Task");
    expect(prompt).toContain("Issue ID: issue-1");
    expect(prompt).toContain("Title: Collect sources");
    expect(prompt).toContain("Post a source-backed comment.");
    expect(prompt).toContain("Use Paperclip API env vars for lifecycle updates or evidence/blocker comments when needed.");
    expect(prompt).not.toContain("## Mission Child Issue Contract");
  });

  it("adds a short bounded contract for mission child issues", () => {
    const prompt = buildAssignedIssuePromptSection({
      id: "issue-2",
      identifier: "PAP-2",
      title: "Validate evidence",
      missionId: "mission-1",
      parentId: "parent-1",
    });

    expect(prompt).toContain("## Mission Child Issue Contract");
    expect(prompt).toContain("This is a bounded mission child issue.");
    expect(prompt).toContain("Work only this issue's scoped deliverable.");
    expect(prompt).toContain("Do not create downstream, sibling, recovery, QA, synthesis, validator, or director-gate work unless this issue explicitly asks for it.");
    expect(prompt).toContain("Complete only after posting the requested evidence");
    expect(prompt).toContain("Treat the mission final output as mission context unless this issue explicitly asks you to create it.");
  });
});

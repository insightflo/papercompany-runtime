import { describe, expect, it } from "vitest";
import { deriveRepoNameFromRepoUrl } from "../services/heartbeat-workspace-repo-name.js";

describe("workspace repo name", () => {
  it("preserves URL cleanup and rejects invalid input", () => {
    expect(deriveRepoNameFromRepoUrl("  https://example.com/team/project.git/  ")).toBe("project");
    expect(deriveRepoNameFromRepoUrl("https://example.com/")).toBeNull();
    expect(deriveRepoNameFromRepoUrl("git@example.com:repo.git")).toBeNull();
    expect(deriveRepoNameFromRepoUrl(null)).toBeNull();
  });
});

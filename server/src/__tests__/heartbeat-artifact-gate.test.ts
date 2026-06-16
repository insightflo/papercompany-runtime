import { describe, expect, it } from "vitest";
import {
  extractClaimedArtifactPaths,
  isActionableClaimedArtifactPath,
  workProductReferencesClaimedArtifact,
} from "../services/heartbeat.ts";

describe("heartbeat missing workProduct artifact gate", () => {
  it("ignores agent instruction files when extracting claimed artifact paths", () => {
    const instructionPath = "/Users/kwak/.paperclip-worktrees/instances/papercompany-runtime/companies/e7e3e98c-e720-4ddb-8f8b-36dd75805cc3/agents/9d56d53b-7a3a-4046-ba0d-08d18083a0cc/instructions/AGENTS.md";
    const commonInstructionPath = "/Users/kwak/.paperclip-worktrees/instances/papercompany-runtime/companies/e7e3e98c-e720-4ddb-8f8b-36dd75805cc3/instructions/research-company-common.md";
    const artifactPath = "/Users/kwak/.paperclip-worktrees/instances/papercompany-runtime/workspaces/9d56d53b-7a3a-4046-ba0d-08d18083a0cc/produced_work/tech_scout_20260616.md";

    expect(isActionableClaimedArtifactPath(instructionPath)).toBe(false);
    expect(isActionableClaimedArtifactPath(commonInstructionPath)).toBe(false);
    expect(isActionableClaimedArtifactPath(artifactPath)).toBe(true);

    const paths = extractClaimedArtifactPaths({
      resultJson: {
        result: [
          "이슈는 이미 완료 상태입니다.",
          `Read context: ${instructionPath}`,
          `Company context: ${commonInstructionPath}`,
          `Official artifact: ${artifactPath}`,
        ].join("\n"),
      },
      stdoutExcerpt: null,
      stderrExcerpt: null,
    } as any);

    expect(paths).toEqual([artifactPath]);
  });

  it("treats an existing active primary issue workProduct as sufficient even when a retry run reports no deliverable path", () => {
    expect(workProductReferencesClaimedArtifact(
      {
        url: null,
        externalId: null,
        status: "active",
        isPrimary: true,
        metadata: {
          path: "/Users/kwak/.paperclip-worktrees/instances/papercompany-runtime/workspaces/9d56d53b-7a3a-4046-ba0d-08d18083a0cc/produced_work/tech_scout_20260616.md",
        },
      },
      [],
    )).toBe(true);
  });
});

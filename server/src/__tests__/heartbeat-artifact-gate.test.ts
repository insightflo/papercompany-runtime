import { describe, expect, it } from "vitest";
import {
  extractClaimedArtifactPaths,
  hasSatisfiedWorkProductRegistration,
  isActionableClaimedArtifactPath,
  resolveStepRunRequiresWorkProduct,
  workProductReferencesClaimedArtifact,
} from "../services/heartbeat.ts";

describe("resolveStepRunRequiresWorkProduct (graphWorkProductRequired 3-state)", () => {
  it("returns true only when the field is explicitly true", () => {
    expect(resolveStepRunRequiresWorkProduct({ graphWorkProductRequired: true })).toBe(true);
  });

  it("returns false when explicitly false so the gate skips heuristics", () => {
    expect(resolveStepRunRequiresWorkProduct({ graphWorkProductRequired: false })).toBe(false);
  });

  it("returns undefined for legacy/unstamped metadata so the prior heuristics still apply", () => {
    expect(resolveStepRunRequiresWorkProduct({})).toBeUndefined();
    expect(resolveStepRunRequiresWorkProduct({ executionControls: { concurrencyKey: "x" } })).toBeUndefined();
    expect(resolveStepRunRequiresWorkProduct(null)).toBeUndefined();
    expect(resolveStepRunRequiresWorkProduct({ graphWorkProductRequired: "true" })).toBeUndefined();
  });
});

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

  it("keeps explicit [ARTIFACT] paths ahead of noisy path-like output", () => {
    const artifactPath = "/srv/papercompany/projects/research-company/produced_work/missions/mission-1/runs/run-1/steps/collect-tech-scout-evidence/evidence.json";
    const noisyPaths = [
      "/tool-index.md",
      "/tool-index.json",
      "/README-kali.md",
      "/platforms/macos.md",
      "/platforms/linux.md",
      "/README_en.md",
      "/README_ja.md",
      "/docs/install.md",
      "/docs/usage.md",
      "/examples/basic.json",
      "/examples/advanced.json",
    ].join("\n");

    const paths = extractClaimedArtifactPaths({
      resultJson: {
        stdout: `${noisyPaths}\n[ARTIFACT]: ${artifactPath}`,
      },
      stdoutExcerpt: null,
      stderrExcerpt: null,
    } as any);

    expect(paths[0]).toBe(artifactPath);
    expect(paths).toContain(artifactPath);
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

  it("treats an active primary workProduct as sufficient when retry output only reports input data paths", () => {
    const issue = { description: null };
    const existingWorkProducts = [
      {
        url: "https://example.invalid/reports/Macro_Event_Impact_2026-06-18.html",
        externalId: null,
        status: "active",
        isPrimary: true,
        metadata: {
          path: "/reports/beginner_html/dashboard/deep_dive/202606/Macro_Event_Impact_2026-06-18.html",
        },
      },
    ];
    const claimedArtifactPaths = [
      "/data/macro/events/macro_2026-06-18.json",
      "/data/macro/indicators/vix_2026-06-18.csv",
    ];

    expect(hasSatisfiedWorkProductRegistration({
      existingWorkProducts,
      claimedArtifactPaths,
      issue,
    })).toBe(true);
  });

  it("does not satisfy a mission artifact gate with a primary workProduct outside the allowed mission output root", () => {
    expect(hasSatisfiedWorkProductRegistration({
      existingWorkProducts: [
        {
          url: null,
          externalId: null,
          status: "active",
          isPrimary: true,
          metadata: {
            path: "/srv/papercompany/projects/research-company/produced_work/tech-scout/202606/old/report.md",
          },
        },
      ],
      claimedArtifactPaths: [],
      issue: { description: null },
      allowedArtifactRoot: "/srv/papercompany/projects/research-company/produced_work/missions/mission-1",
    })).toBe(false);
  });

  it("satisfies a mission artifact gate with a primary workProduct under the allowed mission output root", () => {
    expect(hasSatisfiedWorkProductRegistration({
      existingWorkProducts: [
        {
          url: null,
          externalId: null,
          status: "active",
          isPrimary: true,
          metadata: {
            path: "/srv/papercompany/projects/research-company/produced_work/missions/mission-1/runs/run-1/steps/collect/report.md",
          },
        },
      ],
      claimedArtifactPaths: [],
      issue: { description: null },
      allowedArtifactRoot: "/srv/papercompany/projects/research-company/produced_work/missions/mission-1",
    })).toBe(true);
  });

  it("does not satisfy registration when a deliverable path is claimed without a matching workProduct", () => {
    expect(hasSatisfiedWorkProductRegistration({
      existingWorkProducts: [],
      claimedArtifactPaths: ["/Users/kwak/Projects/ai/gazua-dashboard/reports/x.html"],
      issue: { description: null },
    })).toBe(false);
  });

  it("filters input and source paths from actionable claimed artifact detection", () => {
    expect(isActionableClaimedArtifactPath("/data/macro/events/macro_2026-06-18.json")).toBe(false);
    expect(isActionableClaimedArtifactPath("/input/foo.csv")).toBe(false);
    expect(isActionableClaimedArtifactPath("/source/bar.md")).toBe(false);
    expect(isActionableClaimedArtifactPath(
      "/Users/kwak/.paperclip-worktrees/instances/papercompany-runtime/workspaces/9d56d53b-7a3a-4046-ba0d-08d18083a0cc/produced_work/tech_scout_20260616.md",
    )).toBe(true);
  });
});

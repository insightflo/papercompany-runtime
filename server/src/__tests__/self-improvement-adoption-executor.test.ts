import { describe, expect, it } from "vitest";

import { applySelfImprovementAdoptionPlan } from "../services/self-improvement-adoption-executor.js";
import type { SelfImprovementAdoptionPlanEntry } from "../services/self-improvement-adoption-planner.js";

const basePlanEntry: SelfImprovementAdoptionPlanEntry = {
  candidateIndex: 0,
  asset: {
    assetType: "skill",
    assetRef: "research-news-synthesis",
    resolvedRef: "skills/research-news-synthesis/SKILL.md",
  },
  proposedEdit: {
    operation: "add",
    section: "Validation checklist",
    content: "- Verify source date and separate freshness from importance.",
  },
  validationPlan: "Replay against the last 3 AI news notes.",
  gateOwner: "peer:validator",
  evidenceSource: ["issue:planning-1"],
  pattern: "Repeatedly missed source freshness labels.",
};

function makeMemoryAssetStore(initial: Record<string, string>) {
  const assets = new Map(Object.entries(initial));
  const writes: Array<{ resolvedRef: string; content: string }> = [];
  return {
    assets,
    writes,
    async readAsset(resolvedRef: string) {
      return assets.get(resolvedRef) ?? null;
    },
    async writeAsset(resolvedRef: string, content: string) {
      writes.push({ resolvedRef, content });
      assets.set(resolvedRef, content);
    },
  };
}

describe("applySelfImprovementAdoptionPlan", () => {
  it("applies a bounded section patch only after validation PASS", async () => {
    const assetStore = makeMemoryAssetStore({
      "skills/research-news-synthesis/SKILL.md": [
        "# Research News Synthesis",
        "",
        "## Validation checklist",
        "- Check title.",
        "",
        "## Pitfalls",
        "- Do not overclaim.",
        "",
      ].join("\n"),
    });

    const result = await applySelfImprovementAdoptionPlan({
      plan: [basePlanEntry],
      assetStore,
      validationRunner: async ({ patchedContent }) => ({
        verdict: patchedContent.includes("separate freshness from importance") ? "PASS" : "FAIL",
      }),
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.applied).toEqual([
      {
        candidateIndex: 0,
        assetRef: "research-news-synthesis",
        resolvedRef: "skills/research-news-synthesis/SKILL.md",
        operation: "add",
        section: "Validation checklist",
        validationVerdict: "PASS",
        applied: true,
      },
    ]);
    expect(assetStore.writes).toHaveLength(1);
    expect(assetStore.assets.get("skills/research-news-synthesis/SKILL.md")).toContain("- Check title.\n- Verify source date");
  });

  it("fails closed and does not write when validation fails or the target section is missing", async () => {
    const assetStore = makeMemoryAssetStore({
      "skills/research-news-synthesis/SKILL.md": "# Research News Synthesis\n\n## Other section\n- Keep this.\n",
      "skills/validation-fail/SKILL.md": "# Validation Fail\n\n## Validation checklist\n- Keep this.\n",
    });

    const result = await applySelfImprovementAdoptionPlan({
      plan: [
        basePlanEntry,
        {
          ...basePlanEntry,
          candidateIndex: 1,
          asset: { assetType: "skill", assetRef: "validation-fail", resolvedRef: "skills/validation-fail/SKILL.md" },
        },
      ],
      assetStore,
      validationRunner: async ({ entry }) => ({
        verdict: entry.candidateIndex === 1 ? "FAIL" : "PASS",
        reason: entry.candidateIndex === 1 ? "Focused replay failed" : undefined,
      }),
    });

    expect(assetStore.writes).toEqual([]);
    expect(result.applied).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        code: "section_not_found",
        candidateIndex: 0,
        message: "candidate 0 could not find section Validation checklist in skills/research-news-synthesis/SKILL.md",
      },
      {
        code: "validation_failed",
        candidateIndex: 1,
        message: "candidate 1 validation did not PASS: Focused replay failed",
      },
    ]);
  });
});

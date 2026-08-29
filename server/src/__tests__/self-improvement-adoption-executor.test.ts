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
  evidencePatternIds: [],
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
        adoptedFromPatternIds: [],
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

  // [Phase 2 — impact 원장] 패턴 카드에서 온 채택은 적용 성공 후
  //   impactRecorder가 호출되고 applied에 adoptedFromPatternIds가 남는다.
  it("records adoption impact through the injected recorder for pattern-backed entries", async () => {
    const patternId = "11111111-2222-3333-4444-555555555555";
    const assetStore = makeMemoryAssetStore({
      "skills/research-news-synthesis/SKILL.md": "# Research News Synthesis\n\n## Validation checklist\n- Check title.\n",
    });
    const impactCalls: Array<{ resolvedRef: string; patternIds: string[] }> = [];

    const result = await applySelfImprovementAdoptionPlan({
      plan: [{ ...basePlanEntry, evidencePatternIds: [patternId] }],
      assetStore,
      validationRunner: async () => ({ verdict: "PASS" }),
      impactRecorder: async ({ entry }) => {
        impactCalls.push({ resolvedRef: entry.asset.resolvedRef, patternIds: entry.evidencePatternIds });
      },
    });

    expect(result.diagnostics).toEqual([]);
    expect(impactCalls).toEqual([
      { resolvedRef: "skills/research-news-synthesis/SKILL.md", patternIds: [patternId] },
    ]);
    expect(result.applied[0]?.adoptedFromPatternIds).toEqual([patternId]);
  });

  it("surfaces impact_record_failed diagnostics instead of silently skipping ledger writes", async () => {
    const patternId = "11111111-2222-3333-4444-555555555555";
    const assetStore = makeMemoryAssetStore({
      "skills/research-news-synthesis/SKILL.md": "# Research News Synthesis\n\n## Validation checklist\n- Check title.\n",
      "skills/throwing-skill/SKILL.md": "# Throwing\n\n## Validation checklist\n- Keep.\n",
    });

    const result = await applySelfImprovementAdoptionPlan({
      plan: [
        { ...basePlanEntry, evidencePatternIds: [patternId] },
        {
          ...basePlanEntry,
          candidateIndex: 1,
          asset: { assetType: "skill", assetRef: "throwing-skill", resolvedRef: "skills/throwing-skill/SKILL.md" },
          evidencePatternIds: [patternId],
        },
      ],
      assetStore,
      validationRunner: async () => ({ verdict: "PASS" }),
      impactRecorder: async ({ entry }) => {
        if (entry.asset.resolvedRef.includes("throwing")) throw new Error("ledger db down");
      },
    });

    // 자산 패치는 이미 적용됨 — 원장 누락만 진단으로 노출(롤백 아님, 무음도 아님).
    expect(assetStore.writes).toHaveLength(2);
    expect(result.applied).toHaveLength(2);
    expect(result.diagnostics).toEqual([
      {
        code: "impact_record_failed",
        candidateIndex: 1,
        message: "candidate 1 impact recording failed for skills/throwing-skill/SKILL.md: ledger db down",
      },
    ]);
  });

  it("reports impact_record_failed when pattern-backed entries have no impact recorder configured", async () => {
    const assetStore = makeMemoryAssetStore({
      "skills/research-news-synthesis/SKILL.md": "# Research News Synthesis\n\n## Validation checklist\n- Check title.\n",
    });

    const result = await applySelfImprovementAdoptionPlan({
      plan: [{ ...basePlanEntry, evidencePatternIds: ["11111111-2222-3333-4444-555555555555"] }],
      assetStore,
      validationRunner: async () => ({ verdict: "PASS" }),
    });

    expect(result.applied).toHaveLength(1);
    expect(result.diagnostics).toEqual([
      {
        code: "impact_record_failed",
        candidateIndex: 0,
        message:
          "candidate 0 adopted from knowledge pattern(s) 11111111-2222-3333-4444-555555555555 but no impact recorder was configured",
      },
    ]);
  });
});

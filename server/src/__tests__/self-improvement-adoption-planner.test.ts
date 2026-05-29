import { describe, expect, it } from "vitest";

import { buildSelfImprovementAdoptionPlan } from "../services/self-improvement-adoption-planner.js";

const acceptedCandidate = {
  assetType: "skill",
  assetRef: "research-news-synthesis",
  evidenceSource: ["issue:planning-1"],
  pattern: "Repeatedly missed source freshness labels.",
  proposedEdit: {
    operation: "add",
    section: "Validation checklist",
    content: "Verify source date and separate freshness from importance.",
  },
  validationPlan: "Replay against the last 3 AI news notes.",
  gateOwner: "peer:validator",
  autoAdoptionResult: "accepted",
};

describe("buildSelfImprovementAdoptionPlan", () => {
  it("plans only accepted candidates with gate PASS and a resolved single internal asset", () => {
    const result = buildSelfImprovementAdoptionPlan({
      candidates: [
        acceptedCandidate,
        { ...acceptedCandidate, assetRef: "queued-skill", autoAdoptionResult: "queued_for_validation" },
        { ...acceptedCandidate, assetRef: "rejected-skill", autoAdoptionResult: "rejected", rejectedEditNote: "Bad patch." },
        { ...acceptedCandidate, assetRef: "repair-skill", autoAdoptionResult: "repair_needed" },
      ],
      assetRegistry: [{ assetType: "skill", assetRef: "research-news-synthesis", resolvedRef: "skills/research-news-synthesis/SKILL.md" }],
      gateVerdicts: [{ gateOwner: "peer:validator", verdict: "PASS" }],
    });

    expect(result.plan).toEqual([
      {
        candidateIndex: 0,
        asset: {
          assetType: "skill",
          assetRef: "research-news-synthesis",
          resolvedRef: "skills/research-news-synthesis/SKILL.md",
        },
        proposedEdit: {
          operation: "add",
          section: "Validation checklist",
          content: "Verify source date and separate freshness from importance.",
        },
        validationPlan: "Replay against the last 3 AI news notes.",
        gateOwner: "peer:validator",
        evidenceSource: ["issue:planning-1"],
        pattern: "Repeatedly missed source freshness labels.",
      },
    ]);
    expect(result.diagnostics).toEqual([
      { code: "candidate_not_accepted", message: "selfImprovementCandidates[1] is queued_for_validation and is not selectable for dry-run adoption" },
      { code: "candidate_not_accepted", message: "selfImprovementCandidates[2] is rejected and is not selectable for dry-run adoption" },
      { code: "candidate_not_accepted", message: "selfImprovementCandidates[3] is repair_needed and is not selectable for dry-run adoption" },
    ]);
  });

  it("fails closed when gate PASS is missing, assets are unresolved, or a patch targets multiple assets", () => {
    const result = buildSelfImprovementAdoptionPlan({
      candidates: [
        acceptedCandidate,
        { ...acceptedCandidate, assetRef: "missing-skill" },
        {
          ...acceptedCandidate,
          assetRef: "multi-skill",
          proposedEdit: {
            ...acceptedCandidate.proposedEdit,
            assetRefs: ["multi-skill", "second-skill"],
          },
        },
      ],
      assetRegistry: [
        { assetType: "skill", assetRef: "research-news-synthesis", resolvedRef: "skills/research-news-synthesis/SKILL.md" },
        { assetType: "skill", assetRef: "multi-skill", resolvedRef: "skills/multi-skill/SKILL.md" },
      ],
      gateVerdicts: [{ gateOwner: "other-peer", verdict: "PASS" }],
    });

    expect(result.plan).toEqual([]);
    expect(result.diagnostics).toEqual([
      { code: "gate_not_passed", message: "selfImprovementCandidates[0] gateOwner peer:validator does not have a current PASS verdict" },
      { code: "gate_not_passed", message: "selfImprovementCandidates[1] gateOwner peer:validator does not have a current PASS verdict" },
      { code: "unresolved_asset", message: "selfImprovementCandidates[1] could not resolve exactly one internal asset for skill:missing-skill" },
      { code: "gate_not_passed", message: "selfImprovementCandidates[2] gateOwner peer:validator does not have a current PASS verdict" },
      { code: "multi_asset_patch", message: "selfImprovementCandidates[2] proposedEdit must target exactly one asset through top-level assetType + assetRef" },
    ]);
  });
});

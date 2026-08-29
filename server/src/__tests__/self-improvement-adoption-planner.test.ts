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
        evidencePatternIds: [],
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

  it("never selects tool-gap candidates for adoption, even when marked accepted with a gate PASS", () => {
    const candidate = {
      assetType: "tool",
      assetRef: "text-similarity",
      evidenceSource: ["issue:planning-1"],
      pattern: "Answered similarity questions without a computation tool.",
      toolGap: { capability: "similarity computation", existingToolsTried: ["text_count"] },
      proposedEdit: { operation: "add", section: "text-similarity" },
      validationPlan: "Run against reference documents.",
      gateOwner: "peer:validator",
      autoAdoptionResult: "accepted",
    };
    const result = buildSelfImprovementAdoptionPlan({
      candidates: [candidate],
      assetRegistry: [{ assetType: "tool", assetRef: "text-similarity", resolvedRef: "tools/text_similarity.py" }],
      gateVerdicts: [{ gateOwner: "peer:validator", verdict: "PASS" }],
    });
    expect(result.plan).toHaveLength(0);
    expect(result.diagnostics.some((d) => d.code === "tool_gap_not_auto_adoptable")).toBe(true);
  });

  // [Phase 2 — 지식 위키 연결] evidenceSource의 knowledge_pattern 참조는
  //   회사 레지스트리(knowledge_pattern 자산)에서 정확히 1건으로 해석되어야 한다.
  it("carries resolved knowledge pattern ids on plan entries referenced through string or object evidence", () => {
    const patternId = "11111111-2222-3333-4444-555555555555";
    const result = buildSelfImprovementAdoptionPlan({
      candidates: [
        { ...acceptedCandidate, evidenceSource: [`knowledge_pattern:${patternId}`, "issue:planning-1"] },
        {
          ...acceptedCandidate,
          assetRef: "second-skill",
          evidenceSource: [{ type: "knowledge_pattern", id: patternId, note: "저녁3 스톨 근본원인" }],
        },
      ],
      assetRegistry: [
        { assetType: "skill", assetRef: "research-news-synthesis", resolvedRef: "skills/research-news-synthesis/SKILL.md" },
        { assetType: "skill", assetRef: "second-skill", resolvedRef: "skills/second-skill/SKILL.md" },
        { assetType: "knowledge_pattern", assetRef: patternId, resolvedRef: patternId },
      ],
      gateVerdicts: [{ gateOwner: "peer:validator", verdict: "PASS" }],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.plan.map((entry) => entry.evidencePatternIds)).toEqual([[patternId], [patternId]]);
  });

  it("fails closed when a referenced knowledge pattern does not resolve to exactly one registry entry", () => {
    const missingPatternId = "aaaaaaaa-0000-0000-0000-000000000001";
    const ambiguousPatternId = "aaaaaaaa-0000-0000-0000-000000000002";
    const result = buildSelfImprovementAdoptionPlan({
      candidates: [
        { ...acceptedCandidate, evidenceSource: [{ type: "knowledge_pattern", id: missingPatternId }] },
        { ...acceptedCandidate, assetRef: "second-skill", evidenceSource: [`knowledge_pattern:${ambiguousPatternId}`] },
      ],
      assetRegistry: [
        { assetType: "skill", assetRef: "research-news-synthesis", resolvedRef: "skills/research-news-synthesis/SKILL.md" },
        { assetType: "skill", assetRef: "second-skill", resolvedRef: "skills/second-skill/SKILL.md" },
        { assetType: "knowledge_pattern", assetRef: ambiguousPatternId, resolvedRef: ambiguousPatternId },
        { assetType: "knowledge_pattern", assetRef: ambiguousPatternId, resolvedRef: `${ambiguousPatternId}#dupe` },
      ],
      gateVerdicts: [{ gateOwner: "peer:validator", verdict: "PASS" }],
    });

    expect(result.plan).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        code: "unresolved_evidence_pattern",
        message: `selfImprovementCandidates[0] references knowledge_pattern ${missingPatternId} which does not resolve to exactly one registry entry`,
      },
      {
        code: "unresolved_evidence_pattern",
        message: `selfImprovementCandidates[1] references knowledge_pattern ${ambiguousPatternId} which does not resolve to exactly one registry entry`,
      },
    ]);
  });

  it("rejects malformed knowledge pattern evidence entries as contract violations", () => {
    const result = buildSelfImprovementAdoptionPlan({
      candidates: [{ ...acceptedCandidate, evidenceSource: [{ type: "knowledge_pattern" }] }],
      assetRegistry: [{ assetType: "skill", assetRef: "research-news-synthesis", resolvedRef: "skills/research-news-synthesis/SKILL.md" }],
      gateVerdicts: [{ gateOwner: "peer:validator", verdict: "PASS" }],
    });

    expect(result.plan).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        code: "invalid_candidate_contract",
        message: "selfImprovementCandidates[0].evidenceSource knowledge_pattern entries require a non-empty id",
      },
    ]);
  });
});

// [판정 실체화] 해시 스코프 판정 — 다른 후보 해시를 향한 PASS는 이 후보에 적용되지 않는다.
describe("hash-scoped gate verdicts", () => {
  it("applies a verdict only to the candidate whose hash matches, and global verdicts still work", () => {
    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);
    const result = buildSelfImprovementAdoptionPlan({
      candidates: [acceptedCandidate, { ...acceptedCandidate, assetRef: "second-skill" }],
      candidateHashes: [hashA, hashB],
      assetRegistry: [
        { assetType: "skill", assetRef: "research-news-synthesis", resolvedRef: "skills/research-news-synthesis/SKILL.md" },
        { assetType: "skill", assetRef: "second-skill", resolvedRef: "skills/second-skill/SKILL.md" },
      ],
      gateVerdicts: [
        { gateOwner: "peer:validator", verdict: "PASS", candidateHash: hashA },
        { gateOwner: "peer:other", verdict: "PASS", candidateHash: "c".repeat(64) },
      ],
    });

    expect(result.plan.map((entry) => entry.asset.assetRef)).toEqual(["research-news-synthesis"]);
    expect(result.diagnostics.some((d) => d.code === "gate_not_passed")).toBe(true);
  });

  it("does not authorize unknown-hash candidates with hash-scoped verdicts (fail closed)", () => {
    const result = buildSelfImprovementAdoptionPlan({
      candidates: [acceptedCandidate],
      gateVerdicts: [{ gateOwner: "peer:validator", verdict: "PASS", candidateHash: "d".repeat(64) }],
      assetRegistry: [{ assetType: "skill", assetRef: "research-news-synthesis", resolvedRef: "skills/research-news-synthesis/SKILL.md" }],
    });
    expect(result.plan).toHaveLength(0);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["gate_not_passed"]);
  });
});

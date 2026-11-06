import { expect, it } from "vitest";
import { buildMissionOwnerPlanRevisionDraft, type BuildMissionOwnerPlanRevisionDraftInput, type MissionOwnerPlanDecisionPayload } from "../../services/mission-owner-plan-decisions.js";

export function registerOwnerPlanDraftCasesB(baseDecision: MissionOwnerPlanDecisionPayload, baseArgs: Omit<BuildMissionOwnerPlanRevisionDraftInput, "decision">) {
  it("rejects self-improvement candidates with invalid contract enums", () => {
    const invalidCandidates = [
      { assetType: "memory", proposedEdit: { operation: "add" }, autoAdoptionResult: "queued_for_validation" },
      { assetType: "skill", proposedEdit: { operation: "rewrite" }, autoAdoptionResult: "queued_for_validation" },
      { assetType: "skill", proposedEdit: { operation: "add" }, autoAdoptionResult: "needs_user_approval" },
    ].map((candidate) => ({
      assetRef: "research-news-synthesis",
      evidenceSource: ["issue:planning-1"],
      pattern: "Repeatedly missed source freshness labels.",
      validationPlan: "Replay against reference notes.",
      gateOwner: "peer:validator",
      ...candidate,
    }));

    for (const candidate of invalidCandidates) {
      const result = buildMissionOwnerPlanRevisionDraft({
        decision: {
          ...baseDecision,
          selfImprovementCandidates: [candidate],
        },
        ...baseArgs,
      });

      expect(result).not.toEqual({ ok: true, draft: expect.anything() });
      if (!result.ok) {
        expect(result.diagnostics.some((d) => /selfImprovementCandidates/i.test(d.message))).toBe(true);
      }
    }
  });

  it("accepts a tool-gap candidate with the full toolGap contract and preserves it in refs", () => {
    const candidate = {
      assetType: "tool",
      assetRef: "text-similarity",
      evidenceSource: ["issue:planning-1", { kind: "run", runId: "run-42" }],
      pattern: "Answered similarity questions without a computation tool.",
      toolGap: {
        capability: "Jaccard/cosine similarity between two text files",
        existingToolsTried: ["text_count", "shell"],
      },
      proposedEdit: { operation: "add", section: "text-similarity", content: "New tool proposal: deterministic similarity computation." },
      validationPlan: "Run against two reference documents and compare scores.",
      gateOwner: "peer:validator",
      autoAdoptionResult: "queued_for_validation",
    };

    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, selfImprovementCandidates: [candidate] },
      ...baseArgs,
    });

    expect(result).toEqual({
      ok: true,
      draft: expect.objectContaining({
        refs: expect.objectContaining({ selfImprovementCandidates: [candidate] }),
      }),
    });
  });

  it("rejects tool-gap candidates missing toolGap fields, using non-add operations, or claiming auto-adoption", () => {
    const base = {
      assetType: "tool",
      assetRef: "text-similarity",
      evidenceSource: ["issue:planning-1"],
      pattern: "Answered similarity questions without a computation tool.",
      proposedEdit: { operation: "add", section: "text-similarity" },
      validationPlan: "Run against two reference documents.",
      gateOwner: "peer:validator",
      autoAdoptionResult: "queued_for_validation",
    };
    const invalidCandidates = [
      { ...base }, // missing toolGap entirely
      { ...base, toolGap: { capability: "similarity" } }, // missing existingToolsTried
      { ...base, toolGap: { existingToolsTried: ["text_count"] } }, // missing capability
      { ...base, toolGap: { capability: "  ", existingToolsTried: ["text_count"] } }, // blank capability
      { ...base, toolGap: { capability: "similarity", existingToolsTried: [] } }, // empty tried list
      { ...base, toolGap: { capability: "similarity", existingToolsTried: ["text_count"] }, proposedEdit: { operation: "replace", section: "text-similarity" } },
      { ...base, toolGap: { capability: "similarity", existingToolsTried: ["text_count"] }, autoAdoptionResult: "accepted" },
    ];

    for (const candidate of invalidCandidates) {
      const result = buildMissionOwnerPlanRevisionDraft({
        decision: { ...baseDecision, selfImprovementCandidates: [candidate] },
        ...baseArgs,
      });
      expect(result).not.toEqual({ ok: true, draft: expect.anything() });
      if (!result.ok) {
        expect(result.diagnostics.some((d) => /selfImprovementCandidates\[0\]\.toolGap|toolGap is required|tool/i.test(d.message))).toBe(true);
      }
    }
  });

  // [자동수선 근거] 선택 필드 producerAgentId/sourceIssueId — 정상 통과 / 빈 문자열·비문자열·초과 → invalid_candidate_contract.
  it("accepts optional producerAgentId/sourceIssueId and rejects malformed values", () => {
    const base = {
      assetType: "skill",
      assetRef: "research-news-synthesis",
      evidenceSource: ["issue:planning-1"],
      pattern: "Repeatedly missed source freshness labels.",
      proposedEdit: { operation: "add", section: "Validation checklist" },
      validationPlan: "Replay against reference notes.",
      gateOwner: "peer:validator",
      autoAdoptionResult: "queued_for_validation",
    };

    const valid = buildMissionOwnerPlanRevisionDraft({
      decision: {
        ...baseDecision,
        selfImprovementCandidates: [{ ...base, producerAgentId: "agent-42", sourceIssueId: "issue-7" }],
      },
      ...baseArgs,
    });
    expect(valid).toEqual({
      ok: true,
      draft: expect.objectContaining({
        refs: expect.objectContaining({
          selfImprovementCandidates: [{ ...base, producerAgentId: "agent-42", sourceIssueId: "issue-7" }],
        }),
      }),
    });

    const invalidValues = [
      { producerAgentId: "" },
      { producerAgentId: "   " },
      { producerAgentId: 42 },
      { producerAgentId: "x".repeat(101) },
      { sourceIssueId: "" },
      { sourceIssueId: null },
      { sourceIssueId: ["issue-7"] },
      { sourceIssueId: "x".repeat(101) },
    ];
    for (const invalid of invalidValues) {
      const result = buildMissionOwnerPlanRevisionDraft({
        decision: { ...baseDecision, selfImprovementCandidates: [{ ...base, ...invalid }] },
        ...baseArgs,
      });
      expect(result).not.toEqual({ ok: true, draft: expect.anything() });
      if (!result.ok) {
        expect(
          result.diagnostics.some((d) => /selfImprovementCandidates\[0\]\.(producerAgentId|sourceIssueId)/.test(d.message)),
        ).toBe(true);
      }
    }
  });

  it("requires rejectedEditNote only when self-improvement candidates are rejected", () => {
    const validBaseCandidate = {
      assetType: "skill",
      assetRef: "research-news-synthesis",
      evidenceSource: ["issue:planning-1"],
      pattern: "Repeatedly missed source freshness labels.",
      proposedEdit: { operation: "add", section: "Validation checklist" },
      validationPlan: "Replay against reference notes.",
      gateOwner: "peer:validator",
    };

    const queuedResult = buildMissionOwnerPlanRevisionDraft({
      decision: {
        ...baseDecision,
        selfImprovementCandidates: [{ ...validBaseCandidate, autoAdoptionResult: "queued_for_validation" }],
      },
      ...baseArgs,
    });
    expect(queuedResult).toEqual({ ok: true, draft: expect.anything() });

    const rejectedMissingNote = buildMissionOwnerPlanRevisionDraft({
      decision: {
        ...baseDecision,
        selfImprovementCandidates: [{ ...validBaseCandidate, autoAdoptionResult: "rejected" }],
      },
      ...baseArgs,
    });
    expect(rejectedMissingNote).not.toEqual({ ok: true, draft: expect.anything() });
    if (!rejectedMissingNote.ok) {
      expect(rejectedMissingNote.diagnostics.some((d) => /rejectedEditNote/i.test(d.message))).toBe(true);
    }

    const rejectedWithNote = buildMissionOwnerPlanRevisionDraft({
      decision: {
        ...baseDecision,
        selfImprovementCandidates: [
          { ...validBaseCandidate, autoAdoptionResult: "rejected", rejectedEditNote: "Too broad for one bounded patch." },
        ],
      },
      ...baseArgs,
    });
    expect(rejectedWithNote).toEqual({ ok: true, draft: expect.anything() });
  });
}

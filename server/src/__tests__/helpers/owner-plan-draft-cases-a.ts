import { expect, it } from "vitest";
import { buildMissionOwnerPlanRevisionDraft, type BuildMissionOwnerPlanRevisionDraftInput, type MissionOwnerPlanDecisionPayload } from "../../services/mission-owner-plan-decisions.js";

export function registerOwnerPlanDraftCasesA(baseDecision: MissionOwnerPlanDecisionPayload, baseArgs: Omit<BuildMissionOwnerPlanRevisionDraftInput, "decision">) {
  it("defaults omitted array fields to empty arrays for a minimal decision", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { missionId: "mission-42" },
      ...baseArgs,
    });

    expect(result).toEqual({
      ok: true,
      draft: {
        missionId: "mission-42",
        refs: {
          schemaVersion: 3,
          selectedExecutionUnits: [],
          ruleRefs: [],
          kbRefs: [],
          ownerPlanDecision: { planningIssueId: "issue-99", commentId: "comment-77" },
        },
        requiredInputs: [],
        successCriteria: [],
        steps: [],
      },
    });
  });

  it("defaults null array fields to empty arrays", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: {
        missionId: "mission-42",
        selectedExecutionUnits: null,
        ruleRefs: null,
        kbRefs: null,
        requiredInputs: null,
        successCriteria: null,
        steps: null,
      },
      ...baseArgs,
    });

    expect(result).toEqual({
      ok: true,
      draft: expect.objectContaining({
        refs: expect.objectContaining({
          selectedExecutionUnits: [],
          ruleRefs: [],
          kbRefs: [],
          ownerPlanDecision: { planningIssueId: "issue-99", commentId: "comment-77" },
        }),
        requiredInputs: [],
        successCriteria: [],
        steps: [],
      }),
    });
  });

  // 1. Valid decision with missionGoal normalizes all fields correctly
  it("normalizes a valid decision with missionGoal into a complete draft", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: baseDecision,
      ...baseArgs,
    });

    expect(result).toEqual({
      ok: true,
      draft: {
        missionId: "mission-42",
        missionGoal: "Ship controlled rollout",
        refs: {
          schemaVersion: 3,
          selectedExecutionUnits: [{ id: "unit-1", title: "Run smoke" }],
          ruleRefs: ["rule:security"],
          kbRefs: ["kb:rollout"],
          ownerPlanDecision: { planningIssueId: "issue-99", commentId: "comment-77" },
        },
        requiredInputs: ["stagingUrl"],
        successCriteria: ["smoke passes"],
        steps: [{ id: "step-1", title: "Verify staging" }],
      },
    });
  });

  it("preserves dynamic mission planning fields in plan refs", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: {
        ...baseDecision,
        missionInvariant: ["RPA 과강제 금지", { principle: "slice vs E2E 분리" }],
        scopeHypothesis: "This slice proves the mission owner can request evidence-gated work.",
        executionSlice: {
          inScope: ["runtime brief parsing"],
          outOfScope: ["deploy", "workflow run"],
          approvalGates: ["push requires user approval"],
        },
        evidenceRequired: ["focused test output", { kind: "typecheck", command: "pnpm --filter @paperclipai/server typecheck" }],
        gate: {
          validator: "Report Validator",
          pass: ["all evidence read back"],
          requestChanges: ["missing evidence"],
          blocked: ["needs user approval"],
        },
        promotion: {
          promote: ["repeatable evidence template"],
          doNotPromote: ["PR number", "one-off log"],
        },
      },
      ...baseArgs,
    });

    expect(result).toEqual({
      ok: true,
      draft: expect.objectContaining({
        refs: expect.objectContaining({
          dynamicMissionPlanning: {
            missionInvariant: ["RPA 과강제 금지", { principle: "slice vs E2E 분리" }],
            scopeHypothesis: "This slice proves the mission owner can request evidence-gated work.",
            executionSlice: {
              inScope: ["runtime brief parsing"],
              outOfScope: ["deploy", "workflow run"],
              approvalGates: ["push requires user approval"],
            },
            evidenceRequired: ["focused test output", { kind: "typecheck", command: "pnpm --filter @paperclipai/server typecheck" }],
            gate: {
              validator: "Report Validator",
              pass: ["all evidence read back"],
              requestChanges: ["missing evidence"],
              blocked: ["needs user approval"],
            },
            promotion: {
              promote: ["repeatable evidence template"],
              doNotPromote: ["PR number", "one-off log"],
            },
          },
        }),
      }),
    });
  });

  it("preserves self-improvement candidates in plan refs", () => {
    const candidates = [
      {
        assetType: "skill",
        assetRef: "research-news-synthesis",
        evidenceSource: ["issue:planning-1", { kind: "test", command: "pnpm vitest run news.test.ts" }],
        pattern: "Repeatedly missed source freshness labels.",
        proposedEdit: {
          operation: "add",
          section: "Validation checklist",
          content: "Verify source date and separate freshness from importance.",
        },
        validationPlan: "Replay against the last 3 AI news notes.",
        rejectedEditNote: "none",
        gateOwner: "peer:validator",
        autoAdoptionResult: "queued_for_validation",
      },
    ];

    const result = buildMissionOwnerPlanRevisionDraft({
      decision: {
        ...baseDecision,
        selfImprovementCandidates: candidates,
      },
      ...baseArgs,
    });

    expect(result).toEqual({
      ok: true,
      draft: expect.objectContaining({
        refs: expect.objectContaining({
          selfImprovementCandidates: candidates,
        }),
      }),
    });
  });

  it("rejects malformed self-improvement candidates instead of silently omitting them", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: {
        ...baseDecision,
        selfImprovementCandidates: ["not-a-candidate-object"],
      },
      ...baseArgs,
    });

    expect(result).not.toEqual({ ok: true, draft: expect.anything() });
    if (!result.ok) {
      expect(result.diagnostics.some((d) => /selfImprovementCandidates/i.test(d.message))).toBe(true);
    }
  });

  it("rejects self-improvement candidates missing required contract fields", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: {
        ...baseDecision,
        selfImprovementCandidates: [
          {
            assetType: "skill",
            assetRef: "research-news-synthesis",
            evidenceSource: ["issue:planning-1"],
            proposedEdit: { operation: "add", section: "Validation checklist" },
            validationPlan: "Replay against reference notes.",
            gateOwner: "peer:validator",
            autoAdoptionResult: "queued_for_validation",
          },
        ],
      },
      ...baseArgs,
    });

    expect(result).not.toEqual({ ok: true, draft: expect.anything() });
    if (!result.ok) {
      expect(result.diagnostics.some((d) => /pattern/i.test(d.message))).toBe(true);
    }
  });
}

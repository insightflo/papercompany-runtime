import { expect, it } from "vitest";
import { buildMissionOwnerPlanRevisionDraft, type BuildMissionOwnerPlanRevisionDraftInput, type MissionOwnerPlanAssessment, type MissionOwnerPlanDecisionPayload } from "../../services/mission-owner-plan-decisions.js";

export function registerOwnerPlanDraftCasesC(baseDecision: MissionOwnerPlanDecisionPayload, baseArgs: Omit<BuildMissionOwnerPlanRevisionDraftInput, "decision">, validAssessment: MissionOwnerPlanAssessment) {
  // 2. goal fallback: uses decision.goal when decision.missionGoal is absent
  it("falls back to decision.goal when missionGoal is absent", () => {
    const { missionGoal: _, ...withoutGoal } = baseDecision;
    const decision = { ...withoutGoal, goal: "Fallback goal text" };

    const result = buildMissionOwnerPlanRevisionDraft({
      decision,
      ...baseArgs,
    });

    expect(result).toEqual({
      ok: true,
      draft: expect.objectContaining({
        missionGoal: "Fallback goal text",
      }),
    });
  });

  // 3. Missing goal omitted when both missionGoal and goal are absent or empty
  it("omits missionGoal when both missionGoal and goal are absent", () => {
    const { missionGoal: _, ...withoutGoal } = baseDecision;

    const result = buildMissionOwnerPlanRevisionDraft({
      decision: withoutGoal,
      ...baseArgs,
    });

    expect(result).toEqual({ ok: true, draft: expect.not.objectContaining({ missionGoal: expect.anything() }) });
  });

  it("omits missionGoal when both missionGoal and goal are empty strings", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, missionGoal: "", goal: "" },
      ...baseArgs,
    });

    expect(result).toEqual({ ok: true, draft: expect.not.objectContaining({ missionGoal: expect.anything() }) });
  });

  // 4. missionId mismatch → invalid result, no throw
  it("returns invalid result (no throw) when missionId does not match expectedMissionId", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, missionId: "WRONG-MISSION" },
      expectedMissionId: "mission-42",
      planningIssueId: "issue-99",
      commentId: "comment-77",
    });

    expect(result).not.toEqual({ ok: true, draft: expect.anything() });
    if (!result.ok) {
      expect(result.diagnostics.length).toBeGreaterThan(0);
      expect(result.diagnostics.some((d) => /missionId/i.test(d.message) || /mismatch/i.test(d.message))).toBe(true);
    }
  });

  it("returns ok when missionId is absent from decision", () => {
    const { missionId: _, ...withoutId } = baseDecision;
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: withoutId,
      ...baseArgs,
    });

    expect(result).toEqual({ ok: true, draft: expect.objectContaining({ missionId: "mission-42" }) });
  });

  // 5. Wrong top-level shapes rejected with diagnostics
  it("rejects selectedExecutionUnits that is not an array", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, selectedExecutionUnits: "not-an-array" },
      ...baseArgs,
    });

    expect(result).not.toEqual({ ok: true, draft: expect.anything() });
    if (!result.ok) {
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
  });

  it("rejects selectedExecutionUnits containing non-object entries", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, selectedExecutionUnits: ["string-not-allowed"] },
      ...baseArgs,
    });

    expect(result).not.toEqual({ ok: true, draft: expect.anything() });
    if (!result.ok) {
      expect(result.diagnostics.some((d) => /selectedExecutionUnits/i.test(d.message))).toBe(true);
    }
  });

  it("rejects ruleRefs that is not an array", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, ruleRefs: 42 },
      ...baseArgs,
    });

    expect(result).not.toEqual({ ok: true, draft: expect.anything() });
  });

  it("rejects ruleRefs containing non-string/non-object entries", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, ruleRefs: [123] },
      ...baseArgs,
    });

    expect(result).not.toEqual({ ok: true, draft: expect.anything() });
  });

  it("rejects kbRefs containing non-string/non-object entries", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, kbRefs: [true] },
      ...baseArgs,
    });

    expect(result).not.toEqual({ ok: true, draft: expect.anything() });
  });

  it("rejects requiredInputs containing non-string/non-object entries", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, requiredInputs: [null] },
      ...baseArgs,
    });

    expect(result).not.toEqual({ ok: true, draft: expect.anything() });
  });

  it("rejects successCriteria containing non-string/non-object entries", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, successCriteria: [undefined] },
      ...baseArgs,
    });

    expect(result).not.toEqual({ ok: true, draft: expect.anything() });
  });

  it("rejects steps containing non-string/non-object entries", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, steps: [42] },
      ...baseArgs,
    });

    expect(result).not.toEqual({ ok: true, draft: expect.anything() });
  });

  // 6. Over-cap arrays rejected
  it("rejects absurdly large selectedExecutionUnits array", () => {
    const huge = Array.from({ length: 1100 }, (_, i) => ({ id: `unit-${i}` }));
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, selectedExecutionUnits: huge },
      ...baseArgs,
    });

    expect(result).not.toEqual({ ok: true, draft: expect.anything() });
    if (!result.ok) {
      expect(result.diagnostics.some((d) => /selectedExecutionUnits/i.test(d.message))).toBe(true);
    }
  });

  it("rejects absurdly large ruleRefs array", () => {
    const huge = Array.from({ length: 1100 }, (_, i) => `rule:${i}`);
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, ruleRefs: huge },
      ...baseArgs,
    });

    expect(result).not.toEqual({ ok: true, draft: expect.anything() });
  });

  // 7. selectedExecutionUnits preserve arbitrary object structure without DB validation
  it("preserves arbitrary object structure in selectedExecutionUnits without DB validation", () => {
    const customUnits = [
      { id: "custom-1", foo: "bar", nested: { deep: true }, count: 42 },
      { name: "unit-no-id", metadata: [{ tag: "a" }] },
    ];

    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, selectedExecutionUnits: customUnits },
      ...baseArgs,
    });

    expect(result).toEqual({
      ok: true,
      draft: expect.objectContaining({
        refs: expect.objectContaining({ selectedExecutionUnits: customUnits }),
      }),
    });
  });

  it("preserves a valid assessment under refs.ownerPlanDecision.assessment", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, assessment: validAssessment },
      ...baseArgs,
    });

    expect(result).toEqual({
      ok: true,
      draft: expect.objectContaining({
        refs: expect.objectContaining({
          ownerPlanDecision: {
            planningIssueId: "issue-99",
            commentId: "comment-77",
            assessment: validAssessment,
          },
        }),
      }),
    });
  });

  it("omits malformed assessment arrays without rejecting an otherwise valid draft", () => {
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, assessment: { ...validAssessment, gaps: "not-an-array" } },
      ...baseArgs,
    });

    expect(result).toEqual({
      ok: true,
      draft: expect.objectContaining({
        refs: expect.objectContaining({
          ownerPlanDecision: {
            planningIssueId: "issue-99",
            commentId: "comment-77",
            assessment: expect.objectContaining({
              objectiveRestatement: validAssessment.objectiveRestatement,
              assetEvaluation: validAssessment.assetEvaluation,
              researchPerformed: validAssessment.researchPerformed,
            }),
          },
        }),
      }),
    });
    if (result.ok) {
      expect(result.draft.refs.ownerPlanDecision.assessment).not.toHaveProperty("gaps");
    }
  });

  it("preserves mixed string and object entries in ruleRefs", () => {
    const mixed = ["rule:a", { ref: "rule:b", confidence: 0.9 }];
    const result = buildMissionOwnerPlanRevisionDraft({
      decision: { ...baseDecision, ruleRefs: mixed },
      ...baseArgs,
    });

    expect(result).toEqual({
      ok: true,
      draft: expect.objectContaining({ refs: expect.objectContaining({ ruleRefs: mixed }) }),
    });
  });
}

import { describe, expect, it } from "vitest";
import { fillStructuralValidatorToolArgs } from "../services/missions/structural-materialization.js";
import { buildPaqoWorkflowSteps } from "../services/mission-owner-plan-decisions.js";

type Step = Parameters<typeof fillStructuralValidatorToolArgs>[0][number];

function makeStep(overrides: Partial<Step> & { id: string }): Step {
  return {
    name: `[QA] gate`,
    agentId: "",
    dependencies: [],
    type: "tool",
    qaType: "structural",
    toolNames: ["validate-gazua-report-html"],
    ...overrides,
  } as Step;
}

describe("fillStructuralValidatorToolArgs", () => {
  it("fills canonical validator args from the single producer dependency (case A)", () => {
    const steps = [
      makeStep({ id: "action-2-abc", name: "[ACTION] produce html", agentId: "agent-1", type: undefined, qaType: undefined, toolNames: undefined }),
      makeStep({ id: "qa-3-def", dependencies: ["action-2-abc"] }),
    ];
    fillStructuralValidatorToolArgs(steps);
    expect(steps[1]!.toolArgs).toEqual({
      dir: "{$steps.action-2-abc.workProductDir}",
      glob: "*.html",
    });
  });

  it("keeps explicitly declared toolArgs untouched (case B)", () => {
    const steps = [
      makeStep({ id: "action-2-abc", name: "[ACTION] produce", agentId: "agent-1", type: undefined, qaType: undefined, toolNames: undefined }),
      makeStep({
        id: "qa-3-def",
        dependencies: ["action-2-abc"],
        toolArgs: { dir: "/custom/dir", glob: "report*.html" },
      }),
    ];
    fillStructuralValidatorToolArgs(steps);
    expect(steps[1]!.toolArgs).toEqual({ dir: "/custom/dir", glob: "report*.html" });
  });

  it("fails closed when a structural tool step has no dependency to derive args from (case C)", () => {
    const steps = [makeStep({ id: "qa-3-def", dependencies: [] })];
    expect(() => fillStructuralValidatorToolArgs(steps))
      .toThrow(/qa-3-def[\s\S]*toolArgs/);
  });

  it("fails closed when the structural gate has more than one producer dependency (case D)", () => {
    const producer = { name: "[ACTION] produce", agentId: "a", dependencies: [], type: undefined, qaType: undefined, toolNames: undefined } as const;
    const steps = [
      makeStep({ id: "p1", ...producer }),
      makeStep({ id: "p2", ...producer }),
      makeStep({ id: "qa-3-def", dependencies: ["p1", "p2"] }),
    ];
    expect(() => fillStructuralValidatorToolArgs(steps))
      .toThrow(/qa-3-def[\s\S]*toolArgs/);
  });

  it("fails closed for non-validator tools without args (case E)", () => {
    const steps = [
      makeStep({ id: "p1", name: "[ACTION] produce", agentId: "a", type: undefined, qaType: undefined, toolNames: undefined }),
      makeStep({ id: "qa-3-def", dependencies: ["p1"], toolNames: ["custom-tool"] }),
    ];
    expect(() => fillStructuralValidatorToolArgs(steps))
      .toThrow(/qa-3-def[\s\S]*toolArgs/);
  });
});

describe("buildPaqoWorkflowSteps structural toolArgs materialization", () => {
  const mission = {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "22222222-2222-4222-8222-222222222222",
    ownerAgentId: "33333333-3333-4333-8333-333333333333",
    title: "2026-08-27 gazua-evening",
  } as never;

  it("fills the validator toolArgs with the materialized producer step id when the plan unit omits toolArgs", () => {
    const draft = {
      missionGoal: "이브닝 리포트 재생성",
      successCriteria: [],
      refs: {
        selectedExecutionUnits: [
          { id: "unit-produce-html", title: "[ACTION] 이브닝 HTML 생성", assigneeAgentId: "44444444-4444-4444-8444-444444444444", sourceRef: { id: "unit-produce-html", type: "mission_plan_unit" } },
          { id: "unit-structural-gate", title: "[QA] 기계 검증", type: "tool", qaType: "structural", toolNames: ["validate-gazua-report-html"], sourceRef: { id: "unit-structural-gate", type: "mission_plan_unit" } },
        ],
      },
      steps: [
        { unitId: "unit-produce-html", dependencies: [] },
        { unitId: "unit-structural-gate", dependencies: ["unit-produce-html"] },
      ],
    } as never;

    const steps = buildPaqoWorkflowSteps(draft, mission, {});

    const gate = steps.find((step) => step.qaType === "structural");
    expect(gate).toBeTruthy();
    expect(gate!.toolArgs).toEqual({
      dir: `{$steps.${steps.find((s) => s.id.startsWith("action"))!.id}.workProductDir}`,
      glob: "*.html",
    });
  });
});

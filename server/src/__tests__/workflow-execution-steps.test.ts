import { describe, expect, it } from "vitest";
import * as dagEngine from "../services/workflow/dag-engine.js";
import * as executionSteps from "../services/workflow/execution-steps.js";
import {
  buildWorkflowExecutionSteps,
  getWorkflowLaunchSteps,
  isDynamicOwnerPlanWorkflowDefinition,
  normalizeWorkflowStepsForExecution,
} from "../services/workflow/dag-engine.js";

/**
 * [목적] dag-engine 의 실행 step 정규화/모드 판정/발주 step 구성 로직에 대한
 *   characterization test. Task5a0 에서 execution-steps.ts 로 순수 추출되며
 *   동작이 1:1 보존되는지 고정한다. mock 없이 실제 함수만 사용.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

describe("normalizeWorkflowStepsForExecution — raw aliases", () => {
  it("trims id/name, keeps unknown JSON fields, and does not mutate the input", () => {
    const raw: Array<Record<string, unknown>> = [
      { id: "  s1  ", name: "  Step One  ", customField: { nested: 1 }, dependencies: [" a1 "] },
    ];
    const out = normalizeWorkflowStepsForExecution(raw);

    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("s1");
    expect(out[0]?.name).toBe("Step One");
    expect(out[0]?.dependencies).toEqual(["a1"]);
    expect(Reflect.get(out[0] as object, "customField")).toEqual({ nested: 1 });
    expect(Reflect.get(out[0] as object, "agentId")).toBe("");
    expect(raw[0]?.id).toBe("  s1  ");
    expect(raw[0]?.name).toBe("  Step One  ");
    expect(raw[0]?.dependencies).toEqual([" a1 "]);
  });

  it("accepts dependsOn string and array aliases when dependencies is missing", () => {
    const fromString = normalizeWorkflowStepsForExecution([{ id: "a", name: "A", dependsOn: "x , y" }]);
    const fromArray = normalizeWorkflowStepsForExecution([{ id: "b", name: "B", dependsOn: ["x"] }]);

    expect(fromString[0]?.dependencies).toEqual(["x", "y"]);
    expect(fromArray[0]?.dependencies).toEqual(["x"]);
    expect(Reflect.get(fromString[0] as object, "dependencies")).toEqual(["x", "y"]);
  });

  it("uses toolNames before tools before toolName (first non-empty alias wins)", () => {
    const allThree = normalizeWorkflowStepsForExecution([
      { id: "a", name: "A", toolNames: ["t1"], tools: ["t2"], toolName: "t3" },
    ]);
    const toolsOnly = normalizeWorkflowStepsForExecution([{ id: "b", name: "B", tools: ["t2"], toolName: "t3" }]);
    const toolNameOnly = normalizeWorkflowStepsForExecution([{ id: "c", name: "C", toolName: "t3" }]);

    expect(allThree[0]?.toolNames).toEqual(["t1"]);
    expect(toolsOnly[0]?.toolNames).toEqual(["t2"]);
    expect(toolNameOnly[0]?.toolNames).toEqual(["t3"]);
    // spread 보존: 정규화되지 않은 raw alias 필드는 그대로 남는다(unknown-field retention).
    expect(Reflect.get(allThree[0] as object, "tools")).toEqual(["t2"]);
    expect(Reflect.get(allThree[0] as object, "toolName")).toBe("t3");
  });

  it("generates a random UUID for a missing id (format + uniqueness), name falls back to title", () => {
    const out = normalizeWorkflowStepsForExecution([{ title: " T " }, {}, "garbage"]);
    const firstId = out[0]?.id ?? "";
    const secondId = out[1]?.id ?? "";

    expect(firstId).toMatch(UUID_RE);
    expect(secondId).toMatch(UUID_RE);
    expect(firstId).not.toBe(secondId);
    expect(out[0]?.name).toBe("T");
    expect(out[1]?.name).toBe("Untitled step");
    expect(out[2]?.id).toMatch(UUID_RE);
  });
});

describe("normalizeWorkflowStepsForExecution — field semantics", () => {
  it("preserves conditional edge values through the normalizer", () => {
    const out = normalizeWorkflowStepsForExecution([
      {
        id: "step-1",
        name: "Step 1",
        conditionalDependencies: [
          { stepId: "qa-1", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
          { stepId: "  action-1  ", when: "failure" },
          { stepId: "drop-me", isBackEdge: true },
        ],
      },
    ]);
    const edges = out[0]?.conditionalDependencies;

    expect(edges).toHaveLength(2);
    expect(edges?.[0]).toEqual({ stepId: "qa-1", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 });
    expect(edges?.[1]).toEqual({ stepId: "action-1", when: "failure" });
  });

  it("marks graphWorkProductRequired true for producers but false for QA-like steps", () => {
    const producer = normalizeWorkflowStepsForExecution([
      { id: "write-report", name: "Write report", workProductRequired: true },
    ]);
    const qa = normalizeWorkflowStepsForExecution([
      { id: "write-report", name: "Write report", workProductRequired: true, qaType: "action" },
    ]);
    const explicitFalse = normalizeWorkflowStepsForExecution([
      { id: "plain", name: "Plain", graphWorkProductRequired: false },
    ]);

    expect(producer[0]?.graphWorkProductRequired).toBe(true);
    expect(qa[0]?.graphWorkProductRequired).toBe(false);
    expect(explicitFalse[0]?.graphWorkProductRequired).toBe(false);
  });

  it("normalizes execution controls: limit strings, priority case, cache flags, graph* fallbacks", () => {
    const out = normalizeWorkflowStepsForExecution([
      {
        id: "ctl",
        name: "Ctl",
        executionControls: { concurrencyLimit: "5", priority: "HIGH", cacheEnabled: true, cacheTtlSeconds: 60, deleteAfterUse: false },
      },
    ]);
    const fallback = normalizeWorkflowStepsForExecution([
      { id: "ctl2", name: "Ctl2", graphConcurrencyKey: " k ", graphDeleteAfterUse: true },
    ]);
    const empty = normalizeWorkflowStepsForExecution([
      { id: "ctl3", name: "Ctl3", executionControls: { concurrencyLimit: 0, priority: "  " } },
    ]);

    expect(out[0]?.executionControls).toEqual({
      concurrencyLimit: 5,
      priority: "high",
      cacheEnabled: true,
      cacheTtlSeconds: 60,
    });
    expect(fallback[0]?.executionControls).toEqual({ concurrencyKey: "k", deleteAfterUse: true });
    // 유효 control 이 없으면 계산된 controls 는 생략되고, raw executionControls 는 spread 로 보존된다.
    expect(Reflect.get(empty[0] as object, "executionControls")).toEqual({ concurrencyLimit: 0, priority: "  " });
  });

  it("keeps autoApproveTools only for the literal true boolean", () => {
    const literalTrue = normalizeWorkflowStepsForExecution([{ id: "a", name: "A", autoApproveTools: true }]);
    const stringTrue = normalizeWorkflowStepsForExecution([{ id: "b", name: "B", autoApproveTools: "true" }]);
    const numericOne = normalizeWorkflowStepsForExecution([{ id: "c", name: "C", autoApproveTools: 1 }]);

    expect(literalTrue[0]?.autoApproveTools).toBe(true);
    expect(Reflect.get(stringTrue[0] as object, "autoApproveTools")).toBeUndefined();
    expect(Reflect.get(numericOne[0] as object, "autoApproveTools")).toBeUndefined();
  });
});

describe("isDynamicOwnerPlanWorkflowDefinition", () => {
  it("explicit static mode overrides dynamic step markers", () => {
    expect(isDynamicOwnerPlanWorkflowDefinition({
      name: "wf",
      steps: [{ id: "plan", name: "Plan", dependencies: [], dynamicChildren: true }],
      executionMode: "static_dag",
    })).toBe(false);
    expect(isDynamicOwnerPlanWorkflowDefinition({
      name: "wf",
      steps: [{ id: "plan", name: "Plan", dependencies: [], bootstrapOnly: true }],
      workflowMode: "static_dag",
    })).toBe(false);
  });

  it("explicit dynamic mode or bootstrap flag returns true", () => {
    expect(isDynamicOwnerPlanWorkflowDefinition({ name: "wf", executionMode: "dynamic_owner_plan" })).toBe(true);
    expect(isDynamicOwnerPlanWorkflowDefinition({ name: "wf", workflowMode: "dynamic_owner_plan" })).toBe(true);
    expect(isDynamicOwnerPlanWorkflowDefinition({ name: "wf", dynamicPlanBootstrapOnly: true })).toBe(true);
    expect(isDynamicOwnerPlanWorkflowDefinition({
      name: "wf",
      steps: [{ id: "boot", name: "Boot", dependencies: [], bootstrapOnly: "true" }],
    })).toBe(true);
  });

  it("legacy tech-scout family names need a root planning step for dynamic inference", () => {
    const rootPlan = { id: "plan", name: "Daily plan", dependencies: [] };
    const dependentStep = { id: "scout", name: "Scout", dependencies: ["plan"] };

    expect(isDynamicOwnerPlanWorkflowDefinition({ name: "tech-scout", steps: [rootPlan] })).toBe(true);
    expect(isDynamicOwnerPlanWorkflowDefinition({ name: "Daily-Tech-AI-News ", steps: [rootPlan] })).toBe(true);
    expect(isDynamicOwnerPlanWorkflowDefinition({ name: "tech-scout", steps: [dependentStep] })).toBe(false);
    expect(isDynamicOwnerPlanWorkflowDefinition({ name: "other-workflow", steps: [rootPlan] })).toBe(false);
  });
});

describe("getWorkflowLaunchSteps", () => {
  const steps = [
    { id: "root", name: "Root", dependencies: [] },
    { id: "child", name: "Child", dependencies: ["root"] },
    { id: "esc", name: "Escalation", dependencies: [], triggerOn: "escalation" },
  ];

  it("returns all steps in static mode and filters dependents/escalation in dynamic mode", () => {
    expect(getWorkflowLaunchSteps(steps)).toHaveLength(3);
    const launch = getWorkflowLaunchSteps(steps, { dynamicOwnerPlan: true });
    expect(launch.map((step) => step.id)).toEqual(["root"]);
  });
});

describe("buildWorkflowExecutionSteps — delivery gate synthesis", () => {
  it("appends exactly one delivery-verification-gate for a static manual-onboarding-publish step", () => {
    const steps = buildWorkflowExecutionSteps({
      name: "company-site",
      stepsJson: [{ id: "manual-onboarding-publish", name: "Publish onboarding hub", agentId: "agent-1" }],
    });
    const gates = steps.filter((step) => step.id === "delivery-verification-gate");

    expect(steps).toHaveLength(2);
    expect(gates).toHaveLength(1);
    expect(gates[0]?.dependencies).toEqual(["manual-onboarding-publish"]);
    expect(gates[0]?.agentId).toBe("agent-1");
    expect(gates[0]?.qaType).toBe("delivery");
    expect(gates[0]?.graphWorkProductRequired).toBe(false);
  });

  it("strengthens an existing downstream typed delivery QA instead of adding a duplicate gate", () => {
    const steps = buildWorkflowExecutionSteps({
      name: "company-site",
      stepsJson: [
        { id: "manual-onboarding-publish", name: "Publish onboarding hub", agentId: "agent-1" },
        { id: "verify-publish", name: "Verify publish", qaType: "delivery", dependencies: ["manual-onboarding-publish"], agentId: "qa-agent" },
      ],
    });

    expect(steps.filter((step) => step.id === "delivery-verification-gate")).toHaveLength(0);
    expect(steps).toHaveLength(2);
    expect(steps.find((step) => step.id === "verify-publish")?.description).toContain("Delivery Verification:");
  });

  it("dynamic version of the same delivery input produces no synthetic gate", () => {
    const steps = buildWorkflowExecutionSteps({
      name: "company-site",
      executionMode: "dynamic_owner_plan",
      stepsJson: [{ id: "manual-onboarding-publish", name: "Publish onboarding hub", agentId: "agent-1" }],
    });

    expect(steps.some((step) => step.id === "delivery-verification-gate")).toBe(false);
  });

  it("a generic publish step alone produces no gate", () => {
    const steps = buildWorkflowExecutionSteps({
      name: "generic",
      stepsJson: [{ id: "publish", name: "Publish", agentId: "agent-1" }],
    });

    expect(steps.some((step) => step.id === "delivery-verification-gate")).toBe(false);
  });
});

describe("execution-steps module surface (caller compatibility)", () => {
  it("re-exports the same function objects from dag-engine and execution-steps", () => {
    expect(executionSteps.normalizeWorkflowStepsForExecution).toBe(dagEngine.normalizeWorkflowStepsForExecution);
    expect(executionSteps.isDynamicOwnerPlanWorkflowDefinition).toBe(dagEngine.isDynamicOwnerPlanWorkflowDefinition);
    expect(executionSteps.getWorkflowLaunchSteps).toBe(dagEngine.getWorkflowLaunchSteps);
    expect(executionSteps.buildWorkflowExecutionSteps).toBe(dagEngine.buildWorkflowExecutionSteps);
  });

  it("both import paths yield identical results for the same input", () => {
    const raw = [{ id: " shared ", name: "Shared", dependsOn: "a" }];

    expect(executionSteps.normalizeWorkflowStepsForExecution(raw))
      .toEqual(dagEngine.normalizeWorkflowStepsForExecution(raw));
    const definition = {
      name: "company-site",
      stepsJson: [{ id: "manual-onboarding-publish", name: "Publish onboarding hub", agentId: "agent-1" }],
    };
    expect(executionSteps.buildWorkflowExecutionSteps(definition))
      .toEqual(dagEngine.buildWorkflowExecutionSteps(definition));
  });
});

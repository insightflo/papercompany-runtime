import { describe, expect, it } from "vitest";
import { workflowDefinitionSchema, workflowStepDefinitionSchema } from "./workflow.js";

describe("workflowStepDefinitionSchema — workflow child step fields", () => {
  it("accepts a workflow-type step with targetWorkflowId, wait, and inputs", () => {
    const result = workflowStepDefinitionSchema.safeParse({
      id: "run-child",
      type: "workflow",
      dependencies: [],
      targetWorkflowId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      wait: true,
      inputs: { topic: "n8n execute workflow" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.targetWorkflowId).toBe("3f2504e0-4f89-11d3-9a0c-0305e82c3301");
      expect(result.data.wait).toBe(true);
      expect(result.data.inputs).toEqual({ topic: "n8n execute workflow" });
    }
  });

  it("accepts omitted wait and inputs (executor defaults wait to true)", () => {
    const result = workflowStepDefinitionSchema.safeParse({
      id: "run-child",
      type: "workflow",
      dependencies: [],
      targetWorkflowId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    });
    expect(result.success).toBe(true);
  });

  it("rejects type workflow without targetWorkflowId", () => {
    const result = workflowStepDefinitionSchema.safeParse({
      id: "run-child",
      type: "workflow",
      dependencies: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.issues.filter((issue) => issue.path.includes("targetWorkflowId"));
      expect(issues.length).toBeGreaterThan(0);
    }
  });

  it("does not require targetWorkflowId for non-workflow steps", () => {
    const result = workflowStepDefinitionSchema.safeParse({
      id: "agent-1",
      type: "agent",
      agentId: "",
    });
    expect(result.success).toBe(true);
  });

  it("rejects more than 20 inputs keys", () => {
    const inputs = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`key${i}`, "v"]),
    );
    const result = workflowStepDefinitionSchema.safeParse({
      id: "run-child",
      type: "workflow",
      dependencies: [],
      targetWorkflowId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      inputs,
    });
    expect(result.success).toBe(false);
  });

  it("rejects input values longer than 500 chars", () => {
    const result = workflowStepDefinitionSchema.safeParse({
      id: "run-child",
      type: "workflow",
      dependencies: [],
      targetWorkflowId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      inputs: { long: "x".repeat(501) },
    });
    expect(result.success).toBe(false);
  });

  it("graph editor round-trip: a saved workflow-type step parses back with fields intact", () => {
    // 편집기 저장 → 서버 검증 → 재로딩 라운드트립. passthrough 로 알 수 없는 필드가
    // 유실되지 않는다는 계약(그래프 편집기 load/save 가 깨지지 않는다)을 잠근다.
    const savedSteps = [
      {
        id: "run-child",
        title: "Run child workflow",
        type: "workflow",
        dependsOn: [],
        targetWorkflowId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
        wait: false,
        inputs: { q: "{$runDate}" },
      },
      {
        id: "ordinary",
        title: "Ordinary agent step",
        type: "agent",
        dependsOn: ["run-child"],
      },
    ];
    const parsed = workflowDefinitionSchema.safeParse({
      id: "9f2504e0-4f89-11d3-9a0c-0305e82c3302",
      companyId: "af2504e0-4f89-11d3-9a0c-0305e82c3303",
      name: "parent-wf",
      description: null,
      steps: savedSteps,
      schedule: null,
      timezone: null,
      deadlineTime: null,
      lastScheduledRunAt: null,
      lastScheduleError: null,
      lastScheduleErrorAt: null,
      timeoutMinutes: null,
      maxDailyRuns: null,
      maxConcurrentRuns: null,
      triggerLabels: [],
      labelIds: [],
      projectId: null,
      goalId: null,
      dynamicPlanBootstrapOnly: false,
      legacyMetadata: {},
      createParentIssuePolicy: null,
      executionMode: null,
      source: null,
      sourceKind: null,
      legacyPluginEntityId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const roundTripped = parsed.data.steps[0];
      expect(roundTripped.type).toBe("workflow");
      expect(roundTripped.targetWorkflowId).toBe("3f2504e0-4f89-11d3-9a0c-0305e82c3301");
      expect(roundTripped.wait).toBe(false);
      expect(roundTripped.inputs).toEqual({ q: "{$runDate}" });
    }
  });
});

import { describe, expect, it } from "vitest";
import { workflowDefinitionSchema, workflowStepDefinitionSchema } from "./workflow.js";

const TARGET = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

function workflowStep(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "run-child",
    type: "workflow",
    dependencies: [],
    targetWorkflowId: TARGET,
    ...extra,
  };
}

describe("workflowStepDefinitionSchema — workflow child step fields", () => {
  it("accepts a workflow-type step with targetWorkflowId, wait:true, and inputs", () => {
    const result = workflowStepDefinitionSchema.safeParse(
      workflowStep({ wait: true, inputs: { topic: "n8n execute workflow" } }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.targetWorkflowId).toBe(TARGET);
      expect(result.data.wait).toBe(true);
      expect(result.data.inputs).toEqual({ topic: "n8n execute workflow" });
    }
  });

  it("accepts omitted wait and inputs (descope v1: omission normalizes to wait:true)", () => {
    const result = workflowStepDefinitionSchema.safeParse(workflowStep());
    expect(result.success).toBe(true);
  });

  it("rejects wait:false on workflow steps (fire-and-forget removed by descope v1)", () => {
    const result = workflowStepDefinitionSchema.safeParse(workflowStep({ wait: false }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.issues.filter((issue) => issue.path.includes("wait"));
      expect(issues.length).toBeGreaterThan(0);
    }
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
    const result = workflowStepDefinitionSchema.safeParse(workflowStep({ inputs }));
    expect(result.success).toBe(false);
  });

  it("rejects input values longer than 500 chars", () => {
    const result = workflowStepDefinitionSchema.safeParse(
      workflowStep({ inputs: { long: "x".repeat(501) } }),
    );
    expect(result.success).toBe(false);
  });

  // [descope v1 D2] workflow 스텝 정책 재시도 금지 — 공급 자체(0/false 포함)가 계약 위반.
  describe("forbidden retry-field matrix on workflow steps", () => {
    const forbidden: Array<[string, unknown]> = [
      ["onFailure", "retry"],
      ["maxRetries", 3],
      ["maxRetries", 0],
      ["graphRetryDelaySeconds", 30],
      ["graphRetryDelaySeconds", 0],
      ["graphRetryBackoff", "fixed"],
      ["graphRetryBackoff", "exponential"],
      ["graphRetryJitter", true],
      ["graphRetryJitter", false],
    ];

    it.each(forbidden)("%s=%p is rejected on a workflow-type step", (field, value) => {
      const result = workflowStepDefinitionSchema.safeParse(workflowStep({ [field]: value }));
      expect(result.success).toBe(false);
      if (!result.success) {
        const issues = result.error.issues.filter((issue) => issue.path.includes(field));
        expect(issues.length).toBeGreaterThan(0);
      }
    });

    it("accepts retry policy on non-workflow steps (unchanged agent/tool contract)", () => {
      const result = workflowStepDefinitionSchema.safeParse({
        id: "agent-1",
        type: "agent",
        agentId: "",
        onFailure: "retry",
        maxRetries: 2,
        graphRetryDelaySeconds: 5,
        graphRetryBackoff: "linear",
        graphRetryJitter: false,
      });
      expect(result.success).toBe(true);
    });

    it("accepts non-retry onFailure values on workflow steps", () => {
      const result = workflowStepDefinitionSchema.safeParse(workflowStep({ onFailure: "fail" }));
      expect(result.success).toBe(true);
    });
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
        targetWorkflowId: TARGET,
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
      expect(roundTripped.targetWorkflowId).toBe(TARGET);
      expect(roundTripped.inputs).toEqual({ q: "{$runDate}" });
    }
  });

  it("round-trip refuses a saved draft carrying wait:false or retry policy (import guard)", () => {
    const savedSteps = [
      workflowStep({ wait: false }),
      workflowStep({ id: "run-child-2", onFailure: "retry", maxRetries: 1 }),
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
    expect(parsed.success).toBe(false);
  });
});

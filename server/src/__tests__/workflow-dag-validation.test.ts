import { describe, it, expect, vi } from "vitest";

// Mock @paperclipai/db to prevent the postgres transitive import from breaking vitest
vi.mock("@paperclipai/db", () => ({
  workflowDefinitions: {},
  workflowRuns: {},
  workflowStepRuns: {},
  // [cycle A] 자식 시작 모듈이 import 하는 invocation 스키마 — 모킹 누락 방지.
  workflowStepInvocations: {},
  issues: {},
  heartbeatRuns: {
    id: {},
    companyId: {},
    agentId: {},
    invocationSource: {},
    triggerDetail: {},
    status: {},
    startedAt: {},
    finishedAt: {},
    error: {},
    wakeupRequestId: {},
    exitCode: {},
    signal: {},
    usageJson: {},
    resultJson: {},
    sessionIdBefore: {},
    sessionIdAfter: {},
    issueId: {},
    createdAt: {},
    contextSnapshot: {},
  },
  toolDefinitions: {},
  toolAuditLog: {},
  agents: {},
  knowledgeBases: {},
  agentKbGrants: {},
}));

import { validateDag } from "../services/workflow/dag-engine.js";
import type { WorkflowStep } from "../services/workflow/dag-engine.js";

describe("validateDag", () => {
  it("accepts a valid linear DAG with no cycles", () => {
    const steps: WorkflowStep[] = [
      { id: "a", name: "Step A", agentId: "agent-1", dependencies: [] },
      { id: "b", name: "Step B", agentId: "agent-1", dependencies: ["a"] },
      { id: "c", name: "Step C", agentId: "agent-1", dependencies: ["b"] },
    ];

    const result = validateDag(steps);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts a valid diamond-shaped DAG", () => {
    const steps: WorkflowStep[] = [
      { id: "start", name: "Start", agentId: "agent-1", dependencies: [] },
      { id: "left", name: "Left",  agentId: "agent-1", dependencies: ["start"] },
      { id: "right", name: "Right", agentId: "agent-1", dependencies: ["start"] },
      { id: "end", name: "End", agentId: "agent-1", dependencies: ["left", "right"] },
    ];

    const result = validateDag(steps);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("detects a simple two-node cycle (a → b → a)", () => {
    const steps: WorkflowStep[] = [
      { id: "a", name: "Step A", agentId: "agent-1", dependencies: ["b"] },
      { id: "b", name: "Step B", agentId: "agent-1", dependencies: ["a"] },
    ];

    const result = validateDag(steps);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /cycle/i.test(e))).toBe(true);
  });

  it("detects a three-node cycle", () => {
    const steps: WorkflowStep[] = [
      { id: "a", name: "A", agentId: "x", dependencies: ["c"] },
      { id: "b", name: "B", agentId: "x", dependencies: ["a"] },
      { id: "c", name: "C", agentId: "x", dependencies: ["b"] },
    ];

    const result = validateDag(steps);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /cycle/i.test(e))).toBe(true);
  });

  it("rejects a step that references a non-existent dependency", () => {
    const steps: WorkflowStep[] = [
      { id: "a", name: "A", agentId: "x", dependencies: [] },
      { id: "b", name: "B", agentId: "x", dependencies: ["does-not-exist"] },
    ];

    const result = validateDag(steps);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /does-not-exist/.test(e))).toBe(true);
  });

  it("rejects duplicate step IDs", () => {
    const steps: WorkflowStep[] = [
      { id: "a", name: "A1", agentId: "x", dependencies: [] },
      { id: "a", name: "A2", agentId: "x", dependencies: [] },
    ];

    const result = validateDag(steps);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /duplicate/i.test(e))).toBe(true);
  });

  it("rejects invalid native IF/Complete topology at the DAG validation boundary", () => {
    const steps: WorkflowStep[] = [
      { id: "producer", name: "Producer", agentId: "agent-1", dependencies: [] },
      {
        id: "if",
        name: "IF",
        type: "if",
        agentId: "",
        dependencies: ["producer"],
        conditionGroup: {
          combinator: "all",
          conditions: [{
            source: { kind: "work_product_json", stepId: "producer", title: "decision.json", path: "$.status" },
            dataType: "string",
            operator: "equals",
            rightValue: "selected",
          }],
        },
      },
      { id: "legacy-output", name: "Legacy output", agentId: "agent-1", dependencies: ["if"] },
      {
        id: "true-output",
        name: "True output",
        agentId: "agent-1",
        dependencies: [],
        conditionalDependencies: [{ stepId: "if", when: "condition_true" }],
      },
      {
        id: "complete",
        name: "Complete",
        type: "complete",
        agentId: "",
        dependencies: [],
        conditionalDependencies: [{ stepId: "if", when: "condition_false" }],
      },
    ];

    const result = validateDag(steps);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining("condition_true or condition_false"));
  });

  it("returns valid with empty warnings for an empty DAG", () => {
    const result = validateDag([]);

    // An empty workflow is considered valid (nothing to violate)
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("reports an error when all steps have dependencies (no entry points)", () => {
    const steps: WorkflowStep[] = [
      { id: "a", name: "A", agentId: "x", dependencies: ["b"] },
      { id: "b", name: "B", agentId: "x", dependencies: ["a"] },
    ];

    const result = validateDag(steps);

    // Either a cycle or no-entry-point error must be raised
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

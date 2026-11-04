import { describe, expect, it, vi } from "vitest";

const { heartbeatWakeup } = vi.hoisted(() => ({
  heartbeatWakeup: vi.fn(),
}));

vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return {
    ...actual,
    heartbeatService: () => ({
      wakeup: heartbeatWakeup,
    }),
  };
});

vi.mock("../services/issue-assignment-wakeup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issue-assignment-wakeup.js")>();
  return {
    ...actual,
    queueIssueAssignmentWakeup: (
      input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0],
    ) => actual.queueIssueAssignmentWakeup({
      ...input,
      heartbeat: { wakeup: heartbeatWakeup },
    }),
  };
});

import { normalizeWorkflowStepsForExecution } from "../services/workflow/dag-engine.js";

describe("normalizeWorkflowStepsForExecution", () => {
  it("normalizes legacy plugin workflow step payloads for native DAG execution", () => {
    expect(
      normalizeWorkflowStepsForExecution([
        {
          id: "generate-infographic",
          title: "Tech Scout 교육만화 생성",
          tools: ["generate-tech-scout-knowledge-comic"],
          dependsOn: ["scout-and-report"],
        },
        {
          id: "send-telegram",
          title: "텔레그램으로 PNG 전송",
          toolName: "send-telegram",
          dependsOn: ["generate-infographic"],
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: "generate-infographic",
        name: "Tech Scout 교육만화 생성",
        agentId: "",
        dependencies: ["scout-and-report"],
        toolNames: ["generate-tech-scout-knowledge-comic"],
      }),
      expect.objectContaining({
        id: "send-telegram",
        name: "텔레그램으로 PNG 전송",
        agentId: "",
        dependencies: ["generate-infographic"],
        toolNames: ["send-telegram"],
      }),
    ]);
  });

  it("coerces graphWorkProductRequired to a strict boolean (legacy string absorbed, default false)", () => {
    const normalized = normalizeWorkflowStepsForExecution([
      { id: "producer", graphWorkProductRequired: true },
      { id: "producer-legacy-string", graphWorkProductRequired: "true" },
      { id: "producer-legacy-alias", workProductRequired: true },
      { id: "producer-requires-alias", requiresWorkProduct: "1" },
      { id: "validator", graphWorkProductRequired: false },
      { id: "legacy-false-alias", workProductRequired: false },
      { id: "unset" },
      { id: "garbage-string", graphWorkProductRequired: "false" },
    ]);
    expect(normalized.map((s) => s.graphWorkProductRequired)).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it("forces persisted QA steps to use verdict gates even when legacy data requires a workProduct", () => {
    const normalized = normalizeWorkflowStepsForExecution([
      { id: "inspection", qaType: "semantic", title: "Final inspection", graphWorkProductRequired: true },
      { id: "qa-legacy", qaType: "semantic", title: "Legacy QA", graphWorkProductRequired: "true" },
      { id: "qa-agent", qaType: "semantic", title: "QA agent step", type: "agent", graphWorkProductRequired: true },
      { id: "materialize-report", title: "Materialize report", graphWorkProductRequired: true },
    ]);

    expect(normalized.map((step) => step.graphWorkProductRequired)).toEqual([false, false, false, true]);
  });

  it("preserves workProduct requirements for explicitly labeled ACTION steps", () => {
    const normalized = normalizeWorkflowStepsForExecution([
      { id: "source-audit", title: "[ACTION] Audit supplied article and produce evidence package", graphWorkProductRequired: true },
      { id: "verify-destination", title: "[ACTION] Verify published manual destination readback", graphWorkProductRequired: true },
      { id: "final-review", title: "[ACTION] Final review findings and publish corrections", graphWorkProductRequired: true },
    ]);

    expect(normalized.map((step) => step.graphWorkProductRequired)).toEqual([true, true, true]);
  });

  it("normalizes workflow graph execution controls into the native runtime contract", () => {
    expect(
      normalizeWorkflowStepsForExecution([
        {
          id: "report",
          title: "Market report",
          type: "agent",
          graphConcurrencyKey: " market-report ",
          graphConcurrencyLimit: "2",
          graphPriority: "HIGH",
          graphCacheEnabled: "true",
          graphCacheTtlSeconds: "600",
          graphDeleteAfterUse: true,
        },
        {
          id: "publish",
          title: "Publish",
          dependsOn: ["report"],
          executionControls: {
            concurrencyKey: "publisher",
            concurrencyLimit: 1,
            priority: "critical",
          },
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: "report",
        name: "Market report",
        dependencies: [],
        executionControls: {
          concurrencyKey: "market-report",
          concurrencyLimit: 2,
          priority: "high",
          cacheEnabled: true,
          cacheTtlSeconds: 600,
          deleteAfterUse: true,
        },
      }),
      expect.objectContaining({
        id: "publish",
        name: "Publish",
        dependencies: ["report"],
        executionControls: {
          concurrencyKey: "publisher",
          concurrencyLimit: 1,
          priority: "critical",
        },
      }),
    ]);
  });
});

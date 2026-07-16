import { describe, expect, it, vi } from "vitest";
import type { WorkflowStep } from "../services/workflow/dag-engine.js";

const mockWorkflowService = vi.hoisted(() => ({
  listDefinitions: vi.fn(),
  listRuns: vi.fn(),
  updateDefinition: vi.fn(),
}));

vi.mock("../services/workflow/engine.js", () => ({ workflowService: mockWorkflowService }));

import {
  enableQaCapAcceptanceForCompany,
  enableQaCapAcceptanceInSteps,
} from "../services/workflow/qa-cap-acceptance-rollout.js";

function step(input: Partial<WorkflowStep> & Pick<WorkflowStep, "id" | "name">): WorkflowStep {
  return {
    agentId: "agent-1",
    dependencies: [],
    ...input,
  };
}

describe("QA cap acceptance rollout", () => {
  it("enables only eligible semantic QA back-edges", () => {
    const result = enableQaCapAcceptanceInSteps([
      step({
        id: "producer",
        name: "Build report",
        conditionalDependencies: [
          { stepId: "qa", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
          { stepId: "structural", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
          { stepId: "verify-publish", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
        ],
      }),
      step({ id: "qa", name: "[QA] Review report", dependencies: ["producer"] }),
      step({
        id: "structural",
        name: "Structural contract",
        agentId: "",
        type: "tool",
        qaType: "structural",
        toolNames: ["validate-report"],
        dependencies: ["producer"],
      }),
      step({ id: "verify-publish", name: "Verify publish public readback", dependencies: ["producer"] }),
    ]);

    expect(result.updatedQaEdges).toBe(1);
    expect(result.steps[0]!.conditionalDependencies).toEqual([
      { stepId: "qa", when: "qa_request_changes", isBackEdge: true, maxIterations: 2, allowCapAcceptance: true },
      { stepId: "structural", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
      { stepId: "verify-publish", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
    ]);
  });

  it("updates active definitions without active runs and is idempotent", async () => {
    const semanticSteps = [
      step({
        id: "producer",
        name: "Build",
        conditionalDependencies: [{ stepId: "qa", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 }],
      }),
      step({ id: "qa", name: "[QA] Review", dependencies: ["producer"] }),
    ];
    mockWorkflowService.listDefinitions.mockResolvedValue([
      { id: "wf-update", status: "active", steps: semanticSteps },
      { id: "wf-running", status: "active", steps: semanticSteps },
      { id: "wf-archived", status: "archived", steps: semanticSteps },
    ]);
    mockWorkflowService.listRuns.mockResolvedValue([
      { workflowId: "wf-running", status: "running" },
      { workflowId: "wf-update", status: "completed" },
    ]);
    mockWorkflowService.updateDefinition.mockResolvedValue({ id: "wf-update" });

    const first = await enableQaCapAcceptanceForCompany({} as never, "company-1");
    expect(first).toEqual({
      inspectedWorkflows: 2,
      updatedWorkflows: 1,
      updatedQaEdges: 1,
      skippedActiveWorkflows: 1,
    });
    expect(mockWorkflowService.updateDefinition).toHaveBeenCalledTimes(1);
    expect(mockWorkflowService.updateDefinition).toHaveBeenCalledWith(
      expect.anything(),
      "wf-update",
      { steps: expect.any(Array) },
    );

    const updatedSteps = mockWorkflowService.updateDefinition.mock.calls[0]![2].steps;
    mockWorkflowService.listDefinitions.mockResolvedValue([
      { id: "wf-update", status: "active", steps: updatedSteps },
    ]);
    mockWorkflowService.listRuns.mockResolvedValue([]);
    mockWorkflowService.updateDefinition.mockClear();

    await expect(enableQaCapAcceptanceForCompany({} as never, "company-1")).resolves.toEqual({
      inspectedWorkflows: 1,
      updatedWorkflows: 0,
      updatedQaEdges: 0,
      skippedActiveWorkflows: 0,
    });
    expect(mockWorkflowService.updateDefinition).not.toHaveBeenCalled();
  });
});

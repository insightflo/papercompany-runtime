import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  applyStepRunsToGraphSteps,
  buildWorkflowGraphModel,
  disconnectSteps,
  insertWorkflowStepFromPalette,
  updateStepAdvancedMetadata,
  type WorkflowGraphStep,
} from "./workflow-graph";
import { GraphInspectorPolicyAdvanced } from "./graph-editor/GraphInspectorPolicyAdvanced";
import { jsonToSteps, stepsToJson } from "./step-draft-serialization";

describe("workflow graph helpers", () => {
  it("removes a selected edge dependency and its edge metadata", () => {
    const steps: WorkflowGraphStep[] = [
      { id: "collect", title: "Collect" },
      {
        id: "synthesize",
        title: "Synthesize",
        dependsOn: "collect, scout",
        graphEdgeMetadata: {
          collect: { kind: "conditional", label: "ready" },
          scout: { kind: "conditional", label: "fallback" },
        },
      },
    ];

    const next = disconnectSteps(steps, "collect", "synthesize");

    expect(next[1]?.dependsOn).toBe("scout");
    expect(next[1]?.graphEdgeMetadata).toEqual({ scout: { kind: "conditional", label: "fallback", condition: "" } });
  });
});

describe("native control nodes in the workflow graph", () => {
  it("renders condition_true and condition_false dependencies as labelled graph edges", () => {
    const graph = buildWorkflowGraphModel([
      { id: "if-1", title: "IF", type: "if" },
      { id: "yes", title: "Yes", conditionalDependencies: [{ stepId: "if-1", when: "condition_true" }] },
      { id: "no", title: "No", type: "complete", conditionalDependencies: [{ stepId: "if-1", when: "condition_false" }] },
    ]);
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "if-1", target: "yes", when: "condition_true", label: "true" }),
      expect.objectContaining({ source: "if-1", target: "no", when: "condition_false", label: "false" }),
    ]));
  });

  it("adds IF and Complete palette templates", () => {
    const withIf = insertWorkflowStepFromPalette([], null, "if");
    const withComplete = insertWorkflowStepFromPalette(withIf, null, "complete");
    expect(withComplete).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "if", type: "if", conditionGroup: expect.any(Object) }),
      expect.objectContaining({ id: "complete", type: "complete", dependsOn: "" }),
    ]));
  });

  it("maps persisted IF outcomes into the run overlay", () => {
    const [step] = applyStepRunsToGraphSteps(
      [{ id: "if-1", title: "IF", type: "if" }] as WorkflowGraphStep[],
      [{
        id: "run-1",
        stepId: "if-1",
        status: "completed",
        metadata: { controlNodeResult: { nodeType: "if", outcome: "condition_true" } },
      }],
    );
    expect(step?.graphRunControlOutcome).toBe("condition_true");
  });
});

describe("StepDraft.extra conditional dependencies", () => {
  it("renders the condition_false edge to a Complete node from extra.conditionalDependencies", () => {
    const drafts = jsonToSteps([
      { id: "if-1", title: "IF", type: "if" },
      {
        id: "complete-1",
        title: "Done",
        type: "complete",
        conditionalDependencies: [{ stepId: "if-1", when: "condition_false" }],
      },
    ]);
    expect(drafts.find((step) => step.id === "complete-1")?.extra.conditionalDependencies).toEqual([
      { stepId: "if-1", when: "condition_false" },
    ]);
    const graph = buildWorkflowGraphModel(drafts);
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "if-1->complete-1:condition_false",
        source: "if-1",
        target: "complete-1",
        when: "condition_false",
        label: "false",
      }),
    ]));
  });

  it("dedupes by stepId+when and excludes back-edges", () => {
    const drafts = jsonToSteps([
      { id: "if-1", title: "IF", type: "if" },
      { id: "agent-1", title: "Agent", type: "agent" },
      {
        id: "target",
        title: "Target",
        type: "agent",
        conditionalDependencies: [
          { stepId: "if-1", when: "condition_true" },
          { stepId: "if-1", when: "condition_true" },
          { stepId: "if-1", when: "condition_false" },
          { stepId: "agent-1", when: "qa_request_changes", isBackEdge: true },
        ],
      },
    ]);
    const graph = buildWorkflowGraphModel(drafts);
    const conditionalEdges = graph.edges.filter((edge) => edge.source === "if-1" && edge.target === "target");
    expect(conditionalEdges.map((edge) => edge.when).sort()).toEqual(["condition_false", "condition_true"]);
    expect(graph.edges.some((edge) => edge.source === "agent-1" && edge.target === "target")).toBe(false);
  });
});

describe("workflow graph retry settings", () => {
  it("reads default maxRetries as 2 when onFailure is retry", () => {
    const graph = buildWorkflowGraphModel([
      { id: "step-1", title: "Step 1", onFailure: "retry" },
    ]);
    const node = graph.nodes[0];
    expect(node?.advanced?.onFailure).toBe("retry");
    expect(node?.advanced?.maxRetries).toBe(null); // No explicit value → null (editor shows default 2)
  });

  it("reads explicit maxRetries 0", () => {
    const graph = buildWorkflowGraphModel([
      { id: "step-1", title: "Step 1", onFailure: "retry", maxRetries: 0 },
    ]);
    expect(graph.nodes[0]?.advanced?.maxRetries).toBe(0);
  });

  it("reads all backoff choices", () => {
    for (const backoff of ["fixed", "linear", "exponential"]) {
      const graph = buildWorkflowGraphModel([
        { id: "step-1", onFailure: "retry", graphRetryBackoff: backoff },
      ]);
      expect(graph.nodes[0]?.advanced?.retryBackoff).toBe(backoff);
    }
  });

  it("keeps a zero retry delay through advanced updates and draft serialization", () => {
    const updated = updateStepAdvancedMetadata(
      [{
        id: "step-1",
        title: "Step 1",
        onFailure: "retry",
        graphRetryDelaySeconds: 30,
      }],
      "step-1",
      { retryDelaySeconds: 0 },
    );

    const [draft] = jsonToSteps([{
      id: updated[0]!.id,
      title: updated[0]!.title,
      onFailure: updated[0]!.onFailure,
      graphRetryDelaySeconds: updated[0]!.graphRetryDelaySeconds,
    }]);
    const [serialized] = stepsToJson([draft]) as Array<Record<string, unknown>>;

    expect(updated[0]?.graphRetryDelaySeconds).toBe(0);
    expect(draft?.graphRetryDelaySeconds).toBe("0");
    expect(serialized).toMatchObject({ graphRetryDelaySeconds: 0 });
  });

  it("shows retry badge with default 2 when onFailure is retry", () => {
    const graph = buildWorkflowGraphModel([
      { id: "step-1", onFailure: "retry" },
    ]);
    expect(graph.nodes[0]?.advanced?.badges).toContain("Retry x2");
  });

  it("preserves saved retry settings when retry is inactive", () => {
    const updated = updateStepAdvancedMetadata(
      [{
        id: "step-1",
        onFailure: "retry",
        graphRetryDelaySeconds: 0,
        graphRetryBackoff: "linear",
        graphRetryJitter: true,
      }],
      "step-1",
      { onFailure: "skip" },
    );

    expect(updated[0]).toMatchObject({
      onFailure: "skip",
      graphRetryDelaySeconds: 0,
      graphRetryBackoff: "linear",
      graphRetryJitter: true,
    });
  });

  it("disables inactive retry controls in the policy inspector", () => {
    const [step] = jsonToSteps([{
      id: "step-1",
      title: "Step 1",
      onFailure: "skip",
      graphRetryDelaySeconds: 0,
      graphRetryBackoff: "linear",
      graphRetryJitter: true,
    }]);

    const markup = renderToStaticMarkup(createElement(GraphInspectorPolicyAdvanced, {
      selectedStep: step!,
      updateSelectedAdvanced: () => {},
    }));

    expect(markup).toContain("Fixed (default)");
    expect(markup.match(/\bdisabled=""/g)).toHaveLength(3);
  });
});

describe("workflow graph retry run status", () => {
  it("reads retryCount and workflowRetry metadata from step runs", () => {
    const [step] = applyStepRunsToGraphSteps(
      [{ id: "worker", onFailure: "retry", maxRetries: 2 }] as WorkflowGraphStep[],
      [{
        id: "run-1",
        stepId: "worker",
        status: "pending",
        retryCount: 1,
        metadata: {
          workflowRetry: {
            state: "waiting",
            retryNumber: 1,
            maxRetries: 2,
            nextEligibleAt: "2026-07-22T12:00:00.000Z",
          },
        },
      }],
    );
    expect(step?.graphRunRetryCount).toBe(1);
    expect(step?.graphRunRetryMaxRetries).toBe(2);
    expect(step?.graphRunRetryState).toBe("waiting");
    expect(step?.graphRunRetryNextEligibleAt).toBe("2026-07-22T12:00:00.000Z");
  });

  it("defaults retry fields to 0/empty when no retry metadata", () => {
    const [step] = applyStepRunsToGraphSteps(
      [{ id: "worker" }] as WorkflowGraphStep[],
      [{ id: "run-1", stepId: "worker", status: "completed" }],
    );
    expect(step?.graphRunRetryCount).toBe(0);
    expect(step?.graphRunRetryMaxRetries).toBe(0);
    expect(step?.graphRunRetryState).toBe("");
    expect(step?.graphRunRetryNextEligibleAt).toBe("");
  });

  it("surfaces retry state in graph model run status", () => {
    const graph = buildWorkflowGraphModel(
      applyStepRunsToGraphSteps(
        [{ id: "worker", onFailure: "retry", maxRetries: 3 }] as WorkflowGraphStep[],
        [{
          id: "run-1",
          stepId: "worker",
          status: "pending",
          retryCount: 2,
          metadata: {
            workflowRetry: {
              state: "dispatching",
              retryNumber: 2,
              maxRetries: 3,
              nextEligibleAt: "2026-07-22T12:00:00.000Z",
            },
          },
        }],
      ),
    );
    const runStatus = graph.nodes[0]?.runStatus;
    expect(runStatus?.retryCount).toBe(2);
    expect(runStatus?.retryMaxRetries).toBe(3);
    expect(runStatus?.retryState).toBe("dispatching");
    expect(runStatus?.retryNextEligibleAt).toBe("2026-07-22T12:00:00.000Z");
  });
});

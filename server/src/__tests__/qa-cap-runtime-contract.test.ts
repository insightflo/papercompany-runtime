import { describe, expect, it } from "vitest";
import { buildQaCapAcceptanceRuntimeContract } from "../services/workflow/control-flow/qa-cap-runtime-contract.js";

const qaStep = {
  id: "qa",
  name: "Review",
  agentId: "qa-agent",
  dependencies: ["produce"],
};

const cappedRun = [
  { stepId: "produce", status: "completed", iterationIndex: 2 },
  { stepId: "qa", status: "failed", iterationIndex: 0 },
];

describe("QA cap runtime contract", () => {
  it("is absent unless the individual back-edge opts in", () => {
    const contract = buildQaCapAcceptanceRuntimeContract({
      qaStep,
      qaIssueId: "qa-issue",
      steps: [
        {
          id: "produce",
          name: "Produce",
          agentId: "producer-agent",
          dependencies: [],
          conditionalDependencies: [{
            stepId: "qa",
            when: "qa_request_changes",
            isBackEdge: true,
            maxIterations: 2,
          }],
        },
        qaStep,
      ],
      stepRuns: cappedRun,
    });

    expect(contract).toBeNull();
  });
});

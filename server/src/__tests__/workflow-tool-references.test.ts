import { describe, expect, it } from "vitest";
import { getWorkflowToolReferenceNames, type WorkflowStep } from "../services/workflow/dag-engine.js";
import { STEP_MACHINE_CHECKS_TOOL } from "../services/workflow/step-machine-checks.js";

describe("workflow tool references", () => {
  it("normalizes, deduplicates, filters built-ins and sorts tool names", () => {
    const steps = [
      { id: "a", name: "a", agentId: "x", dependencies: [], toolNames: [" z ", "alpha", "", "delegate_to_company"] },
      { id: "b", name: "b", agentId: "x", dependencies: [], toolNames: ["alpha", STEP_MACHINE_CHECKS_TOOL] },
    ] as WorkflowStep[];
    expect(getWorkflowToolReferenceNames(steps)).toEqual(["alpha", "z"]);
  });
  it("handles steps without tool names", () => {
    expect(getWorkflowToolReferenceNames([{ id: "a", name: "a", agentId: "x", dependencies: [] }])).toEqual([]);
  });
});

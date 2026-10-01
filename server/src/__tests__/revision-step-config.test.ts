import { expect, it } from "vitest";
import { revisionStepHash } from "../services/workflow/revision-step-config.js";
import { normalizeWorkflowStepsForExecution } from "../services/workflow/execution-steps.js";
const source = [{ id: "a", name: "A", agentId: "agent", dependencies: [] },
  { id: "b", name: "B", agentId: "agent", dependencies: ["a"], workProductSelectors: { a: { type: "document", title: "result.json" } },
    toolArgs: { content: "{$steps.a.workProductPath}" }, toolArtifactContract: { inputStepId: "a" } }];
it("canonicalizes explicit mapped dependency and machine token references without comparing presentation", () => {
  const target = [{ ...source[0], id: "new-a", sourceStepId: "a" }, { ...source[1], id: "new-b", sourceStepId: "b", name: "Renamed",
    dependencies: ["new-a"], workProductSelectors: { "new-a": { type: "document", title: "result.json" } },
    toolArgs: { content: "{$steps.new-a.workProductPath}" }, toolArtifactContract: { inputStepId: "new-a" } }];
  expect(revisionStepHash(target[1], target)).toBe(revisionStepHash(source[1], source));
  expect(revisionStepHash({ ...target[1], toolArgs: { content: "other" } }, target)).not.toBe(revisionStepHash(source[1], source));
});
it("does not treat arbitrary metadata or prose-only contract changes as a changed failed execution", () => {
  const step = { ...source[0], contract: { postconditions: ["new words"] }, irrelevant: "bypass" };
  expect(revisionStepHash(step, [], "failure")).toBe(revisionStepHash(source[0], [], "failure"));
});
it("normalizes native tool/dependency aliases so spelling alone cannot bypass a failed configuration", () => {
  const [original] = normalizeWorkflowStepsForExecution([{ ...source[0], toolNames: ["run"], dependencies: ["parent"] }]);
  const [alias] = normalizeWorkflowStepsForExecution([{ ...source[0], type: "agent", tools: ["run"], dependsOn: ["parent"], dependencies: ["parent"] }]);
  expect(revisionStepHash(alias, [], "failure")).toBe(revisionStepHash(original, [], "failure"));
});

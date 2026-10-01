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
it("compares second revisions in the immediate source run coordinate system", () => {
  const previous = [{ ...source[0], id: "a1", sourceStepId: "a" }, { ...source[1], id: "b1", sourceStepId: "b",
    dependencies: ["a1"], workProductSelectors: { a1: { type: "document", title: "result.json" } },
    toolArgs: { content: "{$steps.a1.workProductPath}" }, toolArtifactContract: { inputStepId: "a1" } }];
  const next = [{ ...previous[0], id: "a2", sourceStepId: "a1" }, { ...previous[1], id: "b2", sourceStepId: "b1",
    dependencies: ["a2"], workProductSelectors: { a2: { type: "document", title: "result.json" } },
    toolArgs: { content: "{$steps.a2.workProductPath}" }, toolArtifactContract: { inputStepId: "a2" } }];
  for (const purpose of ["seed", "failure"] as const) {
    expect(revisionStepHash(next[1], next, purpose)).toBe(revisionStepHash(previous[1], previous, purpose, "current"));
  }
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

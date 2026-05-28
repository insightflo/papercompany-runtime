import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");

test("workflow abort parent comments include concrete recovery instructions", () => {
  assert.match(source, /function buildWorkflowParentIssueTerminalComment\(/);
  assert.match(source, /Main executor diagnosis required:/);
  assert.match(source, /Identify the failed step\/output and decide whether retry is safe\./);
  assert.match(source, /Try `rerun-step` for the failed step or `resume-run` for the workflow run when retry is safe\./);
  assert.match(source, /Keep this parent oversight issue open as the operator-facing recovery record until retry, replan, or escalation is complete\./);
});

test("tool failures keep the parent oversight issue blocked instead of cancelled", () => {
  const toolFailureIndex = source.indexOf('failedBy: "tool_failure"');
  assert.notEqual(toolFailureIndex, -1);
  const toolFailureBlock = source.slice(Math.max(0, toolFailureIndex - 600), toolFailureIndex + 600);
  assert.match(toolFailureBlock, /markWorkflowParentIssueTerminal\([\s\S]*?"blocked"/);
  assert.doesNotMatch(toolFailureBlock, /markWorkflowParentIssueTerminal\([\s\S]*?"cancelled"/);
});

test("all workflow parent abort paths use the diagnosis comment builder", () => {
  assert.match(source, /failedBy: "manual_abort"/);
  assert.match(source, /failedBy: "agent_failure"/);
  assert.match(source, /failedBy: "tool_failure"/);
  assert.match(source, /workflow-failure:\$\{input\.workflowRun\.id\}:\$\{markerStep\}/);

  const builderUses = source.match(/buildWorkflowParentIssueTerminalComment\(\{/g) ?? [];
  assert.equal(builderUses.length, 3);

  const terminalCalls = source.match(/markWorkflowParentIssueTerminal\(/g) ?? [];
  // One function declaration plus the three terminal parent issue paths.
  assert.equal(terminalCalls.length, 4);
});

test("terminal parent issue comments are still written for already-cancelled oversight issues", () => {
  assert.match(source, /parentIssue\.status === "done"/);
  assert.match(source, /parentIssue\.status !== status && parentIssue\.status !== "cancelled"/);
  assert.match(source, /await ctx\.issues\.createComment\(parentIssueId, comment, companyId\)/);
});

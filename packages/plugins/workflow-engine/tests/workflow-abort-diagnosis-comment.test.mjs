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

test("tool result payload.error is preserved in step issue comment for recoverable diagnostics", () => {
  // Verify that handleToolExecutionResultPayload extracts payload.error
  // and includes it in the step issue comment when the tool fails.
  const handlerIndex = source.indexOf("async function handleToolExecutionResultPayload(");
  assert.notEqual(handlerIndex, -1);

  const handlerBlock = source.slice(handlerIndex, handlerIndex + 4000);

  // payload.error is extracted as a string and trimmed
  assert.match(handlerBlock, /typeof payload\.error === "string" && payload\.error\.trim\(\)/);

  // The first line of the error is used as errorSummary
  assert.match(handlerBlock, /payload\.error\.trim\(\)\.split\("\\n"\)\[0\]/);

  // errorSummary is conditionally included in the step issue comment
  assert.match(handlerBlock, /errorSummary \? \[/);

  // On failure (!success), the step is marked failed
  assert.match(handlerBlock, /const nextStatus = success \? STEP_STATUSES\.done : STEP_STATUSES\.failed/);
});

test("tool result handler consumes payload.data.retryable and retryAfterSeconds in step issue comment", () => {
  const handlerIndex = source.indexOf("async function handleToolExecutionResultPayload(");
  assert.notEqual(handlerIndex, -1);

  const handlerBlock = source.slice(handlerIndex, handlerIndex + 4500);

  // payload.data is safely inspected as a record
  assert.match(handlerBlock, /typeof payload\.data === "object" && payload\.data !== null/);

  // retryable boolean is extracted and rendered as a diagnostic line
  assert.match(handlerBlock, /typeof \(payloadData\?\.retryable\) === "boolean"/);
  assert.match(handlerBlock, /retryable !== null \? \[`- Retryable: \$\{retryable\}`\]/);

  // retryAfterSeconds is extracted when a finite number and rendered
  assert.match(handlerBlock, /typeof \(payloadData\?\.retryAfterSeconds\) === "number" && Number\.isFinite\(payloadData\.retryAfterSeconds\)/);
  assert.match(handlerBlock, /retryAfterSeconds !== null \? \[`- Retry after: \$\{retryAfterSeconds\}s`\]/);
});

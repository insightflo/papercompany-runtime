import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");

test("workflow-created missions pass source=workflow to the mission API", () => {
  assert.match(source, /description:\s*`Created automatically for workflow run:/);
  assert.match(source, /source:\s*"workflow"/);
});

test("workflow-created issues keep origin metadata for mission work traceability", () => {
  assert.match(source, /originKind:\s*"mission_main_executor_oversight"/);
  assert.match(source, /originKind:\s*"workflow_step"/);
  assert.match(source, /originRunId:\s*liveStepRun\.data\.runId/);
});

test("workflow terminal failures synchronize the parent oversight issue", () => {
  assert.match(source, /async function markWorkflowParentIssueTerminal/);
  assert.match(source, /markWorkflowParentIssueTerminal\(\s*ctx,\s*typedRun,\s*companyId,\s*"cancelled"/);
});

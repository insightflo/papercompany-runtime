import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");

function functionBlock(name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} function should exist`);

  const nextFunction = source.indexOf("\nasync function ", start + 1);
  return source.slice(start, nextFunction === -1 ? source.length : nextFunction);
}

test("plugin advanceWorkflow is legacy-isolated and does not materialize downstream DAG steps", () => {
  const block = functionBlock("advanceWorkflow");

  assert.match(block, /server-native DAG owns execution/);
  assert.doesNotMatch(block, /getNextSteps\(/);
  assert.doesNotMatch(block, /createStepRun\(/);
  assert.doesNotMatch(block, /activateBacklogStep\(/);
  assert.doesNotMatch(block, /updateWorkflowRun\(/);
  assert.doesNotMatch(block, /ctx\.issues\.update\(parentIssueId/);
});

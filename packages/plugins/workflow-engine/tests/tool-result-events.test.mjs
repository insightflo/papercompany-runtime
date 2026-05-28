import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");

test("workflow-engine subscribes to both qualified and unqualified tool result events", () => {
  assert.match(source, /ctx\.events\.on\(\s*"tool-execution-result"/);
  assert.match(source, /plugin\.insightflo\.tool-registry\.tool-execution-result/);
  assert.match(source, /handleToolExecutionResultPayload\(ctx, payload, event\.companyId\)/);
});

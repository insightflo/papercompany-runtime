import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workerSource = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
const reconcilerSource = await readFile(new URL("../src/reconciler.ts", import.meta.url), "utf8");
const artifactGuardSource = await readFile(new URL("../src/artifact-guards.ts", import.meta.url), "utf8").catch(() => "");

test("gazua-morning blog completion is guarded by canonical markdown existence", () => {
  assert.match(artifactGuardSource, /Public_Market_Report_\$\{runDate\}\.md/);
  assert.match(artifactGuardSource, /reports["']?,\s*["']blog["']?/);
  assert.match(artifactGuardSource, /workflowRun\.data\.workflowName !== "gazua-morning"/);
  assert.match(artifactGuardSource, /stepDef\.id !== "blog"/);
});

test("worker refuses to finalize a done issue when required artifacts are missing", () => {
  assert.match(workerSource, /validateRequiredStepArtifacts/);
  assert.match(workerSource, /Required workflow artifact missing/);
  assert.match(workerSource, /status: "blocked"/);
});

test("reconciler does not advance downstream steps when terminal issue artifact validation fails", () => {
  assert.match(reconcilerSource, /validateRequiredStepArtifacts/);
  assert.match(reconcilerSource, /Reconciler: terminal issue is missing required workflow artifact/);
  assert.match(reconcilerSource, /continue;/);
});

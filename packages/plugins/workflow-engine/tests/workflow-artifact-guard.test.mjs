import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workerSource = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
const reconcilerSource = await readFile(new URL("../src/reconciler.ts", import.meta.url), "utf8");
const artifactGuardSource = await readFile(new URL("../src/artifact-guards.ts", import.meta.url), "utf8").catch(() => "");

test("gazua dashboard HTML completion is guarded by report-for-beginners artifacts", () => {
  assert.match(artifactGuardSource, /KR_Market_Report/);
  assert.match(artifactGuardSource, /US_Market_Report/);
  assert.match(artifactGuardSource, /Sector_Rotation_Analysis/);
  assert.match(artifactGuardSource, /Narrative_Deep_Dive/);
  assert.match(artifactGuardSource, /beginner_html/);
  assert.match(artifactGuardSource, /dashboard/);
  assert.match(artifactGuardSource, /workflowName !== "gazua-morning"/);
  assert.match(artifactGuardSource, /workflowName !== "gazua-evening"/);
  assert.match(artifactGuardSource, /stepDef\.id !== "materialize-html-report"/);
  assert.match(artifactGuardSource, /data-report-style="report-for-beginners"/);
  assert.match(artifactGuardSource, /Legacy markdown-wrapper HTML is not acceptable/);
  assert.match(artifactGuardSource, /Report-for-beginners structure incomplete/);
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

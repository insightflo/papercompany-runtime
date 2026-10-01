import { randomUUID } from "node:crypto";
import { mkdir, readdir, symlink, writeFile, access, rename } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { missions, toolDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { fixture, database } from "./helpers/qa-receipt-fixture.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import { prepareQaConsumer } from "../services/workflow/qa-artifact-consumer.js";
import { completeWorkflowToolStepFromResult } from "../services/workflow/dag-engine.js";
import { legacyHtmlManualPublicationContract } from './helpers/legacy-html-manual.js';
import { freezeArtifactAttempt } from '../services/workflow/artifact-contract-runtime.js';

const hook = vi.hoisted(() => ({ afterRead: null as null | (() => Promise<void>) }));
const writerHook = vi.hoisted(() => ({ beforeWrite: null as null | (() => Promise<void>) }));
vi.mock("../services/workflow/artifact-writer.js", async original => {
  const real = await original<typeof import("../services/workflow/artifact-writer.js")>();
  return { ...real, createArtifactDirectory: async (...args: Parameters<typeof real.createArtifactDirectory>) => {
    await writerHook.beforeWrite?.(); return real.createArtifactDirectory(...args);
  } };
});
vi.mock("../services/workflow/artifact-files.js", async original => {
  const real = await original<typeof import("../services/workflow/artifact-files.js")>();
  return { ...real, readArtifactBytes: async (...args: Parameters<typeof real.readArtifactBytes>) => {
    const bytes = await real.readArtifactBytes(...args); await hook.afterRead?.(); return bytes;
  } };
});

async function publication() {
  const f = await fixture(), db = database();
  const result = await f.invoke(); expect(result.status, JSON.stringify(result.body)).toBe(200);
  const receipt = result.toolArtifactReceipt!;
  await completeWorkflowToolStepFromResult(db, { companyId: f.companyId, stepRunId: f.qaId,
    workflowRunId: f.runId, stepId: "qa", requestId: f.requestId, success: true,
    toolArtifactReceipt: receipt, data: result.body.data });
  // Keep the run active for the next explicitly requested publication attempt.
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, f.runId));
  const stepRunId = randomUUID(), toolId = randomUUID();
  await db.insert(workflowStepRuns).values({ id: stepRunId, workflowRunId: f.runId, stepId: "publish",
    status: "running", executionGeneration: 3, lastDispatchRequestId: "publish-1" });
  const script = path.join(path.dirname(f.content), "publish.mjs"), sentinel = script + ".sentinel";
  await writeFile(script, `import {writeFileSync,readFileSync} from 'node:fs';const v=JSON.parse(readFileSync(0,'utf8'));
writeFileSync(4,JSON.stringify({schemaVersion:'manual-onboarding.publication.v1',ok:true,command:'publish',mode:'content-draft',
section:'tech-blog',id:'probe',date:'2026-09-29',title:null,publishedAtKst:'2026-09-29T00:00:00+09:00',publicUrl:'http://127.0.0.1/public/tech-blog/probe',scope:JSON.parse(process.env.PAPERCOMPANY_PUBLICATION_SCOPE),
input:{contentSha256:v.content.sha256,qaSha256:v.qa.sha256,assetManifest:v.assets.map(({fileName,sha256,byteSize})=>({fileName,sha256,byteSize}))},
cms:{ok:true,audience:'public',contentId:'probe',slug:'probe',publicUrl:'http://127.0.0.1/public/tech-blog/probe',liveStatus:200,
blocks:1,assets:1,commandKey:'probe:1',contentHash:'a'.repeat(64),contentBytes:123}}));writeFileSync(${JSON.stringify(sentinel)},'ran');`);
  const adapterConfig = { command: `${process.execPath} ${script}`, workingDirectory: path.dirname(script),
    artifactContract: legacyHtmlManualPublicationContract(path.basename(script)) };
  await db.insert(toolDefinitions).values({ id: toolId, companyId: f.companyId, name: "publish-probe",
    description: "Local sentinel, not CMS", adapterType: "builtin", adapterConfig });
  await db.update(workflowStepRuns).set({ metadata: { artifactExecution: freezeArtifactAttempt({
    adapterConfig, step: {}, executionGeneration: 3, requestId: 'publish-1' }) } }).where(eq(workflowStepRuns.id, stepRunId));
  const input = { db, companyId: f.companyId, workflowRunId: f.runId, stepRunId, stepId: "publish",
    requestId: "publish-1", toolName: "publish-probe", parameters: { sourceContentPath: f.content, section: "tech-blog", id: "probe", date: "2026-09-29",
      qaResultPath: path.join(receipt.outputRoot, "qa-result.json") } };
  return { ...f, db, receipt, input, sentinel, publicationAdapterConfig: adapterConfig, publicationToolId: toolId };
}

it.each(["run", "mission", "step", "request"])("does not execute publication with stale %s", async kind => {
  const f = await publication();
  if (kind === "run") await f.db.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, f.runId));
  if (kind === "mission") await f.db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, f.missionId));
  if (kind === "step") await f.db.update(workflowStepRuns).set({ status: "skipped" }).where(eq(workflowStepRuns.id, f.input.stepRunId));
  if (kind === "request") f.input.requestId = "old-request";
  const result = await executeCoreWorkflowTool(f.input);
  expect(result.status).not.toBe(200); await expect(access(f.sentinel)).rejects.toThrow();
});

it.each(["run", "mission", "generation", "retry", "iteration"])("fences %s changes during input verification before dispatch", async kind => {
  const f = await publication(); let fired = false;
  hook.afterRead = async () => {
    if (fired) return; fired = true;
    if (kind === "run") await f.db.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, f.runId));
    else if (kind === "mission") await f.db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, f.missionId));
    else await f.db.update(workflowStepRuns).set(kind === "generation" ? { executionGeneration: 4 }
      : kind === "retry" ? { retryCount: 1 } : { iterationIndex: 1 }).where(eq(workflowStepRuns.id, f.input.stepRunId));
  };
  try { expect((await executeCoreWorkflowTool(f.input)).status).not.toBe(200); }
  finally { hook.afterRead = null; }
  expect(fired).toBe(true); await expect(access(f.sentinel)).rejects.toThrow();
});

it.each([false, true])("executes a current publication request (progress=%s)", async progress => {
  const f = await publication();
  if (progress) await f.db.update(toolDefinitions).set({ adapterConfig: {
    ...f.publicationAdapterConfig,
    progress: { version: 1, idleTimeoutMs: 5000, maxDurationMs: 15000,
      stages: [{ key: "copy", unit: "items" }] },
  } }).where(eq(toolDefinitions.id, f.publicationToolId));
  const result = await executeCoreWorkflowTool(f.input);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  await expect(access(f.sentinel)).resolves.toBeUndefined();
});

it("refuses a runs symlink without creating outside directories", async () => {
  const f = await fixture();
  const missionRoot = path.dirname(path.dirname(f.content)), outside = path.join(missionRoot, "outside");
  await mkdir(outside); await symlink(outside, path.join(missionRoot, "runs"));
  expect((await f.invoke()).status).not.toBe(200);
  expect(await readdir(outside)).toEqual([]);
});

it("consumer cannot create its result root through a replaced ancestor", async () => {
  const f = await publication(), outside = path.join(path.dirname(f.content), "outside"); await mkdir(outside);
  let swapped = false;
  writerHook.beforeWrite = async () => {
    if (swapped) return;
    swapped = true; await rename(f.receipt.outputRoot, f.receipt.outputRoot + "-pinned");
    await symlink(outside, f.receipt.outputRoot);
  };
  try { await expect(prepareQaConsumer(f.input)).rejects.toThrow(); }
  finally { writerHook.beforeWrite = null; }
  expect(swapped).toBe(true); expect(await readdir(outside)).toEqual([]);
});

import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { cuDatabase } from "./workflow-resume-cu-fixture.js";
import { connectedExactCase, pendingExactCase, registerExact, resolveExact, remoteStorage, controlState,
  type ExactCase } from "./helpers/workflow-exact-artifact-fixture.js";
import { registerWorkflowArtifactWithStorage } from "../services/workflow/registered-artifact-storage.js";
import { admitCuEvidence } from "../services/workflow-resume-cu-evidence.js";

let f: Awaited<ReturnType<typeof cuDatabase>>;
const cases: ExactCase[] = [];
beforeAll(async () => { f = await cuDatabase(); }, 120_000);
afterAll(async () => { for (const c of cases) await c.cleanup(); await f?.cleanup(); });
async function pending() { const c = await pendingExactCase(f); cases.push(c); return c; }
const submission = async (c: ExactCase) => (await f.sql`SELECT * FROM workflow_late_evidence_submissions WHERE id=${c.view.id}`)[0];

test("actual receiver/media -> verified nonprimary artifact -> real IF, concurrent replay preserves DB control state and primary", async () => {
  const c = await connectedExactCase(f); cases.push(c);
  expect(c.view.state).toBe("verified"); expect(c.view.code).toBe("cu_artifact_verified");
  expect([... (await resolveExact(f, c)).values()]).toEqual([c.view.result]);
  const primaryId = randomUUID();
  await f.sql`INSERT INTO issue_work_products(id,company_id,issue_id,type,provider,title,status,is_primary)
    VALUES(${primaryId},${c.companyId},${c.job.issue_id},'artifact','local_file','existing primary','ready',true)`;
  const before = await controlState(f, c), stored = await submission(c);
  const products = await Promise.all(Array.from({ length: 4 }, () => registerExact(c)));
  expect(new Set(products.map(p => p.id)).size).toBe(1);
  expect(products[0]).toMatchObject({ id: stored.artifact_id, type: "artifact", provider: "local_file", isPrimary: false });
  expect(await submission(c)).toEqual(stored);
  const replay = await admitCuEvidence(f.db, { companyId: c.companyId, missionId: c.missionId }, c.intake, "cu-board");
  expect(replay).toEqual(c.view);
  expect(await controlState(f, c)).toEqual(before);
  expect((await f.sql`SELECT is_primary FROM issue_work_products WHERE id=${primaryId}`)[0].is_primary).toBe(true);
  expect(await f.sql`SELECT id FROM issue_work_products WHERE company_id=${c.companyId}`).toHaveLength(2);
  expect(await readFile(c.artifactPath)).toEqual(c.raw);
}, 120_000);

test("all exact producer and supplied issue scopes reject before storage or file side effects", async () => {
  const c = await pending(); await remoteStorage(f, c);
  const send = vi.fn(), secret = vi.fn();
  const deps = { resolveSecretValue: secret, createS3Client: () => ({ send }) };
  const before = await controlState(f, c);
  for (const key of ["companyId", "missionId", "workflowRunId", "stepRunId", "stepId", "issueId", "executionGeneration", "specSha256", "submissionId"] as const) {
    const wrong = key === "executionGeneration" ? 3 : key === "specSha256" ? "f".repeat(64) : randomUUID();
    await expect(registerWorkflowArtifactWithStorage({ ...c.input, exactProducer: { ...c.input.exactProducer, [key]: wrong },
      artifactMirrorDeps: deps })).rejects.toThrow(/cu_/);
  }
  for (const key of ["id", "companyId", "missionId"] as const) {
    await expect(registerWorkflowArtifactWithStorage({ ...c.input, issue: { ...c.input.issue, [key]: randomUUID() },
      artifactMirrorDeps: deps })).rejects.toThrow(/cu_/);
  }
  expect(await controlState(f, c)).toEqual(before);
  await f.sql`UPDATE workflow_step_runs SET status='running' WHERE id=${c.job.step_run_id}`;
  const runningBefore = await controlState(f, c);
  await expect(registerWorkflowArtifactWithStorage({ ...c.input, artifactMirrorDeps: deps })).rejects.toThrow(/cu_/);
  expect(await controlState(f, c)).toEqual(runningBefore);
  expect(send).not.toHaveBeenCalled(); expect(secret).not.toHaveBeenCalled();
  expect((await submission(c)).artifact_id).toBeNull();
  expect(await readFile(c.artifactPath)).toEqual(c.raw);
}, 120_000);

test("exact remote PUT/GET is submission/attempt isolated; missing, oversized and bad GET remain retryable", async () => {
  const c = await pending(); await remoteStorage(f, c);
  const key = `exact/companies/${c.companyId}/workflow-runs/${c.job.workflow_run_id}/steps/clips/attempts/${c.job.step_run_id}/generations/2/submissions/${c.view.id}/clips-result.v1.json`;
  let body: unknown;
  const send = vi.fn(async (command: unknown) => {
    expect(command).toBeInstanceOf(command instanceof PutObjectCommand ? PutObjectCommand : GetObjectCommand);
    expect((command as PutObjectCommand).input.Key).toBe(key);
    if (command instanceof PutObjectCommand) { expect(command.input.Body).toEqual(c.raw); return {}; }
    return { Body: body };
  });
  const deps = { resolveSecretValue: async () => "fixture-secret", createS3Client: () => ({ send }) };
  const before = await controlState(f, c);
  for (const bad of [undefined, Buffer.from("wrong"), Buffer.alloc(1024 * 1024 + 1),
    { async *[Symbol.asyncIterator]() { yield Buffer.alloc(700_000); yield Buffer.alloc(700_000); throw new Error("must stop before third chunk"); } },
    { transformToByteArray: () => { throw new Error("unbounded transform forbidden"); } }]) {
    body = bad;
    await expect(registerWorkflowArtifactWithStorage({ ...c.input, artifactMirrorDeps: deps })).rejects.toThrow("cu_artifact_readback_failed");
    expect(await submission(c)).toMatchObject({ state: "pending_readback", artifact_id: null, verified_at: null, code: "cu_artifact_readback_failed" });
  }
  body = { async *[Symbol.asyncIterator]() { yield c.raw.subarray(0, 20); yield c.raw.subarray(20); } };
  const product = await registerWorkflowArtifactWithStorage({ ...c.input, artifactMirrorDeps: deps });
  expect(product.metadata).toMatchObject({ storageMirror: { objectKey: key }, exactProducer: c.input.exactProducer });
  expect(send).toHaveBeenCalledTimes(12);
  expect((await submission(c)).state).toBe("verified");
  expect(await controlState(f, c)).toEqual(before);
  expect([... (await resolveExact(f, c)).values()]).toEqual([c.view.result]);
}, 120_000);

test("missing local result is never regenerated; persisted pending replay retries registration only", async () => {
  const c = await pending(), before = await controlState(f, c);
  await rename(c.artifactPath, c.artifactPath + ".retained");
  const first = await admitCuEvidence(f.db, { companyId: c.companyId, missionId: c.missionId }, c.intake, "cu-board");
  expect(first.state).toBe("pending_readback"); expect(first.code).toBe("cu_artifact_readback_failed");
  await expect(readFile(c.artifactPath)).rejects.toThrow();
  await rename(c.artifactPath + ".retained", c.artifactPath);
  // If replay spawns this unavailable executable, it cannot succeed.
  process.env.PAPERCLIP_CU_RECEIVER_PYTHON = "/definitely/not/a/python";
  const replay = await admitCuEvidence(f.db, { companyId: c.companyId, missionId: c.missionId }, c.intake, "cu-board");
  expect(replay.state).toBe("verified"); expect(await controlState(f, c)).toEqual(before);
  expect(await f.sql`SELECT id FROM issue_work_products WHERE issue_id=${c.job.issue_id}`).toHaveLength(1);
}, 120_000);

test("invalid paths, pinned bytes, generation, or verified linkage cannot be repaired by registration", async () => {
  const c = await pending();
  await expect(registerWorkflowArtifactWithStorage({ ...c.input, data: { ...c.input.data, path: c.artifactPath + ".other" } })).rejects.toThrow(/cu_/);
  await writeFile(c.artifactPath, "{}");
  await expect(registerExact(c)).rejects.toThrow(/cu_/);
  expect((await submission(c)).state).toBe("pending_readback");
  await writeFile(c.artifactPath, c.raw);
  await f.sql`UPDATE workflow_step_runs SET execution_generation=3 WHERE id=${c.job.step_run_id}`;
  await expect(registerExact(c)).rejects.toThrow(/cu_/);
  await f.sql`UPDATE workflow_step_runs SET execution_generation=2 WHERE id=${c.job.step_run_id}`;
  await registerExact(c);
  await f.sql`UPDATE workflow_late_evidence_submissions SET readback_hash=${"0".repeat(64)} WHERE id=${c.view.id}`;
  const before = await submission(c);
  await expect(registerExact(c)).rejects.toThrow(/cu_/);
  expect(await submission(c)).toEqual(before);
}, 120_000);

test("verified replay with missing retained bytes fails closed rather than returning a fresh success", async () => {
  const c = await connectedExactCase(f); cases.push(c);
  const before = await submission(c);
  await rename(c.artifactPath, c.artifactPath + ".retained");
  await expect(admitCuEvidence(f.db, { companyId: c.companyId, missionId: c.missionId }, c.intake, "cu-board"))
    .rejects.toThrow("cu_artifact_readback_failed");
  expect(await submission(c)).toEqual(before);
}, 120_000);

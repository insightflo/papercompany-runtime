import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, expect, test } from "vitest";
import { cuDatabase, configureCu } from "./workflow-resume-cu-fixture.js";
import { connectedExactCase, pendingExactCase, registerExact, remoteStorage, controlState, type ExactCase } from "./helpers/workflow-exact-artifact-fixture.js";
import { registerWorkflowArtifactWithStorage } from "../services/workflow/registered-artifact-storage.js";
import { admitCuEvidence } from "../services/workflow-resume-cu-evidence.js";
let f: Awaited<ReturnType<typeof cuDatabase>>;
const cases: ExactCase[] = [];
beforeAll(async () => { f = await cuDatabase(); }, 120_000);
afterAll(async () => { for (const c of cases) await c.cleanup(); await f?.cleanup(); });
async function pending() { const c = await pendingExactCase(f); cases.push(c); return c; }

test("concurrent pending retries atomically insert exactly one product/activity, preserving a prior primary and control rows", async () => {
  const c = await pending(), primaryId = randomUUID();
  await f.sql`INSERT INTO issue_work_products(id,company_id,issue_id,type,provider,title,status,is_primary)
    VALUES(${primaryId},${c.companyId},${c.job.issue_id},'artifact','local_file','old primary','active',true)`;
  const before = await controlState(f, c);
  const [activitiesBefore] = await f.sql`SELECT count(*)::int AS n FROM activity_log WHERE entity_id=${c.view.id} AND action='workflow.cu_artifact_verified'`;
  const products = await Promise.all(Array.from({ length: 6 }, () => registerExact(c)));
  expect(new Set(products.map(p => p.id)).size).toBe(1);
  expect(await f.sql`SELECT id FROM issue_work_products WHERE issue_id=${c.job.issue_id}`).toHaveLength(2);
  expect((await f.sql`SELECT is_primary FROM issue_work_products WHERE id=${primaryId}`)[0].is_primary).toBe(true);
  const [after] = await f.sql`SELECT count(*)::int AS n FROM activity_log WHERE entity_id=${c.view.id} AND action='workflow.cu_artifact_verified'`;
  expect(after.n).toBe(activitiesBefore.n + 1);
  expect(await controlState(f, c)).toEqual(before);
}, 120_000);

test.each(["generation", "noncompleted", "local-bytes"])("final transaction rejects %s change during exact remote readback", async change => {
  const c = await pending(); await remoteStorage(f, c);
  const beforeProducts = await f.sql`SELECT * FROM issue_work_products WHERE company_id=${c.companyId}`;
  let afterExternalChange: unknown;
  const deps = { resolveSecretValue: async () => "fixture-secret", createS3Client: () => ({ send: async (command: unknown) => {
    if (command instanceof PutObjectCommand) return {};
    expect(command).toBeInstanceOf(GetObjectCommand);
    if (change === "generation") await f.sql`UPDATE workflow_step_runs SET execution_generation=3 WHERE id=${c.job.step_run_id}`;
    if (change === "noncompleted") await f.sql`UPDATE workflow_step_runs SET status='running' WHERE id=${c.job.step_run_id}`;
    if (change === "local-bytes") await writeFile(c.artifactPath, "{}");
    afterExternalChange = await controlState(f, c);
    return { Body: c.raw };
  } }) };
  await expect(registerWorkflowArtifactWithStorage({ ...c.input, artifactMirrorDeps: deps })).rejects.toThrow(/cu_/);
  expect((await f.sql`SELECT * FROM workflow_late_evidence_submissions WHERE id=${c.view.id}`)[0])
    .toMatchObject({ state: "pending_readback", artifact_id: null, verified_at: null });
  expect(await f.sql`SELECT * FROM issue_work_products WHERE company_id=${c.companyId}`).toEqual(beforeProducts);
  expect(await controlState(f, c)).toEqual(afterExternalChange);
}, 120_000);

test("remote keys separate submissions and attempts; failed PUT retries without receiver or private file replacement", async () => {
  const c = await pending(); await remoteStorage(f, c);
  const calls: unknown[] = [], keys: string[] = [];
  let putFails = true, raw = c.raw;
  const deps = { resolveSecretValue: async () => "fixture-secret", createS3Client: () => ({ send: async (command: unknown) => {
    calls.push(command);
    if (command instanceof PutObjectCommand) {
      keys.push(command.input.Key!);
      if (putFails) throw new Error("SECRET and /private/path must not escape");
      return {};
    }
    return { Body: raw };
  } }) };
  await expect(registerWorkflowArtifactWithStorage({ ...c.input, artifactMirrorDeps: deps })).rejects.toThrow("cu_artifact_readback_failed");
  expect(calls).toHaveLength(1);
  putFails = false;
  await registerWorkflowArtifactWithStorage({ ...c.input, artifactMirrorDeps: deps });
  expect(await readFile(c.artifactPath)).toEqual(c.raw);
  // A distinct real completed attempt + real receiver submission, not caller bytes.
  const other = await pending(); await remoteStorage(f, other); raw = other.raw;
  await registerWorkflowArtifactWithStorage({ ...other.input, artifactMirrorDeps: deps });
  expect(new Set(keys).size).toBe(2);
  expect(keys[0]).toContain(`/attempts/${c.job.step_run_id}/generations/2/submissions/${c.view.id}/`);
  expect(keys[2]).toContain(`/attempts/${other.job.step_run_id}/generations/2/submissions/${other.view.id}/`);
  configureCu(c);
  process.env.PAPERCLIP_CU_RECEIVER_PYTHON = "/definitely/not/a/python";
  expect((await admitCuEvidence(f.db, { companyId: c.companyId, missionId: c.missionId }, c.intake, "cu-board")).state).toBe("verified");
}, 120_000);

test("internal exact preview branch rejects; blocked and receiver-pending without pinned result replay never starts a receiver", async () => {
  const c = await connectedExactCase(f); cases.push(c);
  await expect(registerWorkflowArtifactWithStorage({ ...c.input,
    data: { type: "preview_url", url: "https://example.test", isPrimary: false } })).rejects.toThrow(/cu_/);
  const [original] = await f.sql`SELECT * FROM workflow_late_evidence_submissions WHERE id=${c.view.id}`;
  for (const state of ["blocked", "pending_readback"]) {
    const id = randomUUID(), idempotencyKey = randomUUID();
    // Create genuinely unstarted replay intake with no result (immutable result pins cannot be removed).
    const intake = { ...c.intake, idempotencyKey };
    const { bytes, sha } = await import("../services/workflow-resume-cu-contract.js");
    const scope = { companyId: c.companyId, missionId: c.missionId };
    await f.sql`INSERT INTO workflow_late_evidence_submissions(id,company_id,mission_id,workflow_run_id,step_run_id,issue_id,
      execution_generation,spec_sha256,manifest_object,manifest_sha256,request_hash,idempotency_key,state,code,cu_job_id)
      VALUES(${id},${c.companyId},${c.missionId},${c.job.workflow_run_id},${c.job.step_run_id},${c.job.issue_id},2,
      ${c.job.spec_sha256},${c.intake.manifestObject},${c.intake.manifestSha256},${sha(bytes({ ...scope, ...intake }))},
      ${idempotencyKey},${state},'cu_receiver_pending',${c.job.job_id})`;
    const before = await controlState(f, c);
    process.env.PAPERCLIP_CU_RECEIVER_PYTHON = "/definitely/not/a/python";
    expect((await admitCuEvidence(f.db, scope, intake, "cu-board")).state).toBe(state);
    expect(await controlState(f, c)).toEqual(before);
    expect((await f.sql`SELECT cu_result_base64 FROM workflow_late_evidence_submissions WHERE id=${id}`)[0].cu_result_base64).toBeNull();
  }
  expect((await f.sql`SELECT * FROM workflow_late_evidence_submissions WHERE id=${c.view.id}`)[0]).toEqual(original);
}, 120_000);

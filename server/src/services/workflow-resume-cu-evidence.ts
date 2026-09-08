import { and, asc, eq, gt } from "drizzle-orm";
import { activityLog, workflowCuObservations, workflowLateEvidenceSubmissions, type Db } from "@paperclipai/db";
import { z } from "zod";
import { registerPersistedCuResult } from "./workflow/cu-result-registration.js";
import path from "node:path";
import { HttpError } from "../errors.js";
import { AGGREGATE_CAP, JSON_CAP, bytes, decode, equal, fail, hash, inputsSchema, parse, queueRoot, scopeOf, sha, uuid } from "./workflow-resume-cu-contract.js";
import { loadCuJob, type CuTx } from "./workflow-resume-cu-binding.js";
import { validateStoredObservation } from "./workflow-resume-cu-observations.js";
import { createCuObjectReader } from "./workflow-resume-cu-objects.js";
import { privateSubmission, writePrivate } from "./workflow-resume-cu-files.js";
import { hydrateCuCache } from "./workflow-resume-cu-hydration.js";
import { decodeStoredCuResult, readCuResult, receiverConfiguration, runCuReceiver } from "./workflow-resume-cu-process.js";
export { bindCuJob } from "./workflow-resume-cu-binding.js";
export { writeCuObservation } from "./workflow-resume-cu-observations.js";

export const intakeSchema = z.object({ jobId: uuid, idempotencyKey: uuid, manifestObject: z.string(), manifestSha256: hash }).strict();
type Intake = z.infer<typeof intakeSchema>;
type Scope = { companyId: string; missionId: string };
type Submission = typeof workflowLateEvidenceSubmissions.$inferSelect;

async function capture(tx: CuTx, scope: Scope, input: Intake, actorId: string) {
  const { row, job } = await loadCuJob(tx, scope.companyId, scope.missionId, input.jobId, true);
  if (input.manifestObject !== queueRoot(job) + "manifest.json") fail("cu_manifest_scope_mismatch");
  const requestHash = sha(bytes({ ...scope, ...input }));
  const [prior] = await tx.select().from(workflowLateEvidenceSubmissions).where(and(
    eq(workflowLateEvidenceSubmissions.companyId, scope.companyId), eq(workflowLateEvidenceSubmissions.stepRunId, job.step_run_id),
    eq(workflowLateEvidenceSubmissions.idempotencyKey, input.idempotencyKey)));
  if (prior) {
    if (prior.requestHash !== requestHash || prior.cuJobId !== job.job_id) fail("cu_submission_conflict", 409);
    return { submission: prior, fresh: false, job, inputs: row.inputs };
  }
  const inputs = parse(inputsSchema, row.inputs);
  if (!equal(inputs.scope, scopeOf(job))) fail();
  const records: Record<string, unknown>[] = []; let budget: Record<string, unknown> | null = null;
  let cursor = 0, aggregate = 0, recordBytes = 0;
  for (;;) {
    const observations = await tx.select().from(workflowCuObservations).where(and(eq(workflowCuObservations.jobId, job.job_id),
      eq(workflowCuObservations.companyId, job.company_id), gt(workflowCuObservations.revision, cursor)))
      .orderBy(asc(workflowCuObservations.revision)).limit(16);
    if (!observations.length) break;
    for (const observation of observations) {
      aggregate += Buffer.byteLength(observation.screenshotBase64) + bytes(observation.payload).length;
      if (aggregate > AGGREGATE_CAP) fail("cu_evidence_limit", 422);
      const payload = validateStoredObservation(job, inputs, observation);
      if (observation.kind === "budget") budget = payload;
      else { recordBytes += bytes(payload).length; if (recordBytes > JSON_CAP) fail("cu_evidence_limit", 422); records.push(payload); }
      cursor = observation.revision;
    }
  }
  // Under the same job lock as append-only budget revisions. Each submission freezes its own bytes.
  const snapshot = bytes({ schema: "shorts.cu-receiver-snapshot.v1", job, inputs, records, budget });
  const [submission] = await tx.insert(workflowLateEvidenceSubmissions).values({ companyId: job.company_id, missionId: job.mission_id,
    workflowRunId: job.workflow_run_id, stepRunId: job.step_run_id, issueId: job.issue_id, executionGeneration: job.execution_generation,
    specSha256: job.spec_sha256, manifestObject: input.manifestObject, manifestSha256: input.manifestSha256, requestHash,
    idempotencyKey: input.idempotencyKey, cuJobId: job.job_id, cuSnapshotBase64: snapshot.toString("base64"), cuSnapshotSha256: sha(snapshot),
    attempts: 1, code: "cu_receiver_pending" }).returning();
  await tx.insert(activityLog).values({ companyId: job.company_id, actorType: "user", actorId,
    action: "workflow.cu_evidence_admitted", entityType: "workflow_late_evidence_submission", entityId: submission.id,
    details: { jobId: job.job_id } });
  return { submission, fresh: true, job, inputs };
}
function publicSubmission(row: Submission) {
  let result = null;
  if (row.cuResultBase64 && row.cuResultSha256) {
    result = decodeStoredCuResult(row.cuResultBase64, row.cuResultSha256);
    if (result.scope.job_id !== row.cuJobId || result.scope.company_id !== row.companyId || result.scope.mission_id !== row.missionId
      || result.scope.workflow_run_id !== row.workflowRunId || result.scope.step_run_id !== row.stepRunId
      || result.scope.issue_id !== row.issueId || result.scope.execution_generation !== row.executionGeneration || result.scope.spec_sha256 !== row.specSha256
      || result.manifest_key !== row.manifestObject || result.manifest_sha256 !== row.manifestSha256) fail("cu_result_mismatch", 422);
  }
  return { id: row.id, jobId: row.cuJobId, state: row.state, code: row.code, resultSha256: row.cuResultSha256,
    artifactId: row.artifactId, readbackHash: row.readbackHash, result };
}
export async function readCuSubmission(db: Db, scope: Scope, id: string) {
  parse(uuid, id);
  const [row] = await db.select().from(workflowLateEvidenceSubmissions).where(and(eq(workflowLateEvidenceSubmissions.id, id),
    eq(workflowLateEvidenceSubmissions.companyId, scope.companyId), eq(workflowLateEvidenceSubmissions.missionId, scope.missionId)));
  if (!row?.cuJobId) fail("cu_submission_not_found", 404);
  const { job } = await loadCuJob(db, scope.companyId, scope.missionId, row.cuJobId);
  const view = publicSubmission(row);
  if (view.result && !equal(view.result.scope, scopeOf(job))) fail("cu_result_mismatch", 422);
  return view;
}
/** Durable receiver-result persistence precedes exact registration; neither path wakes a producer. */
export async function admitCuEvidence(db: Db, scope: Scope, raw: unknown, actorId: string) {
  const input = parse(intakeSchema, raw), config = receiverConfiguration();
  const captured = await db.transaction(tx => capture(tx, scope, input, actorId));
  if (!captured.fresh) {
    await registerPersistedCuResult(db, scope, captured.submission.id, actorId);
    return readCuSubmission(db, scope, captured.submission.id);
  }
  const { submission, job, inputs } = captured;
  let result: Awaited<ReturnType<typeof readCuResult>> | undefined, code = "cu_receiver_failed";
  let unavailable = false;
  try {
    // Fresh persisted read; snapshot integrity is checked before filesystem export or spawn.
    const [stored] = await db.select().from(workflowLateEvidenceSubmissions).where(eq(workflowLateEvidenceSubmissions.id, submission.id));
    const snapshot = Buffer.from(stored.cuSnapshotBase64!, "base64");
    if (sha(snapshot) !== stored.cuSnapshotSha256 || !equal(decode(snapshot), decode(Buffer.from(submission.cuSnapshotBase64!, "base64")))) fail();
    const directory = await privateSubmission(config.root, submission.id);
    await writePrivate(path.join(directory, "snapshot.json"), snapshot);
    const manifest = await hydrateCuCache(job, inputs, input, path.join(directory, "object-cache"), createCuObjectReader(db));
    const exit = await runCuReceiver(config, directory, stored.cuSnapshotSha256!);
    result = await readCuResult(directory, exit, job, manifest, input);
    code = "cu_receiver_ok";
  } catch (error) {
    unavailable = error instanceof HttpError && error.status === 503;
    if (error instanceof HttpError && ["cu_evidence_limit", "cu_object_mismatch", "cu_terminal_mismatch", "cu_result_mismatch"].includes(error.message)) code = error.message;
  }
  await db.transaction(async tx => {
    await tx.update(workflowLateEvidenceSubmissions).set({ state: result ? "pending_readback" : "blocked", code,
      cuResultBase64: result?.raw.toString("base64") ?? null, cuResultSha256: result?.digest ?? null })
      .where(and(eq(workflowLateEvidenceSubmissions.id, submission.id), eq(workflowLateEvidenceSubmissions.code, "cu_receiver_pending")));
    const [stored] = await tx.select().from(workflowLateEvidenceSubmissions).where(eq(workflowLateEvidenceSubmissions.id, submission.id));
    if (result && (stored.cuResultBase64 !== result.raw.toString("base64") || stored.cuResultSha256 !== result.digest)) fail("cu_result_mismatch", 422);
    await tx.insert(activityLog).values({ companyId: job.company_id, actorType: "system", actorId: "cu-receiver",
      action: "workflow.cu_evidence_received", entityType: "workflow_late_evidence_submission", entityId: submission.id, details: { code } });
  });
  if (unavailable) fail("cu_evidence_unavailable", 503);
  if (result) await registerPersistedCuResult(db, scope, submission.id, actorId);
  return readCuSubmission(db, scope, submission.id);
}

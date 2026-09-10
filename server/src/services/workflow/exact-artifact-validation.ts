import path from "node:path";
import { and, eq } from "drizzle-orm";
import { issueWorkProducts, workflowLateEvidenceSubmissions, workflowStepRuns } from "@paperclipai/db";
import { z } from "zod";
import { loadCuJob, type CuDb } from "../workflow-resume-cu-binding.js";
import { decodeStoredCuResult, receiverConfiguration } from "../workflow-resume-cu-process.js";
import { equal, fail, hash, integer, JSON_CAP, parse, queueRoot, scopeOf, uuid, type CuJob } from "../workflow-resume-cu-contract.js";

// INTERNAL controller identity only. Never add this to an HTTP validator.
const exactProducerSchema = z.object({ companyId: uuid, missionId: uuid, workflowRunId: uuid,
  stepRunId: uuid, stepId: z.string().min(1), issueId: uuid, executionGeneration: integer,
  specSha256: hash, submissionId: uuid }).strict();
export type ExactProducer = z.infer<typeof exactProducerSchema>;
export type ExactSubmission = typeof workflowLateEvidenceSubmissions.$inferSelect;
export const EXACT_RESULT_TITLE = "clips-result.v1.json";
export const EXACT_RESULT_CAP = Math.min(JSON_CAP, 1024 * 1024);
export const EXACT_REGISTERED_VIA = "workflow_cu_exact_v1";
export const exactResultPath = (id: string) => path.join(receiverConfiguration().root, parse(uuid, id), "result", EXACT_RESULT_TITLE);
export function producerForSubmission(row: ExactSubmission, job: CuJob): ExactProducer {
  return { companyId: row.companyId, missionId: row.missionId, workflowRunId: row.workflowRunId,
    stepRunId: row.stepRunId, stepId: job.step_id, issueId: row.issueId, executionGeneration: row.executionGeneration,
    specSha256: row.specSha256, submissionId: row.id };
}
export const exactMetadata = (producer: ExactProducer) => ({ schema: "workflow.exact-producer.v1", ...producer });

/** Persisted job/spec identity, never latest issue-associated attempt or user prose. */
export async function validateExactSubmission(db: CuDb, raw: ExactProducer, lock = false) {
  const producer = parse(exactProducerSchema, raw);
  const query = db.select().from(workflowLateEvidenceSubmissions).where(and(
    eq(workflowLateEvidenceSubmissions.id, producer.submissionId), eq(workflowLateEvidenceSubmissions.companyId, producer.companyId),
    eq(workflowLateEvidenceSubmissions.missionId, producer.missionId)));
  const [submission] = lock ? await query.for("update") : await query;
  if (!submission?.cuJobId || !["pending_readback", "verified"].includes(submission.state)
    || !submission.cuResultBase64 || !submission.cuResultSha256) fail("cu_artifact_scope_mismatch", 422);
  const { job } = await loadCuJob(db, producer.companyId, producer.missionId, submission.cuJobId, lock);
  if (!equal(producer, producerForSubmission(submission, job)) || job.company_id !== producer.companyId
    || job.mission_id !== producer.missionId || job.workflow_run_id !== producer.workflowRunId || job.step_run_id !== producer.stepRunId
    || job.step_id !== producer.stepId || job.issue_id !== producer.issueId || job.execution_generation !== producer.executionGeneration
    || job.spec_sha256 !== producer.specSha256) fail("cu_artifact_scope_mismatch", 422);
  const stepQuery = db.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.id, producer.stepRunId),
    eq(workflowStepRuns.status, "completed"), eq(workflowStepRuns.executionGeneration, producer.executionGeneration)));
  const steps = lock ? await stepQuery.for("share") : await stepQuery;
  if (steps.length !== 1) fail("cu_artifact_scope_mismatch", 422);
  const result = decodeStoredCuResult(submission.cuResultBase64, submission.cuResultSha256);
  const bytes = Buffer.from(submission.cuResultBase64, "base64");
  if (bytes.length > EXACT_RESULT_CAP || !equal(result.scope, scopeOf(job))
    || submission.manifestObject !== queueRoot(job) + "manifest.json" || result.manifest_key !== submission.manifestObject
    || result.manifest_sha256 !== submission.manifestSha256 || result.clips.length > job.budget.max_clips
    || result.credits_total > job.budget.max_credits_total) fail("cu_artifact_result_mismatch", 422);
  return { producer, submission, job, result, bytes };
}

/** Redundant metadata must agree with the authoritative DB association, including on verified replay. */
export async function validateExactArtifact(db: CuDb, validated: Awaited<ReturnType<typeof validateExactSubmission>>, lock = false) {
  const { submission: s, producer } = validated;
  if (s.state !== "verified" || !s.artifactId || !s.verifiedAt || s.readbackHash !== s.cuResultSha256) fail("cu_artifact_link_mismatch", 422);
  const query = db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, s.artifactId));
  const [product] = lock ? await query.for("share") : await query;
  const associations = await db.select({ id: workflowLateEvidenceSubmissions.id }).from(workflowLateEvidenceSubmissions)
    .where(eq(workflowLateEvidenceSubmissions.artifactId, s.artifactId));
  const knownPath = exactResultPath(s.id);
  if (!product || associations.length !== 1 || associations[0].id !== s.id || product.companyId !== s.companyId
    || product.issueId !== s.issueId || product.type !== "artifact" || product.provider !== "local_file"
    || product.title !== EXACT_RESULT_TITLE || product.externalId !== knownPath || product.metadata?.path !== knownPath
    || product.metadata?.registeredVia !== EXACT_REGISTERED_VIA || !equal(product.metadata?.exactProducer, exactMetadata(producer))) {
    fail("cu_artifact_link_mismatch", 422);
  }
  return product;
}

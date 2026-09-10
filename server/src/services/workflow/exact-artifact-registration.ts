import { and, eq } from "drizzle-orm";
import { activityLog, issueWorkProducts, workflowLateEvidenceSubmissions, type Db } from "@paperclipai/db";
import type { WorkflowArtifactRegister } from "@paperclipai/shared/validators/workflow-agent-api";
import { HttpError } from "../../errors.js";
import { fail, sha } from "../workflow-resume-cu-contract.js";
import { readRegular } from "../workflow-resume-cu-files.js";
import { createCompanyWorkProductStorageService } from "../company-work-product-storage.js";
import { secretService } from "../secrets.js";
import type { WorkflowApiActor, WorkflowApiIssue } from "./agent-api.js";
import type { WorkflowArtifactMirrorDeps } from "./artifact-mirror.js";
import { mirrorExactArtifact } from "./exact-artifact-mirror.js";
import { exactMetadata, exactResultPath, EXACT_REGISTERED_VIA, EXACT_RESULT_CAP, EXACT_RESULT_TITLE,
  validateExactArtifact, validateExactSubmission, type ExactProducer } from "./exact-artifact-validation.js";

async function readPinned(file: string, bytes: Buffer) {
  let local: Buffer;
  try { local = await readRegular(file, EXACT_RESULT_CAP); }
  catch { fail("cu_artifact_readback_failed", 503); }
  if (!local.equals(bytes)) fail("cu_artifact_result_mismatch", 422);
}

export async function registerExactArtifact(input: { db: Db; issue: WorkflowApiIssue; actor: WorkflowApiActor;
  data: WorkflowArtifactRegister; exactProducer: ExactProducer; artifactMirrorDeps?: WorkflowArtifactMirrorDeps }) {
  const { db, exactProducer: producer, issue } = input;
  // Before configuration, local file access, secrets, or any provider/legacy preview branch.
  const initial = await validateExactSubmission(db, producer);
  if (issue.id !== producer.issueId || issue.companyId !== producer.companyId || issue.missionId !== producer.missionId) {
    fail("cu_artifact_scope_mismatch", 422);
  }
  const file = exactResultPath(producer.submissionId);
  if (!("path" in input.data) || input.data.path !== file) fail("cu_artifact_scope_mismatch", 422);
  if (initial.submission.state === "verified") await validateExactArtifact(db, initial);
  else if (initial.submission.artifactId || initial.submission.readbackHash || initial.submission.verifiedAt) fail("cu_artifact_link_mismatch", 422);
  try {
    await readPinned(file, initial.bytes);
    // Verified replays validate immutable linkage/local pins but never PUT again.
    const storageMirror = initial.submission.state === "verified" ? null : await mirrorExactArtifact(
      await createCompanyWorkProductStorageService(db).get(producer.companyId), producer, initial.bytes,
      input.artifactMirrorDeps ?? { resolveSecretValue: secretService(db).resolveSecretValue });
    return await db.transaction(async tx => {
      // Submission FOR UPDATE serializes competing registrations; loadCuJob locks job and exact scope.
      const current = await validateExactSubmission(tx, producer, true);
      if (!current.bytes.equals(initial.bytes) || current.submission.cuResultSha256 !== initial.submission.cuResultSha256
        || current.submission.manifestObject !== initial.submission.manifestObject
        || current.submission.manifestSha256 !== initial.submission.manifestSha256) fail("cu_artifact_result_mismatch", 422);
      await readPinned(file, current.bytes);
      if (current.submission.state === "verified") return validateExactArtifact(tx, current, true);
      if (initial.submission.state === "verified" || current.submission.artifactId || current.submission.readbackHash
        || current.submission.verifiedAt) fail("cu_artifact_link_mismatch", 422);
      const [product] = await tx.insert(issueWorkProducts).values({ companyId: producer.companyId, issueId: producer.issueId,
        type: "artifact", provider: "local_file", externalId: file, title: EXACT_RESULT_TITLE, status: "active", isPrimary: false,
        metadata: { path: file, registeredVia: EXACT_REGISTERED_VIA, exactProducer: exactMetadata(producer),
          ...(storageMirror ? { storageMirror } : {}) } }).returning();
      await tx.update(workflowLateEvidenceSubmissions).set({ artifactId: product.id, readbackHash: sha(current.bytes),
        verifiedAt: new Date(), state: "verified", code: "cu_artifact_verified" })
        .where(eq(workflowLateEvidenceSubmissions.id, producer.submissionId));
      await tx.insert(activityLog).values({ companyId: producer.companyId, actorType: "system", actorId: "cu-artifact-registration",
        action: "workflow.cu_artifact_verified", entityType: "workflow_late_evidence_submission", entityId: producer.submissionId,
        details: { artifactId: product.id, stepRunId: producer.stepRunId, executionGeneration: producer.executionGeneration } });
      return product;
    });
  } catch (error) {
    if (error instanceof HttpError && error.message === "cu_artifact_readback_failed") {
      await db.update(workflowLateEvidenceSubmissions).set({ code: "cu_artifact_readback_failed" }).where(and(
        eq(workflowLateEvidenceSubmissions.id, producer.submissionId), eq(workflowLateEvidenceSubmissions.companyId, producer.companyId),
        eq(workflowLateEvidenceSubmissions.missionId, producer.missionId), eq(workflowLateEvidenceSubmissions.state, "pending_readback")));
    }
    throw error;
  }
}

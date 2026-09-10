import { and, eq } from "drizzle-orm";
import { issues, workflowLateEvidenceSubmissions, type Db } from "@paperclipai/db";
import { HttpError } from "../../errors.js";
import { loadCuJob } from "../workflow-resume-cu-binding.js";
import { fail } from "../workflow-resume-cu-contract.js";
import { exactResultPath, producerForSubmission } from "./exact-artifact-validation.js";
import { registerWorkflowArtifactWithStorage } from "./registered-artifact-storage.js";

/** Pinned replays retry storage only. Pending receiver/no result and blocked rows stay read-only. */
export async function registerPersistedCuResult(db: Db, scope: { companyId: string; missionId: string }, id: string, actorId: string) {
  const [submission] = await db.select().from(workflowLateEvidenceSubmissions).where(and(
    eq(workflowLateEvidenceSubmissions.id, id), eq(workflowLateEvidenceSubmissions.companyId, scope.companyId),
    eq(workflowLateEvidenceSubmissions.missionId, scope.missionId)));
  if (!submission?.cuJobId) fail("cu_submission_not_found", 404);
  if (submission.state === "blocked" || !submission.cuResultBase64 || !submission.cuResultSha256) return;
  const { job } = await loadCuJob(db, scope.companyId, scope.missionId, submission.cuJobId);
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, submission.issueId),
    eq(issues.companyId, scope.companyId), eq(issues.missionId, scope.missionId)));
  if (!issue) fail("cu_artifact_scope_mismatch", 422);
  try {
    await registerWorkflowArtifactWithStorage({ db, issue, actor: { actorType: "user", actorId, agentId: null, runId: null },
      data: { path: exactResultPath(id), type: "artifact", isPrimary: false }, exactProducer: producerForSubmission(submission, job) });
  } catch (error) {
    if (submission.state === "verified" || !(error instanceof HttpError) || error.message !== "cu_artifact_readback_failed") throw error;
    // The exact service retained pending_readback with a fixed retry diagnostic. No receiver restart.
  }
}

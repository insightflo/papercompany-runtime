import { and, eq } from 'drizzle-orm';
import { workflowRuns, workflowStepRuns, type Db } from '@paperclipai/db';
import { readFrozenArtifactAttempt } from './artifact-contract-runtime.js';

/** Provider labels come from the current durable attempt, not a URL or agent request. */
export async function publicationPreviewProvider(db: Db, issue: { id: string; companyId: string }) {
  const rows = await db.select({ step: workflowStepRuns }).from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId)).where(and(
      eq(workflowStepRuns.issueId, issue.id), eq(workflowRuns.companyId, issue.companyId)));
  if (rows.length !== 1 || rows[0].step.metadata.artifactExecution === undefined) return 'public_url';
  const step = rows[0].step;
  const frozen = readFrozenArtifactAttempt(step.metadata.artifactExecution,
    { executionGeneration: step.executionGeneration, requestId: step.lastDispatchRequestId ?? '' });
  return frozen.contract.previewProvider ?? 'public_url';
}

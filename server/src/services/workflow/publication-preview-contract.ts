import { and, eq } from 'drizzle-orm';
import { workflowRuns, workflowStepRuns, type Db } from '@paperclipai/db';
import { readCompletedSourceArtifactAttempt, readFrozenArtifactAttempt } from './artifact-contract-runtime.js';

/** Provider labels come from the current durable attempt, not a URL or agent request. */
export async function publicationPreviewProvider(db: Db, issue: { id: string; companyId: string }) {
  const rows = await db.select({ step: workflowStepRuns }).from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId)).where(and(
      eq(workflowStepRuns.issueId, issue.id), eq(workflowRuns.companyId, issue.companyId)));
  if (rows.length !== 1 || rows[0].step.metadata.artifactExecution === undefined) return 'public_url';
  const step = rows[0].step;
  // 완료 소스는 생성 시도의 냉동 계약 기준(전방향 유효); 그 외 행은 현재 세대 정확-일치.
  const frozen = step.status === 'completed'
    ? readCompletedSourceArtifactAttempt(step.metadata.artifactExecution, step)
    : readFrozenArtifactAttempt(step.metadata.artifactExecution,
      { executionGeneration: step.executionGeneration, requestId: step.lastDispatchRequestId ?? '' });
  return frozen.contract.previewProvider ?? 'public_url';
}

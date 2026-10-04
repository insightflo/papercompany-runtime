import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { workflowRuns, workflowStepRuns, type Db } from '@paperclipai/db';
import { readCompletedSourceArtifactAttempt, readFrozenArtifactAttempt, type FrozenArtifactAttempt } from './artifact-contract-runtime.js';
import { readObject } from './core-tool-context.js';
import { captureArtifactRoot, readArtifactBytes } from './artifact-files.js';
import { adaptPublication } from './publication-result.js';
import { verifyQaCompletion } from './qa-artifact-receipt.js';
import { resolveQaReceiptPath } from './qa-artifact-consumer.js';

type Row = { stepRun: typeof workflowStepRuns.$inferSelect; run: typeof workflowRuns.$inferSelect };
/**
 * 완료 소스는 생성 시도의 냉동 스냅숏 기준으로 읽는다(전방향 유효 — 종결/복구가 행 세대를
 * 올려도 원본 영수증은 소비 가능). running/failed 행은 현재 세대 정확-일치 스코프를 유지한다.
 */
function completedSourceFrozenAttempt(s: typeof workflowStepRuns.$inferSelect): FrozenArtifactAttempt | null {
  if (s.metadata.artifactExecution === undefined) return null;
  return s.status === 'completed'
    ? readCompletedSourceArtifactAttempt(s.metadata.artifactExecution, s)
    : readFrozenArtifactAttempt(s.metadata.artifactExecution,
      { executionGeneration: s.executionGeneration, requestId: s.lastDispatchRequestId ?? '' });
}
function artifactRole(row: Row, declared: unknown) {
  const s = row.stepRun;
  const frozen = completedSourceFrozenAttempt(s);
  if (frozen) return frozen.contract.role;
  // Historical QA attempts have request/receipt authority but no frozen v2 contract.
  if (s.metadata.toolArtifactRequest || s.metadata.toolArtifactReceipt || readObject(declared).role === 'qa') return 'qa';
  if (declared !== undefined) throw new Error('artifact_contract_snapshot_required');
  return null;
}

/** Accept only the bytes returned by the machine-result verifier for this exact frozen attempt. */
async function verifyPublicationPath(row: Row, artifactPath: unknown, data: unknown, requestId: unknown) {
  const s = row.stepRun;
  const frozen = completedSourceFrozenAttempt(s);
  if (!frozen) throw new Error('artifact_contract_snapshot_required');
  if (requestId !== s.lastDispatchRequestId || typeof artifactPath !== 'string' || !path.isAbsolute(artifactPath)
    || path.basename(artifactPath) !== frozen.contract.resultFileName) throw new Error('qa_publication_receipt_unavailable');
  const root = await captureArtifactRoot(path.dirname(artifactPath));
  const bytes = await readArtifactBytes(root, frozen.contract.resultFileName, 1024 * 1024);
  const raw: unknown = JSON.parse(bytes.toString('utf8'));
  const { artifactPath: storedPath, ...stored } = readObject(data);
  if (storedPath !== artifactPath || !isDeepStrictEqual(raw, stored)) throw new Error('qa_publication_receipt_bytes_changed');
  const result = adaptPublication(raw, frozen.contract);
  if (!row.run.missionId || !isDeepStrictEqual(result.scope, {
    companyId: row.run.companyId, missionId: row.run.missionId, workflowRunId: row.run.id,
    stepRunId: s.id, stepId: s.stepId, requestId,
    executionGeneration: s.status === 'completed' ? frozen.executionGeneration : s.executionGeneration,
    retryCount: s.retryCount, iterationIndex: s.iterationIndex,
  })) throw new Error('qa_publish_result_scope_mismatch');
  return artifactPath;
}

export async function verifyArtifactStepCompletion(row: Row, declared: unknown, input: {
  success: boolean; requestId?: string; toolArtifactReceipt?: unknown; artifactPath?: string; data?: unknown;
}) {
  if (!input.success) return null;
  const role = artifactRole(row, declared);
  if (!role) return null;
  if (role === 'qa') {
    const receipt = await verifyQaCompletion(input.toolArtifactReceipt, row, input.requestId);
    return { receipt, requestId: receipt.requestId };
  }
  await verifyPublicationPath(row, input.artifactPath, input.data, input.requestId);
  return { receipt: null, requestId: input.requestId! };
}

/** Issue-less artifact paths must come from completed, same-company/run attempts. */
export async function resolveToolResultPaths(input: { db: Db; run: { id: string; companyId: string };
  workflowSteps: Array<{ id: string; toolArtifactContract?: unknown }> }, unresolvedStepIds: string[], paths: Map<string, string>) {
  if (!unresolvedStepIds.length) return;
  const rows = await input.db.select({ stepRun: workflowStepRuns, run: workflowRuns }).from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId)).where(and(
      eq(workflowRuns.id, input.run.id), eq(workflowRuns.companyId, input.run.companyId),
      inArray(workflowStepRuns.stepId, unresolvedStepIds)))
    .orderBy(desc(workflowStepRuns.completedAt), desc(workflowStepRuns.id));
  for (const row of rows) {
    const s = row.stepRun;
    if (paths.has(s.stepId)) continue;
    const role = artifactRole(row, input.workflowSteps.find(step => step.id === s.stepId)?.toolArtifactContract);
    if (role === 'qa') {
      paths.set(s.stepId, await resolveQaReceiptPath(input.db, { companyId: input.run.companyId, workflowRunId: input.run.id, stepId: s.stepId }));
      continue;
    }
    const stored = readObject(s.metadata.toolResult);
    if (role) {
      if (s.status !== 'completed' || s.metadata.cacheHit || stored.success !== true) throw new Error('qa_publication_receipt_unavailable');
      paths.set(s.stepId, await verifyPublicationPath(row, stored.artifactPath, stored.data, stored.requestId));
    } else if (typeof stored.artifactPath === 'string' && stored.artifactPath.trim()) {
      // Preserve the non-contract legacy transport.
      paths.set(s.stepId, path.resolve(stored.artifactPath.trim()));
    }
  }
}

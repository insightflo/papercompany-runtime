import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, eq } from 'drizzle-orm';
import { workflowRuns, workflowStepRuns } from '@paperclipai/db';
import { readFrozenArtifactAttempt, type FrozenArtifactAttempt } from './artifact-contract-runtime.js';
import { captureArtifactRoot, readArtifactBytes } from './artifact-files.js';
import { createArtifactDirectory } from './artifact-writer.js';
import { captureQaDispatch, type QaDispatchScope } from './qa-dispatch-guard.js';
import { encodeQaInput } from './qa-byte-transport.js';
import { readObject } from './core-tool-context.js';
import { adaptPublication, type PublicationScope } from './publication-result.js';

/** A completed scoped machine result, not an arbitrary path or diagnostic stdout, authorizes readback. */
export async function preparePublicationVerifyConsumer(input: QaDispatchScope & { parameters: unknown;
  artifactExecution: FrozenArtifactAttempt; dispatch?: Awaited<ReturnType<typeof captureQaDispatch>> }) {
  const contract = input.artifactExecution.contract, args = readObject(input.parameters);
  const sourcePath = contract.consumerParams && args[contract.consumerParams.receipt];
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) throw new Error('qa_artifact_consumer_receipt_required');
  const dispatch = input.dispatch ?? await captureQaDispatch(input);
  const rows = await input.db.select({ step: workflowStepRuns, run: workflowRuns }).from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId)).where(and(
      eq(workflowRuns.id, input.workflowRunId!), eq(workflowRuns.companyId, input.companyId)));
  const matches = rows.filter(({ step }) => readObject(step.metadata.toolResult).artifactPath === sourcePath);
  if (matches.length !== 1) throw new Error('qa_artifact_consumer_receipt_required');
  const { step, run } = matches[0], stored = readObject(step.metadata.toolResult);
  if (step.status !== 'completed' || step.metadata.cacheHit || stored.success !== true
    || stored.requestId !== step.lastDispatchRequestId) throw new Error('qa_publication_receipt_unavailable');
  const producer = readFrozenArtifactAttempt(step.metadata.artifactExecution,
    { executionGeneration: step.executionGeneration, requestId: step.lastDispatchRequestId ?? '' });
  if (producer.contract.role !== 'publication' || path.basename(sourcePath) !== producer.contract.resultFileName)
    throw new Error('qa_publication_receipt_contract_mismatch');
  const root = await captureArtifactRoot(path.dirname(sourcePath));
  const sourceBytes = await readArtifactBytes(root, producer.contract.resultFileName, 1024 * 1024);
  const raw: unknown = JSON.parse(sourceBytes.toString('utf8'));
  const { artifactPath: storedPath, ...storedData } = readObject(stored.data);
  if (storedPath !== sourcePath || !isDeepStrictEqual(raw, storedData)) throw new Error('qa_publication_receipt_bytes_changed');
  const sourcePublication = adaptPublication(raw, producer.contract);
  const producerScope: PublicationScope = { companyId: input.companyId, missionId: run.missionId!, workflowRunId: run.id,
    stepRunId: step.id, stepId: step.stepId, requestId: step.lastDispatchRequestId!, executionGeneration: step.executionGeneration,
    retryCount: step.retryCount, iterationIndex: step.iterationIndex };
  if (!run.missionId || !isDeepStrictEqual(sourcePublication.scope, producerScope)) throw new Error('qa_publish_result_scope_mismatch');
  const consumer = rows.find(({ step: s }) => s.id === input.stepRunId)?.step;
  if (!consumer || !input.stepId || !input.requestId) throw new Error('qa_artifact_request_stale');
  const publicationScope: PublicationScope = { ...producerScope, stepRunId: consumer.id, stepId: input.stepId,
    requestId: input.requestId, executionGeneration: consumer.executionGeneration, retryCount: consumer.retryCount,
    iterationIndex: consumer.iterationIndex };
  await dispatch.assertCurrent();
  const resultRoot = await createArtifactDirectory(root, `verification-${randomUUID()}`, [], []);
  return { parameters: args, inputBytes: encodeQaInput(sourceBytes, [], null, undefined, contract.inputEnvelopeVersion),
    resultRoot, publicationScope, sourcePublication, contract, dispatch };
}

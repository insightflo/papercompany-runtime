import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { heartbeatRuns, issues, workflowStepRuns, type Db } from '@paperclipai/db';
import { HttpError, unprocessable, conflict } from '../../errors.js';
import { producerAttempt } from '../work-products/producer-attempt.js';
import { lockProducerSelection } from '../work-products/producer-selection-lock.js';
import { artifactAttemptMetadata, freezeCompanyArtifactAttempt } from './artifact-attempt-start.js';
import { captureQaDispatch } from './qa-dispatch-guard.js';
import { loadExecutionDefinition } from './execution-definition.js';
import { readObject, resolveWorkflowRunStepEnv } from './core-tool-context.js';
import { resolveWorkflowToolStepArgs } from './tool-step-args.js';
import { verifyArtifactStepCompletion } from './artifact-step-result.js';
import type { executeCoreWorkflowTool, CoreWorkflowToolExecutionResult } from './core-tool-executor.js';

type CoreInput = Parameters<typeof executeCoreWorkflowTool>[0];
type Binding = Awaited<ReturnType<typeof bindAttempt>>;
const bindingRequired = () => unprocessable('artifact_tool_step_binding_required');

async function bindAttempt(input: CoreInput) {
  const { db, companyId } = input;
  const [heartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.heartbeatRunId!));
  if (!heartbeat || heartbeat.companyId !== companyId || heartbeat.agentId !== input.agentId
    || heartbeat.status !== 'running' || !heartbeat.issueId || heartbeat.workflowExecutionGeneration === null) throw bindingRequired();
  const candidates = await db.select().from(workflowStepRuns).where(heartbeat.workflowStepRunId
    ? eq(workflowStepRuns.id, heartbeat.workflowStepRunId) : eq(workflowStepRuns.issueId, heartbeat.issueId));
  if (candidates.length !== 1) throw bindingRequired();
  const observed = candidates[0];
  return db.transaction(async tx => {
    // Existing producer/engine lock order; no locks are held while the tool runs.
    const locked = await lockProducerSelection(tx, { companyId, workflowRunId: observed.workflowRunId,
      stepRunIds: [observed.id] }, 'update');
    const run = locked.run, stepRun = locked.steps[0];
    const [current] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, heartbeat.id));
    const [issue] = await tx.select().from(issues).where(eq(issues.id, heartbeat.issueId!));
    if (!run || run.status !== 'running' || !stepRun || stepRun.status !== 'running'
      || stepRun.issueId !== heartbeat.issueId || stepRun.executionGeneration !== heartbeat.workflowExecutionGeneration
      || !current || current.status !== 'running' || current.companyId !== companyId || current.agentId !== input.agentId
      || current.issueId !== heartbeat.issueId || current.workflowStepRunId !== heartbeat.workflowStepRunId
      || current.workflowExecutionGeneration !== heartbeat.workflowExecutionGeneration
      || !issue || issue.companyId !== companyId || issue.missionId !== run.missionId || issue.assigneeAgentId !== input.agentId
      || (issue.executionRunId && issue.executionRunId !== heartbeat.id)) throw bindingRequired();
    // Original server wake proves retry + iteration too; a late heartbeat cannot adopt a reworked row.
    try { await producerAttempt(tx, current, stepRun); } catch { throw bindingRequired(); }
    const execution = await loadExecutionDefinition(tx, run.id, { requireHistorical: false });
    const step = execution.steps.find(s => s.id === stepRun.stepId);
    if (!step || !step.agentId || step.agentId !== input.agentId) throw bindingRequired();
    // One in-flight artifact call per step, across tools and server processes. Never steal a
    // claimed request on a timer: after a crash the existing retry/rework path must reset it.
    const claim = readObject(stepRun.metadata.toolQueue);
    const priorAttempt = [claim.executionGeneration, claim.retryCount, claim.iterationIndex];
    const currentAttempt = [stepRun.executionGeneration, stepRun.retryCount, stepRun.iterationIndex];
    const replacedAttempt = priorAttempt.every(n => typeof n === 'number')
      && priorAttempt.some((n, i) => n !== currentAttempt[i]);
    if (claim.status === 'claimed' && !replacedAttempt) throw conflict('artifact_tool_step_call_in_progress');
    const requestId = randomUUID(), now = new Date();
    const frozen = await freezeCompanyArtifactAttempt({ db: tx as unknown as Db, companyId, toolName: input.toolName,
      step, executionGeneration: stepRun.executionGeneration, requestId });
    if (!frozen) throw unprocessable('artifact_contract_required');
    const metadata = artifactAttemptMetadata(stepRun.metadata, frozen);
    // A later invocation supersedes only this step's evidence, never an earlier QA step's.
    delete metadata.toolArtifactRequest; delete metadata.toolArtifactReceipt; delete metadata.toolResult; delete metadata.cacheHit;
    Object.assign(metadata, { toolInvocation: { requestId, toolName: input.toolName, args: input.parameters,
      dispatchedAt: now.toISOString() }, toolQueue: { status: 'claimed', claimedAt: now.toISOString(),
        executionGeneration: stepRun.executionGeneration, retryCount: stepRun.retryCount, iterationIndex: stepRun.iterationIndex } });
    await tx.update(workflowStepRuns).set({ lastDispatchRequestId: requestId, lastDispatchAttemptAt: now,
      lastDispatchAcceptedAt: now, lastDispatchErrorAt: null, lastDispatchErrorSummary: null, metadata })
      .where(eq(workflowStepRuns.id, stepRun.id));
    const scope = { companyId, workflowRunId: run.id, stepRunId: stepRun.id, stepId: stepRun.stepId, requestId };
    let dispatch: Awaited<ReturnType<typeof captureQaDispatch>>;
    try { dispatch = await captureQaDispatch({ db, ...scope }, tx); } catch { throw bindingRequired(); }
    if (frozen.contract.role === 'qa') {
      // Establish the same exact input pin as engine dispatch, inside the attempt lock.
      // Parameters/prose never supply a missing contract or choose a producer.
      const contract = readObject(readObject(step).toolArtifactContract);
      if (typeof contract.inputStepId !== 'string') throw new Error('qa_artifact_input_contract_required');
      await resolveWorkflowToolStepArgs({ db: tx as unknown as Db, run, consumerStepRunId: scope.stepRunId,
        workflowSteps: execution.steps, step: { ...step, toolArgs: { input: `{$steps.${contract.inputStepId}.workProductPath}` } } });
    }
    return { scope, run, stepRun, step, dispatch };
  });
}

async function storeResult(db: Db, binding: Binding, result: Awaited<ReturnType<typeof executeCoreWorkflowTool>>) {
  const { scope } = binding;
  await binding.dispatch.assertCurrent();
  const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, scope.stepRunId));
  // Exactly the engine's receipt/byte verifier, without its step-completion side effect.
  const verified = await verifyArtifactStepCompletion({ run: binding.run, stepRun }, readObject(binding.step).toolArtifactContract,
    { success: result.status === 200, requestId: scope.requestId, toolArtifactReceipt: result.toolArtifactReceipt,
      artifactPath: result.artifactPath, data: result.body.data });
  const receipt = verified?.receipt;
  const artifactPath = receipt ? path.join(receipt.outputRoot, receipt.relativePath) : result.artifactPath;
  const stored = { toolResult: { requestId: scope.requestId, toolName: readObject(stepRun.metadata.toolInvocation).toolName,
    success: result.status === 200, data: result.body.data, ...(artifactPath && !receipt ? { artifactPath } : {}),
    error: result.body.error ?? null, completedAt: new Date().toISOString() }, ...(receipt ? { toolArtifactReceipt: receipt } : {}) };
  await db.transaction(async tx => {
    await lockProducerSelection(tx, { companyId: scope.companyId, workflowRunId: scope.workflowRunId,
      stepRunIds: [scope.stepRunId] }, 'update');
    await binding.dispatch.assertCurrent();
    const updated = await tx.update(workflowStepRuns).set({ metadata: sql`${workflowStepRuns.metadata} || ${JSON.stringify(stored)}::jsonb` })
      .where(and(eq(workflowStepRuns.id, scope.stepRunId), eq(workflowStepRuns.status, 'running'),
        eq(workflowStepRuns.executionGeneration, binding.stepRun.executionGeneration), eq(workflowStepRuns.retryCount, binding.stepRun.retryCount),
        eq(workflowStepRuns.iterationIndex, binding.stepRun.iterationIndex), eq(workflowStepRuns.lastDispatchRequestId, scope.requestId)))
      .returning({ id: workflowStepRuns.id });
    if (updated.length !== 1) throw new Error('qa_artifact_request_stale');
  });
  return receipt ? { ...result, artifactPath, body: { ...result.body, data: { ...readObject(result.body.data), artifactPath } } } : result;
}

/** Server-only entry: no binding field or attempt identity is read from tool parameters. */
export async function executeAgentArtifactTool(input: CoreInput, execute: typeof executeCoreWorkflowTool): Promise<CoreWorkflowToolExecutionResult> {
  let binding: Binding | undefined;
  try {
    binding = await bindAttempt(input);
    const { scope } = binding;
    const { heartbeatRunId: _, ...coreInput } = input;
    const stepEnv = await resolveWorkflowRunStepEnv(input.db, scope);
    const result = await execute({ ...coreInput, ...scope, artifactDispatch: binding.dispatch, issueId: binding.stepRun.issueId,
      stepEnv: { ...stepEnv, PAPERCLIP_WORKFLOW_STEP_ID: scope.stepId } });
    return await storeResult(input.db, binding, result);
  } catch (error) {
    const status = error instanceof HttpError && error.status === 409 ? 409 as const : 422 as const;
    return { status, body: { error: error instanceof Error ? error.message : String(error), source: 'core' as const, tool: input.toolName } };
  } finally {
    if (binding) await input.db.update(workflowStepRuns).set({ metadata:
      sql`${workflowStepRuns.metadata} || ${JSON.stringify({ toolQueue: { status: 'settled' } })}::jsonb` })
      .where(and(eq(workflowStepRuns.id, binding.scope.stepRunId), eq(workflowStepRuns.lastDispatchRequestId, binding.scope.requestId),
        eq(workflowStepRuns.executionGeneration, binding.stepRun.executionGeneration), eq(workflowStepRuns.retryCount, binding.stepRun.retryCount),
        eq(workflowStepRuns.iterationIndex, binding.stepRun.iterationIndex)));
  }
}

/** Accepts tool callbacks; issued QA completion, proof and consumption commit atomically before sync. */
import { isDeepStrictEqual as same } from "node:util";
import { and, eq } from "drizzle-orm";
import { missions, workflowDefinitions, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import type { WorkflowStep } from "./dag-engine.js";
import type { WorkflowExecutionResult } from "./types.js";
import { recordWorkflowStepStatusTransition, type WorkflowSyncSource } from "./workflow-sync-source.js";
import { readOwnResumeRequestId } from "./resume-scope-fence.js";
import { loadExecutionDefinition } from "./execution-definition.js";
import { isWorkflowChildStep } from "./workflow-child-execution.js";
import { isStructuralGateStep, readStructuralGateProducerToken } from "./control-flow/structural-gate.js";
import { shouldRejectStructuralCallback, atomicStructuralCompletion } from "./control-flow/structural-completion.js";
import { lockFailureObservationScope } from "./tool-dispatch-failure.js";
import { isQaRebindConsumer } from "./qa-rebind-candidate.js";
import { prepareToolCompletion, withMachineToolTruth, writePreparedToolCompletion } from "./tool-completion-preparation.js";
import { assertQaReceiptScope, compareQaCorrectionReceiptFiles, persistQaCorrectionToolConsumption } from "./qa-artifact-receipt.js";
import { findWorkflowVerdictCorrection } from "./workflow-verdict-current.js";
import { createQaCorrectionHistorySession } from "./control-flow/qa-correction-history-session.js";
import { observeQaCorrectionToolCompletion, readCurrentQaCorrectionFollowup,
  readQaCorrectionToolReplay } from "./control-flow/qa-correction-followup.js";
import { prepareWorkflowVerdictLocks, lockWorkflowVerdictDependencies } from "./workflow-verdict-write.js";
import { lockQualityAttemptBudget } from "../quality/retry-budget.js";

const WORKFLOW_STEP_TERMINAL_STATUSES = new Set(["completed", "failed", "skipped"]);
class ToolCompletionCasLost extends Error {}

export interface WorkflowToolResultInput {
    companyId: string;
    stepRunId: string;
    success: boolean;
    requestId?: string;
    workflowRunId?: string;
    stepId?: string;
    toolName?: string;
    stdout?: string;
    data?: unknown;
    artifactPath?: string; toolArtifactReceipt?: unknown;
    stderr?: string;
    exitCode?: number | null;
    error?: string;
    allowTerminalRecovery?: boolean;
}
export interface WorkflowToolResultAcceptanceHooks {
  normalizeRecord(value: unknown): Record<string, unknown>;
  getMetadataRecord(value: unknown, key: string): Record<string, unknown>;
  readMetadataString(value: unknown): string | undefined;
  buildWorkflowStepRunMetadata(step: WorkflowStep, existingMetadata?: unknown): Record<string, unknown>;
  getWorkflowExecutionResultSnapshot(db: Db, runId: string): Promise<WorkflowExecutionResult | null>;
  syncWorkflowRunState(db: Db, runId: string, source: WorkflowSyncSource): Promise<WorkflowExecutionResult>;
}
export async function acceptWorkflowToolResult(
  db: Db,
  input: WorkflowToolResultInput,
  hooks: WorkflowToolResultAcceptanceHooks,
): Promise<WorkflowExecutionResult | null> {
  const { getMetadataRecord, getWorkflowExecutionResultSnapshot, syncWorkflowRunState } = hooks;
  const row = await db
    .select({ stepRun: workflowStepRuns, run: workflowRuns, definition: workflowDefinitions })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .innerJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
    .where(eq(workflowStepRuns.id, input.stepRunId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row || row.run.companyId !== input.companyId) return null;
  if (input.workflowRunId && input.workflowRunId !== row.run.id) return null;
  if (input.stepId && input.stepId !== row.stepRun.stepId) return null;
  // Resume callbacks require the exact durable dispatch identity.
  const resumeScopeRequestId = readOwnResumeRequestId(row.stepRun.metadata);
  if (
    resumeScopeRequestId !== null
    && (input.requestId === undefined || input.requestId !== row.stepRun.lastDispatchRequestId)
  ) {
    return getWorkflowExecutionResultSnapshot(db, row.run.id);
  }
  if (input.requestId && row.stepRun.lastDispatchRequestId && input.requestId !== row.stepRun.lastDispatchRequestId) {
    return null;
  }
  // Load the captured execution definition before any mutation.
  const steps = (await loadExecutionDefinition(db, row.run.id, { requireHistorical: false })).steps;
  const stepForGuard = steps.find((candidate) => candidate.id === row.stepRun.stepId);
  // Child settlement owns workflow-child completion; generic callbacks only observe it.
  if (stepForGuard && isWorkflowChildStep(stepForGuard)) {
    return getWorkflowExecutionResultSnapshot(db, row.run.id);
  }
  // Machine-contract failures remain failures; structural gates keep their own verdict contract.
  input = withMachineToolTruth(input, stepForGuard);
  if (shouldRejectStructuralCallback(stepForGuard, input.requestId, row.stepRun.lastDispatchRequestId)) {
    return null;
  }
  const canRecoverTerminalFailure = input.allowTerminalRecovery === true
    && input.success
    && row.stepRun.status === "failed";
  if (WORKFLOW_STEP_TERMINAL_STATUSES.has(row.stepRun.status) && !canRecoverTerminalFailure) {
    return getWorkflowExecutionResultSnapshot(db, row.run.id);
  }
  const prepared = await prepareToolCompletion(row, stepForGuard, input, hooks);
  const { now, existingMetadata, toolRequestId, artifactCompletion, toolArtifactReceipt,
    resultMetadata, completionPlan } = prepared;

  // Structural verdict and step CAS remain in their existing atomic writer.
  if (isStructuralGateStep(stepForGuard)) {
    const structuralGateProducerToken = readStructuralGateProducerToken(
      existingMetadata.structuralGateProducerToken,
    );
    const atomic = await atomicStructuralCompletion({
      db, step: stepForGuard, success: input.success, data: input.data,
      companyId: row.run.companyId, workflowRunId: row.run.id,
      workflowStepRunId: row.stepRun.id, missionId: row.run.missionId, issueId: row.stepRun.issueId, requestId: toolRequestId!,
      source: "workflow_tool_result",
      observedStatus: row.stepRun.status,
      observedIterationIndex: row.stepRun.iterationIndex ?? null,
      observedRequestId: row.stepRun.lastDispatchRequestId,
      observedCompletedAt: row.stepRun.completedAt,
      observedExecutionGeneration: row.stepRun.executionGeneration,
      producerToken: structuralGateProducerToken,
      patch: {
        startedAt: row.stepRun.startedAt ?? now, completedAt: now,
        metadata: resultMetadata,
        fallbackFailureSummary: input.error ?? input.stderr ?? null,
      },
    });
    if (!atomic.casWon) return getWorkflowExecutionResultSnapshot(db, row.run.id);
    return syncWorkflowRunState(db, row.run.id, "workflow_tool_result");
  }

  // Successful tools also expose dispatch readiness to downstream evaluation.
  const { effectiveSuccess } = completionPlan;
  const nextStatus = effectiveSuccess ? "completed" : "failed";
  // Generation fences terminal/recovery changes; resume also fences transition version.
  const completionCasCondition = and(
    eq(workflowStepRuns.executionGeneration, row.stepRun.executionGeneration),
    ...(artifactCompletion ? [eq(workflowStepRuns.lastDispatchRequestId, artifactCompletion.requestId), eq(workflowStepRuns.status, "running")] : []),
    ...(resumeScopeRequestId !== null
      ? [eq(workflowStepRuns.statusTransitionVersion, row.stepRun.statusTransitionVersion)]
      : []),
  );
  const observeFailure = nextStatus === "failed" && isQaRebindConsumer(row.stepRun.issueId, stepForGuard, existingMetadata);
  const writeCompletion = (writer: Db) =>
    writePreparedToolCompletion(writer, row, stepForGuard, input, prepared, completionCasCondition);
  // Files and frozen-receipt verification above run without locks. Only issued QA uses this writer.
  const correction = effectiveSuccess && toolArtifactReceipt && row.stepRun.issueId
    ? await findWorkflowVerdictCorrection(db, { companyId: row.run.companyId, issueId: row.stepRun.issueId,
      workflowRunId: row.run.id, workflowStepRunId: row.stepRun.id }) : null;
  const requestRef = getMetadataRecord(existingMetadata, "toolArtifactRequest").qaCorrectionFollowup;
  if (toolArtifactReceipt && (correction || requestRef !== undefined)
    && (!correction || !same(correction.ref, requestRef))) throw new Error("qa_correction_tool_request_changed");
  let updatedStepRun;
  if (correction && toolArtifactReceipt) {
    const observation = await observeQaCorrectionToolCompletion(db, correction.ref, toolRequestId!,
      createQaCorrectionHistorySession(db, correction.ref));
    if (!observation) return getWorkflowExecutionResultSnapshot(db, row.run.id);
    const dependencies = await prepareWorkflowVerdictLocks(db, correction, []);
    updatedStepRun = await db.transaction(async tx => {
      const p = correction.issued.preparation, connection = tx as unknown as Db;
      if (p.authority.kind === "quality_current_output") await lockQualityAttemptBudget(tx,
        { companyId: p.companyId, actionId: p.authority.actionId, now: new Date() });
      // Existing order: quality → mission → run → heartbeat → issue → sorted steps → products → bindings.
      await tx.select().from(missions).where(and(eq(missions.companyId, p.companyId),
        eq(missions.id, p.missionId))).for("update");
      await tx.select().from(workflowRuns).where(and(eq(workflowRuns.companyId, p.companyId),
        eq(workflowRuns.id, p.workflowRunId))).for("update");
      if (await readQaCorrectionToolReplay(tx, correction.ref, toolRequestId!,
        createQaCorrectionHistorySession(tx, correction.ref))) throw new ToolCompletionCasLost();
      await lockWorkflowVerdictDependencies(tx, dependencies);
      const current = await readCurrentQaCorrectionFollowup(tx, correction.ref, observation,
        createQaCorrectionHistorySession(tx, correction.ref));
      const latest = await findWorkflowVerdictCorrection(tx, { companyId: p.companyId,
        issueId: row.stepRun.issueId!, workflowRunId: p.workflowRunId, workflowStepRunId: row.stepRun.id });
      if (!same(latest?.ref, correction.ref) || !same(current.database.target.step, row.stepRun)) {
        throw new Error("qa_correction_tool_request_changed");
      }
      assertQaReceiptScope(toolArtifactReceipt,
        { run: current.database.run, stepRun: current.database.target.step }, toolRequestId ?? undefined);
      const revision = current.revisions.length === 1 ? current.revisions[0] : null;
      if (!revision?.workflowProducer || toolArtifactReceipt.input.workProductId !== revision.revision.workProductId
        || compareQaCorrectionReceiptFiles(revision.revision, toolArtifactReceipt.input) !== null
        || !same(toolArtifactReceipt.input.producer, revision.workflowProducer)
        || toolArtifactReceipt.input.mode === "html" && toolArtifactReceipt.input.assetsRoot !== "") {
        throw new Error("qa_correction_tool_input_changed");
      }
      const updated = await writeCompletion(connection);
      // A losing completion must roll back even ancillary budget-lock materialization.
      if (!updated) throw new ToolCompletionCasLost();
      await persistQaCorrectionToolConsumption(connection, current, row.stepRun, toolArtifactReceipt,
        now, updated.transitionVersion);
      return updated;
    }).catch(error => { if (error instanceof ToolCompletionCasLost) return null; throw error; });
  } else {
    // Existing failure observation order: mission → run → step.
    updatedStepRun = observeFailure ? await db.transaction(async tx => {
      await lockFailureObservationScope(tx as unknown as Db, row.run);
      return writeCompletion(tx as unknown as Db);
    }) : await writeCompletion(db);
  }
  if (!updatedStepRun) {
    return getWorkflowExecutionResultSnapshot(db, row.run.id);
  }
  {
    await recordWorkflowStepStatusTransition(db, {
      companyId: row.run.companyId,
      missionId: row.run.missionId,
      workflowRunId: row.run.id,
      workflowStepRunId: row.stepRun.id,
      issueId: row.stepRun.issueId,
      fromStatus: row.stepRun.status,
      toStatus: nextStatus,
      source: "workflow_tool_result",
      transitionVersion: updatedStepRun.transitionVersion > row.stepRun.statusTransitionVersion
        ? updatedStepRun.transitionVersion
        : null,
    });
  }
  return syncWorkflowRunState(db, row.run.id, "workflow_tool_result");
}

import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { and, eq, type SQL } from "drizzle-orm";
import { workflowQaRebindClaims, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import type { WorkflowStep } from "./dag-engine.js";
import type { PersistedWorkflowStep } from "./execution-steps.js";
import type { WorkflowToolResultInput, WorkflowToolResultAcceptanceHooks } from "./workflow-tool-result-acceptance.js";
import { isStructuralGateStep } from "./control-flow/structural-gate.js";
import { planStructuralCompletion } from "./control-flow/structural-completion.js";
import { applyMachineContractTruth } from "./tool-result-truth.js";
import { verifyArtifactStepCompletion } from "./artifact-step-result.js";
import { readWorkflowToolArtifactPath } from "./tool-artifact-path.js";
import { readArtifactDigest } from "./artifact-files.js";
import { stripRetryTrackingOnSuccess } from "./retry-launch-dispatch.js";
import { isQaRebindConsumer, persistQaRebindCandidate } from "./qa-rebind-candidate.js";
import { readQaRebindContext } from "./qa-rebind-evidence.js";
import { settleToolQueueMetadata } from "./tool-queue-settle.js";

type CompletionRow = { run: typeof workflowRuns.$inferSelect; stepRun: typeof workflowStepRuns.$inferSelect };
export type ToolCompletionPreparationHooks = Pick<WorkflowToolResultAcceptanceHooks,
  "normalizeRecord" | "getMetadataRecord" | "readMetadataString" | "buildWorkflowStepRunMetadata">;

export function withMachineToolTruth(input: WorkflowToolResultInput, step: WorkflowStep | undefined): WorkflowToolResultInput {
  return { ...input, ...applyMachineContractTruth({
    success: input.success, data: input.data, error: input.error, exitCode: input.exitCode,
    isStructuralGate: isStructuralGateStep(step),
  }) };
}

/** Shared preparation preserves the legacy artifact, result and retention semantics. */
export async function prepareToolCompletion(
  row: CompletionRow, step: WorkflowStep | undefined, input: WorkflowToolResultInput,
  hooks: ToolCompletionPreparationHooks,
) {
  const { normalizeRecord, getMetadataRecord, readMetadataString, buildWorkflowStepRunMetadata } = hooks;
  const now = new Date();
  const existingMetadata = row.stepRun.metadata && typeof row.stepRun.metadata === "object" && !Array.isArray(row.stepRun.metadata)
    ? row.stepRun.metadata : {};
  const toolRequestId = input.requestId ?? row.stepRun.lastDispatchRequestId ?? null;
  const artifactCompletion = await verifyArtifactStepCompletion(row, (step as PersistedWorkflowStep | undefined)?.toolArtifactContract, input);
  const toolArtifactReceipt = artifactCompletion?.receipt ?? null;
  const artifactDataRecord = normalizeRecord(input.data);
  const relativeArtifactCandidate = [
    typeof input.artifactPath === "string" ? input.artifactPath.trim() : "",
    readMetadataString(artifactDataRecord.rawPath) ?? "",
    readMetadataString(artifactDataRecord.artifactPath) ?? "",
  ].find((candidate) => candidate.length > 0 && !path.isAbsolute(candidate));
  if (relativeArtifactCandidate) throw new Error(`workflow_tool_result_rejected: artifact path is not absolute (${relativeArtifactCandidate})`);
  const artifactPath = toolArtifactReceipt ? null : readWorkflowToolArtifactPath({ artifactPath: input.artifactPath, data: input.data });
  const producedArtifactSha256 = artifactPath && input.success ? await readArtifactDigest(artifactPath) : null;
  const deleteAfterUse = step?.executionControls?.deleteAfterUse === true
    || getMetadataRecord(existingMetadata, "executionControls").deleteAfterUse === true;
  const baseToolResult = {
    requestId: input.requestId ?? row.stepRun.lastDispatchRequestId ?? null,
    toolName: input.toolName ?? null, success: input.success, stdout: input.stdout ?? null,
    ...(input.data === undefined ? {} : { data: toolArtifactReceipt ? { ...artifactDataRecord, artifactPath: undefined, rawPath: undefined } : input.data }),
    ...(artifactPath ? { artifactPath, ...(producedArtifactSha256 ? { artifactSha256: producedArtifactSha256 } : {}) } : {}),
    stderr: input.stderr ?? null, exitCode: input.exitCode ?? null, error: input.error ?? null, completedAt: now.toISOString(),
  };
  const toolResult = input.allowTerminalRecovery === true ? { ...baseToolResult, recoveredBy: "owner-action" } : baseToolResult;
  let resultMetadata: Record<string, unknown> = deleteAfterUse
    ? { ...(step ? buildWorkflowStepRunMetadata(step, existingMetadata) : normalizeRecord(existingMetadata)),
      retentionDeleted: { deleteAfterUse: true, toolName: input.toolName ?? null, success: input.success,
        exitCode: input.exitCode ?? null, deletedAt: now.toISOString() } }
    : { ...existingMetadata, toolResult, ...(toolArtifactReceipt ? { toolArtifactReceipt } : {}) };
  resultMetadata = settleToolQueueMetadata(resultMetadata, now.toISOString());
  if (deleteAfterUse) { delete resultMetadata.toolInvocation; delete resultMetadata.toolResult; delete resultMetadata.cacheHit; }
  const completionPlan = planStructuralCompletion({ step, success: input.success, data: input.data });
  if (completionPlan.effectiveSuccess) resultMetadata = stripRetryTrackingOnSuccess(resultMetadata) ?? resultMetadata;
  return { now, existingMetadata, toolRequestId, artifactCompletion, toolArtifactReceipt, resultMetadata, completionPlan };
}

/** Both callers use the same mutation and failure-observation behavior with their own CAS. */
export async function writePreparedToolCompletion(
  writer: Db, row: CompletionRow, step: WorkflowStep | undefined, input: WorkflowToolResultInput,
  prepared: Awaited<ReturnType<typeof prepareToolCompletion>>, condition: SQL | undefined,
  options: { requireFailureObservation?: boolean } = {},
) {
  const { now, existingMetadata, resultMetadata, completionPlan } = prepared;
  const { effectiveSuccess, structuralGateRejected, structuralContractFailure } = completionPlan;
  const nextStatus = effectiveSuccess ? "completed" : "failed";
  const [updated] = await writer.update(workflowStepRuns).set({
    status: nextStatus, startedAt: row.stepRun.startedAt ?? now, completedAt: now,
    dispatchReadyAt: effectiveSuccess && !row.stepRun.dispatchReadyAt ? now : undefined,
    lastDispatchErrorAt: effectiveSuccess ? null : now,
    lastDispatchErrorSummary: effectiveSuccess ? null
      : structuralGateRejected ? "structural_gate_request_changes"
      : structuralContractFailure ? "structural_gate_contract_failure" : (input.error ?? input.stderr ?? null),
    metadata: resultMetadata,
  }).where(and(eq(workflowStepRuns.id, row.stepRun.id), condition)).returning({
    id: workflowStepRuns.id, transitionVersion: workflowStepRuns.statusTransitionVersion,
    status: workflowStepRuns.status, metadata: workflowStepRuns.metadata,
    requestId: workflowStepRuns.lastDispatchRequestId, generation: workflowStepRuns.executionGeneration,
    acceptedAt: workflowStepRuns.lastDispatchAcceptedAt,
  });
  if (updated && nextStatus === "failed" && isQaRebindConsumer(row.stepRun.issueId, step, existingMetadata)) {
    const scope = { companyId: row.run.companyId, workflowRunId: row.run.id, consumerStepRunId: updated.id };
    await persistQaRebindCandidate(writer, scope);
    if (options.requireFailureObservation) {
      const context = await readQaRebindContext(writer, scope);
      if (!context) throw new Error("retained_failure_observation_scope_missing");
      // The existing observer intentionally emits nothing without an eligible historical role.
      if (context.step.issueId === null && context.step.status === "failed" &&
          (context.role === "publication" || context.role === "publication-verify")) {
        const [observed] = await writer.select().from(workflowQaRebindClaims).where(and(
          eq(workflowQaRebindClaims.companyId, scope.companyId), eq(workflowQaRebindClaims.workflowRunId, scope.workflowRunId),
          eq(workflowQaRebindClaims.consumerStepRunId, updated.id), eq(workflowQaRebindClaims.consumerStepId, context.step.stepId),
          eq(workflowQaRebindClaims.bundleDigest, context.bundleDigest)));
        if (!observed || !isDeepStrictEqual(observed.expectedDigests, context.expectedDigests)) {
          throw new Error("retained_failure_observation_missing");
        }
      }
    }
  }
  return updated;
}

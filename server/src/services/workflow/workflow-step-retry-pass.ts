import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowStepRuns } from "@paperclipai/db";
import type { WorkflowStep } from "./dag-engine.js";
import { isQaLikeStep } from "../missions/supervision-helpers.js";
import { isWorkflowControlNode } from "./control-flow/control-node-executor.js";
import {
  appendRetryAttempt,
  classifyWorkflowStepRetry,
  hasMalformedWorkflowRetry,
  normalizeWorkflowRetryPolicy,
  readWorkflowRetryMetadata,
  sanitizeErrorSummary,
  type WorkflowRetryAttemptSummary,
} from "./retry-policy.js";
import { hasActiveWorkflowRetryRecoveryExecution } from "./retry-execution-state.js";
import { scheduleWorkflowStepRetry } from "./step-retry-scheduler.js";

type StepRun = typeof workflowStepRuns.$inferSelect;

export interface RetryValidationVerdictObservation {
  verdict: "pass" | "request_changes" | null;
  observedAt: Date | null;
}

export interface WorkflowStepRetryPassContext {
  run: { id: string; companyId: string; status: string };
  steps: WorkflowStep[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function supportedStepType(step: WorkflowStep): boolean {
  const stepType = typeof step.type === "string" ? step.type.trim().toLowerCase() : "";
  const hasToolNames = Array.isArray(step.toolNames)
    && step.toolNames.some((tool) => typeof tool === "string" && tool.trim().length > 0);
  if (stepType === "if" || stepType === "complete") return false;
  if (stepType === "" || stepType === "agent") return true;
  return stepType === "tool" && hasToolNames;
}


async function clearRetryMetadata(input: {
  db: Db;
  failedRun: StepRun;
  metadata: Record<string, unknown>;
  appendTerminalAttempt: boolean;
  exhaustion?: { attempts: number; maxRetries: number } | null;
}): Promise<boolean> {
  const retry = readWorkflowRetryMetadata(input.metadata.workflowRetry);
  if (input.appendTerminalAttempt && !retry) return false;
  const cleaned = { ...input.metadata };
  if (retry && input.appendTerminalAttempt) {
    const attempt: WorkflowRetryAttemptSummary = {
      retryNumber: retry.retryNumber,
      failedAt: input.failedRun.completedAt?.toISOString() ?? null,
      errorSummary: sanitizeErrorSummary(input.failedRun.lastDispatchErrorSummary),
    };
    cleaned.workflowRetryAttempts = appendRetryAttempt(
      cleaned.workflowRetryAttempts,
      attempt,
    );
  }
  delete cleaned.workflowRetry;
  delete cleaned.workflowRetryExhaustion;
  if (input.exhaustion) cleaned.workflowRetryExhaustion = input.exhaustion;

  const updated = await input.db.update(workflowStepRuns)
    .set({ metadata: cleaned })
    .where(and(
      eq(workflowStepRuns.id, input.failedRun.id),
      eq(workflowStepRuns.workflowRunId, input.failedRun.workflowRunId),
      eq(workflowStepRuns.status, "failed"),
      eq(workflowStepRuns.retryCount, input.failedRun.retryCount),
      eq(workflowStepRuns.metadata, input.failedRun.metadata),
    ))
    .returning({ id: workflowStepRuns.id });
  return updated.length > 0;
}

export async function applyWorkflowStepRetryPass(input: {
  db: Db;
  context: WorkflowStepRetryPassContext;
  stepRuns: StepRun[];
  validationVerdictsByIssueId: Map<string, RetryValidationVerdictObservation>;
}): Promise<StepRun[]> {
  if (input.context.run.status === "cancelled") return input.stepRuns;
  const failedRuns = input.stepRuns.filter((stepRun) => stepRun.status === "failed");
  if (failedRuns.length === 0) return input.stepRuns;

  const stepRunMap = new Map(input.stepRuns.map((stepRun) => [stepRun.stepId, stepRun]));
  let metadataChanged = false;
  for (const failedRun of failedRuns) {
    const step = input.context.steps.find((candidate) => candidate.id === failedRun.stepId);
    if (!step) continue;
    const metadata = record(failedRun.metadata);
    if (hasMalformedWorkflowRetry(metadata)) {
      await clearRetryMetadata({
        db: input.db,
        failedRun,
        metadata,
        appendTerminalAttempt: false,
      });
      metadataChanged = true;
      continue;
    }

    const hasRetry = readWorkflowRetryMetadata(metadata.workflowRetry) !== null;
    const policy = normalizeWorkflowRetryPolicy(step);
    if (!policy.enabled) {
      if (hasRetry) {
        await clearRetryMetadata({
          db: input.db,
          failedRun,
          metadata,
          appendTerminalAttempt: true,
        });
        metadataChanged = true;
      }
      continue;
    }

    const qaVerdict = failedRun.issueId
      ? input.validationVerdictsByIssueId.get(failedRun.issueId)
      : undefined;
    const structuralGateExcluded = failedRun.lastDispatchErrorSummary
      === "structural_gate_request_changes"
      || failedRun.lastDispatchErrorSummary === "structural_gate_contract_failure";
    const recoveryActive = failedRun.issueId
      ? await hasActiveWorkflowRetryRecoveryExecution(input.db, {
        companyId: input.context.run.companyId,
        issueId: failedRun.issueId,
      })
      : false;
    const decision = classifyWorkflowStepRetry({
      policy,
      stepRunStatus: failedRun.status,
      retryCount: failedRun.retryCount,
      isControlNode: isWorkflowControlNode(step),
      stepTypeSupported: !isWorkflowControlNode(step) && supportedStepType(step),
      isQaStep: isQaLikeStep(step),
      qaRequestChanges: qaVerdict?.verdict === "request_changes" || structuralGateExcluded,
      recoveryActive,
    });

    if (decision.eligible) {
      const errorSummary = failedRun.lastDispatchErrorSummary
        ?? (metadata.toolResult as Record<string, unknown> | undefined)?.error as string | undefined
        ?? null;
      const result = await scheduleWorkflowStepRetry(input.db, {
        companyId: input.context.run.companyId,
        workflowRunId: input.context.run.id,
        stepRunId: failedRun.id,
        retryNumber: decision.retryNumber,
        maxRetries: decision.maxRetries,
        delaySeconds: decision.delaySeconds,
        observedStatus: failedRun.status,
        observedRetryCount: failedRun.retryCount,
        observedCompletedAt: failedRun.completedAt,
        observedLastDispatchRequestId: failedRun.lastDispatchRequestId,
        observedMetadataSnapshot: record(failedRun.metadata),
        errorSummary,
        observedExecutionGeneration: failedRun.executionGeneration,
      });
      if (result.result === "scheduled") metadataChanged = true;
      continue;
    }
    if (!hasRetry || decision.reason === "recovery_active") continue;
    await clearRetryMetadata({
      db: input.db,
      failedRun,
      metadata,
      appendTerminalAttempt: true,
      exhaustion: decision.reason === "exhausted"
        ? { attempts: failedRun.retryCount + 1, maxRetries: policy.maxRetries }
        : null,
    });
    metadataChanged = true;
  }

  return metadataChanged
    ? input.db.select().from(workflowStepRuns).where(eq(
      workflowStepRuns.workflowRunId,
      input.context.run.id,
    ))
    : input.stepRuns;
}

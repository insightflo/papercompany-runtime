// server/src/services/workflow/step-retry-scheduler.ts
//
// Atomic workflow step retry scheduler. Converts an eligible failed step
// into a retry-waiting pending step in a single compare-and-swap transaction.
// The CAS guard on (workflowRunId, stepRunId, status, retryCount,
// completedAt, lastDispatchRequestId, metadata) ensures exactly one retry
// attempt is created per failed snapshot, even under concurrent sync/reconciler calls.

import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import {
  buildWorkflowRetryMetadata,
  appendRetryAttempt,
  sanitizeErrorSummary,
  type WorkflowRetryMetadata,
  type WorkflowRetryAttemptSummary,
} from "./retry-policy.js";
import { isHeartbeatFinalizationV1Enabled } from "../heartbeat-finalization/flag.js";
import {
  appendWorkflowAuthorityTransition,
  supersedeWorkflowDelegationsForGeneration,
} from "./authority/transitions.js";

export type ScheduleWorkflowStepRetryResult =
  | { result: "scheduled"; stepRunId: string; retryNumber: number; delaySeconds: number; nextEligibleAt: string }
  | { result: "already_changed"; stepRunId: string };

/** Sentinel thrown inside the transaction to roll back the event on CAS loss. */
export const RETRY_CAS_LOST_SENTINEL = "workflow-step-retry-cas-lost";

export interface ScheduleWorkflowStepRetryInput {
  companyId: string;
  workflowRunId: string;
  stepRunId: string;
  retryNumber: number;
  maxRetries: number;
  delaySeconds: number;
  observedStatus: string;
  observedRetryCount: number;
  observedCompletedAt: Date | null;
  observedLastDispatchRequestId: string | null;
  /** Exact non-null metadata snapshot observed during retry classification. */
  observedMetadataSnapshot: Record<string, unknown>;
  /** Error summary from the failed attempt (bounded/sanitized). */
  errorSummary: string | null;
  /** Exact execution generation observed during retry classification. */
  observedExecutionGeneration?: number;
}
const RETRY_EVENT_TYPE = "workflow_step_retry_scheduled";
const RETRY_EVENT_LAYER = "workflow_retry";

function buildRetryMetadataPatch(
  input: ScheduleWorkflowStepRetryInput,
  now: Date,
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = { ...input.observedMetadataSnapshot };
  // Clear stale tool-result/invocation and control-flow markers.
  delete cleaned.toolResult;
  delete cleaned.toolInvocation;
  delete cleaned.toolQueue;
  delete cleaned.cacheHit;
  delete cleaned.controlFlowSkipped;
  delete cleaned.workflowRetryExhaustion;

  const retryMeta: WorkflowRetryMetadata = buildWorkflowRetryMetadata({
    retryNumber: input.retryNumber,
    maxRetries: input.maxRetries,
    delaySeconds: input.delaySeconds,
    now,
    sourceRequestId: input.observedLastDispatchRequestId,
    sourceCompletedAt: input.observedCompletedAt?.toISOString() ?? null,
    lastErrorSummary: input.errorSummary,
  });

  const prevAttempt: WorkflowRetryAttemptSummary = {
    retryNumber: input.retryNumber - 1,
    failedAt: input.observedCompletedAt?.toISOString() ?? null,
    errorSummary: sanitizeErrorSummary(input.errorSummary),
  };

  cleaned.workflowRetry = retryMeta;
  cleaned.workflowRetryAttempts = appendRetryAttempt(
    cleaned.workflowRetryAttempts,
    prevAttempt,
  );

  return cleaned;
}

/**
 * Atomically schedule a workflow step retry in a single transaction.
 *
 * 1. Insert idempotent transition event (unique on company_id + idempotency_key).
 * 2. CAS-update the step run: failed → pending, increment retryCount, clear
 *    dispatch/result fields, write bounded retry metadata.
 * 3. Reopen the workflow run as running.
 *
 * CAS loss (row changed since snapshot) rolls back the event insert via the
 * sentinel, then returns `already_changed` outside the transaction. Real
 * database errors propagate to the caller.
 */
export async function scheduleWorkflowStepRetry(
  db: Db,
  input: ScheduleWorkflowStepRetryInput,
): Promise<ScheduleWorkflowStepRetryResult> {
  const idempotencyKey = `workflow-step-retry:${input.stepRunId}:${input.retryNumber}`;
  const now = new Date();
  const finalizationV1Enabled = await isHeartbeatFinalizationV1Enabled(db);
  const observedExecutionGeneration = input.observedExecutionGeneration ?? 0;

  try {
    return await db.transaction(async (tx) => {
      // Step 1: idempotent event insert.
      const claimed = await tx
        .insert(workflowTransitionEvents)
        .values({
          companyId: input.companyId,
          workflowRunId: input.workflowRunId,
          workflowStepRunId: input.stepRunId,
          eventType: RETRY_EVENT_TYPE,
          layer: RETRY_EVENT_LAYER,
          fromStatus: "failed",
          toStatus: "pending",
          decision: "retry",
          reason: "workflow_step_generic_retry",
          reasonCode: RETRY_EVENT_TYPE,
          idempotencyKey,
          payload: {
            stepRunId: input.stepRunId,
            retryNumber: input.retryNumber,
            maxRetries: input.maxRetries,
            delaySeconds: input.delaySeconds,
          },
        })
        .onConflictDoNothing()
        .returning({ id: workflowTransitionEvents.id });

      // Event already exists → a prior call already scheduled this retry.
      if (claimed.length === 0) {
        return { result: "already_changed" as const, stepRunId: input.stepRunId };
      }

      // Step 2: CAS-update the step run. Scope by workflowRunId in addition
      // to stepRunId/status/retryCount/timestamps/metadata so a cross-run
      // collision or unrelated metadata mutation can never match.
      const metadataPatch = buildRetryMetadataPatch(input, now);
      const casConditions = [
        eq(workflowStepRuns.id, input.stepRunId),
        eq(workflowStepRuns.workflowRunId, input.workflowRunId),
        eq(workflowStepRuns.status, input.observedStatus),
        eq(workflowStepRuns.retryCount, input.observedRetryCount),
      ];
      if (input.observedCompletedAt) {
        casConditions.push(eq(workflowStepRuns.completedAt, input.observedCompletedAt));
      } else {
        casConditions.push(isNull(workflowStepRuns.completedAt));
      }
      if (input.observedLastDispatchRequestId) {
        casConditions.push(eq(workflowStepRuns.lastDispatchRequestId, input.observedLastDispatchRequestId));
      } else {
        casConditions.push(isNull(workflowStepRuns.lastDispatchRequestId));
      }
      casConditions.push(eq(workflowStepRuns.metadata, input.observedMetadataSnapshot));
      if (finalizationV1Enabled) {
        casConditions.push(eq(workflowStepRuns.executionGeneration, observedExecutionGeneration));
      }

      const updated = await tx
        .update(workflowStepRuns)
        .set({
          status: "pending",
          retryCount: input.observedRetryCount + 1,
          startedAt: null,
          completedAt: null,
          lastDispatchRequestId: null,
          lastDispatchAttemptAt: null,
          lastDispatchAcceptedAt: null,
          lastDispatchErrorAt: null,
          lastDispatchErrorSummary: null,
          metadata: metadataPatch,
          ...(finalizationV1Enabled
            ? {
                executionGeneration: sql`${workflowStepRuns.executionGeneration} + 1`,
                dispatchOwnerWakeupRequestId: null,
                dispatchOwnerHeartbeatRunId: null,
                evidenceReadyAt: null,
                dispatchReadyAt: null,
              }
            : {}),
        })
        .where(and(...casConditions))
        .returning({ id: workflowStepRuns.id });

      // CAS lost — throw the sentinel to roll back the event insert.
      if (updated.length === 0) {
        throw new Error(RETRY_CAS_LOST_SENTINEL);
      }
      if (finalizationV1Enabled) {
        await supersedeWorkflowDelegationsForGeneration(tx, {
          workflowRunId: input.workflowRunId,
          workflowStepRunId: input.stepRunId,
          executionGeneration: observedExecutionGeneration,
          now,
        });
        await appendWorkflowAuthorityTransition(tx, {
          companyId: input.companyId,
          workflowRunId: input.workflowRunId,
          workflowStepRunId: input.stepRunId,
          executionGeneration: observedExecutionGeneration + 1,
          reason: "workflow_step_retry_generation_advanced",
          idempotencyKey: `authority-generation-retry:${input.stepRunId}:${observedExecutionGeneration}:${observedExecutionGeneration + 1}`,
          payload: {
            version: 1,
            transition: "generation_advanced",
            oldGeneration: observedExecutionGeneration,
            newGeneration: observedExecutionGeneration + 1,
            retryNumber: input.retryNumber,
          },
        });
      }

      // Step 3: reopen the workflow run as running — CAS allowlist
      // (status IN running|failed) serializes cancellation on the run row.
      // If the run was cancelled/completed/pending between snapshot and now,
      // zero rows match: roll back the step reset + event so a cancelled run
      // is never reopened by retry scheduling.
      const reopened = await tx
        .update(workflowRuns)
        .set({
          status: "running",
          completedAt: null,
        })
        .where(and(
          eq(workflowRuns.id, input.workflowRunId),
          eq(workflowRuns.companyId, input.companyId),
          sql`${workflowRuns.status} in ('running', 'failed')`,
        ))
        .returning({ id: workflowRuns.id });

      if (reopened.length === 0) {
        throw new Error(RETRY_CAS_LOST_SENTINEL);
      }

      const retryMeta = metadataPatch.workflowRetry as WorkflowRetryMetadata;
      return {
        result: "scheduled" as const,
        stepRunId: input.stepRunId,
        retryNumber: input.retryNumber,
        delaySeconds: input.delaySeconds,
        nextEligibleAt: retryMeta.nextEligibleAt,
      };
    });
  } catch (err) {
    if (err instanceof Error && err.message === RETRY_CAS_LOST_SENTINEL) {
      return { result: "already_changed" as const, stepRunId: input.stepRunId };
    }
    throw err;
  }
}

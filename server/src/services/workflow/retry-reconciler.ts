// server/src/services/workflow/retry-reconciler.ts
//
// Reconciles delayed workflow step retries. Finds pending step runs with
// workflowRetry metadata whose nextEligibleAt has elapsed and dispatches
// them through normal syncWorkflowRunState.

import type { Db } from "@paperclipai/db";
import { eq, and, inArray } from "drizzle-orm";
import { workflowRuns, workflowStepRuns } from "@paperclipai/db";
import {
  isWorkflowRetryDue,
  readWorkflowRetryMetadata,
  hasMalformedWorkflowRetry,
  sanitizeErrorSummary,
} from "./retry-policy.js";
import { syncWorkflowRunState } from "./dag-engine.js";
import type { ReconciliationResult } from "./reconciler.js";

type DueRetryCandidate = {
  stepRunId: string;
  workflowRunId: string;
  retryNumber: number;
  sourceRequestId: string | null;
};
type DueRetryCurrentRow = {
  stepRunId: string;
  workflowRunId: string;
  status: string;
  retryCount: number;
  metadata: unknown;
  lastDispatchRequestId: string | null;
  lastDispatchAcceptedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
};

export function classifyDueWorkflowRetryRelease(
  candidate: DueRetryCandidate,
  current: DueRetryCurrentRow | undefined,
): ReconciliationResult["action"] {
  if (!current) return "failed";
  if (current.workflowRunId !== candidate.workflowRunId) return "failed";
  if (current.retryCount !== candidate.retryNumber) return "failed";

  const retry = readWorkflowRetryMetadata(
    (current.metadata as Record<string, unknown> | null)?.workflowRetry,
  );
  if (current.status === "pending") {
    if (retry?.retryNumber === candidate.retryNumber && retry.state === "waiting") {
      return "skipped";
    }
    if (retry?.retryNumber === candidate.retryNumber && retry.state === "dispatching") {
      return "recovered";
    }
    return "failed";
  }

  const hasNewExecutionEvidence = Boolean(
    current.lastDispatchRequestId
    && current.lastDispatchRequestId !== candidate.sourceRequestId
    && (current.lastDispatchAcceptedAt || current.startedAt || current.completedAt),
  );
  if (!hasNewExecutionEvidence) return "failed";
  if (current.status === "running" || current.status === "completed") return "recovered";
  return "failed";
}

/**
 * Find all pending step runs with due workflowRetry metadata and dispatch
 * them through normal sync. Called before the generic runnable-step wakeup
 * reconciler so delayed retries are released at the right time.
 */
export async function reconcileDueWorkflowStepRetries(
  db: Db,
  now: Date = new Date(),
): Promise<ReconciliationResult[]> {
  const candidates = await db
    .select({
      stepRunId: workflowStepRuns.id,
      workflowRunId: workflowStepRuns.workflowRunId,
      status: workflowStepRuns.status,
      metadata: workflowStepRuns.metadata,
    })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .where(and(
      eq(workflowStepRuns.status, "pending"),
      eq(workflowRuns.status, "running"),
    ));

  const dueByRunId = new Map<string, DueRetryCandidate[]>();
  const results: ReconciliationResult[] = [];
  for (const candidate of candidates) {
    const meta = candidate.metadata as Record<string, unknown> | null;
    if (!meta) continue;
    // MALFORMED retry metadata must never launch. Record bounded, sanitized
    // reconciliation evidence and leave the step untouched so the stuck-run
    // reconciler / terminal Human Operator evaluation can re-evaluate the
    // now-unrecoverable state.
    if (hasMalformedWorkflowRetry(meta)) {
      results.push({
        runId: candidate.workflowRunId,
        action: "failed",
        reason: sanitizeErrorSummary("workflow retry metadata malformed; not launched") ?? "workflow retry metadata malformed",
      });
      continue;
    }
    const retryMeta = readWorkflowRetryMetadata(meta.workflowRetry);
    if (!retryMeta) continue;
    if (!isWorkflowRetryDue(meta.workflowRetry, now)) continue;
    const due = dueByRunId.get(candidate.workflowRunId) ?? [];
    due.push({
      stepRunId: candidate.stepRunId,
      workflowRunId: candidate.workflowRunId,
      retryNumber: retryMeta.retryNumber,
      sourceRequestId: retryMeta.sourceRequestId,
    });
    dueByRunId.set(candidate.workflowRunId, due);
  }

  for (const [runId, dueCandidates] of dueByRunId) {
    try {
      await syncWorkflowRunState(db, runId, "workflow_retry");
      const currentRows = await db.select({
        stepRunId: workflowStepRuns.id,
        workflowRunId: workflowStepRuns.workflowRunId,
        status: workflowStepRuns.status,
        retryCount: workflowStepRuns.retryCount,
        metadata: workflowStepRuns.metadata,
        lastDispatchRequestId: workflowStepRuns.lastDispatchRequestId,
        lastDispatchAcceptedAt: workflowStepRuns.lastDispatchAcceptedAt,
        startedAt: workflowStepRuns.startedAt,
        completedAt: workflowStepRuns.completedAt,
      })
        .from(workflowStepRuns)
        .where(inArray(workflowStepRuns.id, dueCandidates.map((candidate) => candidate.stepRunId)));
      const currentById = new Map(currentRows.map((row) => [row.stepRunId, row]));
      const outcomes = dueCandidates.map((candidate) =>
        classifyDueWorkflowRetryRelease(candidate, currentById.get(candidate.stepRunId)));
      const action = outcomes.includes("recovered")
        ? "recovered"
        : outcomes.includes("failed")
          ? "failed"
          : "skipped";
      results.push(action === "recovered"
        ? { runId, action, reason: "due workflow retry released" }
        : action === "failed"
          ? { runId, action, reason: "due workflow retry did not gain authoritative execution evidence" }
          : { runId, action, reason: "due workflow retry remains waiting" });
    } catch (err) {
      results.push({ runId, action: "failed", reason: `retry release error: ${sanitizeErrorSummary(String(err)) ?? "error"}` });
    }
  }
  return results;
}

// Pure liveness check shared with the stuck-run reconciler and the terminal
// Human Operator classifier. Lives in retry-policy.js (DB-free) to avoid
// circular imports; re-exported here for existing callers.
export { isStepRunAwaitingRetry } from "./retry-policy.js";

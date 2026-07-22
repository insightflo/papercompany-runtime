import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowStepRuns } from "@paperclipai/db";
import { readWorkflowRetryMetadata } from "./retry-policy.js";

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * CAS-safe waiting -> dispatching transition. Caller proof must identify a
 * real accepted dispatch; concurrency-blocked/cache-completed rows never win.
 */
export async function markRetryDispatching(
  db: Db,
  input: {
    stepRunId: string;
    workflowRunId: string;
    expectedRetryNumber: number;
    observedRetryCount: number;
    requiredStatus: "pending" | "running";
    requiredLastDispatchRequestId?: string | null;
  },
): Promise<boolean> {
  const [current] = await db.select({
    metadata: workflowStepRuns.metadata,
    status: workflowStepRuns.status,
    retryCount: workflowStepRuns.retryCount,
    lastDispatchRequestId: workflowStepRuns.lastDispatchRequestId,
  })
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.id, input.stepRunId))
    .limit(1);
  if (!current || current.status !== input.requiredStatus) return false;
  if (current.retryCount !== input.observedRetryCount) return false;
  if (
    input.requiredLastDispatchRequestId !== undefined
    && current.lastDispatchRequestId !== input.requiredLastDispatchRequestId
  ) return false;

  const metadata = normalizeRecord(current.metadata);
  const retry = readWorkflowRetryMetadata(metadata.workflowRetry);
  if (!retry || retry.state !== "waiting") return false;
  if (retry.retryNumber !== input.expectedRetryNumber) return false;

  const whereConditions = [
    eq(workflowStepRuns.id, input.stepRunId),
    eq(workflowStepRuns.workflowRunId, input.workflowRunId),
    eq(workflowStepRuns.status, input.requiredStatus),
    eq(workflowStepRuns.retryCount, input.observedRetryCount),
    eq(workflowStepRuns.metadata, current.metadata),
  ];
  if (input.requiredLastDispatchRequestId === null) {
    whereConditions.push(isNull(workflowStepRuns.lastDispatchRequestId));
  } else if (input.requiredLastDispatchRequestId !== undefined) {
    whereConditions.push(eq(
      workflowStepRuns.lastDispatchRequestId,
      input.requiredLastDispatchRequestId,
    ));
  }

  const updated = await db.update(workflowStepRuns)
    .set({
      metadata: {
        ...metadata,
        workflowRetry: { ...retry, state: "dispatching" as const },
      },
    })
    .where(and(...whereConditions))
    .returning({ id: workflowStepRuns.id });
  return updated.length > 0;
}

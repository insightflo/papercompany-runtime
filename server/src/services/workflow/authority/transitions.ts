import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  workflowDelegations,
  workflowTransitionEvents,
} from "@paperclipai/db";

type AuthorityWriter = Pick<Db, "insert" | "update">;

export interface WorkflowAuthorityTransitionInput {
  companyId: string;
  workflowRunId?: string | null;
  workflowStepRunId?: string | null;
  issueId?: string | null;
  wakeupRequestId?: string | null;
  heartbeatRunId?: string | null;
  executionGeneration?: number | null;
  executorOwnerId?: string | null;
  reason: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/** Appends an idempotent authority history row. Other constraint failures abort the caller transaction. */
export async function appendWorkflowAuthorityTransition(
  db: AuthorityWriter,
  input: WorkflowAuthorityTransitionInput,
): Promise<void> {
  await db
    .insert(workflowTransitionEvents)
    .values({
      companyId: input.companyId,
      workflowRunId: input.workflowRunId ?? null,
      workflowStepRunId: input.workflowStepRunId ?? null,
      issueId: input.issueId ?? null,
      wakeupRequestId: input.wakeupRequestId ?? null,
      heartbeatRunId: input.heartbeatRunId ?? null,
      executionGeneration: input.executionGeneration ?? null,
      executorOwnerId: input.executorOwnerId ?? null,
      eventType: "workflow_authority_transition",
      layer: "workflow_authority",
      decision: "shadow_write",
      reason: input.reason,
      reasonCode: input.reason,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
    })
    .onConflictDoNothing();
}

/** Preserves old delegation rows while fencing their generation from new work. */
export async function supersedeWorkflowDelegationsForGeneration(
  db: AuthorityWriter,
  input: {
    workflowRunId: string;
    workflowStepRunId: string;
    executionGeneration: number;
    now: Date;
  },
): Promise<void> {
  await db
    .update(workflowDelegations)
    .set({
      status: "superseded",
      completedAt: input.now,
      updatedAt: input.now,
      metadata: sql<Record<string, unknown>>`coalesce(${workflowDelegations.metadata}, '{}'::jsonb) || jsonb_build_object(
        'supersededAt', ${input.now.toISOString()}::text,
        'supersededGeneration', ${input.executionGeneration}::integer
      )`,
    })
    .where(and(
      eq(workflowDelegations.sourceWorkflowRunId, input.workflowRunId),
      eq(workflowDelegations.sourceWorkflowStepRunId, input.workflowStepRunId),
      eq(workflowDelegations.sourceExecutionGeneration, input.executionGeneration),
      eq(workflowDelegations.status, "active"),
    ));
}

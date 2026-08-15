import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, heartbeatRuns, workflowStepRuns } from "@paperclipai/db";
import { appendWorkflowAuthorityTransition } from "../workflow/authority/transitions.js";
import type { HeartbeatRun } from "./owner-capability.js";
import { isHeartbeatFinalizationV1Enabled } from "./flag.js";

type AuthorityDb = Pick<Db, "select" | "update" | "insert">;

/**
 * The proof hook deliberately sits before this mutation. Phase 1 records the
 * transfer only; a later phase will require the exact Class-Q proof here.
 */
export async function transferHeartbeatAuthorityToChild(
  db: AuthorityDb,
  input: {
    parent: HeartbeatRun;
    childRunId: string;
    childWakeupRequestId: string;
    now: Date;
    reason: "adapter_fallback" | "process_lost_retry" | "adapter_failed_retry";
  },
): Promise<boolean> {
  const parent = input.parent;
  if (
    parent.finalizationVersion !== 1 || parent.executionEpoch === null || !parent.executionToken ||
    !parent.executorOwnerId || parent.executorOwnerLeaseEpoch === null || !parent.executorOwnerLeaseToken
  ) return false;
  const nextExecutionEpoch = parent.executionEpoch + 1;
  const nextLeaseEpoch = parent.executorOwnerLeaseEpoch + 1;
  const nextExecutionToken = randomUUID();
  const nextLeaseToken = randomUUID();
  const childExecutionToken = randomUUID();
  const transferred = await db
    .update(heartbeatRuns)
    .set({
      executionEpoch: nextExecutionEpoch,
      executionToken: nextExecutionToken,
      executorOwnerLeaseEpoch: nextLeaseEpoch,
      executorOwnerLeaseToken: nextLeaseToken,
      executorOwnerReleasedAt: input.now,
      updatedAt: input.now,
    })
    .where(and(
      eq(heartbeatRuns.id, parent.id),
      eq(heartbeatRuns.executionEpoch, parent.executionEpoch),
      eq(heartbeatRuns.executionToken, parent.executionToken),
      eq(heartbeatRuns.executorOwnerId, parent.executorOwnerId),
      eq(heartbeatRuns.executorOwnerLeaseEpoch, parent.executorOwnerLeaseEpoch),
      eq(heartbeatRuns.executorOwnerLeaseToken, parent.executorOwnerLeaseToken),
      isNull(heartbeatRuns.executorOwnerReleasedAt),
    ))
    .returning({ id: heartbeatRuns.id });
  if (transferred.length === 0) return false;

  await db.update(agentWakeupRequests).set({
    workflowStepRunId: parent.workflowStepRunId,
    workflowExecutionGeneration: parent.workflowExecutionGeneration,
    updatedAt: input.now,
  }).where(eq(agentWakeupRequests.id, input.childWakeupRequestId));
  await db.update(heartbeatRuns).set({
    finalizationVersion: 1,
    executionScopeKind: parent.executionScopeKind,
    executionEpoch: 0,
    executionToken: childExecutionToken,
    workflowStepRunId: parent.workflowStepRunId,
    workflowExecutionGeneration: parent.workflowExecutionGeneration,
    updatedAt: input.now,
  }).where(eq(heartbeatRuns.id, input.childRunId));

  if (parent.workflowStepRunId && parent.workflowExecutionGeneration !== null) {
    const ownerTransferred = await db.update(workflowStepRuns).set({
      dispatchOwnerWakeupRequestId: input.childWakeupRequestId,
      dispatchOwnerHeartbeatRunId: input.childRunId,
    }).where(and(
      eq(workflowStepRuns.id, parent.workflowStepRunId),
      eq(workflowStepRuns.executionGeneration, parent.workflowExecutionGeneration),
    )).returning({ id: workflowStepRuns.id });
    if (ownerTransferred.length === 0) throw new Error("workflow authority transfer CAS lost");
  }

  await appendWorkflowAuthorityTransition(db, {
    companyId: parent.companyId,
    workflowStepRunId: parent.workflowStepRunId,
    issueId: parent.issueId,
    wakeupRequestId: input.childWakeupRequestId,
    heartbeatRunId: input.childRunId,
    executionGeneration: parent.workflowExecutionGeneration,
    executorOwnerId: parent.executorOwnerId,
    reason: input.reason,
    idempotencyKey: `authority-transfer:${parent.id}:${parent.executionEpoch}:${parent.executionToken}:${input.childRunId}`,
    payload: {
      version: 1,
      transition: "child_transfer",
      oldGeneration: parent.workflowExecutionGeneration,
      newGeneration: parent.workflowExecutionGeneration,
      oldWakeupRequestId: parent.wakeupRequestId,
      newWakeupRequestId: input.childWakeupRequestId,
      oldHeartbeatRunId: parent.id,
      newHeartbeatRunId: input.childRunId,
      oldExecutionEpoch: parent.executionEpoch,
      oldExecutionToken: parent.executionToken,
      oldOwnerLeaseEpoch: parent.executorOwnerLeaseEpoch,
      oldOwnerLeaseToken: parent.executorOwnerLeaseToken,
      parentExecutionEpoch: nextExecutionEpoch,
      parentExecutionToken: nextExecutionToken,
      parentOwnerLeaseEpoch: nextLeaseEpoch,
      parentOwnerLeaseToken: nextLeaseToken,
      childExecutionEpoch: 0,
      childExecutionToken,
      quiescenceProofRequired: true,
      quiescenceProofId: null,
    },
  });
  return true;
}
export async function maybeTransferHeartbeatAuthorityToChild(
  db: AuthorityDb,
  input: Parameters<typeof transferHeartbeatAuthorityToChild>[1],
): Promise<boolean> {
  if (!(await isHeartbeatFinalizationV1Enabled(db))) return false;
  return transferHeartbeatAuthorityToChild(db, input);
}

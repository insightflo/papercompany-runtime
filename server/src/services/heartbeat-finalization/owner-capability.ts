import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  heartbeatRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { appendWorkflowAuthorityTransition } from "../workflow/authority/transitions.js";

const OWNER_LEASE_MS = 5 * 60 * 1000;
type AuthorityDb = Pick<Db, "select" | "update" | "insert">;
export type HeartbeatRun = typeof heartbeatRuns.$inferSelect;

function executorOwnerId(): string {
  return process.env.PAPERCLIP_INSTANCE_ID?.trim() || "default";
}

function executionScopeKind(
  run: HeartbeatRun,
  wake: Pick<typeof agentWakeupRequests.$inferSelect, "workflowStepRunId" | "workflowExecutionGeneration" | "missionId"> | null,
): string {
  if (wake?.workflowStepRunId && wake.workflowExecutionGeneration !== null) return "workflow_step";
  if (run.issueId) return "issue_nonworkflow";
  if (wake?.missionId) return "mission_nonworkflow";
  if (run.invocationSource === "timer") return "timer";
  if (run.invocationSource === "on_demand") return "manual_on_demand";
  return "automation_nonworkflow";
}

async function readWorkflowWake(
  db: AuthorityDb,
  wakeupRequestId: string | null,
) {
  if (!wakeupRequestId) return null;
  return db
    .select({
      workflowRunId: agentWakeupRequests.workflowRunId,
      workflowStepRunId: agentWakeupRequests.workflowStepRunId,
      workflowExecutionGeneration: agentWakeupRequests.workflowExecutionGeneration,
      missionId: agentWakeupRequests.missionId,
    })
    .from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.id, wakeupRequestId))
    .then((rows) => rows[0] ?? null);
}

export async function claimHeartbeatRunWithOwnerCapability(
  db: Db,
  run: HeartbeatRun,
  claimedAt: Date,
): Promise<HeartbeatRun | null> {
  return db.transaction(async (tx) => {
    const wake = await readWorkflowWake(tx, run.wakeupRequestId);
    const ownerId = executorOwnerId();
    const leaseToken = randomUUID();
    const executionToken = run.executionToken ?? randomUUID();
    const executionEpoch = run.executionEpoch ?? 0;
    const leaseEpoch = (run.executorOwnerLeaseEpoch ?? 0) + 1;
    const workflowLinked = Boolean(
      wake?.workflowStepRunId && wake.workflowExecutionGeneration !== null,
    );
    const claimed = await tx
      .update(heartbeatRuns)
      .set({
        status: "running",
        startedAt: run.startedAt ?? claimedAt,
        updatedAt: claimedAt,
        finalizationVersion: 1,
        executionScopeKind: executionScopeKind(run, wake),
        executionEpoch,
        executionToken,
        executorOwnerId: ownerId,
        executorOwnerLeaseEpoch: leaseEpoch,
        executorOwnerLeaseToken: leaseToken,
        executorOwnerLeaseExpiresAt: new Date(claimedAt.getTime() + OWNER_LEASE_MS),
        executorOwnerAcknowledgedAt: null,
        executorOwnerReleasedAt: null,
        workflowStepRunId: workflowLinked ? wake!.workflowStepRunId : null,
        workflowExecutionGeneration: workflowLinked ? wake!.workflowExecutionGeneration : null,
      })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "queued")))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!claimed) return null;

    if (workflowLinked) {
      const ownerBound = await tx
        .update(workflowStepRuns)
        .set({
          dispatchOwnerWakeupRequestId: claimed.wakeupRequestId,
          dispatchOwnerHeartbeatRunId: claimed.id,
        })
        .where(and(
          eq(workflowStepRuns.id, wake!.workflowStepRunId!),
          eq(workflowStepRuns.executionGeneration, wake!.workflowExecutionGeneration!),
        ))
        .returning({ id: workflowStepRuns.id });
      if (ownerBound.length === 0) {
        throw new Error("workflow authority owner bind CAS lost");
      }
    }

    await appendWorkflowAuthorityTransition(tx, {
      companyId: claimed.companyId,
      workflowRunId: wake?.workflowRunId ?? null,
      workflowStepRunId: claimed.workflowStepRunId,
      issueId: claimed.issueId,
      wakeupRequestId: claimed.wakeupRequestId,
      heartbeatRunId: claimed.id,
      executionGeneration: claimed.workflowExecutionGeneration,
      executorOwnerId: ownerId,
      reason: "executor_owner_lease_claimed",
      idempotencyKey: `authority-claim:${claimed.id}:${executionEpoch}:${leaseEpoch}:${leaseToken}`,
      payload: {
        version: 1,
        transition: "owner_lease_claimed",
        oldGeneration: null,
        newGeneration: claimed.workflowExecutionGeneration,
        oldWakeupRequestId: null,
        newWakeupRequestId: claimed.wakeupRequestId,
        oldHeartbeatRunId: null,
        newHeartbeatRunId: claimed.id,
        executionEpoch,
        executionToken,
        ownerLeaseEpoch: leaseEpoch,
        ownerLeaseToken: leaseToken,
      },
    });
    return claimed;
  });
}

export async function acknowledgeHeartbeatOwnerCapability(
  db: Db,
  run: HeartbeatRun,
  now: Date,
): Promise<HeartbeatRun | null> {
  if (
    run.executionEpoch === null || !run.executionToken || !run.executorOwnerId ||
    run.executorOwnerLeaseEpoch === null || !run.executorOwnerLeaseToken
  ) return null;
  const executionEpoch = run.executionEpoch;
  const executionToken = run.executionToken;
  const ownerId = run.executorOwnerId;
  const leaseEpoch = run.executorOwnerLeaseEpoch;
  const leaseToken = run.executorOwnerLeaseToken;
  return db.transaction(async (tx) => {
    const acknowledged = await tx
      .update(heartbeatRuns)
      .set({ executorOwnerAcknowledgedAt: now, updatedAt: now })
      .where(and(
        eq(heartbeatRuns.id, run.id),
        eq(heartbeatRuns.status, "running"),
        eq(heartbeatRuns.executionEpoch, executionEpoch),
        eq(heartbeatRuns.executionToken, executionToken),
        eq(heartbeatRuns.executorOwnerId, ownerId),
        eq(heartbeatRuns.executorOwnerLeaseEpoch, leaseEpoch),
        eq(heartbeatRuns.executorOwnerLeaseToken, leaseToken),
        isNull(heartbeatRuns.executorOwnerAcknowledgedAt),
        isNull(heartbeatRuns.executorOwnerReleasedAt),
        gt(heartbeatRuns.executorOwnerLeaseExpiresAt, now),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!acknowledged) return null;
    await appendWorkflowAuthorityTransition(tx, {
      companyId: acknowledged.companyId,
      workflowStepRunId: acknowledged.workflowStepRunId,
      issueId: acknowledged.issueId,
      wakeupRequestId: acknowledged.wakeupRequestId,
      heartbeatRunId: acknowledged.id,
      executionGeneration: acknowledged.workflowExecutionGeneration,
      executorOwnerId: acknowledged.executorOwnerId,
      reason: "executor_owner_lease_acknowledged",
      idempotencyKey: `authority-ack:${acknowledged.id}:${acknowledged.executionEpoch}:${acknowledged.executorOwnerLeaseEpoch}:${acknowledged.executorOwnerLeaseToken}`,
      payload: {
        version: 1,
        transition: "owner_lease_acknowledged",
        oldGeneration: acknowledged.workflowExecutionGeneration,
        newGeneration: acknowledged.workflowExecutionGeneration,
        heartbeatRunId: acknowledged.id,
        executionEpoch: acknowledged.executionEpoch,
        executionToken: acknowledged.executionToken,
        ownerLeaseEpoch: acknowledged.executorOwnerLeaseEpoch,
        ownerLeaseToken: acknowledged.executorOwnerLeaseToken,
      },
    });
    return acknowledged;
  });
}

export async function decideHeartbeatTerminalOutcomeFirstWins(
  db: Db,
  input: {
    run: HeartbeatRun;
    outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
    source: string;
    now: Date;
  },
): Promise<boolean> {
  const { run } = input;
  if (
    run.finalizationVersion !== 1 || run.executionEpoch === null || !run.executionToken ||
    !run.executorOwnerId || run.executorOwnerLeaseEpoch === null || !run.executorOwnerLeaseToken
  ) return false;
  const executionEpoch = run.executionEpoch;
  const executionToken = run.executionToken;
  const ownerId = run.executorOwnerId;
  const leaseEpoch = run.executorOwnerLeaseEpoch;
  const leaseToken = run.executorOwnerLeaseToken;
  return db.transaction(async (tx) => {
    const decided = await tx
      .update(heartbeatRuns)
      .set({
        terminalOutcome: input.outcome,
        terminalDecidedAt: input.now,
        terminalDecisionSource: input.source,
        updatedAt: input.now,
      })
      .where(and(
        eq(heartbeatRuns.id, run.id),
        eq(heartbeatRuns.finalizationVersion, 1),
        eq(heartbeatRuns.executionEpoch, executionEpoch),
        eq(heartbeatRuns.executionToken, executionToken),
        eq(heartbeatRuns.executorOwnerId, ownerId),
        eq(heartbeatRuns.executorOwnerLeaseEpoch, leaseEpoch),
        eq(heartbeatRuns.executorOwnerLeaseToken, leaseToken),
        isNull(heartbeatRuns.terminalOutcome),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!decided) return false;
    await appendWorkflowAuthorityTransition(tx, {
      companyId: decided.companyId,
      workflowStepRunId: decided.workflowStepRunId,
      issueId: decided.issueId,
      wakeupRequestId: decided.wakeupRequestId,
      heartbeatRunId: decided.id,
      executionGeneration: decided.workflowExecutionGeneration,
      executorOwnerId: decided.executorOwnerId,
      reason: "terminal_outcome_decided",
      idempotencyKey: `terminal-outcome:${decided.id}`,
      payload: {
        version: 1,
        transition: "terminal_outcome_decided",
        executionEpoch: decided.executionEpoch,
        executionToken: decided.executionToken,
        ownerLeaseEpoch: decided.executorOwnerLeaseEpoch,
        ownerLeaseToken: decided.executorOwnerLeaseToken,
        outcome: input.outcome,
        source: input.source,
      },
    });
    return true;
  });
}


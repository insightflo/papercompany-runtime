import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowRuns, workflowStepRuns } from "@paperclipai/db";
import {
  appendWorkflowAuthorityTransition,
  supersedeWorkflowDelegationsForGeneration,
} from "./authority/transitions.js";

type StepRun = typeof workflowStepRuns.$inferSelect;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type ConditionalStepObservation = Pick<
  StepRun,
  | "id"
  | "workflowRunId"
  | "stepId"
  | "status"
  | "issueId"
  | "startedAt"
  | "lastDispatchAttemptAt"
  | "dispatchReadyAt"
  | "executionGeneration"
  | "metadata"
>;

export type ConditionalRunObservation = Pick<
  typeof workflowRuns.$inferSelect,
  "id" | "companyId" | "missionId" | "status"
>;

type ConditionalSkipProofLoss = { kind: "no-op" } | { kind: "cancelled" };

export type ConditionalSkipSettlementResult = {
  kind: "settled";
  stepRunId: string;
  executionGeneration: number;
  statusTransitionVersion: number;
  completedAt: Date;
  dispatchReadyAt: Date;
} | ConditionalSkipProofLoss;

export type ConditionalSkipRevivalResult = {
  kind: "settled";
  stepRunId: string;
  executionGeneration: number;
  statusTransitionVersion: number;
} | ConditionalSkipProofLoss;

export interface SettleConditionalSkipInput {
  observedRun: ConditionalRunObservation;
  target: ConditionalStepObservation;
  nextMetadata: Record<string, unknown>;
  observedPredecessors: ConditionalStepObservation[];
}

export interface ReviveConditionalSkipInput {
  observedRun: ConditionalRunObservation;
  target: ConditionalStepObservation;
  nextMetadata: Record<string, unknown>;
  observedPredecessors: ConditionalStepObservation[];
  invalidateGeneration: boolean;
}

const PG_INT_MAX = 2_147_483_647;

export async function settleConditionalSkip(
  db: Db,
  input: SettleConditionalSkipInput,
): Promise<ConditionalSkipSettlementResult> {
  if (input.observedRun.status === "cancelled") return { kind: "cancelled" };
  return await withRunSerialization(db, input.observedRun, async (tx) => {
    if (!await runMatches(tx, input.observedRun)) return { kind: "cancelled" };
    const current = await currentStepRun(tx, input.target.id, input.observedRun.id);
    if (!current || !stepMatches(current, input.target)) return { kind: "no-op" };
    if (!await predecessorsMatch(tx, input.observedRun.id, input.observedPredecessors)) {
      return { kind: "no-op" };
    }

    const now = sql`clock_timestamp()`;
    const [updated] = await tx
      .update(workflowStepRuns)
      .set({
        status: "skipped",
        completedAt: now,
        dispatchReadyAt: now,
        metadata: input.nextMetadata,
      })
      .where(and(
        eq(workflowStepRuns.id, current.id),
        eq(workflowStepRuns.workflowRunId, input.observedRun.id),
        eq(workflowStepRuns.status, "pending"),
        isNullValue(workflowStepRuns.issueId),
        isNullValue(workflowStepRuns.startedAt),
        isNullValue(workflowStepRuns.lastDispatchAttemptAt),
        eq(workflowStepRuns.executionGeneration, input.target.executionGeneration),
      ))
      .returning({
        stepRunId: workflowStepRuns.id,
        executionGeneration: workflowStepRuns.executionGeneration,
        statusTransitionVersion: workflowStepRuns.statusTransitionVersion,
        completedAt: workflowStepRuns.completedAt,
        dispatchReadyAt: workflowStepRuns.dispatchReadyAt,
      });
    if (!updated) return { kind: "no-op" };
    if (updated.completedAt === null || updated.dispatchReadyAt === null) {
      throw new Error("Conditional skip settlement did not return committed timestamps");
    }
    return {
      kind: "settled",
      stepRunId: updated.stepRunId,
      executionGeneration: updated.executionGeneration,
      statusTransitionVersion: updated.statusTransitionVersion,
      completedAt: updated.completedAt,
      dispatchReadyAt: updated.dispatchReadyAt,
    };
  });
}

export async function reviveConditionalSkip(
  db: Db,
  input: ReviveConditionalSkipInput,
): Promise<ConditionalSkipRevivalResult> {
  if (input.observedRun.status === "cancelled") return { kind: "cancelled" };
  if (!isSafeGeneration(input.target.executionGeneration)) return { kind: "no-op" };
  return await withRunSerialization(db, input.observedRun, async (tx) => {
    if (!await runMatches(tx, input.observedRun)) return { kind: "cancelled" };
    const current = await currentStepRun(tx, input.target.id, input.observedRun.id);
    if (!current || !stepMatches(current, input.target)) return { kind: "no-op" };
    if (!await predecessorsMatch(tx, input.observedRun.id, input.observedPredecessors)) {
      return { kind: "no-op" };
    }
    const now = new Date();
    const [updated] = await tx
      .update(workflowStepRuns)
      .set({
        status: "pending",
        startedAt: null,
        completedAt: null,
        dispatchReadyAt: null,
        evidenceReadyAt: null,
        dispatchOwnerWakeupRequestId: null,
        dispatchOwnerHeartbeatRunId: null,
        ...(input.invalidateGeneration
          ? { executionGeneration: input.target.executionGeneration + 1 }
          : {}),
        metadata: input.nextMetadata,
      })
      .where(and(
        eq(workflowStepRuns.id, current.id),
        eq(workflowStepRuns.workflowRunId, input.observedRun.id),
        eq(workflowStepRuns.status, "skipped"),
        eq(workflowStepRuns.executionGeneration, input.target.executionGeneration),
      ))
      .returning({
        stepRunId: workflowStepRuns.id,
        executionGeneration: workflowStepRuns.executionGeneration,
        statusTransitionVersion: workflowStepRuns.statusTransitionVersion,
      });
    if (!updated) return { kind: "no-op" };

    if (input.invalidateGeneration) {
      await supersedeWorkflowDelegationsForGeneration(tx, {
        workflowRunId: input.observedRun.id,
        workflowStepRunId: current.id,
        executionGeneration: input.target.executionGeneration,
        now,
      });
      await appendWorkflowAuthorityTransition(tx, {
        companyId: input.observedRun.companyId,
        workflowRunId: input.observedRun.id,
        workflowStepRunId: current.id,
        issueId: current.issueId,
        executionGeneration: updated.executionGeneration,
        reason: "conditional_skip_revival",
        idempotencyKey: `conditional-skip-revival:${current.id}:${input.target.executionGeneration}:${updated.executionGeneration}`,
        payload: {
          version: 1,
          transition: "generation_advanced",
          oldGeneration: input.target.executionGeneration,
          newGeneration: updated.executionGeneration,
        },
      });
    }
    return {
      kind: "settled",
      stepRunId: updated.stepRunId,
      executionGeneration: updated.executionGeneration,
      statusTransitionVersion: updated.statusTransitionVersion,
    };
  });
}

async function withRunSerialization<T>(
  db: Db,
  run: ConditionalRunObservation,
  callback: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return await db.transaction(async (tx) => {
    await tx
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.id, run.id), eq(workflowRuns.companyId, run.companyId)))
      .for("update");
    await lockRunSteps(tx, run.id);
    return await callback(tx);
  });
}

async function lockRunSteps(tx: Transaction, workflowRunId: string): Promise<void> {
  await tx
    .select({ id: workflowStepRuns.id })
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, workflowRunId))
    .orderBy(workflowStepRuns.stepId, workflowStepRuns.id)
    .for("update");
}

async function runMatches(tx: Transaction, observed: ConditionalRunObservation): Promise<boolean> {
  const [run] = await tx
    .select({
      id: workflowRuns.id,
      companyId: workflowRuns.companyId,
      missionId: workflowRuns.missionId,
      status: workflowRuns.status,
    })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.id, observed.id), eq(workflowRuns.companyId, observed.companyId)))
    .for("update")
    .limit(1);
  return run !== undefined
    && run.missionId === observed.missionId
    && run.status === observed.status;
}

async function currentStepRun(tx: Transaction, stepRunId: string, workflowRunId: string) {
  const [row] = await tx
    .select()
    .from(workflowStepRuns)
    .where(and(
      eq(workflowStepRuns.id, stepRunId),
      eq(workflowStepRuns.workflowRunId, workflowRunId),
    ))
    .for("update")
    .limit(1);
  return row ?? null;
}

async function predecessorsMatch(
  tx: Transaction,
  workflowRunId: string,
  observed: ConditionalStepObservation[],
): Promise<boolean> {
  if (observed.length === 0) return true;
  const rows = await tx
    .select()
    .from(workflowStepRuns)
    .where(and(
      eq(workflowStepRuns.workflowRunId, workflowRunId),
      inArray(workflowStepRuns.id, observed.map((row) => row.id)),
    ))
    .for("update");
  const currentById = new Map(rows.map((row) => [row.id, row]));
  return observed.every((row) => {
    const current = currentById.get(row.id);
    return current !== undefined && stepMatches(current, row);
  });
}

function stepMatches(current: StepRun, observed: ConditionalStepObservation): boolean {
  return current.workflowRunId === observed.workflowRunId
    && current.stepId === observed.stepId
    && current.status === observed.status
    && current.issueId === observed.issueId
    && sameTimestamp(current.startedAt, observed.startedAt)
    && sameTimestamp(current.lastDispatchAttemptAt, observed.lastDispatchAttemptAt)
    && sameTimestamp(current.dispatchReadyAt, observed.dispatchReadyAt)
    && current.executionGeneration === observed.executionGeneration
    && sameJson(current.metadata, observed.metadata);
}

function sameTimestamp(left: Date | null, right: Date | null): boolean {
  if (left === null || right === null) return left === right;
  return left.getTime() === right.getTime();
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isNullValue(column: unknown) {
  return sql`${column} is null`;
}

function isSafeGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value < PG_INT_MAX;
}

import { and, eq, isNull, or, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRunFinalizations, heartbeatRunFinalizationSteps } from "@paperclipai/db";
import type { HeartbeatRun } from "./owner-capability.js";
import type { FinalizationStageClass } from "./stage-classifier.js";

const FINALIZER_LEASE_MS = 60 * 1000;
type StateDb = Pick<Db, "select" | "update" | "insert">;

function finalizerOwner(): string {
  return process.env.PAPERCLIP_INSTANCE_ID?.trim() || "default";
}

export interface FinalizationStageRecord {
  id: string;
  stageClass: string;
  stageKind: string;
  state: string;
}

/**
 * Creates the immutable finalization parent for a run whose terminal outcome was
 * first-wins-decided. Idempotent: an existing parent for the run is returned as-is.
 */
export async function ensureFinalization(
  db: StateDb,
  run: HeartbeatRun,
  now: Date,
): Promise<typeof heartbeatRunFinalizations.$inferSelect> {
  // Blocker 3 fix: conflict-safe insert — the unique constraint on heartbeat_run_id
  // ensures only one parent per run even under concurrent terminal hooks.
  const [created] = await db
    .insert(heartbeatRunFinalizations)
    .values({
      companyId: run.companyId,
      heartbeatRunId: run.id,
      executionEpoch: run.executionEpoch ?? 0,
      executionToken: run.executionToken ?? sql`gen_random_uuid()`,
      terminalOutcome: run.terminalOutcome ?? "failed",
      terminalDecisionSource: run.terminalDecisionSource ?? "unknown",
      finalizationVersion: run.finalizationVersion ?? 1,
      state: "pending",
    })
    .onConflictDoNothing({ target: heartbeatRunFinalizations.heartbeatRunId })
    .returning();
  if (created) return created;
  // Conflict: a concurrent writer created the parent. Return the existing row.
  const existing = await db
    .select()
    .from(heartbeatRunFinalizations)
    .where(eq(heartbeatRunFinalizations.heartbeatRunId, run.id))
    .then((rows) => rows[0] ?? null);
  if (!existing) throw new Error("finalization parent not found after conflict-safe insert");
  return existing;
}

/**
 * Claims a pending/expired finalization for this worker via a lease CAS.
 * `FOR UPDATE SKIP LOCKED` semantics are approximated by an atomic UPDATE that
 * only matches a claimable row. A stale/expired lease can be reclaimed; an active
 * lease cannot be stolen.
 */
export async function claimFinalization(
  db: StateDb,
  finalizationId: string,
  now: Date,
): Promise<typeof heartbeatRunFinalizations.$inferSelect | null> {
  const owner = finalizerOwner();
  const token = cryptoRandom();
  const claimed = await db
    .update(heartbeatRunFinalizations)
    .set({
      state: "leased",
      finalizerLeaseEpoch: sql`${heartbeatRunFinalizations.finalizerLeaseEpoch} + 1`,
      finalizerLeaseToken: token,
      finalizerOwner: owner,
      finalizerLeaseExpiresAt: new Date(now.getTime() + FINALIZER_LEASE_MS),
      updatedAt: now,
    })
    .where(and(
      eq(heartbeatRunFinalizations.id, finalizationId),
      or(
        eq(heartbeatRunFinalizations.state, "pending"),
        and(
          eq(heartbeatRunFinalizations.state, "leased"),
          or(isNull(heartbeatRunFinalizations.finalizerLeaseExpiresAt), lt(heartbeatRunFinalizations.finalizerLeaseExpiresAt, now)),
        ),
      ),
    ))
    .returning()
    .then((rows) => rows[0] ?? null);
  return claimed;
}

/**
 * Idempotent stage record. The unique (company_id, heartbeat_run_id, stage_kind,
 * idempotency_key) index dedupes concurrent/duplicate writers. Returns the row
 * (existing or newly inserted).
 */
export async function recordStage(
  db: StateDb,
  input: {
    companyId: string;
    runId: string;
    finalizationId: string;
    stageClass: FinalizationStageClass;
    stageKind: string;
    idempotencyKey: string;
    state: string;
    payload?: Record<string, unknown>;
  },
): Promise<FinalizationStageRecord> {
  const inserted = await db
    .insert(heartbeatRunFinalizationSteps)
    .values({
      companyId: input.companyId,
      heartbeatRunId: input.runId,
      heartbeatRunFinalizationId: input.finalizationId,
      stageClass: input.stageClass,
      stageKind: input.stageKind,
      idempotencyKey: input.idempotencyKey,
      state: input.state,
      payload: input.payload ?? {},
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) {
    return { id: inserted[0].id, stageClass: inserted[0].stageClass, stageKind: inserted[0].stageKind, state: inserted[0].state };
  }
  const [existing] = await db
    .select({ id: heartbeatRunFinalizationSteps.id, stageClass: heartbeatRunFinalizationSteps.stageClass, stageKind: heartbeatRunFinalizationSteps.stageKind, state: heartbeatRunFinalizationSteps.state })
    .from(heartbeatRunFinalizationSteps)
    .where(and(
      eq(heartbeatRunFinalizationSteps.companyId, input.companyId),
      eq(heartbeatRunFinalizationSteps.heartbeatRunId, input.runId),
      eq(heartbeatRunFinalizationSteps.stageKind, input.stageKind),
      eq(heartbeatRunFinalizationSteps.idempotencyKey, input.idempotencyKey),
    ));
  if (!existing) throw new Error("stage record disappeared after conflict");
  return existing;
}

/** Transitions a stage's state (e.g. done / equivalent_failed / dead_letter). Idempotent. */
export async function setStageState(
  db: StateDb,
  stepId: string,
  state: string,
  now: Date,
): Promise<void> {
  await db
    .update(heartbeatRunFinalizationSteps)
    .set({ state, updatedAt: now })
    .where(eq(heartbeatRunFinalizationSteps.id, stepId));
}

export async function loadStages(db: StateDb, runId: string): Promise<FinalizationStageRecord[]> {
  const rows = await db
    .select({
      id: heartbeatRunFinalizationSteps.id,
      stageClass: heartbeatRunFinalizationSteps.stageClass,
      stageKind: heartbeatRunFinalizationSteps.stageKind,
      state: heartbeatRunFinalizationSteps.state,
    })
    .from(heartbeatRunFinalizationSteps)
    .where(eq(heartbeatRunFinalizationSteps.heartbeatRunId, runId));
  return rows as FinalizationStageRecord[];
}

function cryptoRandom(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomUUID } = require("node:crypto") as { randomUUID: () => string };
  return randomUUID();
}

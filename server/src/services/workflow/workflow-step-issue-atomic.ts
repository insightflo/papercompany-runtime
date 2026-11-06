import { and, eq, is, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { workflowStepRuns, type Db } from "@paperclipai/db";
import { HttpError } from "../../errors.js";
import type { createWorkflowStepIssue } from "./workflow-step-issue.js";
import type { WorkflowStep } from "./dag-engine.js";
import { bindWorkflowStepIssueRecord } from "./workflow-step-issue-records.js";
import { stepRunNeedsWorkflowResume } from "./dag-rework-observation.js";
import { readWorkflowRetryMetadata } from "./retry-policy.js";
import { wakeIssueBackedRetryAndMarkDispatching } from "./retry-launch-dispatch.js";

type Input = Parameters<typeof createWorkflowStepIssue>[0];

export function collectGateValidatedProducerStepIds(
  directDependencyStepIds: string[],
  workflowStepsById: Map<string, WorkflowStep>,
): Map<string, string[]> {
  const producerStepIdsByGateStepId = new Map<string, string[]>();

  const collectProducerSteps = (stepId: string, visited: Set<string>): string[] => {
    if (visited.has(stepId)) return [];
    const step = workflowStepsById.get(stepId);
    if (!step) return [];
    if (step.graphWorkProductRequired === true) return [stepId];
    const nextVisited = new Set(visited);
    nextVisited.add(stepId);
    return Array.from(new Set(step.dependencies.flatMap((dependencyStepId) => (
      collectProducerSteps(dependencyStepId, nextVisited)
    ))));
  };

  for (const dependencyStepId of directDependencyStepIds) {
    const dependencyStep = workflowStepsById.get(dependencyStepId);
    if (!dependencyStep || dependencyStep.graphWorkProductRequired === true || dependencyStep.dependencies.length === 0) {
      continue;
    }
    const producerStepIds = Array.from(new Set(dependencyStep.dependencies.flatMap((upstreamStepId) => (
      collectProducerSteps(upstreamStepId, new Set([dependencyStepId]))
    ))));
    if (producerStepIds.length > 0) {
      producerStepIdsByGateStepId.set(dependencyStepId, producerStepIds);
    }
  }

  return producerStepIdsByGateStepId;
}

type PoolSlots = { active: number; waiting: Array<() => void> };
const poolSlots = new WeakMap<object, PoolSlots>();
const dispatchTurns = new WeakMap<object, Map<string, Promise<void>>>();

// Same-process callers for one dispatch key wait for their turn here without
// holding a pool connection or a dispatch slot, so a busy dispatch cannot starve
// independent dispatches; the session lock below still guards cross-process entry.
async function takeDispatchTurn(db: Db, key: string): Promise<() => void> {
  const client = db.$client;
  let byKey = dispatchTurns.get(client);
  if (!byKey) { byKey = new Map(); dispatchTurns.set(client, byKey); }
  const predecessors = byKey.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const settle = predecessors.then(() => turn);
  byKey.set(key, settle);
  void settle.finally(() => { if (byKey.get(key) === settle) byKey.delete(key); });
  await predecessors;
  return release;
}

// A session lock needs one connection while the normal heartbeat uses the pool.
// Bound the number of held sessions so concurrent independent dispatches cannot
// exhaust the pool before their transactions and post-commit wakes can run.
async function takeDispatchSlot(db: Db): Promise<() => void> {
  const client = db.$client;
  const max = client.options.max;
  if (!Number.isInteger(max) || max < 2) throw new Error("workflow_dispatch_connection_pool_too_small");
  let slots = poolSlots.get(client);
  if (!slots) { slots = { active: 0, waiting: [] }; poolSlots.set(client, slots); }
  const current = slots;
  if (current.active >= Math.floor(max / 2)) {
    await new Promise<void>((resolve) => current.waiting.push(resolve));
  } else current.active++;
  return () => {
    const next = current.waiting.shift();
    if (next) next();
    else current.active--;
  };
}

/** Serialize root dispatches; nested owners must not wait while holding business locks. */
export async function withWorkflowDispatchGate<T>(
  db: Db, runId: string, stepId: string, work: () => Promise<T>,
): Promise<T> {
  const key = `workflow-step-dispatch:${runId}:${stepId}`;
  if (is(db, PgTransaction)) {
    const rows = await db.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as acquired`);
    if (!rows[0]?.acquired) throw new Error("workflow_step_dispatch_busy");
    return work();
  }
  const releaseTurn = await takeDispatchTurn(db, key);
  const releaseSlot = await takeDispatchSlot(db);
  let client: Awaited<ReturnType<Db["$client"]["reserve"]>>;
  try { client = await db.$client.reserve(); }
  catch (error) { releaseSlot(); releaseTurn(); throw error; }
  let acquired = false;
  let safeToRelease = false;
  try {
    await client`select pg_advisory_lock(hashtextextended(${key}, 0))`;
    acquired = true;
    return await work();
  } finally {
    // A lost acquisition or unlock reply can leave a lock on this session. Do not
    // return an uncertain session to the pool, but the dispatch slot and the turn
    // must never outlive the attempt itself.
    if (acquired) {
      try { await client`select pg_advisory_unlock(hashtextextended(${key}, 0))`; safeToRelease = true; }
      finally { if (safeToRelease) client.release(); }
    }
    releaseSlot();
    releaseTurn();
  }
}

/** Commit the issue and its step binding together before any external wake. */
export async function createBoundWorkflowStepIssue(input: Input, create: typeof createWorkflowStepIssue): Promise<null> {
  const existing = await withWorkflowDispatchGate(input.db, input.run.id, input.step.id, async () => {
    let afterCommit: (() => Promise<void>) | undefined;
    const result = await input.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      const [step] = await tx.select().from(workflowStepRuns).where(and(
        eq(workflowStepRuns.workflowRunId, input.run.id), eq(workflowStepRuns.stepId, input.step.id),
      )).for("update");
      if (!step || step.status !== "pending") return { kind: "noop" as const };
      if (step.issueId) return { kind: "existing" as const, step };
      const issueId = await create({
        ...input, db: tx, deferredSideEffectsDb: input.db,
        captureDeferredSideEffects: (apply) => { afterCommit = apply; },
      });
      if (!issueId) return { kind: "noop" as const };
      await tx.update(workflowStepRuns).set({ issueId }).where(eq(workflowStepRuns.id, step.id));
      return { kind: "created" as const };
    });
    if (result.kind === "created" && afterCommit) await afterCommit();
    return result.kind === "existing" ? result.step : null;
  });
  if (existing) await wakeBoundStep(input, existing);
  // The legacy caller must not perform its stale, unconditional binding after this transaction.
  return null;
}

async function wakeBoundStep(input: Pick<Input, "db" | "run" | "definition" | "step">,
  stepRun: typeof workflowStepRuns.$inferSelect): Promise<void> {
  if (!stepRun.issueId) return;
  const metadata = stepRun.metadata && typeof stepRun.metadata === "object" ? stepRun.metadata : {};
  const retry = readWorkflowRetryMetadata(metadata.workflowRetry);
  const { wakeExistingWorkflowStepIssue } = await import("./workflow-step-wake.js");
  await wakeIssueBackedRetryAndMarkDispatching({
    db: input.db, companyId: input.run.companyId, workflowRunId: input.run.id,
    definition: input.definition, run: input.run, step: input.step, stepRunId: stepRun.id,
    stepRunMetadata: stepRun.metadata, issueId: stepRun.issueId, observedRetryCount: stepRun.retryCount,
    resumeExistingIssue: stepRunNeedsWorkflowResume(stepRun) || retry !== null, wakeExistingWorkflowStepIssue,
  });
}

/** Quality's issue and binding remain one transaction; a savepoint is not a root commit. */
export async function syncQualityStepIssueCommitBeforeWake(
  db: Db,
  context: { run: Input["run"]; definition: Input["definition"]; step: WorkflowStep; stepRunId: string },
  createStepIssue: typeof createWorkflowStepIssue,
): Promise<void> {
  const existing = await withWorkflowDispatchGate(db, context.run.id, context.step.id, async () => {
    let deferredWake: (() => Promise<void>) | null = null;
    let boundIssueId: string | null = null;
    let existingStep: typeof workflowStepRuns.$inferSelect | null = null;
    try {
      boundIssueId = await db.transaction(async (tx) => {
        const [step] = await tx.select().from(workflowStepRuns)
          .where(eq(workflowStepRuns.id, context.stepRunId)).for("update");
        if (!step || step.status !== "pending") return null;
        if (step.issueId) { existingStep = step; return null; }
        const issueId = await createStepIssue({
          db: tx as unknown as Db, run: context.run, definition: context.definition, step: context.step,
          deferredSideEffectsDb: db, captureDeferredSideEffects: (apply) => { deferredWake = apply; },
        });
        if (!issueId) return null;
        await bindWorkflowStepIssueRecord(tx as unknown as Db, { companyId: context.run.companyId, stepRunId: context.stepRunId, issueId });
        return issueId;
      });
    } catch (error) {
      if (error instanceof HttpError && error.message === "quality_step_issue_binding_conflict") return null;
      throw error;
    }
    if (boundIssueId) await deferredWake!();
    return existingStep;
  });
  if (existing) await wakeBoundStep({ db, run: context.run, definition: context.definition, step: context.step }, existing);
}

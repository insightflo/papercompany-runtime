import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  instanceSettings, missions, workflowDefinitions, workflowRecoveryAuthorities,
  workflowRuns, workflowStepRuns, workflowTransitionEvents, type Db,
} from "@paperclipai/db";
import { seedBoundaryIntegrationRun } from "./helpers/run-terminal-boundary-integration-fixtures.js";
import { createCascadeHarness, snapshot, trigger } from "./helpers/failure-cascade-atomicity-fixture.js";
import { captureExecutionDefinition } from "../services/workflow/execution-definition.js";
import { loadWorkflowExecutionContext } from "../services/workflow/workflow-execution-context.js";
import { getWorkflowExecutionResultSnapshot } from "../services/workflow/dag-engine.js";
import { isIssueLessToolStep } from "../services/workflow/issue-less-tool-shape.js";
import { acceptSourceIssueRecovery } from "../services/workflow/source-issue-recovery-accept.js";
import { retryIssueLessToolWorkflowStepInternal } from "../services/workflow/retry-issue-less-manual.js";
import { deliverAcceptedToolRecovery } from "../services/workflow/tool-recovery-delivery.js";
import { finalizeRunTerminal } from "../services/workflow/run-terminal-boundary.js";
import { writeStuckCascade, writeDeadlockCascade } from "../services/workflow/failure-cascade-writes.js";
import { recordWorkflowStepStatusTransition, type WorkflowSyncSource } from "../services/workflow/workflow-sync-source.js";

type Kind = "source" | "tool";
const kinds: Kind[] = ["source", "tool"];
describe("C04 official recovery restores only the proven failure chain", () => {
  let owned: Awaited<ReturnType<typeof createCascadeHarness>>;
  beforeAll(async () => { owned = await createCascadeHarness(); }, 60000);
  afterAll(async () => { await owned?.close(); }, 60000);

  async function seed(kind: Kind, deadlock = false, historical = true, mixed = false) {
    const db = owned.db;
    await db.delete(instanceSettings);
    await db.insert(instanceSettings).values({ singletonKey: "default", general: {},
      experimental: { enableRunReopenGuardV1: true, enableRunRecoveryServiceV1: true } });
    const world = await seedBoundaryIntegrationRun(db, { steps: [
      { stepId: "upstream", status: "pending", ...(kind === "source" ? { issueStatus: "blocked", unblock: true } : {}) },
      { stepId: "after", status: "pending", dependencies: ["upstream"], metadata: { keep: "first" } },
      { stepId: "last", status: "pending", dependencies: ["after"], metadata: { keep: "second" } },
      { stepId: "excluded", status: "pending", dependencies: ["upstream"] },
      { stepId: "cancelled", status: "pending", issueStatus: "cancelled", dependencies: ["upstream"] },
      { stepId: "published", status: "pending", metadata: { publicationReceipt: { confirmed: true, key: "preserve-effect" } } },
      ...(mixed ? [
        { stepId: "other", status: "pending" },
        { stepId: "mixed", status: "pending", dependencies: ["upstream", "other"] },
        { stepId: "mixed-last", status: "pending", dependencies: ["mixed"] },
      ] : []),
    ] });
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, world.workflowId));
    const definitions = (definition!.stepsJson as Array<Record<string, unknown>>).map(step =>
      step.id === "excluded" ? { ...step, conditionalDependencies: [{ stepId: "published", when: "failure" }] }
        : kind === "tool" && step.id === "upstream"
          ? { ...step, type: "tool", agentId: "", toolNames: ["c04-no-execute"] } : step);
    await db.update(workflowDefinitions).set({ stepsJson: definitions }).where(eq(workflowDefinitions.id, world.workflowId));
    if (historical) await db.transaction(async tx => {
      await tx.update(workflowRuns).set({ status: "pending", startedAt: null, metadata: { executionDefinitionVersion: 1 } })
        .where(eq(workflowRuns.id, world.runId));
      await captureExecutionDefinition(tx, world.runId);
      await tx.update(workflowRuns).set({ status: "running", startedAt: new Date() }).where(eq(workflowRuns.id, world.runId));
    });
    async function mark(stepId: string, status: string, source: WorkflowSyncSource, metadata?: Record<string, unknown>) {
      const [row] = await db.update(workflowStepRuns).set({ status, completedAt: new Date(), ...(metadata ? { metadata } : {}) })
        .where(eq(workflowStepRuns.id, world.stepRunIdsByStep[stepId]!)).returning();
      await recordWorkflowStepStatusTransition(db, { companyId: world.companyId, missionId: world.missionId,
        workflowRunId: world.runId, workflowStepRunId: row!.id, issueId: row!.issueId,
        fromStatus: "pending", toStatus: status, transitionVersion: row!.statusTransitionVersion, source });
    }
    await mark("published", "completed", "workflow_tool_result");
    await mark("excluded", "skipped", "workflow_sync", { controlFlowSkipped: true });
    await mark("upstream", "failed", "workflow_tool_result");
    if (mixed) await mark("other", "failed", "workflow_tool_result");
    await db.transaction(async tx => {
      const [run] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, world.runId));
      const rows = await tx.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, world.runId));
      const pending = rows.filter(row => row.status === "pending");
      if (deadlock) await writeDeadlockCascade(tx, run!, pending, new Date());
      else await writeStuckCascade(tx, run!, pending, new Date());
      const result = await finalizeRunTerminal(tx, { runId: world.runId, companyId: world.companyId,
        expectedAuthorityVersion: run!.dispatchAuthorityVersion, decision: "failed",
        cause: { policy: "outcome_convergence", discovery: "engine_recompute", origin: "dag_engine" },
        gatePolicy: "immediate", now: new Date(), stepRuns: rows });
      expect(result.kind).toBe("finalized");
    });
    const before = await snapshot(owned.peer, world);
    return { ...world, run: before.run, failed: before.steps.find(row => row.stepId === "upstream")!, before };
  }
  type World = Awaited<ReturnType<typeof seed>>;
  // Observe durable reset through the existing delivery boundary without starting an adapter.
  async function sync(db: Db, runId: string) {
    const result = await getWorkflowExecutionResultSnapshot(db, runId);
    if (!result) throw Error("missing fixture");
    return result;
  }
  async function recover(db: Db, world: World) {
    if (world.failed.issueId) return acceptSourceIssueRecovery(db, {
      run: world.run, stepRunId: world.failed.id, issueId: world.failed.issueId,
    });
    return retryIssueLessToolWorkflowStepInternal({ db, companyId: world.companyId, runId: world.runId,
      stepId: "upstream", recoveryRequestReference: "c04-same-request",
      expectedFailure: { stepRunId: world.failed.id, authorityVersion: world.run.dispatchAuthorityVersion,
        executionGeneration: world.failed.executionGeneration, dispatchRequestId: world.failed.lastDispatchRequestId },
      loadWorkflowExecutionContext, isIssueLessToolStep,
      resetUnlaunchedTerminalStepRuns: async () => { throw Error("strict recovery must not invoke legacy reset"); },
      syncWorkflowRunState: sync });
  }
  async function state(db: Db, world: World) {
    return { ...await snapshot(db, world), authorities: await db.select().from(workflowRecoveryAuthorities)
      .where(eq(workflowRecoveryAuthorities.workflowRunId, world.runId)).orderBy(workflowRecoveryAuthorities.id) };
  }
  async function assertRecovered(world: World) {
    const current = await state(owned.peer, world);
    expect(current.run).toMatchObject({ status: "running", dispatchAuthorityVersion: world.run.dispatchAuthorityVersion + 1 });
    expect(current.authorities).toHaveLength(1);
    for (const prior of world.before.steps) {
      const row = current.steps.find(row => row.id === prior.id)!;
      expect(row.executionGeneration).toBe(prior.executionGeneration + 1); // Core's ONE increment, never two.
      if (["after", "last"].includes(prior.stepId)) {
        expect(row).toMatchObject({ status: "pending", startedAt: null, completedAt: null,
          dispatchReadyAt: null, dispatchOwnerWakeupRequestId: null, dispatchOwnerHeartbeatRunId: null });
        expect(row.metadata).toEqual({ ...prior.metadata,
          ...(prior.metadata.failureCascadeSkipped ? { failureCascadeSkipped: false } : { controlFlowSkipped: false }) });
      } else if (prior.id === world.failed.id) {
        expect(row.status).toBe(world.failed.issueId ? "running" : "pending");
      } else expect(row).toEqual({ ...prior, executionGeneration: prior.executionGeneration + 1 });
    }
    expect(current.effects).toEqual(world.before.effects);
    expect(current.issues).toEqual(world.before.issues);
    expect(current.heartbeats).toEqual(world.before.heartbeats);
    expect(current.wakes).toEqual(world.before.wakes);
    return current;
  }

  // Oracle: C04 + assessment:30-39. Run/target/two successors recover together;
  // conditional exclusion, explicit cancelled issue and confirmed publication stay unchanged.
  // Run the SAME cases against the baseline: its two successors remain skipped (distinguishing FAIL).
  it.each(kinds.flatMap(kind => [false, true].map(deadlock => ({ kind, deadlock }))))(
    "$kind restores two $deadlock cascade successors and preserves effects/cancellation", async ({ kind, deadlock }) => {
      const world = await seed(kind, deadlock);
      expect(await recover(owned.db, world)).not.toBeNull();
      const accepted = await assertRecovered(world);
      expect(await recover(owned.peer, world)).toBeNull();
      if (kind === "tool") expect(await deliverAcceptedToolRecovery(owned.peer, world.failed.id, sync)).not.toBeNull();
      expect(await state(owned.peer, world)).toEqual(accepted);
    });

  it.each(kinds)("%s preserves multi-cause skips while restoring the independent single-cause chain", async kind => {
    const world = await seed(kind, false, true, true);
    expect(await recover(owned.db, world)).not.toBeNull();
    await assertRecovered(world);
  });

  it.each(kinds.flatMap(kind => ["missing-history", "missing-snapshot", "stale-history"].map(gap => ({ kind, gap }))))(
    "$kind never infers a cause from a boolean: $gap", async ({ kind, gap }) => {
      const world = await seed(kind, false, gap !== "missing-snapshot");
      if (gap !== "missing-snapshot") await owned.db.delete(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.workflowStepRunId, world.stepRunIdsByStep.after!),
        eq(workflowTransitionEvents.eventType, "workflow_step_status_transition")));
      if (gap === "stale-history") await recordWorkflowStepStatusTransition(owned.db, {
        companyId: world.companyId, missionId: world.missionId, workflowRunId: world.runId,
        workflowStepRunId: world.stepRunIdsByStep.after!, fromStatus: "pending", toStatus: "skipped",
        transitionVersion: 99, source: "workflow_reconciler" });
      expect(await recover(owned.db, world)).not.toBeNull();
      const current = await state(owned.peer, world);
      for (const id of ["after", "last"]) expect(current.steps.find(row => row.stepId === id)?.status).toBe("skipped");
    });

  it.each(kinds)("%s accepts the same failed identity only once across independent DB connections", async kind => {
    const world = await seed(kind);
    const results = await Promise.all([recover(owned.db, world), recover(owned.peer, world)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await assertRecovered(world);
  });

  it.each(kinds.flatMap(kind => ["generation", "second-revival", "no-op", "target-reset", "target-no-op"].map(stage => ({ kind, stage }))))(
    "$kind rolls back authority/run/target/all successors at $stage", async ({ kind, stage }) => {
      const world = await seed(kind), before = await state(owned.peer, world);
      const predicate = stage === "generation" ? "NEW.step_id = 'after' AND NEW.execution_generation > OLD.execution_generation"
        : (stage === "target-reset" || stage === "target-no-op") ? "NEW.step_id = 'upstream' AND OLD.status = 'failed' AND NEW.status <> 'failed'"
          : "NEW.step_id = 'last' AND OLD.status = 'skipped' AND NEW.status = 'pending'";
      const remove = await trigger(owned.peer, "workflow_step_runs", "BEFORE UPDATE", predicate,
        (stage === "no-op" || stage === "target-no-op") ? "RETURN NULL;" : "RAISE EXCEPTION 'c04 injected failure';");
      try {
        await expect(recover(owned.db, world)).rejects.toThrow();
        expect(await state(owned.peer, world)).toEqual(before);
      } finally { await remove(); }
    });

  function barrier() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  }
  async function waitForBlocked(holder: number) {
    const deadline = Date.now() + 5000;
    for (;;) {
      const rows = await owned.observer.execute(sql`SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'
        AND ${holder} = ANY(pg_blocking_pids(pid))`);
      if (rows.length) return;
      if (Date.now() >= deadline) throw Error("Independent recovery/cancel lock race not observed");
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  it.each(kinds)("%s cannot revive after the independently locked cancellation wins", async kind => {
    const world = await seed(kind), ready = barrier(), release = barrier();
    let holder = 0;
    const cancelling = owned.peer.transaction(async tx => {
      const [session] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      holder = Number(session!.pid);
      await tx.select().from(missions).where(eq(missions.id, world.missionId)).for("update");
      await tx.update(missions).set({ status: "cancelled" }).where(eq(missions.id, world.missionId));
      await tx.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, world.runId));
      ready.resolve();
      await release.promise;
    });
    await ready.promise;
    const recovering = recover(owned.db, world);
    try { await waitForBlocked(holder); }
    finally { release.resolve(); await cancelling; await recovering; }
    expect(await recovering).toBeNull();
    const current = await state(owned.peer, world);
    expect(current.authorities).toHaveLength(0);
    expect(current.run.status).toBe("cancelled");
    expect(current.steps).toEqual(world.before.steps);
  });

  it.each(kinds)("%s stays cancelled when cancellation follows the committed recovery", async kind => {
    const world = await seed(kind), ready = barrier(), release = barrier();
    let holder = 0;
    const recovering = owned.db.transaction(async tx => {
      const [session] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      holder = Number(session!.pid);
      expect(await recover(tx as unknown as Db, world)).not.toBeNull();
      ready.resolve();
      await release.promise;
    });
    await Promise.race([ready.promise, recovering]);
    const cancelling = owned.peer.transaction(async tx => {
      await tx.select().from(missions).where(eq(missions.id, world.missionId)).for("update");
      await tx.update(missions).set({ status: "cancelled" }).where(eq(missions.id, world.missionId));
      await tx.update(workflowRuns).set({ status: "cancelled",
        dispatchAuthorityVersion: sql`${workflowRuns.dispatchAuthorityVersion} + 1` })
        .where(eq(workflowRuns.id, world.runId));
    });
    try { await waitForBlocked(holder); }
    finally { release.resolve(); await Promise.all([recovering, cancelling]); }
    const cancelled = await state(owned.peer, world);
    expect(cancelled.authorities).toHaveLength(1);
    expect(cancelled.run.status).toBe("cancelled");
    expect(await recover(owned.db, world)).toBeNull();
    expect(await state(owned.peer, world)).toEqual(cancelled);
  });

  it.each(kinds)("%s preserves the configured service-disabled path", async kind => {
    const world = await seed(kind);
    await owned.db.update(instanceSettings).set({ experimental: {
      enableRunReopenGuardV1: false, enableRunRecoveryServiceV1: false,
    } });
    expect(await recover(owned.db, world)).not.toBeNull();
    if (kind === "tool") await assertRecovered(world); // Strict explicit recovery already owns its official path.
    else {
      const current = await state(owned.peer, world);
      expect(current.authorities).toHaveLength(0);
      expect(current.steps.find(row => row.stepId === "after")).toEqual(world.before.steps.find(row => row.stepId === "after"));
      expect(current.steps.find(row => row.stepId === "last")).toEqual(world.before.steps.find(row => row.stepId === "last"));
    }
  });
});

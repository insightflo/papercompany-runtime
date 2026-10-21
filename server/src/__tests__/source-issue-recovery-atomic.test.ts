import path from "node:path";
import { eq, is, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, companies, costEvents, issues,
  workflowRecoveryAuthorities, workflowRuns, workflowStepRuns, type Db,
} from "@paperclipai/db";
import { createCommitSourceHarness } from "./qa-correction-commit-fixture.js";
import { seedBoundaryIntegrationRun } from "./helpers/run-terminal-boundary-integration-fixtures.js";
import { cascadeState, trigger } from "./helpers/failure-cascade-atomicity-fixture.js";
import { setRunRecoveryFlags } from "./helpers/run-reopen-guard-fixture.js";
import { testWake } from "./helpers/cap-override-fixtures.js";
import { captureExecutionDefinition } from "../services/workflow/execution-definition.js";
import { recordWorkflowStepStatusTransition } from "../services/workflow/workflow-sync-source.js";
import { writeStuckCascade } from "../services/workflow/failure-cascade-writes.js";
import { finalizeRunTerminal } from "../services/workflow/run-terminal-boundary.js";
import { dispatchSourceIssueNativeResume } from "../services/workflow/source-issue-native-resume.js";
import { wakeExistingWorkflowStepIssue } from "../services/workflow/dag-engine.js";
import { heartbeatService } from "../services/heartbeat.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import * as delivery from "../services/workflow/replacement-agent-delivery.js";

const sqlPid = sql`SELECT pg_backend_pid() AS pid`;
const adapter = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", async original => ({
  ...await original<typeof import("../adapters/index.js")>(),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: adapter }),
}));
// Only the external model is replaced; recovery, snapshot, native queue and claims use PostgreSQL.
describe("C02/C03 source recovery and native request atomicity", () => {
  let owned: Awaited<ReturnType<typeof createCommitSourceHarness>>;
  let peer: Db;
  const roots: Db[] = [];
  beforeAll(async () => {
    owned = await createCommitSourceHarness();
    peer = owned.connect();
    roots.push(owned.db, peer);
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(owned.root, "resume-storage"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "11".repeat(32));
  }, 60000);
  afterAll(async () => {
    try {
      for (const root of roots) await waitForHeartbeatExecutionsToDrain(root);
      await owned?.close();
    } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
  }, 60000);

  async function seed() {
    const db = owned.db;
    adapter.mockReset();
    await setRunRecoveryFlags(db, true, true);
    const world = await seedBoundaryIntegrationRun(db, { steps: [
      { stepId: "upstream", status: "pending", issueStatus: "blocked", unblock: true },
      { stepId: "after", status: "pending", dependencies: ["upstream"] },
      { stepId: "last", status: "pending", dependencies: ["after"] },
      { stepId: "excluded", status: "pending", dependencies: ["upstream"] },
      { stepId: "published", status: "pending", metadata: { publicationReceipt: { confirmed: true, key: "keep" } } },
    ] });
    await db.update(agents).set({ adapterConfig: { cwd: owned.root },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, world.agentId));
    await db.update(issues).set({ assigneeAgentId: world.agentId })
      .where(eq(issues.id, world.issueIdsByStep.upstream!));
    await db.transaction(async tx => {
      await tx.update(workflowRuns).set({ status: "pending", startedAt: null, metadata: { executionDefinitionVersion: 1 } })
        .where(eq(workflowRuns.id, world.runId));
      await captureExecutionDefinition(tx, world.runId);
      await tx.update(workflowRuns).set({ status: "running", startedAt: new Date() }).where(eq(workflowRuns.id, world.runId));
    });
    for (const [stepId, status, source] of [
      ["published", "completed", "workflow_tool_result"],
      ["excluded", "skipped", "workflow_sync"],
      ["upstream", "failed", "workflow_tool_result"],
    ] as const) {
      const [row] = await db.update(workflowStepRuns).set({ status, completedAt: new Date(),
        ...(stepId === "excluded" ? { metadata: { controlFlowSkipped: true } } : {}) })
        .where(eq(workflowStepRuns.id, world.stepRunIdsByStep[stepId]!)).returning();
      await recordWorkflowStepStatusTransition(db, { companyId: world.companyId, missionId: world.missionId,
        workflowRunId: world.runId, workflowStepRunId: row!.id, issueId: row!.issueId,
        fromStatus: "pending", toStatus: status, transitionVersion: row!.statusTransitionVersion, source });
    }
    await db.transaction(async tx => {
      const [run] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, world.runId));
      const rows = await tx.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, world.runId));
      await writeStuckCascade(tx, run!, rows.filter(row => row.status === "pending"), new Date());
      const result = await finalizeRunTerminal(tx, { runId: world.runId, companyId: world.companyId,
        expectedAuthorityVersion: run!.dispatchAuthorityVersion, decision: "failed",
        cause: { policy: "outcome_convergence", discovery: "engine_recompute", origin: "dag_engine" },
        gatePolicy: "immediate", now: new Date(), stepRuns: rows });
      expect(result.kind).toBe("finalized");
    });
    return world;
  }
  type World = Awaited<ReturnType<typeof seed>>;
  async function state(db: Db, world: World) {
    return { ...await cascadeState(db, world),
      authorities: await db.select().from(workflowRecoveryAuthorities)
        .where(eq(workflowRecoveryAuthorities.workflowRunId, world.runId)).orderBy(workflowRecoveryAuthorities.id),
      costs: await db.select().from(costEvents).where(eq(costEvents.companyId, world.companyId)).orderBy(costEvents.id),
    };
  }
  type State = Awaited<ReturnType<typeof state>>;
  const dispatch = (db: Db, world: World, wakeFn?: typeof wakeExistingWorkflowStepIssue) =>
    dispatchSourceIssueNativeResume(db, { companyId: world.companyId,
      issueId: world.issueIdsByStep.upstream!, allowBlockedIssue: true, wakeFn });
  function assertRecovery(before: State, after: State) {
    expect(after.run).toMatchObject({ status: "running", dispatchAuthorityVersion: before.run.dispatchAuthorityVersion + 1 });
    expect(after.authorities).toHaveLength(1);
    expect(after.authorities[0]).toMatchObject({ status: "consumed", recoveryKind: "source_issue_unblock" });
    for (const previous of before.steps) {
      const current = after.steps.find(row => row.id === previous.id)!;
      expect(current.executionGeneration).toBe(previous.executionGeneration + 1);
      if (["after", "last"].includes(previous.stepId)) {
        expect(current.status).toBe("pending");
        expect(current.metadata?.failureCascadeSkipped).toBe(false);
      } else if (previous.stepId === "upstream") expect(current.status).toBe("running");
      else expect(current).toEqual({ ...previous, executionGeneration: previous.executionGeneration + 1 });
    }
    expect(after.effects).toEqual(before.effects);
  }

  // Oracle: C02/C03 + assessment's complete-storage/delivery contract + addendum:4.
  // SAME failed target + two proven successors: baseline commits recovery alone; candidate restores ALL raw rows.
  it.each(["rejected", "missing", "wrong-kind", "store-error", "after-store"] as const)(
    "rolls back authority, generations, target, successors and request at %s", async fault => {
      const world = await seed(), before = await state(peer, world);
      let prefix: State | undefined, queued: State | undefined, outside: State | undefined;
      let transaction = false;
      let remove = async () => {};
      if (fault === "store-error") remove = await trigger(peer, "agent_wakeup_requests", "BEFORE INSERT",
        "NEW.workflow_run_id = '" + world.runId + "'::uuid", "RAISE EXCEPTION 'source recovery request store failed';");
      try {
        const result = await dispatch(owned.db, world, async input => {
          transaction = is(input.db, PgTransaction);
          prefix = await state(input.db, world);
          outside = await state(peer, world);
          if (fault === "rejected") return false;
          if (fault === "missing") return true;
          if (fault === "after-store") await wakeExistingWorkflowStepIssue(input);
          else await testWake(input.db)(input);
          if (fault === "wrong-kind") await input.db.update(agentWakeupRequests).set({ requestKind: "assignment" })
            .where(eq(agentWakeupRequests.workflowRunId, world.runId));
          queued = await state(input.db, world);
          if (fault === "after-store") throw Error("source recovery failed after storing request");
          return true;
        });
        expect(result).toMatchObject({ kind: "report_only", reason: "wake_rejected" });
        expect(transaction).toBe(true);
        expect(prefix).toBeDefined();
        assertRecovery(before, prefix!);
        expect(outside).toEqual(before);
        if (fault === "after-store") {
          expect(queued?.wakes).toHaveLength(1);
          expect(queued?.heartbeats).toHaveLength(1);
          expect(queued?.heartbeats[0]?.status).toBe("queued");
        }
        expect(adapter).not.toHaveBeenCalled();
        expect(await state(peer, world)).toEqual(before);
      } finally { await remove(); }
    });

  // Real wake in an uncommitted outer transaction cannot start an adapter; even its queued HB rolls back.
  it("never executes before the owning transaction commits", async () => {
    const world = await seed(), before = await state(peer, world);
    let pending: State | undefined, visible: State | undefined, calls = -1;
    await expect(owned.db.transaction(async tx => {
      expect((await dispatch(tx as unknown as Db, world)).kind).toBe("dispatched");
      pending = await state(tx as unknown as Db, world);
      visible = await state(peer, world);
      calls = adapter.mock.calls.length;
      throw Error("abort owning source recovery");
    })).rejects.toThrow("abort owning source recovery");
    assertRecovery(before, pending!);
    expect(pending?.wakes).toHaveLength(1);
    expect(pending?.heartbeats[0]?.status).toBe("queued");
    expect(visible).toEqual(before);
    expect(calls).toBe(0);
    expect(await state(peer, world)).toEqual(before);
  });

  it.each([false, true])("executes one committed request, including lost root delivery=%s", async lost => {
    const world = await seed(), before = await state(peer, world);
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const executions: Array<{ runId: string; wakeId: string; committed: State }> = [];
    adapter.mockImplementation(async (ctx: { runId: string }) => {
      const committed = await state(peer, world);
      const heartbeat = committed.heartbeats.find(row => row.id === ctx.runId)!;
      executions.push({ runId: ctx.runId, wakeId: heartbeat.wakeupRequestId!, committed });
      await held;
      return { exitCode: 0, signal: null, timedOut: false, provider: "test", model: "test",
        billingType: "api", costUsd: 0.01, usage: { inputTokens: 17, outputTokens: 5 }, resultJson: null, runtimeServices: [] };
    });
    const drain = lost ? vi.spyOn(delivery, "drainReplacementRootNotifications")
      .mockRejectedValueOnce(Error("committed source delivery lost")) : null;
    try {
      expect((await dispatch(owned.db, world)).kind).toBe("dispatched");
      const accepted = await state(peer, world);
      assertRecovery(before, accepted);
      expect(accepted.wakes).toHaveLength(1);
      expect(accepted.heartbeats).toHaveLength(1);
      const wake = accepted.wakes[0]!, heartbeat = accepted.heartbeats[0]!;
      expect(wake).toMatchObject({ requestKind: "workflow_resume", workflowRunId: world.runId,
        workflowStepRunId: world.stepRunIdsByStep.upstream, issueId: world.issueIdsByStep.upstream,
        workflowExecutionGeneration: before.steps.find(row => row.stepId === "upstream")!.executionGeneration + 1 });
      expect(heartbeat.wakeupRequestId).toBe(wake.id);
      if (lost) {
        expect(drain).toHaveBeenCalledTimes(1);
        expect(adapter).not.toHaveBeenCalled();
        expect(heartbeat.status).toBe("queued");
      }
      drain?.mockRestore();
      const restarted = owned.connect();
      roots.push(restarted);
      await owned.db.transaction(async first => {
        const [a] = await first.execute(sqlPid);
        await restarted.transaction(async second => {
          const [b] = await second.execute(sqlPid);
          expect(a!.pid).not.toBe(b!.pid);
        });
      });
      const service = heartbeatService(restarted);
      await service.resumeQueuedRuns(); // The scheduler's persisted queue re-read, with no old notifications.
      await vi.waitFor(() => expect(executions).toHaveLength(1), { timeout: 5000 });
      expect(executions[0]).toMatchObject({ runId: heartbeat.id, wakeId: wake.id });
      assertRecovery(before, executions[0]!.committed);
      const active = await state(peer, world);
      for (let delivery = 0; delivery < 2; delivery++) {
        expect((await dispatch(restarted, world)).kind).toBe("already_in_flight");
        await service.resumeQueuedRuns();
      }
      expect(await state(peer, world)).toEqual(active);
      expect(adapter).toHaveBeenCalledTimes(1);
      release();
      for (const root of roots) await waitForHeartbeatExecutionsToDrain(root);
      const settled = await state(peer, world);
      const usage = async () => ({
        agent: (await peer.select({ spent: agents.spentMonthlyCents }).from(agents).where(eq(agents.id, world.agentId)))[0],
        company: (await peer.select({ spent: companies.spentMonthlyCents }).from(companies).where(eq(companies.id, world.companyId)))[0],
      });
      const totals = await usage(), executionCount = adapter.mock.calls.length;
      // C02/C03 require one execution of this recovery request; successors may run after release.
      const targetWakes = settled.wakes.filter(row =>
        row.workflowStepRunId === world.stepRunIdsByStep.upstream || row.issueId === world.issueIdsByStep.upstream);
      expect(targetWakes).toHaveLength(1);
      expect(targetWakes[0]!.id).toBe(wake.id);
      const targetHeartbeats = settled.heartbeats.filter(row => row.wakeupRequestId === wake.id);
      expect(targetHeartbeats).toHaveLength(1);
      expect(targetHeartbeats[0]).toMatchObject({ id: heartbeat.id, wakeupRequestId: wake.id, status: "succeeded" });
      const targetCosts = settled.costs.filter(row => row.heartbeatRunId === heartbeat.id);
      expect(targetCosts).toHaveLength(1);
      expect(targetCosts[0]).toMatchObject({ costCents: 1, inputTokens: 17, outputTokens: 5 });
      await service.resumeQueuedRuns();
      await service.resumeQueuedRuns();
      for (const root of roots) await waitForHeartbeatExecutionsToDrain(root);
      expect(await state(peer, world)).toEqual(settled);
      expect(await usage()).toEqual(totals);
      expect(executions.filter(row => row.runId === heartbeat.id && row.wakeId === wake.id)).toHaveLength(1);
      expect(adapter).toHaveBeenCalledTimes(executionCount);
    } finally {
      release();
      drain?.mockRestore();
      for (const root of roots) await waitForHeartbeatExecutionsToDrain(root);
    }
  }, 120000);
});

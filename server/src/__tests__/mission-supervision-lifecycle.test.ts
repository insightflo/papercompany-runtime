import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { missionPlanArtifacts, missions, workflowRuns } from "@paperclipai/db";
import { missionService } from "../services/missions.js";
import { createMissionOwnerSupervisionMonitor } from "../services/mission-owner-supervision-monitor.js";
import { logger } from "../middleware/logger.js";
import * as authority from "../services/missions/terminal-cleanup-authority.js";
import { seedTerminalTransaction, startTerminalTransactionDatabase, terminalState } from "./helpers/mission-terminal-transaction.js";
import { addLegacyRun, seedSupervisionLifecycle } from "./helpers/mission-supervision-lifecycle.js";

// Breaks caught: lifecycle candidates dropped by aggregate/age gates; canonical policy bypass;
// oversight created before settlement; company/ID leakage; false-safe or stale-epoch writes.
// No lifecycle mocks: only optional external wakeup callbacks are suppressed by omission.
describe("existing supervision owns canonical mission lifecycle", () => {
  let testDb: Awaited<ReturnType<typeof startTerminalTransactionDatabase>>;
  beforeAll(async () => { testDb = await startTerminalTransactionDatabase(); }, 60_000);
  afterAll(async () => { await testDb?.cleanup(); });
  const service = () => missionService(testDb.db);
  const sweep = (companyId: string, applySafeActions = true, missionIds?: string[]) =>
    service().runActiveMissionOwnerSupervision({ companyId, missionIds, applySafeActions });

  it("monitor ignores repeated completed no-ops but reports a real terminal transition without silent IDs", async () => {
    const silent = await seedSupervisionLifecycle(testDb.db, "completed");
    const monitor = createMissionOwnerSupervisionMonitor(testDb.db, { runImmediately: false });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await monitor.run();
      await monitor.run();
      expect(warn).not.toHaveBeenCalled();
      const active = await seedSupervisionLifecycle(testDb.db);
      await monitor.run();
      expect((await active.stored()).status).toBe("completed");
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ missionIds: [active.missionId], findingsCount: 1 }),
        "Mission owner supervision monitor observed active mission issues");
      warn.mockClear();
      await monitor.run();
      expect(warn).not.toHaveBeenCalled();
      expect(await silent.work()).toEqual([]);
      expect(await active.work()).toEqual([]);
    } finally { warn.mockRestore(); }
  });

  it("repeated completed sweeps omit silent results while direct supervision suppresses ordinary work", async () => {
    const f = await seedSupervisionLifecycle(testDb.db, "completed");
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await sweep(f.companyId)).toMatchObject({ missionIds: [], missions: [] });
      const direct = await service().runMainExecutorSupervision({ missionId: f.missionId, applySafeActions: true });
      expect(direct).toMatchObject({ oversightIssueId: null, findings: [], appliedActions: [] });
      expect(await f.work()).toEqual([]);
    }
  });

  it.each([
    ["planning", "paused"], ["planning", "cancelled"], ["completed", "paused"], ["completed", "cancelled"],
  ])("sweep preserves %s -> %s while the preceding candidate is held", async (before, after) => {
    const a = await seedSupervisionLifecycle(testDb.db);
    const b = await seedSupervisionLifecycle(testDb.db, before, before === "planning" ? "running" : "completed");
    if (before === "completed") await b.addIssue("workflow_execution");
    await testDb.db.update(missions).set({ createdAt: new Date("2000-01-01") }).where(eq(missions.id, a.missionId));
    await testDb.db.update(missions).set({ createdAt: new Date("2001-01-01") }).where(eq(missions.id, b.missionId));
    let reached!: () => void, release!: () => void;
    const held = new Promise<void>(resolve => { reached = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const original = authority.captureMissionTerminalAuthority;
    const spy = vi.spyOn(authority, "captureMissionTerminalAuthority").mockImplementation(async (...args) => {
      const captured = await original(...args);
      if (args[2] === a.missionId) { reached(); await resume; }
      return captured;
    });
    const pending = service().runActiveMissionOwnerSupervision({ missionIds: [a.missionId, b.missionId], applySafeActions: true });
    try {
      await Promise.race([held, pending.then(() => { throw new Error("First candidate did not reach authority capture"); })]);
      await testDb.db.update(missions).set({ status: after }).where(eq(missions.id, b.missionId));
      const stored = await b.stored(), work = await b.work();
      release();
      const result = await pending;
      expect(await b.stored()).toEqual(stored);
      expect(await b.work()).toEqual(work);
      expect(await testDb.db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, b.missionId))).toEqual([]);
      expect(result.missionIds).not.toContain(b.missionId);
    } finally { release(); await pending; spy.mockRestore(); }
  });

  it.each(["completed", "cancelled"])("direct supervision settles %s before creating any oversight/plan and is idempotent", async (status) => {
    const f = await seedSupervisionLifecycle(testDb.db, "active", status);
    const first = await service().runMainExecutorSupervision({ missionId: f.missionId, applySafeActions: true });
    expect((await f.stored()).status).toBe(status);
    expect(await f.work()).toEqual([]);
    expect(first.oversightIssueId).toBeNull();
    expect(first.appliedActions).toEqual([{ type: "mission_settled_from_workflow_runs", missionId: f.missionId, resultStatus: status }]);
    const before = await f.stored();
    await testDb.db.$client.unsafe("truncate terminal_test_writes");
    await service().runMainExecutorSupervision({ missionId: f.missionId, applySafeActions: true });
    expect(await f.stored()).toEqual(before);
    expect(await f.work()).toEqual([]);
    expect(await testDb.db.$client.unsafe("select * from terminal_test_writes")).toEqual([]);
  });

  it("sweep selects all-cancelled native runs without any other supervision trigger", async () => {
    const f = await seedSupervisionLifecycle(testDb.db, "active", "cancelled");
    const result = await sweep(f.companyId);
    expect(result.missionIds).toContain(f.missionId);
    expect((await f.stored()).status).toBe("cancelled");
    expect(await f.work()).toEqual([]);
  });

  it("sweep reaches legacy-only no-work cancellation without promoting plugin completion authority", async () => {
    const f = await seedSupervisionLifecycle(testDb.db, "active", null);
    await addLegacyRun(testDb.db, f);
    expect((await sweep(f.companyId)).missionIds).toContain(f.missionId);
    expect((await f.stored()).status).toBe("cancelled");
    expect(await f.work()).toEqual([]);
  });

  it("legacy grace period and genuine open work still prevent automatic cancellation", async () => {
    for (const guard of ["grace", "open-work"]) {
      const f = await seedSupervisionLifecycle(testDb.db, "active", null);
      await addLegacyRun(testDb.db, f);
      if (guard === "grace") await testDb.db.update(missions).set({ startedAt: new Date() }).where(eq(missions.id, f.missionId));
      else await f.addIssue("workflow_execution");
      await sweep(f.companyId);
      expect((await f.stored()).status).toBe("active");
    }
  });

  it("completed mission without native runs reaches canonical oversight-only settlement", async () => {
    const f = await seedSupervisionLifecycle(testDb.db, "completed", null);
    const oversight = await f.addIssue("mission_main_executor_oversight");
    await sweep(f.companyId);
    expect((await f.stored()).status).toBe("completed");
    expect(await f.work()).toEqual([expect.objectContaining({ id: oversight.id, status: "done" })]);
  });

  it("sweep settles recent resolved unblock cards and oversight heartbeat leftovers atomically", async () => {
    const f = await seedTerminalTransaction(testDb.db, true, true);
    expect((await sweep(f.companyId)).missionIds).toContain(f.missionId);
    const state = await terminalState(testDb.db, f);
    expect(state.missions[0].status).toBe("completed");
    expect(state.issues.map(row => row.status)).toEqual(["done", "done", "done"]);
    expect(state.runs[0].status).toBe("cancelled");
    expect(state.issues.find(row => row.id === f.issueId)).toMatchObject({ checkoutRunId: null, executionRunId: null });
    expect(state.runtimes[0]).toMatchObject({ status: "stopped", queueDepth: 0 });
    await sweep(f.companyId);
    expect(await terminalState(testDb.db, f)).toEqual(state);
  });

  it("recent resolved unblock alone cannot delay selection until the stale cutoff", async () => {
    const f = await seedSupervisionLifecycle(testDb.db);
    const source = await f.addIssue("workflow_execution", "done");
    const unblock = await f.addIssue("mission_main_executor_unblock", "blocked", source.id);
    await sweep(f.companyId);
    expect((await f.stored()).status).toBe("completed");
    expect((await f.work()).find(row => row.id === unblock.id)?.status).toBe("done");
    expect((await f.work()).some(row => row.originKind === "mission_main_executor_oversight")).toBe(false);
  });

  it("latest completed native run wins over historical failed native and running plugin units", async () => {
    const f = await seedSupervisionLifecycle(testDb.db);
    await f.addRun("failed", new Date("2026-09-01T00:00:00.000Z"));
    await addLegacyRun(testDb.db, f, "running");
    await sweep(f.companyId);
    expect((await f.stored()).status).toBe("completed");
    expect(await f.work()).toEqual([]);
  });

  it("completed workflow missions with genuine open work retain canonical reopen behavior", async () => {
    const f = await seedSupervisionLifecycle(testDb.db, "completed");
    const work = await f.addIssue("workflow_execution");
    await sweep(f.companyId);
    expect(await f.stored()).toMatchObject({ status: "active", completedAt: null });
    expect((await f.work()).find(row => row.id === work.id)?.status).toBe("todo");
    expect((await f.work()).filter(row => row.originKind === "mission_main_executor_oversight")).toHaveLength(1);
  });

  it("completed non-workflow mission closes oversight but preserves the existing partial-cleanup limit", async () => {
    const f = await seedTerminalTransaction(testDb.db);
    await testDb.db.update(missions).set({ status: "completed", completedAt: f.completedAt }).where(eq(missions.id, f.missionId));
    await sweep(f.companyId);
    const state = await terminalState(testDb.db, f);
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]).toMatchObject({ status: "done", executionRunId: f.runId });
    expect(state.runs[0].status).toBe("running"); // Existing oversight-only UPDATE, not full cleanup.
    expect(state.runtimes[0].status).toBe("busy");
  });

  it("does not compensate for completed/equal-completedAt canonical short circuit or resurrect oversight", async () => {
    const f = await seedTerminalTransaction(testDb.db, true);
    await testDb.db.update(missions).set({ status: "completed", completedAt: f.completedAt }).where(eq(missions.id, f.missionId));
    const before = await terminalState(testDb.db, f);
    await sweep(f.companyId);
    await service().runMainExecutorSupervision({ missionId: f.missionId, applySafeActions: true });
    expect(await terminalState(testDb.db, f)).toEqual(before);
  });

  it("company and explicit mission filters exclude foreign and unrequested lifecycle writes", async () => {
    const f = await seedSupervisionLifecycle(testDb.db);
    const foreign = await seedSupervisionLifecycle(testDb.db);
    const [sibling] = await testDb.db.insert(missions).values({ companyId: f.companyId, ownerAgentId: f.agentId,
      title: "Unrequested", status: "active", startedAt: f.completedAt }).returning();
    await testDb.db.insert(workflowRuns).values({ companyId: f.companyId, missionId: sibling.id,
      workflowId: f.run!.workflowId, status: "completed", triggeredBy: "test", completedAt: f.completedAt });
    const foreignBefore = await foreign.stored();
    const result = await sweep(f.companyId, true, [f.missionId, foreign.missionId]);
    expect(result.missionIds).toEqual([f.missionId]);
    expect((await f.stored()).status).toBe("completed");
    expect(await foreign.stored()).toEqual(foreignBefore);
    expect((await testDb.db.select().from(missions).where(eq(missions.id, sibling.id)))[0]).toEqual(sibling);
  });

  it.each(["paused", "cancelled"])("sweep does not broaden ordinary supervision to %s missions", async (status) => {
    const f = await seedSupervisionLifecycle(testDb.db, status);
    const before = await f.stored();
    expect((await sweep(f.companyId)).missionIds).toEqual([]);
    expect(await f.stored()).toEqual(before);
    expect(await f.work()).toEqual([]);
  });

  it("safe=false keeps canonical reconciliation disabled while preserving ordinary supervision", async () => {
    const f = await seedSupervisionLifecycle(testDb.db);
    await service().runMainExecutorSupervision({ missionId: f.missionId, applySafeActions: false });
    expect((await f.stored()).status).toBe("active");
    expect((await f.work()).some(row => row.originKind === "mission_main_executor_oversight")).toBe(true);
    const legacy = await seedSupervisionLifecycle(testDb.db, "active", null);
    await addLegacyRun(testDb.db, legacy);
    await sweep(legacy.companyId, false);
    expect((await legacy.stored()).status).toBe("active");
    const completed = await seedSupervisionLifecycle(testDb.db, "completed");
    await completed.addIssue("workflow_execution");
    expect((await sweep(completed.companyId, false)).missionIds).toEqual([]);
    expect((await completed.stored()).status).toBe("completed");
  });

  it("canonical open-work and blocked-revision guards remain authoritative", async () => {
    for (const guard of ["open-work", "blocked-revision"]) {
      const f = await seedSupervisionLifecycle(testDb.db);
      if (guard === "open-work") await f.addIssue("workflow_execution");
      else await testDb.db.insert(missionPlanArtifacts).values({ companyId: f.companyId, missionId: f.missionId,
        ownerAgentId: f.agentId, missionGoal: "Blocked revision", status: "active", refs: { revisionBlockedUnits: [{ unitId: "blocked" }] } });
      await sweep(f.companyId);
      expect((await f.stored()).status).toBe("active");
    }
  });

  it("planning promotion uses fresh state without completing terminal-only planning missions", async () => {
    const running = await seedSupervisionLifecycle(testDb.db, "planning", "running");
    await sweep(running.companyId);
    expect((await running.stored()).status).toBe("active");
    const pending = await seedSupervisionLifecycle(testDb.db, "planning", "pending");
    await testDb.db.update(workflowRuns).set({ startedAt: null }).where(eq(workflowRuns.id, pending.run!.id));
    await sweep(pending.companyId);
    expect((await pending.stored()).status).toBe("planning");
    const terminal = await seedSupervisionLifecycle(testDb.db, "planning");
    await sweep(terminal.companyId);
    expect((await terminal.stored()).status).toBe("planning");
  });

  it("real canonical cleanup refuses an intervening run epoch change", async () => {
    const f = await seedTerminalTransaction(testDb.db, true);
    const original = authority.captureMissionTerminalAuthority;
    let captured = false;
    const spy = vi.spyOn(authority, "captureMissionTerminalAuthority").mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      captured = true;
      await testDb.db.update(workflowRuns).set({ dispatchAuthorityVersion: 2 }).where(eq(workflowRuns.missionId, f.missionId));
      return result;
    });
    try {
      await service().runMainExecutorSupervision({ missionId: f.missionId, applySafeActions: true });
      expect(captured).toBe(true);
      const state = await terminalState(testDb.db, f);
      expect(state.missions[0].status).toBe("active");
      expect(state.runs[0].status).toBe("running");
      expect(state.runtimes[0].status).toBe("busy");
      expect(state.issues.find(row => row.id === f.issueId)?.executionRunId).toBe(f.runId);
    } finally { spy.mockRestore(); }
  });
});

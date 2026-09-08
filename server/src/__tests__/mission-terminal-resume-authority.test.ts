import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { runMissionTerminalCleanup } from "../services/missions/terminal-cleanup-fence.js";
import * as authority from "../services/missions/terminal-cleanup-authority.js";
import { missionService } from "../services/missions.js";

// Actual in-memory PostgreSQL with generated production schema; no persistence doubles.
describe("mission terminal mutation authority", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const ormRequire = createRequire(require.resolve("drizzle-orm"));
    const dbRequire = createRequire(require.resolve("@paperclipai/db"));
    const { PGlite } = await import(ormRequire.resolve("@electric-sql/pglite"));
    const { generateDrizzleJson, generateMigration } = dbRequire("drizzle-kit/api");
    const client = new PGlite();
    await client.exec((await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))).join(";\n"));
    db = drizzle(client, { schema }) as unknown as Db;
    close = () => client.close();
  }, 60_000);
  afterAll(async () => { await close?.(); });

  async function seed(withRun = true) {
    const [company] = await db.insert(schema.companies).values({ name: "Terminal", issuePrefix: randomUUID() }).returning();
    const [agent] = await db.insert(schema.agents).values({ companyId: company.id, name: "Worker", status: "running" }).returning();
    const [mission] = await db.insert(schema.missions).values({ companyId: company.id, ownerAgentId: agent.id, title: "Mission", status: "active" }).returning();
    const [definition] = await db.insert(schema.workflowDefinitions).values({ companyId: company.id, name: "Workflow", stepsJson: [] }).returning();
    const addRun = async (status = "running") => (await db.insert(schema.workflowRuns).values({
      companyId: company.id, missionId: mission.id, workflowId: definition.id, triggeredBy: "manual", status, dispatchAuthorityVersion: 1,
    }).returning())[0];
    const run = withRun ? await addRun() : null;
    const [issue] = await db.insert(schema.issues).values({ companyId: company.id, missionId: mission.id, title: "Work", status: "in_progress", assigneeAgentId: agent.id }).returning();
    if (run) await db.insert(schema.workflowStepRuns).values({ workflowRunId: run.id, stepId: "work", issueId: issue.id });
    await db.insert(schema.heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id, status: "running" });
    await db.insert(schema.missionAgentRuntimes).values({ companyId: company.id, missionId: mission.id, agentId: agent.id, adapterType: "process", runtimeKey: randomUUID(), status: "busy", processPid: null });
    await db.insert(schema.missionPlanArtifacts).values({ companyId: company.id, missionId: mission.id, ownerAgentId: agent.id, missionGoal: "Goal", status: "active" });
    const [secret] = await db.insert(schema.companySecrets).values({ companyId: company.id, name: randomUUID() }).returning();
    await db.insert(schema.missionSessions).values({ companyId: company.id, missionId: mission.id, agentId: agent.id, sessionSecretId: secret.id, adapterType: "process", status: "active" });
    const cancelHeartbeatRun = vi.fn(async () => undefined);
    const completeOpenMissionOversightIfSettled = vi.fn(async () => undefined);
    const input = { companyId: company.id, missionId: mission.id, status: "cancelled" as const, now: new Date(), completedAt: null, missionSnapshot: mission, cancelHeartbeatRun, completeOpenMissionOversightIfSettled };
    // Construct the caller's pre-mutation snapshot with real reads, even during RED before capture exists.
    const capture = async () => {
      const [current] = await db.select().from(schema.missions).where(eq(schema.missions.id, mission.id));
      const runs = await db.select({ id: schema.workflowRuns.id, dispatchAuthorityVersion: schema.workflowRuns.dispatchAuthorityVersion })
        .from(schema.workflowRuns).where(eq(schema.workflowRuns.missionId, mission.id)).orderBy(schema.workflowRuns.id);
      return { companyId: company.id, missionId: mission.id, missionStatus: current.status, missionUpdatedAt: current.updatedAt, runs };
    };
    const pendingMissionUpdates = { status: "cancelled", title: "Explicit cancellation", completedAt: input.now, updatedAt: input.now };
    return { company, mission, run, input, capture, addRun, pendingMissionUpdates };
  }

  // Whole-table equality detects accidental resource, audit, request and cross-scope writes.
  async function state() {
    const tables = [schema.missions, schema.workflowRuns, schema.workflowStepRuns, schema.issues, schema.heartbeatRuns,
      schema.missionAgentRuntimes, schema.missionPlanArtifacts, schema.missionSessions, schema.agents,
      schema.agentRuntimeState, schema.workflowResumeRequests, schema.workflowResumeExecutions, schema.activityLog];
    return Promise.all(tables.map(async (table) => (await db.select().from(table as typeof schema.missions))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))));
  }
  async function rejectsUnchanged(f: Awaited<ReturnType<typeof seed>>, capturedAuthority: Awaited<ReturnType<typeof f.capture>>) {
    const before = await state();
    expect(await runMissionTerminalCleanup(db, { ...f.input, capturedAuthority, pendingMissionUpdates: f.pendingMissionUpdates }))
      .toEqual({ aborted: true, reason: "resume_reactivated", stoppedRuntimeIds: [] });
    expect(await state()).toEqual(before);
    expect(f.input.cancelHeartbeatRun).not.toHaveBeenCalled();
    expect(f.input.completeOpenMissionOversightIfSettled).not.toHaveBeenCalled();
  }

  it("rejects a captured epoch after resume changes mission status and run authority", async () => {
    const f = await seed();
    await db.update(schema.missions).set({ status: "completed" }).where(eq(schema.missions.id, f.mission.id));
    const captured = await f.capture();
    await db.update(schema.workflowRuns).set({ dispatchAuthorityVersion: 2 }).where(eq(schema.workflowRuns.id, f.run!.id));
    await db.update(schema.missions).set({ status: "active", updatedAt: new Date(Date.now() + 1000) }).where(eq(schema.missions.id, f.mission.id));
    await rejectsUnchanged(f, captured);
  });

  it.each(["accepted", "pending_delivery"])("fresh same-epoch cancellation is not blocked by %s request/execution history", async (requestState) => {
    const f = await seed();
    const [request] = await db.insert(schema.workflowResumeRequests).values({
      companyId: f.company.id, missionId: f.mission.id, workflowRunId: f.run!.id, idempotencyKey: randomUUID(),
      requestHash: "request", snapshotHash: "snapshot", definitionHash: "definition", requestBody: {}, beforeState: {}, appliedGenerations: {}, state: requestState,
    }).returning();
    await db.insert(schema.workflowResumeExecutions).values({ requestId: request.id, companyId: f.company.id,
      missionId: f.mission.id, workflowRunId: f.run!.id, authorityVersion: 1, generations: {}, state: "running" });
    const history = await db.select().from(schema.workflowResumeRequests);
    const executions = await db.select().from(schema.workflowResumeExecutions);
    const result = await runMissionTerminalCleanup(db, { ...f.input, capturedAuthority: await f.capture(), pendingMissionUpdates: f.pendingMissionUpdates });
    expect(result.aborted).toBe(false);
    const [mission] = await db.select().from(schema.missions).where(eq(schema.missions.id, f.mission.id));
    expect(mission).toMatchObject({ status: "cancelled", title: "Explicit cancellation" });
    const [runtime] = await db.select().from(schema.missionAgentRuntimes).where(eq(schema.missionAgentRuntimes.missionId, f.mission.id));
    expect(runtime.status).toBe("stopped");
    expect(await db.select().from(schema.workflowResumeRequests)).toEqual(history);
    expect(await db.select().from(schema.workflowResumeExecutions)).toEqual(executions);
    expect(f.input.cancelHeartbeatRun).not.toHaveBeenCalled();
    expect((await db.select().from(schema.heartbeatRuns).where(eq(schema.heartbeatRuns.issueId,
      (await db.select().from(schema.issues).where(eq(schema.issues.missionId, f.mission.id)))[0].id)))[0].status).toBe("cancelled");
  });

  it("includes terminal runs in the epoch fence even when another run is active", async () => {
    const f = await seed();
    const terminal = await f.addRun("completed");
    await db.update(schema.missions).set({ status: "cancelled" }).where(eq(schema.missions.id, f.mission.id));
    const captured = await f.capture();
    await db.update(schema.workflowRuns).set({ dispatchAuthorityVersion: 2 }).where(eq(schema.workflowRuns.id, terminal.id));
    await rejectsUnchanged(f, captured);
  });

  it("rejects terminal-only run epoch changes instead of bypassing serialization", async () => {
    const f = await seed();
    await db.update(schema.workflowRuns).set({ status: "completed" }).where(eq(schema.workflowRuns.id, f.run!.id));
    const captured = await f.capture();
    await db.update(schema.workflowRuns).set({ dispatchAuthorityVersion: 2 }).where(eq(schema.workflowRuns.id, f.run!.id));
    await rejectsUnchanged(f, captured);
  });

  it("rejects captured empty run set becoming nonempty", async () => {
    const f = await seed(false);
    const captured = await f.capture();
    await f.addRun("completed");
    await rejectsUnchanged(f, captured);
  });

  it("rejects a removed run even when remaining versions match", async () => {
    const f = await seed();
    const extra = await f.addRun("completed");
    await db.update(schema.missions).set({ status: "cancelled" }).where(eq(schema.missions.id, f.mission.id));
    const captured = await f.capture();
    await db.delete(schema.workflowRuns).where(eq(schema.workflowRuns.id, extra.id));
    await rejectsUnchanged(f, captured);
  });

  it.each(["status", "updatedAt"])("rejects intervening mission %s change without run changes", async (field) => {
    const f = await seed(false);
    const captured = await f.capture();
    await db.update(schema.missions).set(field === "status" ? { status: "paused" } : { updatedAt: new Date(Date.now() + 1000) }).where(eq(schema.missions.id, f.mission.id));
    await rejectsUnchanged(f, captured);
  });

  it.each(["completed", "cancelled"] as const)("ordinary no-workflow %s update succeeds atomically", async (status) => {
    const f = await seed(false);
    const result = await runMissionTerminalCleanup(db, { ...f.input, status, capturedAuthority: await f.capture(),
      pendingMissionUpdates: { ...f.pendingMissionUpdates, status } });
    expect(result.aborted).toBe(false);
    const [mission] = await db.select().from(schema.missions).where(eq(schema.missions.id, f.mission.id));
    expect(mission.status).toBe(status);
    expect(mission.title).toBe("Explicit cancellation");
  });

  it.each([true, false])("legacy direct call captures at entry and cleans existing terminal mission (run=%s)", async (withRun) => {
    const f = await seed(withRun);
    await db.update(schema.missions).set({ status: "cancelled" }).where(eq(schema.missions.id, f.mission.id));
    expect((await runMissionTerminalCleanup(db, f.input)).aborted).toBe(false);
  });

  it("capture is exact, sorted, company-scoped and includes terminal runs", async () => {
    const f = await seed();
    await f.addRun("completed");
    await f.addRun("failed");
    await seed(); // foreign company and mission must not enter this authority
    expect(await authority.captureMissionTerminalAuthority(db, f.company.id, f.mission.id)).toEqual(await f.capture());
    const wrongCompany = await seed(false);
    await expect(authority.captureMissionTerminalAuthority(db, wrongCompany.company.id, f.mission.id)).rejects.toMatchObject({ status: 404 });
    await rejectsUnchanged(f, { ...await f.capture(), companyId: wrongCompany.company.id });
  });

  it.each(["before_capture", "after_capture"])("missions.update preserves resumed mission (%s interleave)", async (timing) => {
    const f = await seed();
    await db.update(schema.missions).set({ status: "cancelled" }).where(eq(schema.missions.id, f.mission.id));
    const original = authority.captureMissionTerminalAuthority;
    let resumedState: Awaited<ReturnType<typeof state>>;
    const resume = async () => {
      await db.update(schema.workflowRuns).set({ dispatchAuthorityVersion: 2 }).where(eq(schema.workflowRuns.id, f.run!.id));
      await db.update(schema.missions).set({ status: "active", startedAt: new Date(), completedAt: null, updatedAt: new Date(Date.now() + 1000) }).where(eq(schema.missions.id, f.mission.id));
      resumedState = await state();
    };
    // Controlled scheduling only: original capture, updates, transactions and readback are real DB operations.
    const spy = vi.spyOn(authority, "captureMissionTerminalAuthority").mockImplementationOnce(async (...args) => {
      if (timing === "before_capture") await resume();
      const captured = await original(...args);
      if (timing === "after_capture") await resume();
      return captured;
    });
    try {
      const result = await missionService(db, { cancelHeartbeatRun: f.input.cancelHeartbeatRun })
        .update(f.mission.id, { status: "cancelled", title: "Stale terminal title" });
      expect(result).toMatchObject({ status: "active", title: "Mission", completedAt: null });
      expect(await state()).toEqual(resumedState!);
      expect(f.input.cancelHeartbeatRun).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it("missions.update handles no-workflow terminal and ordinary nonterminal updates", async () => {
    const f = await seed(false);
    const service = missionService(db, { cancelHeartbeatRun: f.input.cancelHeartbeatRun });
    expect(await service.update(f.mission.id, { title: "Renamed" })).toMatchObject({ status: "active", title: "Renamed" });
    expect(await service.update(f.mission.id, { status: "cancelled" })).toMatchObject({ status: "cancelled", title: "Renamed" });
    expect(f.input.cancelHeartbeatRun).not.toHaveBeenCalled();
    expect((await db.select().from(schema.issues).where(eq(schema.issues.missionId, f.mission.id)))[0].status).toBe("cancelled");
    expect((await db.select().from(schema.missionAgentRuntimes).where(eq(schema.missionAgentRuntimes.missionId, f.mission.id)))[0].status).toBe("stopped");
  });

  it("pending mission status and cleanup roll back together on a thrown callback", async () => {
    const f = await seed(false);
    const before = await state();
    await expect(runMissionTerminalCleanup(db, { ...f.input, status: "completed", capturedAuthority: await f.capture(),
      pendingMissionUpdates: { ...f.pendingMissionUpdates, status: "completed" },
      completeOpenMissionOversightIfSettled: async () => { throw new Error("injected callback failure"); },
    })).rejects.toThrow("injected callback failure");
    expect(await state()).toEqual(before);
  });

  it("legacy direct call rejects active mission even without workflow", async () => {
    const f = await seed(false);
    const before = await state();
    expect((await runMissionTerminalCleanup(db, f.input)).aborted).toBe(true);
    expect(await state()).toEqual(before);
  });
});

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { issueComments, issues, missionDelegations, missions, workflowDefinitions, workflowRuns } from "@paperclipai/db";
import { buildMissionDetail } from "../services/missions/mission-detail.js";
import { seedTerminalTransaction, startTerminalTransactionDatabase, terminalState } from "./helpers/mission-terminal-transaction.js";

// Do not launch an external agent. All lifecycle writes and consumer decisions use real PG.
vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => ({ wakeup: async () => null }),
}));

// The real module has consumer cycles. Load it first, then clear those cached consumers
// before installing the pure GET boundary, so none retain an unwrapped mission service.
const original = await import("../services/missions.js");
vi.resetModules();
vi.doMock("../services/missions.js", () => ({
  ...original,
  missionService: (...args: Parameters<typeof original.missionService>) => ({
    ...original.missionService(...args),
    getById: async (id: string) => {
      const [mission] = await args[0].select().from(missions).where(eq(missions.id, id));
      if (!mission) throw new Error("Missing test mission");
      return buildMissionDetail(args[0], mission);
    },
  }),
}));
const { missionService } = await import("../services/missions.js");
const { missionDelegationService } = await import("../services/mission-delegations.js");
const { workflowService } = await import("../services/workflow/engine.js");
const { ensureCreatedRunOversight } = await import("../services/workflow/workflow-created-run-oversight.js");
const { getWorkflowRunById } = await import("../services/workflow/workflow-store.js");

// Each regression catches a consumer still relying on GET to perform lifecycle writes.
describe("explicit mission reconciliation in mutation consumers", () => {
  let testDb: Awaited<ReturnType<typeof startTerminalTransactionDatabase>>;
  beforeAll(async () => { testDb = await startTerminalTransactionDatabase(); }, 60_000);
  afterAll(async () => { await testDb?.cleanup(); });

  it("scheduler settles an old terminal mission before deciding whether its date is occupied", async () => {
    const { db } = testDb;
    const f = await seedTerminalTransaction(db, true);
    const [oldRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, f.missionId));
    await db.update(workflowDefinitions).set({
      schedule: "0 6 * * *", timezone: "UTC", status: "active",
      stepsJson: [{ id: "collect", name: "Collect", agentId: f.mission.ownerAgentId, dependencies: [] }],
    }).where(eq(workflowDefinitions.id, oldRun.workflowId));
    await db.update(workflowRuns).set({ triggerSource: "schedule", runDate: "2026-10-09" }).where(eq(workflowRuns.id, oldRun.id));
    expect((await missionService(db).getById(f.missionId)).status).toBe("active");

    const result = await workflowService.claimScheduledRun(db, {
      workflowId: oldRun.workflowId, companyId: f.companyId,
      scheduledAt: new Date("2026-10-09T06:00:00Z"), runDate: "2026-10-09", timezone: "UTC",
    });

    expect(result.claimed).toBe(true);
    expect(result.run?.missionId).not.toBe(f.missionId);
    const state = await terminalState(db, f);
    expect(state.missions[0]).toMatchObject({ status: "completed", completedAt: f.completedAt });
    expect(state.issues[0]).toMatchObject({ status: "done", executionRunId: null });
    expect(state.runtimes[0].status).toBe("stopped");
    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, oldRun.workflowId));
    expect(runs).toHaveLength(2);
    expect(runs.find((run) => run.id === result.run?.runId)?.missionId).toBe(result.run?.missionId);
  });

  it("post-create oversight promotes a started planning mission and reopens its oversight", async () => {
    const { db } = testDb;
    const f = await seedTerminalTransaction(db);
    await db.update(missions).set({ status: "planning", startedAt: null }).where(eq(missions.id, f.missionId));
    await db.update(workflowRuns).set({ status: "running", startedAt: f.completedAt, completedAt: null }).where(eq(workflowRuns.missionId, f.missionId));
    await db.update(issues).set({ status: "done", completedAt: f.completedAt }).where(eq(issues.id, f.issueId));
    const [row] = await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, f.missionId));
    const run = await getWorkflowRunById(db, row.id);
    expect(run).not.toBeNull();

    await ensureCreatedRunOversight(db, run!);

    const state = await terminalState(db, f);
    expect(state.missions[0]).toMatchObject({ status: "active", startedAt: f.completedAt, completedAt: null });
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]).toMatchObject({ id: f.issueId, status: "todo", completedAt: null });
  });

  it("post-create oversight closes settled work rather than reviving stale active oversight", async () => {
    const { db } = testDb;
    const f = await seedTerminalTransaction(db, true);
    const [row] = await db.select().from(workflowRuns).where(eq(workflowRuns.missionId, f.missionId));
    const run = await getWorkflowRunById(db, row.id);

    await ensureCreatedRunOversight(db, run!);

    const state = await terminalState(db, f);
    expect(state.missions[0]).toMatchObject({ status: "completed", completedAt: f.completedAt });
    expect(state.issues).toHaveLength(1);
    expect(state.issues[0]).toMatchObject({ id: f.issueId, status: "done", executionRunId: null });
    expect(state.runs[0].status).toBe("cancelled");
  });

  it.each(["completed", "cancelled"] as const)("idempotent delegation settles a %s target without duplicating records", async (status) => {
    const { db } = testDb;
    const source = await seedTerminalTransaction(db);
    const target = await seedTerminalTransaction(db, true);
    await db.update(workflowRuns).set({ status }).where(eq(workflowRuns.missionId, target.missionId));
    const [tracker] = await db.insert(issues).values({
      companyId: source.companyId, missionId: source.missionId, title: "Delegation tracker",
      status: "blocked", originKind: "mission_delegation_source", assigneeAgentId: source.mission.ownerAgentId,
    }).returning();
    const [delegation] = await db.insert(missionDelegations).values({
      sourceCompanyId: source.companyId, sourceMissionId: source.missionId, sourceIssueId: tracker.id,
      externalKey: "existing-unit", targetCompanyId: target.companyId, targetMissionId: target.missionId, status: "active",
    }).returning();
    const input = { sourceMissionId: source.missionId, externalKey: " existing-unit ", targetCompanyId: target.companyId, targetOwnerAgentId: target.mission.ownerAgentId };
    const service = missionDelegationService(db);

    const result = await service.create(input);

    expect(result.targetMission).toMatchObject({ id: target.missionId, status, completedAt: target.completedAt, ownerAgentName: "Runner" });
    expect(result.delegation.id).toBe(delegation.id);
    const state = await terminalState(db, target);
    expect(state.missions[0].status).toBe(status);
    expect(state.issues[0].status).toBe(status === "completed" ? "done" : "cancelled");
    const [storedTracker] = await db.select().from(issues).where(eq(issues.id, tracker.id));
    expect(storedTracker.status).toBe(status === "completed" ? "done" : "cancelled");
    const [storedDelegation] = await service.listForMission(source.missionId);
    expect(storedDelegation).toMatchObject({ id: delegation.id, status: status === "completed" ? "completed" : "failed" });
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, tracker.id));
    expect(comments).toHaveLength(1);

    const repeated = await service.create(input);
    expect(repeated.targetMission).toEqual(result.targetMission);
    expect(repeated.delegation).toEqual(storedDelegation);
    expect(repeated.sourceIssue.status).toBe(storedTracker.status);
    expect(await service.listForMission(source.missionId)).toEqual([storedDelegation]);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, tracker.id))).toEqual(comments);
    expect(await terminalState(db, target)).toEqual(state);
    expect(await db.select().from(missions).where(eq(missions.companyId, target.companyId))).toHaveLength(1);
  });

  it("delegation keeps existing missing-tracker and new-delegation company validation", async () => {
    const { db } = testDb;
    const source = await seedTerminalTransaction(db);
    const target = await seedTerminalTransaction(db);
    await db.insert(missionDelegations).values({
      sourceCompanyId: source.companyId, sourceMissionId: source.missionId, sourceIssueId: null,
      externalKey: "broken", targetCompanyId: target.companyId, targetMissionId: target.missionId, status: "active",
    });
    const service = missionDelegationService(db);
    await expect(service.create({ sourceMissionId: source.missionId, externalKey: "broken", targetCompanyId: target.companyId, targetOwnerAgentId: target.mission.ownerAgentId })).rejects.toMatchObject({ status: 404 });
    await expect(service.create({ sourceMissionId: source.missionId, targetCompanyId: source.companyId, targetOwnerAgentId: source.mission.ownerAgentId })).rejects.toMatchObject({ status: 400 });
    await expect(service.create({ sourceMissionId: source.missionId, targetCompanyId: target.companyId, targetOwnerAgentId: randomUUID() })).rejects.toMatchObject({ status: 404 });
    expect(await db.select().from(missionDelegations).where(eq(missionDelegations.sourceMissionId, source.missionId))).toHaveLength(1);
    expect(await db.select().from(issues).where(and(eq(issues.missionId, source.missionId), eq(issues.originKind, "mission_delegation_source")))).toHaveLength(0);
  });
});

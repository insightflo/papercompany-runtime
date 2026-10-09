import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companySecrets, issues, missionAgents, missionPlanArtifacts, missionSessions, missions, projects, workflowRuns } from "@paperclipai/db";
import { missionService } from "../services/missions.js";
import { seedTerminalTransaction, startTerminalTransactionDatabase, terminalState } from "./helpers/mission-terminal-transaction.js";

// Observe only domain arguments; keep the canonical reconciliation and all DB effects real.
const reconciliationCalls = vi.hoisted(() => [] as Array<{ id: string; status: string }>);
vi.mock("../services/missions/owner-actions.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/missions/owner-actions.js")>();
  return {
    ...original,
    createOwnerActions: (...args: Parameters<typeof original.createOwnerActions>) => {
      const actions = original.createOwnerActions(...args);
      const reconcile = actions.reconcileMissionStatusFromWorkflowRuns;
      actions.reconcileMissionStatusFromWorkflowRuns = async (mission) => {
        reconciliationCalls.push({ id: mission.id, status: mission.status });
        return reconcile(mission);
      };
      return actions;
    },
  };
});

// Breaks caught: missing explicit settlement, skipped/doubled canonical reconciliation,
// lost detail fields, no-op rewrites, or update returning the raw requested terminal status.
describe("explicit mission reconciliation", () => {
  let testDb: Awaited<ReturnType<typeof startTerminalTransactionDatabase>>;
  beforeAll(async () => { testDb = await startTerminalTransactionDatabase(); }, 60_000);
  afterAll(async () => { await testDb?.cleanup(); });
  beforeEach(() => { reconciliationCalls.length = 0; });

  it.each(["completed", "cancelled"] as const)("durably settles native %s without a preceding GET/list and repeats without writes", async (status) => {
    const { db } = testDb;
    const f = await seedTerminalTransaction(db, true);
    await db.update(workflowRuns).set({ status }).where(eq(workflowRuns.missionId, f.missionId));
    const svc = missionService(db);
    const get = vi.spyOn(svc, "getById").mockRejectedValue(new Error("public GET must not be used"));
    const list = vi.spyOn(svc, "list").mockRejectedValue(new Error("public list must not be used"));

    const result = await svc.reconcileById(f.missionId);

    expect(result).toMatchObject({ id: f.missionId, status, completedAt: f.completedAt, ownerAgentName: "Runner", project: null, agents: [], sessionBindings: [] });
    expect(result).toHaveProperty("activeMissionPlan");
    expect(result.ownerActionExplanations).toEqual([]);
    const state = await terminalState(db, f);
    expect(state.missions[0]).toMatchObject({ status, completedAt: f.completedAt });
    expect(state.issues[0]).toMatchObject({ status: status === "completed" ? "done" : "cancelled", checkoutRunId: null, executionRunId: null });
    expect(state.runs[0]).toMatchObject({ status: "cancelled", error: `Cancelled because mission was ${status}` });
    expect(state.runtimes[0]).toMatchObject({ status: "stopped", queueDepth: 0, stopReason: `mission.${status}` });
    expect(reconciliationCalls).toEqual([{ id: f.missionId, status: "active" }]);

    await db.$client.unsafe("truncate terminal_test_writes");
    expect(await svc.reconcileById(f.missionId)).toEqual(result);
    expect(await terminalState(db, f)).toEqual(state);
    expect(await db.$client.unsafe("select * from terminal_test_writes")).toHaveLength(0);
    expect(reconciliationCalls).toEqual([{ id: f.missionId, status: "active" }, { id: f.missionId, status }]);
    expect(get).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("returns the existing full detail projection for an active no-op without writing", async () => {
    const { db } = testDb;
    const f = await seedTerminalTransaction(db);
    await db.update(workflowRuns).set({ status: "running", completedAt: null }).where(eq(workflowRuns.missionId, f.missionId));
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: f.companyId, name: "Example project", color: "#123456" });
    await db.update(missions).set({ projectId }).where(eq(missions.id, f.missionId));
    await db.insert(missionAgents).values({ missionId: f.missionId, agentId: f.mission.ownerAgentId, role: "executor" });
    const secretId = randomUUID();
    await db.insert(companySecrets).values({ id: secretId, companyId: f.companyId, name: "session" });
    await db.insert(missionSessions).values({ companyId: f.companyId, missionId: f.missionId, agentId: f.mission.ownerAgentId, sessionSecretId: secretId, adapterType: "codex_local", status: "active", lastActiveAt: f.completedAt, runCount: 2 });
    const before = await terminalState(db, f);
    await db.$client.unsafe("truncate terminal_test_writes");

    const result = await missionService(db).reconcileById(f.missionId);

    expect(result).toMatchObject({ status: "active", completedAt: null, ownerAgentName: "Runner", project: { id: projectId, name: "Example project", color: "#123456" } });
    expect(result.agents).toEqual([expect.objectContaining({ agentId: f.mission.ownerAgentId, agentName: "Runner", role: "executor" })]);
    expect(result.sessionBindings).toEqual([{ agentId: f.mission.ownerAgentId, adapterType: "codex_local", status: "active", lastActiveAt: f.completedAt, runCount: 2 }]);
    expect(await terminalState(db, f)).toEqual(before);
    expect(await db.$client.unsafe("select * from terminal_test_writes")).toHaveLength(0);
    expect(reconciliationCalls).toEqual([{ id: f.missionId, status: "active" }]);
  });

  it.each(["completed", "cancelled"] as const)("update preserves explicit %s with a failed native run independently of public GET", async (status) => {
    const { db } = testDb;
    const f = await seedTerminalTransaction(db, true);
    await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.missionId, f.missionId));
    await db.insert(missionPlanArtifacts).values({ companyId: f.companyId, missionId: f.missionId, ownerAgentId: f.mission.ownerAgentId, missionGoal: "goal" });
    const svc = missionService(db);
    const get = vi.spyOn(svc, "getById").mockRejectedValue(new Error("public GET must not be used"));

    const result = await svc.update(f.missionId, { status });

    expect(result).toMatchObject({ status, ownerAgentName: "Runner" });
    expect(result.completedAt).toBeInstanceOf(Date);
    expect((await terminalState(db, f)).missions[0].status).toBe(status);
    const [plan] = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, f.missionId));
    expect(plan.status).toBe(status === "completed" ? "completed" : "archived");
    expect(reconciliationCalls).toEqual([{ id: f.missionId, status }]);
    expect(get).not.toHaveBeenCalled();
  });

  it("update still returns active when genuinely unsettled work reopens completed", async () => {
    const { db } = testDb;
    const f = await seedTerminalTransaction(db, true);
    await db.insert(issues).values({ companyId: f.companyId, missionId: f.missionId, title: "Unsettled work", status: "todo", originKind: "mission_workflow_step", assigneeAgentId: f.mission.ownerAgentId });
    const svc = missionService(db);
    vi.spyOn(svc, "getById").mockRejectedValue(new Error("public GET must not be used"));

    const result = await svc.update(f.missionId, { status: "completed" });

    expect(result).toMatchObject({ status: "active", completedAt: null });
    expect((await terminalState(db, f)).missions[0]).toMatchObject({ status: "active", completedAt: null });
    expect(reconciliationCalls).toEqual([{ id: f.missionId, status: "completed" }]);
  });

  it("nonterminal update also reconciles its response once", async () => {
    const { db } = testDb;
    const f = await seedTerminalTransaction(db, true);
    const result = await missionService(db).update(f.missionId, { title: "Renamed" });
    expect(result).toMatchObject({ title: "Renamed", status: "completed", completedAt: f.completedAt });
    expect((await terminalState(db, f)).missions[0]).toMatchObject({ title: "Renamed", status: "completed" });
    expect(reconciliationCalls).toEqual([{ id: f.missionId, status: "active" }]);
  });

  it("rejects invalid or missing identity before reconciliation", async () => {
    const svc = missionService(testDb.db);
    await expect(svc.reconcileById("invalid")).rejects.toMatchObject({ status: 400 });
    await expect(svc.reconcileById(randomUUID())).rejects.toMatchObject({ status: 404 });
    expect(reconciliationCalls).toEqual([]);
  });
});

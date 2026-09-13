/**
 * [purpose] Slice-5 MISMATCH C: owner-actions auto-reconcile terminal writes must finalize
 *   mission resources atomically via runMissionTerminalCleanup — a queued/running heartbeat
 *   run under the mission is cancelled with a machine reason, issue execution locks are
 *   cleared, and active mission_agent_runtimes are stopped. RED today: the bare
 *   db.update(missions) leaves the run queued, locks held, runtime active.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents, companies, createDb, heartbeatRuns, issues, missionAgentRuntimes, missions,
  workflowDefinitions, workflowRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createOwnerActions } from "../services/missions/owner-actions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skip auto-reconcile finalization tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

describeEmbeddedPostgres("mission auto-reconcile finalizes runs on terminal writes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("auto-reconcile-terminal-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    for (const table of [missionAgentRuntimes, heartbeatRuns, issues, workflowRuns, workflowDefinitions, missions, agents, companies]) {
      await db.delete(table);
    }
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  async function seedMissionWithActiveWork(workflowRunStatus: "cancelled" | "completed", issueStatus: "in_progress" | "done" = "in_progress") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "ReconcileCo",
      issuePrefix: `RC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Runner", role: "member", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(missions).values({
      id: missionId, companyId, ownerAgentId: agentId, title: "Reconcile mission",
      status: "active", startedAt: new Date(),
    });
    const wfId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "WF-RC", stepsJson: [] });
    await db.insert(workflowRuns).values({
      id: randomUUID(), companyId, workflowId: wfId, missionId, status: workflowRunStatus, triggeredBy: "test",
      completedAt: new Date(),
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, missionId, identifier: `RC-${randomUUID().slice(0, 6)}`, title: "Step under mission",
      status: issueStatus, assigneeAgentId: agentId, originKind: "mission_workflow",
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, issueId, status: "queued", invocationSource: "assignment",
    });
    await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId }).where(eq(issues.id, issueId));
    await db.insert(missionAgentRuntimes).values({
      companyId, missionId, agentId, adapterType: "codex_local",
      runtimeKey: `test-${randomUUID().slice(0, 8)}`, status: "busy", queueDepth: 1,
    });
    return { companyId, missionId, runId, issueId };
  }

  it("cancels the queued run, clears locks, and stops the runtime when reconciling to cancelled", async () => {
    const seeded = await seedMissionWithActiveWork("cancelled");
    const [mission] = await db.select().from(missions).where(eq(missions.id, seeded.missionId)).then((rows) => rows);
    expect(mission.status).toBe("active");

    const ownerActions = createOwnerActions({ db, deps: {} });
    const reconciled = await ownerActions.reconcileMissionStatusFromWorkflowRuns(mission);

    expect(reconciled.status).toBe("cancelled");

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)).then((rows) => rows);
    expect(run.status).toBe("cancelled");
    expect(run.error ?? "").toContain("Cancelled because mission was cancelled");

    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId)).then((rows) => rows);
    expect(issue.checkoutRunId).toBeNull();
    expect(issue.executionRunId).toBeNull();

    const runtimes = await db.select().from(missionAgentRuntimes).where(eq(missionAgentRuntimes.missionId, seeded.missionId));
    expect(runtimes.length).toBeGreaterThan(0);
    for (const runtime of runtimes) {
      expect(runtime.status).toBe("stopped");
      expect(runtime.stopReason).toBe("mission.cancelled");
    }
  });

  it("cancels the running run and stops the runtime when reconciling to completed", async () => {
    const seeded = await seedMissionWithActiveWork("completed", "done");
    const [mission] = await db.select().from(missions).where(eq(missions.id, seeded.missionId)).then((rows) => rows);

    const ownerActions = createOwnerActions({ db, deps: {} });
    const reconciled = await ownerActions.reconcileMissionStatusFromWorkflowRuns(mission);

    expect(reconciled.status).toBe("completed");

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)).then((rows) => rows);
    expect(run.status).toBe("cancelled");
    expect(run.error ?? "").toContain("Cancelled because mission was completed");

    const runtimes = await db.select().from(missionAgentRuntimes).where(eq(missionAgentRuntimes.missionId, seeded.missionId));
    for (const runtime of runtimes) expect(runtime.status).toBe("stopped");
  });
});

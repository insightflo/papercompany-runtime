/**
 * [purpose] Slice-5 MISMATCH D: terminal missions that still own live work (queued/running
 *   heartbeat runs via issue linkage, or active mission_agent_runtimes) older than the grace
 *   window get swept — runs cancelled-with-reason, locks cleared, runtimes stopped, activity
 *   mission.orphan_terminal_cleanup_swept recorded only when something settled. Non-terminal
 *   missions, fresh work, resumed missions, and a second sweep are no-ops.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agents, companies, createDb, heartbeatRuns, issues, missionAgentRuntimes, missions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { sweepTerminalMissionOrphanRuns } from "../services/missions/terminal-mission-orphan-sweep.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skip orphan sweep tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

const GRACE_MS = 10 * 60_000;

describeEmbeddedPostgres("terminal mission orphan run sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("orphan-sweep-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    for (const table of [activityLog, missionAgentRuntimes, heartbeatRuns, issues, missions, agents, companies]) {
      await db.delete(table);
    }
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  async function seedCase(input: {
    missionStatus: "active" | "completed" | "cancelled";
    runStatus?: "queued" | "running";
    stale?: boolean;
    withRuntime?: boolean;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "SweepCo",
      issuePrefix: `SW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Swept", role: "member", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(missions).values({
      id: missionId, companyId, ownerAgentId: agentId, title: "Sweep mission",
      status: input.missionStatus,
      ...(input.missionStatus === "completed" ? { completedAt: new Date() } : {}),
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, missionId, identifier: "SW-1", title: "Sweep step",
      status: "in_progress", assigneeAgentId: agentId, originKind: "mission_workflow",
    });
    const runId = randomUUID();
    const timestamp = input.stale === false ? new Date() : new Date(Date.now() - GRACE_MS - 60_000);
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, issueId, status: input.runStatus ?? "running",
      invocationSource: "assignment", createdAt: timestamp, updatedAt: timestamp,
    });
    await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId }).where(eq(issues.id, issueId));
    if (input.withRuntime !== false) {
      await db.insert(missionAgentRuntimes).values({
        companyId, missionId, agentId, adapterType: "codex_local",
        runtimeKey: `sweep-${randomUUID().slice(0, 8)}`, status: "busy", queueDepth: 1,
        createdAt: timestamp, updatedAt: timestamp,
      });
    }
    return { companyId, missionId, runId, issueId };
  }

  it("cancels a stale running run under a completed mission, clears locks, stops runtime, logs activity", async () => {
    const seeded = await seedCase({ missionStatus: "completed" });

    const result = await sweepTerminalMissionOrphanRuns(db, new Date());

    expect(result.sweptMissions).toBe(1);
    expect(result.cancelledRuns).toBe(1);
    expect(result.stoppedRuntimes).toBe(1);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)).then((rows) => rows);
    expect(run.status).toBe("cancelled");
    expect(run.error ?? "").toContain("Cancelled because mission was completed");

    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId)).then((rows) => rows);
    expect(issue.checkoutRunId).toBeNull();
    expect(issue.executionRunId).toBeNull();

    const runtimes = await db.select().from(missionAgentRuntimes).where(eq(missionAgentRuntimes.missionId, seeded.missionId));
    expect(runtimes[0]?.status).toBe("stopped");

    const activities = await db.select().from(activityLog)
      .where(eq(activityLog.entityId, seeded.missionId));
    expect(activities.some((row) => row.action === "mission.orphan_terminal_cleanup_swept")).toBe(true);
  });

  it("leaves non-terminal missions untouched", async () => {
    await seedCase({ missionStatus: "active" });
    const result = await sweepTerminalMissionOrphanRuns(db, new Date());
    expect(result.sweptMissions).toBe(0);
  });

  it("leaves fresh work (younger than grace) untouched", async () => {
    await seedCase({ missionStatus: "completed", stale: false });
    const result = await sweepTerminalMissionOrphanRuns(db, new Date());
    expect(result.sweptMissions).toBe(0);
  });

  it("second sweep is a no-op and writes no new activity", async () => {
    const seeded = await seedCase({ missionStatus: "cancelled" });
    await sweepTerminalMissionOrphanRuns(db, new Date());
    const second = await sweepTerminalMissionOrphanRuns(db, new Date());
    expect(second.sweptMissions).toBe(0);
    const activities = await db.select().from(activityLog)
      .where(eq(activityLog.entityId, seeded.missionId));
    expect(activities.filter((row) => row.action === "mission.orphan_terminal_cleanup_swept").length).toBe(1);
  });

  it("does not sweep a resumed (active) mission even with stale runs", async () => {
    const seeded = await seedCase({ missionStatus: "active" });
    const result = await sweepTerminalMissionOrphanRuns(db, new Date());
    expect(result.sweptMissions).toBe(0);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId)).then((rows) => rows);
    expect(run.status).toBe("running");
  });
});

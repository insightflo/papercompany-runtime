import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  missions,
  workflowDefinitions,
  workflowRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const heartbeatWakeup = vi.fn();

vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return {
    ...actual,
    heartbeatService: () => ({ wakeup: heartbeatWakeup }),
  };
});

import { missionService } from "../services/missions.js";
import { activatePlanningMissionForWorkflowRun } from "../services/missions/mission-workflow-lifecycle.js";
import {
  executeWorkflowRun,
  setWorkflowToolStepExecutor,
  setWorkflowToolStepReadinessChecker,
} from "../services/workflow/dag-engine.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("mission workflow lifecycle", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mission-workflow-lifecycle-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(() => {
    heartbeatWakeup.mockReset();
    setWorkflowToolStepExecutor(null);
    setWorkflowToolStepReadinessChecker(null);
  });

  it("promotes a planning mission when its native workflow starts without a mission read", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();

    heartbeatWakeup.mockImplementation(async () => {
      const [runAtDispatch] = await db
        .select({ status: workflowRuns.status, startedAt: workflowRuns.startedAt })
        .from(workflowRuns)
        .where(eq(workflowRuns.id, workflowRunId));
      const [missionAtDispatch] = await db
        .select({ status: missions.status, startedAt: missions.startedAt })
        .from(missions)
        .where(eq(missions.id, missionId));
      expect(runAtDispatch?.status).toBe("running");
      expect(missionAtDispatch?.status).toBe("active");
      expect(missionAtDispatch?.startedAt).toEqual(runAtDispatch?.startedAt);
      return { id: "queued-lifecycle-regression" };
    });
    await db.insert(companies).values({
      id: companyId,
      name: "Mission Lifecycle Regression",
      issuePrefix: `ML${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Lifecycle Agent",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Planning mission with native execution",
      status: "planning",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Lifecycle workflow",
      stepsJson: [{ id: "work", name: "Do work", agentId, dependencies: [] }],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "test",
      status: "pending",
    });

    const result = await executeWorkflowRun(db, workflowRunId);
    expect(heartbeatWakeup).toHaveBeenCalledTimes(1);
    const [storedMission] = await db
      .select({ status: missions.status, startedAt: missions.startedAt, completedAt: missions.completedAt })
      .from(missions)
      .where(eq(missions.id, missionId));
    const [storedRun] = await db
      .select({ status: workflowRuns.status, startedAt: workflowRuns.startedAt })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, workflowRunId));
    const lifecycleActivities = await db
      .select()
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "mission.workflow_started"),
        eq(activityLog.entityType, "mission"),
        eq(activityLog.entityId, missionId),
      ));

    expect(result.status).toBe("running");
    expect(storedRun?.status).toBe("running");
    expect(storedMission).toEqual({
      status: "active",
      startedAt: storedRun?.startedAt,
      completedAt: null,
    });
    expect(lifecycleActivities).toHaveLength(1);
    expect(lifecycleActivities[0]).toMatchObject({
      companyId,
      actorType: "system",
      actorId: "workflow-dag-engine",
      action: "mission.workflow_started",
      entityType: "mission",
      entityId: missionId,
      details: {
        workflowRunId,
        previousStatus: "planning",
        nextStatus: "active",
      },
    });
  });

  it("does not activate an unstarted mission when tool readiness rejects execution, even after GET reconciliation", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Mission Preflight Regression",
      issuePrefix: `MP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Preflight Owner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Planning mission rejected before execution",
      status: "planning",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Unavailable tool workflow",
      stepsJson: [{
        id: "publish",
        name: "Publish",
        type: "tool",
        toolNames: ["unavailable-publisher"],
        dependencies: [],
      }],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "test",
      status: "pending",
    });
    setWorkflowToolStepReadinessChecker(async () => ({
      available: false,
      reason: "publisher offline",
    }));

    await expect(executeWorkflowRun(db, workflowRunId)).rejects.toThrow(
      "Workflow tools are unavailable: publisher offline",
    );

    const [storedRun] = await db
      .select({ status: workflowRuns.status, startedAt: workflowRuns.startedAt })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, workflowRunId));
    const [storedMissionBeforeRead] = await db
      .select({ status: missions.status, startedAt: missions.startedAt })
      .from(missions)
      .where(eq(missions.id, missionId));
    const missionAfterRead = await missionService(db).getById(missionId);
    const lifecycleActivities = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "mission.workflow_started"),
        eq(activityLog.entityType, "mission"),
        eq(activityLog.entityId, missionId),
      ));

    expect(storedRun).toEqual({ status: "pending", startedAt: null });
    expect(storedMissionBeforeRead).toEqual({ status: "planning", startedAt: null });
    expect({ status: missionAfterRead.status, startedAt: missionAfterRead.startedAt }).toEqual({
      status: "planning",
      startedAt: null,
    });
    expect(lifecycleActivities).toEqual([]);
  });

  it("is idempotent: a second activation for the same planning mission is a no-op", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const workflowRunId = randomUUID();
    const startedAt = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Idempotency Company",
      issuePrefix: `IM${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Idempotency Agent",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Idempotency mission",
      status: "planning",
    });

    const first = await db.transaction((tx) => activatePlanningMissionForWorkflowRun(tx, {
      companyId,
      missionId,
      workflowRunId,
      startedAt,
    }));
    const second = await db.transaction((tx) => activatePlanningMissionForWorkflowRun(tx, {
      companyId,
      missionId,
      workflowRunId,
      startedAt,
    }));
    const [storedMission] = await db
      .select({ status: missions.status, startedAt: missions.startedAt })
      .from(missions)
      .where(eq(missions.id, missionId));
    const lifecycleActivities = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "mission.workflow_started"),
        eq(activityLog.entityType, "mission"),
        eq(activityLog.entityId, missionId),
      ));

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(storedMission).toEqual({ status: "active", startedAt });
    expect(lifecycleActivities).toHaveLength(1);
  });

  it.each(["paused", "completed", "cancelled"] as const)(
    "does not reactivate a %s mission",
    async (status) => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const missionId = randomUUID();
      const workflowRunId = randomUUID();
      const originalStartedAt = new Date(Date.now() - 60_000);
      const originalCompletedAt = new Date(Date.now() - 30_000);

      await db.insert(companies).values({
        id: companyId,
        name: `Terminal ${status}`,
        issuePrefix: `TN${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Terminal Agent",
        role: "operator",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(missions).values({
        id: missionId,
        companyId,
        ownerAgentId: agentId,
        title: `Terminal ${status} mission`,
        status,
        startedAt: originalStartedAt,
        completedAt: originalCompletedAt,
      });

      const activated = await db.transaction((tx) => activatePlanningMissionForWorkflowRun(tx, {
        companyId,
        missionId,
        workflowRunId,
        startedAt: new Date(),
      }));
      const [storedMission] = await db
        .select({
          status: missions.status,
          startedAt: missions.startedAt,
          completedAt: missions.completedAt,
        })
        .from(missions)
        .where(eq(missions.id, missionId));
      const lifecycleActivities = await db
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "mission.workflow_started"),
          eq(activityLog.entityType, "mission"),
          eq(activityLog.entityId, missionId),
        ));

      expect(activated).toBe(false);
      expect(storedMission).toEqual({
        status,
        startedAt: originalStartedAt,
        completedAt: originalCompletedAt,
      });
      expect(lifecycleActivities).toEqual([]);
    },
  );

  it("rejects cross-company activation", async () => {
    const companyA = randomUUID();
    const companyB = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const workflowRunId = randomUUID();

    for (const companyId of [companyA, companyB]) {
      await db.insert(companies).values({
        id: companyId,
        name: `Cross-company ${companyId.slice(0, 4)}`,
        issuePrefix: `CC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
    }
    await db.insert(agents).values({
      id: agentId,
      companyId: companyA,
      name: "Cross-company Agent",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId: companyA,
      ownerAgentId: agentId,
      title: "Company A planning mission",
      status: "planning",
    });

    const activated = await db.transaction((tx) => activatePlanningMissionForWorkflowRun(tx, {
      companyId: companyB,
      missionId,
      workflowRunId,
      startedAt: new Date(),
    }));
    const [storedMission] = await db
      .select({ status: missions.status, startedAt: missions.startedAt })
      .from(missions)
      .where(eq(missions.id, missionId));
    const lifecycleActivities = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(
        inArray(activityLog.companyId, [companyA, companyB]),
        eq(activityLog.action, "mission.workflow_started"),
        eq(activityLog.entityType, "mission"),
        eq(activityLog.entityId, missionId),
      ));

    expect(activated).toBe(false);
    expect(storedMission).toEqual({ status: "planning", startedAt: null });
    expect(lifecycleActivities).toEqual([]);
  });

  it("promotes a planning mission with a started failed run even when an unstarted pending run exists", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const failedStartedAt = new Date(Date.now() - 30_000);

    await db.insert(companies).values({
      id: companyId,
      name: "Mixed Runs Company",
      issuePrefix: `MX${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Mixed Runs Agent",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Mixed runs planning mission",
      status: "planning",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Mixed runs workflow",
      stepsJson: [{ id: "work", name: "Do work", agentId, dependencies: [] }],
    });
    // Started recoverable failure: execution evidence.
    await db.insert(workflowRuns).values({
      id: randomUUID(),
      workflowId,
      companyId,
      missionId,
      triggeredBy: "test",
      status: "failed",
      startedAt: failedStartedAt,
    });
    // Unstarted pending run: not execution evidence.
    await db.insert(workflowRuns).values({
      id: randomUUID(),
      workflowId,
      companyId,
      missionId,
      triggeredBy: "test",
      status: "pending",
    });

    const missionAfterRead = await missionService(db).getById(missionId);

    expect(missionAfterRead.status).toBe("active");
    expect(missionAfterRead.startedAt).toEqual(failedStartedAt);
  });
  it("does not promote a planning mission via a foreign-company run referenced through GET reconciliation", async () => {
    const companyA = randomUUID();
    const companyB = randomUUID();
    const agentId = randomUUID();
    const foreignAgentId = randomUUID();
    const missionId = randomUUID();
    const foreignStartedAt = new Date(Date.now() - 30_000);

    for (const companyId of [companyA, companyB]) {
      await db.insert(companies).values({
        id: companyId,
        name: `Foreign-run ${companyId.slice(0, 4)}`,
        issuePrefix: `FR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
    }
    await db.insert(agents).values({
      id: agentId,
      companyId: companyA,
      name: "Company A owner",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agents).values({
      id: foreignAgentId,
      companyId: companyB,
      name: "Company B executor",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId: companyA,
      ownerAgentId: agentId,
      title: "Company A mission with foreign run reference",
      status: "planning",
    });
    const foreignWorkflowId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: foreignWorkflowId,
      companyId: companyB,
      name: "Foreign company workflow",
      stepsJson: [{ id: "work", name: "Do work", agentId: foreignAgentId, dependencies: [] }],
    });
    // Foreign-company run referencing the companyA missionId with started evidence.
    await db.insert(workflowRuns).values({
      id: randomUUID(),
      workflowId: foreignWorkflowId,
      companyId: companyB,
      missionId,
      triggeredBy: "test",
      status: "running",
      startedAt: foreignStartedAt,
    });

    const missionAfterRead = await missionService(db).getById(missionId);

    expect(missionAfterRead.status).toBe("planning");
    expect(missionAfterRead.startedAt).toBeNull();
  });
});

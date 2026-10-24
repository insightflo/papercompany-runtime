import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, missions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { missionService } from "../services/missions.js";
import { applyOwnerReplanDecision } from "../services/missions/owner-replan-application.js";
import { buildMissionOwnerPlanningContext } from "../services/missions/mission-owner-planning-context.js";
import {
  recordMissionOwnerDecision,
  type MissionOwnerDecisionSubmission,
} from "../services/missions/mission-owner-recovery-ledger.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping mission owner replan application tests: ${support.reason ?? "unsupported host"}`);
}

let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
beforeAll(async () => {
  tempDb = await startEmbeddedPostgresTestDatabase("mission-owner-replan-application-");
}, 60_000);
afterAll(async () => {
  await tempDb?.cleanup();
});

type Seed = {
  db: ReturnType<typeof createDb>;
  companyId: string; missionId: string;
  ownerAgentId: string; workerAgentId: string;
  ownerActionIssueId: string; sourceIssueId: string; decisionEventId: string;
};

async function seedOwnerDecision(decision: MissionOwnerDecisionSubmission["decision"]): Promise<Seed> {
  const db = createDb(tempDb!.connectionString);
  const companyId = randomUUID();
  const missionId = randomUUID();
  const ownerAgentId = randomUUID();
  const workerAgentId = randomUUID();
  const prefix = `RP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

  await db.insert(companies).values({
    id: companyId,
    name: "Replan Application Company",
    issuePrefix: prefix,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values([
    {
      id: ownerAgentId,
      companyId,
      name: "Mission Owner",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
    {
      id: workerAgentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
  ]);
  await db.insert(missions).values({
    id: missionId,
    companyId,
    ownerAgentId,
    title: "Recover stalled mission",
    description: "Continue through a reviewed revision plan.",
    status: "active",
  });

  const issueSvc = issueService(db);
  await issueSvc.create(companyId, {
    assigneeAgentId: ownerAgentId,
    missionId,
    originKind: "mission_main_executor_oversight",
    status: "todo",
    title: "[OVERSIGHT] Recover stalled mission",
  });
  await issueSvc.create(companyId, {
    assigneeAgentId: ownerAgentId,
    missionId,
    originKind: "mission_main_executor_plan",
    status: "done",
    title: "[PLAN] Initial plan",
  });
  const sourceIssue = await issueSvc.create(companyId, {
    assigneeAgentId: workerAgentId,
    missionId,
    originKind: "workflow_execution",
    status: "blocked",
    title: "Blocked source work",
  });
  const ownerAction = await issueSvc.create(companyId, {
    assigneeAgentId: ownerAgentId,
    missionId,
    originKind: "mission_main_executor_unblock",
    originId: sourceIssue.id,
    status: "done",
    title: "Choose recovery action",
  });
  const now = new Date();
  const [heartbeat] = await db.insert(heartbeatRuns).values({
    companyId,
    agentId: ownerAgentId,
    issueId: ownerAction.id,
    status: "succeeded",
    startedAt: now,
    finishedAt: now,
  }).returning({ id: heartbeatRuns.id });
  const decisionRecord = await recordMissionOwnerDecision({
    db,
    issue: { id: ownerAction.id, companyId, missionId },
    submission: { decision, reason: "The current plan cannot complete the mission." },
    sourceIssueId: sourceIssue.id,
    heartbeatRunId: heartbeat!.id,
  });

  return {
    db,
    companyId,
    missionId,
    ownerAgentId,
    workerAgentId,
    ownerActionIssueId: ownerAction.id,
    sourceIssueId: sourceIssue.id,
    decisionEventId: decisionRecord.eventId,
  };
}

async function listPlanningIssues(seed: Seed) {
  return seed.db.select().from(issues).where(and(
    eq(issues.companyId, seed.companyId),
    eq(issues.missionId, seed.missionId),
    eq(issues.originKind, "mission_main_executor_plan"),
  )).orderBy(asc(issues.createdAt), asc(issues.id));
}

describeEmbeddedPostgres("mission owner replan application", () => {
  it("opens one new revision planning issue for a structured replan decision and reuses it on replay", async () => {
    const seed = await seedOwnerDecision("replan_mission");
    await issueService(seed.db).create(seed.companyId, {
      assigneeAgentId: seed.workerAgentId,
      missionId: seed.missionId,
      originKind: "mission_main_executor_plan",
      status: "todo",
      title: "[PLAN] Wrongly assigned plan",
    });
    const onOwnerPlanningIssueCreated = vi.fn();
    const service = missionService(seed.db, { onOwnerPlanningIssueCreated });

    const first = await service.runMainExecutorSupervision({
      missionId: seed.missionId,
      applyOwnerDecisionActions: true,
      now: new Date(Date.now() + 20 * 60 * 1000),
    });

    expect(first.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "owner_decision_replan_mission",
        ownerActionIssueId: seed.ownerActionIssueId,
        resultStatus: "todo",
      }),
    ]));
    const firstPlanningIssues = await listPlanningIssues(seed);
    expect(firstPlanningIssues).toHaveLength(3);
    expect(firstPlanningIssues[0]).toEqual(expect.objectContaining({ status: "done" }));
    expect(firstPlanningIssues[1]).toEqual(expect.objectContaining({
      assigneeAgentId: seed.workerAgentId,
      title: "[PLAN] Wrongly assigned plan",
    }));
    expect(firstPlanningIssues[2]).toEqual(expect.objectContaining({
      assigneeAgentId: seed.ownerAgentId,
      status: "todo",
      title: "[PLAN] Recover stalled mission",
    }));
    const planningContext = await buildMissionOwnerPlanningContext(seed.db, {
      companyId: seed.companyId,
      missionId: seed.missionId,
    });
    expect(planningContext.planningIssueId).toBe(firstPlanningIssues[2]!.id);
    expect(onOwnerPlanningIssueCreated).toHaveBeenCalledOnce();
    expect(onOwnerPlanningIssueCreated).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: seed.missionId }),
      issue: expect.objectContaining({ id: firstPlanningIssues[2]!.id }),
      targetAgentId: seed.ownerAgentId,
      idempotencyKey: `mission-owner-replan-wakeup:${seed.missionId}:${firstPlanningIssues[2]!.id}`,
    }));

    await service.runMainExecutorSupervision({
      missionId: seed.missionId,
      applyOwnerDecisionActions: true,
      now: new Date(Date.now() + 21 * 60 * 1000),
    });
    expect(await listPlanningIssues(seed)).toHaveLength(3);
    expect(onOwnerPlanningIssueCreated).toHaveBeenCalledTimes(2);
    expect(onOwnerPlanningIssueCreated.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      issue: expect.objectContaining({ id: firstPlanningIssues[2]!.id }),
      idempotencyKey: `mission-owner-replan-wakeup:${seed.missionId}:${firstPlanningIssues[2]!.id}`,
    }));
  });

  it("keeps the applied replan action when the planning wake callback rejects", async () => {
    const seed = await seedOwnerDecision("replan_mission");
    const result = await missionService(seed.db, {
      onOwnerPlanningIssueCreated: vi.fn().mockRejectedValue(new Error("wake failed")),
    }).runMainExecutorSupervision({
      missionId: seed.missionId,
      applyOwnerDecisionActions: true,
      now: new Date(Date.now() + 20 * 60 * 1000),
    });

    expect(result.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "owner_decision_replan_mission" }),
    ]));
    expect(await listPlanningIssues(seed)).toHaveLength(2);
  });

  it("does not apply a replan superseded by a newer structured decision", async () => {
    const seed = await seedOwnerDecision("replan_mission");
    const now = new Date();
    const [heartbeat] = await seed.db.insert(heartbeatRuns).values({
      companyId: seed.companyId, agentId: seed.ownerAgentId, issueId: seed.ownerActionIssueId,
      status: "succeeded", startedAt: now, finishedAt: now,
    }).returning({ id: heartbeatRuns.id });
    await recordMissionOwnerDecision({
      db: seed.db,
      issue: { id: seed.ownerActionIssueId, companyId: seed.companyId, missionId: seed.missionId },
      submission: { decision: "request_input", reason: "Need a newer operator answer." },
      sourceIssueId: seed.sourceIssueId, heartbeatRunId: heartbeat!.id,
    });
    await expect(applyOwnerReplanDecision({
      db: seed.db, mission: await missionService(seed.db).getById(seed.missionId),
      ownerActionIssueId: seed.ownerActionIssueId, expectedDecisionEventId: seed.decisionEventId,
    })).resolves.toBeNull();
    expect(await listPlanningIssues(seed)).toHaveLength(1);
  });

  it("returns null when the supplied mission identity is absent or belongs to another company", async () => {
    const seed = await seedOwnerDecision("replan_mission");
    const mission = await missionService(seed.db).getById(seed.missionId);
    for (const invalidMission of [{ ...mission, id: randomUUID() }, { ...mission, companyId: randomUUID() }]) {
      await expect(applyOwnerReplanDecision({
        db: seed.db, mission: invalidMission, ownerActionIssueId: seed.ownerActionIssueId,
        expectedDecisionEventId: seed.decisionEventId,
      })).resolves.toBeNull();
    }
    expect(await listPlanningIssues(seed)).toHaveLength(1);
  });

  it("does not let a former owner decision create planning work after ownership changes", async () => {
    const seed = await seedOwnerDecision("replan_mission");
    const staleMission = await missionService(seed.db).getById(seed.missionId);
    await seed.db.update(missions).set({ ownerAgentId: seed.workerAgentId }).where(eq(missions.id, seed.missionId));
    await expect(applyOwnerReplanDecision({
      db: seed.db, mission: staleMission, ownerActionIssueId: seed.ownerActionIssueId,
      expectedDecisionEventId: seed.decisionEventId,
    })).resolves.toBeNull();
    expect(await listPlanningIssues(seed)).toHaveLength(1);
  });

  it("does not create planning work after the locked mission becomes terminal", async () => {
    const seed = await seedOwnerDecision("replan_mission");
    await seed.db.update(missions).set({ status: "completed", completedAt: new Date() })
      .where(eq(missions.id, seed.missionId));

    await expect(applyOwnerReplanDecision({
      db: seed.db,
      mission: { ...await missionService(seed.db).getById(seed.missionId), status: "active" },
      ownerActionIssueId: seed.ownerActionIssueId,
      expectedDecisionEventId: seed.decisionEventId,
    })).resolves.toBeNull();
    expect(await listPlanningIssues(seed)).toHaveLength(1);
  });

  it("keeps non-replan structured owner decisions read-only", async () => {
    const seed = await seedOwnerDecision("request_input");
    const result = await missionService(seed.db).runMainExecutorSupervision({
      missionId: seed.missionId,
      applyOwnerDecisionActions: true,
      now: new Date(Date.now() + 20 * 60 * 1000),
    });

    expect(result.appliedActions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "owner_decision_replan_mission" }),
    ]));
    expect(await listPlanningIssues(seed)).toHaveLength(1);
  });
});

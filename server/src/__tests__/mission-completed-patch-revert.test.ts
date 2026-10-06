import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  activityLog, agents, companies, createDb, issues, missionPlanArtifacts, missions, workflowDefinitions, workflowRuns,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { missionRoutes } from "../routes/missions.js";

/**
 * [파일 목적] PATCH /missions/:id {status:"completed"} 후 읽기경로 reconcile 이 미션을
 *   'active' 로 조용히 되돌리던 결함(A1 fd88ca7b 관찰)의 수정을 고정한다.
 * [수정 내용] owner-actions.ts recoverableFailedWorkflowRunStatuses 분기의 completed 가드가
 *   1a058177(active-런 분기)와 같은 모양으로 운영자 명시 종단 쓰기를 보존하고, 종단 PATCH 가
 *   무효화되면 라우트가 409 로 알리며, reconcile 상태 쓰기는 활동 로그를 남긴다.
 * [판별 증거] missionPlanArtifacts.status='completed' 는 terminal 트랜잭션이 commit 했음을
 *   증명하고(같은 트랜잭션에서만 바뀐다), missions.status='completed' 유지는 커밋 후
 *   되돌림이 더 이상 일어나지 않음을 증명한다.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping mission completed PATCH revert tests: ${embeddedPostgresSupport.reason ?? "unsupported host"}`);
}

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: Db;

beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("mission-completed-revert-");
  db = createDb(temp.connectionString);
}, 60000);
afterAll(async () => { await temp?.cleanup(); });

function boardApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", source: "local_implicit", userId: "board-user" } as typeof req.actor;
    next();
  });
  app.use("/api", missionRoutes(db));
  app.use(errorHandler);
  return app;
}

interface SeedOptions {
  workflowCreated: boolean;
  missionStatus?: "active" | "completed" | "planning";
  runStatus?: "failed" | "completed";
  runStartedAt?: Date;
  openWorkIssue?: boolean;
}

async function seed(options: SeedOptions) {
  const companyId = randomUUID(), agentId = randomUUID(), missionId = randomUUID();
  const workflowId = randomUUID(), runId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "RevertCo", issuePrefix: companyId.slice(0, 8) });
  await db.insert(agents).values({ id: agentId, companyId, name: "Owner" });
  await db.insert(missions).values({
    id: missionId, companyId, ownerAgentId: agentId, title: "M",
    description: options.workflowCreated
      ? "Created automatically for workflow run: manual completion attempt"
      : "Manually created mission",
    status: options.missionStatus ?? "active",
    startedAt: options.missionStatus === "completed" ? new Date("2026-01-01T00:00:00Z") : undefined,
    completedAt: options.missionStatus === "completed" ? new Date("2026-01-02T00:00:00Z") : undefined,
  });
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "WF", stepsJson: [] });
  await db.insert(workflowRuns).values({
    id: runId, companyId, missionId, workflowId,
    status: options.runStatus ?? "failed",
    triggeredBy: "test",
    startedAt: options.runStartedAt ?? new Date("2026-01-01T00:00:00Z"),
  });
  await db.insert(missionPlanArtifacts).values({
    companyId, missionId, ownerAgentId: agentId, missionGoal: "goal",
  });
  if (options.openWorkIssue) {
    // findOpenMissionWork 가 미결 작업으로 치는 조건: hiddenAt=null, status not in
    // (done,cancelled), originKind != mission_main_executor_oversight.
    await db.insert(issues).values({
      companyId, missionId, title: "Open step work", status: "todo",
      originKind: "mission_workflow_step", assigneeAgentId: agentId,
    });
    // reopen 경로의 ensureMainExecutorOversightIssue 가 기존 오버사이트를 찾도록 시드.
    await db.insert(issues).values({
      companyId, missionId, title: "[OVERSIGHT] M", status: "todo",
      originKind: "mission_main_executor_oversight", assigneeAgentId: agentId,
    });
  }
  return { companyId, missionId, runId };
}

async function readMission(missionId: string) {
  const [row] = await db.select().from(missions).where(eq(missions.id, missionId)).limit(1);
  return row!;
}
async function readPlanArtifact(missionId: string) {
  const [row] = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, missionId)).limit(1);
  return row!;
}
async function readMissionActivities(missionId: string) {
  return db
    .select({ action: activityLog.action, details: activityLog.details })
    .from(activityLog)
    .where(and(eq(activityLog.entityType, "mission"), eq(activityLog.entityId, missionId)));
}

describeEP("mission completed PATCH silent revert", () => {
  it("completed 전환은 유지된다 — workflow-created 미션 + failed 런 (1a058177 sibling)", async () => {
    const { missionId } = await seed({ workflowCreated: true });
    const before = await readMission(missionId);
    await new Promise((resolve) => setTimeout(resolve, 20)); // updatedAt 시각 분리

    const res = await request(boardApp()).patch(`/api/missions/${missionId}`).send({ status: "completed" });

    expect(res.status).toBe(200);
    const after = await readMission(missionId);
    const planArtifact = await readPlanArtifact(missionId);

    // 판별 증거 1: terminal 트랜잭션은 실제로 commit 했다 (같은 트랜잭션에서 닫힌 plan artifact).
    expect(planArtifact.status).toBe("completed");
    // 판별 증거 2: 응답 조립(getById→reconcile) 후에도 미션 행은 completed 로 유지된다.
    expect(after.status).toBe("completed");
    expect(after.completedAt).not.toBeNull();
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect(res.body.status).toBe("completed");
  });

  it("control — 수동 생성 미션(동일 failed 런): completed 전환은 유지된다", async () => {
    const { missionId } = await seed({ workflowCreated: false });
    const res = await request(boardApp()).patch(`/api/missions/${missionId}`).send({ status: "completed" });
    expect(res.status).toBe(200);
    const after = await readMission(missionId);
    expect(after.status).toBe("completed");
    expect(after.completedAt).not.toBeNull();
  });

  it("control — workflow-created 미션: cancelled 전환은 되돌아가지 않는다", async () => {
    const { missionId } = await seed({ workflowCreated: true });
    const res = await request(boardApp()).patch(`/api/missions/${missionId}`).send({ status: "cancelled" });
    expect(res.status).toBe(200);
    const after = await readMission(missionId);
    expect(after.status).toBe("cancelled");
  });

  it("list() 읽기경로에서도 completed 되돌림이 일어나지 않는다 — workflow-created + failed 런", async () => {
    const { companyId, missionId } = await seed({ workflowCreated: true, missionStatus: "completed" });

    const resAll = await request(boardApp()).get(`/api/companies/${companyId}/missions`);
    expect(resAll.status).toBe(200);
    expect(resAll.body.find((mission: { id: string }) => mission.id === missionId)?.status).toBe("completed");

    const resCompleted = await request(boardApp()).get(`/api/companies/${companyId}/missions?status=completed`);
    expect(resCompleted.status).toBe(200);
    expect(resCompleted.body.find((mission: { id: string }) => mission.id === missionId)?.status).toBe("completed");

    const after = await readMission(missionId);
    expect(after.status).toBe("completed");
    expect(after.completedAt).not.toBeNull();
  });

  it("종단 PATCH가 재오픈으로 무효화되면 409 — workflow-created + completed 런 + 미결 non-oversight 작업", async () => {
    const { missionId } = await seed({
      workflowCreated: true,
      missionStatus: "active",
      runStatus: "completed",
      openWorkIssue: true,
    });

    const res = await request(boardApp()).patch(`/api/missions/${missionId}`).send({ status: "completed" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("was not applied");
    const after = await readMission(missionId);
    expect(after.status).toBe("active");

    const activities = await readMissionActivities(missionId);
    // 재오픈 경로의 자체 활동 로그가 존재한다 (라우트의 mission.updated 로그 대신).
    expect(activities.some((entry) => entry.action === "mission.reopened_for_unsettled_work")).toBe(true);
    expect(activities.some((entry) => entry.action === "mission.updated")).toBe(false);
  });

  it("reconcile의 recoverable-failed 상태 쓰기는 활동 로그를 남긴다 — planning→active", async () => {
    const { missionId } = await seed({
      workflowCreated: true,
      missionStatus: "planning",
      runStatus: "failed",
      runStartedAt: new Date("2026-01-01T00:01:00Z"),
    });

    const res = await request(boardApp()).get(`/api/missions/${missionId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");

    const activities = await readMissionActivities(missionId);
    const reconciled = activities.find((entry) => entry.action === "mission.status_reconciled");
    expect(reconciled?.details).toMatchObject({
      previousStatus: "planning",
      nextStatus: "active",
      reason: "recoverable_failed_workflow_run",
    });
  });
});

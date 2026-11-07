import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueComments,
  issues,
  missionAgents,
  missionPlanArtifacts,
  missions,
  projects,
  type Db,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { missionRoutes } from "../routes/missions.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * [목적] mission 상세 조회 리팩터링(하위 라우트의 중복 getById 제거, 상세 쿼리 병렬화, owner-action
 *        댓글 배치)이 응답 JSON과 거부 규칙(400/404)을 바꾸지 않았음을 고정한다.
 * [배경] 2026-11-07 A1 실측: 상세 화면 1회 로드에 상세 쿼리가 두 번 실행됐고, owner-action 이슈마다
 *        댓글을 따로 조회했다. 배치로 바꾸면서 댓글이 다른 이슈에 붙으면 결정 표시가 잘못된다.
 * [방법] 소유자 결정 댓글을 이슈 A에만 넣고, A는 decision_recorded_read_only / B는 decision_required 인지
 *        확인한다(배치가 이슈별로 분리됐다는 증거). 각 하위 라우트의 응답 키와 400/404 본문도 함께 고정한다.
 */
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres mission detail route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Actor = { type: "board"; source: "session"; userId: string; companyIds: string[]; isInstanceAdmin?: boolean };

function createApp(db: Db, actor: Actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", missionRoutes(db));
  app.use(errorHandler);
  return app;
}

const OWNER_DECISION_COMMENT = [
  "### Mission owner decision",
  "Decision: retry_source_issue",
  "Reason: the source issue needs one more attempt.",
].join("\n");

describeEmbeddedPostgres("mission detail read routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mission-detail-routes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(missionPlanArtifacts);
    await db.delete(missionAgents);
    await db.delete(missions);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const memberAgentId = randomUUID();
    const projectId = randomUUID();
    const missionId = randomUUID();
    const sourceIssueId = randomUUID();
    const ownerActionWithDecisionId = randomUUID();
    const ownerActionWithoutDecisionId = randomUUID();
    const hiddenOwnerActionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Mission Detail",
      issuePrefix: `MD${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "ceo",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: memberAgentId,
        companyId,
        name: "Mission Executor",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(projects).values({ id: projectId, companyId, name: "Mission Project", color: "#123456" });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      projectId,
      title: "Read routes contract",
      status: "active",
    });
    await db.insert(missionAgents).values([
      { missionId, agentId: ownerAgentId, role: "reviewer" },
      { missionId, agentId: memberAgentId, role: "executor" },
    ]);
    await db.insert(missionPlanArtifacts).values({
      companyId,
      missionId,
      revision: 1,
      status: "active",
      ownerAgentId,
      missionGoal: "Ship the thing",
      steps: [{ title: "first step" }],
    });
    await db.insert(issues).values([
      { id: sourceIssueId, companyId, missionId, identifier: "MD-1", title: "Source issue", status: "todo" },
      {
        id: ownerActionWithDecisionId,
        companyId,
        missionId,
        identifier: "MD-2",
        title: "Owner action with decision",
        status: "todo",
        originKind: "mission_main_executor_unblock",
        originId: sourceIssueId,
      },
      {
        id: ownerActionWithoutDecisionId,
        companyId,
        missionId,
        identifier: "MD-3",
        title: "Owner action without decision",
        status: "todo",
        originKind: "mission_main_executor_unblock",
        originId: sourceIssueId,
      },
      {
        id: hiddenOwnerActionId,
        companyId,
        missionId,
        identifier: "MD-4",
        title: "Hidden owner action",
        status: "todo",
        originKind: "mission_main_executor_unblock",
        originId: sourceIssueId,
        hiddenAt: new Date(),
      },
    ]);
    const base = Date.parse("2026-11-07T00:00:00.000Z");
    await db.insert(issueComments).values([
      { companyId, issueId: ownerActionWithDecisionId, body: "queued", createdAt: new Date(base) },
      { companyId, issueId: ownerActionWithDecisionId, body: OWNER_DECISION_COMMENT, createdAt: new Date(base + 1_000) },
      { companyId, issueId: ownerActionWithoutDecisionId, body: "queued", createdAt: new Date(base + 2_000) },
      { companyId, issueId: hiddenOwnerActionId, body: OWNER_DECISION_COMMENT, createdAt: new Date(base + 3_000) },
    ]);

    return { companyId, missionId, ownerAgentId, memberAgentId, projectId, ownerActionWithDecisionId, ownerActionWithoutDecisionId };
  }

  it("returns the same detail projection and per-issue owner-action decisions", async () => {
    const seeded = await seed();
    const app = createApp(db, { type: "board", source: "session", userId: "operator", companyIds: [seeded.companyId] });

    const response = await request(app).get(`/api/missions/${seeded.missionId}`).expect(200);

    expect(response.body).toMatchObject({
      id: seeded.missionId,
      companyId: seeded.companyId,
      title: "Read routes contract",
      status: "active",
      ownerAgentName: "Mission Owner",
      project: { id: seeded.projectId, name: "Mission Project", color: "#123456" },
      activeMissionPlan: { available: true, revision: 1, status: "active", missionGoal: "Ship the thing" },
      sessionBindings: [],
    });
    expect(response.body.agents).toHaveLength(2);
    expect(response.body.agents.map((entry: { agentName?: string }) => entry.agentName).sort()).toEqual([
      "Mission Executor",
      "Mission Owner",
    ]);

    const explanations = response.body.ownerActionExplanations;
    expect(explanations).toHaveLength(2);
    const withDecision = explanations.find(
      (entry: { ownerActionIssue: { id: string } }) => entry.ownerActionIssue.id === seeded.ownerActionWithDecisionId,
    );
    const withoutDecision = explanations.find(
      (entry: { ownerActionIssue: { id: string } }) => entry.ownerActionIssue.id === seeded.ownerActionWithoutDecisionId,
    );
    expect(withDecision).toMatchObject({
      status: "decision_recorded_read_only",
      retryApplied: false,
      latestDecision: { decision: "retry_source_issue" },
    });
    expect(withoutDecision).toMatchObject({ status: "decision_required", retryApplied: false, latestDecision: null });
  });

  it("keeps sub-resource route payloads unchanged", async () => {
    const seeded = await seed();
    const app = createApp(db, { type: "board", source: "session", userId: "operator", companyIds: [seeded.companyId] });

    const workflowRuns = await request(app).get(`/api/missions/${seeded.missionId}/workflow-runs`).expect(200);
    expect(workflowRuns.body).toEqual([]);

    const missionAgentsResponse = await request(app).get(`/api/missions/${seeded.missionId}/agents`).expect(200);
    expect(missionAgentsResponse.body).toHaveLength(2);

    const issueTree = await request(app).get(`/api/missions/${seeded.missionId}/issues`).expect(200);
    expect(issueTree.body).toBeTypeOf("object");

    const decisionLog = await request(app).get(`/api/missions/${seeded.missionId}/decision-log`).expect(200);
    expect(decisionLog.body).toEqual({
      missionId: seeded.missionId,
      revision: 0,
      updatedAt: null,
      decisions: [],
      stateMarkdown: "",
    });

    const governanceThread = await request(app).get(`/api/missions/${seeded.missionId}/governance-thread`).expect(200);
    expect(governanceThread.body).toMatchObject({ missionId: seeded.missionId, companyId: seeded.companyId });
    expect(Array.isArray(governanceThread.body.events)).toBe(true);

    const runtimeSnapshot = await request(app).get(`/api/missions/${seeded.missionId}/runtime-snapshot`).expect(200);
    expect(runtimeSnapshot.body).toMatchObject({ missionId: seeded.missionId, companyId: seeded.companyId });
    expect(runtimeSnapshot.body.snapshot).toBeTypeOf("object");
  });

  it("keeps the invalid-id and missing-mission responses", async () => {
    const seeded = await seed();
    const app = createApp(db, { type: "board", source: "session", userId: "operator", companyIds: [seeded.companyId] });
    const missingId = randomUUID();

    const missing = await request(app).get(`/api/missions/${missingId}/workflow-runs`).expect(404);
    expect(missing.body).toEqual({ error: `Mission not found: ${missingId}` });

    const missingIssues = await request(app).get(`/api/missions/${missingId}/issues`).expect(404);
    expect(missingIssues.body).toEqual({ error: `Mission not found: ${missingId}` });

    for (const path of ["workflow-runs", "issues", "agents", "decision-log"]) {
      const invalid = await request(app).get(`/api/missions/not-a-uuid/${path}`).expect(400);
      expect(invalid.body).toEqual({ error: "Invalid mission id: not-a-uuid" });
    }
  });
});

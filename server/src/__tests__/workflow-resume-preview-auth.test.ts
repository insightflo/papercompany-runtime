import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { workflowResumeRequests, type Db } from "@paperclipai/db";
import { readResumeRequest } from "../services/workflow/resume/request-store.js";
import { publicRequestSchema } from "./helpers/workflow-resume-public-fixture.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { workflowRoutes } from "../routes/workflows.js";
import {
  PREVIEW_KEY_HEX,
  cleanupPreviewTables,
  seedPreviewGraph,
  seedPreviewResumeRequest,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
  type PreviewGraph,
} from "./helpers/workflow-resume-preview-fixture.js";

/**
 * [purpose] Task6a mounted GET route 테스트 — 실제 workflowRoutes 부모 라우터 아래
 *   workflowResumeRoutes mount 를 통한 실제 HTTP 경로 검증. auth(company access → board)가
 *   조회보다 먼저임(401/403/404), 서명 키 env 계약(누락/오작형 503 고정 resume_unavailable),
 *   strict query 파싱(400), 요청 readback 정확 스코프를 실제 임베디드 PostgreSQL 위에서 검증한다.
 */

const SIGNING_KEY_ENV = "PAPERCLIP_WORKFLOW_RESUME_SIGNING_KEY";
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestActor =
  | { type: "none" }
  | { type: "agent"; companyId: string; agentId: string }
  | { type: "board"; source: "local_implicit"; userId: string };

function createApp(db: Db, actor: TestActor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", workflowRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEP("workflow resume preview routes — mounted GET", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;
  let graph: PreviewGraph;
  let requestId: string;
  let executionId: string;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("resume-preview-auth-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = fixture.db;
    graph = await seedPreviewGraph(fixture.sql, db, {
      stepsJson: [{ id: "pv-complete-root", name: "Complete root", agentId: "", type: "complete", dependencies: [] }],
    });
    const seeded = await seedPreviewResumeRequest(db, {
      companyId: graph.companyId,
      missionId: graph.missionId,
      workflowRunId: graph.runId,
      withExecution: { state: "completed" },
    });
    requestId = seeded.requestId;
    executionId = seeded.executionId!;
    await db.update(workflowResumeRequests).set({ requestBody: {
      schemaVersion: 1, mode: "resume_from_step", companyId: graph.companyId, missionId: graph.missionId,
      workflowRunId: graph.runId, startStepId: "pv-complete-root", snapshotToken: "tok",
      reason: "preview-fixture", idempotencyKey: randomUUID(),
    } }).where(eq(workflowResumeRequests.id, requestId));
    process.env[SIGNING_KEY_ENV] = PREVIEW_KEY_HEX;
  }, 60_000);

  afterEach(async () => {
    process.env[SIGNING_KEY_ENV] = PREVIEW_KEY_HEX;
  });

  afterAll(async () => {
    delete process.env[SIGNING_KEY_ENV];
    if (fixture?.supported) await fixture.cleanup();
  });

  function previewPath(companyId = graph.companyId, missionId = graph.missionId): string {
    return `/api/companies/${companyId}/missions/${missionId}/workflow-resume-preview`;
  }
  function requestPath(companyId = graph.companyId, missionId = graph.missionId): string {
    return `/api/companies/${companyId}/missions/${missionId}/workflow-resume-requests/${requestId}`;
  }
  function previewQuery() {
    return { workflowRunId: graph.runId, startStepId: "pv-complete-root" };
  }

  it("unauthenticated actor gets 401 before any lookup", async () => {
    const response = await request(createApp(db, { type: "none" })).get(previewPath()).query(previewQuery());
    expect(response.status).toBe(401);
  });

  it("agent actor gets 403 (board access required)", async () => {
    const response = await request(createApp(db, {
      type: "agent", companyId: graph.companyId, agentId: graph.agentId,
    })).get(previewPath()).query(previewQuery());
    expect(response.status).toBe(403);
  });

  it("cross-company scope returns 404 — no existence leak", async () => {
    const response = await request(createApp(db, {
      type: "board", source: "local_implicit", userId: "board-user",
    })).get(previewPath("11111111-1111-4111-8111-111111111111", graph.missionId)).query(previewQuery());
    expect(response.status).toBe(404);
    const requestMiss = await request(createApp(db, {
      type: "board", source: "local_implicit", userId: "board-user",
    })).get(requestPath("11111111-1111-4111-8111-111111111111"));
    expect(requestMiss.status).toBe(404);
  });

  it("missing or malformed signing key returns fixed 503 resume_unavailable", async () => {
    delete process.env[SIGNING_KEY_ENV];
    const missing = await request(createApp(db, {
      type: "board", source: "local_implicit", userId: "board-user",
    })).get(previewPath()).query(previewQuery());
    expect(missing.status).toBe(503);
    expect(missing.body.error).toBe("resume_unavailable");
    process.env[SIGNING_KEY_ENV] = "NOT-HEX";
    const malformed = await request(createApp(db, {
      type: "board", source: "local_implicit", userId: "board-user",
    })).get(previewPath()).query(previewQuery());
    expect(malformed.status).toBe(503);
    expect(malformed.body.error).toBe("resume_unavailable");
  });

  it("strict query and path validation reject bad input with 400", async () => {
    const app = createApp(db, { type: "board", source: "local_implicit", userId: "board-user" });
    expect((await request(app).get(previewPath())).status).toBe(400);
    expect((await request(app).get(previewPath()).query({ ...previewQuery(), foo: "bar" })).status).toBe(400);
    expect((await request(app).get(previewPath()).query({ ...previewQuery(), startStepId: ["a", "b"] })).status).toBe(400);
    expect((await request(app).get(previewPath()).query({ ...previewQuery(), workflowRunId: "not-a-uuid" })).status).toBe(400);
    expect((await request(app).get(previewPath("not-a-uuid"))).status).toBe(400);
  });

  it("mounted preview GET returns real blocked preview (empty reviewed registry)", async () => {
    const response = await request(createApp(db, {
      type: "board", source: "local_implicit", userId: "board-user",
    })).get(previewPath()).query(previewQuery());
    expect(response.status).toBe(200);
    expect(response.body.schemaVersion).toBe(1);
    expect(response.body.workflowRunId).toBe(graph.runId);
    expect(response.body.eligible).toBe(false);
    expect(response.body.blockers.map((blocker: { code: string }) => blocker.code)).toContain("external_effect_unknown");
    expect(response.body.snapshotToken).toBeNull();
  });

  it("request readback returns exact scoped row (execution asserted below) without signing key", async () => {
    delete process.env[SIGNING_KEY_ENV];
    const app = createApp(db, { type: "board", source: "local_implicit", userId: "board-user" });
    const response = await request(app).get(requestPath());
    expect(response.status).toBe(200);
    expect(publicRequestSchema.parse(response.body)).toMatchObject({
      id: requestId, workflowRunId: graph.runId, startStepId: "pv-complete-root",
      state: "pending_delivery", acceptanceId: executionId,
    });
    const internal = await readResumeRequest(db, { ...graph, requestId });
    expect(internal).toMatchObject({ companyId: graph.companyId, missionId: graph.missionId, deliveryAttempts: 0 });
    expect(internal.requestBody).toMatchObject({ snapshotToken: "tok", reason: "preview-fixture" });
    expect(internal.appliedGenerations).toEqual({ "step-1": 1 });
    expect(typeof response.body.createdAt).toBe("string");
    expect(new Date(response.body.createdAt).toISOString()).toBe(response.body.createdAt);
  });

  it("request readback includes scoped execution when present", async () => {
    const app = createApp(db, { type: "board", source: "local_implicit", userId: "board-user" });
    const response = await request(app).get(requestPath());
    expect(response.status).toBe(200);
    expect(response.body.acceptanceId).toBe(executionId);
    const internal = await readResumeRequest(db, { ...graph, requestId });
    expect(internal.execution).toMatchObject({
      id: executionId,
      state: "completed",
      authorityVersion: 3,
      attempts: 0,
    });
    expect(internal.execution!.generations).toEqual({ "step-1": 2 });
  });
});

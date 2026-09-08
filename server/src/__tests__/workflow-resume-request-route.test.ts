import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { workflowResumeExecutions, workflowResumeRequests } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import {
  countApplyIssues,
  loadApplyRequestRows,
  loadApplyRunRow,
  resetReviewedPolicies,
  resumeApplyBody,
  seedResumeApplyScenario,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
  type RawSql,
  type ResumeApplyScenario,
} from "./helpers/workflow-resume-apply-fixture.js";
import { errorHandler } from "../middleware/index.js";
import { workflowRoutes } from "../routes/workflows.js";
import { dispatchAcceptedResumeWork } from "../services/workflow/resume/dispatcher.js";
import { readResumeRequest } from "../services/workflow/resume/request-store.js";
import { publicRequestSchema } from "./helpers/workflow-resume-public-fixture.js";

/**
 * [purpose] Task6c mounted POST route 테스트 — 실제 workflowRoutes 부모 라우터 아래
 *   workflowResumeRoutes mount 를 통한 실제 HTTP 경로 검증. apply fixture 체인(seed →
 *   previewResume 실제 서명 token → exact UI body POST)으로 201 happy path/replay-first
 *   idempotency, auth 전치(401/403), strict body 400, 서명 키 env 계약(누락/오작형 503
 *   resume_unavailable), cross-scope readback 404, dispatcher 인수(accepted + 실행 완료 +
 *   run 유지 + 신규 run 없음)를 실제 임베디드 PostgreSQL 위에서 검증한다. 외부 effect(agent
 *   wakeup)와 reviewed-policy manifest 만 모듈 경계 mock 이고, DB/engine/queue 는 실제다.
 */

const { heartbeatWakeup } = vi.hoisted(() => ({ heartbeatWakeup: vi.fn() }));
vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return { ...actual, heartbeatService: () => ({ wakeup: heartbeatWakeup }) };
});
vi.mock("../services/issue-assignment-wakeup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issue-assignment-wakeup.js")>();
  return {
    ...actual,
    queueIssueAssignmentWakeup: (input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0]) =>
      actual.queueIssueAssignmentWakeup({ ...input, heartbeat: { wakeup: heartbeatWakeup } }),
  };
});
vi.mock("../services/workflow/resume/reviewed-policy.js", async () => {
  const helper = await import("./helpers/workflow-resume-apply-fixture.js");
  return { REVIEWED_RESUME_POLICIES: helper.TEST_REVIEWED_POLICIES };
});

const SIGNING_KEY_ENV = "PAPERCLIP_WORKFLOW_RESUME_SIGNING_KEY";
const SIGNING_KEY_HEX = "ab".repeat(32);
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping resume request route tests: ${embeddedPostgresSupport.reason ?? "unsupported host"}`);
}

type TestActor =
  | { type: "none" }
  | { type: "agent"; companyId: string }
  | { type: "board"; source: "local_implicit"; userId: string }
  | { type: "board"; source: "session"; userId: string; companyIds: string[] };

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

describeEP("workflow resume request route — mounted POST", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;
  let sql: RawSql;
  const boardApp = () => createApp(db, { type: "board", source: "local_implicit", userId: "board-user" });

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("resume-request-route-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = fixture.db;
    sql = fixture.sql;
    process.env[SIGNING_KEY_ENV] = SIGNING_KEY_HEX;
  }, 60_000);
  beforeEach(async () => {
    resetReviewedPolicies();
    // [격리] 이전 테스트의 미종결 resume 행이 전역 dispatch 패스에 걸리지 않게 무력화(테스트 전용).
    await db.update(workflowResumeExecutions).set({
      state: "cancelled", code: "mission_cancelled", leaseOwner: null, leaseUntil: null,
    }).where(inArray(workflowResumeExecutions.state, ["queued", "running"]));
    await db.update(workflowResumeRequests).set({
      state: "blocked", code: "scope_changed", leaseOwner: null, leaseUntil: null,
    }).where(eq(workflowResumeRequests.state, "pending_delivery"));
  });
  afterEach(() => {
    process.env[SIGNING_KEY_ENV] = SIGNING_KEY_HEX;
    heartbeatWakeup.mockReset();
  });
  afterAll(async () => {
    delete process.env[SIGNING_KEY_ENV];
    if (fixture?.supported) await fixture.cleanup();
  });

  async function eligibleToken(scenario: ResumeApplyScenario): Promise<string> {
    const response = await request(boardApp())
      .get(`/api/companies/${scenario.companyId}/missions/${scenario.missionId}/workflow-resume-preview`)
      .query({ workflowRunId: scenario.runId, startStepId: "gate" });
    expect(response.status).toBe(200);
    expect(response.body.eligible).toBe(true);
    expect(typeof response.body.snapshotToken).toBe("string");
    return response.body.snapshotToken;
  }
  /** accepted apply fixture 체인 — 실제 시딩 + 실제 preview token 으로 exact UI body 를 만든다. */
  async function seedEligible(prefix: string) {
    const scenario = await seedResumeApplyScenario(db, sql, prefix);
    const body = resumeApplyBody(scenario, { token: await eligibleToken(scenario), reason: "route test" });
    return { scenario, body };
  }
  function postPath(companyId: string, missionId: string): string {
    return `/api/companies/${companyId}/missions/${missionId}/workflow-resume-requests`;
  }
  function requestPath(companyId: string, missionId: string, requestId: string): string {
    return `/api/companies/${companyId}/missions/${missionId}/workflow-resume-requests/${requestId}`;
  }
  async function seedAndPost(prefix: string) {
    const seeded = await seedEligible(prefix);
    const response = await request(boardApp())
      .post(postPath(seeded.scenario.companyId, seeded.scenario.missionId))
      .send(seeded.body);
    return { ...seeded, response };
  }

  it("POST eligible request → 201 pending_delivery view + scoped readback, cross-scope 404", async () => {
    const { scenario, body, response } = await seedAndPost("rr-ok-");
    expect(response.status).toBe(201);
    const view = publicRequestSchema.parse(response.body);
    expect(view).toMatchObject({
      workflowRunId: scenario.runId, startStepId: "gate",
      state: "pending_delivery", code: null, acceptanceId: null,
    });
    const internal = await readResumeRequest(db, { ...scenario, requestId: view.id });
    expect(internal).toMatchObject({ companyId: scenario.companyId, missionId: scenario.missionId,
      deliveryAttempts: 0, execution: null });
    expect(internal.requestBody).toEqual(body);
    const readback = await request(boardApp()).get(requestPath(scenario.companyId, scenario.missionId, view.id));
    expect(readback.status).toBe(200);
    expect(publicRequestSchema.parse(readback.body)).toEqual(view);
    expect(internal.idempotencyKey).toBe(body.idempotencyKey);
    const crossScope = await request(boardApp()).get(requestPath(randomUUID(), scenario.missionId, view.id));
    expect(crossScope.status).toBe(404);
    expect(await loadApplyRequestRows(sql, scenario.runId)).toHaveLength(1);
  });

  it("replay same idempotencyKey+body → 201 same id (apply contract, not 409)", async () => {
    const { scenario, body, response } = await seedAndPost("rr-replay-");
    expect(response.status).toBe(201);
    const replay = await request(boardApp())
      .post(postPath(scenario.companyId, scenario.missionId))
      .send(body);
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(response.body.id);
    expect(await loadApplyRequestRows(sql, scenario.runId)).toHaveLength(1);
  });

  it("agent actor 403, no actor 401, cross-company board 403 — auth precedes apply", async () => {
    const { scenario, body } = await seedEligible("rr-auth-");
    const path = postPath(scenario.companyId, scenario.missionId);
    const agent = await request(createApp(db, { type: "agent", companyId: scenario.companyId })).post(path).send(body);
    expect(agent.status).toBe(403);
    const none = await request(createApp(db, { type: "none" })).post(path).send(body);
    expect(none.status).toBe(401);
    const cross = await request(createApp(db, {
      type: "board", source: "session", userId: "board-user", companyIds: [randomUUID()],
    })).post(path).send(body);
    expect(cross.status).toBe(403);
    expect(await loadApplyRequestRows(sql, scenario.runId)).toHaveLength(0);
  });

  it("invalid body — extra field or bad uuid → 400, zero writes", async () => {
    const { scenario, body } = await seedEligible("rr-invalid-");
    const path = postPath(scenario.companyId, scenario.missionId);
    const extra = await request(boardApp()).post(path).send({ ...body, resetStepIds: ["gate"] });
    expect(extra.status).toBe(400);
    expect(extra.body.error).toBe("Validation error");
    const badUuid = await request(boardApp()).post(path).send({ ...body, workflowRunId: "not-a-uuid" });
    expect(badUuid.status).toBe(400);
    const badPathUuid = await request(boardApp()).post(postPath("not-a-uuid", scenario.missionId)).send(body);
    expect(badPathUuid.status).toBe(400);
    expect(await loadApplyRequestRows(sql, scenario.runId)).toHaveLength(0);
  });

  it("missing/malformed signing key → fixed 503 resume_unavailable", async () => {
    const { scenario, body } = await seedEligible("rr-key-");
    const path = postPath(scenario.companyId, scenario.missionId);
    try {
      delete process.env[SIGNING_KEY_ENV];
      const missing = await request(boardApp()).post(path).send(body);
      expect(missing.status).toBe(503);
      expect(missing.body.error).toBe("resume_unavailable");
      process.env[SIGNING_KEY_ENV] = "NOT-HEX";
      const malformed = await request(boardApp()).post(path).send(body);
      expect(malformed.status).toBe(503);
      expect(malformed.body.error).toBe("resume_unavailable");
    } finally {
      process.env[SIGNING_KEY_ENV] = SIGNING_KEY_HEX;
    }
    expect(await loadApplyRequestRows(sql, scenario.runId)).toHaveLength(0);
  });

  it("dispatcher picks up the route-created request: accepted + execution completed + run stays running", async () => {
    const { scenario, response } = await seedAndPost("rr-dispatch-");
    expect(response.status).toBe(201);
    const result = await dispatchAcceptedResumeWork(db, { now: new Date(Date.now() + 60_000) });
    expect(result).toMatchObject({ acceptedCount: 1, completedCount: 1 });
    expect(result.blockedCount + result.cancelledCount + result.failedCount + result.skippedCount).toBe(0);
    const readback = await request(boardApp())
      .get(requestPath(scenario.companyId, scenario.missionId, response.body.id));
    expect(readback.status).toBe(200);
    const publicView = publicRequestSchema.parse(readback.body);
    const internal = await readResumeRequest(db, { ...scenario, requestId: response.body.id });
    expect(publicView).toMatchObject({ id: response.body.id, startStepId: "gate", state: "accepted",
      code: null, acceptanceId: internal.execution!.id });
    expect(internal.deliveryAttempts).toBe(1);
    expect(internal.acceptedAt).toBeTruthy();
    expect(internal.execution).toMatchObject({ state: "completed", attempts: 1, authorityVersion: 6, code: null });
    expect(internal.execution!.generations).toEqual(internal.appliedGenerations);
    const run = await loadApplyRunRow(sql, scenario.runId);
    expect(run).toMatchObject({ status: "running", dispatch_authority_version: 6 });
    const runs = await sql`SELECT count(*)::int AS c FROM workflow_runs WHERE company_id = ${scenario.companyId}`;
    expect((runs[0] as { c: number }).c).toBe(1);
    expect(await countApplyIssues(sql, scenario.companyId)).toBe(0);
  });
});

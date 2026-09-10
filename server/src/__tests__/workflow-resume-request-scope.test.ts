import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import {
  resetReviewedPolicies, resumeApplyBody, seedResumeApplyScenario, startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture, type RawSql, type ResumeApplyScenario,
} from "./helpers/workflow-resume-apply-fixture.js";
import { errorHandler } from "../middleware/index.js";
import { workflowRoutes } from "../routes/workflows.js";
import { previewResume } from "../services/workflow/resume/preview.js";
import { readResumeRequest } from "../services/workflow/resume/request-store.js";

/** Mounted URL/body identity regressions: real auth, signed preview, apply and isolated PostgreSQL.
 * Only the reviewed-policy manifest and external heartbeat boundary are mocked.
 * Canonical snapshots include every row/field in the six mutation tables for both companies.
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

const KEY_ENV = "PAPERCLIP_WORKFLOW_RESUME_SIGNING_KEY";
const KEY_HEX = "ab".repeat(32);
const originalKey = process.env[KEY_ENV];
const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping resume request scope tests: ${support.reason}`);

type Actor = Express.Request["actor"];
function createApp(db: Db, actor: Actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.actor = actor; next(); });
  app.use("/api", workflowRoutes(db));
  app.use(errorHandler);
  return app;
}
function postPath(scope: { companyId: string; missionId: string }) {
  return `/api/companies/${scope.companyId}/missions/${scope.missionId}/workflow-resume-requests`;
}
function sessionBoard(companyIds: string[]): Actor {
  return { type: "board", source: "session", userId: "scope-board", companyIds, isInstanceAdmin: false };
}
const localBoard: Actor = { type: "board", source: "local_implicit", userId: "scope-board" };

describeEP("workflow resume POST URL/body scope binding", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;
  let sql: RawSql;
  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("resume-request-scope-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = fixture.db;
    sql = fixture.sql;
  }, 60_000);
  beforeEach(() => {
    resetReviewedPolicies();
    process.env[KEY_ENV] = KEY_HEX;
  });
  afterEach(() => {
    process.env[KEY_ENV] = KEY_HEX;
    heartbeatWakeup.mockReset();
  });
  afterAll(async () => {
    if (originalKey === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = originalKey;
    if (fixture?.supported) await fixture.cleanup();
  });

  async function signedBody(scenario: ResumeApplyScenario) {
    const result = await previewResume(db, {
      companyId: scenario.companyId, missionId: scenario.missionId,
      workflowRunId: scenario.runId, startStepId: "gate",
    }, { key: Buffer.from(KEY_HEX, "hex"), now: () => new Date() });
    expect(result.preview.eligible).toBe(true);
    expect(result.preview.token).toBeTruthy();
    return resumeApplyBody(scenario, { token: result.preview.token!, reason: "route scope regression" });
  }
  async function seedPair(sameCompany = false) {
    const prefix = `rs-${randomUUID().slice(0, 8)}`;
    const a = await seedResumeApplyScenario(db, sql, `${prefix}-a`);
    // Pass only company/agent, not a.missionId: the real fixture inserts a second FK-valid mission.
    const b = await seedResumeApplyScenario(db, sql, `${prefix}-b`, sameCompany
      ? { base: { companyId: a.companyId, agentId: a.agentId } } : {});
    expect(b.missionId).not.toBe(a.missionId);
    expect(b.companyId === a.companyId).toBe(sameCompany);
    return { a, b, body: await signedBody(b), companyIds: [...new Set([a.companyId, b.companyId])] };
  }
  async function canonical(companyIds: string[]) {
    const state: Record<string, unknown> = {};
    for (const table of ["workflow_runs", "missions", "workflow_resume_requests", "workflow_resume_executions", "activity_log"]) {
      state[table] = Array.from(await sql`
        SELECT to_jsonb(t) AS row FROM ${sql(table)} t
        WHERE company_id IN ${sql(companyIds)} ORDER BY id
      `);
    }
    state.workflow_step_runs = Array.from(await sql`
      SELECT to_jsonb(s) AS row FROM workflow_step_runs s
      JOIN workflow_runs r ON r.id = s.workflow_run_id
      WHERE r.company_id IN ${sql(companyIds)} ORDER BY s.id
    `);
    return state;
  }

  for (const variant of ["same-company mission", "both-company session", "local implicit", "company only"] as const) {
    it.each(["valid", "missing", "malformed"] as const)(`${variant} mismatch rejects before apply/signer (%s key)`, async (key) => {
      const { a, b, body, companyIds } = await seedPair(variant === "same-company mission");
      const actor = variant === "local implicit" ? localBoard : sessionBoard(companyIds);
      const urlScope = variant === "company only" ? { companyId: a.companyId, missionId: b.missionId } : a;
      const baseline = await canonical(companyIds);
      if (key === "missing") delete process.env[KEY_ENV];
      if (key === "malformed") process.env[KEY_ENV] = "NOT-HEX";
      const response = await request(createApp(db, actor)).post(postPath(urlScope)).send(body);
      expect.soft(response.status).toBe(400);
      expect.soft(response.body.error).toBe("scope_mismatch");
      expect(await canonical(companyIds)).toEqual(baseline);
    });
  }

  it("exact-body replay through another URL is 400, with no added request/reset/execution/audit", async () => {
    const { a, b, body, companyIds } = await seedPair();
    const app = createApp(db, sessionBoard(companyIds));
    const beforeCreate = await canonical(companyIds);
    const created = await request(app).post(postPath(b)).send(body);
    expect(created.status).toBe(201);
    const baseline = await canonical(companyIds);
    expect(baseline).not.toEqual(beforeCreate);
    expect(baseline.workflow_resume_requests).toHaveLength(1);
    expect(baseline.activity_log).not.toEqual(beforeCreate.activity_log);
    const replay = await request(app).post(postPath(a)).send(body);
    expect.soft(replay.status).toBe(400);
    expect.soft(replay.body.error).toBe("scope_mismatch");
    expect(await canonical(companyIds)).toEqual(baseline);
  });

  it.each(["none", "agent", "denied company"] as const)("%s is rejected before scope/body validation", async (kind) => {
    const { a, b, body, companyIds } = await seedPair();
    const actor: Actor = kind === "none" ? { type: "none" }
      : kind === "agent" ? { type: "agent", companyId: a.companyId, agentId: a.agentId, source: "agent_key" }
        : sessionBoard([b.companyId]);
    const app = createApp(db, actor);
    const baseline = await canonical(companyIds);
    delete process.env[KEY_ENV];
    for (const payload of [body, { ...body, unexpected: true }]) {
      const response = await request(app).post(postPath(a)).send(payload);
      expect(response.status).toBe(kind === "none" ? 401 : 403);
      expect(response.body.error).not.toBe("scope_mismatch");
      expect(await canonical(companyIds)).toEqual(baseline);
    }
  });

  it("exact match stays 201 with scoped readback; malformed body stays 400 without writes", async () => {
    const { a, b, body, companyIds } = await seedPair();
    const app = createApp(db, sessionBoard(companyIds));
    const baseline = await canonical(companyIds);
    for (const payload of [{ ...body, unexpected: true }, { ...body, workflowRunId: "not-a-uuid" }]) {
      const malformed = await request(app).post(postPath(b)).send(payload);
      expect(malformed.status).toBe(400);
      expect(malformed.body.error).toBe("Validation error");
      expect(await canonical(companyIds)).toEqual(baseline);
    }
    const created = await request(app).post(postPath(b)).send(body);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ workflowRunId: b.runId, startStepId: body.startStepId,
      state: "pending_delivery", acceptanceId: null });
    const internal = await readResumeRequest(db, { ...b, requestId: created.body.id });
    expect(internal).toMatchObject({ companyId: b.companyId, missionId: b.missionId, state: "pending_delivery" });
    expect(internal.requestBody).toEqual(body);
    const afterCreate = await canonical(companyIds);
    expect(afterCreate.workflow_resume_requests).toHaveLength(1);
    delete process.env[KEY_ENV];
    const readback = await request(app).get(`${postPath(b)}/${created.body.id}`);
    expect(readback.status).toBe(200);
    expect(readback.body).toEqual(created.body);
    expect((await request(app).get(`${postPath(a)}/${created.body.id}`)).status).toBe(404);
    expect(await canonical(companyIds)).toEqual(afterCreate);
  });
});

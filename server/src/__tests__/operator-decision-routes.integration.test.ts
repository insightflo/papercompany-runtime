import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, issues, operatorDecisionContinuations, operatorDecisions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { operatorDecisionRoutes } from "../routes/operator-decisions.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const definition = {
  options: [],
  actions: [
    { id: "hold", label: "Hold", outcome: "hold", tone: "neutral", requiresSelection: false },
    { id: "reject", label: "Reject", outcome: "reject", tone: "danger", requiresSelection: false },
  ],
  selection: null,
  comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 },
  approvedScope: [],
  forbiddenScope: [],
  humanReview: {
    schemaVersion: "human-review-v1" as const,
    decisionSubject: "Hold or reject this work?",
    evidence: [{ label: "Decision request", href: "/operator-decisions/fixture", location: "Decision fixture > request" }],
    interpretation: "The operator is choosing whether this fixture work should remain stopped.",
    impact: { ifApproved: "The selected action is recorded.", ifRejected: "The alternate action is recorded.", ifWrong: "The wrong work state could be retained." },
    unresolvedFacts: [],
    questions: ["Does the requested action match the linked work?"],
    recommendedNextStep: "Review the request and choose one action.",
    requiredReviewer: "Human Operator",
  },
};

function body(requestKey: string) {
  return {
    schemaVersion: 1,
    requestKey,
    priority: "medium",
    interactionType: "action",
    title: "Hold work?",
    description: "",
    sourceType: "system",
    sourceId: "fixture",
    sourceContext: { missionId: null, workflowId: null, workflowRunId: null, artifactRefs: [] },
    definition,
    issueId: null,
    continuationMode: "none",
  };
}

describeDb("operator decision routes", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let issueId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("operator-decision-routes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  beforeEach(async () => {
    await db.delete(activityLog);
    await db.delete(operatorDecisionContinuations);
    await db.delete(operatorDecisions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Routes", issuePrefix: `D${companyId.slice(0, 4)}` });
    agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Requester" });
    issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Task", assigneeAgentId: agentId });
  });

  function app(actor: "board" | "agent" | "none" = "board") {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = actor === "board"
        ? { type: "board", userId: "board-user", companyIds: [], source: "local_implicit", isInstanceAdmin: true }
        : actor === "agent"
          ? { type: "agent", agentId, companyId, runId: null }
          : { type: "none" };
      next();
    });
    server.use("/api", operatorDecisionRoutes(db));
    server.use(errorHandler);
    return server;
  }

  it("returns exact create and idempotent replay envelopes", async () => {
    const first = await request(app("agent")).post(`/api/companies/${companyId}/operator-decisions`).send(body("route-create"));
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ replayed: false, data: { requestedBy: { type: "agent", id: agentId } } });
    const replay = await request(app("agent")).post(`/api/companies/${companyId}/operator-decisions`).send(body("route-create"));
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, data: { id: first.body.data.id } });
  });

  it("rejects omitted nullable keys, unknown keys, and invalid query keys", async () => {
    const invalid = { ...body("invalid"), actorId: "spoof" } as Record<string, unknown>;
    delete invalid.issueId;
    expect((await request(app()).post(`/api/companies/${companyId}/operator-decisions`).send(invalid)).body)
      .toMatchObject({ error: "Validation error", details: expect.any(Array) });
    const query = await request(app()).get(`/api/companies/${companyId}/operator-decisions?unknown=yes`);
    expect(query.status).toBe(400);
    expect(query.body).toMatchObject({ error: "Validation error" });
  });

  it("derives board actor and action outcome on resolve", async () => {
    const created = await request(app("agent")).post(`/api/companies/${companyId}/operator-decisions`).send(body("resolve"));
    const resolved = await request(app()).post(`/api/operator-decisions/${created.body.data.id}/resolve`).send({
      actionId: "hold", selectedOptionIds: [], comment: null,
    });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(resolved.body.data).toMatchObject({ applied: true, decision: { resolvedByUserId: "board-user", result: { outcome: "hold" } }, continuation: null });
  });

  it("enforces board-only list and resolution while allowing requester detail/cancel", async () => {
    const created = await request(app("agent")).post(`/api/companies/${companyId}/operator-decisions`).send(body("auth"));
    expect((await request(app("agent")).get(`/api/companies/${companyId}/operator-decisions`)).status).toBe(403);
    expect((await request(app("agent")).post(`/api/operator-decisions/${created.body.data.id}/resolve`).send({ actionId: "hold", selectedOptionIds: [], comment: null })).status).toBe(403);
    expect((await request(app("agent")).get(`/api/operator-decisions/${created.body.data.id}`)).status).toBe(200);
    const cancelled = await request(app("agent")).post(`/api/operator-decisions/${created.body.data.id}/cancel`).send({});
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data).toMatchObject({ applied: true, decision: { status: "cancelled" } });
  });

  it("returns 409 for a different terminal result", async () => {
    const created = await request(app()).post(`/api/companies/${companyId}/operator-decisions`).send(body("conflict"));
    await request(app()).post(`/api/operator-decisions/${created.body.data.id}/resolve`).send({ actionId: "hold", selectedOptionIds: [], comment: null });
    const conflict = await request(app()).post(`/api/operator-decisions/${created.body.data.id}/resolve`).send({ actionId: "reject", selectedOptionIds: [], comment: null });
    expect(conflict.status).toBe(409);
  });

  it("exposes board-only exact retry envelope", async () => {
    const linked = { ...body("retry-route"), issueId, continuationMode: "issue_current_assignee" };
    const created = await request(app("agent"))
      .post(`/api/companies/${companyId}/operator-decisions`)
      .send(linked);
    await request(app()).post(`/api/operator-decisions/${created.body.data.id}/resolve`).send({
      actionId: "hold", selectedOptionIds: [], comment: null,
    });
    await db.update(operatorDecisionContinuations).set({
      state: "exhausted", attemptCount: 3, errorCode: "attempts_exhausted",
    });
    expect((await request(app("agent"))
      .post(`/api/operator-decisions/${created.body.data.id}/retry-continuation`)
      .send({})).status).toBe(403);
    const retried = await request(app())
      .post(`/api/operator-decisions/${created.body.data.id}/retry-continuation`)
      .send({});
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.data).toMatchObject({
      applied: true,
      continuation: { state: "pending", generation: 2, manualRetryCount: 1, attemptCount: 0 },
    });
  });
});

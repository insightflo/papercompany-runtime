// C08 adopted plan:38–118,216. Expectations come from the public current-request contract:
// GET never writes; POST keeps 201/audit/guards; current identity never falls back to old history.
// Successful requests/cards/continuations below are produced by their actual existing writers.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MissionOwnerDecisionSubmit } from "@paperclipai/shared";
import { activityLog, agents, agentWakeupRequests, companies, createDb, heartbeatRuns,
  issueComments, issues, missions, operatorDecisions, operatorDecisionContinuations,
  workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { workflowAgentApiRoutes } from "../routes/workflow-agent-api.js";
import { errorHandler } from "../middleware/index.js";
import { submitMissionOwnerDecision } from "../services/missions/mission-owner-recovery-agent-api.js";
import { readOwnerHumanRequest } from "../services/missions/owner-human-request-read.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
import { publishLiveEvent } from "../services/live-events.js";

vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
type World = { companyId: string; missionId: string; agentId: string; sourceId: string;
  issueId: string; runId: string; oldRunId: string };
const keyed = (requestKey = "A", expectedCurrentLifetimeId: string | null = null,
  reason = "原文 A"): MissionOwnerDecisionSubmit => ({ decision: "request_input", reason,
  nextAction: "사람 확인", evidence: "원천 근거",
  humanRequest: { schemaVersion: 1, requestKey, expectedCurrentLifetimeId } });

describeDb("C08 actual current-request HTTP routes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("c08-owner-routes-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await database?.cleanup(); });
  async function world(oversight = false): Promise<World> {
    const w = { companyId: randomUUID(), missionId: randomUUID(), agentId: randomUUID(),
      sourceId: randomUUID(), issueId: randomUUID(), runId: randomUUID(), oldRunId: randomUUID() };
    await db.insert(companies).values({ id: w.companyId, name: "C08 routes", issuePrefix: randomUUID() });
    await db.insert(agents).values({ id: w.agentId, companyId: w.companyId, name: "Owner", status: "active" });
    await db.insert(missions).values({ id: w.missionId, companyId: w.companyId,
      ownerAgentId: w.agentId, title: "C08 routes", status: "active" });
    await db.insert(issues).values([
      { id: w.sourceId, companyId: w.companyId, missionId: w.missionId, title: "Source", status: "blocked" },
      { id: w.issueId, companyId: w.companyId, missionId: w.missionId, title: "Owner action",
        status: "in_progress", assigneeAgentId: w.agentId,
        originKind: oversight ? "mission_main_executor_oversight" : "mission_main_executor_unblock",
        originId: oversight ? null : w.sourceId },
    ]);
    await db.insert(heartbeatRuns).values([w.oldRunId, w.runId].map((id) => ({ id,
      companyId: w.companyId, agentId: w.agentId, issueId: w.issueId,
      status: id === w.runId ? "running" : "succeeded" })));
    await db.update(issues).set({ checkoutRunId: w.oldRunId }).where(eq(issues.id, w.issueId));
    return w;
  }
  function app(w: World, liaison = false) {
    const server = express(); server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = { type: "agent", agentId: w.agentId, companyId: w.companyId, runId: w.runId,
        isHermesOpsLiaison: liaison, hermesOpsMode: "advisor" }; next();
    });
    server.use("/api", workflowAgentApiRoutes(db)); server.use(errorHandler); return server;
  }
  const url = (w: World) => `/api/issues/${w.issueId}/owner-recovery/decision`;
  const post = (w: World, data = keyed()) => request(app(w)).post(url(w)).send(data);
  const events = (w: World) => db.select().from(workflowTransitionEvents)
    .where(eq(workflowTransitionEvents.companyId, w.companyId)).orderBy(workflowTransitionEvents.id);
  const snapshot = (w: World) => Promise.all([
    events(w), db.select().from(issues).where(eq(issues.companyId, w.companyId)).orderBy(issues.id),
    db.select().from(missions).where(eq(missions.companyId, w.companyId)).orderBy(missions.id),
    db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, w.companyId)).orderBy(heartbeatRuns.id),
    db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, w.companyId)).orderBy(operatorDecisions.id),
    db.select().from(operatorDecisionContinuations).where(eq(operatorDecisionContinuations.companyId, w.companyId))
      .orderBy(operatorDecisionContinuations.id),
    db.select().from(activityLog).where(eq(activityLog.companyId, w.companyId)).orderBy(activityLog.id),
    db.select().from(issueComments).where(eq(issueComments.companyId, w.companyId)).orderBy(issueComments.id),
    db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, w.companyId)).orderBy(agentWakeupRequests.id),
    db.select().from(workflowRuns).where(eq(workflowRuns.companyId, w.companyId)).orderBy(workflowRuns.id),
    db.select().from(workflowStepRuns).orderBy(workflowStepRuns.id),
  ]);
  async function get(w: World, status = 200, caller = w) {
    const before = await snapshot(w), emitted = vi.mocked(publishLiveEvent).mock.calls.length;
    const response = await request(app(caller)).get(`${url(w)}/current`);
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    expect(await snapshot(w)).toEqual(before);
    expect(vi.mocked(publishLiveEvent).mock.calls).toHaveLength(emitted);
    return response.body;
  }

  it("returns no current request without adopting stale checkout or writing anything", async () => {
    const w = await world();
    expect(await get(w)).toMatchObject({ lifetimeId: null, requestKey: null,
      anchorIssueId: w.issueId, recoveryNeeded: false, card: null, delivery: null, resubmit: null });
    expect((await db.select().from(issues).where(eq(issues.id, w.issueId)))[0]!.checkoutRunId).toBe(w.oldRunId);
  });

  it("POST preserves 201/original fields/audit and exposes the exact current replay envelope", async () => {
    const w = await world(), body = keyed("original-key");
    const first = await post(w, body); expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ decision: "request_input", humanRequest: {
      schemaVersion: 1, requestKey: "original-key", expectedCurrentLifetimeId: first.body.lifetimeId } });
    expect(first.body.createdAt).toEqual(expect.any(String));
    expect(first.body.operatorDecisionId).toEqual(expect.any(String));
    const current = await get(w);
    expect(current).toMatchObject({ lifetimeId: first.body.lifetimeId, requestKey: "original-key",
      anchorIssueId: w.issueId, recoveryNeeded: true, delivery: null,
      card: { id: first.body.operatorDecisionId, sourceId: first.body.eventId, status: "pending" },
      resubmit: { ...body, humanRequest: first.body.humanRequest } });
    const replay = await post(w, current.resubmit); expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    const audit = (await db.select().from(activityLog).where(eq(activityLog.companyId, w.companyId)))
      .filter((row) => row.action === "issue.owner_recovery_decision_submitted");
    expect(audit).toHaveLength(2);
    expect(audit.every((row) => row.entityId === w.issueId)).toBe(true);
    const next = { ...w, runId: randomUUID() };
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, w.runId));
    await db.insert(heartbeatRuns).values({ id: next.runId, companyId: w.companyId,
      agentId: w.agentId, issueId: w.issueId, status: "running" });
    expect((await get(w, 200, next)).resubmit).toEqual(current.resubmit);
    expect((await db.select().from(issues).where(eq(issues.id, w.issueId)))[0]!.checkoutRunId).toBe(w.runId);
  });

  it("returns only B after replacement and replays legacy moi1 through the structured current body", async () => {
    const w = await world(), a = await post(w);
    const b = await post(w, keyed("B", a.body.lifetimeId, "B")); expect(b.status).toBe(201);
    expect(await get(w)).toMatchObject({ lifetimeId: b.body.lifetimeId, requestKey: "B",
      card: { id: b.body.operatorDecisionId }, resubmit: { reason: "B" } });
    const old = await post(w); expect(old.status).toBe(409);
    const legacy = await world(), first = await post(legacy, { decision: "request_input", reason: "legacy" });
    expect(first.status).toBe(201);
    const current = await get(legacy);
    expect(current.card.requestKey).toBe(`moi1:${first.body.eventId}`);
    expect((await post(legacy, current.resubmit)).body).toEqual(first.body);
  });

  it.each(["missing_pointer", "pointer_schema", "reference", "request_key", "anchor", "card", "link"])(
    "rejects %s damage instead of returning historical A or repairing state", async (damage) => {
      const w = await world(), a = await post(w), b = await post(w, keyed("B", a.body.lifetimeId, "B"));
      expect(b.status).toBe(201);
      const pointer = (await events(w)).find((row) => row.eventType === "owner_human_current_v1")!;
      const payload = pointer.payload as Record<string, unknown>;
      if (damage === "missing_pointer") await db.delete(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, pointer.id));
      if (damage === "pointer_schema") await db.update(workflowTransitionEvents).set({ payload: {} })
        .where(eq(workflowTransitionEvents.id, pointer.id));
      if (["reference", "request_key", "anchor"].includes(damage)) {
        const changed = damage === "reference" ? { lifetimeId: randomUUID() }
          : damage === "request_key" ? { requestKey: "wrong" } : { anchorIssueId: w.sourceId };
        await db.update(workflowTransitionEvents).set({ payload: { ...payload, ...changed } })
          .where(eq(workflowTransitionEvents.id, pointer.id));
      }
      if (damage === "card") await db.update(operatorDecisions).set({ sourceId: a.body.eventId })
        .where(eq(operatorDecisions.id, b.body.operatorDecisionId));
      if (damage === "link") {
        const link = (await events(w)).find((row) => row.idempotencyKey === `owner-human-card:v1:${b.body.lifetimeId}`)!;
        await db.update(workflowTransitionEvents).set({ payload: { ...(link.payload as object),
          operatorDecisionId: a.body.operatorDecisionId } }).where(eq(workflowTransitionEvents.id, link.id));
      }
      await get(w, 409);
    });

  it("denies another company/current non-owner and invalid heartbeat/source without writes", async () => {
    const w = await world(), foreign = await world(); await post(w);
    await get(w, 403, foreign);
    await get(w, 403, { ...w, agentId: foreign.agentId });
    await get(w, 409, { ...w, runId: foreign.runId });
    await db.update(issues).set({ originId: foreign.sourceId }).where(eq(issues.id, w.issueId));
    await get(w, 409);
    await expect(readOwnerHumanRequest({ db, companyId: w.companyId, issueId: w.issueId,
      actor: { actorType: "user", actorId: "board", agentId: null, runId: null } })).rejects.toMatchObject({ status: 403 });
  });

  it("uses actual oversight and durable tool-card/run/step scope, rejecting a broken step", async () => {
    const oversight = await world(true); expect((await post(oversight)).status).toBe(201);
    expect((await get(oversight)).scope.target).toEqual({ kind: "oversight" });
    const w = await world(), workflowId = randomUUID(), workflowRunId = randomUUID(), stepRunId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId: w.companyId, name: "tool", stepsJson: [] });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId: w.companyId,
      missionId: w.missionId, status: "failed", triggeredBy: "test" });
    await db.insert(workflowStepRuns).values({ id: stepRunId, workflowRunId, stepId: "tool", status: "failed" });
    await db.insert(workflowTransitionEvents).values({ companyId: w.companyId, missionId: w.missionId,
      issueId: w.issueId, workflowRunId, workflowStepRunId: stepRunId, layer: "mission_owner_recovery",
      eventType: "owner_tool_recovery_target_v1", idempotencyKey: `owner-tool-card:${stepRunId}`,
      payload: { schemaVersion: 1, kind: "tool_step", workflowRunId, stepRunId } });
    expect((await post(w)).status).toBe(201);
    expect((await get(w)).scope.target).toEqual({ kind: "tool_step", workflowRunId, stepRunId });
    await db.delete(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    await get(w, 409);
  });

  it("reports real resolution/continuation separately from recovery completion", async () => {
    const w = await world(), first = await post(w); expect(first.status).toBe(201);
    await operatorDecisionWriteService(db).resolve(first.body.operatorDecisionId,
      { actionId: "approve", selectedOptionIds: ["approve"], comment: "확인" }, "board");
    const current = await get(w);
    expect(current).toMatchObject({ recoveryNeeded: true, card: { status: "resolved" },
      delivery: { state: "pending", generation: 1, attemptCount: 0, wakeupRequestId: null, acceptedAt: null } });
    expect(current.resubmit.humanRequest.requestKey).toBe("A");
  });

  it("GET leaves failed post-commit card creation untouched; exact POST repairs the same request", async () => {
    const w = await world(), transaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction").mockImplementationOnce((callback) => transaction(callback))
      .mockImplementationOnce((callback) => transaction(async (tx) => {
        await callback(tx); throw new Error("card transaction interrupted");
      }));
    try {
      await expect(submitMissionOwnerDecision({ db, issueId: w.issueId, data: keyed(),
        actor: { actorType: "agent", actorId: w.agentId, agentId: w.agentId, runId: w.runId } }))
        .rejects.toMatchObject({ status: 500 });
    } finally { spy.mockRestore(); }
    const current = await get(w); expect(current.card).toBeNull(); expect(current.recoveryNeeded).toBe(true);
    const repaired = await post(w, current.resubmit); expect(repaired.status).toBe(201);
    expect(repaired.body.lifetimeId).toBe(current.lifetimeId);
    expect((await get(w)).card.id).toBe(repaired.body.operatorDecisionId);
  });

  it("preserves nonhuman response and guard-before-validation for all three existing POST routes", async () => {
    const w = await world(), plain = await post(w, { decision: "no_action_waiting" });
    expect(plain.status).toBe(201);
    expect(Object.keys(plain.body).sort()).toEqual(["createdAt", "decision", "eventId"]);
    for (const suffix of ["decision", "replacement", "execute"]) {
      const path = `/api/issues/${w.issueId}/owner-recovery/${suffix}`;
      expect((await request(app(w, true)).post(path).send({})).status).toBe(403);
      expect((await request(app(w)).post(path).send({})).status).toBe(400);
    }
    const before = await snapshot(w);
    expect((await request(app(w, true)).get(`${url(w)}/current`)).status).toBe(200);
    expect(await snapshot(w)).toEqual(before);
  });
});

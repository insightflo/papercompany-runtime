// C08 adopted plan:37–118,215: exact current-key replay, explicit CAS replacement,
// legacy compatibility and post-commit recovery. Fixtures contain only initial authority facts.
// Closure below uses the accepted state writer; it does not claim stage-14 native integration.
import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MissionOwnerDecisionSubmit } from "@paperclipai/shared";
import { activityLog, agents, companies, createDb, heartbeatRuns, issues, missions,
  operatorDecisions, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents,
  type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { workflowAgentApiRoutes } from "../routes/workflow-agent-api.js";
import { errorHandler } from "../middleware/index.js";
import { submitMissionOwnerDecision } from "../services/missions/mission-owner-recovery-agent-api.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
import { lockOwnerHumanRequestAuthority } from "../services/missions/owner-human-request-authority.js";
import { closeOwnerHumanRequest } from "../services/missions/owner-human-request-state.js";
import { ownerHumanLifetimeSchema } from "../services/missions/owner-human-request-contract.js";
import { publishLiveEvent } from "../services/live-events.js";

vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
type World = { companyId: string; missionId: string; agentId: string; issueId: string;
  sourceId: string; runId: string; oldRunId: string };
const keyed = (requestKey: string, expectedCurrentLifetimeId: string | null = null, reason = "A"): MissionOwnerDecisionSubmit => ({
  decision: "request_input", reason, nextAction: "사람 확인", evidence: "원천 근거",
  humanRequest: { schemaVersion: 1, requestKey, expectedCurrentLifetimeId },
});

describeDb("C08 actual owner human submission", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db, other: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("c08-owner-request-");
    db = createDb(database.connectionString); other = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => {
    await other?.$client.end({ timeout: 5 }); await db?.$client.end({ timeout: 5 }); await database?.cleanup();
  });
  async function world(oversight = false): Promise<World> {
    const w = { companyId: randomUUID(), missionId: randomUUID(), agentId: randomUUID(),
      issueId: randomUUID(), sourceId: randomUUID(), runId: randomUUID(), oldRunId: randomUUID() };
    await db.insert(companies).values({ id: w.companyId, name: "C08 request", issuePrefix: randomUUID() });
    await db.insert(agents).values({ id: w.agentId, companyId: w.companyId, name: "Owner", status: "active" });
    await db.insert(missions).values({ id: w.missionId, companyId: w.companyId,
      ownerAgentId: w.agentId, title: "C08 request", status: "active" });
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
  const actor = (w: World) => ({ actorType: "agent" as const, actorId: w.agentId, agentId: w.agentId, runId: w.runId });
  const submit = (w: World, data = keyed("A"), connection = db) =>
    submitMissionOwnerDecision({ db: connection, issueId: w.issueId, actor: actor(w), data });
  function app(w: World) {
    const server = express(); server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = { type: "agent", agentId: w.agentId, companyId: w.companyId, runId: w.runId }; next();
    });
    server.use("/api", workflowAgentApiRoutes(db)); server.use(errorHandler); return server;
  }
  const events = (w: World) => db.select().from(workflowTransitionEvents)
    .where(eq(workflowTransitionEvents.companyId, w.companyId)).orderBy(workflowTransitionEvents.id);
  const cards = (w: World) => db.select().from(operatorDecisions)
    .where(eq(operatorDecisions.companyId, w.companyId)).orderBy(operatorDecisions.id);
  const lifetimes = async (w: World) => (await events(w)).filter((row) => row.eventType === "owner_human_lifetime_v1")
    .map((row) => ownerHumanLifetimeSchema.parse(row.payload));
  const alerts = (w: World) => vi.mocked(publishLiveEvent).mock.calls.filter(([event]) =>
    event.companyId === w.companyId && event.type === "mission.human_input_requested");
  const snapshot = (w: World) => Promise.all([events(w), cards(w),
    db.select().from(issues).where(eq(issues.companyId, w.companyId)).orderBy(issues.id),
    db.select().from(activityLog).where(eq(activityLog.companyId, w.companyId)).orderBy(activityLog.id)]);
  async function unchanged(w: World, operation: () => Promise<unknown>, status = 409) {
    const before = await snapshot(w), emissions = alerts(w).length;
    await expect(operation()).rejects.toMatchObject({ status });
    expect(await snapshot(w)).toEqual(before); expect(alerts(w)).toHaveLength(emissions);
  }

  it("actual HTTP preserves a public-valid 12000-byte key and replays one event/lifetime/moi2 card", async () => {
    const w = await world(), key = randomBytes(9000).toString("base64"), body = keyed(key);
    const first = await request(app(w)).post(`/api/issues/${w.issueId}/owner-recovery/decision`).send(body);
    const again = await request(app(w)).post(`/api/issues/${w.issueId}/owner-recovery/decision`).send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(201); expect(again.status).toBe(201);
    expect(again.body.eventId).toBe(first.body.eventId);
    const saved = await lifetimes(w); expect(saved).toHaveLength(1);
    expect(saved[0]!.requestKey).toBe(key); expect(saved[0]!.decisionEventId).toBe(first.body.eventId);
    expect(await cards(w)).toHaveLength(1);
    expect((await cards(w))[0]).toMatchObject({ requestKey: `moi2:${saved[0]!.lifetimeId}`, sourceId: first.body.eventId });
    expect(alerts(w)).toHaveLength(1);
    expect((await events(w)).filter((row) => row.eventType === "owner_human_card_v1")).toHaveLength(1);
  });

  it("the real decision writer replays an explicit key and rejects a different body without a second event", async () => {
    const w = await world(), humanRequest = keyed("writer").humanRequest!;
    const write = (reason = "A") => db.transaction((tx) => recordMissionOwnerDecision({ db: tx,
      issue: { id: w.issueId, companyId: w.companyId, missionId: w.missionId },
      submission: { decision: "request_input", reason }, humanRequest,
      sourceIssueId: w.sourceId, heartbeatRunId: w.runId }));
    const first = await write(); expect(await write()).toEqual(first);
    await unchanged(w, () => write("B")); expect(await events(w)).toHaveLength(1);
  });

  it("A→B→A requires new keys and distinct originals; old keys, changed bodies and stale CAS leave state untouched", async () => {
    const w = await world(), a = await submit(w, keyed("A1"));
    const b = await submit(w, keyed("B", a.lifetimeId!, "B"));
    expect(await submit(w, keyed("B", a.lifetimeId!, "B"))).toEqual(b);
    await unchanged(w, () => submit(w, keyed("A1", b.lifetimeId!)));
    await unchanged(w, () => submit(w, keyed("B", b.lifetimeId!, "different")));
    await unchanged(w, () => submit(w, keyed("B", null, "B")));
    await unchanged(w, () => submit(w, keyed("C", a.lifetimeId!)));
    const a2 = await submit(w, keyed("A2", b.lifetimeId!));
    expect(new Set([a.eventId, b.eventId, a2.eventId]).size).toBe(3);
    expect(new Set([a.lifetimeId, b.lifetimeId, a2.lifetimeId]).size).toBe(3);
    expect(await lifetimes(w)).toHaveLength(3); expect(await cards(w)).toHaveLength(3);
    expect(alerts(w)).toHaveLength(3);
  });

  it("two real connections serialize replacements so only one same-CAS candidate wins", async () => {
    const w = await world(), a = await submit(w);
    const results = await Promise.allSettled([submit(w, keyed("left", a.lifetimeId!, "L")),
      submit(w, keyed("right", a.lifetimeId!, "R"), other)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await lifetimes(w)).toHaveLength(2); expect(await cards(w)).toHaveLength(2);
    expect(alerts(w)).toHaveLength(2);
  });

  it("an explicit current key survives a new authenticated heartbeat and real stale-checkout adoption", async () => {
    const w = await world(), first = await submit(w);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, w.runId));
    const next = { ...w, runId: randomUUID() };
    await db.insert(heartbeatRuns).values({ id: next.runId, companyId: w.companyId,
      agentId: w.agentId, issueId: w.issueId, status: "running" });
    expect(await submit(next)).toEqual(first);
    expect((await db.select().from(issues).where(eq(issues.id, w.issueId)))[0]!.checkoutRunId).toBe(next.runId);
    expect((await lifetimes(w))[0]!.heartbeatRunId).toBe(w.runId);
    expect(await cards(w)).toHaveLength(1); expect(alerts(w)).toHaveLength(1);
  });

  it("preserves legacy first/revised/current replay and moi1; ABA returns an exact structured current resubmission", async () => {
    const w = await world(), a = await submit(w, { decision: "request_input", reason: "A" });
    expect(await submit(w, { decision: "request_input", reason: "A" })).toEqual(a);
    expect((await cards(w))[0]!.requestKey).toBe(`moi1:${a.eventId}`);
    const b = await submit(w, { decision: "request_input", reason: "B" });
    expect(b.eventId).not.toBe(a.eventId);
    await unchanged(w, () => submit(w, { decision: "request_input", reason: "A" }));
    await expect(submit(w, { decision: "request_input", reason: "A" })).rejects.toMatchObject({
      status: 409, details: { code: "owner_human_request_identity_required", currentLifetimeId: b.lifetimeId,
        resubmit: { decision: "request_input", reason: "B", humanRequest: b.humanRequest } } });
    expect(await submit(w, { ...b.submission, humanRequest: b.humanRequest })).toEqual(b);
    expect(await lifetimes(w)).toHaveLength(2); expect(alerts(w)).toHaveLength(2);
  });

  it("ambiguous cross-run legacy input rolls back checkout adoption and returns the current structured request", async () => {
    const w = await world(), first = await submit(w, { decision: "request_input", reason: "A" });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, w.runId));
    const next = { ...w, runId: randomUUID() };
    await db.insert(heartbeatRuns).values({ id: next.runId, companyId: w.companyId,
      agentId: w.agentId, issueId: w.issueId, status: "running" });
    await unchanged(w, () => submit(next, { decision: "request_input", reason: "A" }));
    expect(await submit(next, { ...first.submission, humanRequest: first.humanRequest })).toEqual(first);
  });

  it.each(["owner", "heartbeat", "source", "checkout", "mission", "board"])(
    "preserves %s denial with no checkout, request, card or notification write", async (damage) => {
      const w = await world(), foreign = await world();
      if (damage === "owner") await db.update(missions).set({ ownerAgentId: foreign.agentId }).where(eq(missions.id, w.missionId));
      if (damage === "heartbeat") await db.update(heartbeatRuns).set({ issueId: w.sourceId }).where(eq(heartbeatRuns.id, w.runId));
      if (damage === "source") await db.update(issues).set({ originId: foreign.sourceId }).where(eq(issues.id, w.issueId));
      if (damage === "checkout") await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, w.oldRunId));
      if (damage === "mission") await db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, w.missionId));
      const operation = damage === "board" ? () => submitMissionOwnerDecision({ db, issueId: w.issueId,
        actor: { actorType: "user", actorId: "board", agentId: null, runId: null }, data: keyed("A") }) : () => submit(w);
      await unchanged(w, operation, ["owner", "board"].includes(damage) ? 403 : 409);
    });

  it("rolls back actual checkout/original/lifetime/pointer/alert writes when the submission transaction fails", async () => {
    const w = await world(), transaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction").mockImplementationOnce((callback) => transaction(async (tx) => {
      await callback(tx); throw new Error("submission interrupted after writes");
    }));
    try { await unchanged(w, () => submit(w).catch((error) => { throw Object.assign(error, { status: 500 }); }), 500); }
    finally { spy.mockRestore(); }
    expect(await events(w)).toHaveLength(0); expect(await cards(w)).toHaveLength(0);
  });

  it("a real failed card transaction preserves one committed request and exact retry repairs that lifetime without another alert", async () => {
    const w = await world(), transaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction").mockImplementationOnce((callback) => transaction(callback))
      .mockImplementationOnce((callback) => transaction(async (tx) => {
        await callback(tx); throw new Error("card transaction interrupted");
      }));
    try { await expect(submit(w)).rejects.toMatchObject({ status: 500, details: { code: "mission_owner_human_input_card_failed" } }); }
    finally { spy.mockRestore(); }
    const saved = (await lifetimes(w))[0]!; expect(await cards(w)).toHaveLength(0);
    expect(alerts(w)).toHaveLength(1);
    const recovered = await submit(w); expect(recovered.lifetimeId).toBe(saved.lifetimeId);
    expect(recovered.eventId).toBe(saved.decisionEventId); expect(await lifetimes(w)).toHaveLength(1);
    expect((await cards(w))[0]!.requestKey).toBe(`moi2:${saved.lifetimeId}`);
    expect(await submit(w)).toEqual(recovered); expect(alerts(w)).toHaveLength(1);
  });

  it("recurrence after accepted state closure requires a new key and retains exact original-CAS replay", async () => {
    const w = await world(), first = await submit(w);
    await db.transaction(async (tx) => {
      const auth = await lockOwnerHumanRequestAuthority(tx, { companyId: w.companyId, missionId: w.missionId,
        ownerActionIssueId: w.issueId, agentId: w.agentId, heartbeatRunId: w.runId, purpose: "settle" });
      await tx.update(issues).set({ status: "done" }).where(eq(issues.id, w.sourceId));
      await closeOwnerHumanRequest(auth, first.lifetimeId!);
    });
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, w.sourceId));
    await unchanged(w, () => submit(w, keyed("A", first.lifetimeId!)));
    const body = keyed("recurrence", first.lifetimeId!), second = await submit(w, body);
    expect(second.eventId).not.toBe(first.eventId); expect(second.lifetimeId).not.toBe(first.lifetimeId);
    expect(await submit(w, body)).toEqual(second); expect(await lifetimes(w)).toHaveLength(2);
  });

  it("uses a verified tool-card run/step while preserving optional human targets and nonhuman tool restrictions", async () => {
    const w = await world(), workflowId = randomUUID(), workflowRunId = randomUUID(), stepRunId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId: w.companyId, name: "tool", stepsJson: [] });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId: w.companyId,
      missionId: w.missionId, status: "failed", triggeredBy: "test" });
    await db.insert(workflowStepRuns).values({ id: stepRunId, workflowRunId, stepId: "tool", status: "failed" });
    await db.insert(workflowTransitionEvents).values({ companyId: w.companyId, missionId: w.missionId,
      issueId: w.issueId, workflowRunId, workflowStepRunId: stepRunId, layer: "mission_owner_recovery",
      eventType: "owner_tool_recovery_target_v1", idempotencyKey: `owner-tool-card:${stepRunId}`,
      payload: { schemaVersion: 1, kind: "tool_step", workflowRunId, stepRunId } });
    await submit(w); expect((await lifetimes(w))[0]!.scope.target).toEqual({ kind: "tool_step", workflowRunId, stepRunId });
    await unchanged(w, () => submit(w, { decision: "retry_source_issue" }));
    await unchanged(w, () => submit(w, { ...keyed("bad"), recoveryTarget: { kind: "tool_step",
      workflowRunId, stepRunId, expectedAuthorityVersion: 1, expectedExecutionGeneration: 0, failedDispatchRequestId: null } }));
  });

  it("preserves oversight scope/target prohibition and nonhuman return/schema/reassignment contracts", async () => {
    const w = await world(true);
    await submit(w, { ...keyed("oversight"), sourceIssueRef: "not authority" });
    expect((await lifetimes(w))[0]!.scope.target).toEqual({ kind: "oversight" });
    expect((await lifetimes(w))[0]!.sourceIssueId).toBeNull();
    await unchanged(w, () => submit(w, { ...keyed("bad"), recoveryTarget: { kind: "issue", issueId: w.sourceId } }));
    const plain = await world(), result = await submit(plain, { decision: "no_action_waiting" });
    expect(result).not.toHaveProperty("lifetimeId"); expect(await lifetimes(plain)).toHaveLength(0);
    expect(await cards(plain)).toHaveLength(0);
    const rejected = await request(app(plain)).post(`/api/issues/${plain.issueId}/owner-recovery/decision`)
      .send({ decision: "reassign_source_issue", nextAction: plain.agentId });
    expect(rejected.status).toBe(400);
  });
});

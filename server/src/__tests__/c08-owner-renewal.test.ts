// C08 plan:112–129 and parent PLAN:1435–1436: real state and renewal/card writers.
// Producer anchor creation remains stage 13C. Only initial authority/target facts are seeded.
// Original decisions use the existing writer; terminal anchors use the native issue service.
// No heartbeat success, renewal result, approval or delivery is inserted as a fixture.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issues, missionPlanArtifacts, missions, operatorDecisions, operatorDecisionContinuations,
  workflowTransitionEvents, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
import { lockOwnerHumanRequestAuthority } from "../services/missions/owner-human-request-authority.js";
import { readOwnerHumanCurrent, renewOwnerHumanRequest, saveOwnerHumanRequest,
  type OwnerHumanCurrentRecord } from "../services/missions/owner-human-request-state.js";
import { ownerHumanEndKey, ownerHumanLifetimeSchema } from "../services/missions/owner-human-request-contract.js";

import { renewOwnerHumanRequestWithCard } from "../services/missions/owner-human-request-renew.js";
import { createMissionOwnerHumanInputDecisionCard } from "../services/missions/mission-owner-human-input-card.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
import { readOwnerHumanRequest } from "../services/missions/owner-human-request-read.js";
import { submitMissionOwnerDecision } from "../services/missions/mission-owner-recovery-agent-api.js";
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const submission = { decision: "request_input" as const, reason: "Original blocker",
  nextAction: "사람 확인", evidence: "원작성 근거" };
type World = { companyId: string; missionId: string; agentId: string; sourceId: string;
  oldId: string; nextId: string; heartbeatId: string; original: OwnerHumanCurrentRecord };

describeDb("C08 explicit anchor renewal state", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db, other: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("c08-owner-renewal-");
    db = createDb(database.connectionString); other = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => {
    await other?.$client.end({ timeout: 5 }); await db?.$client.end({ timeout: 5 }); await database?.cleanup();
  });

  async function world(terminal = true, legacy = false): Promise<World> {
    const companyId = randomUUID(), missionId = randomUUID(), agentId = randomUUID(),
      sourceId = randomUUID(), oldId = randomUUID(), nextId = randomUUID(), heartbeatId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "C08 renewal", issuePrefix: randomUUID() });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", status: "active" });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "Renewal", status: "active" });
    await db.insert(issues).values([
      { id: sourceId, companyId, missionId, title: "Source", status: "blocked" },
      { id: oldId, companyId, missionId, title: "Original", status: "in_progress",
        assigneeAgentId: agentId, originKind: "mission_main_executor_unblock", originId: sourceId },
      { id: nextId, companyId, missionId, title: "New anchor input", status: "todo",
        assigneeAgentId: agentId, originKind: "mission_main_executor_unblock", originId: sourceId },
    ]);
    await db.insert(heartbeatRuns).values({ id: heartbeatId, companyId, agentId, issueId: oldId, status: "running" });
    const original = await db.transaction(async (tx) => {
      const auth = await lockOwnerHumanRequestAuthority(tx, { companyId, missionId, agentId,
        ownerActionIssueId: oldId, heartbeatRunId: heartbeatId });
      const decision = await recordMissionOwnerDecision({ db: tx,
        issue: { id: oldId, companyId, missionId }, submission, sourceIssueId: sourceId, heartbeatRunId: heartbeatId });
      return saveOwnerHumanRequest(auth, { schemaVersion: 1, requestKey: randomUUID(),
        expectedCurrentLifetimeId: null, identityMode: legacy ? "legacy_exact" : "keyed",
        decisionEventId: decision.eventId, submission });
    });
    if (terminal) await issueService(db).update(oldId, { status: "cancelled" });
    return { companyId, missionId, agentId, sourceId, oldId, nextId, heartbeatId, original };
  }
  const authority = (w: World, expected = w.original.lifetime.lifetimeId) => ({
    companyId: w.companyId, missionId: w.missionId, agentId: w.agentId, ownerActionIssueId: w.oldId,
    heartbeatRunId: w.heartbeatId, purpose: "renew" as const,
    renewal: { previousLifetimeId: expected, anchorIssueId: w.nextId },
  });
  const renew = (w: World, key: string, connection = db, expected = w.original.lifetime.lifetimeId) =>
    connection.transaction(async (tx) => renewOwnerHumanRequest(
      await lockOwnerHumanRequestAuthority(tx, authority(w, expected)),
      { requestKey: key, expectedCurrentLifetimeId: expected }));
  const renewalInput = (w: World, key: string) => ({ companyId: w.companyId,
    previousLifetimeId: w.original.lifetime.lifetimeId, anchorIssueId: w.nextId, requestKey: key });
  const renewCard = (w: World, key: string, connection = db) =>
    connection.transaction((tx) => renewOwnerHumanRequestWithCard(tx, renewalInput(w, key)));
  const createCard = (saved: OwnerHumanCurrentRecord, connection = db) =>
    createMissionOwnerHumanInputDecisionCard(connection, { ...saved.lifetime.cardInput, lifetimeId: saved.lifetime.lifetimeId });
  const events = (w: World, connection = db) => connection.select().from(workflowTransitionEvents)
    .where(eq(workflowTransitionEvents.companyId, w.companyId)).orderBy(workflowTransitionEvents.id);
  const snapshot = (w: World) => Promise.all([events(w),
    db.select().from(issues).where(eq(issues.companyId, w.companyId)).orderBy(issues.id),
    db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, w.companyId)).orderBy(heartbeatRuns.id),
    db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, w.companyId)),
    db.select().from(missions).where(eq(missions.id, w.missionId)),
    db.select().from(activityLog).where(eq(activityLog.companyId, w.companyId)).orderBy(activityLog.id),
    db.select().from(operatorDecisionContinuations).where(eq(operatorDecisionContinuations.companyId, w.companyId))]);
  async function unchanged(w: World, operation: () => Promise<unknown>) {
    const before = await snapshot(w);
    await expect(operation()).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(w)).toEqual(before);
  }

  it("replaces one terminal anchor lifetime while retaining exact origin bytes and author heartbeat", async () => {
    const w = await world(), before = await events(w), key = randomUUID();
    const saved = await renew(w, key);
    expect(saved.lifetime.lifetimeId).not.toBe(w.original.lifetime.lifetimeId);
    expect(saved.pointer).toMatchObject({ anchorIssueId: w.nextId, requestKey: key,
      recoveryNeeded: true, closure: null, revision: 2 });
    expect(saved.lifetime).toMatchObject({ decisionEventId: w.original.lifetime.decisionEventId,
      heartbeatRunId: w.heartbeatId, authorAgentId: w.agentId, submission,
      renewal: { schemaVersion: 1, previousLifetimeId: w.original.lifetime.lifetimeId } });
    expect(saved.lifetime.cardInput).toEqual({ ...w.original.lifetime.cardInput,
      ownerActionIssueId: w.nextId, ownerActionIssueStatus: "todo", issueTitle: "New anchor input" });
    const after = await events(w);
    for (const row of before.filter((event) => event.eventType !== "owner_human_current_v1")) {
      expect(after.find((event) => event.id === row.id)).toEqual(row);
    }
    expect(after.filter((row) => row.eventType === "mission_owner_decision")).toHaveLength(1);
    expect(after.filter((row) => row.eventType === "owner_human_lifetime_v1")).toHaveLength(2);
    expect(after.find((row) => row.idempotencyKey === ownerHumanEndKey(w.original.lifetime.lifetimeId))?.payload)
      .toMatchObject({ reason: "replaced", nextLifetimeId: saved.lifetime.lifetimeId });
    expect((await snapshot(w))[2]).toHaveLength(1);
    expect((await snapshot(w))[3]).toHaveLength(0); // No card/approval copying in this primitive.
  });

  it("replays from an independent connection after response loss with no new writes", async () => {
    const w = await world(), key = randomUUID(), saved = await renew(w, key), before = await snapshot(w);
    expect(await renew(w, key, other)).toEqual(saved);
    expect(await snapshot(w)).toEqual(before);
    await unchanged(w, () => renew(w, randomUUID(), other));
  });

  it("serializes two independent PostgreSQL connections: exact retry agrees, competing keys have one winner", async () => {
    const w = await world(), key = randomUUID();
    const [a, b] = await Promise.all([renew(w, key), renew(w, key, other)]);
    expect(a).toEqual(b);
    const v = await world();
    const raced = await Promise.allSettled([renew(v, randomUUID()), renew(v, randomUUID(), other)]);
    expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(raced.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await events(v)).filter((row) => row.eventType === "owner_human_lifetime_v1")).toHaveLength(2);
  });

  it("retains the original provenance through a second server renewal without inventing an author run", async () => {
    const w = await world(), first = await renew(w, randomUUID());
    await issueService(db).update(w.nextId, { status: "cancelled" });
    const nextId = randomUUID();
    await db.insert(issues).values({ id: nextId, companyId: w.companyId, missionId: w.missionId,
      title: "Second target input", status: "todo", assigneeAgentId: w.agentId,
      originKind: "mission_main_executor_unblock", originId: w.sourceId });
    const v = { ...w, oldId: w.nextId, nextId }, key = randomUUID();
    const second = await renew(v, key, db, first.lifetime.lifetimeId);
    expect(second.lifetime.heartbeatRunId).toBe(w.heartbeatId);
    expect(second.lifetime.decisionEventId).toBe(w.original.lifetime.decisionEventId);
    expect(second.pointer.revision).toBe(3);
    expect(await renew(v, key, other, first.lifetime.lifetimeId)).toEqual(second);
  });

  it("rolls back inserts/endings/pointer together, including a failure after state writes", async () => {
    const w = await world(), before = await snapshot(w);
    await expect(db.transaction(async (tx) => {
      const auth = await lockOwnerHumanRequestAuthority(tx, authority(w));
      await renewOwnerHumanRequest(auth, { requestKey: randomUUID(),
        expectedCurrentLifetimeId: w.original.lifetime.lifetimeId });
      throw new Error("failure after renewal");
    })).rejects.toThrow("failure after renewal");
    expect(await snapshot(w)).toEqual(before);
    await unchanged(w, () => db.transaction(async (tx) => {
      const auth = await lockOwnerHumanRequestAuthority(tx, authority(w));
      // Inject a real same-transaction origin corruption after locks. Origin validation runs
      // after the successor insert and predecessor end insert and must roll all of them back.
      await tx.update(issues).set({ originId: w.oldId }).where(eq(issues.id, w.nextId));
      return renewOwnerHumanRequest(auth, { requestKey: randomUUID(),
        expectedCurrentLifetimeId: w.original.lifetime.lifetimeId });
    }));
  });

  it("rejects open predecessor, source settlement, mission cancellation and owner loss", async () => {
    const open = await world(false); await unchanged(open, () => renew(open, randomUUID()));
    const settled = await world(); await issueService(db).update(settled.sourceId, { status: "done" });
    await unchanged(settled, () => renew(settled, randomUUID()));
    const cancelled = await world();
    await db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, cancelled.missionId));
    await unchanged(cancelled, () => renew(cancelled, randomUUID()));
    const lost = await world(), replacementAgentId = randomUUID();
    await db.insert(agents).values({ id: replacementAgentId, companyId: lost.companyId,
      name: "Replacement owner", status: "active" });
    await db.update(missions).set({ ownerAgentId: replacementAgentId }).where(eq(missions.id, lost.missionId));
    await unchanged(lost, () => renew(lost, randomUUID()));
  });

  it("rejects plain new-anchor/old-heartbeat submission, reused keys and malformed renewal schema", async () => {
    const w = await world();
    await unchanged(w, () => db.transaction((tx) => lockOwnerHumanRequestAuthority(tx, {
      companyId: w.companyId, missionId: w.missionId, agentId: w.agentId,
      ownerActionIssueId: w.nextId, heartbeatRunId: w.heartbeatId,
    })));
    await unchanged(w, () => renew(w, w.original.lifetime.requestKey));
    expect(ownerHumanLifetimeSchema.safeParse({ ...w.original.lifetime,
      renewal: { schemaVersion: 2, previousLifetimeId: w.original.lifetime.lifetimeId } }).success).toBe(false);
    expect(ownerHumanLifetimeSchema.safeParse({ ...w.original.lifetime,
      renewal: { schemaVersion: 1, previousLifetimeId: w.original.lifetime.lifetimeId, extra: true } }).success).toBe(false);
    expect(ownerHumanLifetimeSchema.safeParse(w.original.lifetime).success).toBe(true);
  });

  it("rejects missing/tampered predecessor and replaced-ending evidence on restart", async () => {
    for (const damage of ["missing", "ending", "decision", "unproven", "cycle"] as const) {
      const w = await world(), saved = await renew(w, randomUUID());
      if (damage === "missing") {
        await db.delete(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, w.original.lifetime.lifetimeId));
      } else if (damage === "ending") {
        const ending = (await events(w)).find((row) => row.idempotencyKey === ownerHumanEndKey(w.original.lifetime.lifetimeId))!;
        await db.update(workflowTransitionEvents).set({ payload: { ...(ending.payload as object),
          nextLifetimeId: randomUUID() } }).where(eq(workflowTransitionEvents.id, ending.id));
      } else if (damage === "decision") {
        const original = (await events(w)).find((row) => row.id === w.original.lifetime.decisionEventId)!;
        await db.update(workflowTransitionEvents).set({ issueId: w.nextId })
          .where(eq(workflowTransitionEvents.id, original.id));
      } else if (damage === "unproven") {
        const { renewal: _renewal, ...unproven } = saved.lifetime;
        await db.update(workflowTransitionEvents).set({ payload: unproven })
          .where(eq(workflowTransitionEvents.id, saved.lifetime.lifetimeId));
      } else {
        await db.update(workflowTransitionEvents).set({ payload: { ...w.original.lifetime,
          renewal: { schemaVersion: 1, previousLifetimeId: saved.lifetime.lifetimeId } } })
          .where(eq(workflowTransitionEvents.id, w.original.lifetime.lifetimeId));
      }
      await unchanged(w, () => db.transaction(async (tx) => readOwnerHumanCurrent(
        await lockOwnerHumanRequestAuthority(tx, authority(w)))));
    }
  });

  it("renews legacy input into a new keyed lifetime while preserving the legacy origin", async () => {
    const w = await world(true, true), saved = await renew(w, randomUUID());
    expect(saved.lifetime.identityMode).toBe("keyed");
    expect(saved.lifetime.decisionEventId).toBe(w.original.lifetime.decisionEventId);
    const old = (await events(w)).find((row) => row.id === w.original.lifetime.lifetimeId)!;
    expect(ownerHumanLifetimeSchema.parse(old.payload)).toEqual(w.original.lifetime);
  });

  it("creates a new pending card without copying real past approval, result, continuation or links", async () => {
    const w = await world(false), old = await createCard(w.original);
    await operatorDecisionWriteService(db).resolve(old.decision.id,
      { actionId: "approve", selectedOptionIds: ["approve"], comment: "과거 승인" }, "board");
    await issueService(db).update(w.oldId, { status: "cancelled" });
    const decisionHash = "d".repeat(64);
    await db.insert(missionPlanArtifacts).values({ companyId: w.companyId, missionId: w.missionId,
      revision: 1, ownerAgentId: w.agentId, missionGoal: "Renewal", status: "active",
      refs: { ownerPlanDecision: { decisionHash } } });
    const before = await snapshot(w), key = randomUUID(), saved = await renewCard(w, key);
    expect(saved.cardCreated).toBe(true);
    expect(saved.card).toMatchObject({ status: "pending", result: null, resolvedAt: null,
      resolvedByUserId: null, cancelledAt: null, requestedByAgentId: w.agentId,
      issueId: w.nextId, sourceId: w.original.lifetime.decisionEventId,
      requestKey: `moi2:${saved.current.lifetime.lifetimeId}` });
    expect(saved.card.sourceContext).toMatchObject({ missionId: w.missionId, planDecisionHash: decisionHash });
    const after = await snapshot(w);
    expect(after[3].find((card) => card.id === old.decision.id)).toEqual(before[3][0]);
    expect(after[6]).toEqual(before[6]);
    expect(after[2]).toEqual(before[2]);
    for (const row of before[5]) expect(after[5].find((event) => event.id === row.id)).toEqual(row);
    for (const row of before[0].filter((event) => event.eventType !== "owner_human_current_v1")) {
      expect(after[0].find((event) => event.id === row.id)).toEqual(row);
    }
    expect(after[0].filter((event) => event.eventType === "owner_human_card_v1")).toHaveLength(2);
    expect(after[0].find((event) => event.idempotencyKey ===
      `owner-human-card:v1:${saved.current.lifetime.lifetimeId}`)).toMatchObject({
        issueId: w.nextId, heartbeatRunId: w.heartbeatId,
        payload: { lifetimeId: saved.current.lifetime.lifetimeId, operatorDecisionId: saved.card.id } });
    expect((await createCard(saved.current, other)).decision.id).toBe(saved.card.id);
    expect((await renewCard(w, key, other)).cardCreated).toBe(false);
    expect(await snapshot(w)).toEqual(after);
  });

  it("rolls back lifetime, pointer, card, binding and audit if the owning transaction fails", async () => {
    const w = await world(), before = await snapshot(w), key = randomUUID();
    await expect(db.transaction(async (tx) => {
      await renewOwnerHumanRequestWithCard(tx, renewalInput(w, key));
      throw new Error("renewal card interrupted");
    })).rejects.toThrow("renewal card interrupted");
    expect(await snapshot(w)).toEqual(before);
    const [a, b] = await Promise.all([renewCard(w, key), renewCard(w, key, other)]);
    expect(a.card.id).toBe(b.card.id);
    expect([a.cardCreated, b.cardCreated].sort()).toEqual([false, true]);
    expect((await snapshot(w))[3]).toHaveLength(1);
  });

  it("keeps current GET/POST exact replay distinct from the original issuing heartbeat", async () => {
    const w = await world(), saved = await renewCard(w, randomUUID()), runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: w.companyId,
      agentId: w.agentId, issueId: w.nextId, status: "running" }); // Current caller authority only.
    await issueService(db).checkout(w.nextId, w.agentId, ["todo"], runId);
    const actor = { actorType: "agent" as const, actorId: w.agentId, agentId: w.agentId, runId };
    const projection = await readOwnerHumanRequest({ db, companyId: w.companyId, issueId: w.nextId, actor });
    expect(projection.card?.id).toBe(saved.card.id);
    expect(projection.resubmit).toEqual({ ...submission, humanRequest: { schemaVersion: 1,
      requestKey: saved.current.lifetime.requestKey, expectedCurrentLifetimeId: saved.current.lifetime.lifetimeId } });
    const replay = await submitMissionOwnerDecision({ db, issueId: w.nextId, actor, data: projection.resubmit! });
    expect(replay).toMatchObject({ eventId: w.original.lifetime.decisionEventId,
      lifetimeId: saved.current.lifetime.lifetimeId, operatorDecisionId: saved.card.id, submission });
    expect((await snapshot(w))[3]).toHaveLength(1);
    expect((await events(w)).filter((row) => row.eventType === "mission_owner_decision")).toHaveLength(1);
    await db.delete(workflowTransitionEvents).where(eq(workflowTransitionEvents.id,
      (await events(w)).find((row) => row.eventType === "owner_human_card_v1")!.id));
    await unchanged(w, () => renewCard(w, saved.current.lifetime.requestKey, other));
  });
});

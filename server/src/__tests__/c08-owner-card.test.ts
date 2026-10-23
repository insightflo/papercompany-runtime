// C08 adopted plan:103–118,214 is the oracle: one current lifetime/card, immutable exact
// replay and post-commit recovery; replacement must reject both delayed create and old replay.
// Initial fixtures have no cards/bindings. All successful cards below use the real create writer.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issues, missions,
  operatorDecisions, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { lockOwnerHumanRequestAuthority } from "../services/missions/owner-human-request-authority.js";
import { closeOwnerHumanRequest, saveOwnerHumanRequest, type OwnerHumanCurrentRecord } from "../services/missions/owner-human-request-state.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
import { buildMissionOwnerHumanInputDecisionCard, createMissionOwnerHumanInputDecisionCard,
  type MissionOwnerHumanInputCardSpec } from "../services/missions/mission-owner-human-input-card.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
import { publishLiveEvent } from "../services/live-events.js";

vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
type World = { companyId: string; missionId: string; agentId: string;
  ownerActionIssueId: string; heartbeatRunId: string; sourceId: string };

describeDb("C08 current lifetime card creation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let other: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("c08-owner-card-");
    db = createDb(database.connectionString);
    other = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => {
    await other?.$client.end({ timeout: 5 });
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
  });

  async function world(): Promise<World> {
    const w = { companyId: randomUUID(), missionId: randomUUID(), agentId: randomUUID(),
      ownerActionIssueId: randomUUID(), heartbeatRunId: randomUUID(), sourceId: randomUUID() };
    await db.insert(companies).values({ id: w.companyId, name: "C08 card", issuePrefix: randomUUID() });
    await db.insert(agents).values({ id: w.agentId, companyId: w.companyId, name: "Owner", status: "active" });
    await db.insert(missions).values({ id: w.missionId, companyId: w.companyId,
      ownerAgentId: w.agentId, title: "C08 card", status: "active" });
    await db.insert(issues).values([
      { id: w.sourceId, companyId: w.companyId, missionId: w.missionId, title: "Source", status: "blocked" },
      { id: w.ownerActionIssueId, companyId: w.companyId, missionId: w.missionId, title: "Owner action",
        status: "in_progress", assigneeAgentId: w.agentId, originKind: "mission_main_executor_unblock", originId: w.sourceId },
    ]);
    await db.insert(heartbeatRuns).values({ id: w.heartbeatRunId, companyId: w.companyId,
      agentId: w.agentId, issueId: w.ownerActionIssueId, status: "running" });
    return w;
  }
  const authority = (w: World) => ({ companyId: w.companyId, missionId: w.missionId,
    ownerActionIssueId: w.ownerActionIssueId, agentId: w.agentId, heartbeatRunId: w.heartbeatRunId });
  async function write(w: World, key = "A", expected: string | null = null, connection = db) {
    return connection.transaction(async (tx) => {
      const auth = await lockOwnerHumanRequestAuthority(tx, authority(w));
      const submission = { decision: "request_input" as const, reason: key, nextAction: "사람 확인", evidence: "원천 근거" };
      const original = await recordMissionOwnerDecision({ db: tx, issue: {
        id: w.ownerActionIssueId, companyId: w.companyId, missionId: w.missionId,
      }, submission, sourceIssueId: w.sourceId, heartbeatRunId: w.heartbeatRunId });
      return saveOwnerHumanRequest(auth, { schemaVersion: 1, requestKey: key,
        expectedCurrentLifetimeId: expected, identityMode: "keyed", decisionEventId: original.eventId, submission });
    });
  }
  const spec = (saved: OwnerHumanCurrentRecord): MissionOwnerHumanInputCardSpec => ({
    ...saved.lifetime.cardInput, lifetimeId: saved.lifetime.lifetimeId,
  });
  const create = (saved: OwnerHumanCurrentRecord, connection = db) =>
    createMissionOwnerHumanInputDecisionCard(connection, spec(saved));
  const cards = (w: World) => db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, w.companyId));
  const links = (w: World) => db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, w.companyId), eq(workflowTransitionEvents.eventType, "owner_human_card_v1")));
  const alerts = (w: World) => vi.mocked(publishLiveEvent).mock.calls.filter(([event]) =>
    event.companyId === w.companyId && event.type === "operator_decision.created");

  it("commits exactly one actual card and binding across two database connections", async () => {
    const w = await world(), saved = await write(w);
    expect(await cards(w)).toHaveLength(0);
    expect(await links(w)).toHaveLength(0);
    const results = await Promise.all([create(saved), create(saved, other)]);
    expect(results.map((value) => value.replayed).sort()).toEqual([false, true]);
    expect(results[0]!.decision.id).toBe(results[1]!.decision.id);
    const [card] = await cards(w), binding = await links(w);
    expect(await cards(w)).toHaveLength(1);
    expect(card!.requestKey).toBe(`moi2:${saved.lifetime.lifetimeId}`);
    expect(card!.sourceId).toBe(saved.lifetime.decisionEventId);
    expect(card!.issueId).toBe(w.ownerActionIssueId);
    expect(binding).toHaveLength(1);
    expect(binding[0]!.payload).toEqual({ schemaVersion: 1, kind: "owner_human_card_v1",
      lifetimeId: saved.lifetime.lifetimeId, decisionEventId: saved.lifetime.decisionEventId,
      operatorDecisionId: card!.id });
    expect(alerts(w)).toHaveLength(1);
  });

  it("replays the immutable input after open status/display changes and heartbeat completion", async () => {
    const w = await world(), saved = await write(w), first = await create(saved);
    await db.update(issues).set({ status: "blocked", title: "New display" }).where(eq(issues.id, w.ownerActionIssueId));
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, w.heartbeatRunId));
    const again = await create(saved);
    expect(again.replayed).toBe(true);
    expect(again.decision.id).toBe(first.decision.id);
    expect(again.decision.definition).toEqual(first.decision.definition);
    expect(again.decision.sourceContext.targetSnapshot?.issueStatus).toBe("in_progress");
    expect(await cards(w)).toHaveLength(1);
    expect(alerts(w)).toHaveLength(1);
  });

  it("rolls back a failed post-ledger card transaction and recovers the exact same lifetime/key/input", async () => {
    const w = await world(), saved = await write(w);
    const before = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, w.companyId));
    const transaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction").mockImplementationOnce((callback) => transaction(async (tx) => {
      await callback(tx);
      throw new Error("card transaction interrupted");
    }));
    try {
      await expect(create(saved)).rejects.toThrow("card transaction interrupted");
    } finally { spy.mockRestore(); }
    expect(await cards(w)).toHaveLength(0);
    expect(await links(w)).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, w.companyId))).toHaveLength(0);
    expect(await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, w.companyId))).toEqual(before);
    expect(alerts(w)).toHaveLength(0);
    const resubmitted = await write(w);
    expect(resubmitted).toEqual(saved);
    const recovered = await create(resubmitted);
    expect(recovered.replayed).toBe(false);
    expect(recovered.decision.requestKey).toBe(`moi2:${saved.lifetime.lifetimeId}`);
    expect(recovered.decision.sourceId).toBe(saved.lifetime.decisionEventId);
    expect((await create(saved)).decision.id).toBe(recovered.decision.id);
    expect(await links(w)).toHaveLength(1);
    expect(alerts(w)).toHaveLength(1);
  });

  it("rejects delayed creation and the fast replay of replaced lifetimes", async () => {
    const w = await world(), a = await write(w), b = await write(w, "B", a.lifetime.lifetimeId);
    await expect(create(a)).rejects.toMatchObject({ status: 409 });
    expect(await cards(w)).toHaveLength(0);
    const old = await create(b), c = await write(w, "C", b.lifetime.lifetimeId);
    await expect(create(b)).rejects.toMatchObject({ status: 409 });
    expect((await cards(w))[0]!.id).toBe(old.decision.id);
    expect((await cards(w))[0]!.status).toBe("pending");
    const current = await create(c);
    expect(current.decision.id).not.toBe(old.decision.id);
    expect(await cards(w)).toHaveLength(2);
    expect(await links(w)).toHaveLength(2);
  });

  it("rechecks currentness in the catch replay after another connection replaces the lifetime", async () => {
    const w = await world(), a = await write(w);
    await create(a);
    const transaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction").mockImplementationOnce(async (callback) => {
      await transaction(callback);
      await write(w, "B", a.lifetime.lifetimeId, other);
      throw new Error("response lost after replacement");
    });
    try {
      await expect(create(a)).rejects.toMatchObject({ status: 409 });
    } finally { spy.mockRestore(); }
    expect(await cards(w)).toHaveLength(1);
    expect(await links(w)).toHaveLength(1);
    expect(alerts(w)).toHaveLength(1);
  });

  it.each(["owner", "mission", "anchor", "origin", "pointer", "input", "scope"] as const)(
    "rejects current %s mismatches before creating a card", async (damage) => {
      const w = await world(), saved = await write(w);
      let input = buildMissionOwnerHumanInputDecisionCard(spec(saved));
      if (damage === "owner") {
        const id = randomUUID();
        await db.insert(agents).values({ id, companyId: w.companyId, name: "New owner" });
        await db.update(missions).set({ ownerAgentId: id }).where(eq(missions.id, w.missionId));
      } else if (damage === "mission") {
        await db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, w.missionId));
      } else if (damage === "anchor") {
        await db.update(issues).set({ originId: null }).where(eq(issues.id, w.ownerActionIssueId));
      } else if (damage === "origin") {
        await db.update(workflowTransitionEvents).set({ payload: { ...saved.lifetime.submission, schemaVersion: 2 } })
          .where(eq(workflowTransitionEvents.id, saved.lifetime.decisionEventId));
      } else if (damage === "pointer") {
        await db.update(workflowTransitionEvents).set({ payload: { ...saved.pointer, lifetimeId: randomUUID() } })
          .where(eq(workflowTransitionEvents.id, saved.pointerEventId));
      } else if (damage === "input") {
        input = { ...input, title: "Different immutable card input" };
      } else {
        input = { ...input, sourceContext: { ...input.sourceContext, missionId: randomUUID() } };
      }
      await expect(operatorDecisionWriteService(db).create(w.companyId, input, { type: "agent", id: w.agentId }))
        .rejects.toMatchObject({ status: 409 });
      expect(await cards(w)).toHaveLength(0);
      expect(await links(w)).toHaveLength(0);
    });

  it.each(["link", "card", "unbound-card", "missing-card"] as const)(
    "rejects a damaged actual %s on replay without adopting or resurrecting it", async (damage) => {
      const w = await world(), saved = await write(w), first = await create(saved);
      const [link] = await links(w);
      if (damage === "link") {
        await db.update(workflowTransitionEvents).set({ payload: { ...link!.payload, operatorDecisionId: randomUUID() } })
          .where(eq(workflowTransitionEvents.id, link!.id));
      } else if (damage === "card") {
        await db.update(operatorDecisions).set({ sourceId: randomUUID() }).where(eq(operatorDecisions.id, first.decision.id));
      } else if (damage === "unbound-card") {
        await db.delete(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, link!.id));
      } else {
        await db.delete(operatorDecisions).where(eq(operatorDecisions.id, first.decision.id));
      }
      await expect(create(saved)).rejects.toMatchObject({ status: 409 });
      expect(await cards(w)).toHaveLength(damage === "missing-card" ? 0 : 1);
      expect(alerts(w)).toHaveLength(1);
    });

  it("rejects a closed lifetime and cross-company/requester impersonation", async () => {
    const w = await world(), saved = await write(w), foreign = await world();
    await expect(operatorDecisionWriteService(db).create(foreign.companyId,
      buildMissionOwnerHumanInputDecisionCard(spec(saved)), { type: "agent", id: w.agentId }))
      .rejects.toMatchObject({ status: 403 });
    await expect(operatorDecisionWriteService(db).create(w.companyId,
      buildMissionOwnerHumanInputDecisionCard(spec(saved)), { type: "user", id: "board" }))
      .rejects.toMatchObject({ status: 409 });
    await db.transaction(async (tx) => {
      const auth = await lockOwnerHumanRequestAuthority(tx, { ...authority(w), purpose: "settle" });
      await tx.update(issues).set({ status: "done" }).where(eq(issues.id, w.sourceId));
      await closeOwnerHumanRequest(auth, saved.lifetime.lifetimeId);
    });
    await expect(create(saved)).rejects.toMatchObject({ status: 409 });
    expect(await cards(w)).toHaveLength(0);
  });

  it("preserves moi1, structured options, generic create/replay and their return/alert contracts", async () => {
    const w = await world(), saved = await write(w);
    const { lifetimeId: _lifetime, ...legacy } = spec(saved);
    const first = await createMissionOwnerHumanInputDecisionCard(db, legacy);
    expect(first.replayed).toBe(false);
    expect(first.decision.requestKey).toBe(`moi1:${saved.lifetime.decisionEventId}`);
    expect(first.decision.definition.options.map((option) => option.id)).toEqual(["approve", "hold", "reject"]);
    expect(first.decision.definition.comment.mode).toBe("required");
    expect((await createMissionOwnerHumanInputDecisionCard(db, legacy)).replayed).toBe(true);
    const structured = { ...legacy, decisionEventId: randomUUID(), structuredOptions: [{ id: "check", label: "확인" }] };
    expect((await createMissionOwnerHumanInputDecisionCard(db, structured)).decision.definition.options[0]!.id).toBe("check");
    const generic = { ...buildMissionOwnerHumanInputDecisionCard(legacy),
      requestKey: "ordinary", sourceType: "ordinary", sourceId: "ordinary" };
    const normal = await operatorDecisionWriteService(db).create(w.companyId, generic, { type: "user", id: "board" });
    expect(normal.replayed).toBe(false);
    expect((await operatorDecisionWriteService(db).create(w.companyId, generic, { type: "user", id: "board" })).replayed).toBe(true);
    expect(await links(w)).toHaveLength(0);
    expect(alerts(w)).toHaveLength(3);
  });
});

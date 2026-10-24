import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, missions,
  workflowTransitionEvents, type Db } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import { createMissionWorkSettlement } from "../services/missions/mission-work-settlement.js";
import { runMissionTerminalCleanup } from "../services/missions/terminal-cleanup-fence.js";
import { lockOwnerHumanRequestAuthority } from "../services/missions/owner-human-request-authority.js";
import { ownerHumanCurrentKey, ownerHumanCurrentSchema,
  type OwnerHumanSubmission } from "../services/missions/owner-human-request-contract.js";
import { renewOwnerHumanRequest, saveOwnerHumanRequest } from "../services/missions/owner-human-request-state.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
import { getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const submission: OwnerHumanSubmission = {
  decision: "request_input", reason: "need human", nextAction: "answer",
};
type World = { companyId: string; missionId: string; agentId: string; sourceId: string;
  anchorId: string; heartbeatRunId: string; lifetimeId: string };

describeDb("C08 owner request native closeout", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let other: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("c08-owner-close-");
    db = createDb(database.connectionString);
    other = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => {
    await other?.$client.end({ timeout: 5 });
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
  });

  async function world(): Promise<World> {
    const ids = { companyId: randomUUID(), missionId: randomUUID(), agentId: randomUUID(),
      sourceId: randomUUID(), anchorId: randomUUID(), heartbeatRunId: randomUUID() };
    await db.insert(companies).values({ id: ids.companyId, name: "C08 close",
      issuePrefix: `C${ids.companyId.replaceAll("-", "").slice(0, 7)}` });
    await db.insert(agents).values({ id: ids.agentId, companyId: ids.companyId,
      name: "Owner", role: "ceo", status: "active" });
    await db.insert(missions).values({ id: ids.missionId, companyId: ids.companyId,
      ownerAgentId: ids.agentId, title: "Close request", status: "active" });
    await db.insert(issues).values([
      { id: ids.sourceId, companyId: ids.companyId, missionId: ids.missionId,
        title: "Source", status: "blocked" },
      { id: ids.anchorId, companyId: ids.companyId, missionId: ids.missionId,
        title: "Owner action", status: "in_progress", assigneeAgentId: ids.agentId,
        originKind: "mission_main_executor_unblock", originId: ids.sourceId },
    ]);
    await db.insert(heartbeatRuns).values({ id: ids.heartbeatRunId,
      companyId: ids.companyId, agentId: ids.agentId, issueId: ids.anchorId, status: "running" });
    const saved = await db.transaction(async (tx) => {
      const auth = await lockOwnerHumanRequestAuthority(tx, { companyId: ids.companyId,
        missionId: ids.missionId, ownerActionIssueId: ids.anchorId, agentId: ids.agentId,
        heartbeatRunId: ids.heartbeatRunId });
      const decision = await recordMissionOwnerDecision({ db: tx,
        issue: { id: ids.anchorId, companyId: ids.companyId, missionId: ids.missionId },
        submission, sourceIssueId: ids.sourceId, heartbeatRunId: ids.heartbeatRunId });
      return saveOwnerHumanRequest(auth, { schemaVersion: 1, requestKey: randomUUID(),
        expectedCurrentLifetimeId: null, identityMode: "keyed",
        decisionEventId: decision.eventId, submission });
    });
    return { ...ids, lifetimeId: saved.lifetime.lifetimeId };
  }

  async function current(w: World) {
    const [row] = await db.select().from(workflowTransitionEvents).where(eq(
      workflowTransitionEvents.idempotencyKey, ownerHumanCurrentKey({ companyId: w.companyId,
        missionId: w.missionId, target: { kind: "source_issue", issueId: w.sourceId } })));
    return ownerHumanCurrentSchema.parse(row!.payload);
  }

  it("closes the current lifetime in the same native source update transaction", async () => {
    const w = await world();
    await issueService(db).update(w.sourceId, { status: "done" });
    const pointer = await current(w);
    expect(pointer).toMatchObject({ lifetimeId: w.lifetimeId, recoveryNeeded: false,
      closure: { reason: "source_settled" } });
    expect((await db.select().from(issues).where(eq(issues.id, w.sourceId)))[0]!.status).toBe("done");
    expect((await db.select().from(issues).where(eq(issues.id, w.anchorId)))[0]!.status).toBe("in_progress");
  });

  it("rolls back the source update when the current pointer is damaged", async () => {
    const w = await world();
    const key = ownerHumanCurrentKey({ companyId: w.companyId, missionId: w.missionId,
      target: { kind: "source_issue", issueId: w.sourceId } });
    const [row] = await db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.idempotencyKey, key));
    await db.update(workflowTransitionEvents).set({ payload: { ...row!.payload, schemaVersion: 2 } })
      .where(eq(workflowTransitionEvents.id, row!.id));
    await expect(issueService(db).update(w.sourceId, { status: "done" })).rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(issues).where(eq(issues.id, w.sourceId)))[0]!.status).toBe("blocked");
  });

  it("serializes first request creation before source settlement", async () => {
    const w = await world();
    await db.delete(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, w.companyId));
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const authorityLocked = new Promise<void>((resolve) => { locked = resolve; });
    const submit = db.transaction(async (tx) => {
      const auth = await lockOwnerHumanRequestAuthority(tx, { companyId: w.companyId,
        missionId: w.missionId, ownerActionIssueId: w.anchorId, agentId: w.agentId,
        heartbeatRunId: w.heartbeatRunId });
      locked();
      await gate;
      const decision = await recordMissionOwnerDecision({ db: tx,
        issue: { id: w.anchorId, companyId: w.companyId, missionId: w.missionId },
        submission, sourceIssueId: w.sourceId, heartbeatRunId: w.heartbeatRunId });
      return saveOwnerHumanRequest(auth, { schemaVersion: 1, requestKey: "concurrent",
        expectedCurrentLifetimeId: null, identityMode: "keyed",
        decisionEventId: decision.eventId, submission });
    });
    await authorityLocked;
    const settle = issueService(other).update(w.sourceId, { status: "done" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    release();
    const [created] = await Promise.all([submit, settle]);
    expect(await current({ ...w, lifetimeId: created.lifetime.lifetimeId })).toMatchObject({
      lifetimeId: created.lifetime.lifetimeId, recoveryNeeded: false,
      closure: { reason: "source_settled" },
    });
  });

  it("closes a repeatedly renewed lifetime after its source settles", async () => {
    const w = await world();
    const renew = async (anchorId: string, lifetimeId: string, requestKey: string) => {
      const nextAnchorId = randomUUID();
      await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, anchorId));
      await db.insert(issues).values({ id: nextAnchorId, companyId: w.companyId,
        missionId: w.missionId, title: "Renewed owner action", status: "todo",
        assigneeAgentId: w.agentId, originKind: "mission_main_executor_unblock", originId: w.sourceId });
      const saved = await db.transaction(async (tx) => renewOwnerHumanRequest(
        await lockOwnerHumanRequestAuthority(tx, { companyId: w.companyId, missionId: w.missionId,
          ownerActionIssueId: anchorId, agentId: w.agentId, heartbeatRunId: w.heartbeatRunId,
          purpose: "renew", renewal: { previousLifetimeId: lifetimeId, anchorIssueId: nextAnchorId } }),
        { requestKey, expectedCurrentLifetimeId: lifetimeId }));
      return { anchorId: nextAnchorId, lifetimeId: saved.lifetime.lifetimeId };
    };
    const first = await renew(w.anchorId, w.lifetimeId, "renewed-1");
    const second = await renew(first.anchorId, first.lifetimeId, "renewed-2");
    await issueService(db).update(w.sourceId, { status: "done" });
    expect(await current({ ...w, anchorId: second.anchorId, lifetimeId: second.lifetimeId })).toMatchObject({
      lifetimeId: second.lifetimeId, recoveryNeeded: false,
      closure: { reason: "source_settled" },
    });
  });

  it("settles a stale anchor and its current lifetime atomically from a terminal source", async () => {
    const w = await world();
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, w.anchorId));
    await db.update(issues).set({ status: "cancelled", cancelledAt: new Date() })
      .where(eq(issues.id, w.sourceId));
    await createMissionWorkSettlement(db)(w.companyId, w.missionId);
    const pointer = await current(w);
    const [anchor] = await db.select().from(issues).where(eq(issues.id, w.anchorId));
    expect(pointer.closure?.reason).toBe("source_settled");
    expect(pointer.lifetimeId).toBe(w.lifetimeId);
    expect(anchor).toMatchObject({ status: "cancelled", checkoutRunId: null, executionRunId: null });
  });

  it.each([
    { status: "cancelled" as const, reason: "mission_cancelled" },
    { status: "completed" as const, reason: "mission_completed" },
  ])("closes every current mission lifetime inside $status cleanup", async ({ status, reason }) => {
    const w = await world();
    const [snapshot] = await db.select().from(missions).where(eq(missions.id, w.missionId));
    const now = new Date();
    const result = await runMissionTerminalCleanup(db, { companyId: w.companyId,
      missionId: w.missionId, status, now, completedAt: status === "completed" ? now : null,
      missionSnapshot: snapshot!, pendingMissionUpdates: { updatedAt: now,
        ...(status === "completed" ? { completedAt: now } : {}) } });
    expect(result.aborted).toBe(false);
    expect(await current(w)).toMatchObject({ lifetimeId: w.lifetimeId, recoveryNeeded: false,
      closure: { reason } });
    expect((await db.select().from(missions).where(eq(missions.id, w.missionId)))[0]!.status)
      .toBe(status);
  });

  it("rejects terminal cleanup when an existing closure record is corrupt", async () => {
    const w = await world();
    await issueService(db).update(w.sourceId, { status: "done" });
    const pointer = await current(w);
    await db.update(workflowTransitionEvents).set({ payload: { schemaVersion: 2 } })
      .where(eq(workflowTransitionEvents.id, pointer.closure!.eventId));
    const [snapshot] = await db.select().from(missions).where(eq(missions.id, w.missionId));
    await expect(runMissionTerminalCleanup(db, { companyId: w.companyId,
      missionId: w.missionId, status: "cancelled", now: new Date(), completedAt: null,
      missionSnapshot: snapshot!, pendingMissionUpdates: { updatedAt: new Date() } }))
      .rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(missions).where(eq(missions.id, w.missionId)))[0]!.status)
      .toBe("active");
  });
});

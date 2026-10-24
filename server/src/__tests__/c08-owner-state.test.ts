// C08 stage 8 oracle: the accepted plan requires stable keyed replay, CAS replacement and retained
// closure history. These tests execute the new writes against PostgreSQL; fixtures contain only
// initial authority/target facts. API/card resolution/delivery/consumption remain later stages.
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, missions, workflowDefinitions,
  workflowRuns, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { lockOwnerHumanRequestAuthority, type OwnerHumanAuthorityInput } from "../services/missions/owner-human-request-authority.js";
import { closeOwnerHumanRequest, readOwnerHumanCurrent, saveOwnerHumanRequest } from "../services/missions/owner-human-request-state.js";
import { ownerHumanCurrentKey, ownerHumanLifetimeKey, type OwnerHumanSubmission } from "../services/missions/owner-human-request-contract.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
import { ownerHumanRequestSchema } from "@paperclipai/shared/validators/owner-human-request";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const A: OwnerHumanSubmission = { decision: "request_input", reason: "A", nextAction: "사람 확인", evidence: "원천 근거" };
const B: OwnerHumanSubmission = { ...A, reason: "B" };
type World = { companyId: string; missionId: string; agentId: string; ownerActionIssueId: string; heartbeatRunId: string; sourceId: string };

describeDb("C08 owner human request durable state", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let other: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("c08-owner-state-");
    db = createDb(database.connectionString);
    other = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => {
    await other?.$client.end({ timeout: 5 });
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
  });

  async function world(oversight = false): Promise<World> {
    const w = { companyId: randomUUID(), missionId: randomUUID(), agentId: randomUUID(),
      ownerActionIssueId: randomUUID(), heartbeatRunId: randomUUID(), sourceId: randomUUID() };
    await db.insert(companies).values({ id: w.companyId, name: "C08", issuePrefix: randomUUID() });
    await db.insert(agents).values({ id: w.agentId, companyId: w.companyId, name: "Owner", status: "active" });
    await db.insert(missions).values({ id: w.missionId, companyId: w.companyId, ownerAgentId: w.agentId, title: "C08", status: "active" });
    await db.insert(issues).values([
      { id: w.sourceId, companyId: w.companyId, missionId: w.missionId, title: "Source", status: "blocked" },
      { id: w.ownerActionIssueId, companyId: w.companyId, missionId: w.missionId, title: "Owner action", status: "in_progress",
        assigneeAgentId: w.agentId, originKind: oversight ? "mission_main_executor_oversight" : "mission_main_executor_unblock",
        originId: oversight ? null : w.sourceId },
    ]);
    await db.insert(heartbeatRuns).values({ id: w.heartbeatRunId, companyId: w.companyId,
      agentId: w.agentId, issueId: w.ownerActionIssueId, status: "running" });
    return w;
  }
  async function sibling(w: World, sourceId = w.sourceId): Promise<World> {
    const next = { ...w, sourceId, ownerActionIssueId: randomUUID(), heartbeatRunId: randomUUID() };
    await db.insert(issues).values({ id: next.ownerActionIssueId, companyId: w.companyId, missionId: w.missionId,
      title: "Next anchor", status: "in_progress", assigneeAgentId: w.agentId,
      originKind: "mission_main_executor_unblock", originId: sourceId });
    await db.insert(heartbeatRuns).values({ id: next.heartbeatRunId, companyId: w.companyId,
      agentId: w.agentId, issueId: next.ownerActionIssueId, status: "running" });
    return next;
  }
  const context = (w: World, submission = A): OwnerHumanAuthorityInput => ({ companyId: w.companyId,
    missionId: w.missionId, ownerActionIssueId: w.ownerActionIssueId, agentId: w.agentId,
    heartbeatRunId: w.heartbeatRunId, recoveryTarget: submission.recoveryTarget });
  async function write(w: World, key: string, expected: string | null = null, submission = A,
    options: { connection?: Db; eventId?: string; failAfter?: boolean; context?: Partial<OwnerHumanAuthorityInput> } = {}) {
    return (options.connection ?? db).transaction(async (tx) => {
      const auth = await lockOwnerHumanRequestAuthority(tx, { ...context(w, submission), ...options.context });
      const eventId = options.eventId ?? (await recordMissionOwnerDecision({ db: tx,
        issue: { id: w.ownerActionIssueId, companyId: w.companyId, missionId: w.missionId },
        submission, sourceIssueId: auth.source?.id ?? null, heartbeatRunId: w.heartbeatRunId })).eventId;
      const saved = await saveOwnerHumanRequest(auth, { schemaVersion: 1, requestKey: key,
        expectedCurrentLifetimeId: expected, identityMode: "keyed", decisionEventId: eventId, submission });
      if (options.failAfter) throw new Error("rollback after all state writes");
      return saved;
    });
  }
  const current = (w: World, submission = A, connection = db) => connection.transaction(async (tx) =>
    readOwnerHumanCurrent(await lockOwnerHumanRequestAuthority(tx, context(w, submission))));
  const events = (w: World) => db.select().from(workflowTransitionEvents)
    .where(eq(workflowTransitionEvents.companyId, w.companyId));

  it("inserts a real origin/lifetime/pointer and returns the original immutable snapshot on exact replay", async () => {
    const w = await world();
    expect(await events(w)).toHaveLength(0);
    const first = await write(w, "key:A");
    await db.update(issues).set({ title: "Changed display title", status: "blocked" }).where(eq(issues.id, w.ownerActionIssueId));
    const replay = await write(w, "key:A");
    expect(replay).toEqual(first);
    expect(replay.lifetime.cardInput.issueTitle).toBe("Owner action");
    expect((await events(w)).map((row) => row.eventType).sort()).toEqual([
      "mission_owner_decision", "owner_human_current_v1", "owner_human_lifetime_v1"].sort());
    expect(await current(w, A, other)).toEqual(first);
  });

  // Public nonblank keys have no length cap; adopted C08 plan:50–54 requires exact replay
  // and same-key/different-body rejection. Random base64 exposes the old PostgreSQL index limit.
  it("stores a public-valid 12000-byte key, preserves it and rejects a conflicting replay", async () => {
    const w = await world();
    const requestKey = randomBytes(9000).toString("base64");
    expect(Buffer.byteLength(requestKey, "utf8")).toBe(12000);
    expect(ownerHumanRequestSchema.safeParse({
      schemaVersion: 1, requestKey, expectedCurrentLifetimeId: null,
    }).success).toBe(true);
    expect(await events(w)).toHaveLength(0);
    const first = await write(w, requestKey);
    expect(first.lifetime.requestKey).toBe(requestKey);
    expect(first.pointer.requestKey).toBe(requestKey);
    const stored = await events(w);
    expect(stored).toHaveLength(3);
    expect(stored.find((row) => row.id === first.lifetime.lifetimeId)!.payload.requestKey).toBe(requestKey);
    expect(stored.find((row) => row.id === first.pointerEventId)!.payload.requestKey).toBe(requestKey);
    expect(await write(w, requestKey)).toEqual(first);
    expect(await current(w, A, other)).toEqual(first);
    expect(await events(w)).toEqual(stored);
    await expect(write(w, requestKey, first.lifetime.lifetimeId, B)).rejects.toMatchObject({
      status: 409, details: { reason: "owner_human_request_key_conflict" } });
    expect(await events(w)).toEqual(stored);
    expect(await current(w)).toEqual(first);
  });

  it("keeps identity across a new heartbeat and anchor for the same actual source", async () => {
    const w = await world();
    const first = await write(w, "stable");
    const next = await sibling(w);
    const replay = await write(next, "stable", null, A, { eventId: first.lifetime.decisionEventId });
    expect(replay).toEqual(first);
    expect(await current(next)).toEqual(first);
    expect((await events(w)).filter((row) => row.eventType === "owner_human_lifetime_v1")).toHaveLength(1);
  });

  it("replaces A→B→A with distinct lifetimes and refuses an old key or stale CAS", async () => {
    const w = await world();
    const a = await write(w, "A1");
    const b = await write(w, "B", a.lifetime.lifetimeId, B);
    await expect(write(w, "stale", a.lifetime.lifetimeId, { ...A, reason: "C" })).rejects.toMatchObject({ status: 409 });
    await expect(write(w, "A1", b.lifetime.lifetimeId)).rejects.toMatchObject({ status: 409 });
    const a2 = await write(w, "A2", b.lifetime.lifetimeId);
    expect(new Set([a.lifetime.lifetimeId, b.lifetime.lifetimeId, a2.lifetime.lifetimeId]).size).toBe(3);
    expect(a2.pointer.revision).toBe(3);
    const history = await events(w);
    expect(history.filter((row) => row.eventType === "owner_human_lifetime_v1")).toHaveLength(3);
    expect(history.filter((row) => row.eventType === "owner_human_end_v1")).toHaveLength(2);
    expect(await current(w)).toEqual(a2);
  });

  it("rejects a different body under the same key without changing current state", async () => {
    const w = await world();
    const first = await write(w, "same");
    const before = await events(w);
    await expect(write(w, "same", first.lifetime.lifetimeId, B)).rejects.toMatchObject({
      status: 409, details: { reason: "owner_human_request_key_conflict" } });
    expect(await events(w)).toEqual(before);
    expect(await current(w)).toEqual(first);
  });

  it("serializes two PostgreSQL connections so only one replacement wins the same CAS", async () => {
    const w = await world();
    const a = await write(w, "initial");
    const results = await Promise.allSettled([
      write(w, "left", a.lifetime.lifetimeId, B),
      write(w, "right", a.lifetime.lifetimeId, { ...A, reason: "C" }, { connection: other }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const history = await events(w);
    expect(history.filter((row) => row.eventType === "owner_human_lifetime_v1")).toHaveLength(2);
    expect(history.filter((row) => row.eventType === "owner_human_end_v1")).toHaveLength(1);
    expect((await current(w))!.pointer.revision).toBe(2);
  });

  it("rejects company, mission, author and heartbeat mismatches", async () => {
    const w = await world(), foreign = await world();
    const first = await write(w, "A");
    for (const mismatch of [{ companyId: foreign.companyId }, { missionId: foreign.missionId },
      { agentId: foreign.agentId }, { heartbeatRunId: foreign.heartbeatRunId }]) {
      await expect(write(w, "bad", first.lifetime.lifetimeId, B, { context: mismatch })).rejects.toMatchObject({ status: 409 });
    }
    expect(await current(w)).toEqual(first);
  });

  it("does not let a company key cross actual logical targets or use prose as a missing source", async () => {
    const w = await world();
    const first = await write(w, "scoped");
    const sourceId = randomUUID();
    await db.insert(issues).values({ id: sourceId, companyId: w.companyId, missionId: w.missionId, title: "Other source", status: "blocked" });
    const different = await sibling(w, sourceId);
    await expect(write(different, "scoped")).rejects.toMatchObject({ status: 409 });
    await db.update(issues).set({ originId: null, description: `sourceIssueRef=${w.sourceId}` })
      .where(eq(issues.id, different.ownerActionIssueId));
    await expect(write(different, "missing", null, { ...A, sourceIssueRef: w.sourceId })).rejects.toMatchObject({ status: 409 });
    expect(await current(w)).toEqual(first);
  });

  it("uses mission oversight scope and preserves its recovery-target prohibition", async () => {
    const w = await world(true);
    const first = await write(w, "oversight");
    expect(first.lifetime.scope.target).toEqual({ kind: "oversight" });
    expect(first.lifetime.sourceIssueId).toBeNull();
    await expect(write(w, "invalid", first.lifetime.lifetimeId, {
      ...A, recoveryTarget: { kind: "issue", issueId: w.sourceId } })).rejects.toMatchObject({ status: 409 });
    expect(await current(w)).toEqual(first);
  });

  it("requires a validated tool-card link and the exact real run/step", async () => {
    const w = await world();
    const [definition] = await db.insert(workflowDefinitions).values({ companyId: w.companyId, name: "C08 tool", stepsJson: [] }).returning();
    const [run] = await db.insert(workflowRuns).values({ companyId: w.companyId, missionId: w.missionId,
      workflowId: definition!.id, triggeredBy: "test", status: "failed" }).returning();
    const [step] = await db.insert(workflowStepRuns).values({ workflowRunId: run!.id, stepId: "tool", status: "failed" }).returning();
    const body: OwnerHumanSubmission = { ...A, recoveryTarget: { kind: "tool_step", workflowRunId: run!.id,
      stepRunId: step!.id, expectedAuthorityVersion: 0, expectedExecutionGeneration: 0, failedDispatchRequestId: null } };
    await expect(write(w, "unlinked", null, body)).rejects.toMatchObject({ status: 409 });
    const [link] = await db.insert(workflowTransitionEvents).values({ companyId: w.companyId, missionId: w.missionId,
      issueId: w.ownerActionIssueId, workflowRunId: run!.id, workflowStepRunId: step!.id,
      eventType: "owner_tool_recovery_target_v1", layer: "mission_owner_recovery", idempotencyKey: `owner-tool-card:${step!.id}`,
      payload: { schemaVersion: 1, kind: "tool_step", workflowRunId: run!.id, stepRunId: step!.id } }).returning();
    const saved = await write(w, "tool", null, body);
    expect(saved.lifetime.scope.target).toEqual({ kind: "tool_step", workflowRunId: run!.id, stepRunId: step!.id });
    await expect(write(w, "wrong-step", saved.lifetime.lifetimeId, { ...body,
      recoveryTarget: { ...body.recoveryTarget as Extract<NonNullable<OwnerHumanSubmission["recoveryTarget"]>, { kind: "tool_step" }>, stepRunId: randomUUID() } })).rejects.toMatchObject({ status: 409 });
    await db.update(workflowTransitionEvents).set({ payload: { schemaVersion: 2 } }).where(eq(workflowTransitionEvents.id, link!.id));
    await expect(current(w, body)).rejects.toMatchObject({ status: 409 });
  });

  it.each(["pointer", "missing-lifetime", "lifetime", "origin", "card"])("rejects damaged %s instead of falling back to A", async (damage) => {
    const w = await world();
    const a = await write(w, "A"), b = await write(w, "B", a.lifetime.lifetimeId, B);
    const id = damage === "origin" ? b.lifetime.decisionEventId
      : damage === "pointer" || damage === "missing-lifetime" ? b.pointerEventId : b.lifetime.lifetimeId;
    const [row] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, id));
    const payload = damage === "missing-lifetime" ? { ...row!.payload, lifetimeId: randomUUID() }
      : damage === "origin" ? { ...row!.payload, reason: "Changed origin" }
      : damage === "card" ? { ...row!.payload, cardInput: { ...b.lifetime.cardInput, requestedByAgentId: randomUUID() } }
      : { ...row!.payload, schemaVersion: 2 };
    await db.update(workflowTransitionEvents).set({ payload }).where(eq(workflowTransitionEvents.id, id));
    await expect(current(w)).rejects.toMatchObject({ status: 409 });
    await expect(write(w, "C", b.lifetime.lifetimeId, { ...A, reason: "C" })).rejects.toMatchObject({ status: 409 });
    expect((await events(w)).find((event) => event.id === a.lifetime.lifetimeId)!.payload).toEqual(a.lifetime);
  });

  it("rolls back original decision, lifetime, ending and pointer together", async () => {
    const w = await world();
    await expect(write(w, "first", null, A, { failAfter: true })).rejects.toThrow("rollback after all state writes");
    expect(await events(w)).toHaveLength(0);
    const a = await write(w, "A");
    const before = await events(w);
    await expect(write(w, "B", a.lifetime.lifetimeId, B, { failAfter: true })).rejects.toThrow("rollback after all state writes");
    expect(await events(w)).toEqual(before);
    expect(await current(w)).toEqual(a);
  });

  it("closes only after actual settlement, retains the last lifetime and requires a new recurrence key", async () => {
    const w = await world();
    const a = await write(w, "A");
    const close = (settle: boolean) => db.transaction(async (tx) => {
      const auth = await lockOwnerHumanRequestAuthority(tx, { ...context(w), purpose: "settle" });
      if (settle) await tx.update(issues).set({ status: "done" }).where(eq(issues.id, w.sourceId));
      return closeOwnerHumanRequest(auth, a.lifetime.lifetimeId);
    });
    await expect(close(false)).rejects.toMatchObject({ details: { reason: "owner_human_request_recovery_still_needed" } });
    const closed = await close(true);
    expect(closed.pointer.lifetimeId).toBe(a.lifetime.lifetimeId);
    expect(closed.pointer.recoveryNeeded).toBe(false);
    expect(closed.pointer.closure?.reason).toBe("source_settled");
    expect(closed.lifetime).toEqual(a.lifetime);
    expect(await close(false)).toEqual(closed);
    await expect(write(w, "A", a.lifetime.lifetimeId)).rejects.toMatchObject({ status: 409 });
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, w.sourceId));
    const next = await write(w, "A-recurrence", a.lifetime.lifetimeId);
    expect(next.lifetime.lifetimeId).not.toBe(a.lifetime.lifetimeId);
    expect(next.pointer.recoveryNeeded).toBe(true);
    const retained = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, w.companyId),
      eq(workflowTransitionEvents.idempotencyKey, ownerHumanLifetimeKey("A"))));
    expect(retained[0]!.payload).toEqual(a.lifetime);
    expect(ownerHumanCurrentKey(next.lifetime.scope)).toBe(ownerHumanCurrentKey(a.lifetime.scope));
  });
});

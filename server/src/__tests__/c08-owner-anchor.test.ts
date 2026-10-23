// C08 plan:112–129: distinguish the old terminal-anchor reuse from actual producer renewal.
// Only initial scope/owner/heartbeat facts are fixtures. Submission, cards and renewal are native.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issues, missions,
  operatorDecisions, operatorDecisionContinuations, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import type { MissionServiceDeps } from "../services/missions.js";
import { createOwnerActions } from "../services/missions/owner-actions.js";
import { submitMissionOwnerDecision } from "../services/missions/mission-owner-recovery-agent-api.js";
import { readOwnerHumanRequest } from "../services/missions/owner-human-request-read.js";
import { ownerHumanCurrentKey, ownerHumanLifetimeSchema } from "../services/missions/owner-human-request-contract.js";
import { lockOwnerHumanRequestAuthority } from "../services/missions/owner-human-request-authority.js";
import { closeOwnerHumanRequest } from "../services/missions/owner-human-request-state.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const submission = { decision: "request_input" as const, reason: "원작성 요청",
  nextAction: "사람 확인", evidence: "원작성 근거" };

describeDb("C08 source anchor producer", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db, other: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("c08-owner-anchor-");
    db = createDb(database.connectionString); other = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => {
    await other?.$client.end({ timeout: 5 }); await db?.$client.end({ timeout: 5 }); await database?.cleanup();
  });
  async function world(human = true, legacy = false, terminal = true, sourceStatus = "blocked") {
    const companyId = randomUUID(), missionId = randomUUID(), agentId = randomUUID(),
      sourceId = randomUUID(), oldId = randomUUID(), heartbeatId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "C08 producer", issuePrefix: randomUUID(),
      requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", status: "active" });
    const [mission] = await db.insert(missions).values({ id: missionId, companyId,
      ownerAgentId: agentId, title: "Source recovery", status: "active" }).returning();
    const [source] = await db.insert(issues).values({ id: sourceId, companyId, missionId,
      title: "Source", status: sourceStatus }).returning();
    await db.insert(issues).values({ id: oldId, companyId, missionId, title: "Old anchor", status: "todo",
      assigneeAgentId: agentId, originKind: "mission_main_executor_unblock", originId: sourceId });
    await db.insert(heartbeatRuns).values({ id: heartbeatId, companyId, agentId, issueId: oldId, status: "running" });
    await issueService(db).checkout(oldId, agentId, ["todo"], heartbeatId);
    const actor = { actorType: "agent" as const, actorId: agentId, agentId, runId: heartbeatId };
    if (human) await submitMissionOwnerDecision({ db, issueId: oldId, actor, data: {
      ...submission, ...(legacy ? {} : { humanRequest: { schemaVersion: 1 as const,
        requestKey: randomUUID(), expectedCurrentLifetimeId: null } }),
    } });
    if (terminal) await issueService(db).update(oldId, { status: "cancelled" });
    return { companyId, missionId, agentId, sourceId, oldId, heartbeatId, mission: mission!, source: source!, actor };
  }
  type World = Awaited<ReturnType<typeof world>>;
  const produce = (w: World, connection = db, deps: MissionServiceDeps = {}) =>
    createOwnerActions({ db: connection, deps }).ensureMainExecutorUnblockIssue(w.mission, w.source);
  const events = (w: World) => db.select().from(workflowTransitionEvents)
    .where(eq(workflowTransitionEvents.companyId, w.companyId)).orderBy(workflowTransitionEvents.id);
  const cards = (w: World) => db.select().from(operatorDecisions)
    .where(eq(operatorDecisions.companyId, w.companyId)).orderBy(operatorDecisions.id);
  const anchors = (w: World) => db.select().from(issues).where(and(
    eq(issues.companyId, w.companyId), eq(issues.originKind, "mission_main_executor_unblock"),
    eq(issues.originId, w.sourceId))).orderBy(issues.id);
  const snapshot = (w: World) => Promise.all([events(w), cards(w),
    db.select().from(issues).where(eq(issues.companyId, w.companyId)).orderBy(issues.id),
    db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, w.companyId)).orderBy(heartbeatRuns.id),
    db.select().from(operatorDecisionContinuations).where(eq(operatorDecisionContinuations.companyId, w.companyId)),
    db.select().from(activityLog).where(eq(activityLog.companyId, w.companyId)).orderBy(activityLog.id),
    db.select().from(companies).where(eq(companies.id, w.companyId)),
    db.select().from(missions).where(eq(missions.id, w.missionId))]);
  const currentRow = async (w: World) => (await events(w)).find((row) => row.idempotencyKey === ownerHumanCurrentKey({
    companyId: w.companyId, missionId: w.missionId, target: { kind: "source_issue", issueId: w.sourceId },
  }))!;
  const currentLifetime = async (w: World) => {
    const pointer = await currentRow(w);
    return ownerHumanLifetimeSchema.parse((await events(w)).find((row) =>
      row.id === pointer.payload!.lifetimeId)!.payload);
  };

  it("creates one new anchor/lifetime/key/pending card and preserves original author, bytes and history", async () => {
    const w = await world(), old = await currentLifetime(w), before = await snapshot(w);
    const next = await produce(w), now = await currentLifetime(w);
    expect(next.id).not.toBe(w.oldId);
    expect(next).toMatchObject({ status: "todo", originKind: "mission_main_executor_unblock",
      originId: w.sourceId, assigneeAgentId: w.agentId });
    expect((await anchors(w)).filter((row) => !["done", "cancelled"].includes(row.status))).toHaveLength(1);
    expect(now.lifetimeId).not.toBe(old.lifetimeId);
    expect(now.requestKey).not.toBe(old.requestKey);
    expect(now).toMatchObject({ anchorIssueId: next.id, heartbeatRunId: w.heartbeatId,
      authorAgentId: w.agentId, submission, decisionEventId: old.decisionEventId,
      renewal: { schemaVersion: 1, previousLifetimeId: old.lifetimeId } });
    expect((await currentRow(w)).payload).toMatchObject({ recoveryNeeded: true, revision: 2,
      lifetimeId: now.lifetimeId, anchorIssueId: next.id });
    expect((await cards(w)).find((row) => row.issueId === next.id)).toMatchObject({
      status: "pending", result: null, resolvedAt: null, cancelledAt: null,
      requestKey: `moi2:${now.lifetimeId}`, sourceId: old.decisionEventId });
    const after = await snapshot(w);
    for (const row of before[0].filter((row) => row.eventType !== "owner_human_current_v1")) {
      expect(after[0].find((event) => event.id === row.id)).toEqual(row);
    }
    expect(after[1].find((row) => row.id === before[1][0]!.id)).toEqual(before[1][0]);
    expect(after[3]).toEqual(before[3]); expect(after[4]).toEqual(before[4]);
    expect(after[2].find((row) => row.id === w.oldId)).toEqual(before[2].find((row) => row.id === w.oldId));
    expect(after[0].filter((row) => row.eventType === "mission_owner_decision")).toHaveLength(1);
  });

  it("serializes independent connections, replays after response loss and notifies only after commit", async () => {
    const w = await world();
    const notify = vi.fn<NonNullable<MissionServiceDeps["onOwnerActionCreated"]>>(async ({ issue }) => {
      const [stored] = await other.select().from(issues).where(eq(issues.id, issue.id));
      const linked = await other.select().from(operatorDecisions).where(eq(operatorDecisions.issueId, issue.id));
      expect(stored?.id).toBe(issue.id); expect(linked).toHaveLength(1);
    });
    const [a, b] = await Promise.all([
      produce(w, db, { onOwnerActionCreated: notify }), produce(w, other, { onOwnerActionCreated: notify }),
    ]);
    expect(a.id).toBe(b.id); expect(notify).toHaveBeenCalledTimes(1);
    await Promise.all(notify.mock.results.map((result) => result.value));
    const before = await snapshot(w);
    expect((await produce(w, other, { onOwnerActionCreated: notify })).id).toBe(a.id);
    expect(await snapshot(w)).toEqual(before); expect(notify).toHaveBeenCalledTimes(1);
    expect((await anchors(w))).toHaveLength(2); expect(await cards(w)).toHaveLength(2);
  });

  it("rolls the anchor, issue counter, lifetime, ending, pointer, card and audit back on real link write failure", async () => {
    const w = await world(), before = await snapshot(w), notify = vi.fn();
    // Owned isolated DB only; the real writer reaches this CHECK after creating its card.
    await db.execute(sql.raw(`alter table workflow_transition_events add constraint c08_anchor_injected
      check (company_id <> '${w.companyId}' or event_type <> 'owner_human_card_v1') not valid`));
    try {
      await expect(produce(w, db, { onOwnerActionCreated: notify })).rejects.toThrow();
      expect(await snapshot(w)).toEqual(before); expect(notify).not.toHaveBeenCalled();
    } finally {
      await db.execute(sql.raw("alter table workflow_transition_events drop constraint c08_anchor_injected"));
    }
    const next = await produce(w);
    expect(next.id).not.toBe(w.oldId); expect(await cards(w)).toHaveLength(2);
  });

  it("retains real past approval/result/continuation and gives the renewed request a pending card", async () => {
    const w = await world(true, false, false, "todo"), [oldCard] = await cards(w);
    await operatorDecisionWriteService(db).resolve(oldCard!.id,
      { actionId: "approve", selectedOptionIds: ["approve"], comment: "과거 승인" }, "board");
    await issueService(db).update(w.oldId, { status: "done" });
    await issueService(db).update(w.sourceId, { status: "blocked" });
    const before = await snapshot(w), next = await produce(w), after = await snapshot(w);
    expect(after[1].find((row) => row.id === oldCard!.id)).toEqual(before[1][0]);
    expect(after[4]).toEqual(before[4]); expect(after[3]).toEqual(before[3]);
    expect(after[1].find((row) => row.issueId === next.id)).toMatchObject({ status: "pending", result: null });
  });

  it("current GET and exact POST replay use the renewed anchor while retaining the original decision", async () => {
    const w = await world(), old = await currentLifetime(w), next = await produce(w), runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: w.companyId, agentId: w.agentId,
      issueId: next.id, status: "running" }); // Current caller identity only.
    await issueService(db).checkout(next.id, w.agentId, ["todo"], runId);
    const actor = { ...w.actor, runId };
    const projection = await readOwnerHumanRequest({ db, companyId: w.companyId, issueId: next.id, actor });
    expect(projection.anchorIssueId).toBe(next.id); expect(projection.card?.status).toBe("pending");
    expect(projection.resubmit).toMatchObject(submission);
    const replay = await submitMissionOwnerDecision({ db, issueId: next.id, actor, data: projection.resubmit! });
    expect(replay).toMatchObject({ eventId: old.decisionEventId, lifetimeId: projection.lifetimeId,
      operatorDecisionId: projection.card!.id, submission });
    expect(await cards(w)).toHaveLength(2);
    expect((await events(w)).filter((row) => row.eventType === "mission_owner_decision")).toHaveLength(1);
  });

  it("reuses the one open current anchor even when an older terminal anchor sorts first", async () => {
    const w = await world(), next = await produce(w), before = await snapshot(w);
    expect((await produce(w)).id).toBe(next.id); expect(await snapshot(w)).toEqual(before);
    await issueService(db).update(next.id, { status: "cancelled" });
    const second = await produce(w);
    expect(second.id).not.toBe(next.id); expect((await currentRow(w)).payload!.revision).toBe(3);
    expect((await currentLifetime(w)).heartbeatRunId).toBe(w.heartbeatId);
  });

  it("keeps nonhuman blockers and legacy human input working without inventing a new submission", async () => {
    const nonhuman = await world(false);
    await db.update(issues).set({ originRunId: "legacy-plugin-run" }).where(eq(issues.id, nonhuman.sourceId));
    const fresh = await produce(nonhuman);
    expect(fresh.id).not.toBe(nonhuman.oldId); expect(await cards(nonhuman)).toHaveLength(0);
    expect((await events(nonhuman)).filter((row) => row.eventType === "owner_human_lifetime_v1")).toHaveLength(0);
    const legacy = await world(true, true), old = await currentLifetime(legacy), next = await produce(legacy);
    expect((await currentLifetime(legacy))).toMatchObject({ identityMode: "keyed", anchorIssueId: next.id,
      decisionEventId: old.decisionEventId, heartbeatRunId: old.heartbeatRunId });
    expect((await cards(legacy)).find((row) => row.issueId === legacy.oldId)?.requestKey).toMatch(/^moi1:/);
  });

  it("does not copy a closed recovery pointer when the source becomes blocked again", async () => {
    const w = await world();
    await issueService(db).update(w.sourceId, { status: "done" });
    const lifetime = await currentLifetime(w);
    await db.transaction(async (tx) => {
      const auth = await lockOwnerHumanRequestAuthority(tx, { companyId: w.companyId, missionId: w.missionId,
        ownerActionIssueId: w.oldId, agentId: w.agentId, heartbeatRunId: w.heartbeatId, purpose: "settle" });
      await closeOwnerHumanRequest(auth, lifetime.lifetimeId);
    });
    await issueService(db).update(w.sourceId, { status: "blocked" });
    const before = await snapshot(w);
    expect((await produce(w)).id).toBe(w.oldId); expect(await snapshot(w)).toEqual(before);
  });

  it("preserves legacy open unassigned anchors for the existing supervision wake path", async () => {
    const w = await world(false, false, false);
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, w.oldId));
    const before = await snapshot(w);
    expect((await produce(w)).id).toBe(w.oldId); expect(await snapshot(w)).toEqual(before);
  });

  it("never revives a settled source, cancelled/completed mission, lost owner or nonblocked human request", async () => {
    for (const mode of ["source_done", "source_cancelled", "cancelled", "completed", "owner", "todo"] as const) {
      const w = await world();
      if (mode.startsWith("source_") || mode === "todo") {
        await issueService(db).update(w.sourceId, { status: mode === "todo" ? "todo" : mode.slice(7) });
      } else if (mode === "owner") {
        const replacement = randomUUID();
        await db.insert(agents).values({ id: replacement, companyId: w.companyId, name: "New owner", status: "active" });
        await db.update(missions).set({ ownerAgentId: replacement }).where(eq(missions.id, w.missionId));
      } else {
        await db.update(missions).set({ status: mode }).where(eq(missions.id, w.missionId));
      }
      const before = await snapshot(w);
      if (mode.startsWith("source_") || mode === "todo") expect((await produce(w)).id).toBe(w.oldId);
      else await expect(produce(w)).rejects.toMatchObject({ status: 409 });
      if (mode === "owner") {
        const [mission] = await db.select().from(missions).where(eq(missions.id, w.missionId));
        await expect(produce({ ...w, mission: mission! })).rejects.toMatchObject({ status: 409 });
      }
      expect(await snapshot(w)).toEqual(before);
    }
  });

  it("rejects multiple open anchors and missing/corrupt current authority without cleanup or historical fallback", async () => {
    for (const mode of ["multiple", "missing", "corrupt"] as const) {
      const w = await world(true, false, mode !== "multiple");
      if (mode === "multiple") {
        await db.insert(issues).values({ id: randomUUID(), companyId: w.companyId, missionId: w.missionId,
          title: "Ambiguous anchor", status: "todo", assigneeAgentId: w.agentId,
          originKind: "mission_main_executor_unblock", originId: w.sourceId });
      } else {
        const pointer = await currentRow(w);
        if (mode === "missing") await db.delete(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, pointer.id));
        else await db.update(workflowTransitionEvents).set({ payload: { schemaVersion: 99 } })
          .where(eq(workflowTransitionEvents.id, pointer.id));
      }
      const before = await snapshot(w);
      await expect(produce(w)).rejects.toMatchObject({ status: 409 });
      expect(await snapshot(w)).toEqual(before);
    }
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issues, missions,
  operatorDecisionContinuations, operatorDecisions, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { lockOwnerHumanRequestAuthority } from "../services/missions/owner-human-request-authority.js";
import { saveOwnerHumanRequest, type OwnerHumanCurrentRecord } from "../services/missions/owner-human-request-state.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
import { createMissionOwnerHumanInputDecisionCard } from "../services/missions/mission-owner-human-input-card.js";
import { operatorDecisionContinuationStore } from "../services/operator-decision-continuation-store.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
import { publishLiveEvent } from "../services/live-events.js";

vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
type World = { companyId: string; missionId: string; agentId: string; anchorId: string;
  sourceId: string; heartbeatRunId: string };

describeDb("C08 owner response initial heartbeat admission", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("c08-owner-admission-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
  });

  async function world(): Promise<World> {
    const w = { companyId: randomUUID(), missionId: randomUUID(), agentId: randomUUID(),
      anchorId: randomUUID(), sourceId: randomUUID(), heartbeatRunId: randomUUID() };
    await db.insert(companies).values({ id: w.companyId, name: "C08 admission", issuePrefix: randomUUID() });
    await db.insert(agents).values({ id: w.agentId, companyId: w.companyId, name: "Owner", status: "active" });
    await db.insert(missions).values({ id: w.missionId, companyId: w.companyId,
      ownerAgentId: w.agentId, title: "C08 admission", status: "active" });
    await db.insert(issues).values([
      { id: w.sourceId, companyId: w.companyId, missionId: w.missionId, title: "Source", status: "blocked" },
      { id: w.anchorId, companyId: w.companyId, missionId: w.missionId, title: "Owner action",
        status: "in_progress", assigneeAgentId: w.agentId,
        originKind: "mission_main_executor_unblock", originId: w.sourceId },
    ]);
    await db.insert(heartbeatRuns).values({ id: w.heartbeatRunId, companyId: w.companyId,
      agentId: w.agentId, issueId: w.anchorId, status: "running" });
    return w;
  }

  const authority = (w: World) => ({ companyId: w.companyId, missionId: w.missionId,
    ownerActionIssueId: w.anchorId, agentId: w.agentId, heartbeatRunId: w.heartbeatRunId });
  async function request(w: World, key: string, expected: string | null = null) {
    return db.transaction(async (tx) => {
      const auth = await lockOwnerHumanRequestAuthority(tx, authority(w));
      const submission = { decision: "request_input" as const, reason: key, nextAction: "Continue", evidence: "Evidence" };
      const original = await recordMissionOwnerDecision({ db: tx,
        issue: { id: w.anchorId, companyId: w.companyId, missionId: w.missionId },
        submission, sourceIssueId: w.sourceId, heartbeatRunId: w.heartbeatRunId });
      return saveOwnerHumanRequest(auth, { schemaVersion: 1, requestKey: key,
        expectedCurrentLifetimeId: expected, identityMode: "keyed", decisionEventId: original.eventId, submission });
    });
  }
  async function resolvedDelivery(w: World) {
    const saved = await request(w, "request:A");
    const created = await createMissionOwnerHumanInputDecisionCard(db, {
      ...saved.lifetime.cardInput, lifetimeId: saved.lifetime.lifetimeId,
    });
    const result = { actionId: "approve", selectedOptionIds: ["approve"], comment: "approved" };
    await operatorDecisionWriteService(db).resolve(created.decision.id, result, "board");
    const store = operatorDecisionContinuationStore(db);
    const [claimed] = await store.claimBatch("admission-worker", new Date());
    const targeted = await store.setTarget(claimed!.id, "admission-worker", w.agentId, {
      generation: claimed!.generation, attemptCount: claimed!.attemptCount,
      idempotencyKey: claimed!.idempotencyKey!, issueId: claimed!.issueId!,
    });
    const summary = { operatorDecisionId: created.decision.id,
      options: [{ id: "approve", label: "승인", description: "요청된 다음 단계를 승인합니다" }] };
    return { saved, decision: created.decision, targeted: targeted!, options: {
      source: "automation" as const, triggerDetail: "system" as const,
      reason: "operator_decision_resolved" as const,
      payload: { kind: "operator_decision_resolution", operatorDecisionId: created.decision.id,
        issueId: w.anchorId, actionId: "approve", selectedOptionIds: ["approve"],
        paperclipOperatorDecisionResolution: summary },
      contextSnapshot: { issueId: w.anchorId, missionId: w.missionId,
        wakeReason: "operator_decision_resolved", operatorDecisionId: created.decision.id,
        paperclipOperatorDecisionResolution: summary },
      requestedByActorType: "user" as const, requestedByActorId: "board",
      idempotencyKey: targeted!.idempotencyKey!,
    } };
  }

  async function blockMissionQueue(w: World) {
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, w.heartbeatRunId));
    const [blocker] = await db.insert(heartbeatRuns).values({ companyId: w.companyId,
      agentId: w.agentId, issueId: w.sourceId, status: "running",
      contextSnapshot: { issueId: w.sourceId, missionId: w.missionId },
    }).returning();
    return blocker!;
  }

  async function deferredDelivery(w: World) {
    const delivery = await resolvedDelivery(w);
    await db.update(issues).set({ executionRunId: w.heartbeatRunId,
      checkoutRunId: w.heartbeatRunId, executionAgentNameKey: "owner",
    }).where(eq(issues.id, w.anchorId));
    await heartbeatService(db).wakeup(w.agentId, delivery.options);
    const [wake] = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, w.companyId));
    expect(wake).toMatchObject({ status: "deferred_issue_execution", runId: null });
    return { delivery, wake: wake! };
  }

  it("rejects a forged issued key before inserting a wake request", async () => {
    const w = await world(), delivery = await resolvedDelivery(w);
    await expect(heartbeatService(db).wakeup(w.agentId, {
      ...delivery.options, idempotencyKey: `${delivery.options.idempotencyKey}:forged`,
    })).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, w.companyId))).toHaveLength(0);
    expect((await db.select().from(operatorDecisionContinuations)
      .where(eq(operatorDecisionContinuations.id, delivery.targeted.id)))[0]).toMatchObject({ state: "leased" });
  });

  it("rejects paused, stripped, and altered owner deliveries before durable admission", async () => {
    const pausedWorld = await world(), paused = await resolvedDelivery(pausedWorld);
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, pausedWorld.agentId));
    await expect(heartbeatService(db).wakeup(pausedWorld.agentId, {
      ...paused.options, idempotencyKey: `${paused.options.idempotencyKey}:forged`,
    })).rejects.toMatchObject({ status: 409 });

    const strippedWorld = await world(), stripped = await resolvedDelivery(strippedWorld);
    const { paperclipOperatorDecisionResolution: _payloadRef, ...strippedPayload } = stripped.options.payload;
    const { paperclipOperatorDecisionResolution: _contextRef, ...strippedContext } = stripped.options.contextSnapshot;
    await expect(heartbeatService(db).wakeup(strippedWorld.agentId, {
      ...stripped.options, reason: "manual", idempotencyKey: "manual-owner-delivery",
      payload: { ...strippedPayload, kind: "manual" },
      contextSnapshot: { ...strippedContext, wakeReason: "manual" },
    })).rejects.toMatchObject({ status: 409 });

    const alteredWorld = await world(), altered = await resolvedDelivery(alteredWorld);
    const alteredSummary = { ...altered.options.payload.paperclipOperatorDecisionResolution,
      options: [{ id: "approve", label: "변조", description: null }] };
    await expect(heartbeatService(db).wakeup(alteredWorld.agentId, { ...altered.options,
      payload: { ...altered.options.payload, paperclipOperatorDecisionResolution: alteredSummary },
      contextSnapshot: { ...altered.options.contextSnapshot,
        paperclipOperatorDecisionResolution: alteredSummary },
    })).rejects.toMatchObject({ status: 409 });

    const missionWorld = await world(), mission = await resolvedDelivery(missionWorld), foreignMissionId = randomUUID();
    await db.insert(missions).values({ id: foreignMissionId, companyId: missionWorld.companyId,
      ownerAgentId: missionWorld.agentId, title: "Foreign mission", status: "active" });
    await expect(heartbeatService(db).wakeup(missionWorld.agentId, { ...mission.options,
      contextSnapshot: { ...mission.options.contextSnapshot, missionId: foreignMissionId },
    })).rejects.toMatchObject({ status: 409 });

    for (const companyId of [pausedWorld.companyId, strippedWorld.companyId, alteredWorld.companyId, missionWorld.companyId]) {
      expect(await db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(0);
    }
  });

  it("preserves an ordinary paused-agent wake for later promotion", async () => {
    const w = await world();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, w.agentId));
    await expect(heartbeatService(db).wakeup(w.agentId, { reason: "manual",
      payload: { issueId: w.anchorId }, contextSnapshot: { issueId: w.anchorId, missionId: w.missionId },
    })).resolves.toBeNull();
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, w.companyId)))
      .toEqual([expect.objectContaining({ status: "queued", issueId: w.anchorId })]);
  });

  it("keeps paused bounded delivery separate, exact, and promotable", async () => {
    const first = await world(), firstDelivery = await resolvedDelivery(first);
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, first.agentId));
    const generic = { reason: "manual", payload: { issueId: first.anchorId },
      contextSnapshot: { issueId: first.anchorId, missionId: first.missionId } };
    await heartbeatService(db).wakeup(first.agentId, generic);
    await heartbeatService(db).wakeup(first.agentId, firstDelivery.options);
    expect(await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, first.companyId))).toHaveLength(2);

    const w = await world(), delivery = await resolvedDelivery(w);
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, w.agentId));
    await heartbeatService(db).wakeup(w.agentId, delivery.options);
    const [firstBounded] = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, w.companyId));
    await heartbeatService(db).wakeup(w.agentId, delivery.options);
    await heartbeatService(db).wakeup(w.agentId, { reason: "manual", payload: { issueId: w.anchorId },
      contextSnapshot: { issueId: w.anchorId, missionId: w.missionId } });
    const rows = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, w.companyId));
    expect(rows).toHaveLength(2);
    const bounded = rows.find(row => row.idempotencyKey === delivery.options.idempotencyKey)!;
    const storedContext = { ...delivery.options.contextSnapshot, taskId: w.anchorId, taskKey: w.anchorId,
      wakeSource: "automation", wakeTriggerDetail: "system" };
    expect(bounded).toMatchObject({ id: firstBounded!.id, agentId: w.agentId, issueId: w.anchorId,
      status: "queued", coalescedCount: 0 });
    expect(bounded.payload).toEqual({ ...delivery.options.payload, _paperclipWakeContext: storedContext });
  });

  it("rechecks the stored wake identity before queued promotion", async () => {
    const currentWorld = await world(), current = await resolvedDelivery(currentWorld);
    const currentBlocker = await blockMissionQueue(currentWorld);
    await heartbeatService(db).wakeup(currentWorld.agentId, current.options);
    const [currentWake] = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, currentWorld.companyId));
    expect(currentWake).toMatchObject({ status: "queued", runId: null,
      payload: expect.objectContaining({ _paperclipWakeContext: expect.objectContaining({
        missionId: currentWorld.missionId,
      }) }),
    });
    await heartbeatService(db).resumeQueuedRuns(currentWorld.agentId);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, currentWake!.id)))[0])
      .toMatchObject({ status: "queued", runId: null });
    await operatorDecisionContinuationStore(db).accept(current.targeted as typeof current.targeted & {
      targetAgentId: string; idempotencyKey: string; issueId: string;
    }, "admission-worker", currentWake!.id);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, currentBlocker.id));
    await heartbeatService(db).resumeQueuedRuns(currentWorld.agentId);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, currentWake!.id)))[0]?.runId)
      .toEqual(expect.any(String));

    const w = await world(), delivery = await resolvedDelivery(w);
    const blocker = await blockMissionQueue(w);
    await heartbeatService(db).wakeup(w.agentId, delivery.options);
    const [wake] = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, w.companyId));
    await operatorDecisionContinuationStore(db).accept(delivery.targeted as typeof delivery.targeted & {
      targetAgentId: string; idempotencyKey: string; issueId: string;
    }, "admission-worker", wake!.id);
    await request(w, "request:B", delivery.saved.lifetime.lifetimeId);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, blocker.id));
    await heartbeatService(db).resumeQueuedRuns(w.agentId);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake!.id)))[0])
      .toMatchObject({ status: "failed", runId: null });
  });

  it("releases issues before deferred validation and retries pending acceptance", async () => {
    const pendingWorld = await world(), pending = await deferredDelivery(pendingWorld);
    const pendingService = heartbeatService(db);
    await pendingService.cancelRun(pendingWorld.heartbeatRunId);
    await pendingService.resumeQueuedRuns(pendingWorld.agentId);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, pending.wake.id)))[0])
      .toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect((await db.select().from(issues).where(eq(issues.id, pendingWorld.anchorId)))[0])
      .toMatchObject({ executionRunId: null, checkoutRunId: null });
    await operatorDecisionContinuationStore(db).accept(pending.delivery.targeted as typeof pending.delivery.targeted & {
      targetAgentId: string; idempotencyKey: string; issueId: string;
    }, "admission-worker", pending.wake.id);
    await pendingService.resumeQueuedRuns(pendingWorld.agentId);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, pending.wake.id)))[0]?.runId)
      .toEqual(expect.any(String));

    const staleWorld = await world(), stale = await deferredDelivery(staleWorld);
    await operatorDecisionContinuationStore(db).accept(stale.delivery.targeted as typeof stale.delivery.targeted & {
      targetAgentId: string; idempotencyKey: string; issueId: string;
    }, "admission-worker", stale.wake.id);
    await request(staleWorld, "request:B", stale.delivery.saved.lifetime.lifetimeId);
    const [ordinary] = await db.insert(agentWakeupRequests).values({ companyId: staleWorld.companyId,
      agentId: staleWorld.agentId, issueId: staleWorld.anchorId, source: "automation",
      reason: "issue_execution_deferred", status: "deferred_issue_execution", requestedAt: new Date(Date.now() + 1_000),
      payload: { issueId: staleWorld.anchorId, _paperclipWakeContext: {
        issueId: staleWorld.anchorId, missionId: staleWorld.missionId } },
    }).returning();
    const staleService = heartbeatService(db);
    await staleService.cancelRun(staleWorld.heartbeatRunId);
    await staleService.resumeQueuedRuns(staleWorld.agentId);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, stale.wake.id)))[0])
      .toMatchObject({ status: "failed", runId: null });
    const promotedOrdinary = (await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, ordinary!.id)))[0]!;
    expect(promotedOrdinary.runId).toEqual(expect.any(String));
    expect((await db.select().from(issues).where(eq(issues.id, staleWorld.anchorId)))[0]?.executionRunId)
      .toBe(promotedOrdinary.runId);
  });
  it("accepts the exact returned delivery but rejects it after current lifetime replacement", async () => {
    const exactWorld = await world(), exact = await resolvedDelivery(exactWorld);
    await heartbeatService(db).wakeup(exactWorld.agentId, exact.options);
    const [wake] = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, exactWorld.companyId));
    expect(wake).toMatchObject({ agentId: exactWorld.agentId, issueId: exactWorld.anchorId,
      idempotencyKey: exact.options.idempotencyKey });

    const staleWorld = await world(), stale = await resolvedDelivery(staleWorld);
    await request(staleWorld, "request:B", stale.saved.lifetime.lifetimeId);
    await expect(heartbeatService(db).wakeup(staleWorld.agentId, stale.options))
      .rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, staleWorld.companyId))).toHaveLength(0);
    expect(vi.mocked(publishLiveEvent)).toBeDefined();
    expect((await db.select().from(operatorDecisions)
      .where(eq(operatorDecisions.id, stale.decision.id)))[0]?.status).toBe("resolved");
  });
});

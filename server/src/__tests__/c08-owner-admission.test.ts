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

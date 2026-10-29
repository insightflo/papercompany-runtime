import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, operatorDecisions, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { deferred, legacyOwnerWaitCardInput, observeMissionLockAttempt,
  seedOwnerWaitWriterWorld } from "./helpers/owner-retry-human-wait-writer-fixture.js";
import { ensureDeadTargetHumanEscalation, OWNER_DEAD_TARGET_ESCALATION_EVENT }
  from "../services/missions/mission-owner-dead-target-loop.js";
import { emitTerminalMissionHumanOperatorReport }
  from "../services/missions/terminal-mission-human-operator-alert.js";
import { lockOwnerHumanRequestAuthority } from "../services/missions/owner-human-request-authority.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("legacy owner human-wait writer race", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let writerDb: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("owner-human-wait-writer-");
    db = createDb(database.connectionString);
    writerDb = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await writerDb?.$client.end({ timeout: 5 });
    await database?.cleanup();
  });

  it("waits behind the C08 mission prefix, leaves another mission free, and replays once", async () => {
    const held = await seedOwnerWaitWriterWorld(db);
    const independent = await seedOwnerWaitWriterWorld(db, held.companyId);
    const lockHeld = deferred<void>(), releaseLock = deferred<void>();
    const c08Writer = db.transaction(async (tx) => {
      await lockOwnerHumanRequestAuthority(tx, { companyId: held.companyId, missionId: held.missionId,
        ownerActionIssueId: held.ownerActionIssueId, agentId: held.ownerAgentId,
        heartbeatRunId: held.heartbeatRunId,
        recoveryTarget: { kind: "issue", issueId: held.sourceIssueId } });
      lockHeld.resolve();
      await releaseLock.promise;
    });
    await lockHeld.promise;

    let heldCreate: ReturnType<ReturnType<typeof operatorDecisionWriteService>["create"]> | undefined;
    try {
      const lockAttempt = deferred<void>();
      const observedDb = observeMissionLockAttempt(writerDb, lockAttempt.resolve);
      const cardInput = legacyOwnerWaitCardInput(held);
      heldCreate = operatorDecisionWriteService(observedDb).create(held.companyId, cardInput,
        { type: "agent", id: held.ownerAgentId });
      await lockAttempt.promise;
      expect(await db.select({ id: operatorDecisions.id }).from(operatorDecisions).where(and(
        eq(operatorDecisions.companyId, held.companyId), eq(operatorDecisions.requestKey, cardInput.requestKey),
      ))).toHaveLength(0);

      const unrelatedInput = legacyOwnerWaitCardInput(independent);
      const unrelated = await operatorDecisionWriteService(writerDb).create(independent.companyId, unrelatedInput,
        { type: "agent", id: independent.ownerAgentId });
      expect(unrelated.replayed).toBe(false);
    } finally {
      releaseLock.resolve();
      await c08Writer;
    }

    const cardInput = legacyOwnerWaitCardInput(held);
    const created = await heldCreate!;
    expect(created).toMatchObject({ replayed: false, decision: {
      requestKey: cardInput.requestKey, sourceId: held.decisionEventId,
      issueId: held.ownerActionIssueId, status: "pending",
    } });
    const [agentEvent] = await db.select({ heartbeatRunId: workflowTransitionEvents.heartbeatRunId })
      .from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, held.decisionEventId));
    expect(agentEvent?.heartbeatRunId).toBe(held.heartbeatRunId);
    expect(await db.select({ id: operatorDecisions.id }).from(operatorDecisions).where(and(
      eq(operatorDecisions.companyId, held.companyId), eq(operatorDecisions.requestKey, cardInput.requestKey),
    ))).toHaveLength(1);

    const replay = await operatorDecisionWriteService(db).create(held.companyId, cardInput,
      { type: "agent", id: held.ownerAgentId });
    expect(replay).toMatchObject({ replayed: true, decision: { id: created.decision.id } });
    expect(await db.select({ id: operatorDecisions.id }).from(operatorDecisions).where(and(
      eq(operatorDecisions.companyId, held.companyId), eq(operatorDecisions.requestKey, cardInput.requestKey),
    ))).toHaveLength(1);
  });

  it("rejects malformed or cross-mission bindings without inserting a card", async () => {
    const source = await seedOwnerWaitWriterWorld(db);
    const otherMission = await seedOwnerWaitWriterWorld(db, source.companyId);
    const otherCompany = await seedOwnerWaitWriterWorld(db);
    const base = legacyOwnerWaitCardInput(source);
    const cases = [
      { ...base, issueId: null },
      { ...base, sourceContext: { ...base.sourceContext, missionId: otherCompany.missionId } },
      { ...base, sourceContext: { ...base.sourceContext, targetSnapshot: {
        ...base.sourceContext.targetSnapshot!, issueId: otherMission.ownerActionIssueId,
      } } },
      { ...base, sourceContext: { ...base.sourceContext, workflowRunId: otherMission.workflowRunId,
        targetSnapshot: { ...base.sourceContext.targetSnapshot!, workflowRunId: otherMission.workflowRunId,
          stepRunId: otherMission.stepRunId } } },
      { ...base, sourceContext: { ...base.sourceContext, targetSnapshot: {
        ...base.sourceContext.targetSnapshot!, unexpectedScope: true,
      } as typeof base.sourceContext.targetSnapshot } },
    ];
    for (const input of cases) {
      await expect(operatorDecisionWriteService(db).create(source.companyId, input,
        { type: "agent", id: source.ownerAgentId })).rejects.toThrow();
    }
    expect(await db.select({ id: operatorDecisions.id }).from(operatorDecisions).where(and(
      eq(operatorDecisions.companyId, source.companyId), eq(operatorDecisions.requestKey, base.requestKey),
    ))).toHaveLength(0);
    expect(await db.select({ id: operatorDecisions.id }).from(operatorDecisions).where(eq(
      operatorDecisions.companyId, otherCompany.companyId,
    ))).toHaveLength(0);

    const missingHeartbeat = await seedOwnerWaitWriterWorld(db);
    const missingHeartbeatInput = legacyOwnerWaitCardInput(missingHeartbeat);
    await db.update(workflowTransitionEvents).set({ heartbeatRunId: null }).where(eq(
      workflowTransitionEvents.id, missingHeartbeat.decisionEventId,
    ));
    await expect(operatorDecisionWriteService(db).create(missingHeartbeat.companyId, missingHeartbeatInput,
      { type: "agent", id: missingHeartbeat.ownerAgentId })).rejects.toThrow();
    expect(await db.select({ id: operatorDecisions.id }).from(operatorDecisions).where(eq(
      operatorDecisions.requestKey, missingHeartbeatInput.requestKey,
    ))).toHaveLength(0);
  });

  it("creates a first terminal-report system card from its heartbeat-free event", async () => {
    const world = await seedOwnerWaitWriterWorld(db);
    const result = await emitTerminalMissionHumanOperatorReport(db, {
      expectedCompanyId: world.companyId,
      expectedMissionId: world.missionId,
      issue: {
        id: world.ownerActionIssueId, companyId: world.companyId, missionId: world.missionId,
        originKind: "mission_main_executor_unblock", originId: world.sourceIssueId,
        title: "Owner action", identifier: null,
      },
      missionTitle: "Terminal report mission", sourceIssueIdentifier: null,
      workflowRunId: world.workflowRunId,
      failedRuns: [{ id: world.workflowRunId, status: "failed", errorCode: "adapter_failed" }],
      retryAttempts: null, retryMaxRetries: null,
    });
    expect(result.emitted).toBe(true);
    expect(result.card).toEqual({ ensured: true, reason: "card-created" });
    if (!result.decisionEventId) throw new Error("terminal report did not return its event id");

    const [event] = await db.select().from(workflowTransitionEvents).where(eq(
      workflowTransitionEvents.id, result.decisionEventId,
    ));
    expect(event?.heartbeatRunId).toBeNull();
    expect(event).toMatchObject({ companyId: world.companyId, missionId: world.missionId,
      issueId: world.ownerActionIssueId, workflowRunId: world.workflowRunId });
    expect(event?.payload).toMatchObject({ ownerActionIssueId: world.ownerActionIssueId,
      workflowRunId: world.workflowRunId, status: "reported" });
    const [card] = await db.select().from(operatorDecisions).where(eq(
      operatorDecisions.requestKey, `moi1:${result.decisionEventId}`,
    ));
    expect(card).toMatchObject({ sourceId: result.decisionEventId, issueId: world.ownerActionIssueId,
      status: "pending", sourceContext: { missionId: world.missionId,
        targetSnapshot: { issueId: world.ownerActionIssueId, workflowRunId: world.workflowRunId } } });
  });

  it("creates a first dead-target system card from its heartbeat-free event", async () => {
    const world = await seedOwnerWaitWriterWorld(db);
    const result = await ensureDeadTargetHumanEscalation(db, {
      companyId: world.companyId, missionId: world.missionId, ownerAgentId: world.ownerAgentId,
      loopKey: "retry_source_issue",
      anchors: [{ id: world.ownerActionIssueId, status: "in_progress", title: "Owner action", identifier: null }],
      ownerActionIssueId: world.ownerActionIssueId, sourceIssueId: world.sourceIssueId,
      reason: "The retry target cannot be used.", evidence: "source_terminal",
    });
    expect(result).toEqual({ ensured: true, reason: "card-created" });

    const [event] = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, world.companyId),
      eq(workflowTransitionEvents.eventType, OWNER_DEAD_TARGET_ESCALATION_EVENT),
      eq(workflowTransitionEvents.issueId, world.ownerActionIssueId),
    ));
    expect(event?.heartbeatRunId).toBeNull();
    expect(event?.payload).toMatchObject({ kind: OWNER_DEAD_TARGET_ESCALATION_EVENT,
      ownerActionIssueId: world.ownerActionIssueId, anchorIssueId: world.ownerActionIssueId,
      sourceIssueId: world.sourceIssueId });
    const [card] = await db.select().from(operatorDecisions).where(eq(
      operatorDecisions.requestKey, `moi1:${event!.id}`,
    ));
    expect(card).toMatchObject({ sourceId: event!.id, issueId: world.ownerActionIssueId,
      status: "pending", sourceContext: { missionId: world.missionId,
        targetSnapshot: { issueId: world.ownerActionIssueId } } });
  });
});

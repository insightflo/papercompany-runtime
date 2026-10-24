import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issues, missions,
  operatorDecisionContinuations, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { claimHeartbeatWithRecoveryGuard, executeHeartbeatWithRecoveryGuard } from "../services/heartbeat-recovery-guard.js";
import { lockOwnerHumanRequestAuthority } from "../services/missions/owner-human-request-authority.js";
import { saveOwnerHumanRequest } from "../services/missions/owner-human-request-state.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
import { createMissionOwnerHumanInputDecisionCard } from "../services/missions/mission-owner-human-input-card.js";
import { submitMissionOwnerDecision } from "../services/missions/mission-owner-recovery-agent-api.js";
import { operatorDecisionContinuationStore } from "../services/operator-decision-continuation-store.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
import { publishLiveEvent } from "../services/live-events.js";
import { saveOwnerExecutionIntent } from "../services/missions/mission-owner-execute-intent.js";
import { ownerPlanExecutionIntentCurrent } from "../services/missions/mission-owner-execution-state.js";
import { acceptOwnerHumanResponseAtClaim } from "../services/missions/owner-human-response.js";

vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
type World = { companyId: string; missionId: string; agentId: string; anchorId: string;
  sourceId: string; issuingRunId: string };

describeDb("C08 owner response consumption", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("c08-owner-consumption-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await database?.cleanup(); });

  async function world(): Promise<World> {
    const w = { companyId: randomUUID(), missionId: randomUUID(), agentId: randomUUID(),
      anchorId: randomUUID(), sourceId: randomUUID(), issuingRunId: randomUUID() };
    await db.insert(companies).values({ id: w.companyId, name: "C08 consumption", issuePrefix: randomUUID() });
    await db.insert(agents).values({ id: w.agentId, companyId: w.companyId, name: "Owner", status: "active" });
    await db.insert(missions).values({ id: w.missionId, companyId: w.companyId,
      ownerAgentId: w.agentId, title: "C08 consumption", status: "active" });
    await db.insert(issues).values([
      { id: w.sourceId, companyId: w.companyId, missionId: w.missionId, title: "Source", status: "blocked" },
      { id: w.anchorId, companyId: w.companyId, missionId: w.missionId, title: "Owner action",
        status: "in_progress", assigneeAgentId: w.agentId,
        originKind: "mission_main_executor_unblock", originId: w.sourceId },
    ]);
    await db.insert(heartbeatRuns).values({ id: w.issuingRunId, companyId: w.companyId,
      agentId: w.agentId, issueId: w.anchorId, status: "succeeded", finishedAt: new Date() });
    return w;
  }

  async function request(w: World, key: string, expected: string | null = null,
    identityMode: "keyed" | "legacy_exact" = "keyed") {
    return db.transaction(async tx => {
      const auth = await lockOwnerHumanRequestAuthority(tx, { companyId: w.companyId,
        missionId: w.missionId, ownerActionIssueId: w.anchorId, agentId: w.agentId,
        heartbeatRunId: w.issuingRunId });
      const submission = { decision: "request_input" as const, reason: key,
        nextAction: "Continue", evidence: "Evidence" };
      const original = await recordMissionOwnerDecision({ db: tx,
        issue: { id: w.anchorId, companyId: w.companyId, missionId: w.missionId },
        submission, sourceIssueId: w.sourceId, heartbeatRunId: w.issuingRunId });
      return saveOwnerHumanRequest(auth, { schemaVersion: 1, requestKey: key,
        expectedCurrentLifetimeId: expected, identityMode,
        decisionEventId: original.eventId, submission });
    });
  }

  async function responseRun(w: World, identityMode: "keyed" | "legacy_exact" = "keyed",
    accept = true) {
    const saved = await request(w, "request:A", null, identityMode);
    const created = await createMissionOwnerHumanInputDecisionCard(db, {
      ...saved.lifetime.cardInput,
      ...(identityMode === "keyed" ? { lifetimeId: saved.lifetime.lifetimeId } : {}),
    });
    await operatorDecisionWriteService(db).resolve(created.decision.id,
      { actionId: "approve", selectedOptionIds: ["approve"], comment: "approved" }, "board");
    const store = operatorDecisionContinuationStore(db);
    const [claimed] = await store.claimBatch("consumption-worker", new Date());
    const targeted = await store.setTarget(claimed!.id, "consumption-worker", w.agentId, {
      generation: claimed!.generation, attemptCount: claimed!.attemptCount,
      idempotencyKey: claimed!.idempotencyKey!, issueId: claimed!.issueId!,
    });
    const summary = { operatorDecisionId: created.decision.id,
      options: [{ id: "approve", label: "승인", description: "요청된 다음 단계를 승인합니다" }] };
    const context = { issueId: w.anchorId, missionId: w.missionId,
      wakeReason: "operator_decision_resolved", operatorDecisionId: created.decision.id,
      paperclipOperatorDecisionResolution: summary };
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: w.companyId,
      agentId: w.agentId, issueId: w.anchorId, missionId: w.missionId, source: "automation",
      reason: "operator_decision_resolved", requestKind: "operator_decision_resolution",
      status: "claimed", requestedByActorType: "user", requestedByActorId: "board",
      idempotencyKey: targeted!.idempotencyKey!, payload: { kind: "operator_decision_resolution",
        operatorDecisionId: created.decision.id, issueId: w.anchorId, actionId: "approve",
        selectedOptionIds: ["approve"], paperclipOperatorDecisionResolution: summary },
    }).returning();
    if (accept) await store.accept(targeted as typeof targeted & { targetAgentId: string;
      idempotencyKey: string; issueId: string }, "consumption-worker", wake!.id);
    const [run] = await db.insert(heartbeatRuns).values({ companyId: w.companyId,
      agentId: w.agentId, issueId: w.anchorId, status: "running", startedAt: new Date(),
      wakeupRequestId: wake!.id, contextSnapshot: context,
    }).returning();
    await db.update(agentWakeupRequests).set({ runId: run!.id }).where(eq(agentWakeupRequests.id, wake!.id));
    await db.update(issues).set({ executionRunId: run!.id, checkoutRunId: run!.id,
      executionAgentNameKey: "owner" }).where(eq(issues.id, w.anchorId));
    return { saved, decisionId: created.decision.id, continuationId: targeted!.id, run: run! };
  }

  async function retryRun(w: World, parent: typeof heartbeatRuns.$inferSelect, inherit = true) {
    const wakeId = randomUUID(), runId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: w.companyId,
      agentId: w.agentId, issueId: w.anchorId, missionId: w.missionId, source: "automation",
      reason: "process_lost_retry", requestKind: "process_lost_retry", status: "claimed",
      requestedByActorType: "system", requestedByActorId: null, idempotencyKey: null,
      payload: { issueId: w.anchorId, retryOfRunId: parent.id }, runId });
    const [child] = await db.insert(heartbeatRuns).values({ id: runId, companyId: w.companyId,
      agentId: w.agentId, issueId: w.anchorId, status: "running", startedAt: new Date(),
      wakeupRequestId: wakeId, retryOfRunId: parent.id, contextSnapshot: {
        ...(inherit ? parent.contextSnapshot as Record<string, unknown> : {}), retryOfRunId: parent.id,
        wakeReason: "process_lost_retry",
      },
    }).returning();
    await db.update(issues).set({ executionRunId: child!.id, checkoutRunId: child!.id })
      .where(eq(issues.id, w.anchorId));
    return child!;
  }

  const events = (w: World, kind: string) => db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, w.companyId), eq(workflowTransitionEvents.eventType, kind)));

  it.each(["missing_wake", "companyId", "agentId", "issueId", "id"] as const)("rejects actual C08 response %s damage", async damage => {
    const w = await world(), response = await responseRun(w);
    const run = { ...response.run, [damage === "missing_wake" ? "wakeupRequestId" : damage]: randomUUID() };
    await expect(db.transaction(tx => acceptOwnerHumanResponseAtClaim(tx as unknown as Db, run)))
      .rejects.toMatchObject({ status: 409, message: damage === "missing_wake" || damage === "companyId"
        ? "owner_human_response_wake_missing" : "owner_human_response_run_identity_mismatch" });
    expect(await events(w, "owner_human_consumed_v1")).toHaveLength(0);
    expect(await events(w, "owner_human_adapter_start_v1")).toHaveLength(0);
  });

  it("records adapter start separately and consumes only with the structured owner submission", async () => {
    const w = await world(), response = await responseRun(w), execute = vi.fn(async () => "started");
    await expect(executeHeartbeatWithRecoveryGuard(db, response.run, execute)).resolves.toBe("started");
    await expect(executeHeartbeatWithRecoveryGuard(db, response.run, execute)).resolves.toBe("started");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(await events(w, "owner_human_adapter_start_v1")).toHaveLength(1);
    expect(await events(w, "owner_human_consumed_v1")).toHaveLength(0);
    await submitMissionOwnerDecision({ db, issueId: w.anchorId,
      actor: { actorType: "agent", actorId: w.agentId, agentId: w.agentId, runId: response.run.id },
      data: { decision: "recover_artifact", reason: "human response applied" },
    });
    await submitMissionOwnerDecision({ db, issueId: w.anchorId,
      actor: { actorType: "agent", actorId: w.agentId, agentId: w.agentId, runId: response.run.id },
      data: { decision: "recover_artifact", reason: "human response applied" },
    });
    const [consumed] = await events(w, "owner_human_consumed_v1");
    expect(consumed).toMatchObject({ heartbeatRunId: response.run.id,
      payload: expect.objectContaining({ lifetimeId: response.saved.lifetime.lifetimeId }) });
    expect(await events(w, "owner_human_adapter_start_v1")).toHaveLength(1);
    expect(await events(w, "owner_human_consumed_v1")).toHaveLength(1);
  });

  it("preserves legacy moi1 delivery and rolls consumption back with a failed submission", async () => {
    const legacy = await world(), response = await responseRun(legacy, "legacy_exact");
    await expect(executeHeartbeatWithRecoveryGuard(db, response.run, async () => "started"))
      .resolves.toBe("started");
    expect(await events(legacy, "owner_human_adapter_start_v1")).toHaveLength(0);

    const w = await world(), current = await responseRun(w);
    await expect(submitMissionOwnerDecision({ db, issueId: randomUUID(),
      actor: { actorType: "agent", actorId: w.agentId, agentId: w.agentId, runId: current.run.id },
      data: { decision: "recover_artifact", reason: "must roll back" },
    })).rejects.toMatchObject({ status: 409 });
    expect(await events(w, "owner_human_consumed_v1")).toHaveLength(0);
  });

  it("follows a system retry to the current original owner response", async () => {
    const w = await world(), response = await responseRun(w), child = await retryRun(w, response.run);
    await expect(executeHeartbeatWithRecoveryGuard(db, child, async () => "retried"))
      .resolves.toBe("retried");
    await submitMissionOwnerDecision({ db, issueId: w.anchorId,
      actor: { actorType: "agent", actorId: w.agentId, agentId: w.agentId, runId: child.id },
      data: { decision: "recover_artifact", reason: "response applied by retry" },
    });
    const [started] = await events(w, "owner_human_adapter_start_v1");
    const [consumed] = await events(w, "owner_human_consumed_v1");
    expect(started).toMatchObject({ heartbeatRunId: child.id, wakeupRequestId: child.wakeupRequestId,
      payload: expect.objectContaining({ responseHeartbeatRunId: response.run.id,
        responseWakeupRequestId: response.run.wakeupRequestId }) });
    expect(consumed).toMatchObject({ heartbeatRunId: child.id, wakeupRequestId: child.wakeupRequestId });
  });

  it("accepts an exact leased response at the immediate adapter boundary", async () => {
    const w = await world(), response = await responseRun(w, "keyed", false);
    await db.update(heartbeatRuns).set({ status: "queued", startedAt: null })
      .where(eq(heartbeatRuns.id, response.run.id));
    const [queued] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, response.run.id));
    const claimed = await claimHeartbeatWithRecoveryGuard(db, queued!, new Date());
    expect(claimed).toMatchObject({ status: "running" });
    expect(await operatorDecisionContinuationStore(db).failDispatch(
      response.continuationId, "consumption-worker", new Date())).toBeNull();
    await expect(executeHeartbeatWithRecoveryGuard(db, claimed!, async () => "started"))
      .resolves.toBe("started");
    const [continuation] = await db.select().from(operatorDecisionContinuations).where(
      eq(operatorDecisionContinuations.operatorDecisionId, response.decisionId));
    expect(continuation).toMatchObject({ state: "accepted",
      wakeupRequestId: response.run.wakeupRequestId });
  });

  it("keeps a non-response retry of a wake-less legacy run compatible", async () => {
    const w = await world();
    const [parent] = await db.insert(heartbeatRuns).values({ companyId: w.companyId,
      agentId: w.agentId, issueId: w.anchorId, status: "failed", finishedAt: new Date() }).returning();
    const child = await retryRun(w, parent!);
    await expect(executeHeartbeatWithRecoveryGuard(db, child, async () => "ordinary retry"))
      .resolves.toBe("ordinary retry");
    expect(await events(w, "owner_human_adapter_start_v1")).toHaveLength(0);
  });

  it("treats a technical child without inherited owner markers as ordinary", async () => {
    const w = await world(), response = await responseRun(w), child = await retryRun(w, response.run, false);
    await db.update(heartbeatRuns).set({ status: "queued", startedAt: null })
      .where(eq(heartbeatRuns.id, child.id));
    const [queued] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, child.id));
    await expect(claimHeartbeatWithRecoveryGuard(db, queued!, new Date())).resolves.toMatchObject({
      status: "running",
    });
    expect(await events(w, "owner_human_adapter_start_v1")).toHaveLength(0);
  });

  it("preserves a deferred owner response after its wake is promoted", async () => {
    const w = await world(), response = await responseRun(w);
    await db.update(agentWakeupRequests).set({ reason: "issue_execution_promoted" })
      .where(eq(agentWakeupRequests.id, response.run.wakeupRequestId!));
    await expect(executeHeartbeatWithRecoveryGuard(db, response.run, async () => "promoted"))
      .resolves.toBe("promoted");
  });

  it("uses the immutable response wake after mutable run context is merged", async () => {
    const w = await world(), response = await responseRun(w);
    await db.update(heartbeatRuns).set({ contextSnapshot: {
      ...(response.run.contextSnapshot as Record<string, unknown>), wakeReason: "issue_assigned",
    } }).where(eq(heartbeatRuns.id, response.run.id));
    const [merged] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, response.run.id));
    await expect(executeHeartbeatWithRecoveryGuard(db, merged!, async () => "merged"))
      .resolves.toBe("merged");
    await expect(submitMissionOwnerDecision({ db, issueId: w.anchorId,
      actor: { actorType: "agent", actorId: w.agentId, agentId: w.agentId, runId: merged!.id },
      data: { decision: "recover_artifact", reason: "response survived merge" },
    })).resolves.toBeDefined();
  });

  it("rejects late A consumption after B becomes current", async () => {
    const w = await world(), response = await responseRun(w);
    await executeHeartbeatWithRecoveryGuard(db, response.run, async () => "started");
    await request(w, "request:B", response.saved.lifetime.lifetimeId);
    await expect(submitMissionOwnerDecision({ db, issueId: w.anchorId,
      actor: { actorType: "agent", actorId: w.agentId, agentId: w.agentId, runId: response.run.id },
      data: { decision: "recover_artifact", reason: "late A" },
    })).rejects.toMatchObject({ status: 409 });
    expect(await events(w, "owner_human_consumed_v1")).toHaveLength(0);
    expect(vi.mocked(publishLiveEvent)).toBeDefined();
  });

  it("binds a new execute intent to consumption while replay remains stable", async () => {
    const w = await world(), response = await responseRun(w), actionRequestId = randomUUID();
    const context = { db, companyId: w.companyId, agentId: w.agentId, heartbeatRunId: response.run.id };
    const requestBody = { missionId: w.missionId, ownerActionIssueId: w.anchorId, actionRequestId,
      expectedIntentEventId: null, action: { operation: "retry_step" } } as never;
    const refuse = ((_status: number, reason: string) => { throw new Error(reason); }) as never;
    const first = await saveOwnerExecutionIntent(context, requestBody, refuse);
    const [intent] = await events(w, "owner_execute_intent_v1");
    expect(intent?.payload).toMatchObject({ ownerHumanResponse: {
      lifetimeId: response.saved.lifetime.lifetimeId, heartbeatRunId: response.run.id,
      responseHeartbeatRunId: response.run.id } });
    await request(w, "request:B", response.saved.lifetime.lifetimeId);
    await expect(saveOwnerExecutionIntent(context, requestBody, refuse)).resolves.toEqual({
      actionId: first.actionId, replay: true });
    expect(await events(w, "owner_human_consumed_v1")).toHaveLength(1);
    const payload = intent!.payload as Record<string, unknown>;
    await db.update(workflowTransitionEvents).set({ payload: { ...payload, ownerHumanResponse: null } })
      .where(eq(workflowTransitionEvents.id, intent!.id));
    await expect(ownerPlanExecutionIntentCurrent(db, w.companyId,
      { runMetadata: { ownerPlanExecution: { actionId: first.actionId } } })).resolves.toBe(false);
    await db.update(workflowTransitionEvents).set({ payload })
      .where(eq(workflowTransitionEvents.id, intent!.id));
    const [consumed] = await events(w, "owner_human_consumed_v1");
    await db.update(workflowTransitionEvents).set({ layer: "damaged" }).where(eq(workflowTransitionEvents.id, consumed!.id));
    await expect(ownerPlanExecutionIntentCurrent(db, w.companyId,
      { runMetadata: { ownerPlanExecution: { actionId: first.actionId } } })).resolves.toBe(false);
  });
});

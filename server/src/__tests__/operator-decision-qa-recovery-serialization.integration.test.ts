import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  activityLog, agentWakeupRequests, createDb, heartbeatRuns, issueComments, issueWorkProducts, issues,
  operatorDecisionContinuations, operatorDecisions, workflowDefinitions, workflowRuns, workflowStepInvocations,
  workflowStepRuns, workflowTransitionEvents, type Db,
} from "@paperclipai/db";
import type { HistoricalQaSourceDefectCardIdentityInput } from "../services/workflow/qa-source-defect-card-historical-v3.js";
import { buildHistoricalV3Candidates } from "../services/workflow/qa-source-defect-card-historical-v3.js";
import { captureExecutionDefinition } from "../services/workflow/execution-definition.js";
import { applyOwnerCapOverrideRetry } from "../services/workflow/source-issue-cap-override.js";
import { submitWorkflowVerdict } from "../services/workflow/agent-verdict-api.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
import { loadQaRecoveryAdviceFacts } from "../services/operator-decision-qa-recovery-advice.js";
import { seedQaSourceDefectScenario } from "./helpers/qa-source-defect-seed.js";
import { capOwnerAction, seedCapExhaustedRun, testWake } from "./helpers/cap-override-fixtures.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const sourceFindings = [{ id: "S1", layer: "source_data" as const, summary: "The collected source material is incomplete." }];
const actor = { type: "user", id: "system" } as const;
const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip QA recovery serialization integration: ${support.reason}`);

async function until(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("qa_recovery_lock_wait_not_observed");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function waitForBlockedQuery(db: Db, blockerPid: number, pattern: RegExp): Promise<number> {
  let waitingPid = 0;
  await until(async () => {
    const rows = await db.execute(sql`select pid, query from pg_stat_activity
      where datname = current_database() and state = 'active' and wait_event_type = 'Lock'
        and ${blockerPid} = any(pg_blocking_pids(pid))`);
    const row = rows.find((candidate) => pattern.test(String(candidate.query)));
    waitingPid = Number(row?.pid ?? 0);
    return waitingPid > 0;
  });
  return waitingPid;
}

describeDb("historical QA collection admission serializes with native writers", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  const clients: Db[] = [];
  let db: Db, writerDb: Db, resolverDb: Db, observerDb: Db, controlDb: Db, cardHolderDb: Db;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("operator-decision-qa-serialization-");
    [db, writerDb, resolverDb, observerDb, controlDb, cardHolderDb] = Array.from({ length: 6 }, () => createDb(tempDb.connectionString));
    clients.push(db, writerDb, resolverDb, observerDb, controlDb, cardHolderDb);
  }, 60_000);

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.$client.end({ timeout: 5 })));
    await tempDb?.cleanup();
  });

  async function effects(companyId: string) {
    const runIds = db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.companyId, companyId));
    return {
      decisions: await db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, companyId)),
      activity: await db.select().from(activityLog).where(eq(activityLog.companyId, companyId)),
      continuations: await db.select().from(operatorDecisionContinuations).where(eq(operatorDecisionContinuations.companyId, companyId)),
      comments: await db.select().from(issueComments).where(eq(issueComments.companyId, companyId)),
      wakeups: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)),
      runs: await db.select().from(workflowRuns).where(eq(workflowRuns.companyId, companyId)),
      steps: await db.select().from(workflowStepRuns).where(inArray(workflowStepRuns.workflowRunId, runIds)),
      issues: await db.select().from(issues).where(eq(issues.companyId, companyId)),
      events: await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, companyId)),
      invocations: await db.select().from(workflowStepInvocations).where(eq(workflowStepInvocations.companyId, companyId)),
      products: await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.companyId, companyId)),
    };
  }

  async function insertCard(identity: HistoricalQaSourceDefectCardIdentityInput, companyId: string) {
    const candidate = buildHistoricalV3Candidates(identity, sourceFindings.map((finding) => finding.id))
      .find((card) => card.title.startsWith("Quality review")
        && card.definition.options.some((option) => option.id === "rerun_source_collection" && option.recommended));
    if (!candidate) throw new Error("historical_source_only_card_fixture_missing");
    const { decision } = await operatorDecisionWriteService(db).create(companyId, candidate, actor);
    const [card] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, decision.id));
    return card!;
  }

  async function seedRunningCard() {
    const seed = await seedQaSourceDefectScenario(db, sourceFindings, { priorFindings: sourceFindings });
    await db.update(workflowRuns).set({ status: "pending", metadata: { executionDefinitionVersion: 1 } })
      .where(eq(workflowRuns.id, seed.runId));
    await db.transaction((tx) => captureExecutionDefinition(tx, seed.runId));
    await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, seed.runId));
    await db.update(workflowStepRuns).set({ completedAt: new Date() }).where(and(
      eq(workflowStepRuns.workflowRunId, seed.runId), eq(workflowStepRuns.stepId, "qa-validate"),
    ));
    await db.update(issues).set({ originKind: "workflow_execution" }).where(eq(issues.id, seed.qaIssueId));
    const identity: HistoricalQaSourceDefectCardIdentityInput = {
      workflowRunId: seed.runId, producerStepId: "produce", iteration: 0, maxIterations: 2,
      findings: sourceFindings, qaRefs: [{ qaStepId: "qa-validate", qaIssueId: seed.qaIssueId }],
      missionId: seed.missionId, linkIssueId: seed.oversightIssueId,
    };
    const card = await insertCard(identity, seed.companyId);
    return { seed, card };
  }

  async function seedCapOverrideCard() {
    const seed = await seedCapExhaustedRun(db);
    const [seededRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, seed.workflowRunId));
    if (!seededRun) throw new Error("cap_override_run_fixture_missing");
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, seed.workflowId));
    const steps = structuredClone(definition!.stepsJson) as unknown as Array<Record<string, unknown>>;
    const producer = steps.find((step) => step.id === "produce");
    if (!producer) throw new Error("cap_override_producer_fixture_missing");
    producer.dependencies = ["collect"];
    steps.unshift({ id: "collect", name: "Collect", agentId: seed.producerAgentId, dependencies: [] });
    await db.update(workflowDefinitions).set({ stepsJson: steps }).where(eq(workflowDefinitions.id, seed.workflowId));
    const [source] = await db.insert(issues).values({ companyId: seed.companyId, missionId: seed.missionId,
      title: "Collect source", status: "done", assigneeAgentId: seed.ownerAgentId }).returning({ id: issues.id });
    await db.insert(workflowStepRuns).values({ workflowRunId: seed.workflowRunId,
      stepId: "collect", issueId: source!.id, status: "completed", iterationIndex: 0,
      completedAt: new Date("2026-07-09T23:00:00.000Z") });
    await db.update(workflowRuns).set({
      status: "pending", startedAt: null, completedAt: null, metadata: { executionDefinitionVersion: 1 },
    })
      .where(eq(workflowRuns.id, seed.workflowRunId));
    await db.transaction((tx) => captureExecutionDefinition(tx, seed.workflowRunId));
    await db.update(workflowRuns).set({
      status: seededRun.status, startedAt: seededRun.startedAt, completedAt: seededRun.completedAt,
    }).where(eq(workflowRuns.id, seed.workflowRunId));
    const [event] = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, seed.workflowRunId),
      eq(workflowTransitionEvents.workflowStepRunId, seed.qaStepRunId),
      eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
    ));
    await db.update(workflowTransitionEvents).set({ payload: { ...(event!.payload as Record<string, unknown>), findings: sourceFindings } })
      .where(eq(workflowTransitionEvents.id, event!.id));
    const identity: HistoricalQaSourceDefectCardIdentityInput = {
      workflowRunId: seed.workflowRunId, producerStepId: "produce", iteration: seed.producerIteration, maxIterations: 1,
      findings: sourceFindings, qaRefs: [{ qaStepId: "qa-validate", qaIssueId: seed.qaIssueId }],
      missionId: seed.missionId, linkIssueId: seed.ownerActionIssueId,
    };
    const card = await insertCard(identity, seed.companyId);
    return { seed, card };
  }

  async function submitPass(seed: { companyId: string; ownerId: string; qaIssueId: string }, writer: Db) {
    const heartbeatId = randomUUID(), now = new Date();
    await writer.insert(heartbeatRuns).values({ id: heartbeatId, companyId: seed.companyId, agentId: seed.ownerId,
      issueId: seed.qaIssueId, status: "succeeded", startedAt: now, finishedAt: now });
    const [issue] = await writer.select().from(issues).where(eq(issues.id, seed.qaIssueId));
    return submitWorkflowVerdict({ db: writer, issue: issue!, actor: { actorType: "agent", actorId: seed.ownerId,
      agentId: seed.ownerId, runId: heartbeatId }, data: { verdict: "pass" } });
  }

  it("waits for a native official PASS, then denies with no resolver effects", async () => {
    const { seed, card } = await seedRunningCard();
    expect((await loadQaRecoveryAdviceFacts(db, [card])).get(card.id)).toMatchObject({ disposition: "verified", cause: "source_only", collectionChoiceAllowed: true });
    const lock = await controlDb.$client.reserve();
    const cardLock = await cardHolderDb.$client.reserve();
    let holding = false;
    let holdingCard = false;
    let writer: Promise<unknown> | undefined;
    let resolver: Promise<{ error?: unknown; applied?: boolean }> | undefined;
    try {
      await lock`begin`; holding = true;
      const [holder] = await lock`select pg_backend_pid() as pid`;
      await lock`lock table workflow_transition_events in share mode`;
      await cardLock`begin`; holdingCard = true;
      const [cardHolder] = await cardLock`select pg_backend_pid() as pid`;
      await cardLock`select id from operator_decisions where id = ${card.id} for update`;
      writer = submitPass({ companyId: seed.companyId, ownerId: seed.ownerId, qaIssueId: seed.qaIssueId }, writerDb);
      const writerPid = await waitForBlockedQuery(observerDb, Number(holder!.pid), /insert into "workflow_transition_events"/i);
      resolver = operatorDecisionWriteService(resolverDb).resolve(card.id, {
        actionId: "submit", selectedOptionIds: ["rerun_source_collection"], comment: "source direction",
      }, "human").then((result) => ({ applied: result.applied }), (error: unknown) => ({ error }));
      await waitForBlockedQuery(observerDb, writerPid, /from "missions"/i);
      await lock`commit`; holding = false;
      expect(await writer!).toMatchObject({ satisfied: true, verdict: "pass" });
      await waitForBlockedQuery(observerDb, Number(cardHolder!.pid), /from "operator_decisions"/i);
      const afterWriter = await effects(seed.companyId);
      expect(afterWriter.decisions.find((decision) => decision.id === card.id))
        .toMatchObject({ status: "pending", result: null });
      await cardLock`commit`; holdingCard = false;
      expect((await resolver!).error).toMatchObject({ status: 409, details: {
        code: "qa_recovery_collection_choice_unproven", operatorDecisionId: card.id,
      } });
      expect(await effects(seed.companyId)).toEqual(afterWriter);
    } finally {
      if (holding) await lock`rollback`;
      if (holdingCard) await cardLock`rollback`;
      await Promise.allSettled([writer, resolver]);
      lock.release();
      cardLock.release();
    }
  });

  it("waits for native producer iteration and completion reset, then denies without resolver effects", async () => {
    const { seed, card } = await seedCapOverrideCard();
    const [beforeProducer] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, seed.producerStepRunId));
    expect((await loadQaRecoveryAdviceFacts(db, [card])).get(card.id)).toMatchObject({ disposition: "verified", collectionChoiceAllowed: true });
    const lock = await controlDb.$client.reserve();
    const cardLock = await cardHolderDb.$client.reserve();
    let holding = false;
    let holdingCard = false;
    let writer: Promise<unknown> | undefined;
    let resolver: Promise<{ error?: unknown; applied?: boolean }> | undefined;
    try {
      await lock`begin`; holding = true;
      const [holder] = await lock`select pg_backend_pid() as pid`;
      await lock`select id from issues where id = ${seed.producerIssueId} for update`;
      await cardLock`begin`; holdingCard = true;
      const [cardHolder] = await cardLock`select pg_backend_pid() as pid`;
      await cardLock`select id from operator_decisions where id = ${card.id} for update`;
      writer = applyOwnerCapOverrideRetry(writerDb, { companyId: seed.companyId, issueId: seed.producerIssueId,
        ownerAction: capOwnerAction(seed), wakeFn: testWake(writerDb) });
      const writerPid = await waitForBlockedQuery(observerDb, Number(holder!.pid), /update "issues"/i);
      resolver = operatorDecisionWriteService(resolverDb).resolve(card.id, {
        actionId: "submit", selectedOptionIds: ["rerun_source_collection"], comment: "source direction",
      }, "human").then((result) => ({ applied: result.applied }), (error: unknown) => ({ error }));
      await waitForBlockedQuery(observerDb, writerPid, /from "missions"/i);
      await lock`commit`; holding = false;
      expect(await writer!).toMatchObject({ kind: "cap_override_applied" });
      await waitForBlockedQuery(observerDb, Number(cardHolder!.pid), /from "operator_decisions"/i);
      const afterWriter = await effects(seed.companyId);
      expect(afterWriter.decisions.find((decision) => decision.id === card.id))
        .toMatchObject({ status: "pending", result: null });
      const [afterProducer] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, seed.producerStepRunId));
      expect(beforeProducer).toMatchObject({ status: "completed", iterationIndex: 1 });
      expect(beforeProducer!.completedAt).not.toBeNull();
      expect(afterProducer).toMatchObject({ status: "pending", iterationIndex: 2, completedAt: null });
      await cardLock`commit`; holdingCard = false;
      expect((await resolver!).error).toMatchObject({ status: 409, details: {
        code: "qa_recovery_collection_choice_unproven", operatorDecisionId: card.id,
      } });
      expect(await effects(seed.companyId)).toEqual(afterWriter);
    } finally {
      if (holding) await lock`rollback`;
      if (holdingCard) await cardLock`rollback`;
      await Promise.allSettled([writer, resolver]);
      lock.release();
      cardLock.release();
    }
  });

  it("replays an identical resolved choice after a later official PASS without duplicate effects", async () => {
    const { seed, card } = await seedRunningCard();
    const selection = { actionId: "submit", selectedOptionIds: ["rerun_source_collection"], comment: "source direction" };
    const writer = operatorDecisionWriteService(resolverDb);
    const first = await writer.resolve(card.id, selection, "human");
    expect(first.applied).toBe(true);
    expect(first.continuation).toBeTruthy();
    await submitPass({ companyId: seed.companyId, ownerId: seed.ownerId, qaIssueId: seed.qaIssueId }, writerDb);
    const afterPass = await effects(seed.companyId);
    const replay = await writer.resolve(card.id, selection, "human");
    expect(replay.applied).toBe(false);
    expect(await effects(seed.companyId)).toEqual(afterPass);
  });
});

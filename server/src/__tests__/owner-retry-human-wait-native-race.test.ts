import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, createDb, heartbeatRuns, issues,
  workflowDefinitions, workflowRecoveryAuthorities, workflowRuns, workflowStepRuns,
  workflowTransitionEvents, type Db } from "@paperclipai/db";
import { dispatchSourceIssueNativeResume } from "../services/workflow/source-issue-native-resume.js";
import { queueSourceIssueResume } from "../services/workflow/source-issue-recovery-accept.js";
import { loadExecutionDefinition } from "../services/workflow/execution-definition.js";
import { lockOwnerHumanRequestAuthority } from "../services/missions/owner-human-request-authority.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
import { saveOwnerHumanRequest } from "../services/missions/owner-human-request-state.js";
import { ownerHumanCurrentKey } from "../services/missions/owner-human-request-contract.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { capOwnerAction, reloadRun, reloadStepRun, seedCapExhaustedRun,
  testWake } from "./helpers/cap-override-fixtures.js";
import { deferred, observeMissionLockAttempt } from "./helpers/owner-retry-human-wait-writer-fixture.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) throw new Error("Embedded PostgreSQL support is required for the native wait race test");
type Seed = Awaited<ReturnType<typeof seedCapExhaustedRun>>;

describe("native source retry human-wait transaction boundary", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let writerDb: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("owner-retry-human-wait-native-");
    db = createDb(database.connectionString);
    writerDb = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await writerDb?.$client.end({ timeout: 5 });
    await database?.cleanup();
  });

  async function ownerHeartbeat(w: Seed) {
    const [existing] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, w.ownerDecisionHeartbeatRunId));
    if (existing) await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, existing.id));
    else await db.insert(heartbeatRuns).values({ id: w.ownerDecisionHeartbeatRunId, companyId: w.companyId,
      agentId: w.ownerAgentId, issueId: w.ownerActionIssueId, status: "running" });
  }
  async function running(w: Seed) {
    await db.update(workflowRuns).set({ status: "running", completedAt: null }).where(eq(workflowRuns.id, w.workflowRunId));
    await db.update(workflowStepRuns).set({ status: "pending", startedAt: null, completedAt: null })
      .where(eq(workflowStepRuns.id, w.producerStepRunId));
    await db.update(issues).set({ status: "todo", completedAt: null }).where(eq(issues.id, w.producerIssueId));
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, w.ownerActionIssueId));
    await ownerHeartbeat(w);
  }
  async function failed(w: Seed) {
    await db.update(workflowStepRuns).set({ status: "failed", startedAt: new Date(), completedAt: new Date() })
      .where(eq(workflowStepRuns.id, w.producerStepRunId));
    await db.update(issues).set({ status: "blocked", completedAt: null }).where(eq(issues.id, w.producerIssueId));
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, w.ownerActionIssueId));
    await ownerHeartbeat(w);
  }
  const automatic = (database: Db, w: Seed, wakeFn?: Parameters<typeof dispatchSourceIssueNativeResume>[1]["wakeFn"]) =>
    dispatchSourceIssueNativeResume(database, { companyId: w.companyId, issueId: w.producerIssueId,
      allowBlockedIssue: true, ownerAction: { ...capOwnerAction(w), decisionCommentId: "" }, wakeFn });
  async function writeC08Wait(database: Db, w: Seed) {
    const submission = { decision: "request_input" as const,
      recoveryTarget: { kind: "issue" as const, issueId: w.qaIssueId }, reason: "Human decision required" };
    return database.transaction(async (tx) => {
      const auth = await lockOwnerHumanRequestAuthority(tx, { companyId: w.companyId, missionId: w.missionId,
        ownerActionIssueId: w.ownerActionIssueId, agentId: w.ownerAgentId,
        heartbeatRunId: w.ownerDecisionHeartbeatRunId, recoveryTarget: submission.recoveryTarget });
      const decision = await recordMissionOwnerDecision({ db: tx,
        issue: { id: w.ownerActionIssueId, companyId: w.companyId, missionId: w.missionId },
        submission, sourceIssueId: w.qaIssueId, heartbeatRunId: w.ownerDecisionHeartbeatRunId });
      return saveOwnerHumanRequest(auth, { schemaVersion: 1, requestKey: `native-wait:${randomUUID()}`,
        expectedCurrentLifetimeId: null, identityMode: "keyed", decisionEventId: decision.eventId, submission });
    });
  }
  async function currentWaits(w: Seed) {
    return db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.companyId, w.companyId),
      eq(workflowTransitionEvents.idempotencyKey, ownerHumanCurrentKey({ companyId: w.companyId,
        missionId: w.missionId, target: { kind: "source_issue", issueId: w.qaIssueId } }))));
  }
  async function wakeRows(w: Seed) {
    return db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, w.companyId),
      eq(agentWakeupRequests.issueId, w.producerIssueId), eq(agentWakeupRequests.workflowRunId, w.workflowRunId),
      eq(agentWakeupRequests.workflowStepRunId, w.producerStepRunId), eq(agentWakeupRequests.requestKind, "workflow_resume")));
  }
  async function directQueue(w: Seed, wakeFn: NonNullable<Parameters<typeof dispatchSourceIssueNativeResume>[1]["wakeFn"]>) {
    const run = await reloadRun(db, w.workflowRunId);
    const stepRun = await reloadStepRun(db, w.workflowRunId, "produce");
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run.workflowId));
    const execution = await loadExecutionDefinition(db, run.id, { requireHistorical: false });
    const step = execution.steps.find((candidate) => candidate.id === stepRun.stepId);
    if (!definition || !step) throw new Error("native test fixture missing workflow definition/step");
    return queueSourceIssueResume(db, { run, definition, step, stepRun, issueId: w.producerIssueId,
      allowBlockedIssue: true, wakeFn, ownerAction: { ...capOwnerAction(w), decisionCommentId: "" } });
  }

  it("blocks failed-run recovery when an actual current C08 wait committed first", async () => {
    const w = await seedCapExhaustedRun(db, { skipDecisionComment: true });
    await failed(w);
    await writeC08Wait(db, w);
    const beforeRun = await reloadRun(db, w.workflowRunId), beforeStep = await reloadStepRun(db, w.workflowRunId, "produce");
    const beforeIssue = (await db.select().from(issues).where(eq(issues.id, w.producerIssueId)))[0]!;
    const beforeAuthorities = await db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.workflowRunId, w.workflowRunId));
    const outcome = await automatic(db, w, testWake(db));
    const afterRun = await reloadRun(db, w.workflowRunId), afterStep = await reloadStepRun(db, w.workflowRunId, "produce");
    const afterIssue = (await db.select().from(issues).where(eq(issues.id, w.producerIssueId)))[0]!;
    expect(outcome).toMatchObject({ kind: "report_only", reason: "wake_rejected" });
    expect(afterRun).toMatchObject({ status: beforeRun.status, dispatchAuthorityVersion: beforeRun.dispatchAuthorityVersion });
    expect(afterStep).toMatchObject({ status: beforeStep.status, executionGeneration: beforeStep.executionGeneration,
      iterationIndex: beforeStep.iterationIndex });
    expect(afterIssue).toMatchObject({ status: beforeIssue.status, completedAt: beforeIssue.completedAt });
    expect(await db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.workflowRunId, w.workflowRunId)))
      .toHaveLength(beforeAuthorities.length);
    expect(await wakeRows(w)).toHaveLength(0);
    expect(await currentWaits(w)).toHaveLength(1);
  });

  it("commits one exact wake before a waiting writer, then preserves it and blocks the next queue attempt", async () => {
    const w = await seedCapExhaustedRun(db, { skipDecisionComment: true, runStatus: "running" });
    await running(w);
    const callbackEntered = deferred<void>(), releaseCallback = deferred<void>(), writerLockAttempt = deferred<void>();
    const baseWake = testWake(db);
    const heldWake: NonNullable<Parameters<typeof dispatchSourceIssueNativeResume>[1]["wakeFn"]> = async (input) => {
      callbackEntered.resolve();
      await releaseCallback.promise;
      return baseWake(input);
    };
    const nativeAcceptance = automatic(db, w, heldWake);
    await callbackEntered.promise;
    let writerCommitted = false;
    const observedWriterDb = observeMissionLockAttempt(writerDb, writerLockAttempt.resolve);
    const writer = writeC08Wait(observedWriterDb, w).then((value) => { writerCommitted = true; return value; });
    await writerLockAttempt.promise;
    expect(writerCommitted).toBe(false);
    expect(await currentWaits(w)).toHaveLength(0);
    releaseCallback.resolve();
    const [outcome] = await Promise.all([nativeAcceptance, writer]);
    expect(outcome.kind).toBe("dispatched");
    expect(writerCommitted).toBe(true);
    const accepted = await wakeRows(w);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ status: "queued", requestKind: "workflow_resume",
      workflowRunId: w.workflowRunId, workflowStepRunId: w.producerStepRunId, issueId: w.producerIssueId });
    expect(await currentWaits(w)).toHaveLength(1);

    let replayWakeCalls = 0;
    const replayWake: NonNullable<Parameters<typeof dispatchSourceIssueNativeResume>[1]["wakeFn"]> = async (input) => {
      replayWakeCalls++;
      return baseWake(input);
    };
    expect(await directQueue(w, replayWake)).toBe(false);
    expect(replayWakeCalls).toBe(0);
    expect(await wakeRows(w)).toEqual(accepted);
  });

  it("admits a no-wait automatic continuation and proves exact accepted readback", async () => {
    const w = await seedCapExhaustedRun(db, { skipDecisionComment: true, runStatus: "running", producerIteration: 0 });
    await running(w);
    const before = await reloadStepRun(db, w.workflowRunId, "produce");
    const outcome = await automatic(db, w, testWake(db));
    expect(outcome).toMatchObject({ kind: "dispatched", workflowRunId: w.workflowRunId,
      workflowStepRunId: w.producerStepRunId });
    expect(await wakeRows(w)).toHaveLength(1);
    expect(await reloadStepRun(db, w.workflowRunId, "produce")).toMatchObject({
      status: before.status, executionGeneration: before.executionGeneration, iterationIndex: before.iterationIndex,
    });
  });

  it("rolls back failed-run recovery when the native wake is rejected", async () => {
    const w = await seedCapExhaustedRun(db, { skipDecisionComment: true });
    await failed(w);
    const beforeRun = await reloadRun(db, w.workflowRunId), beforeStep = await reloadStepRun(db, w.workflowRunId, "produce");
    const outcome = await automatic(db, w, async () => false);
    expect(outcome).toMatchObject({ kind: "report_only", reason: "wake_rejected" });
    expect(await reloadRun(db, w.workflowRunId)).toMatchObject({ status: beforeRun.status,
      dispatchAuthorityVersion: beforeRun.dispatchAuthorityVersion });
    expect(await reloadStepRun(db, w.workflowRunId, "produce")).toMatchObject({
      status: beforeStep.status, executionGeneration: beforeStep.executionGeneration, iterationIndex: beforeStep.iterationIndex,
    });
    expect(await db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.workflowRunId, w.workflowRunId)))
      .toHaveLength(0);
    expect(await wakeRows(w)).toHaveLength(0);
  });

  it("rejects stale explicit event IDs but accepts the latest exact QA producer retry", async () => {
    const w = await seedCapExhaustedRun(db, { runStatus: "running", producerIteration: 0 });
    await running(w);
    const before = await reloadStepRun(db, w.workflowRunId, "produce");
    const stale = await dispatchSourceIssueNativeResume(db, { companyId: w.companyId, issueId: w.producerIssueId,
      allowBlockedIssue: true, ownerAction: capOwnerAction(w, randomUUID()), wakeFn: testWake(db) });
    expect(stale).toMatchObject({ kind: "report_only", reason: "wake_rejected" });
    expect(await wakeRows(w)).toHaveLength(0);
    expect(await reloadStepRun(db, w.workflowRunId, "produce")).toMatchObject({
      status: before.status, executionGeneration: before.executionGeneration, iterationIndex: before.iterationIndex,
    });

    const explicit = await dispatchSourceIssueNativeResume(db, { companyId: w.companyId, issueId: w.producerIssueId,
      allowBlockedIssue: true, ownerAction: capOwnerAction(w), wakeFn: testWake(db) });
    expect(explicit).toMatchObject({ kind: "dispatched", workflowRunId: w.workflowRunId,
      workflowStepRunId: w.producerStepRunId });
    expect(await wakeRows(w)).toHaveLength(1);
    expect(await reloadStepRun(db, w.workflowRunId, "produce")).toMatchObject({ iterationIndex: before.iterationIndex });
  });

  it("retains the dedicated valid explicit QA cap-override path", async () => {
    const w = await seedCapExhaustedRun(db);
    const before = await reloadStepRun(db, w.workflowRunId, "produce");
    const outcome = await dispatchSourceIssueNativeResume(db, { companyId: w.companyId, issueId: w.producerIssueId,
      allowBlockedIssue: true, ownerAction: capOwnerAction(w), wakeFn: testWake(db) });
    expect(outcome).toMatchObject({ kind: "cap_override_applied", workflowRunId: w.workflowRunId,
      workflowStepRunId: w.producerStepRunId, fromIteration: before.iterationIndex,
      toIteration: before.iterationIndex + 1 });
    expect(await reloadRun(db, w.workflowRunId)).toMatchObject({ status: "running" });
    expect(await reloadStepRun(db, w.workflowRunId, "produce")).toMatchObject({ status: "pending",
      iterationIndex: before.iterationIndex + 1 });
    const wakes = await wakeRows(w);
    expect(wakes).toHaveLength(1);
    expect(await db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.companyId, w.companyId),
      eq(workflowTransitionEvents.eventType, "owner_cap_override_retry")))).toMatchObject([
      expect.objectContaining({ payload: expect.objectContaining({ status: "accepted", acceptedWakeupRequestId: wakes[0]!.id }) }),
    ]);
  });

  it("does not route an empty automatic event through the cap-override branch", async () => {
    const w = await seedCapExhaustedRun(db);
    const beforeRun = await reloadRun(db, w.workflowRunId), beforeStep = await reloadStepRun(db, w.workflowRunId, "produce");
    const outcome = await automatic(db, w, testWake(db));
    expect(outcome).toMatchObject({ kind: "report_only", reason: "wake_rejected" });
    expect(await reloadRun(db, w.workflowRunId)).toMatchObject({ status: beforeRun.status,
      dispatchAuthorityVersion: beforeRun.dispatchAuthorityVersion });
    expect(await reloadStepRun(db, w.workflowRunId, "produce")).toMatchObject({ status: beforeStep.status,
      executionGeneration: beforeStep.executionGeneration, iterationIndex: beforeStep.iterationIndex });
    expect(await db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.companyId, w.companyId),
      eq(workflowTransitionEvents.eventType, "owner_cap_override_retry")))).toHaveLength(0);
    expect(await wakeRows(w)).toHaveLength(0);
  });
});

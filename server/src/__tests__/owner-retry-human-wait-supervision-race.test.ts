import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, createDb, heartbeatRuns, issues, workflowDefinitions,
  missions, workflowRuns, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { missionService, type MissionServiceDeps } from "../services/missions.js";
import { dispatchSourceIssueNativeResume } from "../services/workflow/source-issue-native-resume.js";
import { lockOwnerHumanRequestAuthority } from "../services/missions/owner-human-request-authority.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
import { saveOwnerHumanRequest } from "../services/missions/owner-human-request-state.js";
import { deferred, seedOwnerWaitWriterWorld } from "./helpers/owner-retry-human-wait-writer-fixture.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { testWake } from "./helpers/cap-override-fixtures.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) throw new Error("Embedded PostgreSQL support is required for the supervision wait race test");
type World = Awaited<ReturnType<typeof seedOwnerWaitWriterWorld>> & { automaticIssueId: string };

async function seedAutomatic(db: Db): Promise<World> {
  const world = await seedOwnerWaitWriterWorld(db);
  await db.delete(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, world.decisionEventId));
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, world.workflowRunId));
  await db.update(workflowRuns).set({ status: "running", completedAt: null }).where(eq(workflowRuns.id, world.workflowRunId));
  await db.update(workflowDefinitions).set({ stepsJson: [{ id: "failed-step", name: "Source", type: "agent",
    agentId: world.ownerAgentId, dependencies: [] }] }).where(eq(workflowDefinitions.id, run!.workflowId));
  await db.update(workflowStepRuns).set({ status: "pending", issueId: world.sourceIssueId,
    startedAt: null, completedAt: null }).where(eq(workflowStepRuns.id, world.stepRunId));
  await db.update(issues).set({ status: "blocked", assigneeAgentId: world.ownerAgentId })
    .where(eq(issues.id, world.sourceIssueId));
  const automaticIssueId = world.ownerActionIssueId;
  await db.update(issues).set({ createdAt: new Date(Date.now() - 45 * 60_000) })
    .where(eq(issues.id, automaticIssueId));
  return { ...world, automaticIssueId };
}

async function writeC08Wait(db: Db, world: World) {
  const submission = { decision: "request_input" as const,
    recoveryTarget: { kind: "issue" as const, issueId: world.sourceIssueId }, reason: "Wait for the owner" };
  await db.transaction(async (tx) => {
    const auth = await lockOwnerHumanRequestAuthority(tx, { companyId: world.companyId, missionId: world.missionId,
      ownerActionIssueId: world.ownerActionIssueId, agentId: world.ownerAgentId, heartbeatRunId: world.heartbeatRunId,
      recoveryTarget: submission.recoveryTarget });
    const decision = await recordMissionOwnerDecision({ db: tx,
      issue: { id: world.ownerActionIssueId, companyId: world.companyId, missionId: world.missionId },
      submission, sourceIssueId: world.sourceIssueId, heartbeatRunId: world.heartbeatRunId });
    await saveOwnerHumanRequest(auth, { schemaVersion: 1, requestKey: `h24:${randomUUID()}`,
      expectedCurrentLifetimeId: null, identityMode: "keyed", decisionEventId: decision.eventId, submission });
  });
}

function gateMissionLock(db: Db, targetLock: number, before: () => Promise<void>): Db {
  let count = 0;
  const wrapBuilder = (builder: object, isMission = false, observe = false): object => new Proxy(builder, { get(wrapped, property) {
    const value = Reflect.get(wrapped, property, wrapped);
    if (property === "then" && observe && typeof value === "function") return async (...args: unknown[]) => {
      if (++count === targetLock) await before();
      return Reflect.apply(value, wrapped, args);
    };
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => {
      const next = Reflect.apply(value, wrapped, args);
      const missionQuery = isMission || (property === "from" && args[0] === missions);
      const lockQuery = observe || (property === "for" && missionQuery && args[0] === "update");
      return next && (typeof next === "object" || typeof next === "function")
        ? wrapBuilder(next, missionQuery, lockQuery) : next;
    };
  } });
  const wrapTx = (tx: unknown) => new Proxy(tx as object, { get(target, property) {
    const value = Reflect.get(target, property, target);
    if (property === "select" && typeof value === "function") return (...args: unknown[]) =>
      wrapBuilder(Reflect.apply(value, target, args));
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return new Proxy(db, { get(target, property) {
    const value = Reflect.get(target, property, target);
    if (property === "$client") return value;
    if (property === "transaction" && typeof value === "function") return (...args: unknown[]) => {
      const callback = args[0];
      return Reflect.apply(value, target, [typeof callback === "function"
        ? (tx: unknown) => Reflect.apply(callback, undefined, [wrapTx(tx)]) : callback, ...args.slice(1)]);
    };
    return typeof value === "function" ? value.bind(target) : value;
  } }) as Db;
}

describe("automatic owner retry vs exact human wait", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db, writerDb: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("owner-retry-supervision-race-");
    db = createDb(database.connectionString); writerDb = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 5 }); await writerDb?.$client.end({ timeout: 5 }); await database?.cleanup();
  });
  const applyRows = (w: World) => db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, w.companyId), eq(workflowTransitionEvents.issueId, w.automaticIssueId),
    eq(workflowTransitionEvents.eventType, "mission_owner_retry_apply")));
  const resumeRows = (w: World) => db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, w.companyId), eq(agentWakeupRequests.issueId, w.sourceIssueId),
    eq(agentWakeupRequests.requestKind, "workflow_resume")));
  const nativeCallback = (database: Db, outcomes: unknown[]) => async (input: {
    mission: { id: string }; ownerActionIssue: { id: string }; sourceIssue: { id: string; companyId: string };
    decisionCommentId?: string | null;
  }) => {
    const result = await dispatchSourceIssueNativeResume(database, { companyId: input.sourceIssue.companyId,
      issueId: input.sourceIssue.id, allowBlockedIssue: true, ownerAction: { ownerActionIssueId: input.ownerActionIssue.id,
        missionId: input.mission.id, decisionCommentId: input.decisionCommentId ?? "" }, wakeFn: testWake(database) });
    outcomes.push(result);
    return { status: result.kind === "dispatched" || result.kind === "already_in_flight" ? "dispatched" : "failed" };
  };
  const supervise = (database: Db, w: World, cb: MissionServiceDeps["onOwnerDecisionRetrySourceIssueApplied"]) =>
    missionService(database, { onOwnerDecisionRetrySourceIssueApplied: cb }).runMainExecutorSupervision({
      missionId: w.missionId, staleAfterMinutes: 1, now: new Date(), applyOwnerDecisionActions: true,
      dispatchOwnerDecisionWakeups: true,
    });

  it("lets a same-source replacement wait win just before Transaction A", async () => {
    const w = await seedAutomatic(db), beforeA = deferred<void>(), waitCommitted = deferred<void>();
    const observed = gateMissionLock(db, 3, async () => { beforeA.resolve(); await waitCommitted.promise; });
    const outcomes: unknown[] = [], callback = nativeCallback(writerDb, outcomes);
    const running = supervise(observed, w, callback);
    await beforeA.promise;
    await writeC08Wait(writerDb, w);
    waitCommitted.resolve();
    const result = await running;
    expect(result.findings.join("\n")).toContain("owner_action_grace_default_not_applied");
    expect(await db.select().from(issues).where(eq(issues.id, w.sourceIssueId))).toMatchObject([{ status: "blocked" }]);
    expect(await applyRows(w)).toHaveLength(0); expect(await resumeRows(w)).toHaveLength(0); expect(outcomes).toHaveLength(0);
  }, 30_000);

  it("commits A before the callback can write a wait, and B leaves only A's apply record", async () => {
    const w = await seedAutomatic(db), outcomes: unknown[] = [];
    const callback = async (input: Parameters<NonNullable<MissionServiceDeps["onOwnerDecisionRetrySourceIssueApplied"]>>[0]) => {
      await writeC08Wait(writerDb, w);
      return nativeCallback(writerDb, outcomes)(input);
    };
    const result = await supervise(db, w, callback);
    expect(result.findings.join("\n")).toContain("owner_action_grace_default_retry");
    expect(await applyRows(w)).toHaveLength(1);
    expect(await db.select().from(issues).where(eq(issues.id, w.sourceIssueId))).toMatchObject([{ status: "todo" }]);
    expect(outcomes).toMatchObject([{ kind: "report_only", reason: "wake_rejected" }]);
    expect(await resumeRows(w)).toHaveLength(0);
  }, 30_000);

  it("dispatches the no-wait automatic continuation through the native queue", async () => {
    const w = await seedAutomatic(db), outcomes: unknown[] = [];
    const result = await supervise(db, w, nativeCallback(db, outcomes));
    expect(result.findings.join("\n")).toContain("owner_action_grace_default_retry");
    expect(outcomes).toMatchObject([{ kind: "dispatched" }]);
    expect(await applyRows(w)).toHaveLength(1); expect(await resumeRows(w)).toHaveLength(1);
  }, 30_000);

  it("does not reopen a concurrent settlement and rolls back a rejected apply insert", async () => {
    const settled = await seedAutomatic(db), beforeA = deferred<void>(), settledCommit = deferred<void>();
    const observed = gateMissionLock(db, 3, async () => { beforeA.resolve(); await settledCommit.promise; });
    const settling = supervise(observed, settled, undefined);
    await beforeA.promise;
    await writerDb.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, settled.sourceIssueId));
    settledCommit.resolve(); await settling;
    expect(await db.select().from(issues).where(eq(issues.id, settled.sourceIssueId))).toMatchObject([{ status: "done" }]);
    expect(await applyRows(settled)).toHaveLength(0);

    const rollback = await seedAutomatic(db);
    const rollbackOutcomes: unknown[] = [], nativeRollbackCallback = nativeCallback(db, rollbackOutcomes);
    let rollbackCallbackCalls = 0;
    const rollbackCallback = async (input: Parameters<typeof nativeRollbackCallback>[0]) => {
      rollbackCallbackCalls += 1;
      return nativeRollbackCallback(input);
    };
    await db.$client.unsafe(`CREATE FUNCTION h24_fail_retry_apply() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type = 'mission_owner_retry_apply' THEN RAISE EXCEPTION 'h24 apply insert rejected'; END IF;
      RETURN NEW; END $$; CREATE TRIGGER h24_fail_retry_apply BEFORE INSERT ON workflow_transition_events
      FOR EACH ROW EXECUTE FUNCTION h24_fail_retry_apply()`);
    try { await expect(supervise(db, rollback, rollbackCallback)).rejects.toThrow("h24 apply insert rejected"); }
    finally { await db.$client.unsafe("DROP TRIGGER h24_fail_retry_apply ON workflow_transition_events; DROP FUNCTION h24_fail_retry_apply()"); }
    expect(await db.select().from(issues).where(eq(issues.id, rollback.sourceIssueId))).toMatchObject([{ status: "blocked" }]);
    expect(await applyRows(rollback)).toHaveLength(0); expect(rollbackCallbackCalls).toBe(0);
    expect(rollbackOutcomes).toHaveLength(0);
  }, 45_000);

  it("keeps the current explicit retry path live", async () => {
    const w = await seedAutomatic(db), outcomes: unknown[] = [], heartbeatRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId: w.companyId, agentId: w.ownerAgentId,
      issueId: w.ownerActionIssueId, status: "succeeded" });
    const decision = await recordMissionOwnerDecision({ db,
      issue: { id: w.ownerActionIssueId, companyId: w.companyId, missionId: w.missionId },
      submission: { decision: "retry_source_issue", recoveryTarget: { kind: "issue", issueId: w.sourceIssueId },
        sourceIssueRef: w.sourceIssueId }, sourceIssueId: w.sourceIssueId, heartbeatRunId });
    const result = await supervise(db, w, nativeCallback(db, outcomes));
    expect(result.findings.join("\n")).not.toContain("owner_action_grace_default_waiting");
    expect(outcomes).toMatchObject([{ kind: "dispatched" }]);
    expect(await resumeRows(w)).toHaveLength(1);
    expect(decision.eventId).toBeTruthy();
  }, 30_000);
});

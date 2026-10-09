import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOwnerActions } from "../services/missions/owner-actions.js";
import { runMissionTerminalCleanup } from "../services/missions/terminal-cleanup-fence.js";
import {
  postgresError, seedTerminalTransaction, startTerminalTransactionDatabase, terminalState,
  type TerminalFixture,
} from "./helpers/mission-terminal-transaction.js";

// Regression: a callback that returns to the pool self-blocks on A's issue locks.
// DB triggers record real backend PID + transaction ID, not mocked executor calls.
describe("terminal cleanup A then oversight/owner-action B share one transaction", () => {
  let testDb: Awaited<ReturnType<typeof startTerminalTransactionDatabase>>;
  beforeAll(async () => { testDb = await startTerminalTransactionDatabase(); }, 60_000);
  afterAll(async () => { await testDb?.cleanup(); });
  beforeEach(async () => { await testDb.db.$client.unsafe("truncate terminal_test_writes"); });

  async function beginTrace() {
    await testDb.db.$client.unsafe("truncate terminal_test_writes");
    testDb.trace.length = 0;
  }

  async function assertCompleted(f: TerminalFixture) {
    const state = await terminalState(testDb.db, f);
    expect(state.missions[0]).toMatchObject({ status: "completed", completedAt: f.completedAt });
    expect(state.issues.find((issue) => issue.id === f.issueId)).toMatchObject({
      status: "done", completedAt: f.completedAt, checkoutRunId: null, executionRunId: null,
      executionAgentNameKey: null, executionLockedAt: null,
    });
    expect(state.runs[0]).toMatchObject({ status: "cancelled", errorCode: "cancelled", error: "Cancelled because mission was completed" });
    expect(state.runtimes[0]).toMatchObject({ status: "stopped", queueDepth: 0, stopReason: "mission.completed" });
    return state;
  }

  async function assertOneTransaction(f: TerminalFixture, nested = false) {
    const writes = await testDb.db.$client.unsafe<{
      relation: string; row_id: string; status: string; backend_pid: number; transaction_id: string;
    }[]>("select * from terminal_test_writes order by sequence");
    expect(writes.length).toBeGreaterThan(3);
    expect(new Set(writes.map((row) => row.backend_pid)).size).toBe(1);
    expect(new Set(writes.map((row) => row.transaction_id)).size).toBe(1);
    const cancelledRun = writes.findIndex((row) => row.relation === "heartbeat_runs" && row.status === "cancelled");
    const clearedIssue = writes.findIndex((row) => row.row_id === f.issueId && row.status === "in_progress");
    const stoppedRuntime = writes.findIndex((row) => row.relation === "mission_agent_runtimes" && row.status === "stopped");
    const closedOversight = writes.findIndex((row) => row.row_id === f.issueId && row.status === "done");
    expect(cancelledRun).toBeGreaterThanOrEqual(0);
    expect(clearedIssue).toBeGreaterThan(cancelledRun);
    expect(stoppedRuntime).toBeGreaterThan(clearedIssue);
    expect(closedOversight).toBeGreaterThan(stoppedRuntime);
    const begin = testDb.trace.findIndex((row) => /^begin\s*$/i.test(row.query));
    const commit = testDb.trace.findIndex((row, index) => index > begin && /^commit$/i.test(row.query));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(begin);
    const transactionQueries = testDb.trace.slice(begin, commit + 1);
    expect(new Set(transactionQueries.map((row) => row.connection)).size).toBe(1);
    if (nested) {
      expect(transactionQueries.some((row) => /^savepoint /i.test(row.query))).toBe(true);
      const closedAction = writes.findIndex((row) => row.row_id === f.actionId && row.status === "done");
      expect(closedAction).toBeGreaterThan(stoppedRuntime);
      expect(closedOversight).toBeGreaterThan(closedAction);
      expect(writes.some((row) => row.relation === "issue_comments")).toBe(true);
      expect(writes.some((row) => row.relation === "activity_log")).toBe(true);
    }
  }

  it.each([false, true])("automatically completes open oversight without a second connection (workflow-created=%s)", async (workflowCreated) => {
    const { db } = testDb;
    const f = await seedTerminalTransaction(db, workflowCreated);
    const before = await terminalState(db, f);
    await beginTrace();
    try {
      const result = await createOwnerActions({ db, deps: {} }).reconcileMissionStatusFromWorkflowRuns(f.mission);
      expect(result.status).toBe("completed");
    } catch (error) {
      // RED must be the known product lock failure, with A's writes rolled back.
      expect(await terminalState(db, f)).toEqual(before);
      expect(postgresError(error).code).toBe("55P03");
      throw error;
    }
    await assertCompleted(f);
    await assertOneTransaction(f);
  });

  async function cleanupWithOwnerAction(f: TerminalFixture) {
    const { db } = testDb;
    // Exercise the exact callback exported to both automatic fence call sites.
    // Calling the fence directly keeps the owner action unresolved until B;
    // reconcile's preliminary open-work check would otherwise settle it before A.
    return runMissionTerminalCleanup(db, {
      companyId: f.companyId, missionId: f.missionId, status: "completed",
      now: f.completedAt, completedAt: f.completedAt, missionSnapshot: f.mission,
      pendingMissionUpdates: { status: "completed", completedAt: f.completedAt },
      completeOpenMissionOversightIfSettled: createOwnerActions({ db, deps: {} }).completeOpenMissionOversightIfSettled,
    });
  }

  it("settles owner action, comment and activity in B's same-connection savepoint", async () => {
    const f = await seedTerminalTransaction(testDb.db, false, true);
    await beginTrace();
    expect((await cleanupWithOwnerAction(f)).aborted).toBe(false);
    const state = await assertCompleted(f);
    expect(state.issues.find((issue) => issue.id === f.actionId)).toMatchObject({ status: "done", completedAt: f.completedAt });
    expect(state.comments).toHaveLength(1);
    expect(state.comments[0].issueId).toBe(f.actionId);
    expect(state.activity).toEqual([expect.objectContaining({
      entityId: f.actionId, action: "mission.owner_action_settled_from_source",
      details: expect.objectContaining({ sourceIssueId: f.sourceId, nextStatus: "done" }),
    })]);
    await assertOneTransaction(f, true);
  });

  it("rolls back A and nested B including logs when oversight settlement fails", async () => {
    const { db } = testDb;
    const f = await seedTerminalTransaction(db, false, true);
    const before = await terminalState(db, f);
    await db.$client.unsafe(`
      create function terminal_test_reject_oversight() returns trigger language plpgsql as $$
      begin
        if NEW.id = '${f.issueId}'::uuid and NEW.status = 'done' then
          raise exception 'injected oversight settlement failure';
        end if;
        return NEW;
      end $$;
      create trigger terminal_test_reject before update on issues
        for each row execute function terminal_test_reject_oversight();
    `);
    await beginTrace();
    let failure: unknown;
    try { await cleanupWithOwnerAction(f); } catch (error) { failure = error; }
    finally {
      await db.$client.unsafe("drop trigger terminal_test_reject on issues; drop function terminal_test_reject_oversight()");
    }
    expect(postgresError(failure)).toMatchObject({ code: "P0001", message: "injected oversight settlement failure" });
    expect(await terminalState(db, f)).toEqual(before);
    expect(await db.$client.unsafe("select * from terminal_test_writes")).toHaveLength(0);
    expect(testDb.trace.some((row) => /^savepoint /i.test(row.query))).toBe(true);
    expect(testDb.trace.some((row) => /^rollback$/i.test(row.query))).toBe(true);
    expect(testDb.trace.some((row) => /^commit$/i.test(row.query))).toBe(false);
  });
});

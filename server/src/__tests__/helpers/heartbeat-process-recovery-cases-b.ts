// Heartbeat orphaned-process recovery cases moved out of heartbeat-process-recovery.test.ts
// (T16d, file <=1000 lines).
// Slice: activity/fallback/wake/promotion and SKIP LOCKED cases (21-29).
// Case bodies are moved verbatim: the describe-scoped db connection, service handle and fixture
// helpers are injected by the caller so the suite lifecycle stays in one place.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { type ChildProcess } from "node:child_process";
import { eq, sql } from "drizzle-orm";
import { expect, it, beforeAll } from "vitest";
import { createDb, agents, activityLog, agentWakeupRequests, companies, heartbeatRunEvents, heartbeatRuns, issues, missions } from "@paperclipai/db";
import { runningProcesses } from "../../adapters/index.ts";
import { heartbeatService, setHeartbeatRunStatus } from "../../services/heartbeat.ts";
import { HUMAN_OPERATOR_REQUEST_ACTION } from "../../services/missions/human-operator-alert-events.js";
import { spawnAliveProcess, staleQueuedAt, waitForPidExit, waitForRunStatus, seedRunFixture, seedRunnableAgent, insertOrphanWake, insertRunningRun, createCountingCommand, makeQueuedRecovery, setFinalizationV1 } from "./heartbeat-process-recovery-fixtures.js";

export function registerHeartbeatProcessRecoveryCasesB(deps: {
  getDb: () => ReturnType<typeof createDb>;
  childProcesses: Set<ChildProcess>;
}) {
  const { getDb, childProcesses } = deps;

  // Late-bound: the caller assigns these describe-scoped values in its own beforeAll, which
  // is registered before this hook, so every case sees the live connection and service.
  let db!: ReturnType<typeof createDb>;
  beforeAll(() => {
    db = getDb();
  });

  it("clears the detached warning when the run reports activity again", async () => {
    const { runId } = await seedRunFixture({
      includeIssue: false,
      runErrorCode: "process_detached",
      runError: "Lost in-memory process handle, but child pid 123 is still alive",
    });
    const heartbeat = heartbeatService(db);

    const updated = await heartbeat.reportRunActivity(runId);
    expect(updated?.errorCode).toBeNull();
    expect(updated?.error).toBeNull();

    const run = await heartbeat.getRun(runId);
    expect(run?.errorCode).toBeNull();
    expect(run?.error).toBeNull();
  });

  it("fails a free stale queue once and releases its issue", async () => {
    const command = createCountingCommand();
    const { runId, issueId, wakeupRequestId } = await seedRunFixture({ runStatus: "queued", queuedAt: staleQueuedAt(), agentStatus: "active", adapterType: "process", adapterConfig: { command: command.command } });
    const heartbeat = heartbeatService(db);
    expect((await heartbeat.reapOrphanedRuns({ queuedStaleThresholdMs: 1_000 })).reaped).toBe(1);
    expect((await heartbeat.reapOrphanedRuns({ queuedStaleThresholdMs: 1_000 })).reaped).toBe(0);
    expect((await heartbeat.getRun(runId))?.errorCode).toBe("stale_queued");
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeupRequestId)))[0]?.status).toBe("failed");
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]?.executionRunId).toBeNull();
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    expect(events.filter(event => event.eventType === "lifecycle" && event.message?.startsWith("Queued heartbeat run exceeded"))).toHaveLength(1);
    await heartbeat.resumeQueuedRuns();
    expect(fs.existsSync(command.countPath)).toBe(false);
  });

  it("publishes a stale status only after commit and never after rollback", async () => {
    const committed = await seedRunFixture({ runStatus: "queued", includeIssue: false, queuedAt: staleQueuedAt() });
    const winner = makeQueuedRecovery();
    await winner.recover(1_000);
    expect(winner.effects.liveStatusEvents).toBe(1);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, committed.runId)))[0]?.status).toBe("failed");

    const rolledBack = await seedRunFixture({ runStatus: "queued", includeIssue: false, queuedAt: staleQueuedAt() });
    const rollback = makeQueuedRecovery(undefined, async (tx, runId, status, patch, options) => {
      await setHeartbeatRunStatus(tx, runId, status, patch, options);
      throw new Error("force stale transition rollback");
    });
    await rollback.recover(1_000);
    expect(rollback.effects.liveStatusEvents).toBe(0);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, rolledBack.runId)))[0]?.status).toBe("queued");
  });

  it.each([
    { capacity: 2, live: 1, statusOnly: false, expected: "failed" },
    { capacity: 2, live: 2, statusOnly: false, expected: "queued" },
    { capacity: 2, live: 0, statusOnly: true, expected: "failed" },
    { capacity: 1, live: 1, resizeTo: 2, expected: "failed" },
    { capacity: 1, live: 0, statusOnly: false, terminal: true, finalization: true, expected: "failed" },
    { capacity: 1, live: 1, statusOnly: false, terminal: true, finalization: false, expected: "failed" },
  ])("protects only a positively full current capacity ($capacity/$live)", async ({ capacity, live, statusOnly, resizeTo, terminal, finalization, expected }) => {
    if (finalization !== undefined) await setFinalizationV1(finalization);
    const target = await seedRunFixture({ runStatus: "queued", includeIssue: false, agentStatus: "active", maxConcurrentRuns: capacity, queuedAt: staleQueuedAt() });
    const children: ChildProcess[] = [];
    for (let i = 0; i < Math.max(live, Number(Boolean(statusOnly)), Number(Boolean(terminal))); i++) {
      const blocker = await insertRunningRun(target.companyId, target.agentId);
      if (i < live) {
        const child = spawnAliveProcess(); childProcesses.add(child); children.push(child);
        await db.update(heartbeatRuns).set({ processPid: child.pid ?? null }).where(eq(heartbeatRuns.id, blocker.id));
        runningProcesses.set(blocker.id, { child, graceSec: 1 });
      }
      if (terminal) await db.update(heartbeatRuns).set({ status: "succeeded", finalizationVersion: 1, settledAt: null }).where(eq(heartbeatRuns.id, blocker.id));
    }
    const recovery = makeQueuedRecovery(resizeTo ? async () => {
      await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: resizeTo } } }).where(eq(agents.id, target.agentId));
    } : undefined);
    await recovery.recover(1_000);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, target.runId)))[0]?.status).toBe(expected);
    if (statusOnly) expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, target.agentId))).filter(run => run.status === "running")).toHaveLength(1);
  });

  it("keeps an unlinked stale wake while full, then starts that same request once", async () => {
    const command = createCountingCommand();
    const { companyId, agentId } = await seedRunnableAgent({ adapterConfig: { command: command.command } });
    const blocker = await insertRunningRun(companyId, agentId), child = spawnAliveProcess(); childProcesses.add(child);
    await db.update(heartbeatRuns).set({ processPid: child.pid ?? null }).where(eq(heartbeatRuns.id, blocker.id));
    runningProcesses.set(blocker.id, { child, graceSec: 1 });
    const wakeupRequestId = await insertOrphanWake(companyId, agentId);
    const heartbeat = heartbeatService(db);
    const first = await heartbeat.reapOrphanedRuns({ queuedStaleThresholdMs: 1_000 });
    const preserved = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeupRequestId)))[0]!;
    expect(first.reaped).toBe(0);
    expect(preserved.status).toBe("queued");
    expect(preserved.runId).toBeNull();
    expect(fs.existsSync(command.countPath)).toBe(false);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, wakeupRequestId))).length).toBe(0);
    child.kill("SIGKILL"); await waitForPidExit(child.pid ?? 0); runningProcesses.delete(blocker.id);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, blocker.id));
    await heartbeat.resumeQueuedRuns(agentId);
    const promoted = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeupRequestId)))[0]!;
    expect(promoted.runId).toBeTypeOf("string");
    expect((await waitForRunStatus(db, promoted.runId!, "succeeded"))?.wakeupRequestId).toBe(wakeupRequestId);
    expect(fs.readFileSync(command.countPath, "utf8")).toBe("1");
  });

  it("promotes a valid wake with no heartbeat rows through the ordinary queue", async () => {
    const command = createCountingCommand(), { companyId, agentId } = await seedRunnableAgent({ adapterConfig: { command: command.command } });
    const wakeupRequestId = await insertOrphanWake(companyId, agentId);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).toHaveLength(0);
    await heartbeatService(db).reapOrphanedRuns({ queuedStaleThresholdMs: 1_000 });
    const wakeup = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeupRequestId)))[0]!;
    expect(wakeup.runId).toBeTypeOf("string");
    expect((await waitForRunStatus(db, wakeup.runId!, "succeeded"))?.wakeupRequestId).toBe(wakeupRequestId);
    expect(fs.readFileSync(command.countPath, "utf8")).toBe("1");
  });

  it("discards stale decisions when a run claim or wake attachment wins", async () => {
    const target = await seedRunFixture({ runStatus: "queued", includeIssue: false, agentStatus: "active", queuedAt: staleQueuedAt() });
    let reachedBeforeLock = false;
    const claim = makeQueuedRecovery(async () => {
      reachedBeforeLock = true;
      await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date(), updatedAt: new Date() }).where(eq(heartbeatRuns.id, target.runId));
    });
    expect((await claim.recover(1_000)).reapedRunIds).toEqual([]);
    expect(reachedBeforeLock).toBe(true);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, target.runId)))[0]).toMatchObject({ status: "running", startedAt: expect.any(Date) });
    expect(claim.effects).toMatchObject({ runEvents: 0, liveStatusEvents: 0, releases: 0, settlements: 0, finalizations: 0 });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, target.wakeupRequestId)))[0]?.status).toBe("pending");

    const agent = await seedRunnableAgent(), attachedId = await insertOrphanWake(agent.companyId, agent.agentId);
    const winner = await insertRunningRun(agent.companyId, agent.agentId);
    const attached = makeQueuedRecovery(async () => { await db.update(agentWakeupRequests).set({ runId: winner.id, updatedAt: new Date() }).where(eq(agentWakeupRequests.id, attachedId)); });
    await attached.recover(1_000);
    const [attachedWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, attachedId));
    expect(attachedWake).toMatchObject({ status: "queued", runId: winner.id });
    expect(attached.effects.queueEvents).toBe(0);
  });

  it("preserves a fresh reverse-linked heartbeat while refusing to orphan its stale wake", async () => {
    const agent = await seedRunnableAgent(), reverseId = await insertOrphanWake(agent.companyId, agent.agentId);
    const reverseRunId = randomUUID(), freshAt = new Date();
    await db.insert(heartbeatRuns).values({ id: reverseRunId, companyId: agent.companyId, agentId: agent.agentId, invocationSource: "automation", triggerDetail: "system", status: "queued", wakeupRequestId: reverseId, contextSnapshot: {}, startedAt: null, createdAt: freshAt, updatedAt: freshAt });
    const recovery = makeQueuedRecovery();
    await recovery.recover(1_000);
    const [wakeup] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, reverseId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, reverseRunId));
    expect(wakeup).toMatchObject({ status: "queued", runId: null });
    expect(run).toMatchObject({ status: "queued", errorCode: null, finishedAt: null, wakeupRequestId: reverseId });
    expect(recovery.effects.queueEvents).toBe(0);
  });

  it("marks a failed mission_main_executor_unblock blocked without emitting a Human Operator request (boundary)", async () => {
    // [root-cause boundary] releaseIssueExecutionAndPromote marks a terminal failed/timed_out
    //   mission_main_executor_unblock issue blocked + generic run_failure_auto_blocked only. It must NOT
    //   itself emit the Human Operator request — that is supervision's job, gated on truly-terminal.
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const sourceIssueId = randomUUID();
    const ownerActionIssueId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issuePrefix = `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date();

    await db.insert(companies).values({ id: companyId, name: "Boundary Co", issuePrefix, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Boundary mission", status: "active" });
    await db.insert(issues).values({
      id: sourceIssueId, companyId, missionId, identifier: `${issuePrefix}-1`, title: "Blocked source",
      status: "blocked", assigneeAgentId: workerAgentId, originKind: "workflow_execution",
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId, companyId, agentId: ownerAgentId, source: "assignment", triggerDetail: "system",
      reason: "issue_assigned", payload: { issueId: ownerActionIssueId }, status: "claimed", runId, claimedAt: now,
    });
    const child = spawnAliveProcess();
    childProcesses.add(child);
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId: ownerAgentId, invocationSource: "assignment", triggerDetail: "system",
      status: "running", wakeupRequestId, contextSnapshot: { issueId: ownerActionIssueId, missionId },
      processPid: child.pid ?? null, processStartedAt: new Date(Date.now() - 45 * 60 * 1000),
      processLossRetryCount: 1, startedAt: now, updatedAt: now,
    });
    // owner-action issue references runId (checkout/execution) — insert after the run exists.
    await db.insert(issues).values({
      id: ownerActionIssueId, companyId, missionId, identifier: `${issuePrefix}-2`, title: "[Unblock] source",
      status: "in_progress", assigneeAgentId: ownerAgentId, originKind: "mission_main_executor_unblock",
      originId: sourceIssueId, checkoutRunId: runId, executionRunId: runId,
    });
    child.kill("SIGKILL");
    await waitForPidExit(child.pid ?? null);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    const reapedRun = await heartbeat.getRun(runId);
    expect(reapedRun?.status).toBe("failed");

    const updatedOwnerAction = await db.select({ status: issues.status, checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues).where(eq(issues.id, ownerActionIssueId)).then((rows) => rows[0] ?? null);
    expect(updatedOwnerAction?.status).toBe("blocked");
    expect(updatedOwnerAction?.checkoutRunId).toBeNull();
    expect(updatedOwnerAction?.executionRunId).toBeNull();

    const activities = await db.select().from(activityLog).where(eq(activityLog.runId, runId));
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "issue.run_failure_auto_blocked", entityId: ownerActionIssueId }),
      ]),
    );
    // heartbeat failure path must NOT create the Human Operator request — supervision owns that.
    const issueActivities = await db.select().from(activityLog).where(eq(activityLog.entityId, ownerActionIssueId));
    expect(issueActivities.some((row) => row.action === HUMAN_OPERATOR_REQUEST_ACTION)).toBe(false);
  });
  it("demotes a phantom-running agent to error while a detached child is deferred (A2)", async () => {
    // [paperclip-stuck 2026-08-06, A2] When the in-memory process handle is gone but the
    // recorded child pid is still alive, reapOrphanedRuns defers the run up to the 30min
    // detached cap. During that window finalizeAgentStatus is never called, so agents.status
    // was pinned at `running` (phantom running). Directly demote the agent to `error` once
    // it has been stuck detached beyond a shorter heartbeat threshold, even though the run
    // itself is intentionally left alive under the longevity cap.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issuePrefix = `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const staleUpdatedAt = new Date(Date.now() - 15 * 60 * 1000); // > 10min demote threshold

    await db.insert(companies).values({
      id: companyId,
      name: "Phantom Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Phantom",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      updatedAt: staleUpdatedAt,
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: {},
      status: "claimed",
      runId,
      claimedAt: staleUpdatedAt,
    });
    const child = spawnAliveProcess();
    childProcesses.add(child);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId,
      contextSnapshot: {},
      processPid: child.pid ?? null,
      processStartedAt: new Date(),
      processLossRetryCount: 0,
      startedAt: staleUpdatedAt,
      updatedAt: staleUpdatedAt,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapOrphanedRuns();
    // run is within the 30min cap → not reaped, stays running + detached.
    expect(result.reaped).toBe(0);
    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).toBe("process_detached");
    // agent is no longer phantom-running: demoted to error.
    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    expect(agent?.status).toBe("error");
  });

  it("does not demote an agent that still has a genuinely-progressing (non-detached) run", async () => {
    // [A2 guard] A demote must never fire while a sibling run is making real progress. Here
    // the agent has one detached run AND one fresh non-detached running run → it stays running.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const detachedRunId = randomUUID();
    const progressingRunId = randomUUID();
    const detachedWakeupId = randomUUID();
    const progressingWakeupId = randomUUID();
    const issuePrefix = `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const staleUpdatedAt = new Date(Date.now() - 15 * 60 * 1000);

    await db.insert(companies).values({ id: companyId, name: "Guard Co", issuePrefix, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Guard", role: "engineer", status: "running",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
      updatedAt: staleUpdatedAt,
    });
    await db.insert(agentWakeupRequests).values([
      { id: detachedWakeupId, companyId, agentId, source: "assignment", triggerDetail: "system", reason: "issue_assigned", payload: {}, status: "claimed", runId: detachedRunId, claimedAt: staleUpdatedAt },
      { id: progressingWakeupId, companyId, agentId, source: "assignment", triggerDetail: "system", reason: "issue_assigned", payload: {}, status: "claimed", runId: progressingRunId, claimedAt: new Date() },
    ]);
    const child = spawnAliveProcess();
    childProcesses.add(child);
    // progressing run is genuinely tracked in-memory (live handle) → survives the reaper.
    const progressingChild = spawnAliveProcess();
    childProcesses.add(progressingChild);
    runningProcesses.set(progressingRunId, { child: progressingChild, graceSec: 1 });
    await db.insert(heartbeatRuns).values([
      {
        id: detachedRunId, companyId, agentId, invocationSource: "assignment", triggerDetail: "system",
        status: "running", wakeupRequestId: detachedWakeupId, contextSnapshot: {},
        processPid: child.pid ?? null, processStartedAt: new Date(), processLossRetryCount: 0,
        startedAt: staleUpdatedAt, updatedAt: staleUpdatedAt,
      },
      {
        id: progressingRunId, companyId, agentId, invocationSource: "assignment", triggerDetail: "system",
        status: "running", wakeupRequestId: progressingWakeupId, contextSnapshot: {},
        processPid: progressingChild.pid ?? null, processStartedAt: new Date(), processLossRetryCount: 0,
        startedAt: new Date(), updatedAt: new Date(),
      },
    ]);

    const heartbeat = heartbeatService(db);
    await heartbeat.reapOrphanedRuns();

    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    // sibling progressing run protects the agent from demotion.
    expect(agent?.status).toBe("running");
  });

  it("skips release+promote when the bound issue is locked by another transaction (SKIP LOCKED)", async () => {
    // Regression: releaseIssueExecutionAndPromote locks the issue with FOR UPDATE
    // SKIP LOCKED. If another transaction holds the row lock, the lock select returns
    // no rows and the whole transaction must bail early (return null) instead of
    // waiting — otherwise the recovery lane hangs on the lock wait.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "SkipLocked Co",
      issuePrefix: `SL${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SkipLocked Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Locked issue",
      status: "in_progress",
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      status: "claimed",
      runId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      issueId,
      wakeupRequestId,
      contextSnapshot: {},
    });
    // Link execution_run_id AFTER the run exists (FK: issues.execution_run_id -> heartbeat_runs.id).
    await db
      .update(issues)
      .set({ executionRunId: runId })
      .where(eq(issues.id, issueId));

    const heartbeat = heartbeatService(db);

    // Hold the issue row lock in a separate transaction.
    const heldLock = await db.transaction(async (tx) => {
      await tx.execute(sql`select id from issues where id = ${issueId} for update`);
      // While the lock is held, reapOrphanedRuns must NOT hang; the run is
      // terminal and would otherwise go through release+promote.
      const result = await heartbeat.reapOrphanedRuns();
      return result;
    });

    expect(heldLock.reaped).toBe(1); // run itself is reaped (terminalized)…
    // …but the release+promote step bailed early (return null) — the issue lock
    // was not acquired, so execution_run_id is still set (no early cleanup).
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.executionRunId).toBe(runId);
  });
}

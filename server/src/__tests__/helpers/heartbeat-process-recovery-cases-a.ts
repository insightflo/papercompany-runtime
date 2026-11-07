// Heartbeat orphaned-process recovery cases moved out of heartbeat-process-recovery.test.ts
// (T16d, file <=1000 lines).
// Slice: queue/live-blocker, stale-orphan, detached-run and linked-run cases (1-20).
// Case bodies are moved verbatim: the describe-scoped db connection, service handle and fixture
// helpers are injected by the caller so the suite lifecycle stays in one place.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ChildProcess } from "node:child_process";
import { eq } from "drizzle-orm";
import { expect, it, beforeAll } from "vitest";
import { createDb, agents, agentWikiEntries, activityLog, agentWakeupRequests, companies, heartbeatRunEvents, heartbeatRuns, issues, issueComments, missions, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { runningProcesses } from "../../adapters/index.ts";
import { heartbeatService } from "../../services/heartbeat.ts";
import { approvalWaitFixtures } from "./approval-wait-fixtures.js";
import { spawnAliveProcess, staleQueuedAt, waitForPidExit, waitForRunStatus, seedRunFixture, seedRunnableAgent, insertOrphanWake, insertRunningRun, createCountingCommand, makeQueuedRecovery, setFinalizationV1 } from "./heartbeat-process-recovery-fixtures.js";

export function registerHeartbeatProcessRecoveryCasesA(deps: {
  getDb: () => ReturnType<typeof createDb>;
  tempDirs: Set<string>;
  childProcesses: Set<ChildProcess>;
}) {
  const { getDb, tempDirs, childProcesses } = deps;

  // Late-bound: the caller assigns these describe-scoped values in its own beforeAll, which
  // is registered before this hook, so every case sees the live connection and service.
  let db!: ReturnType<typeof createDb>;
  beforeAll(() => {
    db = getDb();
  });

  it.each([{ terminal: false }, { terminal: true }])("preserves the original queue behind a live blocker (terminal-unsettled v1=$terminal)", async ({ terminal }) => {
    await setFinalizationV1(terminal);
    const command = createCountingCommand();
    const queued = await seedRunFixture({ adapterType: "process", adapterConfig: { command: command.command }, runStatus: "queued", agentStatus: "active", maxConcurrentRuns: 1, queuedAt: staleQueuedAt() });
    const blocker = await insertRunningRun(queued.companyId, queued.agentId), child = spawnAliveProcess();
    childProcesses.add(child); runningProcesses.set(blocker.id, { child, graceSec: 1 });
    await db.update(heartbeatRuns).set({ processPid: child.pid ?? null }).where(eq(heartbeatRuns.id, blocker.id));
    if (terminal) await db.update(heartbeatRuns).set({
      status: "succeeded", finishedAt: new Date(), finalizationVersion: 1, settledAt: null,
    }).where(eq(heartbeatRuns.id, blocker.id));
    const [beforeRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.runId));
    const [beforeWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queued.wakeupRequestId));
    expect((await heartbeatService(db).reapOrphanedRuns({ queuedStaleThresholdMs: 1_000 })).reaped).toBe(0);
    const [waitingRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.runId));
    const [waitingWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queued.wakeupRequestId));
    expect(waitingRun).toMatchObject({ id: beforeRun.id, status: "queued", wakeupRequestId: beforeRun.wakeupRequestId, issueId: beforeRun.issueId, createdAt: beforeRun.createdAt, updatedAt: beforeRun.updatedAt });
    expect(waitingWake).toMatchObject({ id: beforeWake.id, status: "pending", runId: queued.runId, updatedAt: beforeWake.updatedAt });
    const [waitingBlocker] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, blocker.id));
    expect(waitingBlocker).toMatchObject(terminal
      ? { status: "succeeded", finalizationVersion: 1, settledAt: null }
      : { status: "running" });
    expect(fs.existsSync(command.countPath)).toBe(false);
    const [issue] = await db.select().from(issues).where(eq(issues.id, queued.issueId));
    expect(issue).toMatchObject({ checkoutRunId: queued.runId, executionRunId: queued.runId });
    child.kill("SIGKILL"); await waitForPidExit(child.pid ?? 0); runningProcesses.delete(blocker.id);
    await db.update(heartbeatRuns).set(terminal
      ? { settledAt: new Date(), updatedAt: new Date() }
      : { status: "succeeded", finishedAt: new Date(), updatedAt: new Date() }).where(eq(heartbeatRuns.id, blocker.id));
    await heartbeatService(db).resumeQueuedRuns(queued.agentId);
    expect(await waitForRunStatus(db, queued.runId, "succeeded")).toMatchObject({ id: queued.runId, wakeupRequestId: queued.wakeupRequestId });
    expect(fs.readFileSync(command.countPath, "utf8")).toBe("1");
  });

  it.each(["bare-pid", "tracked-exited-child", "other-agent", "other-company"] as const)("does not treat %s as live capacity for another queue", async kind => {
    let companyId: string, agentId: string;
    const target = await seedRunFixture({ runStatus: "queued", includeIssue: false, agentStatus: "active", maxConcurrentRuns: 1, queuedAt: staleQueuedAt() });
    companyId = target.companyId; agentId = target.agentId;
    if (kind === "other-agent") {
      agentId = randomUUID();
      await db.insert(agents).values({ id: agentId, companyId, name: "Other agent", role: "engineer", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} });
    } else if (kind === "other-company") ({ companyId, agentId } = await seedRunnableAgent());
    const blocker = await insertRunningRun(companyId, agentId);
    let child: ChildProcess | null = null;
    if (kind === "tracked-exited-child") {
      child = spawnAliveProcess(); childProcesses.add(child); child.kill("SIGKILL"); await waitForPidExit(child.pid ?? 0);
      runningProcesses.set(blocker.id, { child, graceSec: 1 });
    } else if (kind === "other-agent" || kind === "other-company") {
      child = spawnAliveProcess(); childProcesses.add(child); runningProcesses.set(blocker.id, { child, graceSec: 1 });
    }
    await db.update(heartbeatRuns).set({ processPid: kind === "bare-pid" ? process.pid : child?.pid ?? null }).where(eq(heartbeatRuns.id, blocker.id));
    await makeQueuedRecovery().recover(1_000);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, target.runId)))[0]).toMatchObject({ status: "failed", errorCode: "stale_queued" });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, blocker.id)))[0]).toMatchObject({ status: "running" });
  });

  it("fails only the stale queued sibling and preserves the fresh sibling fields", async () => {
    const stale = await seedRunFixture({ runStatus: "queued", includeIssue: false, agentStatus: "active", queuedAt: staleQueuedAt() });
    const siblingId = randomUUID(), wakeId = randomUUID(), freshAt = new Date();
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: stale.companyId, agentId: stale.agentId, source: "automation", triggerDetail: "system", reason: "fresh sibling", payload: {}, status: "pending", runId: siblingId, createdAt: freshAt, updatedAt: freshAt });
    await db.insert(heartbeatRuns).values({ id: siblingId, companyId: stale.companyId, agentId: stale.agentId, invocationSource: "automation", triggerDetail: "system", status: "queued", wakeupRequestId: wakeId, contextSnapshot: {}, startedAt: null, createdAt: freshAt, updatedAt: freshAt });
    expect((await makeQueuedRecovery().recover(1_000)).reapedRunIds).toEqual([stale.runId]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, stale.runId)))[0]).toMatchObject({ status: "failed", errorCode: "stale_queued", finishedAt: expect.any(Date) });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, siblingId)))[0]).toMatchObject({ status: "queued", error: null, errorCode: null, finishedAt: null, createdAt: freshAt, updatedAt: freshAt });
  });

  it("expires an invalid stale orphan without making a heartbeat or starting an adapter", async () => {
    const command = createCountingCommand(), agent = await seedRunnableAgent({ adapterConfig: { command: command.command } });
    const issueId = randomUUID(), wakeId = await insertOrphanWake(agent.companyId, agent.agentId, { issueId });
    await db.update(agentWakeupRequests).set({ payload: { issueId } }).where(eq(agentWakeupRequests.id, wakeId));
    await heartbeatService(db).reapOrphanedRuns({ queuedStaleThresholdMs: 1_000 });
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    expect(wake).toMatchObject({ status: "failed", runId: null, finishedAt: expect.any(Date) });
    expect(wake.error).toMatch(/issue not found/i);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, wakeId))).toHaveLength(0);
    expect(fs.existsSync(command.countPath)).toBe(false);
  });

  it.each(["decision", "approval"] as const)("skips an approval-waiting wake and promotes the next valid wake (%s)", async kind => {
    const command = createCountingCommand(), fixtures = approvalWaitFixtures(db), base = await fixtures.seedBase();
    await db.update(agents).set({ status: "active", adapterType: "process", adapterConfig: { command: command.command }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, base.agentId));
    await db.update(issues).set({ assigneeAgentId: base.agentId }).where(eq(issues.id, base.issueId));
    if (kind === "decision") await fixtures.seedPendingDecision(base.companyId, base.issueId);
    else await fixtures.seedPendingApproval(base.companyId, base.issueId);
    const waiting = await fixtures.seedRun({ ...base, status: "queued", withRunRow: false });
    const validId = await insertOrphanWake(base.companyId, base.agentId);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, base.agentId))).toHaveLength(0);
    await heartbeatService(db).reapOrphanedRuns({ queuedStaleThresholdMs: 1_000 });
    const [waitingWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, waiting.wakeupId));
    const [validWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, validId));
    expect(waitingWake).toMatchObject({ status: "queued", runId: null });
    expect(validWake?.runId).toBeTypeOf("string");
    expect(await waitForRunStatus(db, validWake!.runId!, "succeeded")).toMatchObject({ wakeupRequestId: validId });
    expect(fs.readFileSync(command.countPath, "utf8")).toBe("1");
  });

  it("keeps a local run active when the recorded pid is still alive", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const { runId, wakeupRequestId } = await seedRunFixture({
      processPid: child.pid ?? null,
      processStartedAt: new Date(),
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(0);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).toBe("process_detached");
    expect(run?.error).toContain(String(child.pid));

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("claimed");
  });

  it("force-reaps a detached local run whose child has run past the detached cap", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const { runId } = await seedRunFixture({
      processPid: child.pid ?? null,
      // 45분 전 시작 — DETACHED_REAP_AFTER_MS(30분) 초과 → cap 발동해 process_lost 회수
      processStartedAt: new Date(Date.now() - 45 * 60 * 1000),
      processLossRetryCount: 1,
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("process_lost");
  });

  it("records a process_lost wiki entry when a detached run is force-reaped", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const seeded = await seedRunFixture({
      processPid: child.pid ?? null,
      processStartedAt: new Date(Date.now() - 45 * 60 * 1000), // > 30min cap → process_lost
      processLossRetryCount: 1,
      includeIssue: false,
    });
    const heartbeat = heartbeatService(db);
    await heartbeat.reapOrphanedRuns();
    // fireWikiRecord is non-blocking — let the recordFailure insert settle.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const entries = await db
      .select()
      .from(agentWikiEntries)
      .where(eq(agentWikiEntries.agentId, seeded.agentId));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.errorCode).toBe("process_lost");
    expect(entries[0]?.pattern).toContain("process_lost");
  });

  it("terminates a detached recorded pid when cancelling the run", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const { runId, issueId } = await seedRunFixture({
      processPid: child.pid ?? null,
    });
    const heartbeat = heartbeatService(db);

    const cancelled = await heartbeat.cancelRun(runId);

    expect(cancelled?.status).toBe("cancelled");
    expect(await waitForPidExit(child.pid as number)).toBe(true);
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.checkoutRunId).toBeNull();
    expect(issue?.executionRunId).toBeNull();
  });
  it("terminalizes an active linked run immediately when an issue is marked done", async () => {
    const { companyId, runId, wakeupRequestId, issueId } = await seedRunFixture();

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.finalizeLinkedRunsForIssueStatus({
      issueId,
      companyId,
      status: "done",
      linkedRunIds: [runId],
    });

    expect(result).toEqual({ finalized: 1, runIds: [runId] });

    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run).toEqual(expect.objectContaining({
      status: "succeeded",
      errorCode: null,
      error: null,
      finishedAt: expect.any(Date),
    }));

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup).toEqual(expect.objectContaining({
      status: "completed",
      finishedAt: expect.any(Date),
    }));
  });

  it("terminalizes an active linked run as cancelled (control-plane cut) when an issue is marked blocked", async () => {
    const { companyId, runId, wakeupRequestId, issueId, agentId } = await seedRunFixture();
    // finalizeAgentStatus 는 paused 에서 조기 반환하므로 에이전트 관찰 가능 상태로 만든다.
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, agentId));

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.finalizeLinkedRunsForIssueStatus({
      issueId,
      companyId,
      status: "blocked",
      linkedRunIds: [runId],
    });

    expect(result).toEqual({ finalized: 1, runIds: [runId] });

    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run).toEqual(expect.objectContaining({
      // [run honesty] 통제판 절단은 실패가 아니다 — 사유는 errorCode 로 구분한다.
      status: "cancelled",
      errorCode: "issue_status_blocked",
      finishedAt: expect.any(Date),
    }));

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup).toEqual(expect.objectContaining({
      status: "cancelled",
      finishedAt: expect.any(Date),
    }));

    // 2차 오염 방지: 통제판 절단으로 에이전트가 error 로 마킹되지 않아야 한다
    //   (2026-08-19 GAZ: error 마킹이 오너의 재할당 판단을 흔들었다).
    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    expect(agent?.status).toBe("idle");
  });

  // [stale-run auto-block guard, 2026-10-07 CMP-328] 이전 run 이 늦게 끝나도 지금 다른 run 이
  //   소유한 이슈를 blocked 로 만들거나 소유 칸을 지우면 안 된다(소유 run 만 자동 차단).
  async function seedStaleRunWithNewOwner() {
    const fixture = await seedRunFixture();
    const newRunId = randomUUID();
    await db.update(heartbeatRuns).set({ issueId: fixture.issueId }).where(eq(heartbeatRuns.id, fixture.runId));
    await db.insert(heartbeatRuns).values({
      id: newRunId,
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      issueId: fixture.issueId,
      contextSnapshot: { issueId: fixture.issueId },
      startedAt: new Date(),
      updatedAt: new Date(),
    });
    await db.update(issues)
      .set({ checkoutRunId: newRunId, executionRunId: newRunId })
      .where(eq(issues.id, fixture.issueId));
    return { ...fixture, newRunId };
  }

  it("does not auto-block or clear the lock when a stale non-owner run of the same issue ends", async () => {
    const { runId, newRunId, issueId } = await seedStaleRunWithNewOwner();

    await heartbeatService(db).cancelRun(runId);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.checkoutRunId).toBe(newRunId);
    expect(issue?.executionRunId).toBe(newRunId);
    const activities = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(activities.some((row) => row.action === "issue.run_failure_auto_blocked")).toBe(false);
  });

  it("still auto-blocks the issue when the cancelled run is the current owner", async () => {
    const { runId, issueId } = await seedRunFixture();

    await heartbeatService(db).cancelRun(runId);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");
    expect(issue?.checkoutRunId).toBeNull();
    const activities = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(activities.some((row) => row.action === "issue.run_failure_auto_blocked")).toBe(true);
  });

  it("queues exactly one retry when the recorded local pid is dead", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(retryRun?.status).toBe("queued");
    expect(retryRun?.retryOfRunId).toBe(runId);
    expect(retryRun?.processLossRetryCount).toBe(1);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
    expect(issue?.checkoutRunId).toBe(runId);
  });

  it("does not reap a running run that reported recent activity", async () => {
    const { runId, wakeupRequestId } = await seedRunFixture({
      includeIssue: false,
      updatedAt: new Date(),
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 });
    expect(result.reaped).toBe(0);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).toBeNull();

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("claimed");
  });

  it("preserves issue linkage from heartbeatRuns.issueId even when the original context snapshot omits issueId", async () => {
    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
      includeIssue: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Recover local adapter after lost process",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      issueNumber: 1,
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-1`,
    });
    await db
      .update(heartbeatRuns)
      .set({ issueId })
      .where(eq(heartbeatRuns.id, runId));

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const retryRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, runId))
      .then((rows) => rows[0] ?? null);

    expect(retryRun?.issueId).toBe(issueId);
    expect(retryRun?.contextSnapshot).toMatchObject({
      issueId,
      retryOfRunId: runId,
      wakeReason: "process_lost_retry",
    });
  });

  it("restores mission and workflow run context on process-loss retry from the issue graph", async () => {
    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
    });
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepRunId = randomUUID();

    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Workflow mission",
      status: "active",
    });
    await db.update(issues).set({ missionId }).where(eq(issues.id, issueId));
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "daily-news",
      stepsJson: [],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId,
      status: "running",
      triggeredBy: "test",
      startedAt: new Date(),
    });
    await db.insert(workflowStepRuns).values({
      id: stepRunId,
      workflowRunId,
      stepId: "validate-note",
      issueId,
      status: "running",
      startedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.reapOrphanedRuns();

    const retryRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, runId))
      .then((rows) => rows[0] ?? null);

    expect(retryRun?.contextSnapshot).toMatchObject({
      issueId,
      missionId,
      workflowRunId,
      workflowStepId: "validate-note",
      stepId: "validate-note",
      retryOfRunId: runId,
      wakeReason: "process_lost_retry",
    });
  });

  it("does not queue a second retry after the first process-loss retry was already used", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
      processLossRetryCount: 1,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.checkoutRunId).toBeNull();
    expect(issue?.status).toBe("blocked");

    const commentBody = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .then((rows) => rows.map((row) => row.body).join("\n"));
    expect(commentBody).toContain("복구 상태: process_lost retry 1/1, adapter fallback 0회 시도됨");
    expect(commentBody).toContain("자동 retry 한도를 소진");
  });

  it("queues an adapter fallback run after process-loss retry is exhausted", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      processPid: 999_999_999,
      processLossRetryCount: 1,
      adapterConfig: {
        command: "primary-agent",
        fallbackCommand: "fallback-agent",
      },
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    const fallbackRun = runs.find((row) => row.id !== runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(fallbackRun?.status).toBe("queued");
    expect(fallbackRun?.retryOfRunId).toBe(runId);
    expect(fallbackRun?.processLossRetryCount).toBe(1);
    expect(fallbackRun?.contextSnapshot).toMatchObject({
      issueId,
      fallbackOfRunId: runId,
      fallbackReason: "process_lost",
      fallbackAttempt: 1,
      fallbackCommand: "fallback-agent",
      wakeReason: "adapter_fallback",
    });

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(fallbackRun?.id ?? null);
    expect(issue?.checkoutRunId).toBe(runId);
    expect(issue?.status).toBe("in_progress");
  });

  it("executes queued adapter fallback runs with the fallback command", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const failedRunId = randomUUID();
    const fallbackRunId = randomUUID();
    const wakeupRequestId = randomUUID();
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-fallback-bin-"));
    tempDirs.add(binDir);
    const primaryCommand = path.join(binDir, "primary.js");
    const fallbackCommand = path.join(binDir, "fallback.js");
    fs.writeFileSync(primaryCommand, "#!/usr/bin/env node\nprocess.exit(99);\n", "utf8");
    fs.writeFileSync(fallbackCommand, "#!/usr/bin/env node\nconsole.log('fallback ran');\n", "utf8");
    fs.chmodSync(primaryCommand, 0o755);
    fs.chmodSync(fallbackCommand, 0o755);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Fallback Runner",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: primaryCommand,
        fallbackCommand,
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: failedRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "failed",
      errorCode: "process_lost",
      error: "Process lost",
      processLossRetryCount: 1,
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "adapter_fallback",
      payload: { fallbackOfRunId: failedRunId, fallbackReason: "process_lost" },
      status: "queued",
      runId: fallbackRunId,
    });
    await db.insert(heartbeatRuns).values({
      id: fallbackRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      retryOfRunId: failedRunId,
      contextSnapshot: {
        retryOfRunId: failedRunId,
        fallbackOfRunId: failedRunId,
        fallbackReason: "process_lost",
        fallbackAttempt: 1,
        fallbackCommand,
        wakeReason: "adapter_fallback",
      },
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();

    const completed = await waitForRunStatus(db, fallbackRunId, "succeeded");
    expect(completed?.status).toBe("succeeded");

    const invokeEvent = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, fallbackRunId))
      .then((rows) => rows.find((row) => row.eventType === "adapter.invoke") ?? null);
    expect(invokeEvent?.payload).toMatchObject({
      command: fallbackCommand,
    });
    expect(JSON.stringify(invokeEvent?.payload)).not.toContain(primaryCommand);
  });
}

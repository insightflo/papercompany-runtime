// [checkpoint+graceful shutdown] 종료 플러시 계약 테스트 — doc/plans/2026-09-27-checkpoint-shutdown.md
// (a) 마킹+CAS 펜스 (b) 이중 타이머 데드라인 (c) 회수 정합(백스톱, 정확히 1회, envelope 정합)
// (d) 체크포인트 레코드 스키마 불량 거부
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  effectIntents,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { shutdownCheckpointSchema } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

async function seedRunFixture(db: Db, input?: {
  runStatus?: "running" | "failed";
  errorCode?: string | null;
  processLossRetryCount?: number;
  includeIssue?: boolean;
  processPid?: number | null;
}) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const runId = randomUUID();
  const wakeupRequestId = randomUUID();
  const issueId = randomUUID();
  const now = new Date();
  const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
  await db.insert(companies).values({
    id: companyId,
    name: "ShutdownCo",
    status: "active",
    issuePrefix: `${issuePrefix}${Math.floor(Math.random() * 100000)}`,
  });
  await db.insert(agents).values({
    id: agentId, companyId, name: "FlushAgent", role: "engineer", status: "paused",
    adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
  });
  await db.insert(agentWakeupRequests).values({
    id: wakeupRequestId, companyId, agentId, source: "assignment", triggerDetail: "system",
    reason: "issue_assigned", payload: { issueId }, status: "claimed", runId, claimedAt: now,
  });
  await db.insert(heartbeatRuns).values({
    id: runId, companyId, agentId, invocationSource: "assignment", triggerDetail: "system",
    status: input?.runStatus ?? "running", wakeupRequestId,
    contextSnapshot: input?.includeIssue === false ? { sessionId: "sess-1" } : { issueId, sessionId: "sess-1" },
    sessionIdBefore: "sess-1",
    processPid: input?.processPid ?? null, processStartedAt: now,
    processLossRetryCount: input?.processLossRetryCount ?? 0,
    errorCode: input?.errorCode ?? null,
    startedAt: now, updatedAt: now,
  });
  if (input?.includeIssue !== false) {
    await db.insert(issues).values({
      id: issueId, companyId, title: "Survive graceful shutdown", status: "in_progress",
      priority: "medium", assigneeAgentId: agentId, checkoutRunId: runId, executionRunId: runId,
      issueNumber: 1, identifier: `${issuePrefix}-1`,
      lastOperatorInstructionAt: now, lastOperatorInstructionCommentId: randomUUID(),
    });
    // 순환 FK(heartbeat_runs.issue_id ↔ issues.*_run_id) — 런 행 삽입 후 역참조 체움.
    await db.update(heartbeatRuns).set({ issueId }).where(eq(heartbeatRuns.id, runId));
  }
  return { companyId, agentId, runId, wakeupRequestId, issueId };
}

async function getRunRow(db: Db, runId: string) {
  return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((r) => r[0] ?? null);
}

async function countRetrySuccessors(db: Db, runId: string) {
  const rows = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
  return rows.length;
}

describeEP("heartbeat shutdown flush (markRunsShutdownInterrupted)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const children = new Set<ChildProcess>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-shutdown-flush-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    runningProcesses.clear();
    for (const child of children) child.kill("SIGKILL");
    children.clear();
    await db.delete(heartbeatRunEvents);
    await db.delete(effectIntents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    for (const child of children) child.kill("SIGKILL");
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  it("(a) marks a tracked running run failed+shutdown_interrupted with a valid checkpoint and queues exactly one retry", async () => {
    const seeded = await seedRunFixture(db);
    const effectId = `eff-${randomUUID()}`;
    await db.insert(effectIntents).values({
      companyId: seeded.companyId, effectKind: "agent_execution", effectId,
      anchorKey: `anchor:${seeded.runId}`, generationKey: "gen:1", paramsHash: "h1",
      status: "applied", attemptRunId: seeded.runId,
    });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.add(child);
    runningProcesses.set(seeded.runId, { child, graceSec: 5 });

    const heartbeat = heartbeatService(db);
    const summary = await heartbeat.markRunsShutdownInterrupted([seeded.runId], { signal: "SIGTERM", deadlineMs: 5000 });

    expect(summary).toMatchObject({ considered: 1, marked: 1, retried: 1, fenced: 0, errors: 0, skippedDeadline: 0 });

    const run = await getRunRow(db, seeded.runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("shutdown_interrupted");
    expect(run?.error).toContain("SIGTERM");
    expect(run?.error).toContain(String(child.pid));

    const checkpoint = shutdownCheckpointSchema.parse((run?.contextSnapshot as Record<string, unknown>).shutdownCheckpoint);
    expect(checkpoint.phase).toBe("running_at_shutdown");
    expect(checkpoint.signal).toBe("SIGTERM");
    expect(checkpoint.lastPid).toBe(child.pid);
    expect(checkpoint.sessionId).toBe("sess-1");
    expect(checkpoint.retryPlanned).toBe(true);
    expect(checkpoint.effectIntentIds).toEqual([effectId]);
    expect(checkpoint.issueInstructionCursor?.commentId).toBeTypeOf("string");

    // 재시도 정합: 정확히 1회, retryCount 상속+1, 세대 스탬프(envelope), 이슈 락 이전, 원본 깨움 실패 처리.
    const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, seeded.runId));
    expect(successors).toHaveLength(1);
    const retry = successors[0];
    expect(retry.status).toBe("queued");
    expect(retry.processLossRetryCount).toBe(1);
    expect(typeof (retry.contextSnapshot as Record<string, unknown>)?.dispatchGeneration).toBe("number");
    const retryWakeup = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, retry.wakeupRequestId!));
    expect(retryWakeup[0]?.status).toBe("queued");
    const originalWakeup = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seeded.wakeupRequestId));
    expect(originalWakeup[0]?.status).toBe("failed");
    const issue = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue[0]?.executionRunId).toBe(retry.id);

    // (c) 재시작 후 백스톱/running 스캔이 이 런을 이중 회수하지 않는다(정확히 1회).
    const fresh = heartbeatService(db);
    await fresh.reapOrphanedRuns();
    expect(await countRetrySuccessors(db, seeded.runId)).toBe(1);
    const runAfterSweep = await getRunRow(db, seeded.runId);
    expect(runAfterSweep?.errorCode).toBe("shutdown_interrupted");
  });

  it("(a) skips marking when the run is no longer running (CAS fence)", async () => {
    const seeded = await seedRunFixture(db, { runStatus: "failed", errorCode: "process_lost" });
    const heartbeat = heartbeatService(db);
    const summary = await heartbeat.markRunsShutdownInterrupted([seeded.runId], { signal: "SIGINT", deadlineMs: 5000 });
    expect(summary).toMatchObject({ considered: 1, marked: 0, fenced: 1, retried: 0, errors: 0 });
    const run = await getRunRow(db, seeded.runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("process_lost"); // 늙은 flush 가 새 상태를 덮어쓰지 않는다.
    expect(await countRetrySuccessors(db, seeded.runId)).toBe(0);
  });

  it("(b) skips remaining runs when the flush deadline is exceeded and bounds total flush time", async () => {
    const first = await seedRunFixture(db);
    const second = await seedRunFixture(db);
    const heartbeat = heartbeatService(db);
    const startedAt = Date.now();
    const summary = await heartbeat.markRunsShutdownInterrupted(
      [first.runId, second.runId],
      { signal: "SIGTERM", deadlineMs: 1 },
    );
    const elapsed = Date.now() - startedAt;
    expect(summary.considered).toBe(2);
    expect(summary.skippedDeadline).toBeGreaterThanOrEqual(1);
    expect(summary.deadlineExceeded).toBe(true);
    // 데드라인은 '남은 마킹 스킵'이지 지연 연장이 아니다 — 총시간 상한.
    expect(elapsed).toBeLessThan(2000);
    // 스킵된 런은 running 유지 → 기존 reaper 회수 경로(안전 장전).
    const skippedRun = (await getRunRow(db, second.runId)) ?? (await getRunRow(db, first.runId));
    expect(["running", "failed"]).toContain(skippedRun?.status);
  });

  it("(c) backstop recovers a marked-but-unretried run exactly once after restart", async () => {
    // 크래시-윈도우 재현: 마킹(failed+shutdown_interrupted)까지만 커밋되고 재시도 등록 전에 프로세스 사망.
    const seeded = await seedRunFixture(db, {
      runStatus: "failed",
      errorCode: "shutdown_interrupted",
    });
    await db.update(heartbeatRuns).set({
      error: "Graceful SIGTERM shutdown interrupted run; last pid unknown",
      finishedAt: new Date(),
    }).where(eq(heartbeatRuns.id, seeded.runId));
    expect(await countRetrySuccessors(db, seeded.runId)).toBe(0);

    const restarted = heartbeatService(db);
    const firstSweep = await restarted.reapOrphanedRuns();
    expect(firstSweep.runIds).toContain(seeded.runId);
    expect(await countRetrySuccessors(db, seeded.runId)).toBe(1);
    const retry = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, seeded.runId)))[0];
    expect(retry?.status).toBe("queued");
    expect(retry?.processLossRetryCount).toBe(1);
    const issue = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue[0]?.executionRunId).toBe(retry?.id);

    // 두 번째 sweep 은 재시도를 만들지 않는다(정확히 1회 — 이중 재시도 아님).
    await restarted.reapOrphanedRuns();
    expect(await countRetrySuccessors(db, seeded.runId)).toBe(1);
  });

  it("(a) marks an exhausted run without retry and keeps the recovery lane consistent", async () => {
    const seeded = await seedRunFixture(db, { processLossRetryCount: 1, includeIssue: false });
    const heartbeat = heartbeatService(db);
    const summary = await heartbeat.markRunsShutdownInterrupted([seeded.runId], { signal: "SIGTERM", deadlineMs: 5000 });
    expect(summary).toMatchObject({ considered: 1, marked: 1, retried: 0, fallbackQueued: 0, released: 1 });
    const run = await getRunRow(db, seeded.runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("shutdown_interrupted");
    const checkpoint = shutdownCheckpointSchema.parse((run?.contextSnapshot as Record<string, unknown>).shutdownCheckpoint);
    expect(checkpoint.retryPlanned).toBe(false);
    expect(await countRetrySuccessors(db, seeded.runId)).toBe(0);
  });

  it("(d) rejects malformed checkpoint records (zod v1 strict)", () => {
    const base = {
      version: 1, phase: "running_at_shutdown", cause: "graceful_shutdown", signal: "SIGTERM",
      interruptedAt: new Date().toISOString(), lastPid: 123, sessionId: null, resumeToken: null,
      issueInstructionCursor: null, effectIntentIds: [], retryPlanned: true,
    };
    expect(shutdownCheckpointSchema.safeParse(base).success).toBe(true);
    expect(shutdownCheckpointSchema.safeParse({ ...base, unknownKey: 1 }).success).toBe(false);
    expect(shutdownCheckpointSchema.safeParse({ ...base, version: 2 }).success).toBe(false);
    expect(shutdownCheckpointSchema.safeParse({ ...base, signal: "SIGHUP" }).success).toBe(false);
    expect(shutdownCheckpointSchema.safeParse({ ...base, effectIntentIds: "not-array" }).success).toBe(false);
    expect(shutdownCheckpointSchema.safeParse({ ...base, effectIntentIds: undefined }).success).toBe(false);
  });
});

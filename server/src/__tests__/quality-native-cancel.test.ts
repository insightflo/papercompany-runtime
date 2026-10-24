// server/src/__tests__/quality-native-cancel.test.ts
//
// [purpose] T4 취소: intent 차단을 먼저 저장한 뒤 기존 cancelRun 정리를 호출한다.
// 취소 요청과 실제 취소 확인을 구분하고, 예약된 사용량计数는 환원하지 않는다.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq, or, sql } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  qualityActionGroups,
  qualityActions,
} from "@paperclipai/db";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { seedQualityFixture, type QualityFixture } from "./helpers/quality-fixture.js";
import { deliverQualityIntent, cancelQualityIntent, readQualityCancellation } from "../services/quality/native-delivery.js";
import { ensureCanonicalQualityExecution } from "../services/quality/native-records.js";
import { expectCancelledAdapterBoundary } from "./helpers/quality-cancel-boundary.js";
import {
  countLockQueueBehind, countWaitersBlockedBy, openGatedRowLock,
  parkRunnerInSetupBarrier, pollBlockedBackend, pollUntil,
} from "./helpers/quality-cancel-locks.js";

const { executeSpy } = vi.hoisted(() => ({ executeSpy: vi.fn() }));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: executeSpy })),
  runningProcesses: new Map(),
}));

function successfulAdapterResult() {
  return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, usage: null, provider: "test", model: "test-model", resultJson: null, runtimeServices: [] };
}

describeQualityDb("Quality native cancel", () => {
  let owned: QualityTestDb;
  let f: QualityFixture;
  let home: string;
  const originalHome = process.env.PAPERCLIP_HOME;
  let releaseExecution: (() => void) | null = null;

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "quality-t4-cancel-"));
    process.env.PAPERCLIP_HOME = home;
    owned = await createQualityTestDb();
    f = await seedQualityFixture(owned.db);
    await owned.db.update(agents).set({
      adapterType: "codex_local", adapterConfig: { promptTemplate: "Test." }, runtimeConfig: {}, permissions: {},
    }).where(eq(agents.companyId, f.companyId));
  }, 180_000);
  afterAll(async () => {
    releaseExecution?.();
    if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalHome;
    await owned?.close();
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("stores the intent block first, then runs the existing cancelRun cleanup, and separates request from confirmation", async () => {
    const db = owned.db;
    // 실행이 계속 붙어 있는 상태를 만든다(어댑터가 완료되지 않는다).
    executeSpy.mockImplementation(() => new Promise((resolve) => { releaseExecution = () => resolve(successfulAdapterResult()); }));
    const delivered = await deliverQualityIntent(db, { companyId: f.companyId, actionId: f.actionId });
    expect(delivered.status).toBe("accepted");
    const [row] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, delivered.receiptId!));
    for (let i = 0; i < 150; i++) {
      const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, row!.runId!));
      if (run && (run.status === "running" || run.status === "succeeded" || run.status === "failed")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const [runBefore] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, row!.runId!));

    const requested = await cancelQualityIntent(db, { companyId: f.companyId, actionId: f.actionId });
    expect(requested.cancelRequestedAt).toBeTruthy();
    // 취소 요청이 저장되었다 — 감사 행과 함께.
    const [action] = await db.select().from(qualityActions).where(and(eq(qualityActions.companyId, f.companyId), eq(qualityActions.id, f.actionId)));
    expect(action!.cancelRequestedAt).not.toBeNull();
    const audits = await db.select().from(activityLog)
      .where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "quality.cancel_requested"), eq(activityLog.entityId, f.actionId)));
    expect(audits).toHaveLength(1);

    if (runBefore!.status === "running") {
      expect(requested.heartbeatRunId).toBe(row!.runId);
      expect(requested.runCancellationRequested).toBe(true);
      const confirmed = await readQualityCancellation(db, { companyId: f.companyId, actionId: f.actionId });
      expect(confirmed.requested).toBe(true);
      expect(confirmed.cancelledConfirmed).toBe(true);
    }
    // 취소 뒤 재전달은 차단된다.
    const after = await deliverQualityIntent(db, { companyId: f.companyId, actionId: f.actionId });
    expect(after).toEqual({ status: "blocked", receiptId: null });
    releaseExecution?.();
  });

  it("idempotently keeps the first cancellation timestamp and does not refund reserved usage", async () => {
    const db = owned.db;
    executeSpy.mockResolvedValue(successfulAdapterResult());
    const seeded = await seedQualityFixture(db);
    await db.update(agents).set({ adapterType: "codex_local", adapterConfig: { promptTemplate: "Test." }, runtimeConfig: {}, permissions: {} })
      .where(eq(agents.companyId, seeded.companyId));
    await ensureCanonicalQualityExecution(db, { companyId: seeded.companyId, actionId: seeded.actionId });
    // 사용량이 이미 예약되어 있다(예: 재시도 예약).
    await db.update(qualityActionGroups).set({ usage: { executionAttempts: 2 } })
      .where(and(eq(qualityActionGroups.companyId, seeded.companyId), eq(qualityActionGroups.id, seeded.groupId)));
    const first = await cancelQualityIntent(db, { companyId: seeded.companyId, actionId: seeded.actionId });
    const second = await cancelQualityIntent(db, { companyId: seeded.companyId, actionId: seeded.actionId });
    expect(second.cancelRequestedAt).toBe(first.cancelRequestedAt);
    const [group] = await db.select().from(qualityActionGroups)
      .where(and(eq(qualityActionGroups.companyId, seeded.companyId), eq(qualityActionGroups.id, seeded.groupId)));
    expect((group!.usage as Record<string, unknown>).executionAttempts).toBe(2);
    const audits = await db.select().from(activityLog)
      .where(and(eq(activityLog.companyId, seeded.companyId), eq(activityLog.action, "quality.cancel_requested"), eq(activityLog.entityId, seeded.actionId)));
    expect(audits).toHaveLength(1);
    const delivered = await deliverQualityIntent(db, { companyId: seeded.companyId, actionId: seeded.actionId });
    expect(delivered).toEqual({ status: "blocked", receiptId: null });
  });

  it("reports an unconfirmed cancellation when only the request exists", async () => {
    const db = owned.db;
    const seeded = await seedQualityFixture(db);
    await db.update(agents).set({ adapterType: "codex_local", adapterConfig: { promptTemplate: "Test." }, runtimeConfig: {}, permissions: {} })
      .where(eq(agents.companyId, seeded.companyId));
    await ensureCanonicalQualityExecution(db, { companyId: seeded.companyId, actionId: seeded.actionId });
    const requested = await cancelQualityIntent(db, { companyId: seeded.companyId, actionId: seeded.actionId });
    expect(requested.heartbeatRunId).toBeNull();
    expect(requested.runCancellationRequested).toBe(false);
    const state = await readQualityCancellation(db, { companyId: seeded.companyId, actionId: seeded.actionId });
    expect(state.requested).toBe(true);
    expect(state.cancelledConfirmed).toBe(false);
  });

  it("keeps the confirmed cancellation when the adapter finishes afterwards (cancel lands after the adapter provably started)", { timeout: 60_000 }, async () => {
    const db = owned.db;
    const seeded = await seedQualityFixture(db);
    await db.update(agents).set({ adapterType: "codex_local", adapterConfig: { promptTemplate: "Test." }, runtimeConfig: {}, permissions: {} })
      .where(eq(agents.companyId, seeded.companyId));
    const adapterGate = { release: () => {} };
    executeSpy.mockImplementation(() => new Promise((resolve) => { adapterGate.release = () => resolve(successfulAdapterResult()); }));
    try {
      const callsBefore = executeSpy.mock.calls.length;
      const delivered = await deliverQualityIntent(db, { companyId: seeded.companyId, actionId: seeded.actionId });
      expect(delivered.status).toBe("accepted");
      const [row] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, delivered.receiptId!));
      const runId = row!.runId!;
      // [barrier] 세팅 종료 증명 — 이 테스트에서 어댑터가 실제로 새로 호출됐다(카운트는 파일 전체 누적).
      const adapterStarted = await pollUntil(20_000, async () => executeSpy.mock.calls.length > callsBefore);
      expect(adapterStarted).toBe(true);
      const [runAtAdapter] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(runAtAdapter!.status).toBe("running");

      const requested = await cancelQualityIntent(db, { companyId: seeded.companyId, actionId: seeded.actionId });
      expect(requested.heartbeatRunId).toBe(runId);
      expect(requested.runCancellationRequested).toBe(true);
      const confirmed = await readQualityCancellation(db, { companyId: seeded.companyId, actionId: seeded.actionId });
      expect(confirmed.cancelledConfirmed).toBe(true);

      // 어댑터가 외부 취소 이후에 완료된다 — 완료 경로는 종말 상태를 되찾지 않아야 한다.
      adapterGate.release();
      const settled = await pollUntil(20_000, async () => {
        const [evidence] = await db.select({ exitCode: heartbeatRuns.exitCode }).from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, runId));
        return evidence?.exitCode !== null && evidence?.exitCode !== undefined;
      });
      if (!settled) {
        const active = (await db.execute(sql`
          select pid, state, wait_event_type, left(query, 120) as query from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle'
        `)) as unknown as Array<Record<string, unknown>>;
        console.error("[ordering-A] completion never settled; non-idle backends:", JSON.stringify(active));
      }
      expect(settled).toBe(true);
      const final = await readQualityCancellation(db, { companyId: seeded.companyId, actionId: seeded.actionId });
      expect(final.cancelledConfirmed).toBe(true);
      expect(final.runStatus).toBe("cancelled");
    } finally {
      adapterGate.release();
    }
  });

  it("preserves an externally confirmed cancellation when setup fails mid-startup (cancel lands inside the setup window)", { timeout: 60_000 }, async () => {
    const db = owned.db;
    const seeded = await seedQualityFixture(db);
    await db.update(agents).set({ adapterType: "codex_local", adapterConfig: { promptTemplate: "Test." }, runtimeConfig: {}, permissions: {} })
      .where(eq(agents.companyId, seeded.companyId));
    // [barrier] 세팅 창 주차 — parkRunnerInSetupBarrier 참조.
    const barrier = await parkRunnerInSetupBarrier(db, seeded);
    expect(barrier.ready).toBe(true);
    const adapterGate = { release: () => {} };
    executeSpy.mockImplementation(() => new Promise((resolve) => { adapterGate.release = () => resolve(successfulAdapterResult()); }));
    let barrierResolved = false;
    try {
      const callsBefore = executeSpy.mock.calls.length;

      const delivered = await deliverQualityIntent(db, { companyId: seeded.companyId, actionId: seeded.actionId });
      expect(delivered.status).toBe("accepted");
      const [row] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, delivered.receiptId!));
      const runId = row!.runId!;

      // claim 은 커밋됐고(running) 러너는 세팅 안쪽에서 우리 잠금에 확실히 멈춰 있다.
      const claimVisible = await pollUntil(20_000, async () => {
        const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        return run?.status === "running";
      });
      expect(claimVisible).toBe(true);
      const runnerParked = await pollUntil(20_000, async () =>
        (await countWaitersBlockedBy(db, barrier.holderPid)) > 0);
      expect(runnerParked).toBe(true);
      expect(executeSpy.mock.calls.length).toBe(callsBefore); // 이 테스트 안 새 호출 없음 — 아직 세팅 창 안이다.

      // 러너가 멈춰 있는 동안 취소가 완료된다(취소 경로는 이 잠금과 충돌하지 않는다).
      const requested = await cancelQualityIntent(db, { companyId: seeded.companyId, actionId: seeded.actionId });
      expect(requested.heartbeatRunId).toBe(runId);
      expect(requested.runCancellationRequested).toBe(true);
      const confirmed = await readQualityCancellation(db, { companyId: seeded.companyId, actionId: seeded.actionId });
      expect(confirmed.cancelledConfirmed).toBe(true);

      // 장벽을 COMMIT 로 푼다 — 러너의 세팅 INSERT 는 unique violation 으로 실패하고 세팅 실패 경로가 돈다.
      barrier.gate.settle("commit");
      barrierResolved = true;
      await barrier.settled;
      const failureHandled = await pollUntil(20_000, async () => {
        const events = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents)
          .where(and(eq(heartbeatRunEvents.runId, runId), eq(heartbeatRunEvents.eventType, "error")));
        return events.length > 0;
      });
      expect(failureHandled).toBe(true);

      // 수정 계약: 외부 취소는 세팅 실패 후에도 살아남는다(현재 런타임에서는 RED — runStatus 'failed').
      const final = await readQualityCancellation(db, { companyId: seeded.companyId, actionId: seeded.actionId });
      expect(final.cancelledConfirmed).toBe(true);
      expect(final.runStatus).toBe("cancelled");
    } finally {
      if (!barrierResolved) {
        barrier.gate.settle("rollback");
        await barrier.settled.catch(() => undefined);
      }
      adapterGate.release();
    }
  });

  it("keeps the overlapping cancellation authoritative when the setup-failure write contends the same run row", { timeout: 60_000 }, async () => {
    const db = owned.db;
    const seeded = await seedQualityFixture(db);
    await db.update(agents).set({ adapterType: "codex_local", adapterConfig: { promptTemplate: "Test." }, runtimeConfig: {}, permissions: {} })
      .where(eq(agents.companyId, seeded.companyId));
    const barrier = await parkRunnerInSetupBarrier(db, seeded);
    expect(barrier.ready).toBe(true);
    const adapterGate = { release: () => {} };
    executeSpy.mockImplementation(() => new Promise((resolve) => { adapterGate.release = () => resolve(successfulAdapterResult()); }));
    let barrierResolved = false;
    const runLockGate = { settle: () => {} };
    let runLockPid = 0;
    let runLockAssigned = false;
    let runLockSettled: Promise<void> | null = null;
    let cancelPromise: Promise<unknown> | null = null;
    try {
      const callsBefore = executeSpy.mock.calls.length;
      const delivered = await deliverQualityIntent(db, { companyId: seeded.companyId, actionId: seeded.actionId });
      expect(delivered.status).toBe("accepted");
      const [row] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, delivered.receiptId!));
      const runId = row!.runId!;
      const claimVisible = await pollUntil(20_000, async () => {
        const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        return run?.status === "running";
      });
      expect(claimVisible).toBe(true);
      const runnerParked = await pollUntil(20_000, async () =>
        (await countWaitersBlockedBy(db, barrier.holderPid)) > 0);
      expect(runnerParked).toBe(true);
      expect(executeSpy.mock.calls.length).toBe(callsBefore);

      // run 행 FOR UPDATE 홀드 — cancelRun 의 setRunStatus('cancelled') UPDATE 가 여기 주차한다.
      runLockSettled = db.transaction(async (tx) => {
        await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).for("update");
        const pidRows = (await tx.execute(sql`select pg_backend_pid() as pid`)) as unknown as Array<{ pid: number }>;
        runLockPid = pidRows[0]!.pid;
        await new Promise<void>((resolve) => {
          runLockGate.settle = resolve;
          runLockAssigned = true;
        });
      });
      expect(await pollUntil(10_000, async () => runLockAssigned)).toBe(true);

      const cancelStarted = cancelQualityIntent(db, { companyId: seeded.companyId, actionId: seeded.actionId });
      cancelPromise = cancelStarted;
      const cancelWriteParked = await pollUntil(20_000, async () =>
        (await countWaitersBlockedBy(db, runLockPid)) > 0);
      expect(cancelWriteParked).toBe(true);

      // 장벽 COMMIT → 러너 세팅 실패 → failed 전이 UPDATE 가 같은 run 행 잠금 큐에 두 번째로 대기한다.
      barrier.gate.settle("commit");
      barrierResolved = true;
      await barrier.settled;
      const bothContending = await pollUntil(20_000, async () =>
        (await countLockQueueBehind(db, runLockPid)) >= 2);
      expect(bothContending).toBe(true);

      // 잠금 해제 — 두 쓰기의 경합 순서는 PG 가 정하고, 어느 쪽이 이겨도 종말 상태는 cancelled 여야 한다.
      runLockGate.settle();
      await runLockSettled!;
      await cancelStarted;

      const failureHandled = await pollUntil(20_000, async () => {
        const events = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents)
          .where(and(eq(heartbeatRunEvents.runId, runId), eq(heartbeatRunEvents.eventType, "error")));
        return events.length > 0;
      });
      expect(failureHandled).toBe(true);
      const final = await readQualityCancellation(db, { companyId: seeded.companyId, actionId: seeded.actionId });
      expect(final.cancelledConfirmed).toBe(true);
      expect(final.runStatus).toBe("cancelled");
      const [wakeupAfter] = await db.select({ status: agentWakeupRequests.status }).from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, row!.id));
      expect(wakeupAfter!.status).toBe("cancelled");
    } finally {
      if (!barrierResolved) {
        barrier.gate.settle("rollback");
        await barrier.settled.catch(() => undefined);
      }
      runLockGate.settle();
      if (runLockSettled) await runLockSettled.catch(() => undefined);
      if (cancelPromise) void cancelPromise.catch(() => undefined);
      adapterGate.release();
    }
  });

  it("keeps both lanes lock-ordered when the cancel release overlaps the runner's resume serialization window (ordering D, cancel-side parks first)", { timeout: 180_000 }, async () => {
    const db = owned.db;
    const seeded = await seedQualityFixture(db);
    await db.update(agents).set({ adapterType: "codex_local", adapterConfig: { promptTemplate: "Test." }, runtimeConfig: {}, permissions: {} })
      .where(eq(agents.companyId, seeded.companyId));
    // [choreography] 러너를 세팅에 주차하고 이슈/root prefix를 홀드한다.
    // 취소의 root 무효화가 먼저 이 홀드에 대기한 뒤 러너를 풀어
    // runner → cancel → issue holder의 실제 PID 연결을 증명한다.
    const barrier = await parkRunnerInSetupBarrier(db, seeded);
    expect(barrier.ready).toBe(true);
    const adapterGate = { release: () => {} };
    executeSpy.mockImplementation(() => new Promise((resolve) => { adapterGate.release = () => resolve(successfulAdapterResult()); }));
    let barrierResolved = false;
    let issueLock: Awaited<ReturnType<typeof openGatedRowLock>> | null = null;
    let cancelOutcome: Promise<unknown> | null = null;
    let cancelError: unknown = null;
    try {
      const callsBefore = executeSpy.mock.calls.length;
      const delivered = await deliverQualityIntent(db, { companyId: seeded.companyId, actionId: seeded.actionId });
      expect(delivered.status).toBe("accepted");
      const [row] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, delivered.receiptId!));
      const runId = row!.runId!;
      const claimVisible = await pollUntil(20_000, async () => {
        const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        return run?.status === "running";
      });
      expect(claimVisible).toBe(true);
      const runnerParkedAtSetup = await pollUntil(20_000, async () =>
        (await countWaitersBlockedBy(db, barrier.holderPid)) > 0);
      expect(runnerParkedAtSetup).toBe(true);

      // 이슈/root prefix 홀드 — 취소의 root 무효화를 release 정리 전에 주차한다.
      const [linkedIssue] = await db.select({ id: issues.id }).from(issues)
        .where(and(
          eq(issues.companyId, seeded.companyId),
          or(eq(issues.executionRunId, runId), eq(issues.checkoutRunId, runId)),
        )).limit(1);
      expect(linkedIssue).toBeTruthy();
      issueLock = await openGatedRowLock(db, (tx) =>
        tx.select({ id: issues.id }).from(issues).where(eq(issues.id, linkedIssue!.id)).for("update"));
      expect(issueLock.ready).toBe(true);

      // 러너가 아직 세팅 장벽에 있으므로 이 홀드의 새 대기자는 취소 lane이다.
      cancelOutcome = (async () => {
        try { return await cancelQualityIntent(db, { companyId: seeded.companyId, actionId: seeded.actionId }); }
        catch (err) { cancelError = err; return null; }
      })();
      const cancelAtRoot = await pollBlockedBackend(db, { blockedByPid: issueLock.holderPid });
      expect(cancelAtRoot).toBeTruthy();
      const cancelPid = cancelAtRoot!.pid;

      // ROLLBACK으로 세팅을 계속 진행시킨 뒤 취소가 보유한 prefix 뒤의 대기를 확인한다.
      barrier.gate.settle("rollback");
      barrierResolved = true;
      await barrier.settled.catch(() => undefined);
      const runnerSerialized = await pollBlockedBackend(db, {
        blockedByPid: cancelPid, blockerBlockedByPid: issueLock.holderPid,
        excludePids: [cancelPid, issueLock.holderPid],
      });
      expect(runnerSerialized).toBeTruthy(); // 같은 관찰에서 runner → cancel → issue holder.
      console.log("[ordering-D] runner parked at:", JSON.stringify(runnerSerialized));

      // 이슈 홀드 해제 — 교차의 결정 지점. 이 시점부터 수정 전에는 40P01 사이클, 수정 후에는 직렬 대기.
      issueLock.gate.settle();
      await issueLock.settled;
      await cancelOutcome;

      // 계약 1: 40P01 탈출이 없다(교찰 희생 측이 취소였다면 cancelQualityIntent 가 기각한다).
      expect(cancelError).toBeNull();

      // 계약 2: 직렬화 이후 실행 직전 경계에 도달했으나, 이미 확정된 취소로 실행이 차단된다.
      // 정확한 실행의 영구 기록을 확인하므로 교착/세팅 실패를 무호출 성공으로 오인하지 않는다.
      await expectCancelledAdapterBoundary(db, seeded.companyId, runId);
      expect(executeSpy.mock.calls.length).toBe(callsBefore);

      // 계약 3: 취소 확인과 종말 상태가 보존된다.
      const final = await readQualityCancellation(db, { companyId: seeded.companyId, actionId: seeded.actionId });
      expect(final.requested).toBe(true);
      expect(final.cancelledConfirmed).toBe(true);
      expect(final.runStatus).toBe("cancelled");

      // 계약 4: release 정리가 완료됐다 — 이슈 실행 연결이 해제됐다.
      const [issueAfter] = await db.select({ executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId })
        .from(issues).where(eq(issues.id, linkedIssue!.id));
      expect(issueAfter!.executionRunId).toBeNull();
      expect(issueAfter!.checkoutRunId).toBeNull();
      // 실행은 위에서 정착했다. 어댑터가 시작되지 않았으므로 exitCode 는 생성되지 않는다.
    } finally {
      if (!barrierResolved) {
        barrier.gate.settle("rollback");
        await barrier.settled.catch(() => undefined);
      }
      if (issueLock) {
        issueLock.gate.settle();
        await issueLock.settled.catch(() => undefined);
      }
      if (cancelOutcome) await cancelOutcome.catch(() => undefined);
      adapterGate.release();
    }
  });

  it("stays deadlock-free in the opposing grant order (runner serializes first, cancel waits on the run row)", { timeout: 180_000 }, async () => {
    const db = owned.db;
    const seeded = await seedQualityFixture(db);
    await db.update(agents).set({ adapterType: "codex_local", adapterConfig: { promptTemplate: "Test." }, runtimeConfig: {}, permissions: {} })
      .where(eq(agents.companyId, seeded.companyId));
    // [choreography] 반대 부여 순서: 러너가 먼저 resume prefix를 잡고 이슈 홀드에 대기한다.
    // 취소를 시작한 뒤 cancel → runner → issue holder를 증명한다.
    // 대기 중인 prefix가 mission인지 heartbeat인지는 SQL 문구로 판정하지 않는다.
    const barrier = await parkRunnerInSetupBarrier(db, seeded);
    expect(barrier.ready).toBe(true);
    const adapterGate = { release: () => {} };
    executeSpy.mockImplementation(() => new Promise((resolve) => { adapterGate.release = () => resolve(successfulAdapterResult()); }));
    let barrierResolved = false;
    let issueLock: Awaited<ReturnType<typeof openGatedRowLock>> | null = null;
    let cancelOutcome: Promise<unknown> | null = null;
    let cancelError: unknown = null;
    try {
      const callsBefore = executeSpy.mock.calls.length;
      const delivered = await deliverQualityIntent(db, { companyId: seeded.companyId, actionId: seeded.actionId });
      expect(delivered.status).toBe("accepted");
      const [row] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, delivered.receiptId!));
      const runId = row!.runId!;
      const claimVisible = await pollUntil(20_000, async () => {
        const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        return run?.status === "running";
      });
      expect(claimVisible).toBe(true);
      const runnerParkedAtSetup = await pollUntil(20_000, async () =>
        (await countWaitersBlockedBy(db, barrier.holderPid)) > 0);
      expect(runnerParkedAtSetup).toBe(true);

      const [linkedIssue] = await db.select({ id: issues.id }).from(issues)
        .where(and(
          eq(issues.companyId, seeded.companyId),
          or(eq(issues.executionRunId, runId), eq(issues.checkoutRunId, runId)),
        )).limit(1);
      expect(linkedIssue).toBeTruthy();
      issueLock = await openGatedRowLock(db, (tx) =>
        tx.select({ id: issues.id }).from(issues).where(eq(issues.id, linkedIssue!.id)).for("update"));
      expect(issueLock.ready).toBe(true);

      // 취소 시작 전에 러너를 풀어 이슈/root prefix 홀드의 대기 PID를 식별한다.
      barrier.gate.settle("rollback");
      barrierResolved = true;
      await barrier.settled.catch(() => undefined);
      const runnerAtRoot = await pollBlockedBackend(db, { blockedByPid: issueLock.holderPid });
      expect(runnerAtRoot).toBeTruthy();
      const runnerPid = runnerAtRoot!.pid;

      // 취소는 러너가 실제로 보유한 prefix 뒤에 대기해야 한다.
      cancelOutcome = (async () => {
        try { return await cancelQualityIntent(db, { companyId: seeded.companyId, actionId: seeded.actionId }); }
        catch (err) { cancelError = err; return null; }
      })();
      const cancelBehindRunner = await pollBlockedBackend(db, {
        blockedByPid: runnerPid, blockerBlockedByPid: issueLock.holderPid,
        excludePids: [runnerPid, issueLock.holderPid],
      });
      expect(cancelBehindRunner).toBeTruthy();

      // 이슈 홀드 해제 — 러너 완료→커밋→취소 진행. 어느 쪽으로도 교찰이 아니어야 한다.
      issueLock.gate.settle();
      await issueLock.settled;
      await cancelOutcome;

      expect(cancelError).toBeNull();
      await expectCancelledAdapterBoundary(db, seeded.companyId, runId);
      expect(executeSpy.mock.calls.length).toBe(callsBefore);
      const final = await readQualityCancellation(db, { companyId: seeded.companyId, actionId: seeded.actionId });
      expect(final.cancelledConfirmed).toBe(true);
      expect(final.runStatus).toBe("cancelled");
      const [issueAfter] = await db.select({ executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId })
        .from(issues).where(eq(issues.id, linkedIssue!.id));
      expect(issueAfter!.executionRunId).toBeNull();
      expect(issueAfter!.checkoutRunId).toBeNull();
      // 실행은 위에서 정착했다. 어댑터가 시작되지 않았으므로 exitCode 는 생성되지 않는다.
    } finally {
      if (!barrierResolved) {
        barrier.gate.settle("rollback");
        await barrier.settled.catch(() => undefined);
      }
      if (issueLock) {
        issueLock.gate.settle();
        await issueLock.settled.catch(() => undefined);
      }
      if (cancelOutcome) await cancelOutcome.catch(() => undefined);
      adapterGate.release();
    }
  });
});

// server/src/services/heartbeat-orphan-reaper.ts
//
// [파일 목적] heartbeat.ts 에서 기계적 추출된 고아 런 정리(reaper) 스윕 — 동작 무변경.
// [추출 계약] 본문은 heartbeat.ts L2103-L2520(추출 시점) 그대로이며, 줄·순서·리터럴을 바꾸지 않는다.
//   heartbeatService 클로저 값(db/appendRunEvent/nextRunEventSeq/setRunStatus/...)은 deps 로 주입받는다.
// [주의] terminalContinuationScanCursor 는 heartbeatService 인스턴스 스코프 상태다.
//   모듈 스코프로 옮기면 테스트가 서비스 인스턴스를 여러 개 만들 때 스캔 커서가 공유되어 동작이 달라진다.
//   그래서 값이 아니라 get/set 접근자로 주입한다.
import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issues, workflowTransitionEvents } from "@paperclipai/db";
import type { agentWakeupRequests } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { runningProcesses } from "../adapters/index.js";
import type { HeartbeatRetryEnqueueDeps } from "./heartbeat-retry-enqueue.js";
import type { agentWikiService } from "./agent-wiki.js";
import { resolveAdapterFallbackConfig, resolveAdapterFallbackThinking } from "./heartbeat-adapter-fallback.js";
import { parseHeartbeatPolicy } from "./heartbeat-concurrency-limit.js";
import { trackHeartbeatExecution } from "./heartbeat-execution-tracker.js";
import { fireWikiRecord } from "./heartbeat-failure-wiki.js";
import {
  DETACHED_GRACE_SEC,
  DETACHED_PROCESS_ERROR_CODE,
  DETACHED_REAP_AFTER_MS,
  isProcessAlive,
  isTrackedLocalChildProcessAdapter,
  terminateRecordedProcess,
} from "./heartbeat-process-liveness.js";
import { createHeartbeatQueuedStaleRecovery } from "./heartbeat-queued-stale-recovery.js";
import { resolveAdapterFallbackAttempt } from "./heartbeat-run-context.js";
import { isTerminalHeartbeatRunStatus } from "./heartbeat-run-status.js";
import { withAgentStartLock } from "./heartbeat-start-lock.js";
import { publishLiveEvent } from "./live-events.js";
import { operatorApprovalWaitService } from "./operator-approval-wait.js";
import { SHUTDOWN_INTERRUPTED_ERROR_CODE } from "./shutdown-flush.js";

type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type TerminalContinuationCursor = { createdAt: string; id: string };

/**
 * HeartbeatOrphanReaperDeps — heartbeatService 클로저가 보유한 상태/함수의 주입 계약.
 * 값이 아니라 "지금 이 순간의 heartbeatService 인스턴스"를 가리켜야 하는 항목만 담는다.
 * 순환 import 를 만들지 않도록 heartbeat 인접 모듈의 심볼 7개도 여기로 주입한다.
 */
export type HeartbeatOrphanReaperDeps = {
  readonly db: Db;
  readonly appendRunEvent: (
    run: HeartbeatRunRow,
    seq: number,
    event: {
      eventType: string;
      stream?: "system" | "stdout" | "stderr";
      level?: "info" | "warn" | "error";
      color?: string;
      message?: string;
      payload?: Record<string, unknown>;
    },
  ) => Promise<void>;
  readonly nextRunEventSeq: (runId: string) => Promise<number>;
  readonly setRunStatus: (
    runId: string,
    status: string,
    patch?: Partial<typeof heartbeatRuns.$inferInsert>,
    opts?: { expectedStatuses?: string[]; expectedRun?: HeartbeatRunRow },
  ) => Promise<HeartbeatRunRow | null>;
  readonly setWakeupStatus: (
    wakeupRequestId: string | null | undefined,
    status: string,
    patch?: Partial<typeof agentWakeupRequests.$inferInsert>,
  ) => Promise<void>;
  readonly recordQueueTransitionEvent: (input: {
    companyId: string;
    missionId?: string | null;
    issueId?: string | null;
    wakeupRequestId?: string | null;
    heartbeatRunId?: string | null;
    workflowRunId?: string | null;
    workflowStepRunId?: string | null;
    eventType: string;
    layer: string;
    decision?: string | null;
    reason?: string | null;
    reasonCode?: string | null;
    idempotencyKey: string;
    payload?: Record<string, unknown>;
  }) => Promise<void>;
  readonly finalizeAgentStatus: (
    agentId: string,
    outcome: "succeeded" | "failed" | "cancelled" | "timed_out",
  ) => Promise<void>;
  readonly countRunningRunsForAgent: (agentId: string) => Promise<number>;
  readonly getAgent: (agentId: string) => Promise<AgentRow | null>;
  readonly getRun: (runId: string) => Promise<HeartbeatRunRow | null>;
  readonly demoteAgentStuckDetached: (run: HeartbeatRunRow, now: Date) => Promise<void>;
  readonly startNextQueuedRunForAgent: (agentId: string) => Promise<unknown>;
  readonly releaseIssueExecutionAndPromote: (
    run: HeartbeatRunRow,
    options?: { readonly skipLocked?: boolean; readonly resumeQueue?: boolean },
  ) => Promise<unknown>;
  readonly resolveRunActiveExecutionTimeoutMs: (run: HeartbeatRunRow, baseMs: number) => Promise<number>;
  readonly runTerminalReleaseContinuation: (
    eventId: string,
  ) => Promise<{ kind: "complete" } | { kind: "held"; reason: string }>;
  readonly retryEnqueueDeps: HeartbeatRetryEnqueueDeps;
  readonly wikiSvc: ReturnType<typeof agentWikiService>;
  readonly activeRunExecutions: ReadonlySet<string>;
  readonly terminalContinuationInflight: ReadonlySet<string>;
  readonly getTerminalContinuationScanCursor: () => TerminalContinuationCursor | null;
  readonly setTerminalContinuationScanCursor: (cursor: TerminalContinuationCursor | null) => void;
  readonly publishHeartbeatRunStatus: typeof import("./heartbeat-agent-cancellation.js").publishHeartbeatRunStatus;
  readonly setHeartbeatRunStatus: typeof import("./heartbeat-queue-lifecycle.js").setHeartbeatRunStatus;
  readonly enqueueProcessLossRetry: typeof import("./heartbeat-retry-enqueue.js").enqueueProcessLossRetry;
  readonly enqueueAdapterFallbackRun: typeof import("./heartbeat-retry-enqueue.js").enqueueAdapterFallbackRun;
  readonly settleHeartbeatAfterExecution: typeof import("./heartbeat-finalization/post-execution.js").settleHeartbeatAfterExecution;
  readonly readTerminalReleaseManifest: typeof import("./heartbeat-terminal-release-continuation.js").readTerminalReleaseManifest;
  readonly TERMINAL_RELEASE_EVENT_TYPE: typeof import("./heartbeat-terminal-release-continuation.js").TERMINAL_RELEASE_EVENT_TYPE;
};

export async function reapOrphanedRuns(deps: HeartbeatOrphanReaperDeps, opts?: {
  staleThresholdMs?: number;
  activeExecutionTimeoutMs?: number;
  queuedStaleThresholdMs?: number;
}) {
  const staleThresholdMs = opts?.staleThresholdMs ?? 0;
  const activeExecutionTimeoutMs = opts?.activeExecutionTimeoutMs ?? 0;
  const queuedStaleThresholdMs = opts?.queuedStaleThresholdMs ?? 0;
  const now = new Date();

  // Find all runs stuck in "running" state. Queued runs are handled below only
  // when they have exceeded an explicit queued staleness threshold.
  const activeRuns = await deps.db
    .select({
      run: heartbeatRuns,
      adapterType: agents.adapterType,
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
    .where(eq(heartbeatRuns.status, "running"));

  const reaped: string[] = [];

  // [approval-waiting marker] running 런의 이슈에 pending 운영자 결정/승인이 있으면
  // '멈춤(stuck)'이 아니라 '사람 대기'다 — 배치 판정 후 타임아웃 회수에서 면제한다(스캔 N+1 금지).
  const approvalWaitByIssueId = await operatorApprovalWaitService(deps.db).markersForIssueIds(
    activeRuns.map((row) => row.run.issueId).filter((issueId): issueId is string => Boolean(issueId)),
  );

  for (const { run, adapterType } of activeRuns) {
    const trackedProcess = runningProcesses.get(run.id) ?? null;
    const hasActiveExecution = deps.activeRunExecutions.has(run.id);
    if (trackedProcess || hasActiveExecution) {
      // [issue done → 자식 즉시 kill] 에이전트가 issue 를 done/cancelled 처리했는데도
      // 어댑터 자식(opencode 등)이 exit 안 하고 살아있으면 maxConcurrentRuns 블록이
      // execution_stale(15min)까지 지속된다. issue 상태가 done/cancelled 면 자식을
      // 즉시 종료해 블록을 푼다.
      if (trackedProcess && run.issueId) {
        const [issueRow] = await deps.db.select({ status: issues.status }).from(issues)
          .where(eq(issues.id, run.issueId)).limit(1);
        if (issueRow && (issueRow.status === "done" || issueRow.status === "cancelled")) {
          trackedProcess.child.kill("SIGTERM");
          setTimeout(() => {
            if (!trackedProcess.child.killed) {
              trackedProcess.child.kill("SIGKILL");
            }
          }, Math.max(1, trackedProcess.graceSec) * 1000);
          runningProcesses.delete(run.id);
          await deps.setRunStatus(run.id, issueRow.status === "done" ? "succeeded" : "cancelled", {
            error: `Issue ${issueRow.status} but adapter child did not exit; terminated`,
            errorCode: "issue_done_child_not_exited",
            finishedAt: now,
          }, { expectedStatuses: ["running"] });
          // Agent self-learning wiki (Phase 1): adapter 자식 미종료 패턴 기록 (non-blocking).
          fireWikiRecord(deps.wikiSvc, {
            companyId: run.companyId,
            agentId: run.agentId,
            missionId: null,
            pattern: "adapter 자식 미종료 (issue done/cancelled)",
            cause: "이슈가 done/cancelled로 종료됐는데도 어댑터 자식(opencode 등)이 exit하지 않아 maxConcurrentRuns 블록이 execution_stale까지 지속됨.",
            solution: "이슈 done/cancelled 처리 후 어댑터 자식이 확실히 exit하도록 종료 시그널/플래그 점검. 작업 완료 시 프로세스를 즉시 종료할 것.",
            errorCode: "issue_done_child_not_exited",
          }, run.id);
          continue;
        }
      }
      if (activeExecutionTimeoutMs <= 0) continue;
      // [run stability] step 등급 타임아웃 — QA/검수 step이거나 명시적 step timeout이 있으면
      //   기본 부실 역치(900s) 대신 그 등급의 역치로 판정한다(낮추지 않는다).
      const stepAwareTimeoutMs = await deps.resolveRunActiveExecutionTimeoutMs(run, activeExecutionTimeoutMs);
      if (stepAwareTimeoutMs <= 0) continue;
      const refTime = new Date(run.updatedAt).getTime();
      if (now.getTime() - refTime < stepAwareTimeoutMs) continue;

      // [approval-waiting marker] 실행이 pending 운영자 결정/승인 대기 중이면 stuck 이 아니다.
      // 프로세스는 살아있고 사람 결정에 막혀 있으므로 타임아웃/kill 을 보류한다(자동취소 금지).
      const approvalWait = run.issueId ? approvalWaitByIssueId.get(run.issueId) : undefined;
      if (approvalWait?.waiting) {
        logger.info(
          {
            runId: run.id,
            issueId: run.issueId,
            operatorDecisionIds: approvalWait.operatorDecisionIds,
            approvalIds: approvalWait.approvalIds,
            activeExecutionTimeoutMs,
          },
          "run is waiting on a pending operator decision/approval; skipping stale execution timeout",
        );
        continue;
      }

      if (trackedProcess) {
        trackedProcess.child.kill("SIGTERM");
        setTimeout(() => {
          if (!trackedProcess.child.killed) {
            trackedProcess.child.kill("SIGKILL");
          }
        }, Math.max(1, trackedProcess.graceSec) * 1000);
        runningProcesses.delete(run.id);
      }

      const timeoutMessage = `Heartbeat execution exceeded ${Math.round(stepAwareTimeoutMs / 1000)}s without reaching a terminal state`;
      const timedOutRun = await deps.setRunStatus(run.id, "timed_out", {
        error: timeoutMessage,
        errorCode: "execution_stale_timeout",
        finishedAt: now,
      }, { expectedStatuses: ["running"] });
      await deps.setWakeupStatus(run.wakeupRequestId, "timed_out", {
        finishedAt: now,
        error: timeoutMessage,
      });
      if (timedOutRun) {
        await deps.appendRunEvent(timedOutRun, await deps.nextRunEventSeq(timedOutRun.id), {
          eventType: "lifecycle",
          stream: "system",
          level: "error",
          message: timeoutMessage,
          payload: {
            activeExecution: hasActiveExecution,
            trackedProcess: Boolean(trackedProcess),
            activeExecutionTimeoutMs,
          },
        });
        // [recovery liveness hardening] per-run isolation: 이 run 의 terminal 처리(release,
        // finalize, startNext) 중 어느 단계가 실패/정지해도 전체 sweep 과 recovery lane 을
        // 중단시키지 않고 다음 run 으로 진행한다.
        try {
          await deps.releaseIssueExecutionAndPromote(timedOutRun, { skipLocked: true });
          const terminalRun = await deps.getRun(timedOutRun.id);
          if (terminalRun && isTerminalHeartbeatRunStatus(terminalRun.status)) {
            await deps.settleHeartbeatAfterExecution(deps.db, terminalRun, now);
          }
          await deps.finalizeAgentStatus(run.agentId, "timed_out");
          await deps.startNextQueuedRunForAgent(run.agentId);
          reaped.push(run.id);
        } catch (err) {
          logger.warn({ err, runId: run.id }, "failed to finalize timed-out run; continuing sweep");
        }
      }
      // Agent self-learning wiki (Phase 1): execution stale(hang) 패턴 기록 (non-blocking).
      fireWikiRecord(deps.wikiSvc, {
        companyId: run.companyId,
        agentId: run.agentId,
        missionId: null,
        pattern: "execution stale (hang)",
        cause: "어댑터 실행이 타임아웃(activeExecutionTimeout) 전에 종단 상태에 도달하지 못해 hang으로 판정됨.",
        solution: "API_TIMEOUT(10분)과 idle 점검. 장기 실행 명령은 타임아웃/백그라운드 분리. 자식이 stdout을 닫지 않고 누수하는지 확인.",
        errorCode: "execution_stale_timeout",
      }, run.id);
      continue;
    }

    // Apply staleness threshold to avoid false positives
    if (staleThresholdMs > 0) {
      const refTime = run.updatedAt ? new Date(run.updatedAt).getTime() : 0;
      if (now.getTime() - refTime < staleThresholdMs) continue;
    }

    const tracksLocalChild = isTrackedLocalChildProcessAdapter(adapterType);
    if (tracksLocalChild && run.processPid && isProcessAlive(run.processPid)) {
      if (run.errorCode !== DETACHED_PROCESS_ERROR_CODE) {
        const detachedMessage = `Lost in-memory process handle, but child pid ${run.processPid} is still alive`;
        const detachedRun = await deps.setRunStatus(run.id, "running", {
          error: detachedMessage,
          errorCode: DETACHED_PROCESS_ERROR_CODE,
        }, { expectedStatuses: ["running"] });
        if (detachedRun) {
          await deps.appendRunEvent(detachedRun, await deps.nextRunEventSeq(detachedRun.id), {
            eventType: "lifecycle",
            stream: "system",
            level: "warn",
            message: detachedMessage,
            payload: {
              processPid: run.processPid,
            },
          });
        }
      }
      // FIX 2b: orphaned-but-alive child longevity cap. child 가 DETACHED_REAP_AFTER_MS 초과 실행 중이면
      // 강제 kill 후 아래 기존 process_lost/retry 경로로 fall-through(무한 defer 방지 — CMPA-5519 대응).
      const detachedChildStartedMs = run.processStartedAt
        ? new Date(run.processStartedAt).getTime()
        : run.startedAt
          ? new Date(run.startedAt).getTime()
          : 0;
      if (
        DETACHED_REAP_AFTER_MS > 0 &&
        detachedChildStartedMs > 0 &&
        now.getTime() - detachedChildStartedMs > DETACHED_REAP_AFTER_MS
      ) {
        terminateRecordedProcess(run.processPid, "SIGTERM");
        setTimeout(
          () => terminateRecordedProcess(run.processPid, "SIGKILL"),
          Math.max(1, DETACHED_GRACE_SEC) * 1000,
        );
        // fall through to process_lost/retry below (의도적 continue 생략).
      } else {
        // [A2] run 은 longevity cap 까지 detached 로 유예하지만, 그동안 agent 가 phantom running
        // 에 갇히지 않도록 agent 가시성을 직접 교정한 뒤 유예한다.
        await deps.demoteAgentStuckDetached(run, now);
        continue;
      }
    }

    const shouldRetry = tracksLocalChild && !!run.processPid && (run.processLossRetryCount ?? 0) < 1;
    const baseMessage = run.processPid
      ? `Process lost -- child pid ${run.processPid} is no longer running`
      : "Process lost -- server may have restarted";

    let finalizedRun = await deps.setRunStatus(run.id, "failed", {
      error: shouldRetry ? `${baseMessage}; retrying once` : baseMessage,
      errorCode: "process_lost",
      finishedAt: now,
    }, { expectedStatuses: ["running"] });
    await deps.setWakeupStatus(run.wakeupRequestId, "failed", {
      finishedAt: now,
      error: shouldRetry ? `${baseMessage}; retrying once` : baseMessage,
    });
    if (!finalizedRun) finalizedRun = await deps.getRun(run.id);
    if (!finalizedRun) continue;

    // Agent wiki hook (process_lost): adapter 자식 프로세스 상실 교훈 축적 (non-blocking).
    // detached 30min cap fall-through 도 이 process_lost 경로를 타므로 이 hook 하나로 커버.
    fireWikiRecord(deps.wikiSvc, {
      companyId: run.companyId,
      agentId: run.agentId,
      pattern: "process_lost (adapter 자식 프로세스 상실)",
      cause: "어댑터 자식 프로세스가 예기치 않게 종료/상실돼 run 실패. in-memory handle 상실(→orphan), 서버 재시작, 자식 crash 등. CMPA-5519 hang의 주요 원인.",
      solution: "detached 30min cap + graceful shutdown 자식 회수로 handle-loss 회수 지연을 보강. 반복 시 adapter command·리소스·안정성 점검.",
      errorCode: "process_lost",
    }, run.id);

    let retriedRun: typeof heartbeatRuns.$inferSelect | null = null;
    let fallbackRun: typeof heartbeatRuns.$inferSelect | null = null;
    if (shouldRetry) {
      const agent = await deps.getAgent(run.agentId);
      if (agent) {
        retriedRun = await deps.enqueueProcessLossRetry(deps.retryEnqueueDeps, finalizedRun, agent, now);
      }
    } else {
      const agent = await deps.getAgent(run.agentId);
      const fallback = agent ? resolveAdapterFallbackConfig(agent.adapterConfig) : null;
      const fallbackAttempt = resolveAdapterFallbackAttempt(run.contextSnapshot);
      const shouldFallback =
        Boolean(agent) &&
        Boolean(fallback) &&
        fallbackAttempt < fallback!.maxAttempts;
      if (agent && fallback && shouldFallback) {
        fallbackRun = await deps.enqueueAdapterFallbackRun(deps.retryEnqueueDeps, finalizedRun, agent, now, {
          fallbackCommand: fallback.command,
          fallbackProvider: fallback.provider,
          fallbackModel: fallback.model,
          fallbackThinking: resolveAdapterFallbackThinking(
            fallback,
            resolveAdapterFallbackAttempt(finalizedRun.contextSnapshot) + 1,
          ),
          fallbackReason: "process_lost",
        });
      } else {
        // [recovery liveness hardening] per-run isolation: fallback 없는 run 의 release+promote
        // 실패가 전체 sweep 을 중단시키지 않게 격리.
        try {
          await deps.releaseIssueExecutionAndPromote(finalizedRun, { skipLocked: true });
        } catch (err) {
          logger.warn({ err, runId: run.id }, "failed to release+promote finalized run; continuing sweep");
        }
      }
    }

    await deps.appendRunEvent(finalizedRun, await deps.nextRunEventSeq(finalizedRun.id), {
      eventType: "lifecycle",
      stream: "system",
      level: "error",
      message: shouldRetry
        ? `${baseMessage}; queued retry ${retriedRun?.id ?? ""}`.trim()
        : fallbackRun
          ? `${baseMessage}; queued adapter fallback ${fallbackRun.id}`
        : baseMessage,
      payload: {
        ...(run.processPid ? { processPid: run.processPid } : {}),
        ...(retriedRun ? { retryRunId: retriedRun.id } : {}),
        ...(fallbackRun ? { fallbackRunId: fallbackRun.id } : {}),
      },
    });

    // [recovery liveness hardening] terminal 체인 후속(finalize/startNext) 도 격리 — 이 run 의
    // 실패가 전체 sweep 을 중단시키지 않는다.
    try {
      await deps.finalizeAgentStatus(run.agentId, "failed");
      await deps.startNextQueuedRunForAgent(run.agentId);
      runningProcesses.delete(run.id);
      reaped.push(run.id);
    } catch (err) {
      logger.warn({ err, runId: run.id }, "failed to finalize process-lost run; continuing sweep");
    }
  }

  // [checkpoint+graceful shutdown 백스톱] 종료 플러시가 마킹(failed+shutdown_interrupted)까지는
  // 커밋했으나 재시도 등록 직전에 프로세스가 죽거나 데드라인에 걸린 런의 회수 사각지대 방어.
  // 이 스캔이 없으면 마킹된 런은 위 running 스캔 대상에서 빠져 아무도 회수하지 못한다(요구사항:
  // 종료 시 마킹된 런은 기존 회수 경로에 반드시 진입해야 한다). 조건 — processLossRetryCount<1
  // (재시도 자격, 소진 규칙 동일) + 후계 런(retryOfRunId, retry/fallback 공통) 부재 → 정확히 1회.
  // retryCount 소진 마킹 런의 fallback 누락은 여기서 보충하지 않는다(이슈 락은
  // reapStalledIssueExecutionLocks 가 회수 — 데드라인 스킵 시 의도된 우아한 강등).
  try {
    const interruptedRuns = await deps.db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.status, "failed"),
          eq(heartbeatRuns.errorCode, SHUTDOWN_INTERRUPTED_ERROR_CODE),
          sql`${heartbeatRuns.processLossRetryCount} < 1`,
        ),
      )
      .limit(50);
    for (const run of interruptedRuns) {
      try {
        if (runningProcesses.has(run.id) || deps.activeRunExecutions.has(run.id)) continue;
        const successors = await deps.db
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.retryOfRunId, run.id))
          .limit(1);
        if (successors.length > 0) continue;
        const agent = await deps.getAgent(run.agentId);
        if (!agent) continue;
        const retriedRun = await deps.enqueueProcessLossRetry(deps.retryEnqueueDeps, run, agent, now);
        if (retriedRun) {
          await deps.setWakeupStatus(run.wakeupRequestId, "failed", {
            finishedAt: now,
            error: run.error ?? "shutdown_interrupted recovered by backstop",
          });
          await deps.appendRunEvent(run, await deps.nextRunEventSeq(run.id), {
            eventType: "lifecycle",
            stream: "system",
            level: "warn",
            message: `Recovered shutdown-interrupted run; queued retry ${retriedRun.id}`,
            payload: { retryRunId: retriedRun.id },
          });
          reaped.push(run.id);
        }
      } catch (err) {
        logger.warn({ err, runId: run.id }, "failed to recover shutdown-interrupted run; continuing sweep");
      }
    }
  } catch (err) {
    logger.warn({ err }, "shutdown-interrupted backstop scan failed; continuing sweep");
  }

  if (queuedStaleThresholdMs > 0) {
    const recoverQueuedStaleWork = createHeartbeatQueuedStaleRecovery({
      db: deps.db,
      activeExecutionTimeoutMs,
      withAgentStartLock,
      startNextQueuedRunForAgent: deps.startNextQueuedRunForAgent,
      countActiveRunsForAgent: deps.countRunningRunsForAgent,
      maxConcurrentRuns: agent => parseHeartbeatPolicy(agent).maxConcurrentRuns,
      hasActiveExecution: runId => deps.activeRunExecutions.has(runId),
      hasLiveTrackedChild: runId => {
        const child = runningProcesses.get(runId)?.child;
        return Boolean(child && child.exitCode === null && child.signalCode === null && isProcessAlive(child.pid));
      },
      resolveActiveExecutionTimeoutMs: deps.resolveRunActiveExecutionTimeoutMs,
      setRunStatus: deps.setHeartbeatRunStatus,
      publishRunStatus: run => deps.publishHeartbeatRunStatus(publishLiveEvent, run),
      nextRunEventSeq: deps.nextRunEventSeq,
      appendRunEvent: deps.appendRunEvent,
      releaseIssueExecutionAndPromote: deps.releaseIssueExecutionAndPromote,
      getRun: deps.getRun,
      settleHeartbeatAfterExecution: deps.settleHeartbeatAfterExecution,
      finalizeAgentStatus: deps.finalizeAgentStatus,
      recordQueueTransitionEvent: deps.recordQueueTransitionEvent,
    });
    const queuedRecovery = await recoverQueuedStaleWork(queuedStaleThresholdMs);
    reaped.push(...queuedRecovery.reapedRunIds);
  }

  const continuationCursor = deps.getTerminalContinuationScanCursor();
  const continuationPredicate = continuationCursor
    ? and(eq(workflowTransitionEvents.eventType, deps.TERMINAL_RELEASE_EVENT_TYPE), or(
        gt(workflowTransitionEvents.createdAt, sql`${continuationCursor.createdAt}::timestamptz`),
        and(eq(workflowTransitionEvents.createdAt, sql`${continuationCursor.createdAt}::timestamptz`),
          gt(workflowTransitionEvents.id, continuationCursor.id)),
      ))
    : eq(workflowTransitionEvents.eventType, deps.TERMINAL_RELEASE_EVENT_TYPE);
  const continuationRows = await deps.db.select({ id: workflowTransitionEvents.id, createdAt: sql<string>`${workflowTransitionEvents.createdAt}::text` })
    .from(workflowTransitionEvents).where(continuationPredicate)
    .orderBy(asc(workflowTransitionEvents.createdAt), asc(workflowTransitionEvents.id)).limit(50);
  if (continuationRows.length === 0) {
    deps.setTerminalContinuationScanCursor(null);
  } else {
    const last = continuationRows[continuationRows.length - 1]!;
    deps.setTerminalContinuationScanCursor({ createdAt: last.createdAt, id: last.id });
    for (const row of continuationRows) {
      if (deps.terminalContinuationInflight.has(row.id)) continue;
      const manifest = await deps.readTerminalReleaseManifest(deps.db, row.id);
      if (manifest.kind !== "found") {
        logger.warn({ continuationEventId: row.id, reason: manifest.reason },
          "terminal release reaper left malformed continuation held");
        continue;
      }
      const execution = deps.runTerminalReleaseContinuation(row.id).then(result => {
        if (result.kind === "held") logger.warn({ continuationEventId: row.id, reason: result.reason },
          "terminal release reaper left continuation pending");
      }).catch(error => {
        logger.warn({ err: error, continuationEventId: row.id },
          "terminal release reaper continuation failed; durable obligation remains pending");
      });
      trackHeartbeatExecution(deps.db, execution);
    }
  }

  if (reaped.length > 0) {
    logger.warn({ reapedCount: reaped.length, runIds: reaped }, "reaped orphaned heartbeat runs");
  }
  return { reaped: reaped.length, runIds: reaped };
}

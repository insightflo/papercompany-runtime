type HeartbeatSchedulerHeartbeat = {
  tickTimers(now: Date): Promise<{ enqueued?: number }>;
  reapOrphanedRuns(opts?: {
    staleThresholdMs?: number;
    activeExecutionTimeoutMs?: number;
    queuedStaleThresholdMs?: number;
  }): Promise<unknown>;
  resumeQueuedRuns(): Promise<unknown>;
};

type HeartbeatSchedulerRoutines = {
  tickScheduledTriggers(now: Date): Promise<{ triggered?: number }>;
};

type HeartbeatSchedulerLogger = {
  info(message: string): void;
  info(obj: unknown, message: string): void;
  warn(message: string): void;
  error(obj: unknown, message: string): void;
};

export type HeartbeatSchedulerOptions = {
  heartbeat: HeartbeatSchedulerHeartbeat;
  routines: HeartbeatSchedulerRoutines;
  logger: HeartbeatSchedulerLogger;
  timerIntervalMs: number;
  routineIntervalMs?: number;
  recoveryIntervalMs?: number;
  recoveryStaleThresholdMs?: number;
};

export type HeartbeatScheduler = {
  start(): void;
  stop(): void;
};

type Lane = "timer" | "routine" | "recovery";

const RECOVERY_LANE_TIMEOUT_MS = 4 * 60 * 1000;

export function createHeartbeatScheduler(opts: HeartbeatSchedulerOptions): HeartbeatScheduler {
  const routineIntervalMs = opts.routineIntervalMs ?? opts.timerIntervalMs;
  const recoveryIntervalMs = opts.recoveryIntervalMs ?? Math.max(opts.timerIntervalMs * 10, 5 * 60 * 1000);
  const recoveryStaleThresholdMs = opts.recoveryStaleThresholdMs ?? 5 * 60 * 1000;
  const activeExecutionTimeoutMs = 15 * 60 * 1000;
  const queuedStaleThresholdMs = Math.max(recoveryStaleThresholdMs * 3, 15 * 60 * 1000);
  const laneTimeoutMs: Record<Lane, number> = {
    timer: Math.max(opts.timerIntervalMs * 2, 30_000),
    routine: Math.max(routineIntervalMs * 2, 30_000),
    recovery: Math.min(RECOVERY_LANE_TIMEOUT_MS, Math.max(recoveryIntervalMs - 30_000, 30_000)),
  };

  let running = false;
  let timerHandle: ReturnType<typeof setInterval> | null = null;
  let routineHandle: ReturnType<typeof setInterval> | null = null;
  let recoveryHandle: ReturnType<typeof setInterval> | null = null;
  const laneFlights: Record<Lane, number> = {
    timer: 0,
    routine: 0,
    recovery: 0,
  };
  const inFlight: Record<Lane, boolean> = {
    timer: false,
    routine: false,
    recovery: false,
  };

  const runLane = (lane: Lane, task: () => Promise<void>) => {
    if (inFlight[lane]) {
      const label = lane === "timer" ? "heartbeat timer tick" : lane === "routine" ? "routine scheduler tick" : "heartbeat recovery";
      opts.logger.warn(`Skipping ${label} because the previous tick is still running`);
      return;
    }

    inFlight[lane] = true;

    // timer/routine lane 은 기존 동작 유지: 이전 tick 이 끝날 때까지 skip(타임아웃 없음).
    if (lane !== "recovery") {
      void Promise.resolve()
        .then(task)
        .catch((err) => {
          const message = lane === "timer" ? "heartbeat timer tick failed" : "routine scheduler tick failed";
          opts.logger.error({ err }, message);
        })
        .finally(() => {
          inFlight[lane] = false;
        });
      return;
    }

    // [recovery liveness hardening] recovery lane 은 한 tick 이 hang 되면 다음 tick 이 영원히
    // skip 된다(Skipping heartbeat recovery...). wall-clock 예산 후 inFlight 를 풀어 다음 tick 이
    // 진행되게 한다. 예산 초과 시에도 원래 task 는 취소하지 않는다(JS Promise 는 취소 불가).
    // timeout 과 늦은 finally 모두 flight 토큰(laneFlights)을 비교해, 자기 세대일 때만
    // inFlight 를 해제한다 — 그래야 timeout 으로 새 tick 이 시작된 뒤 이전 task 의 finally 가
    // 새 tick 을 풀어버리는 세대 간 간섭이 없다.
    // 주의: 예산 초과로 lane 이 풀려도 이전 task 의 DB 작업은 여전히 진행될 수 있고, 그 작업이
    // 반드시 멱등이라고 보장되지는 않는다(release+promote 경로는 lock_timeout/statement_timeout/
    // SKIP LOCKED 로 bounded 를 강화했으나, 그 외 경로의 멱등성은 별도 검증 필요).
    const flight = ++laneFlights.recovery;
    const laneTask = Promise.resolve().then(task);
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutTask = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), laneTimeoutMs.recovery);
      timeoutHandle.unref?.();
    });

    void Promise.race([
      laneTask.then(() => "completed" as const),
      timeoutTask,
    ])
      .then((outcome) => {
        if (outcome === "timeout") {
          opts.logger.warn(`Heartbeat recovery lane exceeded ${laneTimeoutMs.recovery}ms; releasing lane for the next tick`);
        }
      })
      .catch((err) => {
        opts.logger.error({ err }, "periodic heartbeat recovery failed");
      })
      .finally(() => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (laneFlights.recovery === flight) inFlight.recovery = false;
      });
  };

  const tickTimers = async () => {
    const result = await opts.heartbeat.tickTimers(new Date());
    if ((result.enqueued ?? 0) > 0) {
      opts.logger.info({ ...result }, "heartbeat timer tick enqueued runs");
    }
  };

  const tickRoutines = async () => {
    const result = await opts.routines.tickScheduledTriggers(new Date());
    if ((result.triggered ?? 0) > 0) {
      opts.logger.info({ ...result }, "routine scheduler tick enqueued runs");
    }
  };

  const recover = async (staleThresholdMs?: number) => {
    if (staleThresholdMs === undefined) {
      await opts.heartbeat.reapOrphanedRuns();
    } else {
      await opts.heartbeat.reapOrphanedRuns({
        staleThresholdMs,
        activeExecutionTimeoutMs,
        queuedStaleThresholdMs,
      });
    }
    await opts.heartbeat.resumeQueuedRuns();
  };

  return {
    start() {
      if (running) return;
      running = true;

      runLane("recovery", () => recover());
      timerHandle = setInterval(() => runLane("timer", tickTimers), opts.timerIntervalMs);
      routineHandle = setInterval(() => runLane("routine", tickRoutines), routineIntervalMs);
      recoveryHandle = setInterval(
        () => runLane("recovery", () => recover(recoveryStaleThresholdMs)),
        recoveryIntervalMs,
      );
    },

    stop() {
      if (!running) return;
      running = false;
      if (timerHandle) clearInterval(timerHandle);
      if (routineHandle) clearInterval(routineHandle);
      if (recoveryHandle) clearInterval(recoveryHandle);
      timerHandle = null;
      routineHandle = null;
      recoveryHandle = null;
    },
  };
}

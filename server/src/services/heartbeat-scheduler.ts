type HeartbeatSchedulerHeartbeat = {
  tickTimers(now: Date): Promise<{ enqueued?: number }>;
  reapOrphanedRuns(opts?: { staleThresholdMs?: number }): Promise<unknown>;
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

export function createHeartbeatScheduler(opts: HeartbeatSchedulerOptions): HeartbeatScheduler {
  const routineIntervalMs = opts.routineIntervalMs ?? opts.timerIntervalMs;
  const recoveryIntervalMs = opts.recoveryIntervalMs ?? Math.max(opts.timerIntervalMs * 10, 5 * 60 * 1000);
  const recoveryStaleThresholdMs = opts.recoveryStaleThresholdMs ?? 5 * 60 * 1000;

  let running = false;
  let timerHandle: ReturnType<typeof setInterval> | null = null;
  let routineHandle: ReturnType<typeof setInterval> | null = null;
  let recoveryHandle: ReturnType<typeof setInterval> | null = null;
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
    void task()
      .catch((err) => {
        const message =
          lane === "timer"
            ? "heartbeat timer tick failed"
            : lane === "routine"
              ? "routine scheduler tick failed"
              : "periodic heartbeat recovery failed";
        opts.logger.error({ err }, message);
      })
      .finally(() => {
        inFlight[lane] = false;
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
      await opts.heartbeat.reapOrphanedRuns({ staleThresholdMs });
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

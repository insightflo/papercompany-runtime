// server/src/services/judgment/shadow-loop-runner.ts
//
// [파일 목적] 판단 계층 사후 관측(섀도) 주기 루프 공용 실행기 —
//   plan-qa-shadow 와 agent-judgment-shadow 가 동일한 시작/정지/진행 중 틱 추적/유한 시간
//   drain(정지 계약) 상태 머신을 공유한다.
//
// [안전 경계] 두 섀도 루프는 순수 사후 관측(judgment_calls 감사행 기록 전용)이며 어떤 실행 권한도
//   갖지 않는다. 정지 시 stop() 이 신규 스케줄링을 즉시 차단하고, drain() 은 진행 중 틱을
//   유한 상한(기본 5초)까지 Promise.allSettled 로 대기해 외부 판단 API 지연이 서버 종료
//   (systemd TimeoutStopUSec SIGKILL)를 붙잡지 않게 한다.

import { logger as defaultLogger } from "../../middleware/logger.js";

export const DEFAULT_SHADOW_LOOP_INTERVAL_MS = 10 * 60_000; // 10분
export const DEFAULT_SHADOW_DRAIN_TIMEOUT_MS = 5_000; // 5초

export interface ShadowLoopPassSummary {
  scanned: number;
  processed: number;
  recorded: number;
  skipped: number;
}

export interface ShadowLoopSeedSummary {
  companies: number;
  seeded: number;
}

export interface BoundedShadowLoopState<TResult> {
  running: boolean;
  tickCount: number;
  lastTickAt: string | null;
  lastResult: TResult | null;
  lastError: string | null;
  /** 루프 시작 시 1회 실행한 정의 seed 결과. */
  seed: ShadowLoopSeedSummary | null;
}

export interface BoundedShadowLoop<TResult> {
  start: () => void;
  stop: () => void;
  drain: () => Promise<void>;
  /** 1틱 수동 실행(테스트/운영 점검용). */
  observe: (now?: Date) => Promise<void>;
  getState: () => BoundedShadowLoopState<TResult>;
}

export interface CreateBoundedShadowLoopOptions<TResult extends ShadowLoopPassSummary> {
  /** 로그 접두어(예: "plan-qa shadow", "agent-judgment shadow"). */
  name: string;
  /** 정의 신규 seed 발생 시 남길 info 메시지. */
  seededLogMessage: string;
  /** 시작 로그에 함께 남길 설정 스냅샷. */
  startLogContext: Record<string, unknown>;
  intervalMs?: number;
  drainTimeoutMs?: number;
  /** 첫 틱에서 1회 실행되는 정의 시더. setSeed 로 부분 완료 상태도 보존한다. */
  seedOnce: (setSeed: (value: ShadowLoopSeedSummary) => void) => Promise<ShadowLoopSeedSummary>;
  /** 실제 1틱 패스 실행기. */
  runPass: (now: Date) => Promise<TResult>;
}

export function createBoundedShadowLoop<TResult extends ShadowLoopPassSummary>(
  options: CreateBoundedShadowLoopOptions<TResult>,
): BoundedShadowLoop<TResult> {
  const intervalMs = options.intervalMs ?? DEFAULT_SHADOW_LOOP_INTERVAL_MS;
  const drainTimeoutMs =
    options.drainTimeoutMs !== undefined &&
    Number.isFinite(options.drainTimeoutMs) &&
    options.drainTimeoutMs >= 0
      ? options.drainTimeoutMs
      : DEFAULT_SHADOW_DRAIN_TIMEOUT_MS;
  const log = defaultLogger;

  const activeTicks = new Set<Promise<unknown>>();
  let interval: ReturnType<typeof setInterval> | null = null;
  let automaticAdmissionOpen = false;
  let automaticGeneration = 0;
  let tickInFlight = false;
  let tickCount = 0;
  let lastTickAt: string | null = null;
  let lastResult: TResult | null = null;
  let lastError: string | null = null;
  let seed: ShadowLoopSeedSummary | null = null;
  let seededOnce = false;

  function trackTick<T>(tick: Promise<T>): Promise<T> {
    let tracked!: Promise<T>;
    tracked = Promise.resolve(tick).then(
      (value) => {
        activeTicks.delete(tracked);
        return value;
      },
      (error) => {
        activeTicks.delete(tracked);
        throw error;
      },
    );
    activeTicks.add(tracked);
    return tracked;
  }

  function isCurrentAutomaticGeneration(generation: number): boolean {
    return automaticAdmissionOpen && automaticGeneration === generation;
  }

  async function executeObserve(now = new Date(), generation?: number): Promise<void> {
    if (generation !== undefined && !isCurrentAutomaticGeneration(generation)) return;
    if (tickInFlight) {
      log.warn({ intervalMs }, `${options.name} tick skipped — previous tick still running`);
      return;
    }
    tickInFlight = true;
    try {
      if (!seededOnce) {
        seededOnce = true;
        try {
          const seeded = await options.seedOnce((value) => {
            seed = value;
          });
          seed = seeded;
          if (seeded.seeded > 0) {
            log.info({ ...seeded }, options.seededLogMessage);
          }
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          log.error({ err: lastError }, `${options.name}: definition seeding failed at loop start`);
        }
      }
      if (generation !== undefined && !isCurrentAutomaticGeneration(generation)) return;
      const passResult = await options.runPass(now);
      tickCount += 1;
      lastTickAt = now.toISOString();
      lastResult = passResult;
      lastError = null;
      if (passResult.processed > 0 || passResult.skipped > 0) {
        log.info(
          {
            intervalMs,
            scanned: passResult.scanned,
            processed: passResult.processed,
            recorded: passResult.recorded,
            skipped: passResult.skipped,
          },
          `${options.name} pass completed`,
        );
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      log.error({ intervalMs, err: lastError }, `${options.name} tick failed`);
    } finally {
      tickInFlight = false;
    }
  }

  function observe(now = new Date()): Promise<void> {
    return trackTick(executeObserve(now));
  }

  function runAutomaticObserve(generation: number): void {
    if (!isCurrentAutomaticGeneration(generation)) return;
    void trackTick(executeObserve(new Date(), generation));
  }

  function stop(): void {
    automaticAdmissionOpen = false;
    automaticGeneration += 1;
    if (!interval) return;
    clearInterval(interval);
    interval = null;
    log.info({ intervalMs }, `${options.name} loop stopped`);
  }

  async function drain(): Promise<void> {
    stop();
    const deadline = Date.now() + drainTimeoutMs;
    while (activeTicks.size > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        log.warn(
          { drainTimeoutMs, activeTicks: activeTicks.size },
          `${options.name} drain timed out waiting for in-flight tick`,
        );
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        await Promise.race([
          Promise.allSettled([...activeTicks]),
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              timedOut = true;
              resolve();
            }, remainingMs);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (timedOut) {
        log.warn(
          { drainTimeoutMs, activeTicks: activeTicks.size },
          `${options.name} drain timed out waiting for in-flight tick`,
        );
        return;
      }
    }
  }

  return {
    start() {
      if (interval) return;
      automaticAdmissionOpen = true;
      const generation = ++automaticGeneration;
      log.info({ intervalMs, ...options.startLogContext }, `${options.name} loop started`);
      interval = setInterval(() => {
        runAutomaticObserve(generation);
      }, intervalMs);
      interval.unref?.();
      runAutomaticObserve(generation);
    },
    stop,
    drain,
    observe,
    getState() {
      return { running: interval !== null, tickCount, lastTickAt, lastResult, lastError, seed };
    },
  };
}

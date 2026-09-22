// server/src/services/judgment/agent-judgment-shadow-loop.ts
//
// [파일 목적] Jev agent-judgment 섀도 캘리브레이션(v2) — 주기 관측 루프.
//   plan-qa-shadow.ts 의 createPlanQaShadowLoop 구조를 그대로 미러한다:
//   setInterval + tickInFlight 가드 + unref + per-tick try/catch(루퍼 불사),
//   start 시 정의 seed 1회 + 즉시 1틱 후 interval arm(idempotent), 기본 interval 10분.
//
// [안전 경계] 결과는 judgment_calls 감사행뿐 — 어떤 판정·이슈·상태도 변경하지 않는다.
//   PAPERCLIP_JUDGMENT_ENABLED off 면 app.ts 가 이 팩터리를 호출하지 않는다(완전 inert).

import type { Db } from "@paperclipai/db";
import { logger as defaultLogger } from "../../middleware/logger.js";
import type { JudgmentService } from "./judgment-service.js";
import {
  resolveAgentShadowConfig,
  runAgentJudgmentShadowPass,
  seedAgentJudgmentShadowDefinitions,
  type AgentShadowPassOptions,
  type AgentShadowPassResult,
} from "./agent-judgment-shadow.js";

/** 판단 계층 공용 게이트 — plan-qa-shadow 와 같은 스위치를 쓴다. */
export interface AgentShadowOwnership {
  enabled: boolean;
}

function isEnabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

/**
 * [목적] PAPERCLIP_JUDGMENT_ENABLED env 로 섀도 관측 루프 활성화 여부 결정.
 *   "1"/"true"(대소문자 무관)만 true, 그 외(undefined 포함) → false.
 */
export function resolveAgentShadowOwnership(
  env: Record<string, string | undefined> = process.env,
): AgentShadowOwnership {
  return { enabled: isEnabled(env.PAPERCLIP_JUDGMENT_ENABLED) };
}

export interface AgentShadowLoopState {
  running: boolean;
  tickCount: number;
  lastTickAt: string | null;
  lastResult: AgentShadowPassResult | null;
  lastError: string | null;
  /** 루프 시작 시 1회 실행한 정의 seed 결과. */
  seed: { companies: number; seeded: number } | null;
}

export interface AgentShadowLoop {
  start: () => void;
  stop: () => void;
  /** 1틱 수동 실행(테스트/운영 점검용). */
  observe: (now?: Date) => Promise<void>;
  getState: () => AgentShadowLoopState;
}

export interface CreateAgentJudgmentShadowLoopOptions {
  db: Db;
  intervalMs?: number;
  /** env 오버라이드 주입용(테스트). 기본 process.env. */
  env?: Record<string, string | undefined>;
  service?: JudgmentService;
  runPass?: (db: Db, options?: AgentShadowPassOptions) => Promise<AgentShadowPassResult>;
}

const DEFAULT_AGENT_SHADOW_INTERVAL_MS = 10 * 60_000; // 10분

/**
 * [목적] createAgentJudgmentShadowLoop — 섀도 관측 주기 루프(plan-qa-shadow 미러).
 *   start 시 정의 seed 1회 + 즉시 1틱, 이후 intervalMs(기본 10분)마다 1틱.
 *   per-tick try/catch — 한 틱 실패가 루프를 죽이지 않는다. stop/start 재진입 가능.
 */
export function createAgentJudgmentShadowLoop(options: CreateAgentJudgmentShadowLoopOptions): AgentShadowLoop {
  const intervalMs = options.intervalMs ?? DEFAULT_AGENT_SHADOW_INTERVAL_MS;
  const config = resolveAgentShadowConfig(options.env ?? process.env);
  const runPass = options.runPass ?? runAgentJudgmentShadowPass;
  const log = defaultLogger;

  let interval: ReturnType<typeof setInterval> | null = null;
  let tickInFlight = false;
  let tickCount = 0;
  let lastTickAt: string | null = null;
  let lastResult: AgentShadowPassResult | null = null;
  let lastError: string | null = null;
  let seed: { companies: number; seeded: number } | null = null;
  let seededOnce = false;

  async function observe(now = new Date()): Promise<void> {
    if (!seededOnce) {
      // 시작 1회: 전 회사 섀도 정의 seed(idempotent — 이미 있으면 no-op).
      seededOnce = true;
      try {
        seed = await seedAgentJudgmentShadowDefinitions(options.db);
        if (seed.seeded > 0) {
          log.info({ ...seed }, "agent-judgment shadow: seeded definitions");
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        log.error({ err: lastError }, "agent-judgment shadow: definition seeding failed at loop start");
      }
    }
    if (tickInFlight) {
      log.warn({ intervalMs }, "agent-judgment shadow tick skipped — previous tick still running");
      return;
    }
    tickInFlight = true;
    try {
      const passResult = await runPass(options.db, {
        maxPerTick: config.maxPerTick,
        lookbackDays: config.lookbackDays,
        ...(options.service ? { service: options.service } : {}),
        now,
      });
      tickCount += 1;
      lastTickAt = now.toISOString();
      lastResult = passResult;
      lastError = null;
      if (passResult.processed > 0 || passResult.skipped > 0) {
        log.info({ intervalMs, ...passResult }, "agent-judgment shadow pass completed");
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      log.error({ intervalMs, err: lastError }, "agent-judgment shadow tick failed");
    } finally {
      tickInFlight = false;
    }
  }

  return {
    start() {
      if (interval) return;
      log.info({ intervalMs, ...config }, "agent-judgment shadow loop started");
      void observe();
      interval = setInterval(() => {
        void observe();
      }, intervalMs);
      interval.unref?.();
    },
    stop() {
      if (!interval) return;
      clearInterval(interval);
      interval = null;
      log.info({ intervalMs }, "agent-judgment shadow loop stopped");
    },
    observe,
    getState() {
      return { running: interval !== null, tickCount, lastTickAt, lastResult, lastError, seed };
    },
  };
}

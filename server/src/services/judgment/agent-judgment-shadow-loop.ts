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
import type { JudgmentService } from "./judgment-service.js";
import {
  resolveAgentShadowConfig,
  runAgentJudgmentShadowPass,
  seedAgentJudgmentShadowDefinitions,
  type AgentShadowPassOptions,
  type AgentShadowPassResult,
} from "./agent-judgment-shadow.js";
import {
  createBoundedShadowLoop,
  type BoundedShadowLoop,
  type BoundedShadowLoopState,
} from "./shadow-loop-runner.js";

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

export type AgentShadowLoopState = BoundedShadowLoopState<AgentShadowPassResult>;

export type AgentShadowLoop = BoundedShadowLoop<AgentShadowPassResult>;

export interface CreateAgentJudgmentShadowLoopOptions {
  db: Db;
  intervalMs?: number;
  /** 정지(drain) 시 진행 중 틱 대기 상한(ms). 기본 5_000. */
  drainTimeoutMs?: number;
  /** env 오버라이드 주입용(테스트). 기본 process.env. */
  env?: Record<string, string | undefined>;
  service?: JudgmentService;
  runPass?: (db: Db, options?: AgentShadowPassOptions) => Promise<AgentShadowPassResult>;
}

/**
 * [목적] createAgentJudgmentShadowLoop — 섀도 관측 주기 루프(plan-qa-shadow 미러).
 *   start 시 정의 seed 1회 + 즉시 1틱, 이후 intervalMs(기본 10분)마다 1틱.
 *   per-tick try/catch — 한 틱 실패가 루프를 죽이지 않는다. stop/start 재진입 가능,
 *   drain() 은 진행 중 틱을 유한 시간(기본 5초) 대기한다.
 */
export function createAgentJudgmentShadowLoop(options: CreateAgentJudgmentShadowLoopOptions): AgentShadowLoop {
  const config = resolveAgentShadowConfig(options.env ?? process.env);
  const runPass = options.runPass ?? runAgentJudgmentShadowPass;

  return createBoundedShadowLoop({
    name: "agent-judgment shadow",
    seededLogMessage: "agent-judgment shadow: seeded definitions",
    startLogContext: { ...config },
    intervalMs: options.intervalMs,
    drainTimeoutMs: options.drainTimeoutMs,
    seedOnce: async (setSeed) => {
      const seeded = await seedAgentJudgmentShadowDefinitions(options.db);
      setSeed(seeded);
      return seeded;
    },
    runPass: (now) =>
      runPass(options.db, {
        maxPerTick: config.maxPerTick,
        lookbackDays: config.lookbackDays,
        ...(options.service ? { service: options.service } : {}),
        now,
      }),
  });
}

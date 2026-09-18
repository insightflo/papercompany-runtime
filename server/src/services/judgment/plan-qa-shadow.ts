// server/src/services/judgment/plan-qa-shadow.ts
//
// [파일 목적] 트랙 B-2 — PLAN-QA 사후 관측(섀도) 파일럿. 이미 저장된 PLAN-QA 판정
//   (mission_plan_qa_verdicts)을 대상으로 "전체 QA 를 생략할 수 있었는가"를 판단 계층
//   (TypeSafe jev)에 사후 질문하고 결과를 judgment_calls 감사행에만 기록한다.
//   어떤 판정·이슈·상태도 변경하지 않는다(순수 관측 — 실행제어 무접촉).
//
// [등록 패턴] agent-skill-optimizer.ts 미러: env 게이트 + setInterval + tickInFlight 가드 +
//   unref + per-tick try/catch(루퍼 불사). app.ts 가 PAPERCLIP_JUDGMENT_ENABLED 로만
//   루프를 생성한다(off 면 루프 자체가 없어 완전 inert).
//
// [틱 동작] 최근 N일(기본 7일) verdict 중 judgment_calls 에 correlationKey
//   `mission_plan_qa:{verdictId}` 기록이 없는 것을 최대 maxPerTick(기본 3)건 찾아 각각:
//     1) state 조립 = { plan: 계획 원문(mission_plan_artifacts), quality_contract,
//        mission: {id,title,status} } — 계획 작성자/리뷰어의 자기 평가 문구(verdict 값,
//        diagnostics, 이슈 코멘트)는 state 에서 제외. 원문·계약·메타만.
//        verdict.missionPlanArtifactId 가 null 이면 skip+로그(원문 없이는 판단 불가).
//     2) askJudgment(mode "observed", contextType "mission_plan_qa", contextId verdict.id)
//        — 정의 name "plan-qa-prescreen" 활성 버전.
//     3) 결과는 judgment_calls 에만 기록(askJudgment 가 감사행을 남긴다). 성공·실패 무관
//        1행이므로 다음 틱에서 재처리되지 않는다.
//
// [정의 seed] 루프 시작 시 1회 + 회사별 on-demand(활성 정의 없음 에러 시)로 idempotent 시더가
//   "plan-qa-prescreen" v1 정의를 만든다. modelId 는 "jev-1.13.0" 고정.
//
// [수정시 영향] 이 모듈은 mission_plan_qa_verdicts 를 읽기만 하고 recordMissionPlanQaVerdict
//   등 판정 저장 로직을 절대 수정하지 않는다. lookback/maxPerTick env 로 관측 비용을 제어한다.

import { and, asc, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companies,
  judgmentCalls,
  judgmentDefinitions,
  missionPlanArtifacts,
  missionPlanQaVerdicts,
  missions,
} from "@paperclipai/db";
import type { JudgmentDefinitionSnapshot } from "@paperclipai/shared";
import { logger as defaultLogger } from "../../middleware/logger.js";
import { createJudgmentService, type JudgmentService } from "./judgment-service.js";

// ---------------------------------------------------------------------------
// env 게이트 — agent-skill-optimizer(resolveAgentWikiEvolutionOwnership) 미러.
// 판단 계층 공용 게이트 PAPERCLIP_JUDGMENT_ENABLED(default off)를 그대로 쓴다.
// ---------------------------------------------------------------------------

export interface PlanQaShadowOwnership {
  enabled: boolean;
}

function isEnabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

/**
 * [목적] PAPERCLIP_JUDGMENT_ENABLED env 로 섀도 관측 루프 활성화 여부 결정.
 *   provider 게이트와 같은 스위치 — 판단 계층 전체를 한 번에 켜고 끈다.
 * [출력] { enabled }. undefined/그 외 → false(관측 파일럿, 명시적 opt-in 필요).
 */
export function resolvePlanQaShadowOwnership(
  env: Record<string, string | undefined> = process.env,
): PlanQaShadowOwnership {
  return { enabled: isEnabled(env.PAPERCLIP_JUDGMENT_ENABLED) };
}

// ---------------------------------------------------------------------------
// 섀도 관측 설정(env 오버라이드) — 비용 제어용.
// ---------------------------------------------------------------------------

export interface PlanQaShadowConfig {
  /** 틱당 최대 관측 건수. PAPERCLIP_JUDGMENT_SHADOW_MAX_PER_TICK (기본 3). */
  maxPerTick: number;
  /** 관측 대상 verdict 조회 창(일). PAPERCLIP_JUDGMENT_SHADOW_LOOKBACK_DAYS (기본 7). */
  lookbackDays: number;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function resolvePlanQaShadowConfig(
  env: Record<string, string | undefined> = process.env,
): PlanQaShadowConfig {
  return {
    maxPerTick: parsePositiveInt(env.PAPERCLIP_JUDGMENT_SHADOW_MAX_PER_TICK, 3),
    lookbackDays: parsePositiveInt(env.PAPERCLIP_JUDGMENT_SHADOW_LOOKBACK_DAYS, 7),
  };
}

// ---------------------------------------------------------------------------
// 정의 seed — "plan-qa-prescreen" v1 (modelId 고정 jev-1.13.0).
// ---------------------------------------------------------------------------

export const PLAN_QA_PRESCREEN_DEFINITION_NAME = "plan-qa-prescreen";
export const PLAN_QA_PRESCREEN_MODEL_ID = "jev-1.13.0";
/** 질문 묶음의 단일 데이터 정책 목적(정의=1 purpose — 질문마다 개별 정책 불가). */
export const PLAN_QA_PRESCREEN_PURPOSE = "plan-qa-prescreen-observation";
const PLAN_QA_PRESCREEN_VERSION = 1;

/**
 * [목적] plan-qa-prescreen 정의 스냅샷. state 조립 규칙을 stateAssembly.notes 에 문서화한다.
 *   thresholds({ overall_confidence_min: 0.6 })는 메모용 — 섀도 파일럿은 실행에 이를 쓰지 않는다.
 */
export function buildPlanQaPrescreenDefinition(): JudgmentDefinitionSnapshot {
  return {
    description:
      "PLAN-QA 사전 스크리닝(섀도 관측 파일럿) — 계획 원문만 보고 전체 QA 생략 가능성에 대한 권고를 묻는다. " +
      "결과는 judgment_calls 에만 기록되며 어떤 판정·상태·이슈도 변경하지 않는다.",
    // 하나의 정의 = 하나의 purpose. 이 묶음의 3질문은 같은 state/같은 데이터 정책을 공유한다.
    purpose: PLAN_QA_PRESCREEN_PURPOSE,
    stateAssembly: {
      kind: "inline-ref",
      notes:
        "state = { plan: mission_plan_artifacts 원문(revision/missionGoal/refs/assumptions/" +
        "requiredInputs/successCriteria/risks/steps), quality_contract: verdict.qualityContract, " +
        "mission: {id,title,status} }. 계획 작성자·리뷰어의 자기 평가 문구(verdict 값, diagnostics, " +
        "이슈 코멘트)는 state 에서 제외 — 원문·계약·메타만 전달한다(자기 평가에 대한 편향 방지).",
    },
    questions: [
      {
        name: "overall",
        type: "choice",
        instructions: "state의 plan 을 보고 사전스크리닝하세요.",
        criteria: {
          low_risk: "계획이 명확·저위험으로 전체 QA 없이 진행 가능해 보임",
          needs_full_qa: "불확실·고위험 신호가 있어 전체 QA 필요",
          insufficient_evidence: "근거 부족으로 판단 불가",
        },
      },
      {
        name: "steps_have_verification",
        type: "noul",
        instructions: "계획의 각 단계가 완료/검증 방법을 서술하고 있는가",
        criteria: {
          true: "각 단계가 완료/검증 방법을 서술함",
          false: "검증 방법이 없거나 불완전한 단계가 있음",
        },
      },
      {
        name: "requirements_covered",
        type: "noul",
        instructions: "quality_contract 의 요구사항이 계획에 모두 반영되었는가",
        criteria: {
          true: "요구사항이 모두 반영됨",
          false: "반영되지 않은 요구사항이 있음",
        },
      },
    ],
    policy: {
      notes:
        "섀도 관측 파일럿 — 결과는 실행에 반영되지 않는다. thresholds 는 메모용이며 " +
        "판단 계층 파이프라인이 이를 강제하지 않는다.",
      thresholds: { overall_confidence_min: 0.6 },
    },
  };
}

/**
 * [목적] ensurePlanQaPrescreenDefinition — 회사별 활성 정의 보장(idempotent).
 *   활성 정의가 있으면 아무 것도 하지 않고, 없으면 v1 을 insert(onConflictDoNothing —
 *   (companyId,name,version) 유니크). 이미 v1 이 비활성으로 존재하면 만들지 않는다(수정 금지 원칙).
 * [출력] { ensured: boolean } — 이 호출로 정의가 새로 만들어졌으면 true.
 */
export async function ensurePlanQaPrescreenDefinition(
  db: Db,
  companyId: string,
): Promise<{ ensured: boolean }> {
  const [existing] = await db
    .select({ id: judgmentDefinitions.id })
    .from(judgmentDefinitions)
    .where(
      and(
        eq(judgmentDefinitions.companyId, companyId),
        eq(judgmentDefinitions.name, PLAN_QA_PRESCREEN_DEFINITION_NAME),
        eq(judgmentDefinitions.isActive, true),
      ),
    )
    .limit(1);
  if (existing) return { ensured: false };

  const inserted = await db
    .insert(judgmentDefinitions)
    .values({
      companyId,
      name: PLAN_QA_PRESCREEN_DEFINITION_NAME,
      version: PLAN_QA_PRESCREEN_VERSION,
      isActive: true,
      providerId: "typesafe",
      modelId: PLAN_QA_PRESCREEN_MODEL_ID,
      definition: buildPlanQaPrescreenDefinition(),
    })
    .onConflictDoNothing({
      target: [
        judgmentDefinitions.companyId,
        judgmentDefinitions.name,
        judgmentDefinitions.version,
      ],
    })
    .returning({ id: judgmentDefinitions.id });
  return { ensured: inserted.length > 0 };
}

/**
 * [목적] seedPlanQaPrescreenDefinitions — 전 회사(또는 지정 1사)에 대해 활성 정의 보장.
 *   루프 시작 시 1회 호출. 이미 활성 정의가 있는 회사는 건드리지 않는다.
 * [출력] { companies, seeded } — 점검한 회사 수 / 새로 만든 정의 수.
 */
export async function seedPlanQaPrescreenDefinitions(
  db: Db,
  options: { companyId?: string } = {},
): Promise<{ companies: number; seeded: number }> {
  const rows = options.companyId
    ? [{ id: options.companyId }]
    : await db.select({ id: companies.id }).from(companies);
  let seeded = 0;
  for (const row of rows) {
    const result = await ensurePlanQaPrescreenDefinition(db, row.id);
    if (result.ensured) seeded += 1;
  }
  return { companies: rows.length, seeded };
}

// ---------------------------------------------------------------------------
// state 조립 — 계획 원문 + 품질 계약 + 미션 메타. 자기 평가 문구 제외.
// ---------------------------------------------------------------------------

type MissionPlanArtifactRow = typeof missionPlanArtifacts.$inferSelect;

/**
 * [목적] assemblePlanQaShadowState — verdict 에서 판단용 "근거 묶음" state 를 만든다.
 *   포함: plan(계획 원문 전체 — revision/missionGoal/refs/assumptions/requiredInputs/
 *   successCriteria/risks/steps), quality_contract(verdict.qualityContract), mission 메타.
 *   제외: verdict 값·diagnostics·리뷰어 정보·이슈 코멘트 등 계획 작성자/리뷰어의 자기 평가 —
 *   모델이 계획 원문 자체만 보고 판단하게 한다.
 * [입력] artifact 는 verdict.missionPlanArtifactId 로 조회한 원본 행.
 */
export function assemblePlanQaShadowState(
  artifact: MissionPlanArtifactRow,
  qualityContract: Record<string, unknown> | null,
  mission: { id: string; title: string; status: string },
): Record<string, unknown> {
  return {
    plan: {
      revision: artifact.revision,
      status: artifact.status,
      missionGoal: artifact.missionGoal,
      refs: artifact.refs,
      assumptions: artifact.assumptions,
      requiredInputs: artifact.requiredInputs,
      successCriteria: artifact.successCriteria,
      risks: artifact.risks,
      steps: artifact.steps,
    },
    quality_contract: qualityContract,
    mission: { id: mission.id, title: mission.title, status: mission.status },
  };
}

// ---------------------------------------------------------------------------
// 1회 패스 — 미관측 verdict 조회 → state 조립 → askJudgment(감사행만).
// ---------------------------------------------------------------------------

const SCAN_WINDOW_CAP = 500;

export interface PlanQaShadowPassOptions {
  maxPerTick?: number;
  lookbackDays?: number;
  now?: Date;
  /** 테스트 주입용 judgment 서비스. 기본 createJudgmentService(db). */
  service?: JudgmentService;
}

export interface PlanQaShadowPassResult {
  /** 관측 창에서 읽은 verdict 수(스캔 상한 적용). */
  scanned: number;
  /** askJudgment 를 시도한 verdict 수. */
  processed: number;
  /** 감사행(judgment_calls)이 실제로 기록된 수. */
  recorded: number;
  /** 원문 부족(artifact null/missing) 등으로 건너뛴 수. */
  skipped: number;
}

function correlationKeyFor(verdictId: string): string {
  return `mission_plan_qa:${verdictId}`;
}

/**
 * [목적] runPlanQaShadowPass — 섀도 관측 1틱. 미관측 verdict 을 최대 maxPerTick 건 처리.
 *   결과는 askJudgment 가 남기는 judgment_calls 감사행뿐 — 어떤 판정·상태·이슈도 변경 금지.
 *   provider 실패 시에도 error 감사행이 남아(정의가 있는 한) 다음 틱은 다른 verdict 로 진행한다.
 *   정의 부족(no_active_definition)은 감사행이 못 남으므로 회사별 on-demand seed 후 1회 재시도.
 */
export async function runPlanQaShadowPass(
  db: Db,
  options: PlanQaShadowPassOptions = {},
): Promise<PlanQaShadowPassResult> {
  const log = defaultLogger;
  const now = options.now ?? new Date();
  const maxPerTick = options.maxPerTick ?? 3;
  const lookbackDays = options.lookbackDays ?? 7;
  const cutoff = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  const candidates = await db
    .select()
    .from(missionPlanQaVerdicts)
    .where(gte(missionPlanQaVerdicts.createdAt, cutoff))
    .orderBy(asc(missionPlanQaVerdicts.createdAt))
    .limit(SCAN_WINDOW_CAP);

  if (candidates.length === 0) {
    return { scanned: 0, processed: 0, recorded: 0, skipped: 0 };
  }

  const existing = await db
    .select({ correlationKey: judgmentCalls.correlationKey })
    .from(judgmentCalls)
    .where(
      inArray(
        judgmentCalls.correlationKey,
        candidates.map((verdict) => correlationKeyFor(verdict.id)),
      ),
    );
  const done = new Set(existing.map((row) => row.correlationKey));
  const pendingAll = candidates.filter((verdict) => !done.has(correlationKeyFor(verdict.id)));
  // 관측 가능(원문 있음) verdict 을 먼저 처리한다. 원문 없는 verdict 은 영구 관측 불능이므로
  // 큐 앞쪽에 있으면 뒤의 관측 가능 건을 굶기게 한다 — null-artifact 는 맨 뒤로.
  const pending = [
    ...pendingAll.filter((verdict) => verdict.missionPlanArtifactId !== null),
    ...pendingAll.filter((verdict) => verdict.missionPlanArtifactId === null),
  ];

  const result: PlanQaShadowPassResult = {
    scanned: candidates.length,
    processed: 0,
    recorded: 0,
    skipped: 0,
  };
  if (pending.length === 0) return result;

  const service = options.service ?? createJudgmentService(db);

  for (const verdict of pending.slice(0, maxPerTick)) {
    if (!verdict.missionPlanArtifactId) {
      result.skipped += 1;
      log.warn(
        { verdictId: verdict.id, missionId: verdict.missionId },
        "plan-qa shadow: verdict has no plan artifact — skipping observation",
      );
      continue;
    }

    const [artifact] = await db
      .select()
      .from(missionPlanArtifacts)
      .where(eq(missionPlanArtifacts.id, verdict.missionPlanArtifactId))
      .limit(1);
    if (!artifact) {
      result.skipped += 1;
      log.warn(
        { verdictId: verdict.id, artifactId: verdict.missionPlanArtifactId },
        "plan-qa shadow: plan artifact not found — skipping observation",
      );
      continue;
    }

    const [mission] = await db
      .select({ id: missions.id, title: missions.title, status: missions.status })
      .from(missions)
      .where(eq(missions.id, verdict.missionId))
      .limit(1);

    const state = assemblePlanQaShadowState(
      artifact,
      verdict.qualityContract ?? null,
      mission ?? { id: verdict.missionId, title: "", status: "unknown" },
    );

    let askResult = await service.askJudgment({
      companyId: verdict.companyId,
      definitionName: PLAN_QA_PRESCREEN_DEFINITION_NAME,
      contextType: "mission_plan_qa",
      contextId: verdict.id,
      mode: "observed",
      state,
    });
    // 정의 부족은 감사행을 남길 수 없다 — 회사별 idempotent seed 후 1회만 재시도.
    if (askResult.status === "error" && askResult.error === "no_active_definition") {
      const seeded = await ensurePlanQaPrescreenDefinition(db, verdict.companyId);
      if (seeded.ensured) {
        askResult = await service.askJudgment({
          companyId: verdict.companyId,
          definitionName: PLAN_QA_PRESCREEN_DEFINITION_NAME,
          contextType: "mission_plan_qa",
          contextId: verdict.id,
          mode: "observed",
          state,
        });
      }
    }

    result.processed += 1;
    if (askResult.auditId) {
      result.recorded += 1;
    } else {
      log.error(
        { verdictId: verdict.id, error: askResult.error },
        "plan-qa shadow: observation left no audit row",
      );
    }
    if (askResult.status === "error") {
      log.warn(
        { verdictId: verdict.id, error: askResult.error, message: askResult.message },
        "plan-qa shadow: judgment call failed — audit row recorded, continuing",
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// createPlanQaShadowLoop — agent-skill-optimizer(createAgentWikiEvolutionLoop) 미러.
// ---------------------------------------------------------------------------

const DEFAULT_SHADOW_INTERVAL_MS = 10 * 60_000; // 10분

export interface PlanQaShadowLoopState {
  running: boolean;
  tickCount: number;
  lastTickAt: string | null;
  lastResult: PlanQaShadowPassResult | null;
  lastError: string | null;
  /** 루프 시작 시 1회 실행한 정의 seed 결과. */
  seed: { companies: number; seeded: number } | null;
}

export interface PlanQaShadowLoop {
  start: () => void;
  stop: () => void;
  /** 1틱 수동 실행(테스트/운영 점검용). */
  observe: (now?: Date) => Promise<void>;
  getState: () => PlanQaShadowLoopState;
}

export interface CreatePlanQaShadowLoopOptions {
  db: Db;
  intervalMs?: number;
  /** env 오버라이드 주입용(테스트). 기본 process.env. */
  env?: Record<string, string | undefined>;
  service?: JudgmentService;
  runPass?: (db: Db, options?: PlanQaShadowPassOptions) => Promise<PlanQaShadowPassResult>;
}

/**
 * [목적] createPlanQaShadowLoop — 섀도 관측 주기 루프. setInterval + tickInFlight 가드 +
 *   unref + per-tick try/catch. start 시 정의 seed 1회 + 즉시 1틱 후 interval arm(idempotent).
 * [주의] PAPERCLIP_JUDGMENT_ENABLED off 시 app.ts 가 이 팩터리를 호출하지 않아 완전 inert.
 */
export function createPlanQaShadowLoop(options: CreatePlanQaShadowLoopOptions): PlanQaShadowLoop {
  const intervalMs = options.intervalMs ?? DEFAULT_SHADOW_INTERVAL_MS;
  const config = resolvePlanQaShadowConfig(options.env ?? process.env);
  const runPass = options.runPass ?? runPlanQaShadowPass;
  const log = defaultLogger;

  let interval: ReturnType<typeof setInterval> | null = null;
  let tickInFlight = false;
  let tickCount = 0;
  let lastTickAt: string | null = null;
  let lastResult: PlanQaShadowPassResult | null = null;
  let lastError: string | null = null;
  let seed: { companies: number; seeded: number } | null = null;
  let seededOnce = false;

  async function observe(now = new Date()): Promise<void> {
    if (!seededOnce) {
      // 리컨사일러 시작 1회: 전 회사 정의 seed(idempotent — 이미 있으면 no-op).
      seededOnce = true;
      try {
        seed = await seedPlanQaPrescreenDefinitions(options.db);
        if (seed.seeded > 0) {
          log.info({ ...seed }, "plan-qa shadow: seeded plan-qa-prescreen definitions");
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        log.error({ err: lastError }, "plan-qa shadow: definition seeding failed at loop start");
      }
    }
    if (tickInFlight) {
      log.warn({ intervalMs }, "plan-qa shadow tick skipped — previous tick still running");
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
        log.info({ intervalMs, ...passResult }, "plan-qa shadow pass completed");
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      log.error({ intervalMs, err: lastError }, "plan-qa shadow tick failed");
    } finally {
      tickInFlight = false;
    }
  }

  return {
    start() {
      if (interval) return;
      log.info({ intervalMs, ...config }, "plan-qa shadow loop started");
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
      log.info({ intervalMs }, "plan-qa shadow loop stopped");
    },
    observe,
    getState() {
      return { running: interval !== null, tickCount, lastTickAt, lastResult, lastError, seed };
    },
  };
}

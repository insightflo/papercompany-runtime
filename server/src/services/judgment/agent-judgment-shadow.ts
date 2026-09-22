// server/src/services/judgment/agent-judgment-shadow.ts
//
// [파일 목적] Jev agent-judgment 섀도 캘리브레이션(v2) — 생산 판단 감사행(definition name
//   "agent-judgment")을 대상으로 "v2 판단(계산형 verdict + 축약 입력)이 같은 맥락에서 어떤
//   등급을 냈을까"를 사후 질문하고 결과를 judgment_calls 감사행에만 기록한다(순수 관측).
// [안전 경계] 별도 정의 이름 "agent-judgment-shadow" — 생산 소비자(name "agent-judgment" 조회
//   경로)가 섀도 행을 절대 읽지 못한다. 스키마·라우트·app.ts 무수정.
// [틱 동작] 최근 N일 v1 행(contextType "workflow_step" · outcome "observed")을 createdAt
//   asc·스캔 상한 500으로 읽고 contextId별 최신 1건만 리플레이. dedupe = 같은 correlationKey
//   ("workflow_step:" + contextId)의 섀도 행 존재 시 skip. plan-qa 미러.

import { and, asc, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, judgmentCalls, judgmentDefinitions } from "@paperclipai/db";
import type { JudgmentDefinitionSnapshot, JudgmentQuestion } from "@paperclipai/shared";
import { logger as defaultLogger } from "../../middleware/logger.js";
import { createJudgmentService, type JudgmentService } from "./judgment-service.js";
import { AGENT_JUDGMENT_DEFINITION_NAME } from "./agent-judgment-tool.js";
import {
  AGENT_SHADOW_CONF_FLOOR_DEFAULT,
  assembleAgentJudgmentShadowState,
  type AgentShadowState,
} from "./agent-judgment-shadow-state.js";

export const AGENT_JUDGMENT_SHADOW_DEFINITION_NAME = "agent-judgment-shadow";
export const AGENT_JUDGMENT_SHADOW_MODEL_ID = "jev-1.13.0";
/** 질문 묶음의 단일 데이터 정책 목적(정의=1 purpose). */
export const AGENT_JUDGMENT_SHADOW_PURPOSE = "agent-branch-prescreen-observation";

const AGENT_JUDGMENT_SHADOW_DEFINITION_VERSION = 1;
const AGENT_SHADOW_SCAN_WINDOW_CAP = 500;
/**
 * [목적] v2 질문 — noul 2개뿐, overall choice 없음(모델 추정 등급 제거가 핵심).
 *   최종 등급은 computeAgentJudgmentShadowVerdict 가 코드로 계산한다. criteria 문구는
 *   Round A 브리프 지정 문구를 그대로 쓴다.
 */
export function buildShadowJudgmentQuestions(): JudgmentQuestion[] {
  return [
    {
      name: "complete_html",
      type: "noul",
      instructions: "state의 document_text/structure_stats 를 보고 판단하세요.",
      criteria: {
        true: "HTML이 완전하고 깨진 마크업·빈 섹션·자리표시자 없이 게시 가능하다",
        false: "깨진 마크업·빈 섹션·자리표시자 등 게시 부적합 결함이 있다",
      },
    },
    {
      name: "claims_grounded",
      type: "noul",
      instructions: "state의 document_text 를 근거로 판단하세요.",
      criteria: {
        true: "내용의 주장이 근거와 연결되어 있고 근거 없는 단정이 없다",
        false: "근거 없는 단정이나 근거와 연결되지 않은 주장이 있다",
      },
    },
  ];
}

/**
 * [목적] agent-judgment-shadow 정의 스냅샷. stateAssembly.notes 에 축약 조립 규칙
 *   (document_text + structure_stats, 원문 미전송)을 문서화한다. thresholds 는 메모용.
 */
export function buildAgentJudgmentShadowDefinition(): JudgmentDefinitionSnapshot {
  return {
    description:
      "Jev agent-judgment 섀도 캘리브레이션(v2) — 생산 판단 감사행을 축약 입력으로 사후 " +
      "재질문해 계산형 verdict 캘리브레이션 데이터를 모은다. 결과는 감사행뿐이다.",
    purpose: AGENT_JUDGMENT_SHADOW_PURPOSE,
    originClass: "internal",
    stateAssembly: {
      kind: "inline-ref",
      notes:
        "state = assembleAgentJudgmentShadowState(inputState.document) — 원문 HTML 은 전송하지 " +
        "않고 document_text(가시 텍스트, 상한 절단) + structure_stats(docChars/textChars/nodeCount)만 전달한다.",
    },
    questions: buildShadowJudgmentQuestions(),
    policy: {
      notes:
        "섀도 관측 파일럿 — 결과는 실행에 반영되지 않는다. thresholds 는 메모용이며 최종 등급은 " +
        "computeAgentJudgmentShadowVerdict 가 코드로 계산한다.",
      thresholds: { noul_confidence_min: AGENT_SHADOW_CONF_FLOOR_DEFAULT },
    },
  };
}

/** [목적] 회사별 활성 정의 보장(idempotent). 이미 있으면 만들지 않는다(수정 금지 원칙). */
export async function ensureAgentJudgmentShadowDefinition(
  db: Db,
  companyId: string,
): Promise<{ ensured: boolean }> {
  const [existing] = await db
    .select({ id: judgmentDefinitions.id })
    .from(judgmentDefinitions)
    .where(and(
      eq(judgmentDefinitions.companyId, companyId),
      eq(judgmentDefinitions.name, AGENT_JUDGMENT_SHADOW_DEFINITION_NAME),
      eq(judgmentDefinitions.isActive, true),
    ))
    .limit(1);
  if (existing) return { ensured: false };
  const inserted = await db.insert(judgmentDefinitions).values({
    companyId,
    name: AGENT_JUDGMENT_SHADOW_DEFINITION_NAME,
    version: AGENT_JUDGMENT_SHADOW_DEFINITION_VERSION,
    isActive: true,
    providerId: "typesafe",
    modelId: AGENT_JUDGMENT_SHADOW_MODEL_ID,
    definition: buildAgentJudgmentShadowDefinition(),
  }).onConflictDoNothing({
    target: [judgmentDefinitions.companyId, judgmentDefinitions.name, judgmentDefinitions.version],
  }).returning({ id: judgmentDefinitions.id });
  return { ensured: inserted.length > 0 };
}

/** [목적] 전 회사(또는 지정 1사) 정의 보장(루프 시작 1회). { companies, seeded }. */
export async function seedAgentJudgmentShadowDefinitions(
  db: Db,
  options: { companyId?: string } = {},
): Promise<{ companies: number; seeded: number }> {
  const rows = options.companyId
    ? [{ id: options.companyId }]
    : await db.select({ id: companies.id }).from(companies);
  let seeded = 0;
  for (const row of rows) {
    const result = await ensureAgentJudgmentShadowDefinition(db, row.id);
    if (result.ensured) seeded += 1;
  }
  return { companies: rows.length, seeded };
}

export interface AgentShadowConfig {
  /** 틱당 최대 관측 건수(PAPERCLIP_JUDGMENT_AGENT_SHADOW_MAX_PER_TICK, 기본 3). */
  maxPerTick: number;
  /** 관측 대상 조회 창(일)(PAPERCLIP_JUDGMENT_AGENT_SHADOW_LOOKBACK_DAYS, 기본 7). */
  lookbackDays: number;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** [목적] 섀도 관측 설정(env 오버라이드). 양의 정수가 아니면 기본값(3/7)으로 폴백. */
export function resolveAgentShadowConfig(
  env: Record<string, string | undefined> = process.env,
): AgentShadowConfig {
  return {
    maxPerTick: parsePositiveInt(env.PAPERCLIP_JUDGMENT_AGENT_SHADOW_MAX_PER_TICK, 3),
    lookbackDays: parsePositiveInt(env.PAPERCLIP_JUDGMENT_AGENT_SHADOW_LOOKBACK_DAYS, 7),
  };
}

export interface AgentShadowPassOptions {
  maxPerTick?: number;
  lookbackDays?: number;
  now?: Date;
  service?: JudgmentService;
}

export interface AgentShadowPassResult {
  /** 관측 창에서 읽은 v1 후보 행 수(스캔 상한 500 적용). */
  scanned: number;
  processed: number;
  recorded: number;
  skipped: number;
}

type AgentShadowCandidate = { companyId: string; contextId: string; inputState: unknown };

function correlationKeyFor(contextId: string): string {
  return "workflow_step:" + contextId;
}

/** inputState(jsonb: string | record | string[])에서 필드 하나를 안전하게 꺼낸다. */
function readStateField(inputState: unknown, key: string): unknown {
  if (typeof inputState !== "object" || inputState === null || Array.isArray(inputState)) return undefined;
  return (inputState as Record<string, unknown>)[key];
}

/** assembleAgentJudgmentShadowState 가 null 을 낼 조건과 동일(관측 가능 판정용). */
function hasUsableDocument(inputState: unknown): boolean {
  const document = readStateField(inputState, "document");
  return typeof document === "string" && document.length > 0;
}

/** askJudgment 호출 인자(초기 호출·재시도가 동일 인자임을 보장). */
function shadowAskInput(candidate: AgentShadowCandidate, state: AgentShadowState) {
  return {
    companyId: candidate.companyId,
    definitionName: AGENT_JUDGMENT_SHADOW_DEFINITION_NAME,
    contextType: "workflow_step" as const,
    contextId: candidate.contextId,
    state,
    questions: buildShadowJudgmentQuestions(),
    mode: "observed" as const,
  };
}

/**
 * [목적] runAgentJudgmentShadowPass — 섀도 리플레이 1패스(감사행만, 상태 변경 없음).
 *   contextId별 최신 v1 행만 입력. state 조립이 null 이면 skipped++(원문 없이 판단 불가).
 *   no_active_definition 시 회사별 seed 후 1회 재시도(plan-qa 미러).
 */
export async function runAgentJudgmentShadowPass(
  db: Db,
  options: AgentShadowPassOptions = {},
): Promise<AgentShadowPassResult> {
  const log = defaultLogger;
  const now = options.now ?? new Date();
  const maxPerTick = options.maxPerTick ?? 3;
  const lookbackDays = options.lookbackDays ?? 7;
  const cutoff = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      companyId: judgmentCalls.companyId,
      contextId: judgmentCalls.contextId,
      inputState: judgmentCalls.inputState,
    })
    .from(judgmentCalls)
    .innerJoin(judgmentDefinitions, eq(judgmentCalls.definitionId, judgmentDefinitions.id))
    .where(and(
      eq(judgmentDefinitions.name, AGENT_JUDGMENT_DEFINITION_NAME),
      eq(judgmentCalls.contextType, "workflow_step"),
      eq(judgmentCalls.outcome, "observed"),
      gte(judgmentCalls.createdAt, cutoff),
    ))
    .orderBy(asc(judgmentCalls.createdAt))
    .limit(AGENT_SHADOW_SCAN_WINDOW_CAP);

  const result: AgentShadowPassResult = { scanned: rows.length, processed: 0, recorded: 0, skipped: 0 };
  if (rows.length === 0) return result;

  // createdAt asc 순회로 덮어쓰면 contextId별 최신 1건만 남는다(최신 승리).
  const latestByContext = new Map<string, AgentShadowCandidate>();
  for (const row of rows) {
    latestByContext.set(row.contextId, {
      companyId: row.companyId, contextId: row.contextId, inputState: row.inputState,
    });
  }

  const correlationKeys = Array.from(latestByContext.keys(), correlationKeyFor);
  const existing = await db
    .select({ correlationKey: judgmentCalls.correlationKey })
    .from(judgmentCalls)
    .innerJoin(judgmentDefinitions, eq(judgmentCalls.definitionId, judgmentDefinitions.id))
    .where(and(
      eq(judgmentDefinitions.name, AGENT_JUDGMENT_SHADOW_DEFINITION_NAME),
      inArray(judgmentCalls.correlationKey, correlationKeys),
    ));
  const done = new Set(existing.flatMap((row) => (row.correlationKey === null ? [] : [row.correlationKey])));

  const pendingAll = Array.from(latestByContext.values())
    .filter((candidate) => !done.has(correlationKeyFor(candidate.contextId)));
  // document 없는 행은 영구 관측 불능 — 큐 앞에 있으면 뒤의 관측 가능 건을 굶기므로 맨 뒤로.
  const pending = [
    ...pendingAll.filter((candidate) => hasUsableDocument(candidate.inputState)),
    ...pendingAll.filter((candidate) => !hasUsableDocument(candidate.inputState)),
  ];
  if (pending.length === 0) return result;
  const service = options.service ?? createJudgmentService(db);
  for (const candidate of pending.slice(0, maxPerTick)) {
    const subjectValue = readStateField(candidate.inputState, "subject");
    const state = assembleAgentJudgmentShadowState(
      readStateField(candidate.inputState, "document"),
      typeof subjectValue === "string" ? subjectValue : undefined,
    );
    if (!state) {
      result.skipped += 1;
      log.warn({ contextId: candidate.contextId, companyId: candidate.companyId },
        "agent-judgment shadow: candidate has no usable document — skipping observation");
      continue;
    }

    let askResult = await service.askJudgment(shadowAskInput(candidate, state));
    // 정의 부족은 감사행을 남길 수 없다 — 회사별 idempotent seed 후 1회만 재시도.
    if (askResult.status === "error" && askResult.error === "no_active_definition") {
      const seeded = await ensureAgentJudgmentShadowDefinition(db, candidate.companyId);
      if (seeded.ensured) {
        askResult = await service.askJudgment(shadowAskInput(candidate, state));
      }
    }

    result.processed += 1;
    if (askResult.auditId) {
      result.recorded += 1;
    } else {
      log.error({ contextId: candidate.contextId, error: askResult.error },
        "agent-judgment shadow: observation left no audit row");
    }
    if (askResult.status === "error") {
      log.warn({ contextId: candidate.contextId, error: askResult.error, message: askResult.message },
        "agent-judgment shadow: judgment call failed — continuing");
    }
  }

  return result;
}

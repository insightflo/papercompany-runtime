/**
 * Agent Fit Evaluator — 에이전트별 실행 프로필 자동 누계 + 임계/모델 계층 제안
 *
 * [설계 배경 2026-08-31] 리서치사 하위 에이전트의 평균 참조 컨텍스트(52만~151만 tok)와
 * 성공률(57~81%)이 반비례하는 컨텍스트 로트 패턴 실측 → 세션 회전 임계 하향(30만) 운영
 * 시작. 임계/모델 계층의 "변동 판단 수치"를 사람이 수동 집계하지 않도록 코어가 자동 계산.
 *
 * [호출 주체] native-scheduler 틱(주기). 런 종료 훅(정산 CAS 최심부)은 건드리지 않는다 —
 * 실패가 런에 절대 영향을 주지 않는 위치에서 관찰만 한다. 신선도는 틱 주기 수준으로
 * 런 종료 후 수 분 이내(실행 요구와 실질 동일).
 *
 * [저장] agents.metadata.fitProfile (jsonb shallow-merge — 형제 키 보존).
 *   metadata는 실행이 defaultParentIssueId 등을 읽는 열이므로 반드시 || 병합으로 쓴다.
 * [스로틀] computedAt 기준 6시간. 데이터 없으면(런<5) 기존 프로필 유지.
 * [소비] 보드 에이전트 상세(Advanced Run Policy 하단 권고 표시) + API.
 *   제안일 뿐 — 실제 임계/모델 변경은 항상 사람이 승인한다.
 */

import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";

export const AGENT_FIT_WINDOW_DAYS = 14;
export const AGENT_FIT_MIN_RUNS = 5;
export const AGENT_FIT_REFRESH_INTERVAL_MS = 10 * 60_000;
const AGENT_FIT_PROFILE_TTL_MS = 6 * 60 * 60_000;
const DEFAULT_SESSION_THRESHOLD_TOKENS = 2_000_000;

/** claude/codex/hermes_local 은 어댑터 자체 컨텍스트 관리 — 런타임이 세션을 회전하지 않는다. */
const ADAPTER_MANAGED_SESSION_TYPES = new Set(["claude_local", "codex_local", "hermes_local"]);

export interface AgentFitThresholdVerdict {
  verdict: "raise" | "raise_borderline" | "keep" | "keep_info" | "na";
  reason: string;
  suggestedTokens: number | null;
}

export interface AgentFitModelVerdict {
  verdict: "up" | "down" | "keep" | "keep_flag";
  reasons: string[];
}

export interface AgentFitProfile {
  version: 1;
  computedAt: string;
  windowDays: number;
  runs: number;
  okPct: number;
  avgRawInTokens: number;
  p90RawInTokens: number;
  floorRawInTokens: number;
  sessions: number;
  costUsd: number;
  costSharePct: number | null;
  avgRunMin: number;
  model: string;
  adapterType: string;
  sessionThresholdTokens: number;
  thresholdVerdict: AgentFitThresholdVerdict;
  modelVerdict: AgentFitModelVerdict;
}

interface AgentFitRow {
  id: string;
  name: string;
  adapterType: string;
  model: string;
  threshold: number;
  runs: number;
  sessions: number;
  floorTok: number;
  p50Tok: number;
  p90Tok: number;
  avgTok: number;
  okPct: number;
  usd: number;
  avgMin: number;
  computedAtMs: number | null;
}

function roundUpTo(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

export function recommendSessionThreshold(input: {
  adapterType: string;
  threshold: number;
  floorTok: number;
  p50Tok: number;
  p90Tok: number;
  runs: number;
  sessions: number;
}): AgentFitThresholdVerdict {
  if (ADAPTER_MANAGED_SESSION_TYPES.has(input.adapterType)) {
    return {
      verdict: "na",
      reason: `${input.adapterType} manages context natively — runtime never rotates its sessions; threshold is not applicable.`,
      suggestedTokens: null,
    };
  }
  const t = input.threshold;
  const rotationRatio = input.sessions / Math.max(input.runs, 1);
  if (input.floorTok >= 0.8 * t) {
    return {
      verdict: "raise",
      reason: `Fresh-session floor (${input.floorTok.toLocaleString("en-US")}) is ≥80% of threshold (${t.toLocaleString("en-US")}) — near-every-run rotation; handoff cost repeats.`,
      suggestedTokens: roundUpTo(input.floorTok * 1.5, 10_000),
    };
  }
  if (input.p90Tok >= t && rotationRatio >= 0.5) {
    return {
      verdict: "raise_borderline",
      reason: `p90 (${input.p90Tok.toLocaleString("en-US")}) ≥ threshold with session churn ${Math.round(rotationRatio * 100)}%.`,
      suggestedTokens: roundUpTo(input.p90Tok * 1.1, 10_000),
    };
  }
  if (input.p90Tok > t * 1.5) {
    return {
      verdict: "keep_info",
      reason: `p90 (${input.p90Tok.toLocaleString("en-US")}) > 1.5× threshold — single-run intra-session growth; run splitting, not a threshold fix.`,
      suggestedTokens: null,
    };
  }
  return {
    verdict: "keep",
    reason: `Healthy: floor ${input.floorTok.toLocaleString("en-US")} / p50 ${input.p50Tok.toLocaleString("en-US")} / p90 ${input.p90Tok.toLocaleString("en-US")} vs threshold ${t.toLocaleString("en-US")}.`,
    suggestedTokens: null,
  };
}

export function recommendModelTier(input: {
  runs: number;
  okPct: number;
  avgTok: number;
  avgMin: number;
  costSharePct: number | null;
}): AgentFitModelVerdict {
  const reasons: string[] = [];
  if (input.okPct >= 95 && input.avgMin <= 1 && input.runs >= 20 && input.avgTok <= 100_000) {
    reasons.push(`Simple repetitive profile (ok ${Math.round(input.okPct)}%, avg ${input.avgMin}min, ${input.runs} runs) — lightweight tier candidate.`);
    return { verdict: "down", reasons };
  }
  if (input.okPct <= 80 && input.runs >= 10) {
    if (input.avgTok >= 500_000) {
      reasons.push(`Low success (${Math.round(input.okPct)}%) with large context (${Math.round(input.avgTok / 1000)}K tok) — optimize sessions before judging the model.`);
      return { verdict: "keep_flag", reasons };
    }
    reasons.push(`Low success (${Math.round(input.okPct)}%) with normal context — model capability suspect; tier-up candidate.`);
    return { verdict: "up", reasons };
  }
  if (input.costSharePct !== null && input.costSharePct >= 30) {
    reasons.push(`Cost concentration (${Math.round(input.costSharePct)}% of fleet) — periodic review regardless of tier.`);
    return { verdict: "keep_flag", reasons };
  }
  reasons.push(`Stable profile (ok ${Math.round(input.okPct)}%, avg ${Math.round(input.avgTok / 1000)}K tok).`);
  return { verdict: "keep", reasons };
}

async function loadAgentFitRows(db: Db, now: Date): Promise<AgentFitRow[]> {
  const result = await db.execute(sql`
    SELECT a.id, a.name, a.adapter_type AS "adapterType",
           COALESCE(a.adapter_config->>'model', '-') AS "model",
           COALESCE((a.runtime_config->'heartbeat'->'sessionCompaction'->>'maxRawInputTokens')::bigint, ${DEFAULT_SESSION_THRESHOLD_TOKENS}) AS "threshold",
           count(*) AS runs,
           count(DISTINCT h.session_id_after) AS sessions,
           min((h.usage_json->>'rawInputTokens')::bigint) AS "floorTok",
           (percentile_cont(0.5) WITHIN GROUP (ORDER BY (h.usage_json->>'rawInputTokens')::bigint))::bigint AS "p50Tok",
           (percentile_cont(0.9) WITHIN GROUP (ORDER BY (h.usage_json->>'rawInputTokens')::bigint))::bigint AS "p90Tok",
           avg((h.usage_json->>'rawInputTokens')::bigint)::bigint AS "avgTok",
           round(100.0 * count(*) FILTER (WHERE h.status = 'succeeded') / greatest(count(*), 1)) AS "okPct",
           COALESCE(round(sum(COALESCE((h.usage_json->>'costUsd')::numeric, 0)), 2), 0)::float8 AS usd,
           round(avg(EXTRACT(EPOCH FROM (h.finished_at - h.started_at))) / 60.0, 1)::float8 AS "avgMin",
           (a.metadata->'fitProfile'->>'computedAt')::timestamptz AS "computedAt"
    FROM heartbeat_runs h
    JOIN agents a ON a.id = h.agent_id
    WHERE h.started_at >= now() - (${`${AGENT_FIT_WINDOW_DAYS} days`}::interval)
      AND h.usage_json IS NOT NULL
    GROUP BY a.id, a.name, a.adapter_type, a.adapter_config, a.runtime_config, a.metadata
    HAVING count(*) >= ${AGENT_FIT_MIN_RUNS}
  `);
  const rows = (result as unknown as { rows?: Record<string, unknown>[] }).rows ?? (result as unknown as Record<string, unknown>[]);
  const nowMs = now.getTime();
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    adapterType: String(row.adapterType),
    model: String(row.model),
    threshold: Number(row.threshold),
    runs: Number(row.runs),
    sessions: Number(row.sessions),
    floorTok: Number(row.floorTok ?? 0),
    p50Tok: Number(row.p50Tok ?? 0),
    p90Tok: Number(row.p90Tok ?? 0),
    avgTok: Number(row.avgTok ?? 0),
    okPct: Number(row.okPct ?? 0),
    usd: Number(row.usd ?? 0),
    avgMin: Number(row.avgMin ?? 0),
    computedAtMs: row.computedAt ? new Date(String(row.computedAt)).getTime() : null,
  }));
}

export async function buildAgentFitProfile(
  row: AgentFitRow,
  fleetCostUsd: number,
  now: Date,
): Promise<AgentFitProfile> {
  const costSharePct = fleetCostUsd > 0 ? Math.round((row.usd / fleetCostUsd) * 100) : null;
  return {
    version: 1,
    computedAt: now.toISOString(),
    windowDays: AGENT_FIT_WINDOW_DAYS,
    runs: row.runs,
    okPct: row.okPct,
    avgRawInTokens: row.avgTok,
    p90RawInTokens: row.p90Tok,
    floorRawInTokens: row.floorTok,
    sessions: row.sessions,
    costUsd: row.usd,
    costSharePct,
    avgRunMin: row.avgMin,
    model: row.model,
    adapterType: row.adapterType,
    sessionThresholdTokens: row.threshold,
    thresholdVerdict: recommendSessionThreshold({
      adapterType: row.adapterType,
      threshold: row.threshold,
      floorTok: row.floorTok,
      p50Tok: row.p50Tok,
      p90Tok: row.p90Tok,
      runs: row.runs,
      sessions: row.sessions,
    }),
    modelVerdict: recommendModelTier({
      runs: row.runs,
      okPct: row.okPct,
      avgTok: row.avgTok,
      avgMin: row.avgMin,
      costSharePct,
    }),
  };
}

/**
 * Refresh stale agent fit profiles (metadata shallow-merge). Failure per agent is
 * swallowed (logged by caller) — this observation lane must never break anything.
 */
export async function refreshAgentFitProfiles(
  db: Db,
  options: { now?: Date } = {},
): Promise<{ updatedCount: number; skippedFreshCount: number }> {
  const now = options.now ?? new Date();
  const rows = await loadAgentFitRows(db, now);
  const fleetCostUsd = rows.reduce((sum, row) => sum + row.usd, 0);
  let updatedCount = 0;
  let skippedFreshCount = 0;

  for (const row of rows) {
    if (row.computedAtMs !== null && now.getTime() - row.computedAtMs < AGENT_FIT_PROFILE_TTL_MS) {
      skippedFreshCount += 1;
      continue;
    }
    try {
      const profile = await buildAgentFitProfile(row, fleetCostUsd, now);
      // metadata 병합: 실행이 읽는 형제 키(defaultParentIssueId 등) 절대 손상 금지.
      await db
        .update(agents)
        .set({
          metadata: sql`coalesce(${agents.metadata}, '{}'::jsonb) || ${JSON.stringify({ fitProfile: profile })}::jsonb`,
        })
        .where(sql`${agents.id} = ${row.id}`);
      updatedCount += 1;
    } catch {
      // observation lane: 개별 에이전트 실패는 건너뛰고 계속
    }
  }
  return { updatedCount, skippedFreshCount };
}

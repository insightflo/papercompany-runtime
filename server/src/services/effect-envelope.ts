// server/src/services/effect-envelope.ts
//
// [effect envelope] 되돌릴 수 없거나 비용 있는 외부 효과의 이중 실행 방지 표준 헬퍼.
//   원칙(로드맵 3/5): 비용/불가역성 기준 선별 — 전면 장부화 불필요. DB 내 상태 쓰기는
//   기존 CAS 펜싱(#277/#278)이 담당하고, 여기는 DB 밖으로 나가는 효과만 다룬다.
//
// 계약:
//   1. 효과 실행 전 recordEffectIntent 로 내구 intent 를 남긴다(effect_id 자연키).
//   2. effect_id = 해시(company + effect_kind + anchor + generation + params_hash).
//      - anchor: 논리 발주 정체성(중복 디스패치 간 안정, 감독 재파견은 wakeReason 등으로 갱신)
//      - generation: 공인 재시도 세대(process-loss retry, fallback, 워크플로우 실행 세대)
//      - params: 효과 실행 설정(세션 상태 제외 — 회전은 효과 정체성이 아니다)
//   3. executeFencedEffect 는 intent 소유자만 실행하고, 실행 후 CAS(intent→applied) 로 표기한다.
//   4. 동일 effect_id 에 applied 혹은 타 시도의 미해결 intent 가 있으면 skipped_replay 를
//      반환한다(로그 "fenced effect replay skipped"). 호출자는 실패 종결로 이어야 한다(fail-closed).
//      자동 재시도/폴백은 세대를 갱신하는 공인 경로만 허용한다.
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { effectIntents, heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export const HEARTBEAT_ADAPTER_EXECUTE_EFFECT_KIND = "heartbeat.adapter_execute";

export type EffectEnvelopeScopeMap = Record<string, string | number | boolean | null | undefined>;

export type EffectEnvelopeKeys = {
  effectId: string;
  anchorKey: string;
  generationKey: string;
  paramsHash: string;
};

export type EffectEnvelopeKeyInput = {
  companyId: string;
  effectKind: string;
  anchor: EffectEnvelopeScopeMap;
  generation: EffectEnvelopeScopeMap;
  params: unknown;
};

export type RecordEffectIntentInput = EffectEnvelopeKeyInput & {
  attemptRunId: string;
};

export type RecordEffectIntentResult = EffectEnvelopeKeys & {
  inserted: boolean;
  row: typeof effectIntents.$inferSelect;
};

export type FencedEffectResult<T> =
  | { outcome: "executed"; value: T; effectId: string }
  | {
      outcome: "skipped_replay";
      effectId: string;
      status: "intent" | "applied";
      attemptRunId: string | null;
    };

export type ExecuteFencedEffectInput<T> = RecordEffectIntentInput & {
  execute: () => Promise<T>;
  resultSummary?: Record<string, unknown>;
};

/** 키 순서와 무관한 정규화 JSON — 자연키의 결정성을 보장한다. */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`);
  return `{${entries.join(",")}}`;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** effect_id 자연키와 구성 증빙(anchor/generation/params) 키를 계산한다. */
export function computeEffectEnvelopeKeys(input: EffectEnvelopeKeyInput): EffectEnvelopeKeys {
  const anchorKey = canonicalStringify(input.anchor);
  const generationKey = canonicalStringify(input.generation);
  const paramsHash = sha256Hex(canonicalStringify(input.params));
  const effectId = sha256Hex(
    canonicalStringify({
      companyId: input.companyId,
      effectKind: input.effectKind,
      anchorKey,
      generationKey,
      paramsHash,
    }),
  );
  return { effectId, anchorKey, generationKey, paramsHash };
}

function readNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * 디스패치 서수 — 같은 앵커(에이전트+이슈/태스크키)로 지금까지 생성된 런 수 + 1.
 * 런 생성 트랜잭션 안에서 호출해 contextSnapshot.dispatchGeneration 으로 스탬프한다.
 * 순차적 의도적 재디스패치는 항상 새 서수(새 세대)로 실행되고, 동시 중복 디스패치는
 * 서로 커밋 전을 관측해 같은 서수를 받아 펜스된다. 이슈 스코프 깨움은 이슈 행
 * FOR UPDATE 직렬화 안에서 호출된다(비직렬 경로의 좁은 허위 양성 창은 계획 문서 참조).
 */
export async function resolveNextDispatchGeneration(
  db: Db,
  input: { agentId: string; issueId?: string | null; taskKey?: string | null },
): Promise<number> {
  const anchorIssueId = readNonEmpty(input.issueId);
  const anchorTaskKey = readNonEmpty(input.taskKey);
  if (!anchorIssueId && !anchorTaskKey) return 1;
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.agentId, input.agentId),
        anchorIssueId
          ? eq(heartbeatRuns.issueId, anchorIssueId)
          : sql`${heartbeatRuns.contextSnapshot}->>'taskKey' = ${anchorTaskKey}`,
      ),
    );
  return (row?.count ?? 0) + 1;
}

/** 효과 실행 전 내구 intent 기록. 같은 effect_id 가 이미 있으면 기존 행을 그대로 돌려준다. */
export async function recordEffectIntent(
  db: Db,
  input: RecordEffectIntentInput,
): Promise<RecordEffectIntentResult> {
  const keys = computeEffectEnvelopeKeys(input);
  const inserted = await db
    .insert(effectIntents)
    .values({
      companyId: input.companyId,
      effectKind: input.effectKind,
      effectId: keys.effectId,
      anchorKey: keys.anchorKey,
      generationKey: keys.generationKey,
      paramsHash: keys.paramsHash,
      status: "intent",
      attemptRunId: input.attemptRunId,
    })
    .onConflictDoNothing({ target: effectIntents.effectId })
    .returning();
  const [existing] = inserted.length > 0
    ? inserted
    : await db.select().from(effectIntents).where(eq(effectIntents.effectId, keys.effectId)).limit(1);
  if (!existing) {
    // fail-closed: 삽입 충돌 후에도 행이 없으면 장부가 깨진 것이다 — 실행 없이 예외로 종결.
    throw new Error(`effect intent ledger inconsistent for effect_id=${keys.effectId}`);
  }
  return { ...keys, inserted: inserted.length > 0, row: existing };
}

/**
 * 펜스된 효과 실행. intent 소유자만 execute 를 호출하고, 성공 시 CAS 로 applied 표기한다.
 * 동일 effect_id 가 이미 applied 이거나 타 시도의 미해결 intent 이면 실행 없이 skipped_replay.
 * execute 가 던지면 intent 는 미해결로 남고 원본 예외가 그대로 전파된다(공인 재시도 경로가
 * 새 세대로 진입할 수 있다).
 */
export async function executeFencedEffect<T>(
  db: Db,
  input: ExecuteFencedEffectInput<T>,
): Promise<FencedEffectResult<T>> {
  const intent = await recordEffectIntent(db, input);
  const ownsExecution = intent.row.status === "intent" && intent.row.attemptRunId === input.attemptRunId;
  if (!ownsExecution) {
    logger.warn(
      {
        effectId: intent.effectId,
        effectKind: input.effectKind,
        companyId: input.companyId,
        status: intent.row.status,
        intentAttemptRunId: intent.row.attemptRunId,
        attemptRunId: input.attemptRunId,
      },
      "fenced effect replay skipped",
    );
    return {
      outcome: "skipped_replay",
      effectId: intent.effectId,
      status: intent.row.status === "applied" ? "applied" : "intent",
      attemptRunId: intent.row.attemptRunId,
    };
  }

  let value: T;
  try {
    value = await input.execute();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(effectIntents)
      .set({ resultSummary: { error: message }, updatedAt: new Date() })
      .where(eq(effectIntents.effectId, intent.effectId))
      .catch((updateErr) => {
        logger.warn({ err: updateErr, effectId: intent.effectId }, "failed to record effect intent error");
      });
    throw error;
  }

  const applied = await db
    .update(effectIntents)
    .set({
      status: "applied",
      appliedAt: new Date(),
      updatedAt: new Date(),
      ...(input.resultSummary ? { resultSummary: input.resultSummary } : {}),
    })
    .where(
      and(
        eq(effectIntents.effectId, intent.effectId),
        eq(effectIntents.status, "intent"),
        eq(effectIntents.attemptRunId, input.attemptRunId),
      ),
    )
    .returning();
  if (applied.length === 0) {
    // 소유 CAS 실패 — 효과는 이미 발생했으므로 실행 결과는 유지하되 장부 이탈을 경고로 남긴다.
    logger.warn(
      { effectId: intent.effectId, attemptRunId: input.attemptRunId },
      "effect intent applied-CAS lost after execution",
    );
  }
  return { outcome: "executed", value, effectId: intent.effectId };
}

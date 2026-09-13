// server/src/services/quality/retry-budget.ts
//
// [purpose] T4 유한 재시도 예약. 기존 workflow step retry 트랜잭션 안에서 quality 조치의
//   group+policy 사용량을 검사·증가한다(§3.3 잠금 순서: policy usage → group → action).
//   새 기술 시도는 이 예약이 성공해야 새 generation/키로 확정된다.
// [cost] 실행 시도 횟수(executionAttempts)만 예약한다. 시도당 금액 기본값을 만들지
//   않는다(누락값에 숨은 기본값 금지). 금액은 기존 비용 기록에서 정산되며 이미 저장된
//   예약·청구 금액은 새 시작 한도에서 제외하지 않는다.

import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  qualityActionGroups,
  qualityActions,
  qualityPolicyUsage,
  qualityPolicyVersions,
} from "@paperclipai/db";
import { qualityPolicySchema, retryEnvelopeSchema } from "@paperclipai/shared";
import { parseEvidence } from "./contract.js";
import { readPolicyUsageTotals } from "./policy-usage.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** step run metadata 에서 quality 소속 조치 ID 를 읽는다(없으면 null — generic step). */
export function readQualityStepActionId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).qualityActionId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

type GroupUsage = { executionAttempts?: number; reservedCostCents?: number; chargedCostCents?: number };

/**
 * 재시도 1회 분의 실행 예약: 한도 검사 + group.usage/quality_policy_usage 증가.
 * 한도 초과/조치 없음은 예외를 던져 retry 트랜잭션 전체를 롤백한다(원본 불변).
 */
export async function reserveQualityRetryUsage(tx: Tx, input: {
  companyId: string; actionId: string; now: Date;
}): Promise<void> {
  // 잠금 순서(§3.3): policy usage 행 → group → action.
  const [pre] = await tx.select({ groupId: qualityActions.groupId, policyVersionId: qualityActions.policyVersionId })
    .from(qualityActions).where(and(eq(qualityActions.companyId, input.companyId), eq(qualityActions.id, input.actionId)));
  if (!pre) throw new Error("quality_action_not_found");
  await tx.select({ id: qualityPolicyUsage.id }).from(qualityPolicyUsage)
    .where(and(eq(qualityPolicyUsage.companyId, input.companyId), eq(qualityPolicyUsage.policyVersionId, pre.policyVersionId)))
    .orderBy(asc(qualityPolicyUsage.windowStart)).for("update");
  await tx.select({ id: qualityActionGroups.id }).from(qualityActionGroups)
    .where(and(eq(qualityActionGroups.companyId, input.companyId), eq(qualityActionGroups.id, pre.groupId))).for("update");
  const [action] = await tx.select().from(qualityActions)
    .where(and(eq(qualityActions.companyId, input.companyId), eq(qualityActions.id, input.actionId))).for("update");
  if (!action) throw new Error("quality_action_not_found");
  const envelope = parseEvidence(retryEnvelopeSchema, action.retryEnvelope);
  const [policyRow] = await tx.select().from(qualityPolicyVersions)
    .where(and(eq(qualityPolicyVersions.companyId, input.companyId), eq(qualityPolicyVersions.id, action.policyVersionId))).for("share");
  if (!policyRow) throw new Error("quality_policy_not_found");
  const policy = parseEvidence(qualityPolicySchema, policyRow.definition);
  const windowStart = new Date(policy.periodStart);
  const windowEnd = new Date(policy.periodEnd);

  // 회사 기간 총량(정책 버전 교체로 초기화되지 않는다) — 실행 시도 횟수와 저장 금액 모두 검사.
  const totals = await readPolicyUsageTotals(tx as unknown as Db, {
    companyId: input.companyId, policyVersionId: action.policyVersionId, windowStart, windowEnd,
  });
  if (totals.executionAttempts + 1 > envelope.maxExecutorAttempts) {
    throw new Error("quality_execution_attempts_exhausted");
  }
  if (totals.reservedCostCents + totals.chargedCostCents > policy.maxCostCentsPerPeriod) {
    throw new Error("quality_period_cost_exhausted");
  }
  const [groupRow] = await tx.select().from(qualityActionGroups)
    .where(and(eq(qualityActionGroups.companyId, input.companyId), eq(qualityActionGroups.id, envelope.groupId))).for("update");
  if (!groupRow) throw new Error("quality_group_not_found");
  const usage = (groupRow.usage ?? {}) as GroupUsage;
  const groupAttempts = Number(usage.executionAttempts ?? 0);
  if (groupAttempts + 1 > envelope.maxExecutorAttempts) {
    throw new Error("quality_execution_attempts_exhausted");
  }
  if ((Number(usage.reservedCostCents ?? 0) + Number(usage.chargedCostCents ?? 0)) > envelope.maxCumulativeCostCents) {
    throw new Error("quality_group_cost_exhausted");
  }

  // 예약 기록: group.usage.executionAttempts + policy_usage.executionAttempts (+0 예약 금액).
  const nextUsage: GroupUsage = { ...usage, executionAttempts: groupAttempts + 1 };
  const groupClaimed = await tx.update(qualityActionGroups)
    .set({ usage: nextUsage, revision: groupRow.revision + 1, updatedAt: input.now })
    .where(and(
      eq(qualityActionGroups.companyId, input.companyId),
      eq(qualityActionGroups.id, envelope.groupId),
      eq(qualityActionGroups.revision, groupRow.revision),
    ))
    .returning({ id: qualityActionGroups.id });
  if (groupClaimed.length === 0) throw new Error("quality_usage_revision_conflict");

  const [existingUsage] = await tx.select().from(qualityPolicyUsage)
    .where(and(
      eq(qualityPolicyUsage.companyId, input.companyId),
      eq(qualityPolicyUsage.policyVersionId, action.policyVersionId),
      eq(qualityPolicyUsage.windowStart, windowStart),
    )).for("update");
  if (existingUsage) {
    const claimed = await tx.update(qualityPolicyUsage)
      .set({
        executionAttempts: existingUsage.executionAttempts + 1,
        revision: existingUsage.revision + 1,
      })
      .where(and(
        eq(qualityPolicyUsage.companyId, input.companyId),
        eq(qualityPolicyUsage.id, existingUsage.id),
        eq(qualityPolicyUsage.revision, existingUsage.revision),
      ))
      .returning({ id: qualityPolicyUsage.id });
    if (claimed.length === 0) throw new Error("quality_usage_revision_conflict");
    return;
  }
  const inserted = await tx.insert(qualityPolicyUsage).values({
    companyId: input.companyId,
    policyVersionId: action.policyVersionId,
    windowStart,
    windowEnd,
    reservedCostCents: 0,
    chargedCostCents: 0,
    executionAttempts: 1,
    revision: 1,
  })
    .onConflictDoNothing()
    .returning({ id: qualityPolicyUsage.id });
  if (inserted.length === 0) {
    // 동시 삽입 승자: 다시 읽어 증가시킨다(같은 tx 잠금 순서로 직렬화).
    const [winner] = await tx.select().from(qualityPolicyUsage)
      .where(and(
        eq(qualityPolicyUsage.companyId, input.companyId),
        eq(qualityPolicyUsage.policyVersionId, action.policyVersionId),
        eq(qualityPolicyUsage.windowStart, windowStart),
      )).for("update");
    if (!winner) throw new Error("quality_usage_write_failed");
    await tx.update(qualityPolicyUsage)
      .set({ executionAttempts: winner.executionAttempts + 1, revision: winner.revision + 1 })
      .where(eq(qualityPolicyUsage.id, winner.id));
  }
}

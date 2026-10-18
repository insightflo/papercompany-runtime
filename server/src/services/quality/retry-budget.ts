// Atomic quality retry admission. Locking does not spend or reject exhausted budgets;
// only the event winner consumes. All failures must escape the owning transaction.
// Order: usage(windowStart, id) -> group -> action -> policy -> caller's mission/run.
// Company-period totals still span policy versions; cross-policy serialization is outside this boundary.
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { qualityActionGroups, qualityActions, qualityPolicyUsage, qualityPolicyVersions } from "@paperclipai/db";
import { qualityPolicySchema, retryEnvelopeSchema } from "@paperclipai/shared";
import { parseEvidence } from "./contract.js";
import { readPolicyUsageTotals } from "./policy-usage.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type BudgetInput = { companyId: string; actionId: string; now: Date };
type GroupUsage = { executionAttempts?: number; reservedCostCents?: number; chargedCostCents?: number };
declare const budgetLockBrand: unique symbol;
export type QualityAttemptBudgetLock = { readonly [budgetLockBrand]: true };
type LockedBudget = {
  tx: Tx;
  xid: string;
  companyId: string;
  action: typeof qualityActions.$inferSelect;
  group: typeof qualityActionGroups.$inferSelect;
  usage: typeof qualityPolicyUsage.$inferSelect;
  policy: ReturnType<typeof qualityPolicySchema.parse>;
  envelope: ReturnType<typeof retryEnvelopeSchema.parse>;
  windowStart: Date;
  windowEnd: Date;
};
// Opaque, single-use receipts bind both the tx object and its actual database transaction.
const lockedBudgets = new WeakMap<QualityAttemptBudgetLock, LockedBudget>();

async function readBudgetTransactionId(tx: Tx): Promise<string> {
  const [row] = await tx.execute(sql`SELECT txid_current()::text AS xid`);
  const xid = row?.xid;
  if (typeof xid !== "string" || !/^[1-9][0-9]*$/.test(xid)) {
    throw new Error("quality_budget_lock_invalid");
  }
  return xid;
}

export function readQualityStepActionId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).qualityActionId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Acquire before mission/run locks; do not check quotas until the caller wins its event. */
export async function lockQualityAttemptBudget(tx: Tx, input: BudgetInput): Promise<QualityAttemptBudgetLock> {
  const [pre] = await tx.select().from(qualityActions)
    .where(and(eq(qualityActions.companyId, input.companyId), eq(qualityActions.id, input.actionId)));
  if (!pre) throw new Error("quality_action_not_found");
  const [preGroup] = await tx.select().from(qualityActionGroups)
    .where(and(eq(qualityActionGroups.companyId, input.companyId), eq(qualityActionGroups.id, pre.groupId)));
  if (!preGroup) throw new Error("quality_group_not_found");
  const [prePolicy] = await tx.select().from(qualityPolicyVersions)
    .where(and(eq(qualityPolicyVersions.companyId, input.companyId), eq(qualityPolicyVersions.id, pre.policyVersionId)));
  if (!prePolicy) throw new Error("quality_policy_not_found");
  const observedPolicy = parseEvidence(qualityPolicySchema, prePolicy.definition);
  const windowStart = new Date(observedPolicy.periodStart);
  const windowEnd = new Date(observedPolicy.periodEnd);

  // A missing row cannot be locked. Materialize zero before locking either competing group.
  // The unique key also serializes concurrent first reservations; no conflict-path increment.
  await tx.insert(qualityPolicyUsage).values({
    companyId: input.companyId, policyVersionId: pre.policyVersionId, windowStart, windowEnd,
    executionAttempts: 0, reservedCostCents: 0, chargedCostCents: 0, revision: 1,
  }).onConflictDoNothing();
  const usageRows = await tx.select().from(qualityPolicyUsage)
    .where(and(eq(qualityPolicyUsage.companyId, input.companyId), eq(qualityPolicyUsage.policyVersionId, pre.policyVersionId)))
    .orderBy(asc(qualityPolicyUsage.windowStart), asc(qualityPolicyUsage.id)).for("update");
  const usage = usageRows.find(row => row.windowStart.getTime() === windowStart.getTime());
  if (!usage) throw new Error("quality_usage_write_failed");
  const [group] = await tx.select().from(qualityActionGroups)
    .where(and(eq(qualityActionGroups.companyId, input.companyId), eq(qualityActionGroups.id, pre.groupId))).for("update");
  if (!group) throw new Error("quality_group_not_found");
  const [action] = await tx.select().from(qualityActions)
    .where(and(eq(qualityActions.companyId, input.companyId), eq(qualityActions.id, input.actionId))).for("update");
  if (!action) throw new Error("quality_action_not_found");
  const [policyRow] = await tx.select().from(qualityPolicyVersions)
    .where(and(eq(qualityPolicyVersions.companyId, input.companyId), eq(qualityPolicyVersions.id, pre.policyVersionId))).for("share");
  if (!policyRow) throw new Error("quality_policy_not_found");
  const policy = parseEvidence(qualityPolicySchema, policyRow.definition);
  const envelope = parseEvidence(retryEnvelopeSchema, action.retryEnvelope);
  if (action.groupId !== pre.groupId || action.policyVersionId !== pre.policyVersionId
    || action.revision !== pre.revision || group.policyVersionId !== preGroup.policyVersionId
    || new Date(policy.periodStart).getTime() !== windowStart.getTime()
    || new Date(policy.periodEnd).getTime() !== windowEnd.getTime()
    || usage.windowEnd.getTime() !== windowEnd.getTime()) {
    throw new Error("quality_budget_scope_changed");
  }
  if (envelope.groupId !== action.groupId || envelope.policyVersionId !== action.policyVersionId) {
    throw new Error("quality_action_contract_mismatch");
  }
  const xid = await readBudgetTransactionId(tx);
  const receipt = Object.freeze({}) as QualityAttemptBudgetLock;
  lockedBudgets.set(receipt, { tx, xid, companyId: input.companyId, action, group, usage, policy, envelope, windowStart, windowEnd });
  return receipt;
}

/** Backward-compatible reservation API; an optional authentic receipt avoids reversing lock order. */
export async function reserveQualityRetryUsage(
  tx: Tx, input: BudgetInput, receipt?: QualityAttemptBudgetLock,
): Promise<void> {
  const token = receipt === undefined ? await lockQualityAttemptBudget(tx, input) : receipt;
  const locked = lockedBudgets.get(token);
  if (!locked || locked.tx !== tx || locked.companyId !== input.companyId || locked.action.id !== input.actionId) {
    throw new Error("quality_budget_lock_invalid");
  }
  // Consume before awaiting the identity check so concurrent consumers cannot reuse the receipt.
  lockedBudgets.delete(token);
  if (await readBudgetTransactionId(tx) !== locked.xid) {
    throw new Error("quality_budget_lock_invalid");
  }
  // Re-read even under our locks: a caller may have changed a revision earlier in this tx.
  const [groupRow] = await tx.select().from(qualityActionGroups)
    .where(and(eq(qualityActionGroups.companyId, input.companyId), eq(qualityActionGroups.id, locked.group.id)));
  const [usageRow] = await tx.select().from(qualityPolicyUsage)
    .where(and(eq(qualityPolicyUsage.companyId, input.companyId), eq(qualityPolicyUsage.id, locked.usage.id)));
  const [action] = await tx.select().from(qualityActions)
    .where(and(eq(qualityActions.companyId, input.companyId), eq(qualityActions.id, input.actionId)));
  if (!groupRow || !usageRow || !action || groupRow.revision !== locked.group.revision
    || usageRow.revision !== locked.usage.revision || action.revision !== locked.action.revision) {
    throw new Error("quality_usage_revision_conflict");
  }
  if (action.groupId !== locked.group.id || action.policyVersionId !== locked.action.policyVersionId
    || groupRow.policyVersionId !== locked.group.policyVersionId
    || usageRow.policyVersionId !== locked.action.policyVersionId
    || usageRow.windowStart.getTime() !== locked.windowStart.getTime()
    || usageRow.windowEnd.getTime() !== locked.windowEnd.getTime()) {
    throw new Error("quality_budget_scope_changed");
  }
  const { envelope, policy, windowStart, windowEnd } = locked;
  // Keep the existing all-policy-version company-period cost/attempt contract.
  const totals = await readPolicyUsageTotals(tx, {
    companyId: input.companyId, policyVersionId: action.policyVersionId, windowStart, windowEnd,
  });
  if (totals.executionAttempts + 1 > envelope.maxExecutorAttempts) {
    throw new Error("quality_execution_attempts_exhausted");
  }
  if (totals.reservedCostCents + totals.chargedCostCents > policy.maxCostCentsPerPeriod) {
    throw new Error("quality_period_cost_exhausted");
  }
  const usage = (groupRow.usage ?? {}) as GroupUsage;
  const groupAttempts = Number(usage.executionAttempts ?? 0);
  if (groupAttempts + 1 > envelope.maxExecutorAttempts) {
    throw new Error("quality_execution_attempts_exhausted");
  }
  if (Number(usage.reservedCostCents ?? 0) + Number(usage.chargedCostCents ?? 0) > envelope.maxCumulativeCostCents) {
    throw new Error("quality_group_cost_exhausted");
  }
  const groupClaimed = await tx.update(qualityActionGroups)
    .set({ usage: { ...usage, executionAttempts: groupAttempts + 1 }, revision: groupRow.revision + 1, updatedAt: input.now })
    .where(and(
      eq(qualityActionGroups.companyId, input.companyId), eq(qualityActionGroups.id, groupRow.id),
      eq(qualityActionGroups.revision, groupRow.revision),
    )).returning({ id: qualityActionGroups.id });
  if (groupClaimed.length === 0) throw new Error("quality_usage_revision_conflict");
  const usageClaimed = await tx.update(qualityPolicyUsage)
    .set({ executionAttempts: usageRow.executionAttempts + 1, revision: usageRow.revision + 1 })
    .where(and(
      eq(qualityPolicyUsage.companyId, input.companyId), eq(qualityPolicyUsage.id, usageRow.id),
      eq(qualityPolicyUsage.revision, usageRow.revision),
    )).returning({ id: qualityPolicyUsage.id });
  if (usageClaimed.length === 0) throw new Error("quality_usage_revision_conflict");
}

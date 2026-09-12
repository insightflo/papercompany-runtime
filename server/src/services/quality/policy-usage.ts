import { and, eq, gt, lt, sql } from "drizzle-orm";
import { qualityPolicyUsage, type Db } from "@paperclipai/db";
import { uuidSchema } from "@paperclipai/shared";
import type { QualityTx } from "./targets.js";

/** Company-period totals deliberately span policy versions so replacement cannot reset spend.
 * This read is not execution admission: later reservation writers must lock usage before groups.
 */
export async function readPolicyUsageTotals(db: Db | QualityTx, input: {
  companyId: string; policyVersionId: string; windowStart: Date; windowEnd: Date;
}): Promise<{ reservedCostCents: number; chargedCostCents: number; executionAttempts: number }> {
  uuidSchema.parse(input.companyId);
  uuidSchema.parse(input.policyVersionId);
  if (!Number.isFinite(input.windowStart.getTime()) || !Number.isFinite(input.windowEnd.getTime())
    || input.windowEnd <= input.windowStart) throw new Error("quality_policy_invalid_period");
  const [row] = await db.select({
    reservedCostCents: sql<number>`coalesce(sum(${qualityPolicyUsage.reservedCostCents}), 0)`.mapWith(Number),
    chargedCostCents: sql<number>`coalesce(sum(${qualityPolicyUsage.chargedCostCents}), 0)`.mapWith(Number),
    executionAttempts: sql<number>`coalesce(sum(${qualityPolicyUsage.executionAttempts}), 0)`.mapWith(Number),
  }).from(qualityPolicyUsage).where(and(
    eq(qualityPolicyUsage.companyId, input.companyId),
    lt(qualityPolicyUsage.windowStart, input.windowEnd), gt(qualityPolicyUsage.windowEnd, input.windowStart),
  ));
  return row!;
}

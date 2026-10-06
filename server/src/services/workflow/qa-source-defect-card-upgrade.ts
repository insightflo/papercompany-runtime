import { activityLog, type Db, type operatorDecisions } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

export const QA_CARD_SUPERSEDED_REASON = "qa_source_defect_card_superseded_by_newer_generation";
export const QA_CARD_SYSTEM_ACTOR = { type: "user", id: "system" } as const;

// This is the existing shared writer's machine-produced v1 cancellation receipt,
// committed atomically with the terminal row. It is NOT a card/comment text parser.
const cancellationReceipt = z.object({
  schemaVersion: z.literal(1),
  operatorDecisionId: z.string().uuid(),
  cancelledByActorType: z.literal("user"),
  cancelledByActorId: z.literal("system"),
  cancelledAt: z.string().datetime(),
  reason: z.literal(QA_CARD_SUPERSEDED_REASON),
});

export async function isRecoverableQaCardUpgrade(
  db: Db,
  row: typeof operatorDecisions.$inferSelect,
  expected: { companyId: string; requestKey: string; sourceType: string | null; sourceId: string | null },
): Promise<boolean> {
  if (row.status !== "cancelled" || !row.cancelledAt
    || row.companyId !== expected.companyId || row.requestKey !== expected.requestKey
    || row.sourceType !== expected.sourceType || row.sourceId !== expected.sourceId) return false;
  const receipts = await db.select().from(activityLog).where(and(
    eq(activityLog.companyId, expected.companyId),
    eq(activityLog.entityType, "operator_decision"),
    eq(activityLog.entityId, row.id),
    eq(activityLog.action, "operator_decision.cancelled"),
  ));
  if (receipts.length !== 1) return false;
  const receipt = receipts[0]!;
  if (receipt.actorType !== "user" || receipt.actorId !== "system" || receipt.agentId !== null) return false;
  const parsed = cancellationReceipt.safeParse(receipt.details);
  return parsed.success && parsed.data.operatorDecisionId === row.id
    && new Date(parsed.data.cancelledAt).getTime() === row.cancelledAt.getTime();
}

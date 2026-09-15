/** Minimal finding writer: no issue service import, wakeup or execution authority from prose. */
import { and, desc, eq, isNull, notInArray, sql } from "drizzle-orm";
import { qualityEvidenceRefs, qualityOccurrences, qualityReviewItems, type Db } from "@paperclipai/db";
import type { ArtifactRef, SourceAttempt } from "@paperclipai/shared";
import { writeOccurrence } from "./quality/occurrences.js";

const CLOSED_STATUSES = ["resolved_pass", "resolved_fail", "dismissed", "closed", "evaluator_promoted", "evaluator_rejected"];

export interface QualityFindingInput {
  companyId: string;
  missionId?: string | null;
  title: string;
  targetType: string;
  triggerSource: string;
  targetId: string;
  failureType: string;
  priority?: string;
  triggerMetadata?: Record<string, unknown>;
  evidenceRefs?: Array<{ surface: string; status?: string; blocking?: boolean; expected?: Record<string, unknown> }>;
  /** Only callers with an exact machine-produced attempt may opt into occurrence authority. */
  occurrence?: { producerRunId: string; submissionKey: string; source: SourceAttempt; evidence: ArtifactRef[] };
}

export async function writeQualityFinding(db: Db, input: QualityFindingInput): Promise<{ reviewItemId: string; created: boolean }> {
  return db.transaction(async (tx) => {
    const target = and(
      eq(qualityReviewItems.companyId, input.companyId), eq(qualityReviewItems.targetType, input.targetType),
      eq(qualityReviewItems.triggerSource, input.triggerSource),
      input.targetId ? eq(qualityReviewItems.targetId, input.targetId) : isNull(qualityReviewItems.targetId),
      notInArray(qualityReviewItems.status, CLOSED_STATUSES),
    );
    // Serializes the find/create and occurrence transaction without catching an aborted PG transaction.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["quality-finding", input.companyId, input.targetType, input.triggerSource, input.targetId])}, 0))`);
    const [replay] = input.occurrence ? await tx.select({ reviewItemId: qualityOccurrences.reviewItemId }).from(qualityOccurrences).where(and(
      eq(qualityOccurrences.companyId, input.companyId), eq(qualityOccurrences.producerRunId, input.occurrence.producerRunId), eq(qualityOccurrences.submissionKey, input.occurrence.submissionKey),
    )) : [];
    const [open] = await tx.select({ id: qualityReviewItems.id }).from(qualityReviewItems).where(target).orderBy(desc(qualityReviewItems.createdAt)).limit(1);
    let reviewItemId = replay?.reviewItemId ?? open?.id;
    let created = false;
    if (!reviewItemId) {
      const [row] = await tx.insert(qualityReviewItems).values({
        companyId: input.companyId, missionId: input.missionId ?? null, title: input.title,
        status: "awaiting_review", targetType: input.targetType, targetId: input.targetId,
        triggerSource: input.triggerSource, triggerMetadata: input.triggerMetadata ?? {},
        failureType: input.failureType, priority: input.priority ?? "high",
      }).onConflictDoNothing().returning({ id: qualityReviewItems.id });
      if (row) { reviewItemId = row.id; created = true; }
      else {
        const [concurrent] = await tx.select({ id: qualityReviewItems.id }).from(qualityReviewItems).where(target).limit(1);
        if (!concurrent) throw new Error("quality_review_conflict");
        reviewItemId = concurrent.id;
      }
    }
    // Must precede the open-review return. Replay never creates actions or consumes budget.
    if (input.occurrence) await writeOccurrence(tx, { companyId: input.companyId, reviewItemId, ...input.occurrence });
    if (created && input.evidenceRefs?.length) await tx.insert(qualityEvidenceRefs).values(input.evidenceRefs.map((ref) => ({
      companyId: input.companyId, reviewItemId, surface: ref.surface, status: ref.status ?? "missing",
      blocking: ref.blocking ?? true, expected: ref.expected ?? {}, actual: {},
    })));
    return { reviewItemId, created };
  });
}

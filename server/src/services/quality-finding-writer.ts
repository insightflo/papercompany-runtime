/**
 * [파일 목적] Phase 5 자동 trigger 용 얇은 quality finding writer.
 *   heartbeat / loop-driver 같은 hot path 에서 무거운 qualityService(issueService 등)를
 *   끌어오지 않고, quality_review_items + quality_evidence_refs 에 직접 기록한다.
 *
 * [주의] 이 파일은 issueService 를 import 하지 않는다(순환/사이드이펙트 회피).
 *   본체 기능(dedupe/상태전이/verdict)은 qualityService(quality.ts) 가 담당하고,
 *   여기는 자동 생성 minimal insert 만 담당 → call-site 부담 최소.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { qualityEvidenceRefs, qualityReviewItems, type Db } from "@paperclipai/db";

const CLOSED_STATUSES = new Set([
  "resolved_pass",
  "resolved_fail",
  "dismissed",
  "closed",
  "evaluator_promoted",
  "evaluator_rejected",
]);

export interface QualityFindingInput {
  companyId: string;
  missionId?: string | null;
  title: string;
  targetType: string;
  triggerSource: string;
  /** dedupe 단위. 보통 missionId 또는 run 기반 식별자. */
  targetId: string;
  failureType: string;
  priority?: string;
  triggerMetadata?: Record<string, unknown>;
  evidenceRefs?: Array<{
    surface: string;
    status?: string;
    blocking?: boolean;
    expected?: Record<string, unknown>;
  }>;
}

/**
 * [목적] 같은 대상(company+targetType+triggerSource+targetId)의 열린 finding 이 있으면 재사용,
 *   없으면 새로 삽입. minimal direct insert(issueService 미사용).
 * [출력] {reviewItemId, created}.
 */
export async function writeQualityFinding(
  db: Db,
  input: QualityFindingInput,
): Promise<{ reviewItemId: string; created: boolean }> {
  const existing = await db
    .select({ id: qualityReviewItems.id, status: qualityReviewItems.status })
    .from(qualityReviewItems)
    .where(
      and(
        eq(qualityReviewItems.companyId, input.companyId),
        eq(qualityReviewItems.targetType, input.targetType),
        eq(qualityReviewItems.triggerSource, input.triggerSource),
        input.targetId ? eq(qualityReviewItems.targetId, input.targetId) : isNull(qualityReviewItems.targetId),
      ),
    )
    .orderBy(desc(qualityReviewItems.createdAt))
    .limit(5);

  const open = existing.find((e) => !CLOSED_STATUSES.has(e.status));
  if (open) {
    return { reviewItemId: open.id, created: false };
  }

  let reviewItemId: string;
  let created = true;
  try {
    const [row] = await db
      .insert(qualityReviewItems)
      .values({
        companyId: input.companyId,
        missionId: input.missionId ?? null,
        title: input.title,
        status: "awaiting_review",
        targetType: input.targetType,
        targetId: input.targetId,
        triggerSource: input.triggerSource,
        triggerMetadata: input.triggerMetadata ?? {},
        failureType: input.failureType,
        priority: input.priority ?? "high",
      })
      .returning({ id: qualityReviewItems.id });
    reviewItemId = row.id;
  } catch (err) {
    // [주의] 동시 삽입 race: partial unique index(0070) 가 잡음 → 상대가 먼저 넣은 open item 재조회.
    if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "23505") {
      const recon = await db
        .select({ id: qualityReviewItems.id })
        .from(qualityReviewItems)
        .where(
          and(
            eq(qualityReviewItems.companyId, input.companyId),
            eq(qualityReviewItems.targetType, input.targetType),
            eq(qualityReviewItems.triggerSource, input.triggerSource),
            input.targetId ? eq(qualityReviewItems.targetId, input.targetId) : isNull(qualityReviewItems.targetId),
          ),
        )
        .orderBy(desc(qualityReviewItems.createdAt))
        .limit(1);
      if (!recon[0]) throw err;
      reviewItemId = recon[0].id;
      created = false;
    } else {
      throw err;
    }
  }

  if (created && input.evidenceRefs && input.evidenceRefs.length > 0) {
    await db.insert(qualityEvidenceRefs).values(
      input.evidenceRefs.map((r) => ({
        companyId: input.companyId,
        reviewItemId,
        surface: r.surface,
        status: r.status ?? "missing",
        blocking: r.blocking ?? true,
        expected: r.expected ?? {},
        actual: {},
      })),
    );
  }
  return { reviewItemId, created };
}

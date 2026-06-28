import { and, asc, eq, inArray } from "drizzle-orm";
import {
  evaluatorAnchorCases,
  missionQualityVerdicts,
  missions,
  qualityEvidenceRefs,
  qualityReviewItems,
  type Db,
} from "@paperclipai/db";
import { notFound } from "../errors.js";
import { issueService } from "./issues.js";

const EVIDENCE_ISSUE_ORIGIN = "quality_evidence_request";
const TERMINAL_MISSION_STATUSES = new Set(["completed", "cancelled"]);

type TransactionDb = Parameters<Parameters<Db["transaction"]>[0]>[0];
type QualityWriteDb = Db | TransactionDb;

function resolveVerdictStatus(verdict: string): string {
  switch (verdict) {
    case "pass":
      return "resolved_pass";
    case "fail":
      return "resolved_fail";
    case "request_changes":
      return "changes_requested";
    case "dismissed":
      return "dismissed";
    case "needs_evidence":
      return "evidence_collecting";
    default:
      return "awaiting_review";
  }
}

export interface QualityEvidenceRefRow {
  id: string;
  companyId: string;
  reviewItemId: string;
  surface: string;
  expected: Record<string, unknown>;
  actual: Record<string, unknown>;
  status: string;
  collectedByActorType: string | null;
  collectedByActorId: string | null;
  sourceRunId: string | null;
  sourceUrl: string | null;
  collectedAt: Date;
  freshnessExpiresAt: Date | null;
  blocking: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface QualityReviewItemRow {
  id: string;
  companyId: string;
  missionId: string | null;
  title: string;
  status: string;
  targetType: string;
  targetId: string | null;
  triggerSource: string;
  triggerMetadata: Record<string, unknown>;
  failureType: string | null;
  priority: string;
  createdAt: Date;
  updatedAt: Date;
}

export type QualityReviewItemListItemWithEvidence = QualityReviewItemRow & {
  evidenceRefs: QualityEvidenceRefRow[];
};

function attachEvidenceRefs(
  items: QualityReviewItemRow[],
  refs: QualityEvidenceRefRow[],
): QualityReviewItemListItemWithEvidence[] {
  const byItem = new Map<string, QualityEvidenceRefRow[]>();
  for (const ref of refs) {
    const bucket = byItem.get(ref.reviewItemId);
    if (bucket) bucket.push(ref);
    else byItem.set(ref.reviewItemId, [ref]);
  }
  return items.map((item) => ({
    ...item,
    evidenceRefs: byItem.get(item.id) ?? [],
  }));
}

function buildEvidenceIssueDescription(
  item: QualityReviewItemRow,
  input: RecordVerdictInput,
  followUpMissionId: string | undefined,
) {
  const lines = [
    "Quality Board requested additional evidence before this result can be trusted.",
    "",
    `Review item: ${item.title}`,
    `Target: ${item.targetType}${item.targetId ? ` ${item.targetId}` : ""}`,
    `Original mission: ${item.missionId ?? "none"}`,
  ];
  if (!followUpMissionId && item.missionId) {
    lines.push("Follow-up issue is company-scoped because the original mission is already terminal or unavailable.");
  }
  if (input.reason?.trim()) {
    lines.push("", "Reason:", input.reason.trim());
  }
  const surfaces = (input.requiredEvidenceSurfaces ?? []).map((s) => s.trim()).filter(Boolean);
  if (surfaces.length > 0) {
    lines.push("", "Required evidence surfaces:");
    for (const surface of surfaces) lines.push(`- ${surface}`);
  }
  return lines.join("\n");
}

export interface RecordVerdictInput {
  reviewItemId: string;
  decidedByUserId: string;
  verdict: string;
  reason?: string | null;
  failureType?: string | null;
  requiredEvidenceSurfaces?: string[];
}

export interface PromoteAnchorInput {
  reviewItemId: string;
  verdictId: string;
  title: string;
}

export function qualityService(db: Db) {
  // Use the issue service so identifiers, issue numbers, and activity side effects stay consistent.
  const issueSvc = issueService(db);

  async function loadReviewItem(reviewItemId: string): Promise<QualityReviewItemRow> {
    const [item] = await db
      .select({
        id: qualityReviewItems.id,
        companyId: qualityReviewItems.companyId,
        missionId: qualityReviewItems.missionId,
        title: qualityReviewItems.title,
        status: qualityReviewItems.status,
        targetType: qualityReviewItems.targetType,
        targetId: qualityReviewItems.targetId,
        triggerSource: qualityReviewItems.triggerSource,
        triggerMetadata: qualityReviewItems.triggerMetadata,
        failureType: qualityReviewItems.failureType,
        priority: qualityReviewItems.priority,
        createdAt: qualityReviewItems.createdAt,
        updatedAt: qualityReviewItems.updatedAt,
      })
      .from(qualityReviewItems)
      .where(eq(qualityReviewItems.id, reviewItemId))
      .limit(1);
    if (!item) throw notFound("Quality review item not found");
    return item;
  }

  async function getReviewItemOwnership(reviewItemId: string): Promise<{ companyId: string; missionId: string | null } | null> {
    const item = await db
      .select({
        companyId: qualityReviewItems.companyId,
        missionId: qualityReviewItems.missionId,
      })
      .from(qualityReviewItems)
      .where(eq(qualityReviewItems.id, reviewItemId))
      .limit(1);
    return item[0] ?? null;
  }

  async function listCompanyQualityReviewItems(
    companyId: string,
  ): Promise<QualityReviewItemListItemWithEvidence[]> {
    const items = await db
      .select({
        id: qualityReviewItems.id,
        companyId: qualityReviewItems.companyId,
        missionId: qualityReviewItems.missionId,
        title: qualityReviewItems.title,
        status: qualityReviewItems.status,
        targetType: qualityReviewItems.targetType,
        targetId: qualityReviewItems.targetId,
        triggerSource: qualityReviewItems.triggerSource,
        triggerMetadata: qualityReviewItems.triggerMetadata,
        failureType: qualityReviewItems.failureType,
        priority: qualityReviewItems.priority,
        createdAt: qualityReviewItems.createdAt,
        updatedAt: qualityReviewItems.updatedAt,
      })
      .from(qualityReviewItems)
      .where(eq(qualityReviewItems.companyId, companyId))
      .orderBy(asc(qualityReviewItems.createdAt));

    if (items.length === 0) return [];

    const itemIds = items.map((i) => i.id);
    const refs = await db
      .select({
        id: qualityEvidenceRefs.id,
        companyId: qualityEvidenceRefs.companyId,
        reviewItemId: qualityEvidenceRefs.reviewItemId,
        surface: qualityEvidenceRefs.surface,
        expected: qualityEvidenceRefs.expected,
        actual: qualityEvidenceRefs.actual,
        status: qualityEvidenceRefs.status,
        collectedByActorType: qualityEvidenceRefs.collectedByActorType,
        collectedByActorId: qualityEvidenceRefs.collectedByActorId,
        sourceRunId: qualityEvidenceRefs.sourceRunId,
        sourceUrl: qualityEvidenceRefs.sourceUrl,
        collectedAt: qualityEvidenceRefs.collectedAt,
        freshnessExpiresAt: qualityEvidenceRefs.freshnessExpiresAt,
        blocking: qualityEvidenceRefs.blocking,
        createdAt: qualityEvidenceRefs.createdAt,
        updatedAt: qualityEvidenceRefs.updatedAt,
      })
      .from(qualityEvidenceRefs)
      .where(inArray(qualityEvidenceRefs.reviewItemId, itemIds))
      .orderBy(asc(qualityEvidenceRefs.surface), asc(qualityEvidenceRefs.createdAt));

    return attachEvidenceRefs(items, refs as QualityEvidenceRefRow[]);
  }

  async function resolveFollowUpMissionId(tx: TransactionDb, item: QualityReviewItemRow) {
    if (!item.missionId) return undefined;
    const [mission] = await tx
      .select({ status: missions.status })
      .from(missions)
      .where(and(eq(missions.id, item.missionId), eq(missions.companyId, item.companyId)))
      .limit(1);
    if (!mission || TERMINAL_MISSION_STATUSES.has(mission.status)) return undefined;
    return item.missionId;
  }

  async function recordQualityVerdict(input: RecordVerdictInput): Promise<{
    verdict: Awaited<ReturnType<typeof insertVerdictReturning>>;
    reviewItem: QualityReviewItemListItemWithEvidence;
  }> {
    const item = await loadReviewItem(input.reviewItemId);
    const nextStatus = resolveVerdictStatus(input.verdict);
    const surfaces = (input.requiredEvidenceSurfaces ?? []).map((s) => s.trim()).filter(Boolean);

    return db.transaction(async (tx) => {
      const verdict = await insertVerdictReturning(tx, {
        companyId: item.companyId,
        reviewItemId: item.id,
        missionId: item.missionId,
        targetType: item.targetType,
        targetId: item.targetId,
        verdict: input.verdict,
        failureType: input.failureType ?? item.failureType ?? null,
        reason: input.reason ?? null,
        decidedByUserId: input.decidedByUserId,
      });

      const [updated] = await tx
        .update(qualityReviewItems)
        .set({ status: nextStatus, updatedAt: new Date() })
        .where(eq(qualityReviewItems.id, item.id))
        .returning();

      // Only needs_evidence opens the evidence collection path. Leave it unassigned for queue pickup.
      if (input.verdict === "needs_evidence") {
        const title = `Quality evidence required: ${item.title || item.targetType}`;
        const followUpMissionId = await resolveFollowUpMissionId(tx, item);
        await issueSvc.createFromSrb(tx, item.companyId, {
          missionId: followUpMissionId,
          title,
          description: buildEvidenceIssueDescription(item, input, followUpMissionId),
          status: "todo",
          originKind: EVIDENCE_ISSUE_ORIGIN,
          originId: item.id,
        });

        if (surfaces.length > 0) {
          // Keep this idempotent when the same surface is requested more than once.
          const existing = await tx
            .select({ surface: qualityEvidenceRefs.surface })
            .from(qualityEvidenceRefs)
            .where(
              and(
                eq(qualityEvidenceRefs.reviewItemId, item.id),
                inArray(qualityEvidenceRefs.surface, surfaces),
              ),
            );
          const have = new Set(existing.map((r) => r.surface));
          const toInsert = surfaces
            .filter((s) => !have.has(s))
            .map((surface) => ({
              companyId: item.companyId,
              reviewItemId: item.id,
              surface,
              status: "missing",
              blocking: true,
            }));
          if (toInsert.length > 0) {
            await tx.insert(qualityEvidenceRefs).values(toInsert);
          }
        }
      }

      const refs = await tx
        .select()
        .from(qualityEvidenceRefs)
        .where(eq(qualityEvidenceRefs.reviewItemId, item.id))
        .orderBy(asc(qualityEvidenceRefs.surface), asc(qualityEvidenceRefs.createdAt));

      const reviewItem: QualityReviewItemListItemWithEvidence = {
        id: updated.id,
        companyId: updated.companyId,
        missionId: updated.missionId,
        title: updated.title,
        status: updated.status,
        targetType: updated.targetType,
        targetId: updated.targetId,
        triggerSource: updated.triggerSource,
        triggerMetadata: updated.triggerMetadata,
        failureType: updated.failureType,
        priority: updated.priority,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
        evidenceRefs: refs as unknown as QualityEvidenceRefRow[],
      };

      return { verdict, reviewItem };
    });
  }

  async function promoteVerdictToAnchor(input: PromoteAnchorInput) {
    const [verdict] = await db
      .select()
      .from(missionQualityVerdicts)
      .where(eq(missionQualityVerdicts.id, input.verdictId))
      .limit(1);
    if (!verdict || verdict.reviewItemId !== input.reviewItemId) {
      throw notFound("Quality verdict not found for this review item");
    }

    const evidenceRefs = await db
      .select({
        surface: qualityEvidenceRefs.surface,
        status: qualityEvidenceRefs.status,
        blocking: qualityEvidenceRefs.blocking,
        sourceUrl: qualityEvidenceRefs.sourceUrl,
      })
      .from(qualityEvidenceRefs)
      .where(eq(qualityEvidenceRefs.reviewItemId, input.reviewItemId));

    const [anchor] = await db
      .insert(evaluatorAnchorCases)
      .values({
        companyId: verdict.companyId,
        sourceVerdictId: verdict.id,
        reviewItemId: input.reviewItemId,
        missionId: verdict.missionId,
        title: input.title,
        failureType: verdict.failureType,
        verdict: verdict.verdict,
        evidenceRefs: evidenceRefs as unknown as Array<Record<string, unknown>>,
        status: "candidate",
      })
      .returning();

    return anchor;
  }

  return {
    listCompanyQualityReviewItems,
    getReviewItemOwnership,
    recordQualityVerdict,
    promoteVerdictToAnchor,
  };
}

async function insertVerdictReturning(
  tx: QualityWriteDb,
  values: {
    companyId: string;
    reviewItemId: string;
    missionId: string | null;
    targetType: string;
    targetId: string | null;
    verdict: string;
    failureType: string | null;
    reason: string | null;
    decidedByUserId: string;
  },
) {
  const [row] = await tx
    .insert(missionQualityVerdicts)
    .values({
      companyId: values.companyId,
      reviewItemId: values.reviewItemId,
      missionId: values.missionId ?? undefined,
      targetType: values.targetType,
      targetId: values.targetId,
      verdict: values.verdict,
      failureType: values.failureType,
      reason: values.reason,
      decidedByUserId: values.decidedByUserId,
    })
    .returning();
  return row;
}

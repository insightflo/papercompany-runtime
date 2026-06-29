import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  evaluatorCandidateRuns,
  evaluatorAnchorCases,
  evaluatorVersions,
  issueWorkProducts,
  missionQualityVerdicts,
  missionPlanArtifacts,
  missions,
  qualityDailyReports,
  qualityEvidenceRefs,
  qualityReviewItems,
  issues,
  type Db,
} from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { issueService } from "./issues.js";

const EVIDENCE_ISSUE_ORIGIN = "quality_evidence_request";
const CORRECTION_ISSUE_ORIGIN = "quality_correction_request";
const IMPROVEMENT_ISSUE_ORIGIN = "quality_evaluator_improvement";
const TERMINAL_MISSION_STATUSES = new Set(["completed", "cancelled"]);
const CLOSED_REVIEW_ITEM_STATUSES = new Set(["resolved_pass", "resolved_fail", "dismissed", "closed", "evaluator_promoted", "evaluator_rejected"]);
const UNRESOLVED_EVIDENCE_STATUSES = new Set(["missing", "failed", "stale", "insufficient"]);
const REQUIRED_FAILURE_TYPES = [
  "content_missing_core_concept",
  "delivery_url_404",
  "evidence_incomplete",
  "plan_goal_mismatch",
  "plan_submission_missing",
  "qa_false_pass",
];
const REQUIRED_EVIDENCE_SURFACES = [
  "db_row",
  "work_product",
  "r2_object",
  "public_url",
  "browser_readback",
  "run_transcript",
  "issue_comment",
];

type TransactionDb = Parameters<Parameters<Db["transaction"]>[0]>[0];
type QualityWriteDb = Db | TransactionDb;

// [목적] partial unique index(0070) 동시 삽입 race 감지. Postgres unique_violation = 23505.
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "23505";
}

function resolveVerdictStatus(verdict: string): string {
  switch (verdict) {
    case "pass":
      return "resolved_pass";
    case "fail":
      return "anchor_candidate";
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
  missionTitle?: string | null;
  missionStatus?: string | null;
  qualityContext?: {
    missionGoal?: string | null;
    target?: {
      issueId?: string | null;
      identifier?: string | null;
      title?: string | null;
      status?: string | null;
      stepId?: string | null;
      plannedOutput?: string | null;
      workProductTitle?: string | null;
      workProductPath?: string | null;
    } | null;
    sourceReview?: {
      issueId?: string | null;
      identifier?: string | null;
      title?: string | null;
      status?: string | null;
      stepId?: string | null;
    } | null;
    mismatchSummary?: string | null;
    recommendedAction?: string | null;
    focusNote?: string | null;
  } | null;
};

// [목적] missionId 들의 title/status 를 한 번에 조회해 item 에 요약 부착(UI "현재 해결 여부" 용).
async function attachMissionSummary(db: Db, items: QualityReviewItemListItemWithEvidence[]) {
  const missionIds = Array.from(new Set(items.map((i) => i.missionId).filter((m): m is string => !!m)));
  if (missionIds.length === 0) return items;
  const rows = await db
    .select({ id: missions.id, title: missions.title, status: missions.status })
    .from(missions)
    .where(inArray(missions.id, missionIds));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const item of items) {
    const m = item.missionId ? byId.get(item.missionId) : undefined;
    item.missionTitle = m?.title ?? null;
    item.missionStatus = m?.status ?? null;
  }
  return items;
}

function stringMeta(meta: Record<string, unknown>, key: string): string | null {
  const value = meta[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function triggerReasonText(meta: Record<string, unknown> | undefined): string | null {
  const value = meta?.reason;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstIssueIdentifier(text: string | null): string | null {
  if (!text) return null;
  return text.match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/)?.[0] ?? null;
}

function sourceStepIdFromDescription(description: string | null | undefined): string | null {
  if (!description) return null;
  return description.match(/(?:^|\n)-?\s*stepId:\s*([a-z0-9_-]+)/i)?.[1] ?? null;
}

function plannedOutputFromDescription(description: string | null | undefined): string | null {
  if (!description) return null;
  const lines = description.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const stepLine = lines.find((line) => / step\./i.test(line) && /save|write|create|include|convert/i.test(line));
  if (stepLine) return stepLine.length > 260 ? `${stepLine.slice(0, 257)}...` : stepLine;
  const outputLine = lines.find((line) => /must create|deliverable|save .* as|write .* into/i.test(line));
  if (outputLine) return outputLine.length > 260 ? `${outputLine.slice(0, 257)}...` : outputLine;
  return null;
}

function mismatchSummaryFromReason(reason: string | null): string | null {
  if (!reason) return null;
  const requestChanges = reason.match(/REQUEST[_\s-]?CHANGES:\s*([\s\S]+)/i)?.[1]?.trim();
  const summary = requestChanges || reason;
  const normalized = summary.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > 360 ? `${normalized.slice(0, 357)}...` : normalized;
}

function shouldBuildQualityContext(item: QualityReviewItemListItemWithEvidence): boolean {
  return item.failureType === "plan_goal_mismatch" || item.triggerSource === "plan_qa_failure" || item.triggerSource === "final_qa_failure";
}

async function attachQualityContext(db: Db, items: QualityReviewItemListItemWithEvidence[]) {
  const relevant = items.filter(shouldBuildQualityContext);
  if (relevant.length === 0) return items;

  const missionIds = Array.from(new Set(relevant.map((item) => item.missionId).filter((id): id is string => !!id)));
  const planRows = missionIds.length > 0
    ? await db
      .select({
        missionId: missionPlanArtifacts.missionId,
        missionGoal: missionPlanArtifacts.missionGoal,
        revision: missionPlanArtifacts.revision,
        updatedAt: missionPlanArtifacts.updatedAt,
      })
      .from(missionPlanArtifacts)
      .where(inArray(missionPlanArtifacts.missionId, missionIds))
      .orderBy(desc(missionPlanArtifacts.revision), desc(missionPlanArtifacts.updatedAt))
    : [];
  const missionGoalByMissionId = new Map<string, string>();
  for (const row of planRows) {
    if (!missionGoalByMissionId.has(row.missionId)) missionGoalByMissionId.set(row.missionId, row.missionGoal);
  }

  const targetIdentifiers = Array.from(new Set(relevant
    .map((item) => stringMeta(item.triggerMetadata, "targetIssueIdentifier") ?? firstIssueIdentifier(triggerReasonText(item.triggerMetadata)))
    .filter((identifier): identifier is string => !!identifier)));
  const sourceIdentifiers = Array.from(new Set(relevant
    .map((item) => stringMeta(item.triggerMetadata, "sourceIssueIdentifier"))
    .filter((identifier): identifier is string => !!identifier)));
  const identifiers = Array.from(new Set([...targetIdentifiers, ...sourceIdentifiers]));
  const issueRows = identifiers.length > 0
    ? await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        description: issues.description,
      })
      .from(issues)
      .where(inArray(issues.identifier, identifiers))
    : [];
  const issueByIdentifier = new Map(issueRows.map((row) => [row.identifier, row]));
  const issueIds = issueRows.map((row) => row.id);
  const productRows = issueIds.length > 0
    ? await db
      .select({
        issueId: issueWorkProducts.issueId,
        title: issueWorkProducts.title,
        isPrimary: issueWorkProducts.isPrimary,
        metadata: issueWorkProducts.metadata,
        createdAt: issueWorkProducts.createdAt,
      })
      .from(issueWorkProducts)
      .where(inArray(issueWorkProducts.issueId, issueIds))
      .orderBy(desc(issueWorkProducts.isPrimary), desc(issueWorkProducts.createdAt))
    : [];
  const productByIssueId = new Map<string, typeof productRows[number]>();
  for (const row of productRows) {
    if (!productByIssueId.has(row.issueId)) productByIssueId.set(row.issueId, row);
  }

  for (const item of relevant) {
    const reason = triggerReasonText(item.triggerMetadata);
    const targetIdentifier = stringMeta(item.triggerMetadata, "targetIssueIdentifier") ?? firstIssueIdentifier(reason);
    const targetIssue = targetIdentifier ? issueByIdentifier.get(targetIdentifier) : undefined;
    const targetProduct = targetIssue ? productByIssueId.get(targetIssue.id) : undefined;
    const sourceIdentifier = stringMeta(item.triggerMetadata, "sourceIssueIdentifier");
    const sourceIssue = sourceIdentifier ? issueByIdentifier.get(sourceIdentifier) : undefined;
    const workProductPath = typeof targetProduct?.metadata?.path === "string" ? targetProduct.metadata.path : null;
    item.qualityContext = {
      missionGoal: item.missionId ? missionGoalByMissionId.get(item.missionId) ?? null : null,
      target: targetIssue ? {
        issueId: targetIssue.id,
        identifier: targetIssue.identifier,
        title: targetIssue.title,
        status: targetIssue.status,
        stepId: stringMeta(item.triggerMetadata, "targetStepId") ?? sourceStepIdFromDescription(targetIssue.description),
        plannedOutput: stringMeta(item.triggerMetadata, "plannedOutput") ?? plannedOutputFromDescription(targetIssue.description),
        workProductTitle: targetProduct?.title ?? null,
        workProductPath,
      } : null,
      sourceReview: sourceIssue ? {
        issueId: sourceIssue.id,
        identifier: sourceIssue.identifier,
        title: sourceIssue.title,
        status: sourceIssue.status,
        stepId: stringMeta(item.triggerMetadata, "sourceStepId") ?? sourceStepIdFromDescription(sourceIssue.description),
      } : null,
      mismatchSummary: stringMeta(item.triggerMetadata, "mismatchSummary") ?? mismatchSummaryFromReason(reason),
      recommendedAction: stringMeta(item.triggerMetadata, "recommendedAction") ?? "Request changes and route the affected producer step for rework; do not treat the mission's completed status as a pass for this quality finding.",
      focusNote: item.missionStatus && TERMINAL_MISSION_STATUSES.has(item.missionStatus)
        ? "The mission may already be terminal. Judge this quality finding by the target step and QA evidence, not by the mission status badge."
        : "Judge the target step output against the mission goal and QA evidence.",
    };
  }
  return items;
}

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
  input: { reason?: string | null; requiredEvidenceSurfaces?: string[] },
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

function buildCorrectionIssueDescription(
  item: QualityReviewItemRow,
  input: { verdict: string; reason?: string | null; failureType?: string | null },
  followUpMissionId: string | undefined,
) {
  const lines = [
    "Quality Board requires correction before this result can be trusted.",
    "",
    `Review item: ${item.title}`,
    `Verdict: ${input.verdict}`,
    `Target: ${item.targetType}${item.targetId ? ` ${item.targetId}` : ""}`,
    `Original mission: ${item.missionId ?? "none"}`,
  ];
  if (!followUpMissionId && item.missionId) {
    lines.push("Follow-up issue is company-scoped because the original mission is already terminal or unavailable.");
  }
  const failureType = input.failureType ?? item.failureType;
  if (failureType) lines.push(`Failure type: ${failureType}`);
  if (input.reason?.trim()) {
    lines.push("", "Reason:", input.reason.trim());
  }
  lines.push(
    "",
    "Required next action:",
    "- Correct the target output against the original mission goal.",
    "- Attach fresh evidence for the final user-visible or machine-consumed surface.",
    "- Do not close this issue with only adjacent evidence such as a DB row when the user-facing URL/content is the real target.",
  );
  return lines.join("\n");
}

function buildEvaluatorImprovementIssueDescription(input: {
  anchorTitle: string;
  anchorId: string;
  evaluatorVersionId: string;
  candidateRunId: string;
  reportId?: string;
}) {
  return [
    "Quality Board created an evaluator improvement job from a promoted anchor.",
    "",
    `Anchor: ${input.anchorTitle}`,
    `Anchor id: ${input.anchorId}`,
    `Candidate evaluator version id: ${input.evaluatorVersionId}`,
    `Replay run id: ${input.candidateRunId}`,
    input.reportId ? `Daily report id: ${input.reportId}` : null,
    "",
    "Required next action:",
    "- Replay the candidate evaluator against the promoted anchor corpus.",
    "- Record coverage and regression findings before promoting any production evaluator.",
    "- Do not change the evaluator for an already-running mission; apply only to the next run or epoch.",
  ].filter((line): line is string => line !== null).join("\n");
}

function isUnresolvedEvidence(ref: Pick<QualityEvidenceRefRow, "status" | "blocking">) {
  return ref.blocking || UNRESOLVED_EVIDENCE_STATUSES.has(ref.status);
}

function todayString(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function countBy<T extends string>(values: T[]) {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
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

export interface CreateReviewItemInput {
  companyId: string;
  missionId?: string | null;
  title: string;
  targetType: string;
  targetId?: string | null;
  triggerSource: string;
  triggerMetadata?: Record<string, unknown>;
  failureType?: string | null;
  priority?: string;
  evidenceRefs?: Array<{
    surface: string;
    expected?: Record<string, unknown>;
    actual?: Record<string, unknown>;
    status?: string;
    sourceRunId?: string | null;
    sourceUrl?: string | null;
    freshnessExpiresAt?: Date | string | null;
    blocking?: boolean;
  }>;
}

export interface RequestEvidenceInput {
  reviewItemId: string;
  requestedByUserId?: string | null;
  reason?: string | null;
  requiredEvidenceSurfaces: string[];
}

export interface RecordEvidenceInput {
  reviewItemId: string;
  surface: string;
  expected?: Record<string, unknown>;
  actual?: Record<string, unknown>;
  status: string;
  collectedByActorType?: string | null;
  collectedByActorId?: string | null;
  sourceRunId?: string | null;
  sourceUrl?: string | null;
  freshnessExpiresAt?: Date | string | null;
  blocking?: boolean;
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

    const enriched = attachEvidenceRefs(items, refs as QualityEvidenceRefRow[]);
    await attachMissionSummary(db, enriched);
    return attachQualityContext(db, enriched);
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

  // [목적] needs_evidence / requestEvidence 공용: 수집 issue + missing/blocking evidence ref 기록.
  // [입력] tx(외부 트랜잭션), item, surfaces, reason. 멱등: 같은 surface 면 갱신 안 함.
  async function openEvidenceCollection(
    tx: TransactionDb,
    item: QualityReviewItemRow,
    surfaces: string[],
    reason: string | null,
  ) {
    const title = `Quality evidence required: ${item.title || item.targetType}`;
    const followUpMissionId = await resolveFollowUpMissionId(tx, item);
    await issueSvc.createFromSrb(tx, item.companyId, {
      missionId: followUpMissionId,
      title,
      description: buildEvidenceIssueDescription(item, { reason, requiredEvidenceSurfaces: surfaces }, followUpMissionId),
      status: "todo",
      originKind: EVIDENCE_ISSUE_ORIGIN,
      originId: item.id,
    });
    if (surfaces.length > 0) {
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

  // [목적] fail/request_changes 공용: correction issue 생성(producer/owner 가 수정하도록).
  async function openCorrectionFlow(
    tx: TransactionDb,
    item: QualityReviewItemRow,
    verdict: string,
    input: { reason?: string | null; failureType?: string | null },
  ) {
    const title = `Quality correction required: ${item.title || item.targetType}`;
    const followUpMissionId = await resolveFollowUpMissionId(tx, item);
    await issueSvc.createFromSrb(tx, item.companyId, {
      missionId: followUpMissionId,
      title,
      description: buildCorrectionIssueDescription(item, { verdict, ...input }, followUpMissionId),
      status: "todo",
      originKind: CORRECTION_ISSUE_ORIGIN,
      originId: item.id,
    });
  }

  // [목적] promote-anchor 호출 시 evaluator candidate version + queued replay run + improvement issue 생성.
  // [주의] replay run 이 passed 되기 전에는 production 승격 불가(promoteEvaluatorVersion 이 가드).
  async function seedEvaluatorCandidateFromAnchor(
    tx: TransactionDb,
    anchor: Awaited<ReturnType<typeof promoteVerdictToAnchorRaw>>,
  ) {
    const [version] = await tx
      .insert(evaluatorVersions)
      .values({
        companyId: anchor.companyId,
        name: `Candidate from anchor: ${anchor.title}`,
        evaluatorType: "quality_gate",
        status: "candidate",
        sourceAnchorCaseId: anchor.id,
        coverageSummary: {},
      })
      .returning();
    const [run] = await tx
      .insert(evaluatorCandidateRuns)
      .values({
        companyId: anchor.companyId,
        evaluatorVersionId: version.id,
        anchorCaseId: anchor.id,
        reviewItemId: anchor.reviewItemId,
        status: "queued",
        replayInput: { anchorId: anchor.id, failureType: anchor.failureType },
      })
      .returning();
    const followUpMissionId = anchor.missionId
      ? await resolveFollowUpMissionId(tx, {
          id: anchor.reviewItemId,
          companyId: anchor.companyId,
          missionId: anchor.missionId,
        } as QualityReviewItemRow)
      : undefined;
    await issueSvc.createFromSrb(tx, anchor.companyId, {
      missionId: followUpMissionId,
      title: `Evaluator improvement job: ${anchor.title}`,
      description: buildEvaluatorImprovementIssueDescription({
        anchorTitle: anchor.title,
        anchorId: anchor.id,
        evaluatorVersionId: version.id,
        candidateRunId: run.id,
      }),
      status: "todo",
      originKind: IMPROVEMENT_ISSUE_ORIGIN,
      originId: version.id,
    });
    // review item 을 replay 대기 상태로 표시(이미 닫혀 있으면 유지).
    await tx
      .update(qualityReviewItems)
      .set({ status: "evaluator_replay_queued", updatedAt: new Date() })
      .where(
        and(
          eq(qualityReviewItems.id, anchor.reviewItemId),
          eq(qualityReviewItems.companyId, anchor.companyId),
        ),
      );
    return { version, run };
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

      // Verdict routing (plan 8.2): needs_evidence -> evidence collection;
      // fail/request_changes -> correction issue. pass/dismissed just close.
      if (input.verdict === "needs_evidence") {
        await openEvidenceCollection(tx, item, surfaces, input.reason ?? null);
      } else if (input.verdict === "fail" || input.verdict === "request_changes") {
        await openCorrectionFlow(tx, item, input.verdict, input);
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

  // [목적] human 판정 → anchor case 승격 + evaluator candidate version/replay/improvement job 까지 한 트랜잭션.
  async function promoteVerdictToAnchor(input: PromoteAnchorInput) {
    return db.transaction(async (tx) => {
      const anchor = await promoteVerdictToAnchorRaw(tx, input);
      await seedEvaluatorCandidateFromAnchor(tx, anchor);
      return anchor;
    });
  }

  async function promoteVerdictToAnchorRaw(tx: QualityWriteDb, input: PromoteAnchorInput) {
    const [verdict] = await tx
      .select()
      .from(missionQualityVerdicts)
      .where(eq(missionQualityVerdicts.id, input.verdictId))
      .limit(1);
    if (!verdict || verdict.reviewItemId !== input.reviewItemId) {
      throw notFound("Quality verdict not found for this review item");
    }

    const evidenceRefs = await tx
      .select({
        surface: qualityEvidenceRefs.surface,
        status: qualityEvidenceRefs.status,
        blocking: qualityEvidenceRefs.blocking,
        sourceUrl: qualityEvidenceRefs.sourceUrl,
      })
      .from(qualityEvidenceRefs)
      .where(eq(qualityEvidenceRefs.reviewItemId, input.reviewItemId));

    const [anchor] = await tx
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

  // [목적] review item 자동/수동 생성. 같은 대상의 열린 item 이 있으면 멱등 반환(created:false).
  // [외부 연결] final QA / delivery gate / oversight / user feedback 가 호출(plan 8.1).
  async function createReviewItem(input: CreateReviewItemInput): Promise<{
    reviewItem: QualityReviewItemListItemWithEvidence;
    created: boolean;
  }> {
    // [주의] dedupe: 같은 대상의 "열린" item 만 재사용. closed/resolved/promoted 는 새 item.
    //   targetId 없으면 null 매칭(isNull). 빈 문자열 매칭은 insert 가 null 이라 놓침.
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

    let itemId: string;
    let created = false;
    const openExisting = existing.find((e) => !CLOSED_REVIEW_ITEM_STATUSES.has(e.status));
    if (openExisting) {
      itemId = openExisting.id;
    } else {
      try {
        const [row] = await db
          .insert(qualityReviewItems)
          .values({
            companyId: input.companyId,
            missionId: input.missionId ?? null,
            title: input.title,
            status: "awaiting_review",
            targetType: input.targetType,
            targetId: input.targetId ?? null,
            triggerSource: input.triggerSource,
            triggerMetadata: input.triggerMetadata ?? {},
            failureType: input.failureType ?? null,
            priority: input.priority ?? "medium",
          })
          .returning();
        itemId = row.id;
        created = true;
        if (input.evidenceRefs && input.evidenceRefs.length > 0) {
          await db.insert(qualityEvidenceRefs).values(
            input.evidenceRefs.map((r) => ({
              companyId: input.companyId,
              reviewItemId: itemId,
              surface: r.surface,
              expected: r.expected ?? {},
              actual: r.actual ?? {},
              status: r.status ?? "missing",
              sourceRunId: r.sourceRunId ?? null,
              sourceUrl: r.sourceUrl ?? null,
              freshnessExpiresAt: r.freshnessExpiresAt ? new Date(r.freshnessExpiresAt) : null,
              blocking: r.blocking ?? true,
            })),
          );
        }
      } catch (err) {
        // [주의] 동시 삽입 race: partial unique index(0070) 가 잡음 → 상대가 먼저 넣은 open item 재조회.
        if (isUniqueViolation(err)) {
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
          const reconOpen = recon.find((r) => r.id);
          if (!reconOpen) throw err;
          itemId = reconOpen.id;
        } else {
          throw err;
        }
      }
    }
    const reviewItem = await getReviewItemDetail(itemId);
    return { reviewItem, created };
  }

  // [목적] verdict 없이 독립적으로 evidence 수집 요청(plan 8.3). 상태를 evidence_collecting 으로.
  async function requestEvidence(input: RequestEvidenceInput): Promise<{ reviewItem: QualityReviewItemListItemWithEvidence }> {
    const item = await loadReviewItem(input.reviewItemId);
    const surfaces = input.requiredEvidenceSurfaces.map((s) => s.trim()).filter(Boolean);
    await db.transaction(async (tx) => {
      await tx
        .update(qualityReviewItems)
        .set({ status: "evidence_collecting", updatedAt: new Date() })
        .where(eq(qualityReviewItems.id, item.id));
      await openEvidenceCollection(tx, item, surfaces, input.reason ?? null);
    });
    const reviewItem = await getReviewItemDetail(item.id);
    return { reviewItem };
  }

  // [목적] 증거 수집 결과 기록. 모든 blocking/unresolved 해소되면 awaiting_review 로 복귀(폐루프 8.3).
  async function recordEvidence(input: RecordEvidenceInput): Promise<{ reviewItem: QualityReviewItemListItemWithEvidence }> {
    const item = await loadReviewItem(input.reviewItemId);
    await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: qualityEvidenceRefs.id })
        .from(qualityEvidenceRefs)
        .where(
          and(
            eq(qualityEvidenceRefs.reviewItemId, item.id),
            eq(qualityEvidenceRefs.surface, input.surface),
          ),
        )
        .limit(1);
      const status = input.status;
      const blocking = input.blocking ?? UNRESOLVED_EVIDENCE_STATUSES.has(status);
      const payload = {
        companyId: item.companyId,
        reviewItemId: item.id,
        surface: input.surface,
        expected: input.expected ?? {},
        actual: input.actual ?? {},
        status,
        collectedByActorType: input.collectedByActorType ?? null,
        collectedByActorId: input.collectedByActorId ?? null,
        sourceRunId: input.sourceRunId ?? null,
        sourceUrl: input.sourceUrl ?? null,
        freshnessExpiresAt: input.freshnessExpiresAt ? new Date(input.freshnessExpiresAt) : null,
        blocking,
      };
      if (existing) {
        await tx
          .update(qualityEvidenceRefs)
          .set({ ...payload, updatedAt: new Date() })
          .where(eq(qualityEvidenceRefs.id, existing.id));
      } else {
        await tx.insert(qualityEvidenceRefs).values(payload);
      }

      const refs = await tx
        .select({ status: qualityEvidenceRefs.status, blocking: qualityEvidenceRefs.blocking })
        .from(qualityEvidenceRefs)
        .where(eq(qualityEvidenceRefs.reviewItemId, item.id));
      const stillUnresolved = refs.some((r) => isUnresolvedEvidence(r));
      const nextStatus = stillUnresolved ? "evidence_collecting" : "awaiting_review";
      await tx
        .update(qualityReviewItems)
        .set({ status: nextStatus, updatedAt: new Date() })
        .where(eq(qualityReviewItems.id, item.id));
    });
    const reviewItem = await getReviewItemDetail(item.id);
    return { reviewItem };
  }

  async function getReviewItemDetail(reviewItemId: string): Promise<QualityReviewItemListItemWithEvidence> {
    const item = await loadReviewItem(reviewItemId);
    const refs = await db
      .select()
      .from(qualityEvidenceRefs)
      .where(eq(qualityEvidenceRefs.reviewItemId, reviewItemId))
      .orderBy(asc(qualityEvidenceRefs.surface), asc(qualityEvidenceRefs.createdAt));
    const enriched = attachEvidenceRefs([item], refs as QualityEvidenceRefRow[]);
    await attachMissionSummary(db, enriched);
    await attachQualityContext(db, enriched);
    return enriched[0];
  }

  async function listAnchorCases(companyId: string) {
    return db
      .select()
      .from(evaluatorAnchorCases)
      .where(eq(evaluatorAnchorCases.companyId, companyId))
      .orderBy(desc(evaluatorAnchorCases.createdAt));
  }

  // [목적] Quality 요약 카운트. UI 헤더 + daily report 입력.
  async function getQualitySummary(companyId: string) {
    const [items, refs, anchors, versions, reports] = await Promise.all([
      db
        .select({ status: qualityReviewItems.status })
        .from(qualityReviewItems)
        .where(eq(qualityReviewItems.companyId, companyId)),
      db
        .select({ status: qualityEvidenceRefs.status, blocking: qualityEvidenceRefs.blocking })
        .from(qualityEvidenceRefs)
        .where(eq(qualityEvidenceRefs.companyId, companyId)),
      db
        .select({ status: evaluatorAnchorCases.status })
        .from(evaluatorAnchorCases)
        .where(eq(evaluatorAnchorCases.companyId, companyId)),
      db
        .select({ status: evaluatorVersions.status })
        .from(evaluatorVersions)
        .where(eq(evaluatorVersions.companyId, companyId)),
      db
        .select({ id: qualityDailyReports.id })
        .from(qualityDailyReports)
        .where(eq(qualityDailyReports.companyId, companyId)),
    ]);
    const openReviewItems = items.filter((i) => !CLOSED_REVIEW_ITEM_STATUSES.has(i.status)).length;
    const blockingEvidenceGaps = refs.filter((r) => isUnresolvedEvidence(r)).length;
    return {
      openReviewItems,
      blockingEvidenceGaps,
      anchorCandidates: anchors.filter((a) => a.status === "candidate").length,
      candidateEvaluators: versions.filter((v) => v.status === "candidate").length,
      dailyReports: reports.length,
    };
  }

  async function listEvaluatorVersions(companyId: string) {
    return db
      .select()
      .from(evaluatorVersions)
      .where(eq(evaluatorVersions.companyId, companyId))
      .orderBy(desc(evaluatorVersions.createdAt));
  }

  async function listDailyReports(companyId: string) {
    return db
      .select()
      .from(qualityDailyReports)
      .where(eq(qualityDailyReports.companyId, companyId))
      .orderBy(desc(qualityDailyReports.reportDate));
  }

  async function listCandidateRuns(companyId: string, versionId?: string) {
    return db
      .select()
      .from(evaluatorCandidateRuns)
      .where(
        versionId
          ? and(eq(evaluatorCandidateRuns.companyId, companyId), eq(evaluatorCandidateRuns.evaluatorVersionId, versionId))
          : eq(evaluatorCandidateRuns.companyId, companyId),
      )
      .orderBy(desc(evaluatorCandidateRuns.createdAt));
  }

  // [목적] candidate evaluator replay 실행(v1 결정론적). regression 없으면 passed.
  async function runCandidateReplay(companyId: string, runId: string, input: { regressions?: number; resultSummary?: string }) {
    const [run] = await db
      .select()
      .from(evaluatorCandidateRuns)
      .where(and(eq(evaluatorCandidateRuns.id, runId), eq(evaluatorCandidateRuns.companyId, companyId)))
      .limit(1);
    if (!run) throw notFound("Evaluator candidate run not found");
    const passed = (input.regressions ?? 0) <= 0;
    const [updated] = await db
      .update(evaluatorCandidateRuns)
      .set({
        status: passed ? "passed" : "failed",
        replayResult: { evaluatedAt: new Date().toISOString(), regressions: input.regressions ?? 0, passed },
        resultSummary: input.resultSummary ?? (passed ? "Replay passed with no regressions." : "Replay found regressions."),
        updatedAt: new Date(),
      })
      .where(eq(evaluatorCandidateRuns.id, runId))
      .returning();
    return updated;
  }

  // [목적] candidate → production 승격. passed replay 가 있어야만(폐루프 8.4 가드).
  async function promoteEvaluatorVersion(companyId: string, versionId: string) {
    const [version] = await db
      .select()
      .from(evaluatorVersions)
      .where(and(eq(evaluatorVersions.id, versionId), eq(evaluatorVersions.companyId, companyId)))
      .limit(1);
    if (!version) throw notFound("Evaluator version not found");
    const passed = await db
      .select({ id: evaluatorCandidateRuns.id })
      .from(evaluatorCandidateRuns)
      .where(
        and(
          eq(evaluatorCandidateRuns.evaluatorVersionId, versionId),
          eq(evaluatorCandidateRuns.status, "passed"),
        ),
      )
      .limit(1);
    if (passed.length === 0) {
      throw unprocessable("Cannot promote evaluator before a passed replay run exists");
    }
    const [updated] = await db
      .update(evaluatorVersions)
      .set({ status: "production", promotedAt: new Date(), updatedAt: new Date() })
      .where(eq(evaluatorVersions.id, versionId))
      .returning();
    // 출처 review item 들을 evaluator_promoted 표시.
    const runs = await db
      .select({ reviewItemId: evaluatorCandidateRuns.reviewItemId })
      .from(evaluatorCandidateRuns)
      .where(eq(evaluatorCandidateRuns.evaluatorVersionId, versionId));
    for (const r of runs) {
      if (r.reviewItemId) {
        await db
          .update(qualityReviewItems)
          .set({ status: "evaluator_promoted", updatedAt: new Date() })
          .where(eq(qualityReviewItems.id, r.reviewItemId));
      }
    }
    return updated;
  }

  // [목적] 일일 품질 보고서 생성(plan 8.5). (companyId, reportDate) 로 upsert.
  async function generateDailyReport(companyId: string, reportDate?: string) {
    const date = reportDate ?? todayString();
    const [items, refs, anchors, versions] = await Promise.all([
      db
        .select({
          status: qualityReviewItems.status,
          failureType: qualityReviewItems.failureType,
        })
        .from(qualityReviewItems)
        .where(eq(qualityReviewItems.companyId, companyId)),
      db
        .select({ surface: qualityEvidenceRefs.surface, status: qualityEvidenceRefs.status, blocking: qualityEvidenceRefs.blocking })
        .from(qualityEvidenceRefs)
        .where(eq(qualityEvidenceRefs.companyId, companyId)),
      db
        .select({ id: evaluatorAnchorCases.id, status: evaluatorAnchorCases.status })
        .from(evaluatorAnchorCases)
        .where(eq(evaluatorAnchorCases.companyId, companyId)),
      db
        .select({ sourceAnchorCaseId: evaluatorVersions.sourceAnchorCaseId })
        .from(evaluatorVersions)
        .where(eq(evaluatorVersions.companyId, companyId)),
    ]);

    const failureTypeCounts = countBy(items.map((i) => i.failureType ?? "unknown").filter((f) => f !== "unknown"));
    const evidenceSurfaceStats: Record<string, { failed: number; missing: number; total: number }> = {};
    for (const r of refs) {
      const bucket = (evidenceSurfaceStats[r.surface] ??= { failed: 0, missing: 0, total: 0 });
      bucket.total += 1;
      if (r.status === "failed") bucket.failed += 1;
      if (r.status === "missing" || r.blocking) bucket.missing += 1;
    }
    const coveredAnchorIds = new Set(versions.map((v) => v.sourceAnchorCaseId).filter((v): v is string => v !== null));
    const anchorCoverageGaps = anchors.filter((a) => a.status === "candidate" && !coveredAnchorIds.has(a.id)).length;
    const summary = {
      failureTypeCounts,
      evidenceSurfaceStats,
      pendingReviewItems: items.filter((i) => i.status === "awaiting_review").length,
      needsEvidenceOutstanding: items.filter((i) => i.status === "evidence_collecting").length,
      anchorCoverageGaps,
      improvementCandidates: anchorCoverageGaps,
    };

    const [existing] = await db
      .select({ id: qualityDailyReports.id })
      .from(qualityDailyReports)
      .where(and(eq(qualityDailyReports.companyId, companyId), eq(qualityDailyReports.reportDate, date)))
      .limit(1);
    const hasBlockingGap = refs.some((r) => isUnresolvedEvidence(r));
    const status = summary.needsEvidenceOutstanding > 0 || hasBlockingGap ? "needs_attention" : "generated";
    if (existing) {
      const [updated] = await db
        .update(qualityDailyReports)
        .set({ summary, status, updatedAt: new Date() })
        .where(eq(qualityDailyReports.id, existing.id))
        .returning();
      return updated;
    }
    const [created] = await db
      .insert(qualityDailyReports)
      .values({ companyId, reportDate: date, status, summary })
      .returning();
    return created;
  }

  // [목적] Phase 5 자동 trigger 진입점들(plan 8.1). 감시/배포 검증 실패를 review item 으로.
  //   targetId 로 좁혀 dedupe(회사 단위 과잉 누적 방지). 감시/루프는 await+try/catch 로 관측 가능.
  async function createOversightStallReviewItem(input: {
    companyId: string;
    missionId: string;
    missionTitle: string;
  }) {
    return createReviewItem({
      companyId: input.companyId,
      missionId: input.missionId,
      title: `Oversight stall: plan submission missing — ${input.missionTitle}`,
      targetType: "mission_output",
      triggerSource: "oversight_stall",
      targetId: input.missionId,
      failureType: "plan_submission_missing",
      priority: "high",
    });
  }

  async function createDeliveryFailureReviewItem(input: {
    companyId: string;
    missionId?: string | null;
    stepId: string;
    targetUrl?: string | null;
    /** 수집자가 무엇을 어디서 확인해야 하는지 알 수 있게 expected/triggerMetadata 에 들어간다. */
    context?: {
      workflowRunId?: string | null;
      qaIssueId?: string | null;
      producerStepId?: string | null;
    };
  }) {
    const ctx = input.context ?? {};
    // dedupe 단위를 run 까지 좁힌다: URL > run:qaIssue > run:step > qaIssue > step.
    const fallback = ctx.qaIssueId ?? input.stepId;
    const targetId = input.targetUrl ?? (ctx.workflowRunId ? `${ctx.workflowRunId}:${fallback}` : fallback);
    const expected = {
      workflowRunId: ctx.workflowRunId ?? null,
      qaStepId: input.stepId,
      qaIssueId: ctx.qaIssueId ?? null,
      producerStepId: ctx.producerStepId ?? null,
    };
    return createReviewItem({
      companyId: input.companyId,
      missionId: input.missionId ?? null,
      title: `Delivery verification failed: ${input.stepId}`,
      targetType: "public_url",
      triggerSource: "delivery_verification",
      targetId,
      failureType: "delivery_url_404",
      priority: "high",
      triggerMetadata: ctx,
      evidenceRefs: [
        { surface: "public_url", status: "missing", blocking: true, expected },
        { surface: "browser_readback", status: "missing", blocking: true, expected },
      ],
    });
  }

  // [목적] mission quality contract / QA 목적 적합성 실패 → review item. plan 8.1.
  //   caller 가 triggerSource(plan_qa_failure | final_qa_failure) 와 failureType 을 고른다.
  //   targetId = missionId 로 미션 단위 dedupe.
  async function createMissionQualityFailureReviewItem(input: {
    companyId: string;
    missionId: string;
    missionTitle?: string | null;
    triggerSource: "plan_qa_failure" | "final_qa_failure";
    failureType?: string | null;
    reason?: string | null;
  }) {
    const missionTitle = input.missionTitle?.trim() || `mission ${input.missionId}`;
    return createReviewItem({
      companyId: input.companyId,
      missionId: input.missionId,
      title: `${input.triggerSource === "plan_qa_failure" ? "Plan QA" : "Final QA"} / purpose-fitness failure — ${missionTitle}`,
      targetType: "mission_output",
      triggerSource: input.triggerSource,
      targetId: input.missionId,
      failureType: input.failureType ?? "plan_goal_mismatch",
      priority: "high",
      triggerMetadata: input.reason ? { reason: input.reason } : {},
    });
  }


  return {
    listCompanyQualityReviewItems,
    getReviewItemOwnership,
    createOversightStallReviewItem,
    createDeliveryFailureReviewItem,
    createMissionQualityFailureReviewItem,
    getReviewItemDetail,
    createReviewItem,
    requestEvidence,
    recordEvidence,
    recordQualityVerdict,
    promoteVerdictToAnchor,
    listAnchorCases,
    getQualitySummary,
    listEvaluatorVersions,
    listCandidateRuns,
    listDailyReports,
    runCandidateReplay,
    promoteEvaluatorVersion,
    generateDailyReport,
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

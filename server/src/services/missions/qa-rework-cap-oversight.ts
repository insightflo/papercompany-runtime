// server/src/services/missions/qa-rework-cap-oversight.ts
//
// [ purpose ] QA rework cap exhaustion → Mission Owner (Oversight) handoff.
//   Lease/fencing token in correlationId ensures single-owner create+link.
//   Append-only claim (never deleted). SHA256 key for safe dedupe.
//   Wake dispatch always verifies authoritative DB outcome.

import { createHash, randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { issues, workflowTransitionEvents } from "@paperclipai/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { MissionRow } from "../missions.js";
import type { MissionServiceDeps } from "../missions.js";
import type { IssueCreateInput, IssueRow } from "./shared-types.js";
import { detectQaReworkCapExhaustion } from "./qa-rework-cap-oversight-detection.js";
import { dispatchCapWake } from "./qa-rework-cap-oversight-wake.js";
import { loadLatestMissionOwnerDecision } from "./mission-owner-recovery-ledger.js";

export type { QaReworkCapExhaustion } from "./qa-rework-cap-oversight-detection.js";
export { detectQaReworkCapExhaustion } from "./qa-rework-cap-oversight-detection.js";
import type { QaReworkCapExhaustion } from "./qa-rework-cap-oversight-detection.js";

// ---------------------------------------------------------------------------
// Key / marker (SHA256 — safe from LIKE/colon metacharacters in step IDs)
// ---------------------------------------------------------------------------

export const QA_CAP_KEY_PREFIX = "qa-cap-key";

/** SHA256 hash of the exact generation tuple (companyId+run+producer+QA+iter+completedAt). */
export function buildQaCapKeyHash(input: {
  companyId: string; workflowRunId: string;
  producerStepId: string; qaStepId: string;
  producerIteration: number; producerCompletedAt: string;
}): string {
  const raw = JSON.stringify([
    input.companyId,
    input.workflowRunId,
    input.producerStepId,
    input.qaStepId,
    input.producerIteration,
    input.producerCompletedAt,
  ]);
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

/** The idempotency key used for the atomic transition-event claim. */
export function buildQaCapClaimIdempotencyKey(keyHash: string): string {
  return `qa-cap-oversight:${keyHash}`;
}

/** The marker comment embedded in the issue description (safe hex, LIKE-safe). */
export function buildQaCapKeyMarker(keyHash: string): string {
  return `${QA_CAP_KEY_PREFIX}:${keyHash}`;
}

const KEY_RE = /qa-cap-key:([0-9a-f]{32})/;

/** Detect a cap-oversight key marker in an issue description. */
export function isQaReworkCapOversightIssue(
  description: string | null | undefined,
): boolean {
  if (!description) return false;
  return KEY_RE.test(description);
}

const PRODUCER_SOURCE_ISSUE_RE = /^Producer source issue:\s*([0-9a-f-]{36}|[A-Z]+-\d+)\s*$/im;
const QA_STEP_ID_RE = /^QA: step\s+([A-Za-z0-9_-]+)\s*$/im;

/**
 * [cap-oversight producer authority] qa-cap-oversight 이슈 설명의 "Producer source issue:" 라인에서
 *   producer issue id/identifier 를 추출한다. 이 이슈의 origin 은 oversight issue(스텝 없음)라
 *   supervision 의 DAG 역추적이 producer 를 찾지 못하는 갭을 메우는 유일한 구조 경로다.
 *   자연어 코멘트가 아니라 시스템이 생성한 설명이므로 신뢰 가능한 입력.
 */
export function extractQaCapProducerIssueRef(
  description: string | null | undefined,
): string | null {
  if (!description) return null;
  const match = PRODUCER_SOURCE_ISSUE_RE.exec(description);
  const ref = match?.[1]?.trim();
  return ref ? ref : null;
}

/**
 * [cap-oversight QA gate authority] qa-cap-oversight 이슈 설명의 "QA: step <stepId>" 라인에서
 *   QA step id 를 추출한다. producer rework authorization 의 fresh REQUEST_CHANGES 검증이
 *   QA 게이트 이슈를 찾는 데 쓴다(origin 이 oversight 라 resolveQaGateIssueId 가 null 인 갭 보완).
 */
export function extractQaCapQaStepId(
  description: string | null | undefined,
): string | null {
  if (!description) return null;
  const match = QA_STEP_ID_RE.exec(description);
  const ref = match?.[1]?.trim();
  return ref ? ref : null;
}

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

export function buildQaReworkCapDescription(input: {
  keyMarker: string;
  exhaustion: QaReworkCapExhaustion;
  missionTitle: string;
  workflowName: string;
  rejectTrend?: { readonly count: number; readonly latestReason: string | null } | null;
}): string {
  const { keyMarker, exhaustion, missionTitle, workflowName, rejectTrend } = input;
  return [
    "## QA rework cap exhausted — owner decision required",
    "",
    `<!-- ${keyMarker} -->`,
    "",
    `Mission: ${missionTitle}`,
    `Workflow: ${workflowName} (run ${exhaustion.workflowRunId})`,
    "",
    `Producer: step ${exhaustion.producerStepId} (iteration ${exhaustion.producerIteration}/${exhaustion.maxIterations}, completed ${exhaustion.producerCompletedAt || "unknown"})`,
    `Producer source issue: ${exhaustion.producerIssueId ?? "(unknown)"}`,
    `QA: step ${exhaustion.qaStepId}`,
    ...((rejectTrend && rejectTrend.count >= 2)
      ? [
        "",
        `Consecutive QA rejects on this gate: ${rejectTrend.count}`,
        "- 직전 재시도들도 같은 게이트에서 반려됐다. output 파일 패치가 아닌 원천(생성기/템플릿/스킬) 수준의 근본 원인을 먼저 의심하고, 근거를 확인한 뒤에만 retry_source_issue 를 승인할 것. (Repeated identical rejects — suspect a source-level root cause, not an output patch, before approving another retry.)",
        ...(rejectTrend.latestReason ? [`- Latest QA defect: ${rejectTrend.latestReason}`] : []),
      ]
      : []),
    "",
    "The producer has exhausted its QA rework cap.",
    "The semantic QA step is still requesting changes. Automatic rework will not retry beyond this cap.",
    "",
    "### Allowed owner decisions",
    "Submit a structured decision to `POST /api/issues/:id/owner-recovery/decision` with one of:",
    `- \`decision: retry_source_issue\` — retry the producer beyond the cap (explicit override).`,
    "  Use the exact producer source issue so supervision dispatches to the producer, not this oversight issue:",
    `  \`Rework target: ${exhaustion.producerIssueId ?? "<producerIssueId>"}\``,
    "- `decision: replan_mission` — replan the mission with a new approach.",
    "- `decision: escalate` — escalate to a human operator.",
    "- `decision: report_impossible` — mark completion as impossible with evidence.",
    "- `decision: request_input` — request additional input or clarification.",
    "Comments and QA-cap markers are display-only and cannot authorize a retry or wakeup.",
    "",
    "Do not auto-retry. Wait for an explicit decision.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Atomic create / reuse + wake
// ---------------------------------------------------------------------------

const STALE_CLAIM_MS = 60_000;

/** Parse epoch ms from a lease token (`lease:<epochMs>:<nonce>`). */
function parseLeaseEpoch(cid: string | null): number | null {
  const m = cid?.match(/^lease:(\d+):/);
  return m ? parseInt(m[1], 10) : null;
}
export interface EnsureQaCapResult {
  issue: IssueRow;
  created: boolean;
}

/**
 * Lease/fencing create+link. Issues are created HIDDEN, then atomically
 * linked+unhidden via fencedLinkAndUnhide. A crash at any point leaves only
 * hidden orphans — never visible ones.
 */
export async function ensureQaReworkCapOversightIssue(input: {
  db: Db;
  mission: MissionRow;
  oversightIssue: IssueRow;
  exhaustion: QaReworkCapExhaustion;
  workflowName: string;
  rejectTrend?: { readonly count: number; readonly latestReason: string | null } | null;
  createIssue: (companyId: string, data: IssueCreateInput) => Promise<IssueRow>;
  onOwnerActionCreated: MissionServiceDeps["onOwnerActionCreated"];
}): Promise<EnsureQaCapResult | null> {
  const { db, mission, oversightIssue, exhaustion, workflowName, createIssue } = input;
  const onOwnerActionCreated = input.onOwnerActionCreated;
  if (!onOwnerActionCreated) throw new Error("qa-cap-oversight: onOwnerActionCreated callback is required");
  const keyHash = buildQaCapKeyHash({
    companyId: mission.companyId, workflowRunId: exhaustion.workflowRunId,
    producerStepId: exhaustion.producerStepId, qaStepId: exhaustion.qaStepId,
    producerIteration: exhaustion.producerIteration, producerCompletedAt: exhaustion.producerCompletedAt,
  });
  const idempotencyKey = buildQaCapClaimIdempotencyKey(keyHash);
  const keyMarker = buildQaCapKeyMarker(keyHash);
  const wakeInput = { db, mission, oversightIssue, exhaustion, keyHash, onOwnerActionCreated };
  let claim: typeof workflowTransitionEvents.$inferSelect | null = null;

  const linkedIssueId = async (): Promise<string | null> => {
    const [row] = await db.select({ issueId: workflowTransitionEvents.issueId })
      .from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, claim!.id)).limit(1);
    return row?.issueId ?? null;
  };

  // 1. Atomic claim insert with lease token (append-only — never deleted).
  const leaseToken = `lease:${Date.now()}:${randomUUID().slice(0, 8)}`;
  const claimRows = await db.insert(workflowTransitionEvents).values({
    companyId: mission.companyId, missionId: mission.id,
    workflowRunId: exhaustion.workflowRunId, workflowStepRunId: exhaustion.qaStepRunId,
    eventType: "qa_cap_oversight_claim", layer: "workflow_validation",
    idempotencyKey, correlationId: leaseToken,
    payload: { kind: "qa_cap_oversight_claim", keyHash, ...exhaustion },
  }).onConflictDoNothing().returning({ id: workflowTransitionEvents.id });
  const isClaimWinner = claimRows.length > 0;

  // 2. Load claim. If already linked → reuse.
  [claim] = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, mission.companyId),
    eq(workflowTransitionEvents.idempotencyKey, idempotencyKey),
  )).limit(1);
  if (!claim) return null;
  if (claim.issueId) return reuseExistingIssue(wakeInput, claim.issueId);

  // 3. Determine lease ownership.
  let myLeaseToken: string | null = isClaimWinner ? leaseToken : null;
  if (!isClaimWinner) {
    const leaseEpoch = parseLeaseEpoch(claim.correlationId);
    if (leaseEpoch === null) return null;
    if (Date.now() - leaseEpoch <= STALE_CLAIM_MS) return null;
    const newToken = `lease:${Date.now()}:${randomUUID().slice(0, 8)}`;
    const takeover = await db.update(workflowTransitionEvents).set({ correlationId: newToken })
      .where(and(
        eq(workflowTransitionEvents.id, claim.id), isNull(workflowTransitionEvents.issueId),
        eq(workflowTransitionEvents.correlationId, claim.correlationId!),
      )).returning({ id: workflowTransitionEvents.id });
    if (takeover.length === 0) {
      const li = await linkedIssueId();
      return li ? reuseExistingIssue(wakeInput, li) : null;
    }
    myLeaseToken = newToken;
  }
  if (!myLeaseToken) return null;

  // 4. Marker scan INCLUDING hidden — a hidden crash-orphan can be reused.
  const existing = await db.select().from(issues).where(and(
    eq(issues.companyId, mission.companyId), eq(issues.missionId, mission.id),
    eq(issues.originKind, "mission_main_executor_unblock"),
    sql`${issues.description} like ${`%${keyMarker}%`}`,
  )).limit(1);
  if (existing.length > 0) {
    const ok = await fencedLinkAndUnhide(db, claim.id, existing[0]!.id, myLeaseToken, mission.companyId);
    if (!ok) return null;
    return reuseExistingIssue(wakeInput, existing[0]!.id);
  }

  // 5. Create issue HIDDEN at INSERT time — no visible window even on crash.
  const description = buildQaReworkCapDescription({ keyMarker, exhaustion, missionTitle: mission.title, workflowName, rejectTrend: input.rejectTrend ?? null });
  const parentId = oversightIssue.parentId ? undefined : oversightIssue.id;
  const rawIssue = await createIssue(mission.companyId, {
    assigneeAgentId: mission.ownerAgentId, description, missionId: mission.id,
    originKind: "mission_main_executor_unblock", originId: oversightIssue.id,
    parentId, priority: "high", status: "todo", hiddenAt: new Date(),
    title: `[QA Cap] Producer ${exhaustion.producerStepId} cap exhausted — owner decision required`,
  });

  // 6. Atomic fenced link+unhide. CAS failure → issue stays hidden, no visible orphan.
  const ok = await fencedLinkAndUnhide(db, claim.id, rawIssue.id, myLeaseToken, mission.companyId);
  if (!ok) return null;

  // 7. Re-read the now-visible issue for dispatch/return.
  const [issue] = await db.select().from(issues).where(eq(issues.id, rawIssue.id)).limit(1);
  if (!issue || issue.hiddenAt) return null;
  await dispatchCapWake({
    db, mission, issue, oversightIssue,
    workflowRunId: exhaustion.workflowRunId, keyHash, onOwnerActionCreated,
  });
  return { issue, created: true };
}

/** Atomic transaction: CAS-link claim (exact lease token) + unhide issue. Company-scoped. Throw on unhide miss → rollback. */
export async function fencedLinkAndUnhide(db: Db, claimId: string, issueId: string, leaseToken: string, companyId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const linked = await tx.update(workflowTransitionEvents).set({ issueId })
      .where(and(
        eq(workflowTransitionEvents.id, claimId), isNull(workflowTransitionEvents.issueId),
        eq(workflowTransitionEvents.correlationId, leaseToken),
      )).returning({ id: workflowTransitionEvents.id });
    if (linked.length === 0) return false;
    const unhid = await tx.update(issues).set({ hiddenAt: null, updatedAt: new Date() })
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .returning({ id: issues.id });
    if (unhid.length === 0) throw new Error(`qa-cap-oversight: issue ${issueId} unhide failed (company scope)`);
    return true;
  });
}

interface WakeInput {
  db: Db; mission: MissionRow; oversightIssue: IssueRow;
  exhaustion: QaReworkCapExhaustion; keyHash: string;
  onOwnerActionCreated: NonNullable<MissionServiceDeps["onOwnerActionCreated"]>;
}

async function reuseExistingIssue(wakeInput: WakeInput, issueId: string): Promise<EnsureQaCapResult> {
  const { db, mission, oversightIssue } = wakeInput;
  const [issue] = await db.select().from(issues).where(and(
    eq(issues.id, issueId), eq(issues.companyId, mission.companyId),
    eq(issues.missionId, mission.id), eq(issues.originKind, "mission_main_executor_unblock"),
  )).limit(1);
  if (!issue) throw new Error(`qa-cap-oversight: linked issue ${issueId} not found`);
  if (issue.hiddenAt) await db.update(issues).set({ hiddenAt: null, updatedAt: new Date() }).where(eq(issues.id, issueId));
  await reconcileOrphanIssues(db, mission.companyId, mission.id, buildQaCapKeyMarker(wakeInput.keyHash), issue.id);
  const ownerDecision = await loadLatestMissionOwnerDecision({
    db,
    companyId: mission.companyId,
    ownerActionIssueId: issue.id,
  });
  const hasOwnerDecision = Boolean(ownerDecision);
  if (!hasOwnerDecision) {
    await dispatchCapWake({
      db, mission, issue, oversightIssue,
      workflowRunId: wakeInput.exhaustion.workflowRunId,
      keyHash: wakeInput.keyHash, onOwnerActionCreated: wakeInput.onOwnerActionCreated,
    });
  }
  return { issue, created: false };
}

/** Defense-line: hide visible orphan marker issues except the linked one. */
async function reconcileOrphanIssues(db: Db, companyId: string, missionId: string, keyMarker: string, linkedId: string): Promise<void> {
  const visible = await db.select({ id: issues.id }).from(issues).where(and(
    eq(issues.companyId, companyId), eq(issues.missionId, missionId),
    eq(issues.originKind, "mission_main_executor_unblock"), isNull(issues.hiddenAt),
    sql`${issues.description} like ${`%${keyMarker}%`}`,
  ));
  const orphans = visible.filter((r) => r.id !== linkedId).map((r) => r.id);
  if (orphans.length > 0) await db.update(issues).set({ hiddenAt: new Date() }).where(inArray(issues.id, orphans));
}
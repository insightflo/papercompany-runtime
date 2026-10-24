import { and, desc, eq, gte, isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, workflowStepOutputBindings, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { parseQaCorrectionEventPayload } from "./control-flow/qa-correction-contract.js";
import { createQaCorrectionHistorySession } from "./control-flow/qa-correction-history-session.js";
import { readIssuedQaCorrectionFollowup, readQaCorrectionFollowupConsumption } from "./control-flow/qa-correction-followup.js";
import type { QaCorrectionDb } from "./control-flow/qa-correction-authority.js";
import { workflowNonblockingAcceptanceSchema, workflowQaRemediationsSchema } from "@paperclipai/shared";
import type {
  WorkflowNonblockingAcceptance,
  WorkflowQaRemediations,
  WorkflowValidationVerdictValue,
} from "@paperclipai/shared";
import type { WorkflowValidationLedgerResult } from "./validation-verdict-ledger.js";

type ResolveContext = typeof import("./validation-verdict-ledger.js").resolveWorkflowValidationContext;
type WorkflowValidationDb = Pick<Db, "select" | "insert">;
type WorkflowValidationIssue = Parameters<ResolveContext>[1];

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isWorkflowValidationVerdictValue(value: unknown): value is WorkflowValidationVerdictValue {
  return value === "pass" || value === "request_changes" || value === "insufficient_evidence";
}

/**
 * [verdict authority hardening] a workflow_validation_verdict event is authoritative only when it
 * was submitted from a checked-out heartbeat run scoped to the SAME company + issue as the QA issue
 * that owns the event (the verdict API always runs on the QA issue). A null or cross-issue
 * heartbeatRunId is not an API submission and must not satisfy any reader/completion check.
 */
export async function heartbeatRunScopedToIssue(
  db: Pick<Db, "select">,
  heartbeatRunId: string | null,
  expected: { readonly companyId: string; readonly issueId: string },
): Promise<boolean> {
  if (!heartbeatRunId) return false;
  const [run] = await db
    .select({ companyId: heartbeatRuns.companyId, issueId: heartbeatRuns.issueId })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, heartbeatRunId))
    .limit(1);
  return Boolean(run && run.companyId === expected.companyId && run.issueId === expected.issueId);
}

/** A DB-issued target is also a fence for late ordinary submissions; absence of a wake ref is insufficient. */
export async function findWorkflowVerdictCorrection(db: Pick<Db, "select">, scope: {
  companyId: string; issueId: string; workflowRunId?: string | null; workflowStepRunId?: string | null;
}) {
  const [step] = await db.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.issueId, scope.issueId),
    ...(scope.workflowRunId ? [eq(workflowStepRuns.workflowRunId, scope.workflowRunId)] : []),
    ...(scope.workflowStepRunId ? [eq(workflowStepRuns.id, scope.workflowStepRunId)] : [])))
    .orderBy(desc(workflowStepRuns.startedAt), desc(workflowStepRuns.completedAt)).limit(1);
  if (!step) return null;
  const [row] = await db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, scope.companyId), eq(workflowTransitionEvents.issueId, scope.issueId),
    eq(workflowTransitionEvents.workflowRunId, step.workflowRunId), eq(workflowTransitionEvents.workflowStepRunId, step.id),
    eq(workflowTransitionEvents.eventType, "qa_correction_followup_requested")))
    .orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id)).limit(1);
  if (!row) return null;
  const followup = parseQaCorrectionEventPayload("qa_correction_followup_requested", row.payload);
  const ref = { companyId: scope.companyId, workflowRunId: step.workflowRunId,
    appliedEventId: followup.appliedEventId, requestId: followup.requestId };
  // These readers are SELECT-only; the older annotation also admits transaction connections.
  const connection = db as QaCorrectionDb;
  const selected = await readIssuedQaCorrectionFollowup(connection, ref, createQaCorrectionHistorySession(connection, ref));
  if (selected.followupEventId !== row.id) throw new Error("qa_correction_followup_record");
  return selected;
}

async function matchesCurrentCorrection(db: Pick<Db, "select">, scope: {
  companyId: string; issueId: string; workflowRunId?: string | null; workflowStepRunId?: string | null;
}, eventId: string) {
  const selected = await findWorkflowVerdictCorrection(db, scope);
  if (!selected) return true;
  const t = selected.followup.target;
  const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, t.stepRunId));
  if (!step || step.executionGeneration !== t.executionGeneration || step.retryCount !== t.retryCount
    || step.iterationIndex !== t.iterationIndex) return false;
  for (const change of selected.issued.applied.bindingChanges) {
    const [binding] = await db.select().from(workflowStepOutputBindings).where(and(
      eq(workflowStepOutputBindings.companyId, scope.companyId), eq(workflowStepOutputBindings.id, change.bindingId)));
    if (!binding || binding.workProductId !== change.toProductId) return false;
  }
  const connection = db as QaCorrectionDb;
  const relation = await readQaCorrectionFollowupConsumption(connection, selected.ref,
    createQaCorrectionHistorySession(connection, selected.ref));
  return relation?.consumed.evidence.kind === "workflow_verdict" && relation.consumed.evidence.eventId === eventId;
}

export async function hasWorkflowValidationCompletionLedger(input: {
  readonly db: WorkflowValidationDb;
  readonly issue: WorkflowValidationIssue;
}, resolveWorkflowValidationContext: ResolveContext): Promise<WorkflowValidationLedgerResult> {
  const context = await resolveWorkflowValidationContext(input.db, input.issue);
  if (!context.isCandidate) {
    return { ...context, satisfied: true, verdict: null, insufficientEvidence: false, insufficientEvidenceReason: null };
  }
  // [scope fail-closed] only a verdict bound to THIS issue's current workflow run + step run counts.
  //   a reused issue's prior-run verdict must never satisfy the current completion gate.
  if (!context.workflowRunId || !context.workflowStepRunId) {
    return { ...context, satisfied: false, verdict: null, insufficientEvidence: false, insufficientEvidenceReason: null };
  }

  const conditions = [
    eq(workflowTransitionEvents.companyId, input.issue.companyId),
    eq(workflowTransitionEvents.issueId, input.issue.id),
    eq(workflowTransitionEvents.workflowRunId, context.workflowRunId),
    eq(workflowTransitionEvents.workflowStepRunId, context.workflowStepRunId),
    eq(workflowTransitionEvents.reason, "workflow_api"),
    eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
    isNotNull(workflowTransitionEvents.heartbeatRunId),
  ];
  if (input.issue.startedAt) {
    conditions.push(gte(workflowTransitionEvents.createdAt, input.issue.startedAt));
  }

  // [verdict abstention] latest-first: 최신 공식 판정이 insufficient_evidence 면 만족하지 않는다.
  //   pass/request_changes 만 게이트를 만족시키며, 인식 불가능한(레거시) verdict 행은 건너뛴다.
  const rows = await input.db
    .select({
      id: workflowTransitionEvents.id,
      verdict: workflowTransitionEvents.verdict,
      payload: workflowTransitionEvents.payload,
      heartbeatRunId: workflowTransitionEvents.heartbeatRunId,
    })
    .from(workflowTransitionEvents)
    .where(and(...conditions))
    .orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id))
    .limit(20);
  for (const row of rows) {
    if (!isWorkflowValidationVerdictValue(row.verdict)) continue;
    // [verdict authority] the backing heartbeat run must be a checked-out run scoped to this QA issue.
    const scoped = await heartbeatRunScopedToIssue(
      input.db,
      row.heartbeatRunId,
      { companyId: input.issue.companyId, issueId: input.issue.id },
    );
    if (!scoped) continue;
    if (!await matchesCurrentCorrection(input.db, { companyId: input.issue.companyId, issueId: input.issue.id,
      workflowRunId: context.workflowRunId, workflowStepRunId: context.workflowStepRunId }, row.id)) continue;
    if (row.verdict === "insufficient_evidence") {
      const payloadReason = asRecord(row.payload).reason;
      const reason = typeof payloadReason === "string" && payloadReason.trim().length > 0
        ? payloadReason.trim().slice(0, 2000)
        : null;
      return { ...context, satisfied: false, verdict: null, insufficientEvidence: true, insufficientEvidenceReason: reason };
    }
    return { ...context, satisfied: true, verdict: row.verdict, insufficientEvidence: false, insufficientEvidenceReason: null };
  }
  return { ...context, satisfied: false, verdict: null, insufficientEvidence: false, insufficientEvidenceReason: null };
}

/**
 * [qa-cap acceptance] 해당 QA issue 의 최신 request_changes verdict event 에서 nonblockingAcceptance 를
 *   읽어 반환한다. cap 수용 게이트가 "현재 공식 분류" 로 사용하는 유일한 원천.
 * [엄격 바인딩] 오직 공식 workflow API 원천(reason="workflow_api") + heartbeatRunId non-null 만 인정 —
 *   comment(issue_patch_comment)/heartbeat_result 파생 verdict 는 fields 가 유사해도 절대 수용 ❌.
 *   payload JSON 은 신뢰 불가 → schema 재검증(bounded nonempty). caller 가 observedAt/workflowStepRunId/
 *   heartbeatRunId 로 current-generation + exact QA step binding 을 판정한다(stale ❌).
 */
export async function loadLatestNonblockingAcceptance(input: {
  readonly db: WorkflowValidationDb;
  readonly companyId: string;
  readonly issueId: string;
}): Promise<{
  readonly acceptance: WorkflowNonblockingAcceptance;
  readonly observedAt: Date | null;
  readonly workflowStepRunId: string | null;
  readonly heartbeatRunId: string | null;
} | null> {
  // [execution freshness] load the LATEST official workflow_api verdict for the issue FIRST —
  //   do NOT prefilter to request_changes/nonblocking. Only if that latest row is request_changes
  //   AND its payload parses as a bounded nonblocking acceptance does it qualify. A newer official
  //   PASS (or a request_changes without acceptance) is the current verdict and must disqualify.
  const row = await input.db
    .select({
      verdict: workflowTransitionEvents.verdict,
      payload: workflowTransitionEvents.payload,
      createdAt: workflowTransitionEvents.createdAt,
      id: workflowTransitionEvents.id,
      workflowStepRunId: workflowTransitionEvents.workflowStepRunId,
      heartbeatRunId: workflowTransitionEvents.heartbeatRunId,
    })
    .from(workflowTransitionEvents)
    .where(and(
      eq(workflowTransitionEvents.companyId, input.companyId),
      eq(workflowTransitionEvents.issueId, input.issueId),
      eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      eq(workflowTransitionEvents.reason, "workflow_api"),
      isNotNull(workflowTransitionEvents.heartbeatRunId),
    ))
    .orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row || row.verdict !== "request_changes") return null;
  // [verdict authority] require a checked-out heartbeat run scoped to this QA issue.
  if (!(await heartbeatRunScopedToIssue(input.db, row.heartbeatRunId, { companyId: input.companyId, issueId: input.issueId }))) {
    return null;
  }
  if (!await matchesCurrentCorrection(input.db, input, row.id)) return null;
  const payload = asRecord(row.payload);
  const parsed = workflowNonblockingAcceptanceSchema.safeParse(payload.nonblockingAcceptance);
  if (!parsed.success) return null;
  return {
    acceptance: parsed.data,
    observedAt: row.createdAt ?? null,
    workflowStepRunId: row.workflowStepRunId ?? null,
    heartbeatRunId: row.heartbeatRunId ?? null,
  };
}

/**
 * [qa mechanical remediation] 해당 QA issue 의 최신 공식 verdict event 에서 schema-validated
 *   remediations 를 읽어 반환한다. loop-driver 의 remediation pass 가 사용하는 유일한 원천이다.
 * [엄격 바인딩] nonblockingAcceptance/loadLatestNonblockingAcceptance 와 동일하게 오직 공식
 *   workflow API 원천(reason="workflow_api") + heartbeatRunId non-null(이슈 스코프 확인)만 인정한다.
 *   payload JSON 은 신뢰 불가 → schema 재검증, 실패 시 null. caller 가 observedAt/workflowStepRunId/
 *   heartbeatRunId/sourceVerdictEventId 로 current-generation + exact QA step binding + 멱등 키를 판정한다.
 */
export async function loadLatestQaRemediations(input: {
  readonly db: Pick<Db, "select">;
  readonly companyId: string;
  readonly issueId: string;
}): Promise<{
  readonly remediations: WorkflowQaRemediations;
  readonly observedAt: Date | null;
  readonly workflowStepRunId: string | null;
  readonly heartbeatRunId: string | null;
  /** remediation 멱등/감사가 참조할 원천 verdict event id(재적용 방지 키). */
  readonly sourceVerdictEventId: string;
} | null> {
  // [execution freshness] load the LATEST official workflow_api verdict for the issue FIRST —
  //   a newer official PASS (or a request_changes without remediations) is the current verdict
  //   and must disqualify.
  const row = await input.db
    .select({
      id: workflowTransitionEvents.id,
      verdict: workflowTransitionEvents.verdict,
      payload: workflowTransitionEvents.payload,
      createdAt: workflowTransitionEvents.createdAt,
      workflowStepRunId: workflowTransitionEvents.workflowStepRunId,
      heartbeatRunId: workflowTransitionEvents.heartbeatRunId,
    })
    .from(workflowTransitionEvents)
    .where(and(
      eq(workflowTransitionEvents.companyId, input.companyId),
      eq(workflowTransitionEvents.issueId, input.issueId),
      eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      eq(workflowTransitionEvents.reason, "workflow_api"),
      isNotNull(workflowTransitionEvents.heartbeatRunId),
    ))
    .orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row || row.verdict !== "request_changes") return null;
  // [verdict authority] require a checked-out heartbeat run scoped to this QA issue.
  if (!(await heartbeatRunScopedToIssue(input.db, row.heartbeatRunId, { companyId: input.companyId, issueId: input.issueId }))) {
    return null;
  }
  const payload = asRecord(row.payload);
  if (!await matchesCurrentCorrection(input.db, input, row.id)) return null;
  const parsed = workflowQaRemediationsSchema.safeParse(payload.remediations);
  if (!parsed.success) return null;
  return {
    remediations: parsed.data,
    observedAt: row.createdAt ?? null,
    workflowStepRunId: row.workflowStepRunId ?? null,
    heartbeatRunId: row.heartbeatRunId ?? null,
    sourceVerdictEventId: row.id,
  };
}

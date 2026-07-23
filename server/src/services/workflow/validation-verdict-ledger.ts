import { createHash } from "node:crypto";
import { and, desc, eq, gte, isNotNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  heartbeatRuns,
  issueExecutionCards,
  issues,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import { workflowNonblockingAcceptanceSchema } from "@paperclipai/shared";
import type { WorkflowNonblockingAcceptance, WorkflowValidationVerdictPayload } from "@paperclipai/shared";
import { type ValidationVerdict } from "../validation-verdict.js";

type IssueRow = typeof issues.$inferSelect;
type WorkflowValidationDb = Pick<Db, "select" | "insert">;
type WorkflowValidationIssue = Pick<IssueRow, "id" | "companyId" | "missionId" | "originKind" | "title" | "startedAt">;

export type WorkflowValidationLedgerResult = {
  readonly isCandidate: boolean;
  readonly satisfied: boolean;
  readonly verdict: ValidationVerdict | null;
  readonly workflowRunId: string | null;
  readonly workflowStepRunId: string | null;
  readonly stepId: string | null;
};

type StepLike = {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly title?: unknown;
  readonly type?: unknown;
};

type WorkflowValidationContext = {
  readonly isCandidate: boolean;
  readonly workflowRunId: string | null;
  readonly workflowStepRunId: string | null;
  readonly stepId: string | null;
};

type ResolveWorkflowValidationContextMode = "completion" | "record";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readSteps(value: unknown): StepLike[] {
  return Array.isArray(value) ? value.filter((step): step is StepLike => Boolean(step) && typeof step === "object") : [];
}

function isLegacyWorkflowValidationStep(issue: WorkflowValidationIssue, step: StepLike | null): boolean {
  if (issue.originKind !== "workflow_execution") return false;
  const title = trimmedString(issue.title) ?? "";
  const stepId = trimmedString(step?.id) ?? "";
  const stepType = trimmedString(step?.type)?.toLowerCase() ?? "";
  return /^\s*\[QA\]/iu.test(title) ||
    /^qa[-_]/iu.test(stepId) ||
    ["qa", "validation", "validator"].includes(stepType);
}

function cardRequiresWorkflowValidationVerdict(value: unknown): boolean | null {
  const card = asRecord(value);
  if (Object.keys(card).length === 0) return null;
  const requiredOutputs = asRecord(card.requiredOutputs);
  const verdict = asRecord(requiredOutputs.verdict);
  return typeof verdict.required === "boolean" ? verdict.required : null;
}

async function readWorkflowValidationCompletionRequirement(
  db: WorkflowValidationDb,
  issue: WorkflowValidationIssue,
): Promise<boolean | null> {
  const row = await db
    .select({ cardJson: issueExecutionCards.cardJson })
    .from(issueExecutionCards)
    .where(and(
      eq(issueExecutionCards.companyId, issue.companyId),
      eq(issueExecutionCards.issueId, issue.id),
    ))
    .orderBy(desc(issueExecutionCards.updatedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row ? cardRequiresWorkflowValidationVerdict(row.cardJson) : null;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}


export async function resolveWorkflowValidationContext(
  db: WorkflowValidationDb,
  issue: WorkflowValidationIssue,
  options: { readonly mode?: ResolveWorkflowValidationContextMode } = {},
): Promise<WorkflowValidationContext> {
  const stepRun = await db
    .select({
      id: workflowStepRuns.id,
      workflowRunId: workflowStepRuns.workflowRunId,
      stepId: workflowStepRuns.stepId,
    })
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.issueId, issue.id))
    .orderBy(desc(workflowStepRuns.startedAt), desc(workflowStepRuns.completedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  const workflowRun = stepRun
    ? await db
        .select({ workflowId: workflowRuns.workflowId })
        .from(workflowRuns)
        .where(eq(workflowRuns.id, stepRun.workflowRunId))
        .limit(1)
        .then((rows) => rows[0] ?? null)
    : null;
  const definition = workflowRun
    ? await db
        .select({ stepsJson: workflowDefinitions.stepsJson })
        .from(workflowDefinitions)
        .where(eq(workflowDefinitions.id, workflowRun.workflowId))
        .limit(1)
        .then((rows) => rows[0] ?? null)
    : null;
  const step = readSteps(definition?.stepsJson).find((candidate) => trimmedString(candidate.id) === stepRun?.stepId) ?? null;
  const hasStepRunContext = Boolean(stepRun?.workflowRunId && stepRun.id);
  const mode = options.mode ?? "completion";
  const recordableWorkflowStep = issue.originKind === "workflow_execution" && hasStepRunContext;
  const cardRequirement = mode === "completion" && recordableWorkflowStep
    ? await readWorkflowValidationCompletionRequirement(db, issue)
    : null;
  const completionRequired = mode === "record"
    ? recordableWorkflowStep
    : recordableWorkflowStep && (cardRequirement ?? isLegacyWorkflowValidationStep(issue, step));

  return {
    isCandidate: completionRequired,
    workflowRunId: stepRun?.workflowRunId ?? null,
    workflowStepRunId: stepRun?.id ?? null,
    stepId: stepRun?.stepId ?? null,
  };
}

export async function recordWorkflowValidationVerdict(input: {
  readonly db: WorkflowValidationDb;
  readonly issue: WorkflowValidationIssue;
  readonly verdict: ValidationVerdict;
  readonly source: "workflow_api";
  readonly actorAgentId?: string | null;
  readonly heartbeatRunId?: string | null;
  readonly sourceText?: string | null;
  readonly nonblockingAcceptance?: WorkflowNonblockingAcceptance | null;
}): Promise<WorkflowValidationLedgerResult> {
  const context = await resolveWorkflowValidationContext(input.db, input.issue, { mode: "record" });
  if (!context.isCandidate || !context.workflowRunId || !context.workflowStepRunId) {
    return { ...context, satisfied: false, verdict: null };
  }
  // [qa-cap acceptance] nonblocking 분류는 request_changes verdict 와만 공존. heartbeat/comment 경로는
  //   이 필드를 넘기지 않으므로 구조적 수용은 오직 공식 workflow API(request_changes) 만 가능하다.
  const acceptance = input.nonblockingAcceptance && input.verdict === "request_changes"
    ? input.nonblockingAcceptance
    : null;
  const boundedReason = typeof input.sourceText === "string" && input.sourceText.trim().length > 0
    ? input.sourceText.trim().slice(0, 4000)
    : null;
  const payload = {
    kind: "workflow_validation_verdict",
    workflowRunId: context.workflowRunId,
    stepRunId: context.workflowStepRunId,
    issueId: input.issue.id,
    verdict: input.verdict,
    diagnostics: [],
    ...(boundedReason ? { reason: boundedReason } : {}),
    ...(acceptance ? { nonblockingAcceptance: acceptance } : {}),
  } satisfies WorkflowValidationVerdictPayload;
  const sourceKey = input.heartbeatRunId
    ? `run:${input.heartbeatRunId}`
    : `text:${hashText(input.sourceText ?? input.verdict)}`;

  await input.db.insert(workflowTransitionEvents).values({
    companyId: input.issue.companyId,
    missionId: input.issue.missionId,
    workflowRunId: context.workflowRunId,
    workflowStepRunId: context.workflowStepRunId,
    issueId: input.issue.id,
    heartbeatRunId: input.heartbeatRunId ?? null,
    eventType: "workflow_validation_verdict",
    layer: "workflow_validation",
    verdict: input.verdict,
    decision: input.verdict,
    reason: input.source,
    reasonCode: input.source,
    idempotencyKey: `workflow-validation-verdict:${input.issue.companyId}:${input.issue.id}:${context.workflowStepRunId}:${sourceKey}`,
    payload,
  }).onConflictDoNothing();

  return { ...context, satisfied: true, verdict: input.verdict };
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

/**
 * [rework feedback authority] reads the request-changes rationale from the LATEST official
 * workflow_api verdict event exactly bound to the QA issue's current run + step (and a checked-out
 * heartbeat run scoped to that issue). This is the only rework-feedback source; comments/stdout are
 * not parsed. Returns null when no authoritative reason is present.
 */
export async function loadWorkflowApiFeedback(input: {
  readonly db: Pick<Db, "select">;
  readonly companyId: string;
  readonly issueId: string;
  readonly workflowRunId: string;
  readonly workflowStepRunId: string;
}): Promise<string | null> {
  const [row] = await input.db
    .select({
      payload: workflowTransitionEvents.payload,
      heartbeatRunId: workflowTransitionEvents.heartbeatRunId,
      createdAt: workflowTransitionEvents.createdAt,
    })
    .from(workflowTransitionEvents)
    .where(and(
      eq(workflowTransitionEvents.companyId, input.companyId),
      eq(workflowTransitionEvents.issueId, input.issueId),
      eq(workflowTransitionEvents.workflowRunId, input.workflowRunId),
      eq(workflowTransitionEvents.workflowStepRunId, input.workflowStepRunId),
      eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      eq(workflowTransitionEvents.reason, "workflow_api"),
      eq(workflowTransitionEvents.verdict, "request_changes"),
      isNotNull(workflowTransitionEvents.heartbeatRunId),
    ))
    .orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id))
    .limit(1);
  if (!row) return null;
  if (!(await heartbeatRunScopedToIssue(input.db, row.heartbeatRunId, { companyId: input.companyId, issueId: input.issueId }))) {
    return null;
  }
  const reason = asRecord(row.payload).reason;
  const observedAt = row.createdAt instanceof Date ? row.createdAt.toISOString() : "unknown-time";
  return typeof reason === "string" && reason.trim().length > 0
    ? `### QA feedback at ${observedAt}\n${reason.trim().slice(0, 4000)}`
    : null;
}


export async function hasWorkflowValidationCompletionLedger(input: {
  readonly db: WorkflowValidationDb;
  readonly issue: WorkflowValidationIssue;
}): Promise<WorkflowValidationLedgerResult> {
  const context = await resolveWorkflowValidationContext(input.db, input.issue);
  if (!context.isCandidate) return { ...context, satisfied: true, verdict: null };
  // [scope fail-closed] only a verdict bound to THIS issue's current workflow run + step run counts.
  //   a reused issue's prior-run verdict must never satisfy the current completion gate.
  if (!context.workflowRunId || !context.workflowStepRunId) {
    return { ...context, satisfied: false, verdict: null };
  }

  const conditions = [
    eq(workflowTransitionEvents.companyId, input.issue.companyId),
    eq(workflowTransitionEvents.issueId, input.issue.id),
    eq(workflowTransitionEvents.workflowRunId, context.workflowRunId),
    eq(workflowTransitionEvents.workflowStepRunId, context.workflowStepRunId),
    eq(workflowTransitionEvents.reason, "workflow_api"),
    eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
    isNotNull(workflowTransitionEvents.heartbeatRunId),
    or(eq(workflowTransitionEvents.verdict, "pass"), eq(workflowTransitionEvents.verdict, "request_changes"))!,
  ];
  if (input.issue.startedAt) {
    conditions.push(gte(workflowTransitionEvents.createdAt, input.issue.startedAt));
  }

  const row = await input.db
    .select({ verdict: workflowTransitionEvents.verdict, heartbeatRunId: workflowTransitionEvents.heartbeatRunId })
    .from(workflowTransitionEvents)
    .where(and(...conditions))
    .orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  // [verdict authority] the backing heartbeat run must be a checked-out run scoped to this QA issue.
  const scoped = row
    ? await heartbeatRunScopedToIssue(input.db, row.heartbeatRunId, { companyId: input.issue.companyId, issueId: input.issue.id })
    : false;
  const verdict = scoped && (row?.verdict === "pass" || row?.verdict === "request_changes") ? row.verdict : null;
  return { ...context, satisfied: Boolean(verdict), verdict };
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
  const parsed = workflowNonblockingAcceptanceSchema.safeParse(payload.nonblockingAcceptance);
  if (!parsed.success) return null;
  return {
    acceptance: parsed.data,
    observedAt: row.createdAt ?? null,
    workflowStepRunId: row.workflowStepRunId ?? null,
    heartbeatRunId: row.heartbeatRunId ?? null,
  };
}

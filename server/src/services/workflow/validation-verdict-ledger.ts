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
import { readExplicitValidationVerdict, type ValidationVerdict } from "../validation-verdict.js";
import { extractCodexTaskCompleteMessages } from "./codex-task-output.js";

type IssueRow = typeof issues.$inferSelect;
type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type WorkflowValidationDb = Pick<Db, "select" | "insert">;
type WorkflowValidationIssue = Pick<IssueRow, "id" | "companyId" | "missionId" | "originKind" | "title" | "startedAt">;
type WorkflowValidationRun = Pick<HeartbeatRunRow, "id" | "agentId" | "resultJson">;

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

function verdictFromString(value: string): ValidationVerdict | null {
  return readExplicitValidationVerdict(value, { allowLeadingVerdict: true });
}

export function readWorkflowValidationVerdictFromRunResult(resultJson: unknown): {
  readonly verdict: ValidationVerdict;
  readonly excerpt: string;
} | null {
  const result = asRecord(resultJson);
  const candidates = [
    trimmedString(result.verdict),
    trimmedString(result.decision),
    trimmedString(result.outcome),
    trimmedString(result.status),
    trimmedString(result.result),
    ...extractCodexTaskCompleteMessages(trimmedString(result.stdout)),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  for (const candidate of candidates) {
    const verdict = verdictFromString(candidate);
    if (!verdict) continue;
    return { verdict, excerpt: candidate };
  }
  return null;
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
  readonly source: "issue_patch_comment" | "heartbeat_result" | "workflow_api";
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
  const payload = {
    kind: "workflow_validation_verdict",
    workflowRunId: context.workflowRunId,
    stepRunId: context.workflowStepRunId,
    issueId: input.issue.id,
    verdict: input.verdict,
    diagnostics: [],
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

export async function recordWorkflowValidationVerdictFromText(input: {
  readonly db: WorkflowValidationDb;
  readonly issue: WorkflowValidationIssue;
  readonly text: string | null | undefined;
  readonly actorAgentId?: string | null;
  readonly heartbeatRunId?: string | null;
}): Promise<WorkflowValidationLedgerResult | null> {
  const text = input.text?.trim();
  if (!text) return null;
  const verdict = readExplicitValidationVerdict(text, { allowLeadingVerdict: true });
  if (!verdict) return null;
  return recordWorkflowValidationVerdict({
    db: input.db,
    issue: input.issue,
    verdict,
    source: "issue_patch_comment",
    actorAgentId: input.actorAgentId,
    heartbeatRunId: input.heartbeatRunId,
    sourceText: text,
  });
}

export async function recordWorkflowValidationVerdictFromRun(input: {
  readonly db: WorkflowValidationDb;
  readonly issue: WorkflowValidationIssue;
  readonly run: WorkflowValidationRun;
}): Promise<WorkflowValidationLedgerResult | null> {
  const result = readWorkflowValidationVerdictFromRunResult(input.run.resultJson);
  if (!result) return null;
  return recordWorkflowValidationVerdict({
    db: input.db,
    issue: input.issue,
    verdict: result.verdict,
    source: "heartbeat_result",
    actorAgentId: input.run.agentId,
    heartbeatRunId: input.run.id,
    sourceText: result.excerpt,
  });
}

export async function hasWorkflowValidationCompletionLedger(input: {
  readonly db: WorkflowValidationDb;
  readonly issue: WorkflowValidationIssue;
}): Promise<WorkflowValidationLedgerResult> {
  const context = await resolveWorkflowValidationContext(input.db, input.issue);
  if (!context.isCandidate) return { ...context, satisfied: true, verdict: null };

  const conditions = [
    eq(workflowTransitionEvents.companyId, input.issue.companyId),
    eq(workflowTransitionEvents.issueId, input.issue.id),
    eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
    or(eq(workflowTransitionEvents.verdict, "pass"), eq(workflowTransitionEvents.verdict, "request_changes"))!,
  ];
  if (input.issue.startedAt) {
    conditions.push(gte(workflowTransitionEvents.createdAt, input.issue.startedAt));
  }

  const row = await input.db
    .select({ verdict: workflowTransitionEvents.verdict })
    .from(workflowTransitionEvents)
    .where(and(...conditions))
    .orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const verdict = row?.verdict === "pass" || row?.verdict === "request_changes" ? row.verdict : null;
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

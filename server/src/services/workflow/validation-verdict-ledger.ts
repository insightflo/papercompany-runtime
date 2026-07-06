import { createHash } from "node:crypto";
import { and, desc, eq, gte, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  heartbeatRuns,
  issues,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import type { WorkflowValidationVerdictPayload } from "@paperclipai/shared";
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readSteps(value: unknown): StepLike[] {
  return Array.isArray(value) ? value.filter((step): step is StepLike => Boolean(step) && typeof step === "object") : [];
}

function isWorkflowValidationStep(issue: WorkflowValidationIssue, step: StepLike | null): boolean {
  if (issue.originKind !== "workflow_execution") return false;
  const title = trimmedString(issue.title) ?? "";
  const stepId = trimmedString(step?.id) ?? "";
  const stepType = trimmedString(step?.type)?.toLowerCase() ?? "";
  return /^\s*\[QA\]/iu.test(title) ||
    /^qa[-_]/iu.test(stepId) ||
    ["qa", "validation", "validator"].includes(stepType);
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

  return {
    isCandidate: hasStepRunContext && isWorkflowValidationStep(issue, step),
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
}): Promise<WorkflowValidationLedgerResult> {
  const context = await resolveWorkflowValidationContext(input.db, input.issue);
  if (!context.isCandidate || !context.workflowRunId || !context.workflowStepRunId) {
    return { ...context, satisfied: false, verdict: null };
  }
  const payload = {
    kind: "workflow_validation_verdict",
    workflowRunId: context.workflowRunId,
    stepRunId: context.workflowStepRunId,
    issueId: input.issue.id,
    verdict: input.verdict,
    diagnostics: [],
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

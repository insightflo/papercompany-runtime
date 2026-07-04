import { heartbeatRuns, issueComments, issues, issueWorkProducts } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { readExplicitValidationVerdict, type ValidationVerdict } from "../validation-verdict.js";
import { extractCodexTaskCompleteMessages } from "../workflow/codex-task-output.js";
import { asRecord, isQaLikeStep, trimmedString, type DagStepLike } from "./supervision-helpers.js";
import type { MissionSupervisionIssue, MissionSupervisionWorkflowStepRow } from "./mission-supervision-context.js";

type IssueRow = typeof issues.$inferSelect;

type VerdictObservation = {
  verdict: ValidationVerdict | null;
  observedAt: Date | null;
};

export type ValidationGateAssessment = {
  issue: IssueRow;
  label: string;
  verdict: VerdictObservation | null;
  requiredAfter: Date | null;
  reason: string;
  action: "requeue_validation" | "block_source_retry";
};

const MAIN_EXECUTOR_ORIGINS = new Set([
  "mission_main_executor_plan",
  "mission_main_executor_oversight",
  "mission_main_executor_unblock",
]);

function readStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return list.length > 0 ? list : undefined;
}

function readSteps(value: unknown): DagStepLike[] {
  if (!Array.isArray(value)) return [];
  const steps: DagStepLike[] = [];
  for (const rawStep of value) {
    const step = asRecord(rawStep);
    const id = trimmedString(step.id);
    if (!id) continue;
    steps.push({
      id,
      dependencies: readStringList(step.dependencies),
      dependsOn: readStringList(step.dependsOn),
      name: trimmedString(step.name) ?? undefined,
      title: trimmedString(step.title) ?? undefined,
      type: trimmedString(step.type) ?? undefined,
    });
  }
  return steps;
}

function isValidationGateIssue(issue: MissionSupervisionIssue, step: DagStepLike | null): boolean {
  if (MAIN_EXECUTOR_ORIGINS.has(issue.originKind)) return false;
  if (step && isQaLikeStep(step)) return true;
  const text = [issue.title, step?.id, step?.name, step?.title, step?.type]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
  return /^\s*\[QA\]/iu.test(text) ||
    /\b(QA|audit|auditor|validator|validation|validate)\b/iu.test(text) ||
    text.includes("검증");
}

function readValidationVerdictFromHeartbeatResult(resultJson: unknown): ValidationVerdict | null {
  const result = asRecord(resultJson);
  const candidates = [
    result.verdict,
    result.decision,
    result.outcome,
    result.status,
    result.result,
    ...extractCodexTaskCompleteMessages(trimmedString(result.stdout)),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const verdict = readExplicitValidationVerdict(candidate, { allowLeadingVerdict: true });
    if (verdict) return verdict;
  }
  return null;
}

function newerObservation(next: VerdictObservation, current: VerdictObservation | null): boolean {
  if (!current) return true;
  return (next.observedAt?.getTime() ?? 0) >= (current.observedAt?.getTime() ?? 0);
}

async function loadLatestValidationVerdict(db: Db, issue: IssueRow): Promise<VerdictObservation | null> {
  let latest: VerdictObservation | null = null;
  const inCurrentWindow = (observedAt: Date | null) => !issue.startedAt || !observedAt ||
    observedAt.getTime() >= issue.startedAt.getTime();

  const runs = await db
    .select({ resultJson: heartbeatRuns.resultJson, finishedAt: heartbeatRuns.finishedAt, createdAt: heartbeatRuns.createdAt })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.issueId, issue.id), eq(heartbeatRuns.status, "succeeded")))
    .orderBy(desc(heartbeatRuns.finishedAt), desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id));
  for (const run of runs) {
    const observedAt = run.finishedAt ?? run.createdAt ?? null;
    if (!inCurrentWindow(observedAt)) continue;
    const next = { verdict: readValidationVerdictFromHeartbeatResult(run.resultJson), observedAt };
    if (newerObservation(next, latest)) latest = next;
  }

  const comments = await db
    .select({ body: issueComments.body, createdAt: issueComments.createdAt })
    .from(issueComments)
    .where(and(eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id)))
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id));
  for (const comment of comments) {
    const observedAt = comment.createdAt ?? null;
    if (!inCurrentWindow(observedAt)) continue;
    const verdict = readExplicitValidationVerdict(comment.body);
    if (!verdict) continue;
    const next = { verdict, observedAt };
    if (newerObservation(next, latest)) latest = next;
  }
  return latest;
}

async function latestDependencyOutputTime(db: Db, companyId: string, dependencyIssues: MissionSupervisionIssue[]): Promise<Date | null> {
  const times = dependencyIssues
    .map((issue) => issue.completedAt)
    .filter((time): time is Date => time instanceof Date);
  if (dependencyIssues.length > 0) {
    const products = await db
      .select({ updatedAt: issueWorkProducts.updatedAt })
      .from(issueWorkProducts)
      .where(and(
        eq(issueWorkProducts.companyId, companyId),
        inArray(issueWorkProducts.issueId, dependencyIssues.map((issue) => issue.id)),
      ));
    for (const product of products) times.push(product.updatedAt);
  }
  if (times.length === 0) return null;
  return new Date(Math.max(...times.map((time) => time.getTime())));
}

function findStepIssue(input: {
  rows: MissionSupervisionWorkflowStepRow[];
  workflowRunId: string;
  stepId: string;
  issueById: Map<string, MissionSupervisionIssue>;
}): MissionSupervisionIssue | null {
  const row = input.rows.find((candidate) => (
    candidate.stepRun.workflowRunId === input.workflowRunId &&
    candidate.stepRun.stepId === input.stepId &&
    candidate.stepRun.issueId
  ));
  return row?.stepRun.issueId ? input.issueById.get(row.stepRun.issueId) ?? null : null;
}

export async function findValidationGateNeedingFreshPass(input: {
  db: Db;
  companyId: string;
  sourceStepRows: MissionSupervisionWorkflowStepRow[];
  stepRows: MissionSupervisionWorkflowStepRow[];
  missionIssues: MissionSupervisionIssue[];
}): Promise<ValidationGateAssessment | null> {
  const issueById = new Map(input.missionIssues.map((issue) => [issue.id, issue]));
  for (const sourceRow of input.sourceStepRows) {
    const steps = readSteps(sourceRow.definition.stepsJson);
    const stepById = new Map(steps.map((step) => [step.id, step]));
    const sourceStep = stepById.get(sourceRow.stepRun.stepId);
    const dependencyIds = sourceStep?.dependencies ?? sourceStep?.dependsOn ?? [];
    for (const dependencyId of dependencyIds) {
      const gateIssue = findStepIssue({
        rows: input.stepRows,
        workflowRunId: sourceRow.stepRun.workflowRunId,
        stepId: dependencyId,
        issueById,
      });
      const gateStep = stepById.get(dependencyId) ?? null;
      if (!gateIssue || !isValidationGateIssue(gateIssue, gateStep)) continue;
      const gateDependencies = (gateStep?.dependencies ?? gateStep?.dependsOn ?? [])
        .map((stepId) => findStepIssue({ rows: input.stepRows, workflowRunId: sourceRow.stepRun.workflowRunId, stepId, issueById }))
        .filter((issue): issue is MissionSupervisionIssue => issue !== null);
      const requiredAfter = await latestDependencyOutputTime(input.db, input.companyId, gateDependencies);
      const verdict = await loadLatestValidationVerdict(input.db, gateIssue as IssueRow);
      const freshEnough = !requiredAfter || (verdict?.observedAt?.getTime() ?? 0) >= requiredAfter.getTime();
      if (verdict?.verdict === "pass" && freshEnough) continue;
      const label = gateIssue.identifier ?? gateIssue.id;
      const verdictLabel = verdict?.verdict ?? "missing";
      if (freshEnough && verdict) {
        return {
          issue: gateIssue as IssueRow,
          label,
          verdict,
          requiredAfter,
          reason: `validation gate ${label} latest verdict is ${verdictLabel}, not PASS`,
          action: "block_source_retry",
        };
      }
      const reason = verdict
        ? `validation gate ${label} verdict is older than dependency output`
        : `validation gate ${label} has no validation execution for the current dependency output`;
      return { issue: gateIssue as IssueRow, label, verdict, requiredAfter, reason, action: "requeue_validation" };
    }
  }
  return null;
}

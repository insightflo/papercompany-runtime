import {
  issues,
  issueWorkProducts,
  workflowTransitionEvents,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { type ValidationVerdict } from "../validation-verdict.js";
import { heartbeatRunScopedToIssue } from "../workflow/validation-verdict-ledger.js";
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
  if (step) return isQaLikeStep(step);
  return isQaLikeStep({ title: issue.title });
}

async function loadLatestValidationVerdict(
  db: Db,
  issue: IssueRow,
  binding: { readonly workflowRunId: string; readonly workflowStepRunId: string },
): Promise<VerdictObservation | null> {
  const inCurrentWindow = (observedAt: Date | null) => !issue.startedAt || !observedAt ||
    observedAt.getTime() >= issue.startedAt.getTime();

  // structured authority only: official workflow_api submissions, exact-bound to the gate's current
  //   workflow run + step run. legacy comment/heartbeat_result derived events and any prior-run verdict
  //   for a reused issue are ignored even if they share eventType=workflow_validation_verdict.
  const events = await db
    .select({
      verdict: workflowTransitionEvents.verdict,
      createdAt: workflowTransitionEvents.createdAt,
      heartbeatRunId: workflowTransitionEvents.heartbeatRunId,
    })
    .from(workflowTransitionEvents)
    .where(and(
      eq(workflowTransitionEvents.companyId, issue.companyId),
      eq(workflowTransitionEvents.issueId, issue.id),
      eq(workflowTransitionEvents.workflowRunId, binding.workflowRunId),
      eq(workflowTransitionEvents.workflowStepRunId, binding.workflowStepRunId),
      eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      eq(workflowTransitionEvents.reason, "workflow_api"),
      isNotNull(workflowTransitionEvents.heartbeatRunId),
    ))
    .orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id));
  for (const event of events) {
    const observedAt = event.createdAt ?? null;
    if (!inCurrentWindow(observedAt)) continue;
    if (event.verdict !== "pass" && event.verdict !== "request_changes") continue;
    // [verdict authority] require a checked-out heartbeat run scoped to this gate's QA issue.
    if (!(await heartbeatRunScopedToIssue(db, event.heartbeatRunId, { companyId: issue.companyId, issueId: issue.id }))) {
      continue;
    }
    const verdict: ValidationVerdict = event.verdict === "pass" ? "pass" : "request_changes";
    return { verdict, observedAt };
  }
  return null;
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
      const gateRow = input.stepRows.find((candidate) => (
        candidate.stepRun.workflowRunId === sourceRow.stepRun.workflowRunId &&
        candidate.stepRun.stepId === dependencyId &&
        candidate.stepRun.issueId
      )) ?? null;
      const gateIssue = gateRow?.stepRun.issueId ? issueById.get(gateRow.stepRun.issueId) ?? null : null;
      const gateStep = stepById.get(dependencyId) ?? null;
      if (!gateIssue || !gateRow || !isValidationGateIssue(gateIssue, gateStep)) continue;
      const gateDependencies = (gateStep?.dependencies ?? gateStep?.dependsOn ?? [])
        .map((stepId) => findStepIssue({ rows: input.stepRows, workflowRunId: sourceRow.stepRun.workflowRunId, stepId, issueById }))
        .filter((issue): issue is MissionSupervisionIssue => issue !== null);
      const requiredAfter = await latestDependencyOutputTime(input.db, input.companyId, gateDependencies);
      const verdict = await loadLatestValidationVerdict(input.db, gateIssue as IssueRow, {
        workflowRunId: sourceRow.stepRun.workflowRunId,
        workflowStepRunId: gateRow.stepRun.id,
      });
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

/**
 * Engine-owned execution for native IF and Complete workflow nodes.
 *
 * Control nodes never create issues, wake agents, or dispatch tools. A pending node is
 * claimed with a run-scoped compare-and-set, evaluated synchronously, and completed with
 * a bounded schema-validated result. Source values are never persisted or copied into
 * errors. Evaluation failures fail the control step instead of selecting the false branch.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowStepRuns } from "@paperclipai/db";
import {
  workflowCompleteControlResultSchema,
  workflowConditionGroupSchema,
  workflowIfControlResultSchema,
} from "@paperclipai/shared";
import type { WorkflowExecutionContext, WorkflowStep } from "../dag-engine.js";
import { evaluateWorkflowConditionGroup } from "./condition-evaluator.js";
import {
  resolveWorkflowConditionSources,
  workflowConditionSourceKey,
} from "./condition-source-resolver.js";

type WorkflowStepRunRow = typeof workflowStepRuns.$inferSelect;

const MAX_ERROR_SUMMARY_LENGTH = 500;
const SAFE_IF_ERROR_PREFIX = "Workflow IF condition failed:";

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function safeErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const safe = message.startsWith(SAFE_IF_ERROR_PREFIX)
    ? message
    : "Workflow control node execution failed";
  return safe.slice(0, MAX_ERROR_SUMMARY_LENGTH);
}

export function isWorkflowControlNode(step: WorkflowStep): boolean {
  return step.type === "if" || step.type === "complete";
}

async function evaluateIfNode(input: {
  db: Db;
  context: WorkflowExecutionContext;
  step: WorkflowStep;
  evaluatedAt: Date;
}) {
  const parsedGroup = workflowConditionGroupSchema.safeParse(input.step.conditionGroup);
  if (!parsedGroup.success) {
    throw new Error(`${SAFE_IF_ERROR_PREFIX} IF step configuration is invalid`);
  }
  const group = parsedGroup.data;
  const sources = group.conditions.map((condition) => condition.source);
  const resolved = await resolveWorkflowConditionSources({
    db: input.db,
    run: input.context.run,
    ifStep: input.step,
    workflowSteps: input.context.steps,
    sources,
  });
  const evaluation = evaluateWorkflowConditionGroup({
    group,
    resolveSource: (source) => resolved.get(workflowConditionSourceKey(source)),
  });
  return workflowIfControlResultSchema.parse({
    nodeType: "if",
    outcome: evaluation.outcome ? "condition_true" : "condition_false",
    evaluatedAt: input.evaluatedAt.toISOString(),
    conditionCount: group.conditions.length,
    combinator: group.combinator,
    sourceSummary: sources.map(({ stepId, title, path }) => ({ stepId, title, path })),
  });
}

function completeNodeResult(step: WorkflowStep, completedAt: Date) {
  const reason = typeof step.completionReason === "string" ? step.completionReason.trim() : "";
  return workflowCompleteControlResultSchema.parse({
    nodeType: "complete",
    outcome: "completed",
    completedAt: completedAt.toISOString(),
    ...(reason ? { reason } : {}),
  });
}

export async function executeWorkflowControlNode(input: {
  db: Db;
  context: WorkflowExecutionContext;
  step: WorkflowStep;
  stepRun: WorkflowStepRunRow;
}): Promise<void> {
  if (!isWorkflowControlNode(input.step)) return;

  const startedAt = new Date();
  const claimed = await input.db
    .update(workflowStepRuns)
    .set({ status: "running", startedAt: input.stepRun.startedAt ?? startedAt, completedAt: null })
    .where(and(
      eq(workflowStepRuns.id, input.stepRun.id),
      eq(workflowStepRuns.workflowRunId, input.context.run.id),
      eq(workflowStepRuns.status, "pending"),
    ))
    .returning({ id: workflowStepRuns.id });
  if (claimed.length === 0) return;

  try {
    const completedAt = new Date();
    const result = input.step.type === "if"
      ? await evaluateIfNode({ db: input.db, context: input.context, step: input.step, evaluatedAt: completedAt })
      : completeNodeResult(input.step, completedAt);
    const metadata = normalizeRecord(input.stepRun.metadata);
    metadata.controlNodeResult = result;
    delete metadata.controlNodeError;
    await input.db
      .update(workflowStepRuns)
      .set({
        status: "completed",
        completedAt,
        dispatchReadyAt: completedAt,
        lastDispatchErrorAt: null,
        lastDispatchErrorSummary: null,
        metadata,
      })
      .where(and(
        eq(workflowStepRuns.id, input.stepRun.id),
        eq(workflowStepRuns.workflowRunId, input.context.run.id),
        eq(workflowStepRuns.status, "running"),
      ));
  } catch (error) {
    const failedAt = new Date();
    const summary = safeErrorSummary(error);
    const metadata = normalizeRecord(input.stepRun.metadata);
    delete metadata.controlNodeResult;
    metadata.controlNodeError = { message: summary, failedAt: failedAt.toISOString() };
    await input.db
      .update(workflowStepRuns)
      .set({
        status: "failed",
        completedAt: failedAt,
        lastDispatchErrorAt: failedAt,
        lastDispatchErrorSummary: summary,
        metadata,
      })
      .where(and(
        eq(workflowStepRuns.id, input.stepRun.id),
        eq(workflowStepRuns.workflowRunId, input.context.run.id),
        eq(workflowStepRuns.status, "running"),
      ));
  }
}

/**
 * [목적] resume 시 failed control node(IF/complete) 를 pending 으로 리셋해 재평가되게 한다.
 *   control node 는 issue 가 없고(issueId IS NULL), 한 번 failed 되면 executeWorkflowControlNode 의
 *   CAS(status=pending) 재클레임이 불가해 resume 만으로는 복구되지 않는다. resume 경로에서 명시적으로
 *   pending 으로 리셋한다. 일반 tool/issue step 의 failed 상태는 건드리지 않는다(범위 한정).
 * [주의] control node 만 리셋 — 재평가 후 다시 실패하면 failed 로 돌아가 run 은 다시 실패한다(idempotent).
 *   하류 issue 는 executeWorkflowRun 의 launch/skip pass 가 현 시점 상태로 다시 파생한다.
 */
export async function resetFailedControlNodesForResume(input: {
  db: Db;
  workflowRunId: string;
  steps: WorkflowStep[];
}): Promise<number> {
  const controlStepIds = input.steps.filter(isWorkflowControlNode).map((step) => step.id);
  if (controlStepIds.length === 0) return 0;

  const failedControlRuns = await input.db
    .select({ id: workflowStepRuns.id, metadata: workflowStepRuns.metadata })
    .from(workflowStepRuns)
    .where(and(
      eq(workflowStepRuns.workflowRunId, input.workflowRunId),
      eq(workflowStepRuns.status, "failed"),
      isNull(workflowStepRuns.issueId),
      inArray(workflowStepRuns.stepId, controlStepIds),
    ));
  if (failedControlRuns.length === 0) return 0;

  for (const row of failedControlRuns) {
    const metadata = normalizeRecord(row.metadata);
    delete metadata.controlNodeError;
    delete metadata.controlNodeResult;
    await input.db
      .update(workflowStepRuns)
      .set({
        status: "pending",
        startedAt: null,
        completedAt: null,
        dispatchReadyAt: null,
        lastDispatchErrorAt: null,
        lastDispatchErrorSummary: null,
        metadata,
      })
      .where(eq(workflowStepRuns.id, row.id));
  }
  return failedControlRuns.length;
}

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
  selectCurrentWorkProductCandidate,
  workflowConditionSourceKey,
} from "./condition-source-resolver.js";
import { executeWorkflowConditionToolSource } from "./condition-tool-source.js";
import {
  getGateWorkProductGraceRetrySeconds,
  qualifiesForGateWorkProductGrace,
  readControlNodeGraceWait,
} from "./gate-work-product-grace.js";
import { WorkProductConditionWaitableError } from "./waitable-condition-error.js";

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
    // tool_json sources are measured by the server itself (server-held secrets), so an
    // agent-authored work product cannot fabricate the measured storage reality.
    resolveToolJsonSource: (source) => executeWorkflowConditionToolSource({
      db: input.db,
      companyId: input.context.run.companyId,
      runId: input.context.run.id,
      ifStepId: input.step.id,
      workflowSteps: input.context.steps,
      source,
      runDate: input.context.run.runDate ?? null,
      runMetadata: input.context.run.metadata ?? null,
    }),
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
    sourceSummary: sources.map((source) => source.kind === "tool_json"
      ? { kind: source.kind, stepId: source.stepId, toolName: source.toolName, path: source.path }
      : { kind: source.kind, stepId: source.stepId, title: source.title, path: source.path }),
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
    delete metadata.controlNodeGraceWait;
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
    // [게이트 워크프로덕트 대기창] closeout 레이스(producer 완료 직후 등록/작성 지연)로 인한
    // 해소 실패는, producer 스텝이 최근에 완료됐다면 즉시 실패 대신 pending-wait 로 돌린다.
    // nextEvaluateAt 전까지 dispatch 가 차단되고(스핀 방지), heartbeat/sync/resume 또는
    // reconciler 타이머가 다음 패스에서 재조회한다. 대기창이 지나면 아래 정직한 실패 경로로 간다.
    if (input.step.type === "if" && error instanceof WorkProductConditionWaitableError) {
      const now = new Date();
      const graceApplies = await qualifiesForGateWorkProductGrace({
        db: input.db,
        workflowRunId: input.context.run.id,
        sourceStepId: error.sourceStepId,
        now,
      });
      if (graceApplies) {
        const summary = safeErrorSummary(error);
        const retrySeconds = getGateWorkProductGraceRetrySeconds();
        const nextEvaluateAt = new Date(now.getTime() + retrySeconds * 1000);
        const metadata = normalizeRecord(input.stepRun.metadata);
        const previousWait = readControlNodeGraceWait(metadata);
        metadata.controlNodeGraceWait = {
          reason: summary,
          since: previousWait?.since ?? now.toISOString(),
          attempts: (previousWait?.attempts ?? 0) + 1,
          nextEvaluateAt: nextEvaluateAt.toISOString(),
        };
        delete metadata.controlNodeResult;
        delete metadata.controlNodeError;
        await input.db
          .update(workflowStepRuns)
          .set({
            status: "pending",
            startedAt: input.stepRun.startedAt ?? null,
            completedAt: null,
            dispatchReadyAt: nextEvaluateAt,
            lastDispatchErrorAt: null,
            lastDispatchErrorSummary: null,
            metadata,
          })
          .where(and(
            eq(workflowStepRuns.id, input.stepRun.id),
            eq(workflowStepRuns.workflowRunId, input.context.run.id),
            eq(workflowStepRuns.status, "running"),
          ));
        return;
      }
    }

    const failedAt = new Date();
    const summary = safeErrorSummary(error);
    const metadata = normalizeRecord(input.stepRun.metadata);
    delete metadata.controlNodeResult;
    delete metadata.controlNodeGraceWait;
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
    delete metadata.controlNodeGraceWait;
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

/**
 * [목적] resume 시 verdict 가 stale 해진 완료된 IF control node 를 pending 으로 리셋해 재평가한다.
 *   run9 RCA: producer 산물이 재등록(수정)되어도 완료된 IF 노드는 영구 재평가 불가 → 하류 skip 스티키
 *   → run 이 조기 completed. stale 판정은 기계적 신선도 비교다: gate 평가 시점(controlNodeResult
 *   .evaluatedAt) 이후에 소스 work product 의 현재 후보가 갱신되었다면 verdict 는 폐기한다.
 *   tool_json 소스는 평가 시점에 라이브 실측이므로 stale 대상이 아니다.
 * [안전] stale 여부가 확립 불가하면(소스 후보 조회 실패 등) 리셋하지 않는다 — 보수적으로 유지.
 *   리셋된 노드는 executeWorkflowControlNode 의 CAS 로 재평가되며, 재평가가 다시 실패하면 run 은
 *   실패한다(idempotent). tool/issue step 은 건드리지 않는다(범위 한정).
 */
export async function resetStaleIfControlNodesForResume(input: {
  db: Db;
  companyId: string;
  workflowRunId: string;
  steps: WorkflowStep[];
}): Promise<number> {
  const ifStepById = new Map(
    input.steps.filter((step) => step.type === "if").map((step) => [step.id, step]),
  );
  if (ifStepById.size === 0) return 0;

  const completedIfRuns = await input.db
    .select({ id: workflowStepRuns.id, stepId: workflowStepRuns.stepId, metadata: workflowStepRuns.metadata })
    .from(workflowStepRuns)
    .where(and(
      eq(workflowStepRuns.workflowRunId, input.workflowRunId),
      eq(workflowStepRuns.status, "completed"),
      isNull(workflowStepRuns.issueId),
      inArray(workflowStepRuns.stepId, Array.from(ifStepById.keys())),
    ));
  if (completedIfRuns.length === 0) return 0;

  let resetCount = 0;
  for (const row of completedIfRuns) {
    const step = ifStepById.get(row.stepId);
    if (!step) continue;
    const parsedResult = workflowIfControlResultSchema.safeParse(
      normalizeRecord(row.metadata).controlNodeResult,
    );
    if (!parsedResult.success) continue;
    const evaluatedAtMs = Date.parse(parsedResult.data.evaluatedAt);
    if (!Number.isFinite(evaluatedAtMs)) continue;

    const parsedGroup = workflowConditionGroupSchema.safeParse(step.conditionGroup);
    if (!parsedGroup.success) continue;
    const workProductSources = parsedGroup.data.conditions
      .map((condition) => condition.source)
      .filter((source): source is Extract<typeof source, { kind: "work_product_json" }> => source.kind === "work_product_json");
    const uniquePairs = new Map(workProductSources.map((source) => [`${source.stepId}\u0000${source.title}`, source]));
    if (uniquePairs.size === 0) continue;

    let stale = false;
    for (const source of uniquePairs.values()) {
      try {
        const candidate = await selectCurrentWorkProductCandidate({
          db: input.db,
          run: { id: input.workflowRunId, companyId: input.companyId },
          ifStepId: step.id,
          workflowSteps: input.steps,
          stepId: source.stepId,
          title: source.title,
        });
        if (candidate.updatedAt.getTime() > evaluatedAtMs) {
          stale = true;
          break;
        }
      } catch {
        // Freshness cannot be established — keep the existing verdict (conservative).
        continue;
      }
    }
    if (!stale) continue;

    const metadata = normalizeRecord(row.metadata);
    delete metadata.controlNodeResult;
    delete metadata.controlNodeError;
    delete metadata.controlNodeGraceWait;
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
    resetCount += 1;
  }
  return resetCount;
}

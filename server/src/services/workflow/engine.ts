/**
 * Workflow Engine Service
 *
 * Main service interface for workflow operations.
 * Provides create, trigger, cancel, and query operations for workflows.
 */

import type { Db } from "@paperclipai/db";
import { activityLog, companies, heartbeatRuns, issueWorkProducts, issues, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { and, desc, eq, gt, lt, ne } from "drizzle-orm";
import { issueService } from "../issues.js";
import { validateDag, executeWorkflowRun, syncWorkflowRunState, getWorkflowExecutionResultSnapshot, syncWorkflowRunForIssue, cancelWorkflowRunWithCleanup } from "./dag-engine.js";
import { lockUnreplacedRun } from "./run-replacement-guard.js";
import { assertWorkflowToolReadinessForSteps } from "./admission-tool-readiness.js";
import { validateRunInputDeclarations } from "./run-input-derivations.js";
import type { WorkflowRunInputPolicy } from "./run-input-normalization.js";
import { formatDateKeyInTimezone } from "./workflow-run-date.js";
import { resetFailedControlNodesForResume, resetStaleIfControlNodesForResume } from "./control-flow/control-node-executor.js";
import { listCompanyPlanningArtifactTools } from "../missions/mission-plan-publication-contract.js";
import { assertDefinitionNotQualityOwned } from "../quality/native-definition.js";
import {
  createWorkflowDefinition,
  claimWorkflowRunSlot,
  getWorkflowDefinitionById,
  listWorkflowDefinitions,
  updateWorkflowDefinition,
  deleteWorkflowDefinition,
  createWorkflowRun,
  getWorkflowRunById,
  listWorkflowRuns,
  listWorkflowStepRuns,
  getWorkflowStepExecutionContractForIssue,
  updateWorkflowRunStatus,
  resumeWorkflowRun,
  markWorkflowRunSlotFailed,
  recordWorkflowScheduleClaimed,
  recordWorkflowScheduleFailure,
} from "./workflow-store.js";
import type {
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStepRun,
  CreateWorkflowDefinitionInput,
  CreateWorkflowRunInput,
  ClaimScheduledWorkflowRunInput,
  ClaimScheduledWorkflowRunResult,
  DagValidationResult,
  WorkflowExecutionResult,
  WorkflowStepExecutionContract,
} from "./types.js";
import type { WorkflowExecutionMode, WorkflowStep } from "./dag-engine.js";
import type { WorkflowSyncSource } from "./workflow-sync-source.js";
import { loadExecutionDefinition } from "./execution-definition.js";
import { normalizeWorkflowSteps } from "./normalize-definition-steps.js";
import { findActiveScheduledWorkflowMissionRun, prepareWorkflowTrigger } from "./trigger-preparation.js";

import { assertWorkflowChildDefinitionCycles } from "./workflow-child-execution.js";
import { discoverWorkflowChildStart } from "./workflow-child-discovery.js";
import { createWorkflowDefinitionWithNormalization } from "./create-definition.js";
import { HttpError } from "../../errors.js";

async function assertWorkflowToolReadiness(
  db: Db,
  companyId: string,
  steps: WorkflowStep[],
): Promise<void> {
  // [Q7 구현 단일화] 검사 본체는 admission-tool-readiness.ts 로 옮겼다 — create/update/trigger/
  //   resume 검사(:272/:313/:353/:500 호출점)와 시작 승인(생성) 시점 재검사가 같은 순서·같은
  //   오류로 하나의 구현을 공유한다(동작 변경 없음, 호출부 서명 불변).
  await assertWorkflowToolReadinessForSteps(db, { companyId, steps });
}

/**
 * [stale-run auto-block guard, 2026-10-07 CMP-328] 이슈를 막은 마지막 기록이 heartbeat 자동 차단
 * (issue.run_failure_auto_blocked, reason=terminal_run_failure)이고, 그 run 이 (a) 취소됐거나
 * (b) 차단 전에 같은 이슈의 더 새 run 이 이미 시작돼 소유자가 아니었으며, 스텝 현재 세대의
 * 산출물이 장부(issue_work_products)에 등록돼 있을 때만 재무장 근거를 돌려준다.
 * 코멘트·stdout 등 자연어는 읽지 않는다. 산출물 완료/증거 검사는 이후 기존 경로가 그대로 수행한다.
 */
async function findStaleRunBlockWithCurrentWorkProduct(
  db: Db,
  input: { companyId: string; issueId: string; executionGeneration: number },
): Promise<{ blockActivityId: string; blockingRunId: string; reason: "cancelled" | "not_owner"; workProductId: string } | null> {
  const [block] = await db
    .select({ id: activityLog.id, runId: activityLog.runId, details: activityLog.details, createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, input.companyId),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, input.issueId),
      eq(activityLog.action, "issue.run_failure_auto_blocked"),
    ))
    .orderBy(desc(activityLog.createdAt))
    .limit(1);
  if (!block?.runId || (block.details as Record<string, unknown> | null)?.reason !== "terminal_run_failure") return null;
  const [blockingRun] = await db
    .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, createdAt: heartbeatRuns.createdAt })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, block.runId), eq(heartbeatRuns.companyId, input.companyId)))
    .limit(1);
  if (!blockingRun) return null;
  let reason: "cancelled" | "not_owner" | null = blockingRun.status === "cancelled" ? "cancelled" : null;
  if (!reason) {
    const [newerRun] = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.issueId, input.issueId),
        ne(heartbeatRuns.id, blockingRun.id),
        gt(heartbeatRuns.createdAt, blockingRun.createdAt),
        lt(heartbeatRuns.createdAt, block.createdAt),
      ))
      .limit(1);
    if (newerRun) reason = "not_owner";
  }
  if (!reason) return null;
  const [workProduct] = await db
    .select({ id: issueWorkProducts.id })
    .from(issueWorkProducts)
    .where(and(
      eq(issueWorkProducts.companyId, input.companyId),
      eq(issueWorkProducts.issueId, input.issueId),
      ne(issueWorkProducts.status, "archived"),
      eq(issueWorkProducts.sourceExecutionGeneration, input.executionGeneration),
    ))
    .limit(1);
  if (!workProduct) return null;
  return { blockActivityId: block.id, blockingRunId: blockingRun.id, reason, workProductId: workProduct.id };
}

/**
 * [QA rework re-arm] 공식 resume 에서 "failed 스텝 + blocked 이슈" 조합을 재무장한다.
 *
 * 배경(2026-09-25 락 순환 사고, mission 90605444 run b7728a08): 게이트 반려(request_changes
 * verdict) 후 운영자/에이전트 재작업 대기 상태에서는 run failed → 툴 스코프 잠금
 * (tool_progress_scope_replaced) → 에이전트가 계약대로 이슈 blocked 유지 → sync 가
 * blocked→failed 재판정 → resume 이 즉시 재실패하는 순환이 생긴다. 수동 탈출은
 * "wake → in_progress 전환 틈 → resume" 레이스였고, 이를 resume CAS 로 흡수한다.
 *
 * 재무장 조건(좁게 유지): failed 스텝의 linked issue 가 blocked 이고, 그 step run 에
 * 현재 세대 workflow_validation_verdict(event_type=workflow_validation_verdict,
 * verdict=request_changes) 가 장부에 기록돼 있을 때만 blocked → in_progress 로 되돌린다.
 * verdict 없는 blocked 는 운영자/에이전트 판단 영역이므로 건드리지 않는다.
 */
export async function rearmBlockedQaIssuesForResume(
  db: Db,
  input: { companyId: string; runId: string },
): Promise<Array<{ issueId: string; stepRunId: string }>> {
  const failedStepRuns = await db
    .select({ id: workflowStepRuns.id, issueId: workflowStepRuns.issueId, executionGeneration: workflowStepRuns.executionGeneration })
    .from(workflowStepRuns)
    .where(and(
      eq(workflowStepRuns.workflowRunId, input.runId),
      eq(workflowStepRuns.status, "failed"),
    ));
  const rearmed: Array<{ issueId: string; stepRunId: string }> = [];
  for (const stepRun of failedStepRuns) {
    if (!stepRun.issueId) continue;
    const [issue] = await db
      .select({ id: issues.id, companyId: issues.companyId, status: issues.status, identifier: issues.identifier })
      .from(issues)
      .where(and(eq(issues.id, stepRun.issueId), eq(issues.companyId, input.companyId)))
      .limit(1);
    if (!issue || issue.status !== "blocked") continue;
    const [verdictEvent] = await db
      .select({ id: workflowTransitionEvents.id })
      .from(workflowTransitionEvents)
      .where(and(
        eq(workflowTransitionEvents.workflowStepRunId, stepRun.id),
        eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
        eq(workflowTransitionEvents.verdict, "request_changes"),
      ))
      .limit(1);
    const staleRunBlock = verdictEvent
      ? null
      : await findStaleRunBlockWithCurrentWorkProduct(db, {
        companyId: input.companyId,
        issueId: issue.id,
        executionGeneration: stepRun.executionGeneration,
      });
    if (!verdictEvent && !staleRunBlock) continue;
    await issueService(db).update(issue.id, {
      status: "in_progress",
      workflowSyncSource: "workflow_resume_qa_rearm",
    });
    await db.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "system",
      actorId: "workflow-resume",
      action: "workflow_run.qa_rework_rearmed",
      entityType: "issue",
      entityId: issue.id,
      details: {
        schemaVersion: 1,
        workflowRunId: input.runId,
        workflowStepRunId: stepRun.id,
        verdictEventId: verdictEvent?.id ?? null,
        staleRunBlock,
        issueIdentifier: issue.identifier ?? null,
        previousStatus: "blocked",
        nextStatus: "in_progress",
      },
    });
    rearmed.push({ issueId: issue.id, stepRunId: stepRun.id });
  }
  return rearmed;
}

export const workflowService = {
  /** Create a new workflow definition. */
  async createDefinition(
    db: Db,
    input: CreateWorkflowDefinitionInput,
  ): Promise<WorkflowDefinition> {
    // 생성 경로(정규화·검증·저장)는 create-definition.ts 로 추출 — 여기서는 위임한다.
    return createWorkflowDefinitionWithNormalization(db, input);
  },

  /**
   * Get a workflow definition by ID.
   */
  async getDefinition(db: Db, id: string): Promise<WorkflowDefinition | null> {
    return getWorkflowDefinitionById(db, id);
  },

  /**
   * List workflow definitions for a company.
   */
  async listDefinitions(db: Db, companyId: string): Promise<WorkflowDefinition[]> {
    return listWorkflowDefinitions(db, companyId);
  },

  /**
   * Update a workflow definition.
   */
  async updateDefinition(
    db: Db,
    id: string,
    updates: Partial<Omit<WorkflowDefinition, "id" | "createdAt" | "updatedAt">>,
  ): Promise<WorkflowDefinition | null> {
    await assertDefinitionNotQualityOwned(db, id);
    if (updates.steps) {
      const existing = await getWorkflowDefinitionById(db, id);
      if (!existing) return null;
      const steps = normalizeWorkflowSteps(updates.steps as unknown[], {
        executionMode: updates.executionMode,
        tools: await listCompanyPlanningArtifactTools(db, existing.companyId),
      });
      const validation = validateDag(steps);
      if (!validation.valid) {
        throw new Error(`Invalid workflow DAG: ${validation.errors.join(", ")}`);
      }
      await assertWorkflowToolReadiness(db, existing.companyId, steps);
      // [workflow child step] 정의 수정 시에도 CYCLE DFS(자기참조 거부, diamond 허용).
      await assertWorkflowChildDefinitionCycles(db, existing.companyId, id, steps);
      updates = { ...updates, steps };
    }
    // runInputs는 배열 패치 시 전체 교체이므로 새 배열 단위로 선언 무결성 검증.
    if (updates.runInputs) {
      validateRunInputDeclarations(updates.runInputs);
    }

    return updateWorkflowDefinition(db, id, updates);
  },

  /** Delete a workflow definition. */
  async deleteDefinition(db: Db, id: string): Promise<boolean> {
    await assertDefinitionNotQualityOwned(db, id);
    return deleteWorkflowDefinition(db, id);
  },

  /** Trigger (create and execute) a workflow run. */
  async trigger(
    db: Db,
    input: CreateWorkflowRunInput,
    policy: WorkflowRunInputPolicy = {},
  ): Promise<WorkflowExecutionResult> {
    const prepared = await workflowService.prepareTrigger(db, input, policy);
    return prepared.replay
      ? (await getWorkflowExecutionResultSnapshot(db, prepared.run.id))!
      : workflowService.startPreparedRun(db, prepared.run.id);
  },

  /** Prepare durable rows before starting any workflow step. */
  async prepareTrigger(db: Db, input: CreateWorkflowRunInput, policy: WorkflowRunInputPolicy = {},
    options?: { deferWorkingNote?: boolean }): Promise<{ run: WorkflowRun; replay: boolean }> {
    return prepareWorkflowTrigger(db, input, policy, options);
  },

  async startPreparedRun(db: Db, runId: string): Promise<WorkflowExecutionResult> {
    return executeWorkflowRun(db, runId);
  },
  /** Scheduler-only: claim a slot before run creation to prevent duplicate scheduled runs. */
  async claimScheduledRun(
    db: Db,
    input: ClaimScheduledWorkflowRunInput,
  ): Promise<ClaimScheduledWorkflowRunResult> {
    const workflow = await getWorkflowDefinitionById(db, input.workflowId);
    if (!workflow) {
      throw new Error(`Workflow definition not found: ${input.workflowId}`);
    }
    if (workflow.companyId !== input.companyId) {
      throw new Error(`Workflow does not belong to company: ${input.workflowId}`);
    }

    const [company] = await db
      .select({ timezone: companies.timezone })
      .from(companies)
      .where(eq(companies.id, input.companyId))
      .limit(1);
    const timezone = input.timezone ?? workflow.timezone ?? company?.timezone ?? null;
    const triggerSource = input.triggerSource ?? "schedule";
    const runDate = input.runDate
      ?? (timezone ? formatDateKeyInTimezone(input.scheduledAt, timezone) : null)
      ?? input.scheduledAt.toISOString().slice(0, 10);
    const activeScheduledRun = await findActiveScheduledWorkflowMissionRun(db, {
      companyId: input.companyId,
      workflowId: input.workflowId,
    }, workflow, runDate);
    if (activeScheduledRun) {
      return {
        claimed: false,
        scheduledSlotId: null,
        run: null,
      };
    }

    const slot = await claimWorkflowRunSlot(db, {
      workflowDefinitionId: input.workflowId,
      companyId: input.companyId,
      triggerSource,
      scheduledAt: input.scheduledAt,
      runDate,
      timezone,
      metadata: {
        ...(input.metadata ?? {}),
        scheduledAt: input.scheduledAt.toISOString(),
      },
    });

    if (!slot) {
      return {
        claimed: false,
        scheduledSlotId: null,
        run: null,
      };
    }

    await recordWorkflowScheduleClaimed(db, {
      workflowDefinitionId: input.workflowId,
      scheduledAt: input.scheduledAt,
    });

    let run: WorkflowExecutionResult;
    try {
      run = await workflowService.trigger(db, {
        workflowId: input.workflowId,
        companyId: input.companyId,
        triggeredBy: input.triggeredBy ?? "scheduler",
        triggerSource,
        runDate,
        runNumber: input.runNumber ?? null,
        runLabel: input.runLabel ?? null,
        scheduledSlotId: slot.id,
        metadata: input.metadata ?? {},
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markWorkflowRunSlotFailed(db, slot.id, {
        error: message,
        metadata: slot.metadata,
      });
      await recordWorkflowScheduleFailure(db, {
        workflowDefinitionId: input.workflowId,
        error: message,
      });
      throw error;
    }

    return {
      claimed: true,
      scheduledSlotId: slot.id,
      run,
    };
  },

  /**
   * Resume a workflow run through the native server DAG execution path.
   */
  
async resumeRun(
    db: Db,
    input: { runId: string; companyId: string },
  ): Promise<WorkflowExecutionResult> {
    const existingRun = await getWorkflowRunById(db, input.runId);
    if (!existingRun || existingRun.companyId !== input.companyId) {
      throw new Error(`Workflow run not found: ${input.runId}`);
    }
    // [descope D3] 자식 run 의 공개 resume 은 어떤 부수효과(정의 검증/리셋/임대/실행) "이전"에
    //   typed 거부된다. linked 는 workflow_child_resume_not_supported, 표지가 있지만 비정합인
    //   run 은 workflow_child_invalid_state 다 — plain fallback 은 절대 없다. missing 은 기존
    //   not-found 를 유지한다. 자동 회복(초기화/정산)은 회복 경로의 소관이지 사용자 resume 이 아니다.
    const discovery = await discoverWorkflowChildStart(db, input.runId);
    if (discovery.kind === "linked") {
      throw new HttpError(
        409,
        `workflow_child_resume_not_supported: run ${input.runId} is a linked child owned by its parent workflow step; rerun the parent workflow instead`,
      );
    }
    if (discovery.kind === "invalid-child") {
      throw new HttpError(409, `workflow_child_invalid_state: run ${input.runId} (${discovery.reason})`);
    }
    if (discovery.kind === "missing") {
      throw new Error(`Workflow run not found: ${input.runId}`);
    }
    // 일반 run — pre-feature plain resume 을 그대로 유지한다(검증 → store resume → 컨트롤 리셋 → 실행).
    const workflow = await getWorkflowDefinitionById(db, existingRun.workflowId);
    if (!workflow || workflow.companyId !== input.companyId) {
      throw new Error(`Workflow definition not found: ${existingRun.workflowId}`);
    }
    // [Task5a2a] run/workflow scope guards 후·readiness/status mutation 전에 실행정의를 1회 로드한다.
    //   missing/corrupt snapshot 은 run 상태/startedAt/reset 이 전혀 없이 422 로 거절된다.
    const execution = await loadExecutionDefinition(db, existingRun.id, { requireHistorical: false });
    await assertWorkflowToolReadiness(db, input.companyId, execution.steps);
    const resumedId = await db.transaction(async (tx) => {
    const db = tx as unknown as Db;
    await lockUnreplacedRun(db, input.runId, input.companyId);
    const run = await resumeWorkflowRun(db, input.runId, input.companyId);
    if (!run) {
      throw new Error(`Workflow run not found: ${input.runId}`);
    }
    if (existingRun.status === "failed") {
      await rearmBlockedQaIssuesForResume(db, { companyId: input.companyId, runId: run.id });
    }
    await resetFailedControlNodesForResume({
      db,
      workflowRunId: run.id,
      steps: execution.steps,
    });
    // [run9 RCA] 완료된 IF 노드도 verdict 입력(소스 work product)이 평가 시점보다 새로 갱신됐으면
    //   stale 로 보고 pending 리셋 후 재평가한다 — producer 수정 후에도 skip 스티키가 영구화되지 않게.
    //   정산(failed/completed)된 workflow S 는 리셋/재오픈되지 않는다(D2 — 재실행은 새 최상위 run).
    await resetStaleIfControlNodesForResume({
      db,
      companyId: input.companyId,
      workflowRunId: run.id,
      steps: execution.steps,
    });
    return run.id;
    });
    return syncWorkflowRunState(db, resumedId, "workflow_execution", { requireRunning: true });
  },

  /**
   * Cancel a workflow run.
   */
  async cancelRun(db: Db, input: { runId: string; companyId: string }): Promise<boolean> {
    return cancelWorkflowRunWithCleanup(db, input.runId, input.companyId);
  },

  /**
   * Get a workflow run by ID.
   */
  async getRun(db: Db, id: string): Promise<WorkflowRun | null> {
    return getWorkflowRunById(db, id);
  },

  /**
   * List workflow runs.
   */
  async listRuns(
    db: Db,
    filters: { companyId?: string; workflowId?: string; missionId?: string },
  ): Promise<WorkflowRun[]> {
    return listWorkflowRuns(db, filters);
  },

  /**
   * List step runs for a workflow run.
   */
  async listStepRuns(db: Db, workflowRunId: string): Promise<WorkflowStepRun[]> {
    return listWorkflowStepRuns(db, workflowRunId);
  },

  /**
   * Resolve the workflow step execution contract for a workflow-owned issue.
   */
  async getStepExecutionContractForIssue(
    db: Db,
    issueId: string,
  ): Promise<WorkflowStepExecutionContract | null> {
    return getWorkflowStepExecutionContractForIssue(db, issueId);
  },

  /**
   * Validate a workflow DAG without creating it.
   */
  async validateDag(steps: unknown[]): Promise<DagValidationResult> {
    return validateDag(normalizeWorkflowSteps(steps));
  },

  /**
   * Synchronize a workflow run after one of its execution issues changed state.
   */
  async syncRunStatusForIssue(
    db: Db,
    issueId: string,
    source: WorkflowSyncSource = "workflow_sync",
  ): Promise<WorkflowExecutionResult | null> {
    return syncWorkflowRunForIssue(db, issueId, source);
  },
};

// Re-export types for convenience
export type {
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStepRun,
  CreateWorkflowDefinitionInput,
  CreateWorkflowRunInput,
  ClaimScheduledWorkflowRunInput,
  ClaimScheduledWorkflowRunResult,
  DagValidationResult,
  WorkflowExecutionResult,
  WorkflowStepExecutionContract,
};

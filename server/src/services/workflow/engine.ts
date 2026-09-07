/**
 * Workflow Engine Service
 *
 * Main service interface for workflow operations.
 * Provides create, trigger, cancel, and query operations for workflows.
 */

import type { Db } from "@paperclipai/db";
import { agents, companies,
  workflowRuns,
} from "@paperclipai/db";
import { and, eq, asc, ne } from "drizzle-orm";
import { assertWorkflowToolStepsReady, validateDag, executeWorkflowRun, syncWorkflowRunForIssue, cancelWorkflowRunWithCleanup, normalizeWorkflowStepsForExecution } from "./dag-engine.js";
import { assertWorkflowToolReferencesSelectable } from "./tool-catalog.js";
import { validateRunInputDeclarations } from "./run-input-derivations.js";
import { resetFailedControlNodesForResume, resetStaleIfControlNodesForResume } from "./control-flow/control-node-executor.js";
import { validateStructuralGateReadinessForSteps } from "./control-flow/structural-gate-readiness.js";
import { getStructuralTopologyErrors } from "./control-flow/structural-topology.js";
import { missionService } from "../missions.js";
import { isQaLikeStep, synthesizeQaReworkBackEdge } from "../missions/supervision-helpers.js";
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

type WorkflowStepLike = WorkflowStep & {
  title?: unknown;
  dependsOn?: unknown;
  tools?: unknown;
  toolName?: unknown;
  agentName?: unknown;
};

function synthesizeWorkflowQaReworkBackEdges(steps: WorkflowStep[]): WorkflowStep[] {
  return steps
    .filter((step) => isQaLikeStep(step) && step.dependencies.length > 0)
    .reduce(
      (nextSteps, qaStep) => synthesizeQaReworkBackEdge(nextSteps, qaStep.id),
      steps,
    );
}

function normalizeWorkflowSteps(
  steps: unknown[],
  options: { executionMode?: unknown; dynamicPlanBootstrapOnly?: unknown } = {},
): WorkflowStep[] {
  const normalizedSteps = steps.map((rawStep) => {
    const step = (rawStep && typeof rawStep === "object" ? rawStep : {}) as WorkflowStepLike;
    const { conditionalDependencies: _rawConditionalDependencies, ...stepWithoutRawConditionalDependencies } = step;
    const normalized = normalizeWorkflowStepsForExecution([step])[0]!;
    const toolNames = normalized.toolNames;

    return {
      ...stepWithoutRawConditionalDependencies,
      id: normalized.id,
      name: normalized.name,
      agentId: normalized.agentId,
      dependencies: normalized.dependencies,
      graphWorkProductRequired: normalized.graphWorkProductRequired,
      ...(normalized.conditionalDependencies ? { conditionalDependencies: normalized.conditionalDependencies } : {}),
      ...(toolNames ? { toolNames } : {}),
    };
  });

  const dynamicOwnerPlan = options.executionMode === "dynamic_owner_plan"
    || options.dynamicPlanBootstrapOnly === true
    || options.dynamicPlanBootstrapOnly === "true";
  const stepsWithQaLoops = synthesizeWorkflowQaReworkBackEdges(normalizedSteps);

  if (!dynamicOwnerPlan) return stepsWithQaLoops;

  return stepsWithQaLoops.map((step) => {
    if (step.triggerOn === "escalation" || step.dependencies.length > 0) return step;
    return {
      ...step,
      dynamicChildren: step.dynamicChildren ?? true,
      ownerPlanBootstrapOnly: step.ownerPlanBootstrapOnly ?? true,
      executionMode: step.executionMode ?? "dynamic_owner_plan",
    };
  });
}

function formatDateKeyInTimezone(date: Date, timezone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (!year || !month || !day) return null;
    return `${year}-${month}-${day}`;
  } catch {
    return null;
  }
}

function formatWorkflowMissionTitle(
  workflowName: string,
  input: { runDate?: string | null; timezone?: string | null; runLabel?: string | null },
  now = new Date(),
): string {
  const yyyyMmDd = typeof input.runDate === "string" && input.runDate.trim().length > 0
    ? input.runDate.trim()
    : (input.timezone ? formatDateKeyInTimezone(now, input.timezone) : null) ?? now.toISOString().slice(0, 10);
  // [manual run label] 수동 실행 대화상자의 실행명(runLabel)은 미션명에 접미되어 같은 날
  //   같은 워크플로우의 반복 실행을 구분한다. 없음/공백이면 기존 포맷 그대로(스케줄 무변화).
  const runLabel = typeof input.runLabel === "string" ? input.runLabel.trim() : "";
  const base = `${yyyyMmDd} ${workflowName}`;
  if (!runLabel) return base;
  return `${base} — ${runLabel.slice(0, 120)}`;
}

async function resolveWorkflowMissionOwnerAgentId(
  db: Db,
  companyId: string,
  workflow: WorkflowDefinition,
): Promise<string> {
  const stepAgentId = workflow.steps.find((step) => typeof step.agentId === "string" && step.agentId.trim())?.agentId;
  if (stepAgentId) return stepAgentId;

  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(
      eq(agents.companyId, companyId),
      ne(agents.status, "terminated"),
      ne(agents.status, "pending_approval"),
    ))
    .orderBy(asc(agents.createdAt))
    .limit(1);

  if (!agent) {
    throw new Error("Cannot create workflow mission: no agent exists for company");
  }
  return agent.id;
}

async function ensureMissionForWorkflowRun(
  db: Db,
  input: CreateWorkflowRunInput,
): Promise<CreateWorkflowRunInput> {
  if (input.missionId) return input;

  const workflow = await getWorkflowDefinitionById(db, input.workflowId);
  if (!workflow) {
    throw new Error(`Workflow definition not found: ${input.workflowId}`);
  }

  const ownerAgentId = await resolveWorkflowMissionOwnerAgentId(db, input.companyId, workflow);
  const [company] = await db
    .select({ timezone: companies.timezone })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .limit(1);
  const timezone = workflow.timezone ?? company?.timezone ?? null;
  const mission = await missionService(db).create({
    companyId: input.companyId,
    ownerAgentId,
    title: formatWorkflowMissionTitle(workflow.name, { runDate: input.runDate, timezone, runLabel: input.runLabel }),
    description: `Created automatically for workflow run: ${workflow.name}`,
    status: "active",
    source: "workflow",
    // [연결] workflow 정의의 projectId → mission 으로 전파. mission.projectId 가 있어야
    //   heartbeat resolveWorkspaceForRun 이 project_primary workspace 를 주입하고,
    //   step-input-manifest 의 broadScanAllowed 가 켜진다(find . / rg 허용). 없으면 broad scan guard 가
    //   workflow 단계의 정상적인 파일 탐색까지 차단해 첫 단계부터 실패함.
    projectId: workflow.projectId ?? undefined,
  });
  await missionService(db).ensureMainExecutorOversightIssue(mission, workflow.name, {
    workflowStepIds: workflow.steps.map((step) => step.id),
  });

  return { ...input, missionId: mission.id };
}

async function assertNoImplicitDuplicateScheduledWorkflowRun(
  db: Db,
  input: CreateWorkflowRunInput,
  workflow: WorkflowDefinition,
  runDate: string,
): Promise<void> {
  if (input.missionId) return;
  if (typeof workflow.schedule !== "string" || workflow.schedule.trim().length === 0) return;

  const existingScheduledRun = await findActiveScheduledWorkflowMissionRun(db, input, workflow, runDate);
  if (!existingScheduledRun) return;

  throw new Error(
    `Workflow already has an active scheduled workflow mission for ${runDate}: ${existingScheduledRun.id}. `
      + "Finish/cancel the active mission before starting another scheduled run for the same workflow date.",
  );
}

async function findActiveScheduledWorkflowMissionRun(
  db: Db,
  input: Pick<CreateWorkflowRunInput, "companyId" | "workflowId">,
  workflow: WorkflowDefinition,
  runDate: string,
): Promise<WorkflowRun | null> {
  if (typeof workflow.schedule !== "string" || workflow.schedule.trim().length === 0) return null;

  const existingRuns = await listWorkflowRuns(db, {
    companyId: input.companyId,
    workflowId: input.workflowId,
  });

  for (const run of existingRuns) {
    if (run.runDate !== runDate) continue;
    if (typeof run.missionId !== "string" || run.missionId.trim().length === 0) continue;
    if (run.triggerSource !== "schedule" && typeof run.scheduledSlotId !== "string") continue;

    const mission = await missionService(db).getById(run.missionId);
    if (mission?.status === "active") return run;
  }

  return null;
}

import { assertWorkflowChildDefinitionCycles } from "./workflow-child-execution.js";
import { findChildStartIdentityForRun } from "./workflow-child-start-state.js";
import { prepareManualChildResume } from "./workflow-child-manual-resume.js";
import { repairWorkflowChildStartDiscovery } from "./workflow-child-discovery.js";

async function assertWorkflowToolReadiness(
  db: Db,
  companyId: string,
  steps: WorkflowStep[],
): Promise<void> {
  await assertWorkflowToolStepsReady({ companyId, steps });
  await assertWorkflowToolReferencesSelectable(db, { companyId, steps });
  // [Hybrid QA] Structural gates fail closed at create/update/trigger/resume
  //   unless their single named tool is registered, enabled, declares the
  //   structural_validation_v1 capability, and the assignee has a grant.
  //   A plugin-only or unregistered name cannot bypass this. Ordinary tool/agent
  //   steps are unaffected (isStructuralGateStep skips them).
  const structuralErrors = await validateStructuralGateReadinessForSteps({ db, companyId, steps });
  const topologyErrors = getStructuralTopologyErrors(steps);
  const allErrors = [...structuralErrors, ...topologyErrors];
  if (allErrors.length > 0) {
    throw new Error(`Structural gate validation failed: ${allErrors.join("; ")}`);
  }
}

/**
 * Workflow service singleton.
 */
export const workflowService = {
  /**
   * Create a new workflow definition.
   */
  async createDefinition(
    db: Db,
    input: CreateWorkflowDefinitionInput,
  ): Promise<WorkflowDefinition> {
    const steps = normalizeWorkflowSteps(input.steps as unknown[], {
      executionMode: input.executionMode,
    });
    // Validate DAG structure
    const validation = validateDag(steps);
    if (!validation.valid) {
      throw new Error(`Invalid workflow DAG: ${validation.errors.join(", ")}`);
    }
    validateRunInputDeclarations(input.runInputs);
    await assertWorkflowToolReadiness(db, input.companyId, steps);
    // [workflow child step] 정의 생성 시 workflow-step 타깃 체인 CYCLE DFS(자기참조 거부, diamond 허용).
    await assertWorkflowChildDefinitionCycles(db, input.companyId, null, steps);

    return createWorkflowDefinition(db, { ...input, steps });
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
    if (updates.steps) {
      const steps = normalizeWorkflowSteps(updates.steps as unknown[], {
        executionMode: updates.executionMode,
      });
      const validation = validateDag(steps);
      if (!validation.valid) {
        throw new Error(`Invalid workflow DAG: ${validation.errors.join(", ")}`);
      }
      const existing = await getWorkflowDefinitionById(db, id);
      if (!existing) return null;
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

  /**
   * Delete a workflow definition.
   */
  async deleteDefinition(db: Db, id: string): Promise<boolean> {
    return deleteWorkflowDefinition(db, id);
  },

  /**
   * Trigger (create and execute) a workflow run.
   */
  async trigger(
    db: Db,
    input: CreateWorkflowRunInput,
  ): Promise<WorkflowExecutionResult> {
    const workflow = await getWorkflowDefinitionById(db, input.workflowId);
    if (!workflow) {
      throw new Error(`Workflow definition not found: ${input.workflowId}`);
    }
    if (workflow.companyId !== input.companyId) {
      throw new Error(`Workflow does not belong to company: ${input.workflowId}`);
    }
    await assertWorkflowToolReadiness(db, input.companyId, workflow.steps);
    const [company] = await db
      .select({ timezone: companies.timezone })
      .from(companies)
      .where(eq(companies.id, input.companyId))
      .limit(1);
    const timezone = workflow.timezone ?? company?.timezone ?? null;
    const runDate = input.runDate
      ?? (timezone ? formatDateKeyInTimezone(new Date(), timezone) : null)
      ?? new Date().toISOString().slice(0, 10);
    await assertNoImplicitDuplicateScheduledWorkflowRun(db, input, workflow, runDate);
    const runInput = await ensureMissionForWorkflowRun(db, { ...input, runDate });
    const run = await createWorkflowRun(db, runInput);
    if (run.missionId) {
      const mission = await missionService(db).getById(run.missionId);
      if (mission) {
        await missionService(db).ensureMainExecutorOversightIssue(mission, workflow.name, {
          sourceRunId: run.id,
          workflowStepIds: workflow.steps.map((step) => step.id),
        });
      }
    }
    return executeWorkflowRun(db, run.id);
  },

  /**
   * Internal scheduler-only entrypoint. Claims a scheduled slot before creating
   * the run so concurrent scheduler ticks cannot create duplicate scheduled runs.
   */
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
    const workflow = await getWorkflowDefinitionById(db, existingRun.workflowId);
    if (!workflow || workflow.companyId !== input.companyId) {
      throw new Error(`Workflow definition not found: ${existingRun.workflowId}`);
    }
    // [cycle A §3 + cycle B F4] 자식 분류를 readiness/store resume 변이 "이전"에 발견한다. 판별자는
    //   plain/linked/legacy/invalid-child 를 구분하고, 레거시 coherent claimed+nonnull 은 여기서 1회
    //   수리 후 신선한 linked 신원으로 진행한다. invalid/수리 실패는 무차별 store resume/resets 없이
    //   진실한 스냅숏으로 양보하고, plain/missing 만 기존 store resume 을 사용한다.
    const childEntry = await repairWorkflowChildStartDiscovery(db, input.runId);
    let detected: Awaited<ReturnType<typeof findChildStartIdentityForRun>> = null;
    if (childEntry.kind === "yield") {
      // invalid-child/경합/수리 불가 — 실행 재호출 준비 없이 ineligible 스냅숏만(fail-closed).
      return executeWorkflowRun(db, input.runId, { intent: "manual-resume", preparedChildStartFence: undefined });
    }
    if (childEntry.kind === "proceed") {
      detected = await findChildStartIdentityForRun(db, input.runId);
      if (!detected) {
        return executeWorkflowRun(db, input.runId, { intent: "manual-resume", preparedChildStartFence: undefined });
      }
    }
    if (detected) {
      // [cycle B F3] materialized(기존 행) 경로는 준비 트랜잭션 "이전에" 현재 정의 기준
      //   readiness/구조 검증을 수행한다(검증 선행 플래그로 경합 시 busy 양보).
      const [childRow] = await db
        .select({ m: workflowRuns.childStartMaterializedAt })
        .from(workflowRuns)
        .where(eq(workflowRuns.id, input.runId))
        .limit(1);
      const materialized = childRow?.m != null;
      if (materialized) {
        await assertWorkflowToolReadiness(db, input.companyId, workflow.steps);
      }
      const prepared = await prepareManualChildResume(db, detected.identity, {
        // [cycle B F3] 리셋은 준비 트랜잭션 안으로 이동한다(콜백은 txDb 만 받는다 — 외부 db 캡처 금지).
        resetControls: (txDb) => {
          resetFailedControlNodesForResume({
            db: txDb,
            workflowRunId: input.runId,
            steps: normalizeWorkflowStepsForExecution(workflow.steps),
          });
          resetStaleIfControlNodesForResume({
            db: txDb,
            companyId: input.companyId,
            workflowRunId: input.runId,
            steps: normalizeWorkflowStepsForExecution(workflow.steps),
          });
        },
        validatedMaterialized: materialized || undefined,
      });
      if (prepared.kind === "busy" || prepared.kind === "ineligible") {
        // 경합/무자격 — 실행 재호출 없이 진실한 스냅숏만 반환한다(리셋/시작 부수효과 0).
        return executeWorkflowRun(db, input.runId, { intent: "manual-resume", preparedChildStartFence: undefined });
      }
      if (prepared.kind === "native") {
        // materialized 수동 resume — 네이티브 계속(초기화 없음, 시작 시각/영수증 불변).
        return executeWorkflowRun(db, input.runId, { intent: "native-continuation" });
      }
      // owned(0행 재초기화) — 공급된 fence 로만 실행한다(토큰 연속성 보장).
      return executeWorkflowRun(db, input.runId, {
        intent: "manual-resume",
        preparedChildStartFence: prepared.fence,
      });
    }
    await assertWorkflowToolReadiness(db, input.companyId, workflow.steps);
    const run = await resumeWorkflowRun(db, input.runId, input.companyId);
    if (!run) {
      throw new Error(`Workflow run not found: ${input.runId}`);
    }
    // [control node resume recovery] failed control node(IF/complete) 는 executeWorkflowControlNode 의
    //   CAS(status=pending) 재클레임이 불가해 resume 만으로는 재평가되지 않는다. 재실행 전 pending 으로
    //   리셋해 현 상태로 다시 평가되게 한다.
    await resetFailedControlNodesForResume({
      db,
      workflowRunId: run.id,
      steps: normalizeWorkflowStepsForExecution(workflow.steps),
    });
    // [run9 RCA] 완료된 IF 노드도 verdict 입력(소스 work product)이 평가 시점보다 새로 갱신됐으면
    //   stale 로 보고 pending 리셋 후 재평가한다 — producer 수정 후에도 skip 스티키가 영구화되지 않게.
    await resetStaleIfControlNodesForResume({
      db,
      companyId: input.companyId,
      workflowRunId: run.id,
      steps: normalizeWorkflowStepsForExecution(workflow.steps),
    });
    // [cycle A §3] 일반 run — 기존 store resume/readiness/control-reset 동작을 유지하고 intent 없이
    //   실행한다(수동 의도는 링크 자식 경로 전용이다).
    return executeWorkflowRun(db, run.id);
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

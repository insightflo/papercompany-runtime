/**
 * DAG Engine
 *
 * Validates and executes Directed Acyclic Graph (DAG) workflows.
 * A workflow is a DAG where each step has dependencies on other steps.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, asc, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db, IssueExecutionCardJson } from "@paperclipai/db";
import { agents, heartbeatRuns, issueComments, issueWorkProducts, issues, missionPlanArtifacts, missions, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { workflowControlNodeResultSchema, type WorkflowConditionGroup } from "@paperclipai/shared";
import type { DagValidationResult, WorkflowExecutionResult } from "./types.js";
import {
  normalizeWorkflowSyncSource,
  recordWorkflowStepStatusTransition,
  recordWorkflowStepStatusTransitions,
  type WorkflowSyncSource,
} from "./workflow-sync-source.js";
import { syncCancelledWorkflowRunState } from "./workflow-cancelled-state.js";
import { issueService } from "../issues.js";
import { heartbeatService } from "../heartbeat.js";
import { applyIssueCreatedSideEffects } from "../issue-create-side-effects.js";
import { queueIssueAssignmentWakeup } from "../issue-assignment-wakeup.js";
import { isCapOverrideWakeKey } from "./cap-override-wakeup-conflict.js";
import { isHeartbeatFinalizationV1Enabled } from "../heartbeat-finalization/flag.js";
import { stopMissionRuntimesForMission, TERMINAL_WORKFLOW_STATUSES } from "../missions/mission-runtime-manager.js";
import { isQaLikeStep } from "../missions/supervision-helpers.js";
import { activatePlanningMissionForWorkflowRun } from "../missions/mission-workflow-lifecycle.js";
import {
  MISSION_QUALITY_PURPOSE_FITNESS_SENTENCE,
  VERIFICATION_BEFORE_COMPLETION_MARKER,
  extractMissionQualityContract,
  renderAdaptiveQualityProfileLines,
  renderMissionQualityContractSection,
  renderMissionQualityReviewLines,
  renderVerificationBeforeCompletionGateLines,
} from "../missions/mission-quality-contract.js";
import {
  hasExistingDeliveryReadbackStep,
  isDeliveryRelevantStep,
  strengthenDeliveryReadbackSteps,
  synthesizeDeliveryVerificationGateStep,
} from "./delivery-verification-gate.js";
import { logActivity } from "../activity-log.js";
import { normalizeConditionalEdges, type ConditionalEdge } from "./control-flow/types.js";
import {
  classifyStepActivation,
  findSkippableSteps,
  resolveEdges,
  workflowHasConditionalEdges,
  type PredFacts,
  type PredStatus,
} from "./control-flow/edge-condition.js";
import { hasDisallowedCycle } from "./control-flow/cycle-validator.js";
import { applyBackEdgeReworkPass } from "./control-flow/loop-driver.js";
import { readWorkflowReworkContract } from "./control-flow/rework-contract.js";
import { applyStructuralGatePass } from "./control-flow/structural-gate-rework.js";
import { loadDownstreamQaCapAcceptanceContext } from "./control-flow/qa-cap-acceptance-context.js";
import { buildQaCapAcceptanceRuntimeContract } from "./control-flow/qa-cap-runtime-contract.js";
import { readAcceptanceRecord } from "./control-flow/qa-cap-acceptance-records.js";
import { readAttempts } from "./control-flow/verdict-store.js";
import { resolveMissionWorkProductPaths } from "../work-products/output-paths.js";
import { resolveWorkProductLocalFilePath } from "../work-products.js";
import {
  buildArtifactOutputDirectoryLines,
  buildWorkProductRegistrationContractLines,
} from "../work-products/artifact-registration-instructions.js";
import { upsertWorkflowIssueExecutionCard } from "../issue-execution-cards/workflow-upsert.js";
import { readExplicitValidationVerdict } from "../validation-verdict.js";
import { readWorkProductRequirementMarker } from "./workflow-step-workproduct-markers.js";
import { applyWorkProductDependencyGate, collectUniqueStepRunIssueIds, loadWorkProductDependencyGate, reloadWorkflowStepRunsForSameRun } from "./workproduct-dependency-gate.js";
import { normalizeWorkflowQaType } from "./workflow-qa-type.js";
import { resolveWorkflowToolStepArgs } from "./tool-step-args.js";
import { isStructuralGateStep, readStructuralGateProducerToken } from "./control-flow/structural-gate.js";
import { validateStructuralGateReadinessForSteps } from "./control-flow/structural-gate-readiness.js";
import { getStructuralTopologyErrors } from "./control-flow/structural-topology.js";
import { validateWorkflowControlNodes } from "./control-flow/control-node-validation.js";
import {
  executeWorkflowControlNode,
  isWorkflowControlNode,
} from "./control-flow/control-node-executor.js";
import {
  captureStructuralGateProducerToken,
  evaluateSemanticStructuralReadiness,
  renderStructuralGateCoverageLines,
} from "./control-flow/structural-semantic-readiness.js";
import {
  shouldRejectStructuralCallback,
  planStructuralCompletion,
  atomicStructuralCompletion,
  checkDependencyFreshness,
} from "./control-flow/structural-completion.js";
import {
  readWorkflowRetryMetadata,
  isWorkflowRetryDue,
} from "./retry-policy.js";
import {
  isRetryDelayBlockingDispatch,
  markIssueLessRetryDispatchingFromProof,
  shouldPreservePendingRetryFromIssueState,
  stripRetryTrackingOnSuccess,
  wakeIssueBackedRetryAndMarkDispatching,
} from "./retry-launch-dispatch.js";
import { markRetryDispatching } from "./retry-dispatch-state.js";
import { retryIssueLessToolWorkflowStepInternal } from "./retry-issue-less-manual.js";
import { applyWorkflowStepRetryPass } from "./workflow-step-retry-pass.js";
import { shouldLoadValidationVerdictsForRun } from "./validation-verdict-load-gate.js";
export { markRetryDispatching };

/**
 * Workflow step definition.
 */
export interface WorkflowStep {
  id: string;
  name: string;
  title?: string;
  agentId: string;
  agentName?: string;
  assigneeAgentId?: string;
  dependencies: string[]; // step IDs this step depends on
  dependsOn?: string[];
  description?: string;
  type?: string;
  qaType?: string;
  toolName?: string;
  toolArgs?: unknown;
  tools?: string[];
  toolNames?: string[];
  sessionMode?: string;
  onFailure?: string;
  escalateTo?: string;
  maxRetries?: number;
  timeoutSeconds?: number;
  knowledgeBaseIds?: string[];
  triggerOn?: "normal" | "escalation" | string;
  /**
   * Dynamic owner-plan marker. In this mode the native workflow engine only
   * launches bootstrap/root planning steps; the owner plan creates concrete
   * mission child issues dynamically rather than the static DAG activating
   * every declared downstream step.
   */
  dynamicChildren?: boolean | string;
  ownerPlanBootstrapOnly?: boolean | string;
  bootstrapOnly?: boolean | string;
  executionMode?: "static_dag" | "dynamic_owner_plan" | string;
  workflowMode?: "static_dag" | "dynamic_owner_plan" | string;
  executionControls?: WorkflowStepExecutionControls;
  /**
   * 조건부/loop edge (control-flow). legacy `dependencies[]` 는 when:"success" 로 동작한다.
   * edge 평가는 control-flow/edge-condition, cycle 허용은 cycle-validator, loop 재발화는 loop-driver,
   * step 리셋은 step-reset 이 담당 — 여기선 데이터 모델만.
   */
  conditionalDependencies?: ConditionalEdge[];
  /**
   * Native control nodes. type:"if" 인 step 의 typed condition group(평가는 condition-evaluator),
   * type:"complete" 인 step 의 optional 사람-readable 완료 사유. 두 필드 모두 normalize spread 로 보존.
   */
  conditionGroup?: WorkflowConditionGroup;
  completionReason?: string;
  /**
   * 이 step이 파일 산출물을 생산하는지(compile-time 계약).
   * normalizeWorkflowStepsForExecution 이 명시 true/alias true만 true로 정규화한다.
   * true면 createWorkflowStepIssue 가 출력 디렉토리 + [ARTIFACT]: 등록 contract를 주입하고,
   * heartbeat missing-workProduct gate가 적용된다.
   */
  graphWorkProductRequired?: boolean;
  /**
   * 이 step이 adapter에게 tool auto-approve(예: hermes_local --yolo)를 요구하는지(compile-time 계약).
   * normalizeWorkflowStepsForExecution 이 명시 true(literal)만 true로 정규화한다(string/number/alias 거부).
   * true면 createWorkflowStepIssue 가 issue 의 assigneeAdapterOverrides.adapterConfig.autoApproveTools=true 를
   * 주입하고, heartbeat 가 이를 runtime adapter config 에 merge한다(Hermes 는 autoApproveTools→--yolo 매핑).
   */
  autoApproveTools?: boolean;
  graphRetryDelaySeconds?: number;
  graphRetryBackoff?: "fixed" | "linear" | "exponential";
  graphRetryJitter?: boolean;
}

export type WorkflowExecutionMode = "static_dag" | "dynamic_owner_plan";

export interface WorkflowStepExecutionControls {
  concurrencyKey?: string;
  concurrencyLimit?: number;
  priority?: string;
  cacheEnabled?: boolean;
  cacheTtlSeconds?: number;
  deleteAfterUse?: boolean;
}

type PersistedWorkflowStep = WorkflowStep & {
  title?: unknown;
  dependsOn?: unknown;
  tools?: unknown;
  toolName?: unknown;
  toolArgs?: unknown;
  type?: unknown;
  qaType?: unknown;
  agentName?: unknown;
  executionControls?: unknown;
  graphConcurrencyKey?: unknown;
  graphConcurrencyLimit?: unknown;
  graphPriority?: unknown;
  graphCacheEnabled?: unknown;
  graphCacheTtlSeconds?: unknown;
  graphDeleteAfterUse?: unknown;
  graphWorkProductRequired?: unknown;
  autoApproveTools?: unknown;
  workProductRequired?: unknown;
  requiresWorkProduct?: unknown;
};

const WORKFLOW_STEP_TERMINAL_STATUSES = new Set(["completed", "failed", "skipped"]);

export type WorkflowToolStepExecutionRequest = {
  companyId: string;
  workflowRunId: string;
  workflowId: string;
  stepId: string;
  stepRunId: string;
  toolName: string;
  args: unknown;
  requestId: string;
  agentId?: string;
  agentName?: string;
};

export type WorkflowToolStepExecutionResult = {
  accepted?: boolean;
  duplicate?: boolean;
};

export type WorkflowToolStepExecutor = (
  request: WorkflowToolStepExecutionRequest,
) => Promise<WorkflowToolStepExecutionResult | void>;

export type WorkflowToolStepReadiness = {
  available: boolean;
  reason?: string;
};

export type WorkflowToolStepReadinessChecker = (input: {
  companyId: string;
  toolNames: string[];
}) => Promise<WorkflowToolStepReadiness>;

export type WorkflowToolStepQueueDispatchResult = {
  claimedCount: number;
  executedCount: number;
  failedCount: number;
  skippedCount: number;
};

let workflowToolStepExecutor: WorkflowToolStepExecutor | null = null;
let workflowToolStepReadinessChecker: WorkflowToolStepReadinessChecker | null = null;

export function setWorkflowToolStepExecutor(executor: WorkflowToolStepExecutor | null): void {
  workflowToolStepExecutor = executor;
}

export function setWorkflowToolStepReadinessChecker(checker: WorkflowToolStepReadinessChecker | null): void {
  workflowToolStepReadinessChecker = checker;
}

export function getWorkflowToolReferenceNames(steps: WorkflowStep[]): string[] {
  return Array.from(new Set(
    steps.flatMap((step) => Array.isArray(step.toolNames)
      ? step.toolNames.map((toolName) => toolName.trim()).filter(Boolean)
      : []),
  ))
    .filter((toolName) => toolName !== "delegate_to_company")
    .sort((a, b) => a.localeCompare(b));
}

export async function assertWorkflowToolStepsReady(input: {
  companyId: string;
  steps: WorkflowStep[];
}): Promise<void> {
  const toolNames = getWorkflowToolReferenceNames(input.steps);
  if (toolNames.length === 0) return;

  const readiness = workflowToolStepReadinessChecker
    ? await workflowToolStepReadinessChecker({ companyId: input.companyId, toolNames })
    : { available: true };
  if (!readiness.available) {
    throw new Error(`Workflow tools are unavailable: ${readiness.reason ?? "tool execution is not available."}`);
  }

  if (!workflowToolStepExecutor) {
    throw new Error("Workflow tools are unavailable: Workflow tool step executor is not configured.");
  }
}

export type WorkflowExecutionContext = {
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
  steps: WorkflowStep[];
  stepRuns: (typeof workflowStepRuns.$inferSelect)[];
};

type WorkflowDefinitionExecutionShape = {
  name?: unknown;
  executionMode?: unknown;
  dynamicPlanBootstrapOnly?: unknown;
  workflowMode?: unknown;
  steps?: WorkflowStep[];
};

function normalizeStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const strings = value
      .map((item) => typeof item === "string" ? item.trim() : "")
      .filter(Boolean);
    return strings.length > 0 ? strings : undefined;
  }
  if (typeof value === "string") {
    const strings = value.split(",").map((item) => item.trim()).filter(Boolean);
    return strings.length > 0 ? strings : undefined;
  }
  return undefined;
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeBooleanMarker(value: unknown): boolean | undefined {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off" || normalized === "") return false;
  }
  return undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const numberValue = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value.trim())
      : NaN;
  if (!Number.isFinite(numberValue)) return undefined;
  const integer = Math.trunc(numberValue);
  return integer > 0 ? integer : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeWorkflowStepExecutionControls(step: PersistedWorkflowStep): WorkflowStepExecutionControls | undefined {
  const rawControls = normalizeRecord(step.executionControls);
  const concurrencyKey = normalizeOptionalString(rawControls.concurrencyKey) ?? normalizeOptionalString(step.graphConcurrencyKey);
  const concurrencyLimit = normalizePositiveInteger(rawControls.concurrencyLimit) ?? normalizePositiveInteger(step.graphConcurrencyLimit);
  const priority = (normalizeOptionalString(rawControls.priority) ?? normalizeOptionalString(step.graphPriority))?.toLowerCase();
  const explicitCacheEnabled = normalizeBooleanMarker(rawControls.cacheEnabled) ?? normalizeBooleanMarker(step.graphCacheEnabled);
  const cacheTtlSeconds = normalizePositiveInteger(rawControls.cacheTtlSeconds) ?? normalizePositiveInteger(step.graphCacheTtlSeconds);
  const deleteAfterUse = normalizeBooleanMarker(rawControls.deleteAfterUse) ?? normalizeBooleanMarker(step.graphDeleteAfterUse);
  const controls: WorkflowStepExecutionControls = {};

  if (concurrencyKey) controls.concurrencyKey = concurrencyKey;
  if (concurrencyLimit) controls.concurrencyLimit = concurrencyLimit;
  if (priority) controls.priority = priority;
  if (explicitCacheEnabled === true || cacheTtlSeconds) {
    controls.cacheEnabled = true;
  }
  if (controls.cacheEnabled && cacheTtlSeconds) {
    controls.cacheTtlSeconds = cacheTtlSeconds;
  }
  if (deleteAfterUse === true) controls.deleteAfterUse = true;

  return Object.keys(controls).length > 0 ? controls : undefined;
}

export function normalizeWorkflowStepsForExecution(rawSteps: unknown): WorkflowStep[] {
  if (!Array.isArray(rawSteps)) return [];
  return rawSteps.map((rawStep) => {
    const step = (rawStep && typeof rawStep === "object" ? rawStep : {}) as PersistedWorkflowStep;
    const id = typeof step.id === "string" && step.id.trim() ? step.id.trim() : crypto.randomUUID();
    const name = typeof step.name === "string" && step.name.trim()
      ? step.name.trim()
      : typeof step.title === "string" && step.title.trim()
        ? step.title.trim()
        : typeof step.id === "string" && step.id.trim()
          ? step.id.trim()
          : "Untitled step";
    const dependencies = normalizeStringArray(step.dependencies) ?? normalizeStringArray(step.dependsOn) ?? [];
    const toolNames = normalizeStringArray(step.toolNames)
      ?? normalizeStringArray(step.tools)
      ?? normalizeStringArray(step.toolName);
    const executionControls = normalizeWorkflowStepExecutionControls(step);
    const conditionalDependencies = normalizeConditionalEdges(step.conditionalDependencies);
    const qaType = normalizeWorkflowQaType(step.qaType);
    const graphWorkProductRequired = isQaLikeStep({
      id,
      name,
      title: typeof step.title === "string" ? step.title : undefined,
      type: typeof step.type === "string" ? step.type : undefined,
      qaType,
    })
      ? false
      : readWorkProductRequirementMarker(step) === true;
    const autoApproveTools = step.autoApproveTools === true ? true : undefined;
    return {
      ...step,
      id,
      name,
      agentId: typeof step.agentId === "string" ? step.agentId : "",
      dependencies,
      qaType: qaType ?? undefined,
      ...(toolNames ? { toolNames } : {}),
      ...(executionControls ? { executionControls } : {}),
      // raw 를 normalized(또는 undefined)로 덮어쓴다 — undefined 면 직렬화에서 생략.
      conditionalDependencies,
      graphWorkProductRequired,
      autoApproveTools,
    };
  });
}

function isTruthyBooleanMarker(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

function isDynamicOwnerPlanStep(step: WorkflowStep): boolean {
  return isTruthyBooleanMarker(step.dynamicChildren)
    || isTruthyBooleanMarker(step.ownerPlanBootstrapOnly)
    || isTruthyBooleanMarker(step.bootstrapOnly)
    || step.executionMode === "dynamic_owner_plan"
    || step.workflowMode === "dynamic_owner_plan";
}

function hasRootPlanningStep(steps: WorkflowStep[]): boolean {
  return steps.some((step) => {
    if (step.triggerOn === "escalation" || step.dependencies.length > 0) {
      return false;
    }
    const id = step.id.toLowerCase();
    const name = step.name.toLowerCase();
    return id === "plan" || id.endsWith("-plan") || name.includes("plan") || name.includes("계획");
  });
}

function isLegacyResearchDailyWorkflowName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const normalized = name.trim().toLowerCase();
  return normalized === "tech-scout"
    || normalized === "tech-ai-news"
    || normalized === "daily-tech-scout"
    || normalized === "daily-tech-ai-news";
}

export function isDynamicOwnerPlanWorkflowDefinition(
  definition: WorkflowDefinitionExecutionShape,
): boolean {
  if (definition.executionMode === "static_dag" || definition.workflowMode === "static_dag") {
    return false;
  }

  if (
    definition.executionMode === "dynamic_owner_plan"
    || definition.workflowMode === "dynamic_owner_plan"
    || isTruthyBooleanMarker(definition.dynamicPlanBootstrapOnly)
  ) {
    return true;
  }

  const steps = Array.isArray(definition.steps) ? definition.steps : [];
  if (steps.some(isDynamicOwnerPlanStep)) {
    return true;
  }

  return isLegacyResearchDailyWorkflowName(definition.name) && hasRootPlanningStep(steps);
}

export function getWorkflowLaunchSteps(
  steps: WorkflowStep[],
  options: { dynamicOwnerPlan?: boolean } = {},
): WorkflowStep[] {
  if (!options.dynamicOwnerPlan) return steps;
  return steps.filter((step) => step.triggerOn !== "escalation" && step.dependencies.length === 0);
}

export interface WorkflowDefinitionExecutionInput {
  readonly name: unknown;
  readonly stepsJson: unknown;
  readonly executionMode?: unknown;
  readonly dynamicPlanBootstrapOnly?: unknown;
  readonly workflowMode?: unknown;
}

export function buildWorkflowExecutionSteps(definition: WorkflowDefinitionExecutionInput): WorkflowStep[] {
  let steps = normalizeWorkflowStepsForExecution(definition.stepsJson);
  if (
    !isDynamicOwnerPlanWorkflowDefinition({
      name: definition.name,
      executionMode: definition.executionMode,
      dynamicPlanBootstrapOnly: definition.dynamicPlanBootstrapOnly,
      workflowMode: definition.workflowMode,
      steps,
    })
  ) {
    const deliverySteps = steps.filter(isDeliveryRelevantStep);
    if (deliverySteps.length > 0 && hasExistingDeliveryReadbackStep(steps)) {
      steps = strengthenDeliveryReadbackSteps(steps);
    } else if (deliverySteps.length > 0) {
      const gateAgentId = deliverySteps[deliverySteps.length - 1]?.agentId ?? "";
      steps = [
        ...steps,
        synthesizeDeliveryVerificationGateStep({
          dependencyStepIds: deliverySteps.map((step) => step.id),
          agentId: gateAgentId,
        }),
      ];
    }
  }
  return steps;
}

function buildWorkflowDefinitionExecutionShape(context: WorkflowExecutionContext): WorkflowDefinitionExecutionShape {
  const definitionMeta = context.definition as typeof workflowDefinitions.$inferSelect & {
    executionMode?: unknown;
    dynamicPlanBootstrapOnly?: unknown;
    workflowMode?: unknown;
  };
  return {
    name: context.definition.name,
    executionMode: definitionMeta.executionMode,
    dynamicPlanBootstrapOnly: definitionMeta.dynamicPlanBootstrapOnly,
    workflowMode: definitionMeta.workflowMode,
    steps: context.steps,
  };
}

function getDynamicLaunchStepIds(context: WorkflowExecutionContext): Set<string> | undefined {
  const dynamicOwnerPlan = isDynamicOwnerPlanWorkflowDefinition(buildWorkflowDefinitionExecutionShape(context));
  if (!dynamicOwnerPlan) return undefined;
  return new Set(getWorkflowLaunchSteps(context.steps, { dynamicOwnerPlan }).map((step) => step.id));
}


/**
 * Validates that a workflow DAG is acyclic and well-formed.
 *
 * @param steps - The workflow steps to validate.
 * @returns Validation result with any errors or warnings.
 */
export function validateDag(steps: WorkflowStep[]): DagValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const stepIds = new Set(steps.map((s) => s.id));

  // Check for duplicate step IDs
  if (stepIds.size !== steps.length) {
    errors.push("Duplicate step IDs detected");
  }

  // Check for orphan dependencies (legacy dependencies[] + conditionalDependencies edge.stepId)
  for (const step of steps) {
    for (const dep of step.dependencies) {
      if (!stepIds.has(dep)) {
        errors.push(`Step "${step.id}" depends on non-existent step "${dep}"`);
      }
    }
    // [IF/loop] conditional edge 의 선행 stepId 도 orphan 검사 — 빠지면 해당 step 이 영원히 waiting 에
    // 갇혀 run 이 terminal 에 수렴하지 못 한다(가즈아 60min reconciler kill 회귀).
    for (const edge of step.conditionalDependencies ?? []) {
      if (!stepIds.has(edge.stepId)) {
        errors.push(`Step "${step.id}" conditionalDependency references non-existent step "${edge.stepId}"`);
      }
    }
  }

  // Native IF/Complete nodes have stricter semantic topology than ordinary DAG
  // steps. Validate it at the shared create/update/launch boundary so malformed
  // branches cannot be persisted or executed.
  errors.push(...validateWorkflowControlNodes(steps));

  // Check for cycles: annotated back-edge(isBackEdge+maxIterations≥1) 로 닫히는 cycle(bounded loop)은 허용,
  // 그 외 우연한 cycle 은 거부(control-flow/cycle-validator).
  const hasCycle = hasDisallowedCycle(steps);
  if (hasCycle) {
    errors.push("Workflow contains an unannotated cycle (circular dependency); only annotated back-edges (isBackEdge + maxIterations) may form a bounded loop");
  }

  // Check for steps with no dependencies (entry points)
  const entryPoints = steps.filter((s) => s.dependencies.length === 0);
  if (entryPoints.length === 0 && steps.length > 0) {
    errors.push("Workflow has no entry points (all steps have dependencies)");
  }

  // Check for unreachable steps
  if (entryPoints.length > 0) {
    const reachable = new Set<string>();
    for (const entry of entryPoints) {
      dfsReachable(entry, steps, reachable);
    }
    for (const step of steps) {
      if (!reachable.has(step.id)) {
        warnings.push(`Step "${step.id}" is unreachable from any entry point`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Marks all steps reachable from the given step.
 */
function dfsReachable(step: WorkflowStep, allSteps: WorkflowStep[], visited: Set<string>): void {
  if (visited.has(step.id)) return;
  visited.add(step.id);

  for (const depId of step.dependencies) {
    const dep = allSteps.find((s) => s.id === depId);
    if (dep) {
      dfsReachable(dep, allSteps, visited);
    }
  }
}

async function loadWorkflowExecutionContext(db: Db, runId: string): Promise<WorkflowExecutionContext> {
  const runResult = await db
    .select({
      run: workflowRuns,
      definition: workflowDefinitions,
    })
    .from(workflowRuns)
    .innerJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
    .where(eq(workflowRuns.id, runId))
    .limit(1);

  if (!runResult[0]) {
    throw new Error(`Workflow run ${runId} not found`);
  }

  const { run, definition } = runResult[0] as {
    run: typeof workflowRuns.$inferSelect;
    definition: typeof workflowDefinitions.$inferSelect;
  };
  const steps = buildWorkflowExecutionSteps(definition);
  const stepRuns = await db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, runId));

  return { run, definition, steps, stepRuns };
}

async function ensureStepRunRecords(
  db: Db,
  runId: string,
  steps: WorkflowStep[],
): Promise<(typeof workflowStepRuns.$inferSelect)[]> {
  const existing = await db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, runId));

  const existingStepIds = new Set(existing.map((stepRun) => stepRun.stepId));
  const missingSteps = steps.filter((step) => !existingStepIds.has(step.id));

  if (missingSteps.length > 0) {
    await db.insert(workflowStepRuns).values(
      missingSteps.map((step) => ({
        id: crypto.randomUUID(),
        workflowRunId: runId,
        stepId: step.id,
        status: "pending",
        metadata: buildWorkflowStepRunMetadata(step),
      })),
    );
  }

  const stepRuns = missingSteps.length === 0
    ? existing
    : await db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, runId));
  return syncStepRunExecutionControlMetadata(db, stepRuns, steps);
}

function buildWorkflowStepRunMetadata(
  step: WorkflowStep,
  existingMetadata: unknown = {},
): Record<string, unknown> {
  const metadata = { ...normalizeRecord(existingMetadata) };
  if (step.executionControls && Object.keys(step.executionControls).length > 0) {
    metadata.executionControls = step.executionControls;
  } else {
    delete metadata.executionControls;
  }
  // heartbeat missing-workProduct gate가 이 step의 산출물 여부를
  // title/contract 휴리스틱 없이 권위적으로 판정하도록 stamp. syncStepRunExecutionControlMetadata 가
  // 로드 시마다 재동기화하므로 기존 step-run에도 채워진다.
  metadata.graphWorkProductRequired = step.graphWorkProductRequired === true;
  return metadata;
}

function metadataJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

async function syncStepRunExecutionControlMetadata(
  db: Db,
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
  steps: WorkflowStep[],
): Promise<(typeof workflowStepRuns.$inferSelect)[]> {
  if (stepRuns.length === 0) return stepRuns;

  const stepById = new Map(steps.map((step) => [step.id, step]));
  let changed = false;
  for (const stepRun of stepRuns) {
    const step = stepById.get(stepRun.stepId);
    if (!step) continue;
    const nextMetadata = buildWorkflowStepRunMetadata(step, stepRun.metadata);
    if (metadataJson(stepRun.metadata) === metadataJson(nextMetadata)) continue;
    changed = true;
    await db
      .update(workflowStepRuns)
      .set({ metadata: nextMetadata })
      .where(eq(workflowStepRuns.id, stepRun.id));
  }

  if (!changed) return stepRuns;
  return reloadWorkflowStepRunsForSameRun(db, stepRuns);
}

function desiredStepRunStatusFromIssueStatus(issueStatus: string): "pending" | "running" | "completed" | "failed" {
  if (issueStatus === "done") return "completed";
  if (issueStatus === "blocked" || issueStatus === "cancelled") return "failed";
  if (issueStatus === "in_progress" || issueStatus === "in_review") return "running";
  return "pending";
}

function isValidationGateCandidate(input: {
  issueTitle?: string | null;
  issueOriginKind?: string | null;
  step?: WorkflowStep | null;
}): boolean {
  if (
    input.issueOriginKind === "mission_main_executor_plan" ||
    input.issueOriginKind === "mission_main_executor_oversight" ||
    input.issueOriginKind === "mission_main_executor_unblock"
  ) {
    return false;
  }

  if (input.step) return isQaLikeStep(input.step);
  return isQaLikeStep({ title: input.issueTitle });
}

async function writeQaRubricMarkdown(input: {
  filePath: string;
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
  step: WorkflowStep;
  renderedStepDescription: string | null;
  dependencyIssueLines: string[];
  missingDependencyWorkProductLines: string[];
  missionGoal?: string | null;
  missionTitle?: string | null;
  missionDescription?: string | null;
  structuralGateCoverageLines?: string[];
}): Promise<void> {
  await mkdir(path.dirname(input.filePath), { recursive: true });
  // [AREA: Mission Quality Contract] mission goal 에서 품질 contract 도출 → rubric 주입.
  // goal 소스: active plan missionGoal 우선 → mission title+description fallback(caller 주입).
  const qualityContractSource = input.missionGoal ?? input.missionTitle ?? null;
  const qualityContractLines = qualityContractSource
    ? [
        MISSION_QUALITY_PURPOSE_FITNESS_SENTENCE,
        "",
        ...renderMissionQualityContractSection(
          extractMissionQualityContract({
            missionGoal: input.missionGoal ?? "",
            missionTitle: input.missionTitle,
            missionDescription: input.missionDescription,
          }),
        ),
        ...renderAdaptiveQualityProfileLines(),
        ...renderMissionQualityReviewLines(),
      ]
    : [];
  const verificationGateLines = input.renderedStepDescription?.includes(VERIFICATION_BEFORE_COMPLETION_MARKER)
    ? []
    : renderVerificationBeforeCompletionGateLines({ intermediateQa: true });
  const body = [
    "# QA grading rubric",
    "",
    "This rubric is workflow-owned input for the QA/validator step. Do not invent a new grading standard; judge the dependency workProducts against this rubric.",
    "",
    ...qualityContractLines,
    ...verificationGateLines,
    "## Workflow execution boundary",
    "",
    `- workflowRunId: ${input.run.id}`,
    `- workflowDefinitionId: ${input.definition.id}`,
    `- missionId: ${input.run.missionId ?? "none"}`,
    `- stepId: ${input.step.id}`,
    `- dependencyStepIds: ${JSON.stringify(input.step.dependencies)}`,
    "",
    "## Evaluation criteria",
    "",
    input.renderedStepDescription?.trim()
      || "No step-specific criteria were provided by the workflow owner. Validate only objective completeness, dependency workProduct availability, and explicit workflow success requirements.",
    "",
    "## Verdict severity precedence",
    "",
    "- A failed checklist item or probe is evidence to assess, not an automatic blocking verdict.",
    "- The Outcome review standard governs even when step-specific criteria use absolute wording such as `PASS only` or `otherwise REQUEST_CHANGES`.",
    "- REQUEST_CHANGES only when the inspector judges that the material consequence blocks safe or useful use, downstream consumption, delivery, or verification. Otherwise return PASS and list the optional improvement separately.",
    "",
    ...(input.structuralGateCoverageLines ?? []),
    "## Dependency inputs",
    "",
    input.dependencyIssueLines.length > 0
      ? input.dependencyIssueLines.join("\n")
      : "- No dependency issue inputs are registered for this step.",
    "",
    ...(input.missingDependencyWorkProductLines.length > 0
      ? [
          "## Missing dependency hard-stop",
          "",
          ...input.missingDependencyWorkProductLines,
          "- If this step needs the missing dependency deliverable, return `REQUEST_CHANGES: <specific missing workProduct>` instead of guessing from the filesystem.",
          "",
        ]
      : []),
    "## Required verdict",
    "",
    "- Read the dependency workProduct files directly when paths are provided.",
    "- Return `PASS` when no blocking defect remains, even if nonblocking limitations or optional improvements remain.",
    "- Return `REQUEST_CHANGES: <specific gaps>` only for blocking defects. Explain the material consequence that makes each requested change blocking.",
    "- End the final answer with one clear verdict: `PASS` or `REQUEST_CHANGES: <specific gaps>`.",
    "",
  ].join("\n");
  await writeFile(input.filePath, body, "utf8");
}

function buildWorkflowApiCloseoutLines(input: {
  requiresWorkProduct: boolean;
  requiresVerdict: boolean;
}): string[] {
  const lines = [
    "Workflow API closeout:",
    "- Use the installed `paperclip` skill for request examples and Paperclip API environment variables.",
  ];
  if (input.requiresWorkProduct) {
    lines.push("- If this step creates or reuses a file artifact, register it with `POST /api/issues/{issueId}/workflow/artifacts` before completion.");
    lines.push("- If this step publishes a public URL, register it with `POST /api/issues/{issueId}/workflow/artifacts` using `type: \"preview_url\"` and `url` before completion.");
  }
  if (input.requiresVerdict) {
    lines.push("- Submit the official `PASS`, `REQUEST_CHANGES`, or `INSUFFICIENT_EVIDENCE` verdict with `POST /api/issues/{issueId}/workflow/verdict` before completion.");
    lines.push("- Use `INSUFFICIENT_EVIDENCE` only when the evidence needed to judge is genuinely missing; list what is missing in `reason` (required). It records an abstention — it does not satisfy this gate and does not trigger producer rework.");
  }
  lines.push("- Complete this workflow issue with `POST /api/issues/{issueId}/workflow/complete` after required artifact or verdict records exist.");
  lines.push("- Use normal issue status/comment updates only if the Workflow API is unavailable or the issue is blocked.");
  return lines;
}

async function commentOnValidationRecheckQueued(input: {
  db: Db;
  companyId: string;
  issueId: string;
  workflowRunId: string;
  step: WorkflowStep;
}): Promise<void> {
  const dependencyStepIds = input.step.dependencies;
  const dependencyRows = dependencyStepIds.length > 0
    ? await input.db
      .select({
        stepId: workflowStepRuns.stepId,
        issueId: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
      })
      .from(workflowStepRuns)
      .innerJoin(issues, eq(workflowStepRuns.issueId, issues.id))
      .where(and(
        eq(workflowStepRuns.workflowRunId, input.workflowRunId),
        inArray(workflowStepRuns.stepId, dependencyStepIds),
      ))
    : [];

  const order = new Map(dependencyStepIds.map((stepId, index) => [stepId, index]));
  dependencyRows.sort((a, b) => (order.get(a.stepId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.stepId) ?? Number.MAX_SAFE_INTEGER));

  const workProductRows = dependencyRows.length > 0
    ? await input.db
      .select({
        issueId: issueWorkProducts.issueId,
        title: issueWorkProducts.title,
        type: issueWorkProducts.type,
        provider: issueWorkProducts.provider,
        url: issueWorkProducts.url,
        externalId: issueWorkProducts.externalId,
        metadata: issueWorkProducts.metadata,
        status: issueWorkProducts.status,
      })
      .from(issueWorkProducts)
      .where(inArray(issueWorkProducts.issueId, dependencyRows.map((row) => row.issueId)))
    : [];

  const workProductsByIssueId = new Map<string, typeof workProductRows>();
  for (const product of workProductRows) {
    const products = workProductsByIssueId.get(product.issueId) ?? [];
    products.push(product);
    workProductsByIssueId.set(product.issueId, products);
  }

  const renderWorkProductSummary = (product: typeof workProductRows[number]) => {
    const metadata = normalizeRecord(product.metadata);
    const metadataPath = typeof metadata.path === "string" ? metadata.path : null;
    const artifactRef = metadataPath ?? product.url ?? product.externalId ?? (
      product.metadata ? JSON.stringify(product.metadata) : "no artifact ref"
    );
    return `${product.title} [${product.type}/${product.status}] ${artifactRef}`;
  };

  const dependencyIssueLines = dependencyRows.flatMap((row) => {
    const products = workProductsByIssueId.get(row.issueId) ?? [];
    const lines = [
      `- ${row.stepId}: ${row.identifier ?? row.issueId} (${row.status}) — ${row.title}`,
    ];
    if (products.length > 0) {
      lines.push(`  workProducts: ${products.map(renderWorkProductSummary).join("; ")}`);
    } else {
      lines.push("  workProducts: none registered");
    }
    return lines;
  });

  const missingWorkProductLines = dependencyRows
    .filter((row) => (workProductsByIssueId.get(row.issueId) ?? []).length === 0)
    .map((row) => `- ${row.stepId}: ${row.identifier ?? row.issueId} has no registered dependency workProduct.`);

  await input.db.insert(issueComments).values({
    companyId: input.companyId,
    issueId: input.issueId,
    body: [
      "### Workflow validation recheck",
      "",
      "The producer/dependency completed after the previous REQUEST_CHANGES verdict.",
      "Re-run this validation using the current dependency workProducts below.",
      "",
      `- workflowRunId: ${input.workflowRunId}`,
      `- stepId: ${input.step.id}`,
      `- dependencyStepIds: ${JSON.stringify(dependencyStepIds)}`,
      "",
      "Current dependency issue inputs:",
      ...(dependencyIssueLines.length > 0 ? dependencyIssueLines : ["- No dependency issue inputs are registered for this step."]),
      ...(missingWorkProductLines.length > 0
        ? [
            "",
            "Missing dependency hard-stop:",
            ...missingWorkProductLines,
            "- If this validation needs a missing dependency deliverable, return `REQUEST_CHANGES: <specific missing workProduct>`.",
          ]
        : []),
    ].join("\n"),
  });
}

type ValidationVerdict = "pass" | "request_changes";

interface ValidationVerdictObservation {
  verdict: ValidationVerdict | null;
  observedAt: Date | null;
}

function desiredValidationCheckStepStatus(input: {
  issueStatus: string;
  latestVerdict: ValidationVerdictObservation | undefined;
}): "pending" | "running" | "completed" | "failed" {
  if (input.issueStatus !== "done") {
    return desiredStepRunStatusFromIssueStatus(input.issueStatus);
  }
  if (input.latestVerdict?.verdict === "pass") return "completed";
  if (input.latestVerdict?.verdict === "request_changes") return "failed";
  return "running";
}

function isNewerValidationVerdict(
  next: ValidationVerdictObservation,
  current: ValidationVerdictObservation | undefined,
): boolean {
  if (!current) return true;
  const nextTime = next.observedAt?.getTime() ?? 0;
  const currentTime = current.observedAt?.getTime() ?? 0;
  return nextTime >= currentTime;
}

function setLatestValidationVerdict(
  verdictsByIssueId: Map<string, ValidationVerdictObservation>,
  issueId: string | null,
  verdict: ValidationVerdict | null,
  observedAt: Date | null,
): void {
  if (!issueId) return;
  const next = { verdict, observedAt };
  if (isNewerValidationVerdict(next, verdictsByIssueId.get(issueId))) {
    verdictsByIssueId.set(issueId, next);
  }
}


function stepRunNeedsWorkflowResume(stepRun: typeof workflowStepRuns.$inferSelect): boolean {
  return stepRun.status === "pending" && (stepRun.iterationIndex ?? 0) > 0;
}
function isPendingReworkAwaitingCurrentIssueCompletion(
  stepRun: typeof workflowStepRuns.$inferSelect,
  issueCompletedAt: Date | null,
): boolean {
  if (stepRun.status !== "pending" || (stepRun.iterationIndex ?? 0) === 0) return false;
  const priorCompletedAt = readAttempts(stepRun.metadata).at(-1)?.completedAt;
  if (!priorCompletedAt || !issueCompletedAt) return true;
  const priorCompletedMs = new Date(priorCompletedAt).getTime();
  return !Number.isFinite(priorCompletedMs) || issueCompletedAt.getTime() <= priorCompletedMs;
}

/**
 * [목적] 주어진 issue 들에 대해 최신 validation verdict(pass|request_changes|null) 를 durable
 *   workflow_validation_verdict event 에서만 읽어 issueId→observation 맵으로 반환.
 *   syncStepRunsFromIssueState 와 syncWorkflowRunState(loop-driver predFacts 빌드) 가 동일 원천을 공유.
 * [scope fail-closed] 각 issue 의 CURRENT workflow run + step run + company exact binding 만 인정.
 *   재사용된 issue의 과거 run/step verdict 가 현재 DAG 판정을 좌우하지 않는다(startedAt 단독 대체 ❌).
 */
type WorkflowValidationIssueBinding = {
  readonly companyId: string;
  readonly workflowRunId: string;
  readonly workflowStepRunId: string;
};

async function loadLatestValidationVerdicts(
  db: Db,
  bindings: ReadonlyMap<string, WorkflowValidationIssueBinding>,
): Promise<Map<string, ValidationVerdictObservation>> {
  const verdicts = new Map<string, ValidationVerdictObservation>();
  if (bindings.size === 0) return verdicts;

  const issueIds = [...bindings.keys()];
  const issueRows = await db
    .select({
      id: issues.id,
      startedAt: issues.startedAt,
    })
    .from(issues)
    .where(inArray(issues.id, issueIds));
  const minObservedAtByIssueId = new Map(issueRows.map((issue) => [issue.id, issue.startedAt ?? null]));
  const isWithinCurrentExecutionWindow = (issueId: string | null, observedAt: Date | null): boolean => {
    if (!issueId || !observedAt) return true;
    const minObservedAt = minObservedAtByIssueId.get(issueId);
    return !minObservedAt || observedAt.getTime() >= minObservedAt.getTime();
  };

  const eventRows = await db
    .select({
      issueId: workflowTransitionEvents.issueId,
      verdict: workflowTransitionEvents.verdict,
      createdAt: workflowTransitionEvents.createdAt,
      companyId: workflowTransitionEvents.companyId,
      workflowRunId: workflowTransitionEvents.workflowRunId,
      workflowStepRunId: workflowTransitionEvents.workflowStepRunId,
      heartbeatRunId: workflowTransitionEvents.heartbeatRunId,
    })
    .from(workflowTransitionEvents)
    .where(and(
      inArray(workflowTransitionEvents.issueId, issueIds),
      eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      // structured authority only: ignore legacy comment/heartbeat_result derived events.
      eq(workflowTransitionEvents.reason, "workflow_api"),
    ))
    .orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id));
  // [verdict authority] batch-resolve backing heartbeat runs and keep only those scoped (company +
  //   issue) to their QA issue — the verdict API always runs on a checked-out run of the QA issue.
  const heartbeatRunIds = Array.from(new Set(
    eventRows.map((event) => event.heartbeatRunId).filter((id): id is string => typeof id === "string"),
  ));
  const heartbeatRunScopeById = new Map<string, { companyId: string | null; issueId: string | null }>();
  if (heartbeatRunIds.length > 0) {
    const runScopeRows = await db
      .select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, issueId: heartbeatRuns.issueId })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, heartbeatRunIds));
    for (const row of runScopeRows) {
      heartbeatRunScopeById.set(row.id, { companyId: row.companyId, issueId: row.issueId });
    }
  }
  for (const event of eventRows) {
    const observedAt = event.createdAt ?? null;
    if (!isWithinCurrentExecutionWindow(event.issueId, observedAt)) continue;
    if (event.verdict !== "pass" && event.verdict !== "request_changes") continue;
    // [scope fail-closed] exact binding to the issue's current workflow run + step run + company.
    //   a reused issue's prior-run verdict must never drive the current DAG verdict.
    const binding = event.issueId ? bindings.get(event.issueId) : null;
    if (
      !binding ||
      event.companyId !== binding.companyId ||
      event.workflowRunId !== binding.workflowRunId ||
      event.workflowStepRunId !== binding.workflowStepRunId
    ) {
      continue;
    }
    // [verdict authority] the backing heartbeat run must be a checked-out run scoped to this QA issue.
    const runScope = event.heartbeatRunId ? heartbeatRunScopeById.get(event.heartbeatRunId) : null;
    if (!runScope || runScope.companyId !== binding.companyId || runScope.issueId !== event.issueId) {
      continue;
    }
    setLatestValidationVerdict(verdicts, event.issueId, event.verdict, observedAt);
  }
  return verdicts;
}

/**
 * [qa-cap acceptance anti-flap, generation-aware] a completed QA is protected from
 *   request_changes+done re-derivation ONLY while its qaCapAccepted sentinel's
 *   producerStepId/producerIteration match a CURRENTLY completed producer row in this run.
 *   A new producer generation (rework) breaks the match => protection lifts, re-derivation resumes.
 */
function matchesCurrentCapAcceptedProducer(
  qaStepRun: (typeof workflowStepRuns.$inferSelect),
  stepRuns: ReadonlyArray<(typeof workflowStepRuns.$inferSelect)>,
): boolean {
  const sentinel = readAcceptanceRecord(normalizeRecord(qaStepRun.metadata).qaCapAccepted);
  if (!sentinel) return false; // forged/malformed metadata never suppresses QA re-derivation
  return stepRuns.some(
    (r) => r.stepId === sentinel.producerStepId && r.status === "completed" && (r.iterationIndex ?? 0) === sentinel.producerIteration,
  );
}

async function syncStepRunsFromIssueState(
  db: Db,
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
  steps: WorkflowStep[] = [],
  context?: WorkflowExecutionContext,
): Promise<(typeof workflowStepRuns.$inferSelect)[]> {
  const issueIds = stepRuns
    .map((stepRun) => stepRun.issueId)
    .filter((issueId): issueId is string => Boolean(issueId));
  if (issueIds.length === 0) return stepRuns;

  const issueRows = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      status: issues.status,
      startedAt: issues.startedAt,
      completedAt: issues.completedAt,
      cancelledAt: issues.cancelledAt,
      title: issues.title,
      originKind: issues.originKind,
    })
    .from(issues)
    .where(inArray(issues.id, issueIds));
  const issueById = new Map(issueRows.map((issue) => [issue.id, issue]));
  const stepById = new Map(steps.map((step) => [step.id, step]));
  const workProductDependencyGate = await loadWorkProductDependencyGate(db, stepRuns, steps);
  const validationCandidateIssueIds = collectUniqueStepRunIssueIds(stepRuns.filter((stepRun) => {
      if (!stepRun.issueId) return false;
      const issue = issueById.get(stepRun.issueId);
      if (!issue || (issue.status !== "done" && issue.status !== "blocked")) return false;
      return isValidationGateCandidate({
        issueTitle: issue.title,
        issueOriginKind: issue.originKind,
        step: stepById.get(stepRun.stepId) ?? null,
      });
    }));
  const validationCandidateIssueIdSet = new Set(validationCandidateIssueIds);
  const validationBindings = new Map<string, WorkflowValidationIssueBinding>();
  for (const stepRun of stepRuns) {
    if (!stepRun.issueId || !validationCandidateIssueIdSet.has(stepRun.issueId)) continue;
    const issue = issueById.get(stepRun.issueId);
    if (!issue) continue;
    validationBindings.set(stepRun.issueId, {
      companyId: issue.companyId,
      workflowRunId: stepRun.workflowRunId,
      workflowStepRunId: stepRun.id,
    });
  }
  const latestValidationVerdictByIssueId = await loadLatestValidationVerdicts(db, validationBindings);
  // [Patch 3] validation-recheck idempotency: 각 validation issue 의 latest succeeded heartbeat 시각.
  const latestSucceededHeartbeatByIssueId = await loadLatestSucceededHeartbeatAt(db, validationCandidateIssueIds);

  const stepRunByStepId = new Map(stepRuns.map((stepRun) => [stepRun.stepId, stepRun]));
  for (const stepRun of stepRuns) {
    if (!stepRun.issueId) continue;
    const issue = issueById.get(stepRun.issueId);
    if (!issue || (issue.status !== "blocked" && issue.status !== "done")) continue;
    const step = stepById.get(stepRun.stepId);
    if (!step || step.dependencies.length === 0) continue;
    if (!isValidationGateCandidate({ issueTitle: issue.title, issueOriginKind: issue.originKind, step })) continue;

    const latestVerdict = latestValidationVerdictByIssueId.get(issue.id);
    if (latestVerdict?.verdict !== "request_changes" || !latestVerdict.observedAt) continue;

    // [Hybrid QA] Tolerate issue-less structural tool gate dependencies (extracted).
    const depCheck = checkDependencyFreshness(step.dependencies, stepRunByStepId, issueById);
    if (!depCheck.allFound || !depCheck.allDone) continue;
    if (depCheck.maxCompletedAt === 0) continue;
    // [Transitive producer freshness] A reworked producer can sit 2+ hops above
    //   the QA step (producer → intermediate QA/gate → semantic QA). Direct-dep
    //   freshness then never advances after a producer rework and the recheck is
    //   skipped forever — the QA re-fire chain dead-ends silently and the run
    //   finalizes failed (gazua-evening 2026-08-20: producer gen2 completed 09:22,
    //   direct-dep max stayed 09:04 < RC verdict 09:11 → owner-action stall).
    //   Include gate-validated producers' completion times so a reworked producer
    //   generation re-arms the recheck regardless of DAG topology.
    let freshnessMaxCompletedAt = depCheck.maxCompletedAt;
    for (const producerStepIds of collectGateValidatedProducerStepIds(step.dependencies, stepById).values()) {
      for (const producerStepId of producerStepIds) {
        const producerRun = stepRunByStepId.get(producerStepId);
        if (!producerRun) continue;
        const producerIssue = producerRun.issueId ? issueById.get(producerRun.issueId) : undefined;
        const producerCompletedMs = producerIssue
          ? (producerIssue.completedAt?.getTime() ?? 0)
          : (producerRun.completedAt?.getTime() ?? 0);
        if (producerCompletedMs > freshnessMaxCompletedAt) freshnessMaxCompletedAt = producerCompletedMs;
      }
    }
    if (freshnessMaxCompletedAt <= latestVerdict.observedAt.getTime()) continue;
    // [Patch 3 recheck idempotency] 같은 producer generation 에 대해 validation 이 이미 재실행됐으면
    //   중복 실행 요청을 만들지 않는다. producer 최종 완료(dependencyMaxCompletedAt) 이후에 succeeded heartbeat 가
    //   한 번이라도 있으면 이미 이 generation 산출물을 recheck 한 것 — explicit verdict 유무와 무관하게 duplicate
    //   request 를 끊는다. 이후 producer 가 다시 rework 되면 dependencyMaxCompletedAt 이 더 뒤로 갱신돼 재요청이 허용된다.
    const dependencyMaxCompletedAt = freshnessMaxCompletedAt;
    const latestRecheckAt = latestSucceededHeartbeatByIssueId.get(issue.id);
    if (latestRecheckAt && latestRecheckAt.getTime() >= dependencyMaxCompletedAt) continue;

    if (!context) continue;
    // [Hybrid QA] Force fresh session on semantic QA recheck so stale verdict/session
    //   state is not reused after a new producer generation.
    const queued = await wakeExistingWorkflowStepIssue({
      db,
      run: context.run,
      definition: context.definition,
      step,
      stepRunId: stepRun.id,
      stepRunMetadata: stepRun.metadata,
      issueId: issue.id,
      allowCompletedIssue: true,
      allowBlockedIssue: true,
      forceFreshSession: true,
    });
    if (!queued) continue;

    const [updatedIssue] = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        status: issues.status,
        startedAt: issues.startedAt,
        completedAt: issues.completedAt,
        cancelledAt: issues.cancelledAt,
        title: issues.title,
        originKind: issues.originKind,
      })
      .from(issues)
      .where(eq(issues.id, issue.id))
      .limit(1);
    if (updatedIssue) issueById.set(updatedIssue.id, updatedIssue);
    await commentOnValidationRecheckQueued({
      db,
      companyId: issue.companyId,
      issueId: issue.id,
      workflowRunId: stepRun.workflowRunId,
      step,
    });
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: "workflow:validation-recheck",
      action: "workflow.validation_recheck_queued",
      entityType: "issue",
      entityId: issue.id,
      details: {
        workflowRunId: stepRun.workflowRunId,
        workflowStepRunId: stepRun.id,
        stepId: step.id,
        dependencyStepIds: step.dependencies,
        reason: "dependency_completed_after_request_changes",
        requestChangesObservedAt: latestVerdict.observedAt.toISOString(),
      },
    });
  }

  // A rework reset ignores the prior issue completion but accepts a later
  // completion from the current iteration.
  for (const stepRun of stepRuns) {
    if (!stepRun.issueId) continue;
    const issue = issueById.get(stepRun.issueId);
    if (!issue) continue;
    if (stepRun.issueId && await shouldPreservePendingRetryFromIssueState({
      db,
      companyId: issue.companyId,
      issueId: issue.id,
      stepRunStatus: stepRun.status,
      metadata: stepRun.metadata,
    })) {
      continue;
    }
    if (isPendingReworkAwaitingCurrentIssueCompletion(stepRun, issue.completedAt)) continue;
    // [qa-cap acceptance] cap 수용으로 completed 된 QA 는 request_changes+done 재유도(flap)에서 보호 —
    //   단, sentinel 의 producerStepId/producerIteration 이 현 sync 의 completed producer row 와 정확히
    //   일치(현 generation)할 때만. 새 producer generation(rework) 시 보호 해제 → 재유도 허용.
    if (stepRun.status === "completed" && matchesCurrentCapAcceptedProducer(stepRun, stepRuns)) continue;
    const isValidationCheck = validationCandidateIssueIdSet.has(issue.id);
    const latestValidationVerdict = latestValidationVerdictByIssueId.get(issue.id);
    const ungatedStatus = isValidationCheck
      ? desiredValidationCheckStepStatus({ issueStatus: issue.status, latestVerdict: latestValidationVerdict })
      : desiredStepRunStatusFromIssueStatus(issue.status);
    const desiredStatus = applyWorkProductDependencyGate({
      issueId: issue.id,
      status: ungatedStatus,
      gate: workProductDependencyGate,
    });
    const patch: Partial<typeof workflowStepRuns.$inferInsert> = {};
    const now = new Date();
    // [rework startedAt 타이밍] rework 리셋 후 stepRun.startedAt 이 null 이면 startedAt 이 완료
    //   시각(now)으로 잡혀, 같은 시도가 막 생산한 work product(updatedAt 이 몇 초 먼저)이 "이전 시도
    //   산물(stale)"로 오분류돼 하류 IF 노드의 신선도 검사(condition-source-resolver)가 실패한다.
    //   rework 계약의 createdAt(= 현 시도 시작의 신뢰 가능 하한)으로 폴백해 현 시도 산물이 stale 처리
    //   되지 않게 한다. 비-rework(최초 시도)는 reworkStartedAt 이 null 이라 기존 동작과 동일.
    const reworkContract = readWorkflowReworkContract(
      normalizeRecord(stepRun.metadata).workflowReworkContract,
    );
    const reworkStartedAt = reworkContract?.createdAt ? new Date(reworkContract.createdAt) : null;
    const attemptStartedAt = stepRun.startedAt ?? issue.startedAt ?? reworkStartedAt ?? now;

    if (desiredStatus !== stepRun.status) {
      patch.status = desiredStatus;
    }

    if (desiredStatus === "running") {
      patch.startedAt = attemptStartedAt;
      patch.completedAt = null;
    } else if (desiredStatus === "completed") {
      patch.startedAt = attemptStartedAt;
      patch.completedAt = issue.completedAt ?? now;
      // When finalization v1 is active, issue-backed steps also need
      // dispatch_ready_at set so downstream edge-condition evaluation admits
      // successors. Heartbeat-linked steps get this via settlement.ts, but
      // steps that complete via issue status sync (e.g. workflow_agent_api)
      // bypass settlement entirely.
      if (!stepRun.dispatchReadyAt) {
        patch.dispatchReadyAt = now;
      }
      const cleanedRetryMetadata = stripRetryTrackingOnSuccess(stepRun.metadata);
      if (cleanedRetryMetadata) {
        patch.metadata = cleanedRetryMetadata;
      }
    } else if (desiredStatus === "failed") {
      patch.startedAt = attemptStartedAt;
      patch.completedAt = issue.cancelledAt ?? issue.completedAt ?? now;
    } else {
      patch.startedAt = null;
      patch.completedAt = null;
    }

    if (Object.keys(patch).length === 0) continue;
    const metadataCleanupCondition = patch.metadata
      ? and(
        eq(workflowStepRuns.status, stepRun.status),
        eq(workflowStepRuns.metadata, stepRun.metadata),
      )
      : undefined;
    await db
      .update(workflowStepRuns)
      .set(patch)
      .where(and(eq(workflowStepRuns.id, stepRun.id), metadataCleanupCondition));
  }

  return reloadWorkflowStepRunsForSameRun(db, stepRuns);
}

async function resetUnlaunchedTerminalStepRuns(
  db: Db,
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
): Promise<(typeof workflowStepRuns.$inferSelect)[]> {
  // controlFlowSkipped sentinel: IF false-branch 로 skip 된 step 은 리셋에서 제외한다.
  // 그렇지 않으면 매 sync 마다 skipped→pending→(skip pass)→skipped 로 flap 하며 finalize 가
  // allStepsTerminal 에 수렴하지 못해 60min reconciler kill(가즈아 hang 회귀)을 유발한다.
  const unlaunchedTerminal = stepRuns.filter((stepRun) =>
    (stepRun.status === "skipped" || stepRun.status === "failed")
    && stepRun.issueId == null
    && stepRun.startedAt == null
    && stepRun.lastDispatchAttemptAt == null
    && normalizeRecord(stepRun.metadata).controlFlowSkipped !== true
  );
  if (unlaunchedTerminal.length === 0) return stepRuns;

  await db
    .update(workflowStepRuns)
    .set({
      status: "pending",
      startedAt: null,
      completedAt: null,
    })
    .where(inArray(workflowStepRuns.id, unlaunchedTerminal.map((stepRun) => stepRun.id)));

  return reloadWorkflowStepRunsForSameRun(db, stepRuns);
}

function uniqueIssueRowsByIssueId<T extends { issueId: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const row of rows) {
    if (seen.has(row.issueId)) continue;
    seen.add(row.issueId);
    unique.push(row);
  }
  return unique;
}

function collectGateValidatedProducerStepIds(
  directDependencyStepIds: string[],
  workflowStepsById: Map<string, WorkflowStep>,
): Map<string, string[]> {
  const producerStepIdsByGateStepId = new Map<string, string[]>();

  const collectProducerSteps = (stepId: string, visited: Set<string>): string[] => {
    if (visited.has(stepId)) return [];
    const step = workflowStepsById.get(stepId);
    if (!step) return [];
    if (step.graphWorkProductRequired === true) return [stepId];
    const nextVisited = new Set(visited);
    nextVisited.add(stepId);
    return Array.from(new Set(step.dependencies.flatMap((dependencyStepId) => (
      collectProducerSteps(dependencyStepId, nextVisited)
    ))));
  };

  for (const dependencyStepId of directDependencyStepIds) {
    const dependencyStep = workflowStepsById.get(dependencyStepId);
    if (!dependencyStep || dependencyStep.graphWorkProductRequired === true || dependencyStep.dependencies.length === 0) {
      continue;
    }
    const producerStepIds = Array.from(new Set(dependencyStep.dependencies.flatMap((upstreamStepId) => (
      collectProducerSteps(upstreamStepId, new Set([dependencyStepId]))
    ))));
    if (producerStepIds.length > 0) {
      producerStepIdsByGateStepId.set(dependencyStepId, producerStepIds);
    }
  }

  return producerStepIdsByGateStepId;
}

async function createWorkflowStepIssue(input: {
  db: Db;
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
  step: WorkflowStep;
}): Promise<string | null> {
  const issueSvc = issueService(input.db);
  const heartbeat = heartbeatService(input.db);

  const executionSteps = buildWorkflowExecutionSteps(input.definition);
  const structuralReadiness = await evaluateSemanticStructuralReadiness({
    db: input.db,
    companyId: input.run.companyId,
    workflowRunId: input.run.id,
    step: input.step,
    steps: executionSteps,
  });
  if (!structuralReadiness.ready) return null;
  const structuralGateCoverageLines = renderStructuralGateCoverageLines(structuralReadiness.coverage);

  const assigneeAgentId = await resolveWorkflowStepAssigneeAgentId(input.db, input.run.companyId, input.step);
  const workflowStepsById = new Map(
    executionSteps.map((step) => [step.id, step]),
  );
  const gateProducerStepIdsByGateStepId = collectGateValidatedProducerStepIds(
    input.step.dependencies,
    workflowStepsById,
  );
  const gateValidatedProducerStepIds = Array.from(new Set(
    Array.from(gateProducerStepIdsByGateStepId.values()).flatMap((stepIds) => stepIds),
  )).filter((stepId) => !input.step.dependencies.includes(stepId));
  const sortByStepIds = <T extends { stepId: string }>(rows: T[], stepIds: string[]): T[] => {
    const order = new Map(stepIds.map((stepId, index) => [stepId, index]));
    return rows.sort((a, b) => (order.get(a.stepId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.stepId) ?? Number.MAX_SAFE_INTEGER));
  };
  const queryIssueRowsForStepIds = async (stepIds: string[]) => {
    if (stepIds.length === 0) return [];
    const rows = await input.db
      .select({
        stepId: workflowStepRuns.stepId,
        issueId: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        description: issues.description,
      })
      .from(workflowStepRuns)
      .innerJoin(issues, eq(workflowStepRuns.issueId, issues.id))
      .where(and(
        eq(workflowStepRuns.workflowRunId, input.run.id),
        inArray(workflowStepRuns.stepId, stepIds),
      ));
    return sortByStepIds(rows, stepIds);
  };
  const dependencyIssueRows = await queryIssueRowsForStepIds(input.step.dependencies);
  const gateValidatedProducerIssueRows = await queryIssueRowsForStepIds(gateValidatedProducerStepIds);
  const artifactLookupIssueRows = uniqueIssueRowsByIssueId([
    ...dependencyIssueRows,
    ...gateValidatedProducerIssueRows,
  ]);
  const dependencyWorkProductRows = artifactLookupIssueRows.length > 0
    ? await input.db
      .select({
        id: issueWorkProducts.id,
        issueId: issueWorkProducts.issueId,
        title: issueWorkProducts.title,
        type: issueWorkProducts.type,
        provider: issueWorkProducts.provider,
        url: issueWorkProducts.url,
        externalId: issueWorkProducts.externalId,
        metadata: issueWorkProducts.metadata,
        status: issueWorkProducts.status,
      })
      .from(issueWorkProducts)
      .where(and(
        eq(issueWorkProducts.companyId, input.run.companyId),
        inArray(issueWorkProducts.issueId, artifactLookupIssueRows.map((row) => row.issueId)),
        ne(issueWorkProducts.status, "archived"),
      ))
    : [];
  const dependencyWorkProductsByIssueId = new Map<string, typeof dependencyWorkProductRows>();
  for (const product of dependencyWorkProductRows) {
    const products = dependencyWorkProductsByIssueId.get(product.issueId) ?? [];
    products.push(product);
    dependencyWorkProductsByIssueId.set(product.issueId, products);
  }
  const dependencyIssueRowsByIssueId = new Map(
    artifactLookupIssueRows.map((row) => [row.issueId, row]),
  );
  const dependencyWorkProductEvidenceRefs: IssueExecutionCardJson["evidenceRefs"] =
    dependencyWorkProductRows.flatMap((product) => {
      if (product.provider !== "local" && product.provider !== "local_file") return [];
      const localPath = resolveWorkProductLocalFilePath(product);
      if (!localPath) return [];
      const dependencyIssue = dependencyIssueRowsByIssueId.get(product.issueId);
      return [{
        type: "dependency_work_product",
        id: product.id,
        path: localPath,
        description: dependencyIssue
          ? `Registered workProduct from workflow step ${dependencyIssue.stepId}`
          : "Registered dependency workProduct",
      }];
    });
  const dependencyToolArtifactRows = input.step.dependencies.length > 0
    ? await input.db
      .select({
        id: workflowStepRuns.id,
        stepId: workflowStepRuns.stepId,
        metadata: workflowStepRuns.metadata,
      })
      .from(workflowStepRuns)
      .where(and(
        eq(workflowStepRuns.workflowRunId, input.run.id),
        inArray(workflowStepRuns.stepId, input.step.dependencies),
        isNull(workflowStepRuns.issueId),
        eq(workflowStepRuns.status, "completed"),
      ))
    : [];
  const dependencyToolArtifactEvidenceRefs: IssueExecutionCardJson["evidenceRefs"] =
    dependencyToolArtifactRows.flatMap((row) => {
      const artifactPath = readWorkflowToolArtifactPath(getMetadataRecord(row.metadata, "toolResult"));
      if (!artifactPath) return [];
      return [{
        type: "dependency_tool_artifact",
        id: row.id,
        path: artifactPath,
        description: `Workflow tool artifact from step ${row.stepId}`,
      }];
    });
  const dependencyToolArtifactLines = dependencyToolArtifactEvidenceRefs.map((artifact) =>
    `- ${artifact.description}: ${artifact.path}`,
  );
  const dependencyEvidenceRefs = [
    ...dependencyWorkProductEvidenceRefs,
    ...dependencyToolArtifactEvidenceRefs,
  ];
  // [structured artifact authority] downstream execution recognizes dependency deliverables ONLY via
  //   formally registered workProducts (DB) or machine-produced native tool-result metadata above.
  //   producer-declared `[ARTIFACT]:` markers in issue descriptions/comments/run output are NOT
  //   registration authority and must not satisfy the dependency work-product gate.
  const dependencyHasWorkProduct = (row: { issueId: string }) =>
    (dependencyWorkProductsByIssueId.get(row.issueId) ?? []).length > 0;
  const renderWorkProductSummary = (product: typeof dependencyWorkProductRows[number]) => {
    const artifactRef = product.url ?? product.externalId ?? (
      product.metadata ? JSON.stringify(product.metadata) : "no artifact ref"
    );
    return `${product.title} [${product.type}/${product.status}] ${artifactRef}`;
  };
  const renderArtifactInputLines = (row: {
    issueId: string;
    stepId: string;
    identifier: string | null;
    status: string;
    title: string;
  }) => {
    const label = row.identifier ?? row.issueId;
    const products = dependencyWorkProductsByIssueId.get(row.issueId) ?? [];
    const lines: string[] = [
      `- ${row.stepId}: ${label} (${row.status}) — ${row.title}`,
    ];
    if (products.length > 0) {
      lines.push(`  workProducts: ${products.map(renderWorkProductSummary).join("; ")}`);
    } else {
      lines.push("  workProducts: none registered");
    }
    return lines;
  };
  const dependencyIssueLines = dependencyIssueRows.flatMap((row) => {
    const label = row.identifier ?? row.issueId;
    const products = dependencyWorkProductsByIssueId.get(row.issueId) ?? [];
    const gateProducerStepIds = gateProducerStepIdsByGateStepId.get(row.stepId) ?? [];
    const lines: string[] = [
      `- ${row.stepId}: ${label} (${row.status}) — ${row.title}`,
    ];
    if (products.length > 0) {
      lines.push(`  workProducts: ${products.map(renderWorkProductSummary).join("; ")}`);
    } else if (gateProducerStepIds.length > 0) {
      lines.push(`  gate dependency passed without its own workProduct; use validated upstream workProducts below: ${gateProducerStepIds.join(", ")}`);
    } else {
      lines.push("  workProducts: none registered");
    }
    return lines;
  });
  const validatedUpstreamWorkProductLines = gateValidatedProducerIssueRows.flatMap((row) => {
    const gateStepIds = Array.from(gateProducerStepIdsByGateStepId.entries())
      .filter(([, producerStepIds]) => producerStepIds.includes(row.stepId))
      .map(([gateStepId]) => gateStepId);
    return [
      ...renderArtifactInputLines(row),
      gateStepIds.length > 0 ? `  checkedByGates: ${gateStepIds.join(", ")}` : null,
    ].filter((line) => line !== null);
  });
  const gateStepIds = new Set(gateProducerStepIdsByGateStepId.keys());
  const missingDirectDependencyWorkProductLines = dependencyIssueRows
    .filter((row) => workflowStepsById.get(row.stepId)?.graphWorkProductRequired === true)
    .filter((row) => !dependencyHasWorkProduct(row))
    .filter((row) => !gateStepIds.has(row.stepId))
    .map((row) => `- ${row.stepId}: ${row.identifier ?? row.issueId} has no registered dependency workProduct.`);
  const missingGateValidatedProducerWorkProductLines = gateValidatedProducerIssueRows
    .filter((row) => !dependencyHasWorkProduct(row))
    .map((row) => `- ${row.stepId}: ${row.identifier ?? row.issueId} has no registered dependency workProduct.`);
  const missingDependencyWorkProductLines = [
    ...missingDirectDependencyWorkProductLines,
    ...missingGateValidatedProducerWorkProductLines,
  ];

  const stepName = renderWorkflowRunTextTemplate(input.step.name.trim(), input.run);
  const title = stepName || renderWorkflowRunTextTemplate(input.definition.name, input.run);
  const missionProject = input.run.missionId
    ? await input.db
      .select({ projectId: missions.projectId })
      .from(missions)
      .where(eq(missions.id, input.run.missionId))
      .limit(1)
      .then((rows) => rows[0] ?? null)
    : null;
  const projectId = missionProject?.projectId ?? input.definition.projectId ?? null;
  const workProductPaths = await resolveMissionWorkProductPaths(input.db, {
    companyId: input.run.companyId,
    missionId: input.run.missionId ?? null,
    projectId,
    workflowRunId: input.run.id,
    stepId: input.step.id,
  });
  const requiresWorkProduct = input.step.graphWorkProductRequired === true;
  const renderedStepDescription = input.step.description?.trim()
    ? renderWorkflowRunTextTemplate(input.step.description.trim(), input.run)
    : null;
  const requiresVerdict = !requiresWorkProduct && isQaLikeStep(input.step);
  const qaRubricPath = requiresVerdict && workProductPaths?.stepOutputDir
    ? path.join(workProductPaths.stepOutputDir, "qa-rubric.md")
    : null;
  if (qaRubricPath) {
    // [AREA: Mission Quality Contract] mission goal/title/description 조회(active plan missionGoal 우선 → title+desc fallback).
    let missionGoalForRubric: string | null = null;
    let missionTitleForRubric: string | null = null;
    let missionDescriptionForRubric: string | null = null;
    if (input.run.missionId) {
      const [missionRow] = await input.db
        .select({ title: missions.title, description: missions.description })
        .from(missions)
        .where(and(eq(missions.companyId, input.run.companyId), eq(missions.id, input.run.missionId)))
        .limit(1);
      missionTitleForRubric = missionRow?.title ?? null;
      missionDescriptionForRubric = (missionRow?.description as string | null) ?? null;
      const [activePlanRow] = await input.db
        .select({ missionGoal: missionPlanArtifacts.missionGoal })
        .from(missionPlanArtifacts)
        .where(and(
          eq(missionPlanArtifacts.companyId, input.run.companyId),
          eq(missionPlanArtifacts.missionId, input.run.missionId),
          eq(missionPlanArtifacts.status, "active"),
        ))
        .orderBy(desc(missionPlanArtifacts.revision))
        .limit(1);
      missionGoalForRubric = (activePlanRow?.missionGoal as string | null) ?? null;
    }
    await writeQaRubricMarkdown({
      filePath: qaRubricPath,
      run: input.run,
      definition: input.definition,
      step: input.step,
      renderedStepDescription,
      dependencyIssueLines,
      missingDependencyWorkProductLines,
      missionGoal: missionGoalForRubric,
      missionTitle: missionTitleForRubric,
      missionDescription: missionDescriptionForRubric,
      structuralGateCoverageLines,
    });
  }
  const description = [
    ...(requiresWorkProduct && workProductPaths?.stepOutputDir
      ? buildArtifactOutputDirectoryLines({ outputDir: workProductPaths.stepOutputDir })
      : []),
    requiresWorkProduct && workProductPaths ? "" : null,
    qaRubricPath ? "QA grading rubric:" : null,
    qaRubricPath ? `- ${qaRubricPath}` : null,
    qaRubricPath ? "- Read the rubric file before judging the dependency workProducts. Do not invent extra criteria in the issue body." : null,
    qaRubricPath ? "- Finish with exactly `PASS` or `REQUEST_CHANGES: <specific gaps>`." : null,
    qaRubricPath ? null : renderedStepDescription,
    ...structuralGateCoverageLines,
    "",
    "Workflow execution boundary:",
    `- workflowRunId: ${input.run.id}`,
    `- workflowDefinitionId: ${input.definition.id}`,
    `- missionId: ${input.run.missionId ?? "none"}`,
    `- stepId: ${input.step.id}`,
    `- dependencyStepIds: ${JSON.stringify(input.step.dependencies)}`,
    dependencyIssueLines.length > 0 ? "Dependency issue inputs:" : null,
    ...dependencyIssueLines,
    dependencyToolArtifactLines.length > 0 ? "Dependency tool artifacts:" : null,
    ...dependencyToolArtifactLines,
    validatedUpstreamWorkProductLines.length > 0 ? "Validated upstream workProducts:" : null,
    ...validatedUpstreamWorkProductLines,
    missingDependencyWorkProductLines.length > 0 ? "Dependency workProduct hard-stop:" : null,
    ...missingDependencyWorkProductLines,
    missingDependencyWorkProductLines.length > 0
      ? "- Registered dependency workProducts above are the only official upstream artifacts. Do not infer dependency deliverables from guessed filesystem paths, sibling run folders, old dates, or unrelated comments."
      : null,
    missingDependencyWorkProductLines.length > 0
      ? "- If this step needs that dependency deliverable for validation, synthesis, build, publish, or approval, stop and leave a blocker/REQUEST_CHANGES naming the missing dependency workProduct instead of producing a guessed result."
      : null,
    "- Treat issue ids from other missions or workflow runs as out of scope, even when their titles are similar.",
    "",
    ...buildWorkflowApiCloseoutLines({ requiresWorkProduct, requiresVerdict }),
    "",
    ...(requiresWorkProduct ? buildWorkProductRegistrationContractLines() : []),
    !requiresWorkProduct ? "- For QA/validator steps, validate dependency issue workProducts above; do not require a QA issue to have its own workProduct unless QA creates a separate deliverable." : null,
  ].filter((line) => line !== null).join("\n");

  // [idempotency] 같은 run + 같은 STEP 의 기존 workflow_execution issue 가 살아있으면
  // (cancelled 제외) 재사용. step 실패→재시도/Unblock 시 createWorkflowStepIssue 가 매번 새
  // issue 를 찍어 signal/sector/narrative 가 처음부터 반복되는 것(가즈아 gazua-morning
  // CMPA-5415→5419→5424→5427→5430 반복) 을 막는다. done/blocked issue 도 재사용 — 이후
  // dispatch 의 wake/skip 이 상태를 판단한다(이미 done 이면 재실행 안 함).
  // [B: same-title step collision] title 만으로 재사용하면 같은 run 안에서 서로 다른 stepId 가
  // 같은 title(예: 두 개의 "[QA] Verify mission result") 을 쓰는 경우 둘 다 같은 issue 를
  // 가리키게 되어 verdict/validation 바인딩이 깨진다. 반드시 workflowStepRuns.stepId 로
  // exact step 매칭을 해야 한다. stepRun.issueId 는 첫 생성 시점엔 null 이므로(생성 후
  // update 로 연결), 같은 run + 같은 stepId 의 다른 stepRun 이 이미 issue 를 갖고 있으면
  // 그 issue 를 재사용한다. 같은-title legacy issue(step 매칭 불가) 는 재사용하지 않는다.
  const reusable = await input.db
    .select({
      id: issues.id,
      status: issues.status,
      description: issues.description,
      assigneeAgentId: issues.assigneeAgentId,
      projectId: issues.projectId,
      missionId: issues.missionId,
    })
    .from(workflowStepRuns)
    .innerJoin(issues, eq(issues.id, workflowStepRuns.issueId))
    .where(and(
      eq(workflowStepRuns.workflowRunId, input.run.id),
      eq(workflowStepRuns.stepId, input.step.id),
      eq(issues.originRunId, input.run.id),
      eq(issues.originKind, "workflow_execution"),
      ne(issues.status, "cancelled"),
    ))
    .orderBy(desc(workflowStepRuns.iterationIndex), desc(workflowStepRuns.startedAt))
    .limit(1);
  if (reusable.length > 0) {
    const reusableIssue = reusable[0];
    if (reusableIssue) {
      await upsertWorkflowIssueExecutionCard({
        db: input.db,
        companyId: input.run.companyId,
        issueId: reusableIssue.id,
        title,
        description: reusableIssue.description ?? description,
        assigneeAgentId: reusableIssue.assigneeAgentId,
        projectId: reusableIssue.projectId,
        missionId: reusableIssue.missionId,
        workflowDefinitionId: input.definition.id,
        workflowRunId: input.run.id,
        step: input.step,
        stepOutputDir: workProductPaths?.stepOutputDir ?? null,
        qaRubricPath,
        evidenceRefs: dependencyEvidenceRefs,
      });
      return reusableIssue.id;
    }
  }

  const autoApproveTools = input.step.autoApproveTools === true;
  const createdIssue = await issueSvc.create(input.run.companyId, {
    title,
    description,
    status: "todo",
    assigneeAgentId,
    projectId,
    missionId: input.run.missionId ?? null,
    originKind: "workflow_execution",
    originId: input.run.id,
    originRunId: input.run.id,
    ...(autoApproveTools
      ? { assigneeAdapterOverrides: { adapterConfig: { autoApproveTools: true } } }
      : {}),
  });

  const executionCardRow = await upsertWorkflowIssueExecutionCard({
    db: input.db,
    companyId: input.run.companyId,
    issueId: createdIssue.id,
    title,
    description,
    assigneeAgentId,
    projectId,
    missionId: input.run.missionId ?? null,
    workflowDefinitionId: input.definition.id,
    workflowRunId: input.run.id,
    step: input.step,
    stepOutputDir: workProductPaths?.stepOutputDir ?? null,
    qaRubricPath,
    evidenceRefs: dependencyEvidenceRefs,
  });

  // [qa-cap acceptance] inject predecessor cap-accepted nonblocking limitations so a freshly
  //   created downstream issue carries them in both execution payload and contextSnapshot.
  const capAcceptanceContext = await loadDownstreamQaCapAcceptanceContext({
    db: input.db,
    workflowRunId: input.run.id,
    predecessorStepIds: resolveEdges(input.step).filter((e) => e.isBackEdge !== true).map((e) => e.stepId),
  });
  const capAcceptancePayload = capAcceptanceContext.accepted.length > 0
    ? { acceptedQaLimitations: capAcceptanceContext }
    : {};

  await applyIssueCreatedSideEffects({
    db: input.db,
    heartbeat,
    issue: createdIssue,
    actor: {
      actorType: "system",
      actorId: `workflow:${input.definition.id}`,
    },
    contextSource: "workflow.dispatch",
    payload: {
      ...(input.run.missionId ? { missionId: input.run.missionId } : {}),
      workflowRunId: input.run.id,
      workflowDefinitionId: input.definition.id,
      workflowStepId: input.step.id,
      issueExecutionCardId: executionCardRow.id,
      issueExecutionCardHash: executionCardRow.contentHash,
      ...capAcceptancePayload,
    },
    contextSnapshot: {
      taskId: createdIssue.id,
      ...(input.run.missionId ? { missionId: input.run.missionId } : {}),
      workflowRunId: input.run.id,
      workflowDefinitionId: input.definition.id,
      workflowStepId: input.step.id,
      stepId: input.step.id,
      paperclipIssueExecutionCard: executionCardRow.cardJson,
      paperclipIssueExecutionCardId: executionCardRow.id,
      paperclipIssueExecutionCardHash: executionCardRow.contentHash,
      ...capAcceptancePayload,
    },
    waitForWakeCompletion: true,
  });

  return createdIssue.id;
}

// [Patch 3 recheck idempotency] validation issue 별 latest succeeded heartbeat finishedAt.
//   syncStepRunsFromIssueState 가 같은 producer generation 에 대해 중복 실행 요청을 만들지 않도록 한다:
//   "이미 recheck heartbeat 가 producer 최종 완료 이후에 성공했다면 재요청 금지" 판정 재료.
//   A1 RES-424 사례: 재실행 run 은 succeeded 였으나 explicit PASS verdict 가 없어 latestValidationVerdict
//   가 구 REQUEST_CHANGES 에 머물 → 이후 sync 마다 QA 실행 요청이 반복되던 stale duplicate.
async function loadLatestSucceededHeartbeatAt(db: Db, issueIds: string[]): Promise<Map<string, Date>> {
  const latest = new Map<string, Date>();
  if (issueIds.length === 0) return latest;
  const rows = await db
    .select({ issueId: heartbeatRuns.issueId, finishedAt: heartbeatRuns.finishedAt, createdAt: heartbeatRuns.createdAt })
    .from(heartbeatRuns)
    .where(and(inArray(heartbeatRuns.issueId, issueIds), eq(heartbeatRuns.status, "succeeded")))
    .orderBy(desc(heartbeatRuns.finishedAt), desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id));
  for (const row of rows) {
    if (!row.issueId) continue;
    if (latest.has(row.issueId)) continue; // desc 정렬 → 첫 행이 최신
    const at = row.finishedAt ?? row.createdAt;
    if (at) latest.set(row.issueId, at);
  }
  return latest;
}

export async function wakeExistingWorkflowStepIssue(input: {
  db: Db;
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
  step: WorkflowStep;
  stepRunId?: string;
  stepRunMetadata?: unknown;
  issueId: string;
  allowCompletedIssue?: boolean;
  allowBlockedIssue?: boolean;
  /** When true, the heartbeat session is forced fresh (no stale context reuse). */
  forceFreshSession?: boolean;
  /** Optional correlation key; cap-override keys also enable exact queue-conflict propagation. */
  idempotencyKey?: string | null;
}): Promise<boolean> {
  // This guards every resume entry point (normal recheck, reconciler, owner
  // recovery). A semantic QA issue may not be queued from status alone.
  const structuralReadiness = await evaluateSemanticStructuralReadiness({
    db: input.db,
    companyId: input.run.companyId,
    workflowRunId: input.run.id,
    step: input.step,
    steps: buildWorkflowExecutionSteps(input.definition),
  });
  if (!structuralReadiness.ready) return false;

  const [issue] = await input.db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      assigneeAgentId: issues.assigneeAgentId,
      status: issues.status,
    })
    .from(issues)
    .where(eq(issues.id, input.issueId))
    .limit(1);
  if (!issue) return false;
  const isRunnableIssue =
    issue.status === "todo" ||
    (input.allowCompletedIssue === true && issue.status === "done") ||
    (input.allowBlockedIssue === true && issue.status === "blocked");
  if (!isRunnableIssue) return false;

  let wakeIssue = issue;
  if (!wakeIssue.assigneeAgentId) {
    const assigneeAgentId = await resolveWorkflowStepAssigneeAgentId(input.db, input.run.companyId, input.step);
    if (!assigneeAgentId) return false;

    const [updatedIssue] = await input.db
      .update(issues)
      .set({
        assigneeAgentId,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, wakeIssue.id))
      .returning({
        id: issues.id,
        companyId: issues.companyId,
        assigneeAgentId: issues.assigneeAgentId,
        status: issues.status,
      });
    if (!updatedIssue) return false;

    await logActivity(input.db, {
      companyId: updatedIssue.companyId,
      actorType: "system",
      actorId: `workflow:${input.definition.id}`,
      action: "issue.assignee_restored",
      entityType: "issue",
      entityId: updatedIssue.id,
      details: {
        assigneeAgentId,
        reason: "workflow_step_runnable",
        workflowRunId: input.run.id,
        workflowDefinitionId: input.definition.id,
        stepId: input.step.id,
      },
    });

    wakeIssue = updatedIssue;
  }

  const stepRunMetadata = normalizeRecord(input.stepRunMetadata);
  const reworkContract = readWorkflowReworkContract(stepRunMetadata.workflowReworkContract);
  const reworkContext = reworkContract
    ? { paperclipWorkflowReworkContract: reworkContract }
    : {};
  // [qa-cap acceptance] resumed downstream issue sees predecessor cap-accepted limitations.
  const capAcceptanceContext = await loadDownstreamQaCapAcceptanceContext({
    db: input.db,
    workflowRunId: input.run.id,
    predecessorStepIds: resolveEdges(input.step).filter((e) => e.isBackEdge !== true).map((e) => e.stepId),
  });
  const capAcceptancePayload = capAcceptanceContext.accepted.length > 0
    ? { acceptedQaLimitations: capAcceptanceContext }
    : {};
  const executionStepRuns = await input.db
    .select({
      stepId: workflowStepRuns.stepId,
      status: workflowStepRuns.status,
      iterationIndex: workflowStepRuns.iterationIndex,
    })
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, input.run.id));
  const qaCapAcceptanceContract = buildQaCapAcceptanceRuntimeContract({
    qaStep: input.step,
    qaIssueId: issue.id,
    steps: buildWorkflowExecutionSteps(input.definition),
    stepRuns: executionStepRuns,
  });
  const qaCapAcceptancePayload = qaCapAcceptanceContract
    ? { paperclipQaCapAcceptanceContract: qaCapAcceptanceContract }
    : {};

  await queueIssueAssignmentWakeup({
    heartbeat: heartbeatService(input.db),
    issue: wakeIssue,
    reason: "workflow_step_runnable",
    mutation: "workflow_resume",
    contextSource: "workflow.resume",
    payload: {
      ...(input.run.missionId ? { missionId: input.run.missionId } : {}),
      workflowRunId: input.run.id,
      workflowDefinitionId: input.definition.id,
      stepId: input.step.id,
      ...(input.stepRunId ? { workflowStepRunId: input.stepRunId } : {}),
      ...(input.forceFreshSession ? { forceFreshSession: true } : {}),
      ...(structuralReadiness.coverage.length > 0 ? { structuralGateCoverage: structuralReadiness.coverage } : {}),
      ...reworkContext,
      ...capAcceptancePayload,
      ...qaCapAcceptancePayload,
    },
    contextSnapshot: {
      issueId: issue.id,
      taskId: issue.id,
      ...(input.run.missionId ? { missionId: input.run.missionId } : {}),
      workflowRunId: input.run.id,
      workflowDefinitionId: input.definition.id,
      ...(input.stepRunId ? { workflowStepRunId: input.stepRunId } : {}),
      workflowStepId: input.step.id,
      stepId: input.step.id,
      source: "workflow.resume",
      wakeReason: "workflow_step_runnable",
      ...(input.forceFreshSession ? { forceFreshSession: true } : {}),
      ...(structuralReadiness.coverage.length > 0 ? { structuralGateCoverage: structuralReadiness.coverage } : {}),
      ...reworkContext,
      ...capAcceptancePayload,
      ...qaCapAcceptancePayload,
    },
    requestedByActorType: "system",
    requestedByActorId: `workflow:${input.definition.id}`,
    idempotencyKey: input.idempotencyKey ?? null,
    rethrowOnError: isCapOverrideWakeKey(input.idempotencyKey),
  });
  return true;
}

async function resolveWorkflowStepAssigneeAgentId(
  db: Db,
  companyId: string,
  step: WorkflowStep,
): Promise<string | undefined> {
  if (typeof step.agentId === "string" && step.agentId.trim()) {
    return step.agentId.trim();
  }

  const rawAgentName = (step as PersistedWorkflowStep).agentName;
  const agentName = typeof rawAgentName === "string"
    ? rawAgentName.trim()
    : "";
  if (!agentName) return undefined;

  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(
      eq(agents.companyId, companyId),
      eq(agents.name, agentName),
      ne(agents.status, "terminated"),
      ne(agents.status, "pending_approval"),
    ))
    .orderBy(asc(agents.createdAt))
    .limit(1);
  return agent?.id;
}

function buildStepRunMap(
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
): Map<string, typeof workflowStepRuns.$inferSelect> {
  return new Map(stepRuns.map((stepRun) => [stepRun.stepId, stepRun]));
}

/**
 * [목적] completed 된 IF step 의 persisted controlNodeResult 에서 outcome 만 안전하게 유도.
 *   agent/tool step 이나 누락/잘못된 metadata 에선 빈 객체를 반환해 condition_true/false edge 가
 *   양쪽 모두 비활성(fail-closed) 되게 한다. metadata 는 검증된 스키마로만 통과.
 */
function deriveIfControlOutcome(
  step: WorkflowStep,
  run: typeof workflowStepRuns.$inferSelect | undefined,
): { controlOutcome?: "condition_true" | "condition_false" } {
  if (!run || run.status !== "completed") return {};
  if (typeof step.type !== "string" || step.type !== "if") return {};
  const raw = run.metadata?.controlNodeResult;
  if (!raw || typeof raw !== "object") return {};
  const parsed = workflowControlNodeResultSchema.safeParse(raw);
  if (!parsed.success || parsed.data.nodeType !== "if") return {};
  return { controlOutcome: parsed.data.outcome };
}

async function failMalformedCompletedControlNodes(
  db: Db,
  context: WorkflowExecutionContext,
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
): Promise<(typeof workflowStepRuns.$inferSelect)[]> {
  const runId = context.run.id;
  const steps = context.steps;
  const stepById = new Map(steps.map((step) => [step.id, step]));
  const malformed = stepRuns.filter((stepRun) => {
    if (stepRun.status !== "completed") return false;
    const step = stepById.get(stepRun.stepId);
    if (!step || !isWorkflowControlNode(step)) return false;
    const parsed = workflowControlNodeResultSchema.safeParse(
      normalizeRecord(stepRun.metadata).controlNodeResult,
    );
    return !parsed.success || parsed.data.nodeType !== step.type;
  });
  if (malformed.length === 0) return stepRuns;

  const failedAt = new Date();
  for (const stepRun of malformed) {
    const metadata = normalizeRecord(stepRun.metadata);
    delete metadata.controlNodeResult;
    metadata.controlNodeError = {
      message: "Workflow control node completed without a valid result",
      failedAt: failedAt.toISOString(),
    };
    await db
      .update(workflowStepRuns)
      .set({
        status: "failed",
        completedAt: failedAt,
        lastDispatchErrorAt: failedAt,
        lastDispatchErrorSummary: "Workflow control node completed without a valid result",
        metadata,
      })
      .where(and(
        eq(workflowStepRuns.id, stepRun.id),
        eq(workflowStepRuns.workflowRunId, runId),
        eq(workflowStepRuns.status, "completed"),
      ));
  }
  // A malformed completed IF means branch selection cannot be trusted. Stop any
  // issue work already launched from that corrupt state, then let the normal skip
  // pass terminalize untouched branches and the normal finalizer fail the run.
  await cancelOutstandingWorkflowIssues(db, runId);
  const reloaded = await db.select().from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, runId));
  return syncStepRunsFromIssueState(db, reloaded, steps, context);
}

/**
 * [목적] edge-condition 평가용 선행(pred) facts 맵 구성 — dag-engine adapter.
 *   stepRunMap(실행 상태) + step 정의 → {status, isQaGate, verdict}. 순수 edge-condition 모듈이
 *   DB/stepRun 타입을 모르게 한다(역참조/결합 회피).
 * [주의] verdict 는 P2 에선 null(P4 가 validation verdict 를 step_run.metadata 에 persist 한 뒤 공급).
 *   isQaGate 는 isValidationGateCandidate({step}) 로 step-only 추정 — qa_request_changes 평가용이며,
 *   P2 핵심 IF(success/failure/always) 평가엔 관여하지 않는다.
 * [수정시 영향] findRunnableSteps + skip-propagation pass 가 동일한 맵을 소비한다.
 */
function buildPredFactsMap(
  steps: WorkflowStep[],
  stepRunMap: Map<string, typeof workflowStepRuns.$inferSelect>,
  validationVerdictsByIssueId?: Map<string, ValidationVerdictObservation>,
  v1EnforcementEnabled?: boolean,
): Map<string, PredFacts> {
  const facts = new Map<string, PredFacts>();
  for (const step of steps) {
    const run = stepRunMap.get(step.id);
    // P4: live validation verdict 로 qa_request_changes edge 를 정밀 평가(generic failure/infra 에러 loop 방지).
    //   맵 미제공 시 null → edge-condition 의 P2 fallback(QA gate && status:failed) 으로 떨어진다.
    const liveVerdict = run?.issueId
      ? validationVerdictsByIssueId?.get(run.issueId)?.verdict ?? null
      : null;
    facts.set(step.id, {
      status: (run?.status ?? "pending") as PredStatus,
      isQaGate: isValidationGateCandidate({ step }),
      verdict: liveVerdict,
      // validationVerdictsByIssueId 맵이 제공됐으면(P4) verdictChecked=true. 맵에 이 이슈가 없으면
      // liveVerdict=null 이고 edge-condition 은 이를 "조사했으나 판정 없음(infra 실패)"으로 해석한다.
      verdictChecked: validationVerdictsByIssueId !== undefined,
      // IF control node outcome: 오직 completed 된 IF step 의 검증된 controlNodeResult 에서만 유도.
      // agent/tool/잘못된 metadata/누락 시 undefined → condition_true/false edge 양쪽 모두 비활성(fail-closed).
      ...deriveIfControlOutcome(step, run),
      // Phase 3 enforcement: when v1EnforcementEnabled, set dispatchReady from
      // the step-run's dispatch_ready_at (evidence + settlement). When disabled,
      // omit (undefined → treated as true → legacy behavior).
      ...(v1EnforcementEnabled ? { dispatchReady: run?.dispatchReadyAt != null } : {}),
    });
  }
  return facts;
}

function findRunnableSteps(
  steps: WorkflowStep[],
  stepRunMap: Map<string, typeof workflowStepRuns.$inferSelect>,
  options: {
    launchedStepIds?: Set<string>;
    validationVerdictsByIssueId?: Map<string, ValidationVerdictObservation>;
    v1EnforcementEnabled?: boolean;
  } = {},
): WorkflowStep[] {
  // [IF/loop] edge-aware 활성화 게이트. classifyStepActivation 은 legacy dependencies[] 에 대해
  // 기존 `dependencies.every(completed)` 와 byte-identical 이므로 legacy 회귀가 없고, conditional edge 가
  // 있는 step 만 when 평가(failure/always 발화 또는 waiting)로 분기된다.
  const predsByStepId = buildPredFactsMap(steps, stepRunMap, options.validationVerdictsByIssueId, options.v1EnforcementEnabled);
  return steps.filter((step) => {
    if (options.launchedStepIds && !options.launchedStepIds.has(step.id)) return false;
    if (step.triggerOn === "escalation") return false;
    const stepRun = stepRunMap.get(step.id);
    if (!stepRun || stepRun.status !== "pending") return false;
    if (isRetryDelayBlockingDispatch(stepRun.metadata, new Date())) return false;
    return classifyStepActivation(step, predsByStepId).runnable;
  });
}

function hasRecoverableQaRequestChangesDependency(
  step: WorkflowStep,
  steps: WorkflowStep[],
  stepRunMap: Map<string, typeof workflowStepRuns.$inferSelect>,
  validationVerdictsByIssueId: Map<string, ValidationVerdictObservation>,
): boolean {
  const predsByStepId = buildPredFactsMap(steps, stepRunMap, validationVerdictsByIssueId);
  const incomingEdges = resolveEdges(step).filter((edge) => edge.isBackEdge !== true);
  for (const edge of incomingEdges) {
    const pred = predsByStepId.get(edge.stepId);
    if (
      pred?.status !== "failed"
      || pred.isQaGate !== true
      || pred.verdict !== "request_changes"
      || (edge.when ?? "success") !== "success"
    ) {
      continue;
    }

    const hasRemainingBackEdgeRework = steps.some((candidate) => {
      const candidateRun = stepRunMap.get(candidate.id);
      if (!candidateRun) return false;
      return resolveEdges(candidate).some((candidateEdge) => {
        if (
          candidateEdge.isBackEdge !== true
          || candidateEdge.stepId !== edge.stepId
          || candidateEdge.when !== "qa_request_changes"
          || typeof candidateEdge.maxIterations !== "number"
        ) {
          return false;
        }
        return (candidateRun.iterationIndex ?? 0) < candidateEdge.maxIterations;
      });
    });
    if (hasRemainingBackEdgeRework) return true;
  }
  return false;
}

function isIssueLessToolStep(step: WorkflowStep): boolean {
  const hasToolNames = Array.isArray(step.toolNames)
    && step.toolNames.some((toolName) => typeof toolName === "string" && toolName.trim().length > 0);
  const agentId = typeof step.agentId === "string" ? step.agentId.trim() : "";
  const persistedStep = step as PersistedWorkflowStep;
  const stepType = typeof persistedStep.type === "string" ? persistedStep.type.trim().toLowerCase() : "";
  const agentName = typeof persistedStep.agentName === "string" ? persistedStep.agentName.trim() : "";
  if (stepType === "agent" || agentName.length > 0) return false;
  return hasToolNames && agentId.length === 0;
}

function getSingleToolStepName(step: WorkflowStep): string {
  const toolNames = Array.isArray(step.toolNames)
    ? step.toolNames.map((toolName) => toolName.trim()).filter(Boolean)
    : [];
  if (toolNames.length !== 1) {
    throw new Error(`Workflow tool step "${step.id}" requires exactly one toolName; received ${toolNames.length}.`);
  }
  const toolName = toolNames[0];
  if (!toolName) {
    throw new Error(`Workflow tool step "${step.id}" requires exactly one toolName; received 0.`);
  }
  return toolName;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function renderWorkflowRunTextTemplate(
  value: string,
  run: typeof workflowRuns.$inferSelect,
): string {
  const runDate = run.runDate ?? "";
  return value.replaceAll("{$runDate}", runDate).replaceAll("{$date}", runDate);
}

function getMetadataRecord(value: unknown, key: string): Record<string, unknown> {
  const metadata = normalizeRecord(value);
  return normalizeRecord(metadata[key]);
}

function readMetadataString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readWorkflowToolArtifactPath(value: unknown): string | null {
  const result = normalizeRecord(value);
  const data = normalizeRecord(result.data);
  const candidate = readMetadataString(result.artifactPath)
    ?? readMetadataString(data.rawPath)
    ?? readMetadataString(data.artifactPath);
  return candidate && path.isAbsolute(candidate) ? path.resolve(candidate) : null;
}

function isCacheEnabled(step: WorkflowStep): boolean {
  return step.executionControls?.cacheEnabled === true;
}

function workflowPriorityRank(priority: string | undefined): number {
  switch (priority) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "normal":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

function sortWorkflowStepsByPriority(steps: WorkflowStep[]): WorkflowStep[] {
  return [...steps].sort((left, right) =>
    workflowPriorityRank(right.executionControls?.priority) - workflowPriorityRank(left.executionControls?.priority)
  );
}

function getCacheTtlSeconds(step: WorkflowStep): number | undefined {
  return typeof step.executionControls?.cacheTtlSeconds === "number" && step.executionControls.cacheTtlSeconds > 0
    ? step.executionControls.cacheTtlSeconds
    : undefined;
}

async function findCachedToolStepRun(input: {
  db: Db;
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
  step: WorkflowStep;
  toolName: string;
  args: unknown;
  now: Date;
}): Promise<typeof workflowStepRuns.$inferSelect | null> {
  if (!isCacheEnabled(input.step)) return null;

  const ttlSeconds = getCacheTtlSeconds(input.step);
  const cutoff = ttlSeconds ? new Date(input.now.getTime() - ttlSeconds * 1000) : null;
  const conditions = [
    eq(workflowRuns.companyId, input.run.companyId),
    eq(workflowRuns.workflowId, input.definition.id),
    ne(workflowRuns.id, input.run.id),
    eq(workflowStepRuns.stepId, input.step.id),
    eq(workflowStepRuns.status, "completed"),
    ...(cutoff ? [gte(workflowStepRuns.completedAt, cutoff)] : []),
  ];
  const rows = await input.db
    .select({ stepRun: workflowStepRuns })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .where(and(...conditions))
    .orderBy(desc(workflowStepRuns.completedAt))
    .limit(25);
  const argsKey = stableJson(input.args);

  for (const row of rows) {
    const invocation = getMetadataRecord(row.stepRun.metadata, "toolInvocation");
    const result = getMetadataRecord(row.stepRun.metadata, "toolResult");
    if (result.success !== true) continue;
    if (invocation.toolName !== input.toolName) continue;
    if (stableJson(invocation.args ?? {}) !== argsKey) continue;
    return row.stepRun;
  }

  return null;
}

async function getRunningConcurrencyCount(input: {
  db: Db;
  run: typeof workflowRuns.$inferSelect;
  stepRun: typeof workflowStepRuns.$inferSelect;
  concurrencyKey: string;
}): Promise<number> {
  const rows = await input.db
    .select({ stepRun: workflowStepRuns })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .where(and(
      eq(workflowRuns.companyId, input.run.companyId),
      eq(workflowStepRuns.status, "running"),
      ne(workflowStepRuns.id, input.stepRun.id),
    ));
  return rows.filter((row) => {
    const controls = getMetadataRecord(row.stepRun.metadata, "executionControls");
    return controls.concurrencyKey === input.concurrencyKey;
  }).length;
}

async function blockToolStepRunForConcurrency(input: {
  db: Db;
  step: WorkflowStep;
  stepRun: typeof workflowStepRuns.$inferSelect;
  concurrencyKey: string;
  concurrencyLimit: number;
  runningCount: number;
  now: Date;
}): Promise<void> {
  await input.db
    .update(workflowStepRuns)
    .set({
      status: "pending",
      metadata: {
        ...buildWorkflowStepRunMetadata(input.step, input.stepRun.metadata),
        concurrencyBlocked: {
          concurrencyKey: input.concurrencyKey,
          concurrencyLimit: input.concurrencyLimit,
          runningCount: input.runningCount,
          checkedAt: input.now.toISOString(),
        },
      },
    })
    .where(eq(workflowStepRuns.id, input.stepRun.id));
}

async function completeToolStepRunFromCache(input: {
  db: Db;
  stepRun: typeof workflowStepRuns.$inferSelect;
  sourceStepRun: typeof workflowStepRuns.$inferSelect;
  step: WorkflowStep;
  toolName: string;
  args: unknown;
  now: Date;
}): Promise<void> {
  const sourceMetadata = normalizeRecord(input.sourceStepRun.metadata);
  const sourceToolResult = normalizeRecord(sourceMetadata.toolResult);
  const metadata: Record<string, unknown> = {
    ...buildWorkflowStepRunMetadata(input.step, input.stepRun.metadata),
    toolInvocation: {
      toolName: input.toolName,
      args: input.args,
      cacheCheckedAt: input.now.toISOString(),
    },
    toolResult: sourceToolResult,
    cacheHit: {
      sourceStepRunId: input.sourceStepRun.id,
      toolName: input.toolName,
      completedAt: input.now.toISOString(),
    },
  };
  delete metadata.concurrencyBlocked;

  await input.db
    .update(workflowStepRuns)
    .set({
      status: "completed",
      startedAt: input.stepRun.startedAt ?? input.now,
      completedAt: input.now,
      metadata,
    })
    .where(eq(workflowStepRuns.id, input.stepRun.id));
}

async function failToolStepRun(
  db: Db,
  stepRun: typeof workflowStepRuns.$inferSelect,
  now: Date,
): Promise<void> {
  await db
    .update(workflowStepRuns)
    .set({
      status: "failed",
      startedAt: stepRun.startedAt ?? now,
      completedAt: now,
    })
    .where(eq(workflowStepRuns.id, stepRun.id));
}

async function failToolStepRunWithDispatchError(input: {
  db: Db;
  step: WorkflowStep;
  stepRun: typeof workflowStepRuns.$inferSelect;
  now: Date;
  requestId: string;
  toolName: string;
  args: unknown;
  error: string;
  provenance?: {
    run: Pick<typeof workflowRuns.$inferSelect, "id" | "companyId" | "missionId">;
    source: WorkflowSyncSource;
  };
}): Promise<void> {
  const metadata: Record<string, unknown> = {
    ...buildWorkflowStepRunMetadata(input.step, input.stepRun.metadata),
    toolInvocation: {
      requestId: input.requestId,
      toolName: input.toolName,
      args: input.args,
      dispatchedAt: input.now.toISOString(),
      dispatchError: input.error,
    },
  };
  delete metadata.concurrencyBlocked;

  const [updated] = await input.db
    .update(workflowStepRuns)
    .set({
      status: "failed",
      startedAt: input.stepRun.startedAt ?? input.now,
      completedAt: input.now,
      lastDispatchAttemptAt: input.now,
      lastDispatchErrorAt: input.now,
      lastDispatchErrorSummary: input.error,
      lastDispatchRequestId: input.requestId,
      metadata,
    })
    .where(eq(workflowStepRuns.id, input.stepRun.id))
    .returning({
      id: workflowStepRuns.id,
      transitionVersion: workflowStepRuns.statusTransitionVersion,
    });
  if (updated && input.provenance) {
    await recordWorkflowStepStatusTransition(input.db, {
      companyId: input.provenance.run.companyId,
      missionId: input.provenance.run.missionId,
      workflowRunId: input.provenance.run.id,
      workflowStepRunId: input.stepRun.id,
      issueId: input.stepRun.issueId,
      fromStatus: input.stepRun.status,
      toStatus: "failed",
      source: input.provenance.source,
      transitionVersion: updated.transitionVersion > input.stepRun.statusTransitionVersion
        ? updated.transitionVersion
        : null,
    });
  }
}

async function startIssueLessToolStepRun(input: {
  db: Db;
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
  step: WorkflowStep;
  stepRun: typeof workflowStepRuns.$inferSelect;
  now: Date;
}): Promise<boolean> {
  const { db, run, definition, step, stepRun, now } = input;

  const toolName = getSingleToolStepName(step);
  const requestId = `${run.id}:${step.id}:${Date.now()}`;
  const workflowSteps = normalizeWorkflowStepsForExecution(definition.stepsJson);
  let args: unknown;
  try {
    args = await resolveWorkflowToolStepArgs({
      db,
      run,
      step: step as PersistedWorkflowStep,
      workflowSteps,
    });
  } catch (error) {
    await failToolStepRunWithDispatchError({
      db,
      step,
      stepRun,
      now,
      requestId,
      toolName,
      args: step.toolArgs ?? {},
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  const concurrencyKey = step.executionControls?.concurrencyKey;
  const concurrencyLimit = step.executionControls?.concurrencyLimit;
  if (concurrencyKey && typeof concurrencyLimit === "number" && concurrencyLimit > 0) {
    const runningCount = await getRunningConcurrencyCount({
      db,
      run,
      stepRun,
      concurrencyKey,
    });
    if (runningCount >= concurrencyLimit) {
      await blockToolStepRunForConcurrency({
        db,
        step,
        stepRun,
        concurrencyKey,
        concurrencyLimit,
        runningCount,
        now,
      });
      return true;
    }
  }
  // [Hybrid QA] Structural gates must NOT use generic tool cache. Cache bypasses
  //   the verdict ledger, requestId binding, and generation tracking. A cached
  //   result has no data.verdict, no official transition-event row, and no
  //   current-generation requestId — semantic QA could run on an unvalidated gate.
  if (!isStructuralGateStep(step)) {
    const cachedStepRun = await findCachedToolStepRun({
      db,
      run,
      definition,
      step,
      toolName,
      args,
      now,
    });
    if (cachedStepRun) {
      await completeToolStepRunFromCache({
        db,
        stepRun,
        sourceStepRun: cachedStepRun,
        step,
        toolName,
        args,
        now,
      });
      return true;
    }
  }

  if (toolName !== "delegate_to_company" && !workflowToolStepExecutor) {
    await failToolStepRunWithDispatchError({
      db,
      step,
      stepRun,
      now,
      requestId,
      toolName,
      args,
      error: "Workflow tool step executor is not configured.",
    });
    return false;
  }

  const structuralGateProducerToken = isStructuralGateStep(step)
    ? await captureStructuralGateProducerToken({ db, workflowRunId: run.id, gate: step, steps: workflowSteps })
    : null;
  if (isStructuralGateStep(step) && !structuralGateProducerToken) {
    await failToolStepRunWithDispatchError({
      db,
      step,
      stepRun,
      now,
      requestId,
      toolName,
      args,
      error: "Structural gate producer generation is unavailable.",
    });
    return false;
  }

  const metadata: Record<string, unknown> = {
    ...buildWorkflowStepRunMetadata(step, stepRun.metadata),
    toolInvocation: {
      requestId,
      toolName,
      args,
      queuedAt: now.toISOString(),
    },
    toolQueue: {
      status: "queued",
      queuedAt: now.toISOString(),
    },
    ...(structuralGateProducerToken ? { structuralGateProducerToken } : {}),
  };
  delete metadata.concurrencyBlocked;

  await db
    .update(workflowStepRuns)
    .set({
      status: "running",
      startedAt: stepRun.startedAt ?? now,
      completedAt: null,
      lastDispatchAttemptAt: now,
      lastDispatchAcceptedAt: null,
      lastDispatchErrorAt: null,
      lastDispatchErrorSummary: null,
      lastDispatchRequestId: requestId,
      metadata,
    })
    .where(eq(workflowStepRuns.id, stepRun.id));

  return true;
}

export async function processQueuedWorkflowToolStepRuns(
  db: Db,
  options: { limit?: number; now?: Date } = {},
): Promise<WorkflowToolStepQueueDispatchResult> {
  const limit = Math.max(1, Math.min(options.limit ?? 25, 100));
  const queuedRows = await db
    .select({ stepRun: workflowStepRuns, run: workflowRuns, definition: workflowDefinitions })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .innerJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
    .where(and(
      eq(workflowRuns.status, "running"),
      eq(workflowStepRuns.status, "running"),
      isNull(workflowStepRuns.issueId),
      isNull(workflowStepRuns.lastDispatchAcceptedAt),
      isNull(workflowStepRuns.lastDispatchErrorAt),
      sql`${workflowStepRuns.lastDispatchRequestId} is not null`,
    ))
    .orderBy(asc(workflowStepRuns.startedAt), asc(workflowStepRuns.id))
    .limit(limit);

  const result: WorkflowToolStepQueueDispatchResult = {
    claimedCount: 0,
    executedCount: 0,
    failedCount: 0,
    skippedCount: 0,
  };

  for (const row of queuedRows) {
    const now = options.now ?? new Date();
    const steps = normalizeWorkflowStepsForExecution(row.definition.stepsJson);
    const step = steps.find((candidate) => candidate.id === row.stepRun.stepId);
    if (!step || !isIssueLessToolStep(step)) {
      result.skippedCount += 1;
      continue;
    }
    // [when:always / edge gate] A queued issue-less tool row can outlive a non-terminal predecessor, so
    //   re-check classifyStepActivation against current step-run states and skip (not fail) to re-dispatch.
    const activationPreds = buildPredFactsMap(steps, buildStepRunMap(
      await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, row.run.id)),
    ));
    if (!classifyStepActivation(step, activationPreds).runnable) {
      result.skippedCount += 1;
      continue;
    }

    const invocation = getMetadataRecord(row.stepRun.metadata, "toolInvocation");
    const requestId = readMetadataString(invocation.requestId) ?? readMetadataString(row.stepRun.lastDispatchRequestId);
    const toolName = readMetadataString(invocation.toolName) ?? getSingleToolStepName(step);
    const args = Object.prototype.hasOwnProperty.call(invocation, "args")
      ? invocation.args
      : await resolveWorkflowToolStepArgs({
        db,
        run: row.run,
        step: step as PersistedWorkflowStep,
        workflowSteps: steps,
      });
    if (!requestId) {
      await failToolStepRunWithDispatchError({
        db,
        step,
        stepRun: row.stepRun,
        now,
        requestId: `${row.run.id}:${step.id}:${Date.now()}`,
        toolName,
        args,
        error: "Workflow tool step queue entry is missing a dispatch request id.",
        provenance: { run: row.run, source: "workflow_tool_queue" },
      });
      await syncWorkflowRunState(db, row.run.id, "workflow_tool_queue");
      result.failedCount += 1;
      continue;
    }

    const metadata = normalizeRecord(row.stepRun.metadata);
    const claimedMetadata: Record<string, unknown> = {
      ...metadata,
      toolQueue: {
        ...getMetadataRecord(metadata, "toolQueue"),
        status: "claimed",
        claimedAt: now.toISOString(),
      },
      toolInvocation: {
        ...invocation,
        requestId,
        toolName,
        args,
        dispatchedAt: now.toISOString(),
      },
    };

    const claimedStepRun = await db
      .update(workflowStepRuns)
      .set({
        lastDispatchAcceptedAt: now,
        metadata: claimedMetadata,
      })
      .where(and(
        eq(workflowStepRuns.id, row.stepRun.id),
        eq(workflowStepRuns.status, "running"),
        isNull(workflowStepRuns.lastDispatchAcceptedAt),
        isNull(workflowStepRuns.lastDispatchErrorAt),
        eq(workflowStepRuns.lastDispatchRequestId, requestId),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (!claimedStepRun) {
      result.skippedCount += 1;
      continue;
    }
    result.claimedCount += 1;

    try {
      if (toolName === "delegate_to_company") {
        const { startDelegatedWorkflowStep } = await import("../workflow-delegations.js");
        const delegated = await startDelegatedWorkflowStep({
          db,
          run: row.run,
          definition: row.definition,
          step,
          stepRun: claimedStepRun,
          args,
          now,
        });
        if (!delegated) {
          await failToolStepRunWithDispatchError({
            db,
            step,
            stepRun: claimedStepRun,
            now,
            requestId,
            toolName,
            args,
            error: "Workflow delegation tool step could not be started.",
            provenance: { run: row.run, source: "workflow_tool_queue" },
          });
          await syncWorkflowRunState(db, row.run.id, "workflow_tool_queue");
          result.failedCount += 1;
        } else {
          result.executedCount += 1;
        }
        continue;
      }

      if (!workflowToolStepExecutor) {
        await failToolStepRunWithDispatchError({
          db,
          step,
          stepRun: claimedStepRun,
          now,
          requestId,
          toolName,
          args,
          error: "Workflow tool step executor is not configured.",
          provenance: { run: row.run, source: "workflow_tool_queue" },
        });
        await syncWorkflowRunState(db, row.run.id, "workflow_tool_queue");
        result.failedCount += 1;
        continue;
      }

      const persistedStep = step as PersistedWorkflowStep;
      const agentName = typeof persistedStep.agentName === "string" ? persistedStep.agentName.trim() : undefined;
      const dispatchResult = await workflowToolStepExecutor({
        companyId: row.run.companyId,
        workflowRunId: row.run.id,
        workflowId: row.definition.id,
        stepId: step.id,
        stepRunId: claimedStepRun.id,
        toolName,
        args,
        requestId,
        agentId: (typeof step.agentId === "string" && step.agentId.trim())
          ? step.agentId.trim()
          : (typeof step.assigneeAgentId === "string" ? step.assigneeAgentId.trim() : undefined),
        agentName,
      });
      if (dispatchResult?.accepted === false) {
        await failToolStepRunWithDispatchError({
          db,
          step,
          stepRun: claimedStepRun,
          now,
          requestId,
          toolName,
          args,
          error: "Workflow tool step executor rejected the queued request.",
          provenance: { run: row.run, source: "workflow_tool_queue" },
        });
        await syncWorkflowRunState(db, row.run.id, "workflow_tool_queue");
        result.failedCount += 1;
        continue;
      }
      result.executedCount += 1;
    } catch (error) {
      await failToolStepRunWithDispatchError({
        db,
        step,
        stepRun: claimedStepRun,
        now,
        requestId,
        toolName,
        args,
        error: error instanceof Error ? error.message : String(error),
        provenance: { run: row.run, source: "workflow_tool_queue" },
      });
      await syncWorkflowRunState(db, row.run.id, "workflow_tool_queue");
      result.failedCount += 1;
    }
  }

  return result;
}

function mapWorkflowExecutionResult(
  run: typeof workflowRuns.$inferSelect,
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
): WorkflowExecutionResult {
  return {
    runId: run.id,
    workflowId: run.workflowId,
    missionId: run.missionId,
    status: run.status as "running" | "completed" | "failed" | "cancelled",
    completedAt: run.completedAt,
    error: run.status === "failed" ? "One or more workflow steps failed" : undefined,
    stepRuns: stepRuns.map((stepRun) => ({
      id: stepRun.id,
      workflowRunId: stepRun.workflowRunId,
      stepId: stepRun.stepId,
      issueId: stepRun.issueId,
      status: stepRun.status as "pending" | "running" | "completed" | "failed" | "skipped",
      startedAt: stepRun.startedAt,
      completedAt: stepRun.completedAt,
    })),
  };
}

async function getWorkflowExecutionResultSnapshot(
  db: Db,
  runId: string,
): Promise<WorkflowExecutionResult | null> {
  const run = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!run) return null;

  const stepRuns = await db
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, runId));

  return mapWorkflowExecutionResult(run, stepRuns);
}

export async function completeWorkflowToolStepFromResult(
  db: Db,
  input: {
    companyId: string;
    stepRunId: string;
    success: boolean;
    requestId?: string;
    workflowRunId?: string;
    stepId?: string;
    toolName?: string;
    stdout?: string;
    data?: unknown;
    artifactPath?: string;
    stderr?: string;
    exitCode?: number | null;
    error?: string;
    allowTerminalRecovery?: boolean;
  },
): Promise<WorkflowExecutionResult | null> {
  const row = await db
    .select({ stepRun: workflowStepRuns, run: workflowRuns, definition: workflowDefinitions })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .innerJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
    .where(eq(workflowStepRuns.id, input.stepRunId))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!row || row.run.companyId !== input.companyId) return null;
  if (input.workflowRunId && input.workflowRunId !== row.run.id) return null;
  if (input.stepId && input.stepId !== row.stepRun.stepId) return null;
  if (input.requestId && row.stepRun.lastDispatchRequestId && input.requestId !== row.stepRun.lastDispatchRequestId) {
    return null;
  }
  // [Hybrid QA] Structural gate callback guard and verdict handling (extracted).
  const stepForGuard = normalizeWorkflowStepsForExecution(row.definition.stepsJson)
    .find((candidate) => candidate.id === row.stepRun.stepId);
  if (shouldRejectStructuralCallback(stepForGuard, input.requestId, row.stepRun.lastDispatchRequestId)) {
    return null;
  }
  const canRecoverTerminalFailure = input.allowTerminalRecovery === true
    && input.success
    && row.stepRun.status === "failed";
  if (WORKFLOW_STEP_TERMINAL_STATUSES.has(row.stepRun.status) && !canRecoverTerminalFailure) {
    return getWorkflowExecutionResultSnapshot(db, row.run.id);
  }

  const now = new Date();
  const existingMetadata = row.stepRun.metadata && typeof row.stepRun.metadata === "object" && !Array.isArray(row.stepRun.metadata)
    ? row.stepRun.metadata
    : {};
  const steps = normalizeWorkflowStepsForExecution(row.definition.stepsJson);
  const step = steps.find((candidate) => candidate.id === row.stepRun.stepId);
  const toolRequestId = input.requestId ?? row.stepRun.lastDispatchRequestId ?? null;
  const artifactPath = readWorkflowToolArtifactPath({
    artifactPath: input.artifactPath,
    data: input.data,
  });
  const deleteAfterUse = step?.executionControls?.deleteAfterUse === true
    || getMetadataRecord(existingMetadata, "executionControls").deleteAfterUse === true;
  const baseToolResult = {
    requestId: input.requestId ?? row.stepRun.lastDispatchRequestId ?? null,
    toolName: input.toolName ?? null,
    success: input.success,
    stdout: input.stdout ?? null,
    ...(input.data === undefined ? {} : { data: input.data }),
    ...(artifactPath ? { artifactPath } : {}),
    stderr: input.stderr ?? null,
    exitCode: input.exitCode ?? null,
    error: input.error ?? null,
    completedAt: now.toISOString(),
  };
  const toolResult = input.allowTerminalRecovery === true
    ? { ...baseToolResult, recoveredBy: "owner-action" }
    : baseToolResult;
  let resultMetadata: Record<string, unknown> = deleteAfterUse
    ? {
      ...(step ? buildWorkflowStepRunMetadata(step, existingMetadata) : normalizeRecord(existingMetadata)),
      retentionDeleted: { deleteAfterUse: true, toolName: input.toolName ?? null, success: input.success, exitCode: input.exitCode ?? null, deletedAt: now.toISOString() },
    }
    : { ...existingMetadata, toolResult };
  if (deleteAfterUse) { delete resultMetadata.toolInvocation; delete resultMetadata.toolResult; delete resultMetadata.cacheHit; }
  const completionPlan = planStructuralCompletion({
    step: stepForGuard, success: input.success, data: input.data,
  });
  if (completionPlan.effectiveSuccess) {
    resultMetadata = stripRetryTrackingOnSuccess(resultMetadata) ?? resultMetadata;
  }

  // [Hybrid QA] Structural gates: atomic ledger+status transaction with CAS.
  // The status patch is derived PURELY (no DB/ledger write) via
  // planStructuralCompletion; the authoritative verdict is recorded exactly once
  // INSIDE the atomic transaction below. Never pre-write the ledger outside the
  // transaction — a pre-tx write cannot roll back on CAS loss and would orphan a
  // verdict row with no matching step status update.
  // Non-structural tool steps: unchanged non-transactional path.
  if (isStructuralGateStep(stepForGuard)) {
    const structuralGateProducerToken = readStructuralGateProducerToken(
      existingMetadata.structuralGateProducerToken,
    );
    const atomic = await atomicStructuralCompletion({
      db, step: stepForGuard, success: input.success, data: input.data,
      companyId: row.run.companyId, workflowRunId: row.run.id,
      workflowStepRunId: row.stepRun.id, missionId: row.run.missionId, issueId: row.stepRun.issueId, requestId: toolRequestId!,
      source: "workflow_tool_result",
      observedStatus: row.stepRun.status,
      observedIterationIndex: row.stepRun.iterationIndex ?? null,
      observedRequestId: row.stepRun.lastDispatchRequestId,
      observedCompletedAt: row.stepRun.completedAt,
      producerToken: structuralGateProducerToken,
      patch: {
        startedAt: row.stepRun.startedAt ?? now, completedAt: now,
        metadata: resultMetadata,
        fallbackFailureSummary: input.error ?? input.stderr ?? null,
      },
    });
    if (!atomic.casWon) return getWorkflowExecutionResultSnapshot(db, row.run.id);
    return syncWorkflowRunState(db, row.run.id, "workflow_tool_result");
  }

  // Non-structural path: reuse the pure completion plan.
  // When finalization v1 is enabled, tool steps must also set dispatch_ready_at
  // so that v1Enforcement-enabled edge-condition evaluation admits downstream steps.
  // Heartbeat-backed steps get this via settlement.ts; tool steps bypass heartbeat
  // entirely, so we set it here on successful completion (only if not already set).
  const { structuralGateRejected, structuralContractFailure, effectiveSuccess } = completionPlan;
  const nextStatus = effectiveSuccess ? "completed" : "failed";
  const [updatedStepRun] = await db.update(workflowStepRuns).set({
    status: nextStatus,
    startedAt: row.stepRun.startedAt ?? now, completedAt: now,
    dispatchReadyAt: effectiveSuccess && !row.stepRun.dispatchReadyAt ? now : undefined,
    lastDispatchErrorAt: effectiveSuccess ? null : now,
    lastDispatchErrorSummary: effectiveSuccess ? null
      : structuralGateRejected ? "structural_gate_request_changes"
      : structuralContractFailure ? "structural_gate_contract_failure"
      : (input.error ?? input.stderr ?? null),
    metadata: resultMetadata,
  }).where(eq(workflowStepRuns.id, row.stepRun.id)).returning({
    id: workflowStepRuns.id,
    transitionVersion: workflowStepRuns.statusTransitionVersion,
  });
  if (updatedStepRun) {
    await recordWorkflowStepStatusTransition(db, {
      companyId: row.run.companyId,
      missionId: row.run.missionId,
      workflowRunId: row.run.id,
      workflowStepRunId: row.stepRun.id,
      issueId: row.stepRun.issueId,
      fromStatus: row.stepRun.status,
      toStatus: nextStatus,
      source: "workflow_tool_result",
      transitionVersion: updatedStepRun.transitionVersion > row.stepRun.statusTransitionVersion
        ? updatedStepRun.transitionVersion
        : null,
    });
  }

  return syncWorkflowRunState(db, row.run.id, "workflow_tool_result");
}
export async function retryIssueLessToolWorkflowStep(
  db: Db,
  input: { companyId: string; runId: string; stepId: string },
): Promise<{ stepRunId: string; result: WorkflowExecutionResult } | null> {
  return retryIssueLessToolWorkflowStepInternal({
    db,
    ...input,
    loadWorkflowExecutionContext,
    isIssueLessToolStep,
    resetUnlaunchedTerminalStepRuns,
    syncWorkflowRunState: (syncDb, runId) => syncWorkflowRunState(syncDb, runId, "workflow_retry"),
  });
}

async function finalizeWorkflowRunState(
  db: Db,
  context: WorkflowExecutionContext,
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
): Promise<typeof workflowRuns.$inferSelect> {
  const hasFailedStep = stepRuns.some((stepRun) => stepRun.status === "failed");
  const hasActiveStep = stepRuns.some((stepRun) => !WORKFLOW_STEP_TERMINAL_STATUSES.has(stepRun.status));
  const dynamicLaunchStepIds = getDynamicLaunchStepIds(context);
  const executableStepRuns = dynamicLaunchStepIds
    ? stepRuns.filter((stepRun) => dynamicLaunchStepIds.has(stepRun.stepId))
    : stepRuns;
  const executableHasActiveStep = executableStepRuns.some((stepRun) => !WORKFLOW_STEP_TERMINAL_STATUSES.has(stepRun.status));
  const allStepsTerminal = dynamicLaunchStepIds
    ? executableStepRuns.length === dynamicLaunchStepIds.size && !executableHasActiveStep
    : stepRuns.length === context.steps.length && !hasActiveStep;
  const nextStatus =
    context.run.status === "cancelled"
      ? "cancelled"
      : hasFailedStep && allStepsTerminal
        ? "failed"
        : !hasFailedStep && allStepsTerminal
          ? "completed"
          : "running";
  const patch: Partial<typeof workflowRuns.$inferInsert> = {
    status: nextStatus,
    startedAt: context.run.startedAt ?? new Date(),
    completedAt: nextStatus === "completed" || nextStatus === "failed" || nextStatus === "cancelled" ? new Date() : null,
  };

  const [updatedRun] = await db
    .update(workflowRuns)
    .set(patch)
    .where(eq(workflowRuns.id, context.run.id))
    .returning();

  const finalRun = updatedRun ?? { ...context.run, ...patch } as typeof workflowRuns.$inferSelect;
  const dynamicOwnerPlan = isDynamicOwnerPlanWorkflowDefinition(buildWorkflowDefinitionExecutionShape(context));
  const missionId = finalRun.missionId;
  const shouldStopMissionRuntimes = missionId !== null
    && TERMINAL_WORKFLOW_STATUSES.has(finalRun.status)
    && !(dynamicOwnerPlan && finalRun.status === "completed");
  if (shouldStopMissionRuntimes) {
    await stopMissionRuntimesForMission(db, {
      companyId: finalRun.companyId,
      missionId,
      reason: `workflow ${finalRun.id} ${finalRun.status}`,
    });
  }

  return finalRun;
}

async function cancelOutstandingWorkflowIssues(
  db: Db,
  runId: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(issues)
    .set({
      status: "cancelled",
      cancelledAt: now,
      updatedAt: now,
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    })
    .where(and(
      eq(issues.originKind, "workflow_execution"),
      eq(issues.originRunId, runId),
      sql`${issues.status} not in ('done', 'cancelled')`,
    ));
}


export async function cancelWorkflowRunWithCleanup(
  db: Db,
  runId: string,
  companyId?: string,
): Promise<boolean> {
  const whereClause = companyId
    ? and(eq(workflowRuns.id, runId), eq(workflowRuns.companyId, companyId))
    : eq(workflowRuns.id, runId);
  const updatedRows = await db
    .update(workflowRuns)
    .set({
      status: "cancelled",
      completedAt: new Date(),
    })
    .where(whereClause)
    .returning({ id: workflowRuns.id, companyId: workflowRuns.companyId, missionId: workflowRuns.missionId });

  const updatedRun = updatedRows[0];
  if (!updatedRun) {
    return false;
  }

  await cancelOutstandingWorkflowIssues(db, runId);
  await syncCancelledWorkflowRunState({
    db,
    run: updatedRun,
    syncStepRunsFromIssueState,
  });
  if (updatedRun.missionId) {
    await stopMissionRuntimesForMission(db, {
      companyId: updatedRun.companyId,
      missionId: updatedRun.missionId,
      reason: `workflow ${runId} cancelled`,
    });
  }
  return true;
}

async function commentOnMainExecutorOversightForFailures(
  db: Db,
  context: WorkflowExecutionContext,
  stepRuns: (typeof workflowStepRuns.$inferSelect)[],
): Promise<void> {
  const missionId = context.run.missionId;
  if (!missionId) return;

  const failedStepRuns = stepRuns.filter((stepRun) => stepRun.status === "failed");
  if (failedStepRuns.length === 0) return;

  const oversightIssue = await db
    .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId })
    .from(issues)
    .where(and(
      eq(issues.missionId, missionId),
      eq(issues.originKind, "mission_main_executor_oversight"),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!oversightIssue) return;

  const existingComments = await db
    .select({ body: issueComments.body })
    .from(issueComments)
    .where(eq(issueComments.issueId, oversightIssue.id));
  const existingBodies = existingComments.map((comment) => comment.body).join("\n");

  for (const stepRun of failedStepRuns) {
    const marker = `workflow-failure:${context.run.id}:${stepRun.stepId}`;
    if (existingBodies.includes(marker)) continue;
    const step = context.steps.find((candidate) => candidate.id === stepRun.stepId);
    await db.insert(issueComments).values({
      authorAgentId: oversightIssue.assigneeAgentId,
      body: [
        "### Workflow step failed",
        `<!-- ${marker} -->`,
        `- Workflow: ${context.definition.name}`,
        `- Run: ${context.run.id}`,
        `- Step: ${stepRun.stepId}${step?.name ? ` (${step.name})` : ""}`,
        `- Observed at: ${new Date().toISOString()}`,
        "",
        "Main executor action:",
        "- Review the failed step output and decide whether a retry is safe.",
        "- Retry failed steps only within the retry limit; otherwise escalate with context.",
      ].join("\n"),
      companyId: context.run.companyId,
      issueId: oversightIssue.id,
    });
  }
}

async function applyConditionalSkipPropagation(input: {
  db: Db;
  context: WorkflowExecutionContext;
  stepRuns: (typeof workflowStepRuns.$inferSelect)[];
  dynamicLaunchStepIds?: Set<string>;
  validationVerdictsByIssueId: Map<string, ValidationVerdictObservation>;
}): Promise<(typeof workflowStepRuns.$inferSelect)[]> {
  if (input.context.run.status === "cancelled" || !workflowHasConditionalEdges(input.context.steps)) {
    return input.stepRuns;
  }
  let stepRuns = input.stepRuns;
  for (;;) {
    const skipRunMap = buildStepRunMap(stepRuns);
    const skipPredsByStepId = buildPredFactsMap(
      input.context.steps,
      skipRunMap,
      input.validationVerdictsByIssueId,
    );
    const skippableSteps = findSkippableSteps(input.context.steps, skipPredsByStepId, {
      launchedStepIds: input.dynamicLaunchStepIds,
      isStepEligible: (step) => {
        const run = skipRunMap.get(step.id);
        if (!run || run.status !== "pending" || run.issueId != null) return false;
        if (step.dependencies.some((depId) => {
          const depStep = input.context.steps.find((candidate) => candidate.id === depId);
          return isStructuralGateStep(depStep);
        })) return false;
        return !hasRecoverableQaRequestChangesDependency(
          step,
          input.context.steps,
          skipRunMap,
          input.validationVerdictsByIssueId,
        );
      },
    });
    if (skippableSteps.length === 0) return stepRuns;

    const completedAt = new Date();
    for (const step of skippableSteps) {
      const stepRun = skipRunMap.get(step.id);
      if (!stepRun) continue;
      await input.db
        .update(workflowStepRuns)
        .set({
          status: "skipped",
          completedAt,
          metadata: {
            ...buildWorkflowStepRunMetadata(step, stepRun.metadata),
            controlFlowSkipped: true,
          },
        })
        .where(eq(workflowStepRuns.id, stepRun.id));
    }
    stepRuns = await input.db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, input.context.run.id));
  }
}

export async function syncWorkflowRunState(
  db: Db,
  runId: string,
  source: WorkflowSyncSource = "workflow_sync",
): Promise<WorkflowExecutionResult> {
  const normalizedSource = normalizeWorkflowSyncSource(source);
  const context = await loadWorkflowExecutionContext(db, runId);
  let stepRuns = await ensureStepRunRecords(db, runId, context.steps);
  const priorStatusByStepRunId = new Map(stepRuns.map((stepRun) => [stepRun.id, stepRun.status]));
  stepRuns = await syncStepRunsFromIssueState(db, stepRuns, context.steps, context);
  const v1Enforcement = await isHeartbeatFinalizationV1Enabled(db);

  const dynamicLaunchStepIds = getDynamicLaunchStepIds(context);
  if (!dynamicLaunchStepIds && context.run.status !== "cancelled") {
    stepRuns = await resetUnlaunchedTerminalStepRuns(db, stepRuns);
  }
  if (context.run.status !== "cancelled") {
    stepRuns = await failMalformedCompletedControlNodes(db, context, stepRuns);
  }
  // [IF/loop] skip-propagation pass — 명시적 conditional false-branch 를 skipped 로 마감.
  //   hasConditionalEdges 게이트: conditional edge 가 없는 legacy 워크플로에겐 이 pass 가 no-op 이다(회귀 없음).
  //   syncStepRunsFromIssueState 이후·resetUnlaunchedTerminalStepRuns 이후에 실행한다 — QA request_changes →
  //   failed 가 반영된 후에야 when 평가가 정확하며, sentinel(controlFlowSkipped) 로 마감해 reset 의 flap(가즈아 hang)을 막는다.
  const hasConditionalEdges = workflowHasConditionalEdges(context.steps);
  // Plain legacy workflows must not pay the verdict-query cost. Load
  // authoritative validation verdicts only when conditional control flow or an
  // active issue-backed QA retry can actually consume semantic request_changes.
  const runValidationBindings = new Map<string, WorkflowValidationIssueBinding>();
  for (const stepRun of stepRuns) {
    if (!stepRun.issueId) continue;
    runValidationBindings.set(stepRun.issueId, {
      companyId: context.run.companyId,
      workflowRunId: stepRun.workflowRunId,
      workflowStepRunId: stepRun.id,
    });
  }
  const validationVerdictsByIssueId = context.run.status !== "cancelled"
    && shouldLoadValidationVerdictsForRun(context.steps, stepRuns)
    ? await loadLatestValidationVerdicts(db, runValidationBindings)
    : new Map<string, ValidationVerdictObservation>();
  // ④ revive pass — 선행이 회복(rework/재시도 completed) 되어 failure cascade 로 controlFlowSkipped 된
  //   downstream step 이 다시 runnable 이 되면 sentinel 을 풀고 pending 으로 부활시켜 이어지는 launch 가
  //   다시 잡게 한다. plain(legacy dependsOn) 워크플로도 포함한다 — deadlock-reconciler 가 남긴 stale skip 은
  //   선행 완료 후 반드시 재평가되어야 회복된 run 이 정상 종료된다(조건부-edge 전용 게이트 제거).
  //   IF false-branch / 여전히 failed 인 선행은 classifyStepActivation 이 runnable=false 를 주어 부활하지
  //   않는다(legitimate-skip/flap 회피). resetUnlaunchedTerminalStepRuns 은 controlFlowSkipped 를 제외하므로
  //   이 pass 가 유일한 정확한 부활 경로(무조건 skipped→pending flap 없음).
  if (context.run.status !== "cancelled") {
    const reviveRunMap = buildStepRunMap(stepRuns);
    const revivePredsByStepId = buildPredFactsMap(context.steps, reviveRunMap, validationVerdictsByIssueId);
    let revivedAny = false;
    for (const step of context.steps) {
      const sr = reviveRunMap.get(step.id);
      if (!sr || sr.status !== "skipped" || normalizeRecord(sr.metadata).controlFlowSkipped !== true) continue;
      if (!classifyStepActivation(step, revivePredsByStepId).runnable) continue;
      await db
        .update(workflowStepRuns)
        .set({
          status: "pending",
          startedAt: null,
          completedAt: null,
          metadata: { ...buildWorkflowStepRunMetadata(step, sr.metadata), controlFlowSkipped: false },
        })
        .where(eq(workflowStepRuns.id, sr.id));
      revivedAny = true;
    }
    if (revivedAny) {
      stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    }
  }
  stepRuns = await applyConditionalSkipPropagation({
    db,
    context,
    stepRuns,
    dynamicLaunchStepIds,
    validationVerdictsByIssueId,
  });

  // [IF/loop P4] back-edge rework pass — QA request_changes 로 발화한 back-edge 의 타겟(producer) 을
  //   maxIterations cap 내에서 리셋(rework). 리셋된 producer 는 이어지는 launch while-loop 에서 재실행되고,
  //   producer 재완료 후 기존 validation-recheck(syncStepRunsFromIssueState) 가 QA issue 를 재QA 시킨다.
  //   skip-pass 이후·launch 이전에 실행: QA failed 가 반영된 뒤 리셋된 step 이 runnable 로 launch 되게.
  //   가즈아 무한 loop 방지: iteration_index 단조 증가 + maxIterations 하드 cap(loop-driver). reconciler(60min) 백업.
  if (hasConditionalEdges && context.run.status !== "cancelled") {
    const reworkPredsByStepId = buildPredFactsMap(
      context.steps,
      buildStepRunMap(stepRuns),
      validationVerdictsByIssueId,
    );
    const reworkResult = await applyBackEdgeReworkPass({
      db,
      run: context.run,
      steps: context.steps,
      stepRuns,
      predsByStepId: reworkPredsByStepId,
      validationVerdictsByIssueId,
    });
    stepRuns = reworkResult.stepRuns;
  }
  // [Hybrid QA] structural gate rework pass — when a structural (deterministic)
  //   tool gate returned request_changes, reset the producer for rework within
  //   the existing maxIterations cap. Also resets completed downstream structural
  //   gates when a producer is reworked (fresh gate re-run, no stale PASS).
  //   Runs after applyBackEdgeReworkPass so both QA and structural gate rejections
  //   are handled before the launch loop.
  if (context.run.status !== "cancelled" && context.steps.some(isStructuralGateStep)) {
    const structuralResult = await applyStructuralGatePass({
      db,
      run: context.run,
      steps: context.steps,
      stepRuns,
    });
    stepRuns = structuralResult.stepRuns;
  }

  // [Workflow Retry] After recovery/rework passes settle, atomically schedule
  // eligible failed steps; launch loop below dispatches immediate retries and
  // leaves delayed retries pending for the reconciler.
  if (context.run.status !== "cancelled") {
    stepRuns = await applyWorkflowStepRetryPass({
      db,
      context,
      stepRuns,
      validationVerdictsByIssueId,
    });
  }

  const hasFailure = stepRuns.some((stepRun) => stepRun.status === "failed");
  if (hasFailure) {
    await commentOnMainExecutorOversightForFailures(db, context, stepRuns);
  }
  // [IF/loop] short-circuit narrowing: legacy 워크플로(hasConditionalEdges=false)에선 기존과 동일하게
  //   hasFailure 시 launch 를 건너뛴다. conditional edge 가 있으면 failure/always-gated step 도 발화해야
  //   하므로 launch loop 를 항상 실행한다. [Hybrid QA 136B] structural gate failures are
  //   recoverable (request_changes triggers rework), so allow launch when structural
  //   gates exist — pending sibling gates must be able to finish.
  const hasStructuralGates = context.steps.some(isStructuralGateStep);
  if (!hasFailure || hasConditionalEdges || hasStructuralGates) {
    let shouldContinue = true;
    let synchronousControlPasses = 0;
    while (shouldContinue) {
      shouldContinue = false;
      const stepRunMap = buildStepRunMap(stepRuns);
      const runnableSteps = sortWorkflowStepsByPriority(findRunnableSteps(context.steps, stepRunMap, {
        launchedStepIds: dynamicLaunchStepIds,
        validationVerdictsByIssueId,
        v1EnforcementEnabled: v1Enforcement,
      }));
      if (runnableSteps.length === 0) break;

      let failedIssueLessToolStep = false;
      let executedControlNode = false;
      for (const step of runnableSteps) {
        const stepRun = stepRunMap.get(step.id);
        if (!stepRun) continue;

        if (isWorkflowControlNode(step)) {
          await executeWorkflowControlNode({ db, context, step, stepRun });
          executedControlNode = true;
          continue;
        }

        if (isIssueLessToolStep(step)) {
          const started = await startIssueLessToolStepRun({
            db,
            run: context.run,
            definition: context.definition,
            step,
            stepRun,
            now: new Date(),
          });
          failedIssueLessToolStep = failedIssueLessToolStep || !started;
          if (started) {
            await markIssueLessRetryDispatchingFromProof({
              db,
              workflowRunId: context.run.id,
              stepRunId: stepRun.id,
              observedRetryCount: stepRun.retryCount,
              priorLastDispatchRequestId: stepRun.lastDispatchRequestId,
              metadata: stepRun.metadata,
            });
          }
          continue;
        }

        if (stepRun.issueId) {
          const retryMeta = readWorkflowRetryMetadata(normalizeRecord(stepRun.metadata).workflowRetry);
          const resumeExistingIssue = stepRunNeedsWorkflowResume(stepRun) || retryMeta !== null;
          await wakeIssueBackedRetryAndMarkDispatching({
            db,
            companyId: context.run.companyId,
            workflowRunId: context.run.id,
            definition: context.definition,
            run: context.run,
            step,
            stepRunId: stepRun.id,
            stepRunMetadata: stepRun.metadata,
            issueId: stepRun.issueId,
            observedRetryCount: stepRun.retryCount,
            resumeExistingIssue,
            wakeExistingWorkflowStepIssue,
          });
          continue;
        }

        const issueId = await createWorkflowStepIssue({
          db,
          run: context.run,
          definition: context.definition,
          step,
        });
        if (!issueId) continue;
        await db
          .update(workflowStepRuns)
          .set({ issueId })
          .where(eq(workflowStepRuns.id, stepRun.id));
      }

      stepRuns = await db
        .select()
        .from(workflowStepRuns)
        .where(eq(workflowStepRuns.workflowRunId, runId));

      if (executedControlNode) {
        synchronousControlPasses += 1;
        if (synchronousControlPasses > context.steps.length + 1) {
          throw new Error(`Workflow control-node convergence limit exceeded for run ${runId}`);
        }
        // Only a freshly executed IF can change condition_true/condition_false
        // reachability inside this synchronous loop. Keep the legacy QA/back-edge
        // launch order untouched on iterations that did not execute a control node.
        stepRuns = await applyConditionalSkipPropagation({
          db,
          context,
          stepRuns,
          dynamicLaunchStepIds,
          validationVerdictsByIssueId,
        });
      }
      shouldContinue = failedIssueLessToolStep || executedControlNode;
    }
  }

  const hasFailureAfterLaunch = stepRuns.some((stepRun) => stepRun.status === "failed");
  if (!hasFailure && hasFailureAfterLaunch) {
    await commentOnMainExecutorOversightForFailures(db, context, stepRuns);
  }

  if (dynamicLaunchStepIds && !hasFailure) {
    const launchedStepRuns = stepRuns.filter((stepRun) => dynamicLaunchStepIds.has(stepRun.stepId));
    const launchedStepsTerminal = launchedStepRuns.length === dynamicLaunchStepIds.size
      && launchedStepRuns.every((stepRun) => WORKFLOW_STEP_TERMINAL_STATUSES.has(stepRun.status));
    const unlaunchedPendingSteps = stepRuns.filter((stepRun) =>
      !dynamicLaunchStepIds.has(stepRun.stepId) && stepRun.status === "pending" && stepRun.issueId == null
    );
    if (launchedStepsTerminal && unlaunchedPendingSteps.length > 0) {
      const now = new Date();
      for (const stepRun of unlaunchedPendingSteps) {
        await db
          .update(workflowStepRuns)
          .set({ status: "skipped", completedAt: now })
          .where(eq(workflowStepRuns.id, stepRun.id));
      }
      stepRuns = await db
        .select()
        .from(workflowStepRuns)
        .where(eq(workflowStepRuns.workflowRunId, runId));
    }
  }

  const updatedRun = await finalizeWorkflowRunState(db, context, stepRuns);
  await recordWorkflowStepStatusTransitions(db, {
    companyId: context.run.companyId,
    missionId: context.run.missionId,
    workflowRunId: context.run.id,
    source: normalizedSource,
    priorStatusByStepRunId,
    stepRuns,
  });

  return {
    runId,
    workflowId: updatedRun.workflowId,
    missionId: updatedRun.missionId,
    status: updatedRun.status as "running" | "completed" | "failed" | "cancelled",
    completedAt: updatedRun.completedAt,
    error: updatedRun.status === "failed" ? "One or more workflow steps failed" : undefined,
    stepRuns: stepRuns.map((stepRun) => ({
      id: stepRun.id,
      workflowRunId: stepRun.workflowRunId,
      stepId: stepRun.stepId,
      issueId: stepRun.issueId,
      status: stepRun.status as "pending" | "running" | "completed" | "failed" | "skipped",
      startedAt: stepRun.startedAt,
      completedAt: stepRun.completedAt,
    })),
  };
}

export async function syncWorkflowRunForIssue(
  db: Db,
  issueId: string,
  source: WorkflowSyncSource = "workflow_sync",
): Promise<WorkflowExecutionResult | null> {
  const normalizedSource = normalizeWorkflowSyncSource(source);
  const issue = await db
    .select({
      originKind: issues.originKind,
      originRunId: issues.originRunId,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (issue?.originKind === "workflow_execution" && issue.originRunId) {
    return syncWorkflowRunState(db, issue.originRunId, normalizedSource);
  }

  const linkedStepRun = await db
    .select({ workflowRunId: workflowStepRuns.workflowRunId })
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.issueId, issueId))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!linkedStepRun?.workflowRunId) {
    return null;
  }

  return syncWorkflowRunState(db, linkedStepRun.workflowRunId, normalizedSource);
}

/**
 * Executes a workflow run.
 *
 * @param db - Database instance.
 * @param runId - The workflow run ID to execute.
 * @param tx - Optional transaction for atomic execution.
 * @returns Execution result.
 */
export async function executeWorkflowRun(
  db: Db,
  runId: string,
): Promise<WorkflowExecutionResult> {
  const context = await loadWorkflowExecutionContext(db, runId);
  await assertWorkflowToolStepsReady({
    companyId: context.run.companyId,
    steps: context.steps,
  });
  // [Hybrid QA] Persisted runtime execution: a structural gate must fail closed
  //   here too (tool registered + enabled + structural_validation_v1 capability
  //   + assignee grant), even if the definition was inserted bypassing the engine
  //   create/update path. Ordinary tool/agent steps are unaffected.
  const structuralErrors = await validateStructuralGateReadinessForSteps({
    db,
    companyId: context.run.companyId,
    steps: context.steps,
  });
  const structuralTopologyErrors = getStructuralTopologyErrors(context.steps);
  const allStructuralErrors = [...structuralErrors, ...structuralTopologyErrors];
  if (allStructuralErrors.length > 0) {
    throw new Error(`Structural gate validation failed: ${allStructuralErrors.join("; ")}`);
  }
  const startedAt = new Date();
  await db.transaction(async (tx) => {
    const [startedRun] = await tx
      .update(workflowRuns)
      .set({ status: "running", startedAt, completedAt: null })
      .where(and(
        eq(workflowRuns.id, runId),
        eq(workflowRuns.companyId, context.run.companyId),
      ))
      .returning({
        id: workflowRuns.id,
        companyId: workflowRuns.companyId,
        missionId: workflowRuns.missionId,
        startedAt: workflowRuns.startedAt,
      });
    if (!startedRun?.startedAt) {
      throw new Error(`Workflow run disappeared before execution start: ${runId}`);
    }
    await activatePlanningMissionForWorkflowRun(tx, {
      companyId: startedRun.companyId,
      missionId: startedRun.missionId,
      workflowRunId: startedRun.id,
      startedAt: startedRun.startedAt,
    });
  });
  return syncWorkflowRunState(db, runId, "workflow_execution");
}

// NOTE: stuck-run 정리(reconcile)는 services/workflow/reconciler.ts 의
// createNativeWorkflowReconciler + reconcileWorkflow 로 이관했다. 과거 이 파일에
// 있던 reconcileWorkflowRuns(및 engine.ts 의 reconcile() 래퍼)는 호출부가 없는
// dead code 였고, 그 빈약 구현(run 상태만 failed 로 바꾸고 pending step / orphan
// step 은 처리하지 않음) 대신 reconciler.ts 의 더 완전한 구현을 주기 구동한다.

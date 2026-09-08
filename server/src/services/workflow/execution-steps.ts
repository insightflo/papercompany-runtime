// Workflow Execution Steps
//
// [목적] dag-engine 의 실행 step 정규화/모드 판정/발주 step 구성 로직 중 순수(비 DB) 부분.
//   Task5a0 에서 dag-engine.ts 로부터 1:1 추출됨. 동작 보존이 원칙 — 여기서 정규화 규칙을 바꾸지 않는다.
// [외부 연결] dag-engine 은 이 모듈의 함수를 runtime import 하고 재노출한다(호환 표면).
//   반대로 이 모듈은 dag-engine 의 타입만 import type 으로 참조한다(runtime 의존 없음 → import cycle 방지).

import type { WorkflowStep, WorkflowStepExecutionControls } from "./dag-engine.js";
import { isQaLikeStep } from "../missions/supervision-helpers.js";
import { normalizeConditionalEdges } from "./control-flow/types.js";
import { normalizeWorkflowQaType } from "./workflow-qa-type.js";
import { readWorkProductRequirementMarker } from "./workflow-step-workproduct-markers.js";
import {
  hasExistingDeliveryReadbackStep,
  isDeliveryRelevantStep,
  strengthenDeliveryReadbackSteps,
  synthesizeDeliveryVerificationGateStep,
} from "./delivery-verification-gate.js";

export type PersistedWorkflowStep = WorkflowStep & {
  title?: unknown;
  dependsOn?: unknown;
  tools?: unknown;
  toolName?: unknown;
  toolArgs?: unknown;
  type?: unknown;
  qaType?: unknown;
  targetWorkflowId?: unknown;
  wait?: unknown;
  inputs?: unknown;
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

export type WorkflowDefinitionExecutionShape = {
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

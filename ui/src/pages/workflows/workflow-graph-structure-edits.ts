// Immutable graph structure edits: step run status, edges, rename/duplicate/remove and palette insertion.
// Split out of workflow-graph.ts (pure move, function bodies unchanged).

import type { WorkflowGraphEdgeMetadataInput, WorkflowGraphStep, WorkflowGraphStepRunInput } from "./workflow-graph-types-core.js";
import type { WorkflowGraphFailureRouteOptions } from "./workflow-graph-types-model.js";
import type { WorkflowGraphPaletteNodeKind } from "./workflow-graph-types-interface.js";
import { parseDependencies } from "./workflow-graph-dependencies.js";
import { normalizeGraphRunStatus } from "./workflow-graph-run-status.js";
import { cloneWorkflowConditionGroup, defaultIfConditionGroup } from "./workflow-control-nodes.js";
import { buildStepMap, compactGraphEdgeMetadata, normalizeWorkProducts, readRecord, readString } from "./workflow-graph-step-runtime.js";
import { buildWorkflowGraphModel } from "./workflow-graph-model-build.js";
import { buildWorkflowGraphFailureRouteSummary, hasPath } from "./workflow-graph-run-views.js";

function formatDependencies(dependencies: string[]): string {
  return dependencies.join(", ");
}

function nextUniqueStepId<TStep extends WorkflowGraphStep>(steps: TStep[], baseId: string): string {
  const existingIds = new Set(steps.map((step) => step.id.trim()).filter(Boolean));
  const normalizedBaseId = baseId.trim() || "step";
  let candidate = normalizedBaseId;
  let index = 2;
  while (existingIds.has(candidate)) {
    candidate = `${normalizedBaseId}-${index}`;
    index += 1;
  }
  return candidate;
}

function clearGraphRunOverlay<TStep extends WorkflowGraphStep>(step: TStep): Record<string, unknown> {
  const next = { ...step } as Record<string, unknown>;
  for (const key of [
    "graphRunStatus",
    "graphRunStepRunId",
    "graphRunIssueId",
    "graphRunIssueIdentifier",
    "graphRunUpdatedAt",
    "graphRunSummary",
    "graphRunStartedAt",
    "graphRunCompletedAt",
    "graphRunLastDispatchAttemptAt",
    "graphRunLastDispatchAcceptedAt",
    "graphRunLastDispatchErrorAt",
    "graphRunLastDispatchErrorSummary",
    "graphRunLastDispatchRequestId",
    "graphRunResultPreview",
    "graphRunLogPreview",
    "graphRunControlOutcome",
    "graphRunWorkProducts",
  ]) {
    delete next[key];
  }
  return next;
}

export function setStepGraphRunStatus<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepId: string,
  patch: { status?: string; issueIdentifier?: string; updatedAt?: string; summary?: string },
): TStep[] {
  const id = stepId.trim();
  if (!id) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (step.id !== id) return step;
    changed = true;
    return {
      ...step,
      ...(patch.status !== undefined ? { graphRunStatus: normalizeGraphRunStatus(patch.status) } : {}),
      ...(patch.issueIdentifier !== undefined ? { graphRunIssueIdentifier: patch.issueIdentifier.trim() } : {}),
      ...(patch.updatedAt !== undefined ? { graphRunUpdatedAt: patch.updatedAt.trim() } : {}),
      ...(patch.summary !== undefined ? { graphRunSummary: patch.summary.trim() } : {}),
    };
  });
  return changed ? next : steps;
}

export function applyStepRunsToGraphSteps<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepRuns: WorkflowGraphStepRunInput[],
): TStep[] {
  const runByStepId = new Map<string, WorkflowGraphStepRunInput>();
  for (const run of stepRuns) {
    const stepId = typeof run.stepId === "string" ? run.stepId.trim() : "";
    if (stepId) runByStepId.set(stepId, run);
  }

  return steps.map((step) => {
    const run = runByStepId.get(step.id.trim());
    if (!run) {
      return {
        ...step,
        graphRunStatus: step.graphRunStatus ?? "planned",
      };
    }
    const updatedAt = run.completedAt?.trim()
      || run.startedAt?.trim()
      || run.lastDispatchAcceptedAt?.trim()
      || run.lastDispatchAttemptAt?.trim()
      || run.lastDispatchErrorAt?.trim()
      || "";
    const summary = run.lastDispatchErrorSummary?.trim()
      || (typeof run.agentName === "string" ? run.agentName.trim() : "")
      || "";
    const metadata = readRecord(run.metadata);
    const controlNodeResult = readRecord(metadata?.controlNodeResult);
    const resultPreview = readString(metadata?.resultPreview);
    const logPreview = readString(metadata?.logPreview);
    const workflowRetry = readRecord(metadata?.workflowRetry);
    return {
      ...step,
      graphRunStatus: normalizeGraphRunStatus(run.status),
      graphRunStepRunId: run.id?.trim() || "",
      graphRunIssueId: run.issueId?.trim() || "",
      graphRunIssueIdentifier: run.issueIdentifier?.trim() || run.issueId?.trim() || "",
      graphRunUpdatedAt: updatedAt,
      graphRunSummary: summary,
      graphRunStartedAt: run.startedAt?.trim() || "",
      graphRunCompletedAt: run.completedAt?.trim() || "",
      graphRunLastDispatchAttemptAt: run.lastDispatchAttemptAt?.trim() || "",
      graphRunLastDispatchAcceptedAt: run.lastDispatchAcceptedAt?.trim() || "",
      graphRunLastDispatchErrorAt: run.lastDispatchErrorAt?.trim() || "",
      graphRunLastDispatchErrorSummary: run.lastDispatchErrorSummary?.trim() || "",
      graphRunLastDispatchRequestId: run.lastDispatchRequestId?.trim() || "",
      graphRunResultPreview: resultPreview,
      graphRunLogPreview: logPreview,
      graphRunControlOutcome: readString(controlNodeResult?.outcome),
      graphRunWorkProducts: normalizeWorkProducts(run.workProducts),
      graphRunConcurrencyBlocked: readRecord(metadata?.concurrencyBlocked) ?? undefined,
      graphRunRetentionDeleted: readRecord(metadata?.retentionDeleted) ?? undefined,
      graphRunRetryCount: typeof run.retryCount === "number" ? run.retryCount : 0,
      graphRunRetryMaxRetries: typeof workflowRetry?.maxRetries === "number" ? workflowRetry.maxRetries : 0,
      graphRunRetryState: typeof workflowRetry?.state === "string" ? workflowRetry.state.trim() : "",
      graphRunRetryNextEligibleAt: typeof workflowRetry?.nextEligibleAt === "string" ? workflowRetry.nextEligibleAt.trim() : "",
    };
  });
}

export function connectSteps<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  sourceId: string,
  targetId: string,
): TStep[] {
  const source = sourceId.trim();
  const target = targetId.trim();
  if (!source || !target) return steps;
  if (source === target) {
    throw new Error("A workflow step cannot depend on itself.");
  }
  const stepMap = buildStepMap(steps);
  if (!stepMap.has(source) || !stepMap.has(target)) {
    throw new Error("Both workflow steps must exist before connecting them.");
  }
  if (hasPath(steps, target, source)) {
    throw new Error(`Connecting "${source}" to "${target}" would create a cycle.`);
  }

  let changed = false;
  const next = steps.map((step) => {
    if (step.id !== target) return step;
    const dependencies = parseDependencies(step.dependsOn);
    if (dependencies.includes(source)) return step;
    changed = true;
    return { ...step, dependsOn: formatDependencies([...dependencies, source]) };
  });

  return changed ? next : steps;
}

export function disconnectSteps<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  sourceId: string,
  targetId: string,
): TStep[] {
  const source = sourceId.trim();
  const target = targetId.trim();
  let changed = false;
  const next = steps.map((step) => {
    if (step.id !== target) return step;
    const dependencies = parseDependencies(step.dependsOn);
    const filtered = dependencies.filter((dependency) => dependency !== source);
    if (filtered.length === dependencies.length) return step;
    changed = true;
    const graphEdgeMetadata = step.graphEdgeMetadata && typeof step.graphEdgeMetadata === "object"
      ? compactGraphEdgeMetadata(Object.fromEntries(
        Object.entries(step.graphEdgeMetadata).filter(([metadataSource]) => metadataSource !== source),
      ))
      : undefined;
    return { ...step, dependsOn: formatDependencies(filtered), graphEdgeMetadata };
  });
  return changed ? next : steps;
}

export function renameWorkflowStep<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepId: string,
  nextStepId: string,
): TStep[] {
  const currentId = stepId.trim();
  const nextId = nextStepId.trim();
  if (!currentId || !nextId || currentId === nextId) return steps;
  const sourceIndex = steps.findIndex((step) => step.id.trim() === currentId);
  if (sourceIndex < 0) return steps;
  if (steps.some((step, index) => index !== sourceIndex && step.id.trim() === nextId)) {
    throw new Error(`Workflow step "${nextId}" already exists.`);
  }

  return steps.map((step, index) => {
    const dependencies = parseDependencies(step.dependsOn);
    const renamedDependencies = dependencies.map((dependency) => dependency === currentId ? nextId : dependency);
    const graphEdgeMetadata = step.graphEdgeMetadata && typeof step.graphEdgeMetadata === "object"
      ? compactGraphEdgeMetadata(Object.fromEntries(
        Object.entries(step.graphEdgeMetadata).map(([metadataSource, metadata]) => [
          metadataSource === currentId ? nextId : metadataSource,
          metadata,
        ]),
      ))
      : undefined;
    const renamedStep = index === sourceIndex ? { ...step, id: nextId } : step;
    const dependenciesChanged = renamedDependencies.some((dependency, dependencyIndex) => dependency !== dependencies[dependencyIndex]);
    const metadataChanged = graphEdgeMetadata !== step.graphEdgeMetadata;
    if (!dependenciesChanged && !metadataChanged && renamedStep === step) return step;
    return {
      ...renamedStep,
      ...(dependenciesChanged ? { dependsOn: formatDependencies(renamedDependencies) } : {}),
      ...(metadataChanged ? { graphEdgeMetadata } : {}),
    };
  });
}

export function duplicateWorkflowStep<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepId: string,
): TStep[] {
  const id = stepId.trim();
  if (!id) return steps;
  const sourceIndex = steps.findIndex((step) => step.id.trim() === id);
  if (sourceIndex < 0) return steps;
  const sourceStep = steps[sourceIndex]!;
  const copyId = nextUniqueStepId(steps, `${id}-copy`);
  const sourceTitle = typeof sourceStep.title === "string" ? sourceStep.title.trim() : "";
  const copy = {
    ...clearGraphRunOverlay(sourceStep),
    id: copyId,
    title: sourceTitle ? `${sourceTitle} copy` : `${copyId}`,
  } as unknown as TStep;
  return [...steps.slice(0, sourceIndex + 1), copy, ...steps.slice(sourceIndex + 1)];
}

export function duplicateWorkflowContainer<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  containerId: string,
): TStep[] {
  const id = containerId.trim();
  if (!id) return steps;
  const graph = buildWorkflowGraphModel(steps);
  const container = graph.containers.find((candidate) => candidate.id === id);
  if (!container || container.stepIds.length === 0) return steps;

  const stepIdSet = new Set(container.stepIds);
  const sourceIndexes = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => stepIdSet.has(step.id.trim()));
  if (sourceIndexes.length === 0) return steps;

  const existingIds = new Set(steps.map((step) => step.id.trim()).filter(Boolean));
  const allocateStepId = (baseId: string): string => {
    const normalizedBaseId = baseId.trim() || "step";
    let candidate = normalizedBaseId;
    let index = 2;
    while (existingIds.has(candidate)) {
      candidate = `${normalizedBaseId}-${index}`;
      index += 1;
    }
    existingIds.add(candidate);
    return candidate;
  };

  const existingContainerIds = new Set(steps
    .map((step) => typeof step.graphContainerId === "string" ? step.graphContainerId.trim() : "")
    .filter(Boolean));
  let copiedContainerId = `${id}-copy`;
  let copiedContainerIndex = 2;
  while (existingContainerIds.has(copiedContainerId)) {
    copiedContainerId = `${id}-copy-${copiedContainerIndex}`;
    copiedContainerIndex += 1;
  }
  const idMap = new Map<string, string>();
  for (const { step } of sourceIndexes) {
    idMap.set(step.id, allocateStepId(`${step.id}-copy`));
  }

  const copiedTitle = container.title.trim() ? `${container.title.trim()} copy` : copiedContainerId;
  const copies = sourceIndexes.map(({ step }) => {
    const copyId = idMap.get(step.id) ?? `${step.id}-copy`;
    const copiedDependencies = parseDependencies(step.dependsOn).map((dependency) => idMap.get(dependency) ?? dependency);
    const graphEdgeMetadata = step.graphEdgeMetadata && typeof step.graphEdgeMetadata === "object"
      ? compactGraphEdgeMetadata(Object.fromEntries(
        Object.entries(step.graphEdgeMetadata).map(([sourceId, metadata]) => [
          idMap.get(sourceId) ?? sourceId,
          metadata,
        ]),
      ))
      : undefined;
    const title = typeof step.title === "string" && step.title.trim() ? `${step.title.trim()} copy` : copyId;
    return {
      ...clearGraphRunOverlay(step),
      id: copyId,
      title,
      dependsOn: formatDependencies(copiedDependencies),
      graphEdgeMetadata,
      graphContainerId: copiedContainerId,
      graphContainerTitle: copiedTitle,
    } as unknown as TStep;
  });

  const insertAfterIndex = Math.max(...sourceIndexes.map(({ index }) => index));
  return [...steps.slice(0, insertAfterIndex + 1), ...copies, ...steps.slice(insertAfterIndex + 1)];
}

export function removeWorkflowStep<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepId: string,
): TStep[] {
  const id = stepId.trim();
  if (!id || !steps.some((step) => step.id.trim() === id)) return steps;
  return steps
    .filter((step) => step.id.trim() !== id)
    .map((step) => {
      const dependencies = parseDependencies(step.dependsOn);
      const filteredDependencies = dependencies.filter((dependency) => dependency !== id);
      const graphEdgeMetadata = step.graphEdgeMetadata && typeof step.graphEdgeMetadata === "object"
        ? compactGraphEdgeMetadata(Object.fromEntries(
          Object.entries(step.graphEdgeMetadata).filter(([metadataSource]) => metadataSource !== id),
        ))
        : undefined;
      if (filteredDependencies.length === dependencies.length && graphEdgeMetadata === step.graphEdgeMetadata) {
        return step;
      }
      return {
        ...step,
        dependsOn: formatDependencies(filteredDependencies),
        graphEdgeMetadata,
      };
    });
}

export function updateGraphEdgeMetadata<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  sourceId: string,
  targetId: string,
  patch: WorkflowGraphEdgeMetadataInput,
): TStep[] {
  const source = sourceId.trim();
  const target = targetId.trim();
  if (!source || !target) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (step.id !== target) return step;
    if (!parseDependencies(step.dependsOn).includes(source)) return step;
    const current = step.graphEdgeMetadata && typeof step.graphEdgeMetadata === "object"
      ? step.graphEdgeMetadata
      : {};
    const merged = compactGraphEdgeMetadata({
      ...current,
      [source]: {
        kind: patch.kind ?? current[source]?.kind,
        label: patch.label ?? current[source]?.label,
        condition: patch.condition ?? current[source]?.condition,
      },
    });
    changed = true;
    return { ...step, graphEdgeMetadata: merged };
  });
  return changed ? next : steps;
}

export function applyWorkflowGraphFailureRoute<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  sourceStepIds: string[],
  handlerStepId: string,
  options: WorkflowGraphFailureRouteOptions = {},
): TStep[] {
  const summary = buildWorkflowGraphFailureRouteSummary(steps, sourceStepIds, handlerStepId, options);
  if (summary.blocked) return steps;

  let next = steps;
  for (const sourceId of summary.sourceStepIds) {
    next = connectSteps(next, sourceId, summary.handlerStepId);
    next = updateGraphEdgeMetadata(next, sourceId, summary.handlerStepId, {
      kind: "failure",
      label: summary.label,
      condition: summary.condition,
    });
  }

  const handlerScope = options.handlerScope?.trim() || "selected-path";
  const handlerInput = options.handlerInput?.trim() || "";
  return next.map((step) => {
    const stepId = step.id.trim();
    if (summary.sourceStepIds.includes(stepId)) {
      return {
        ...step,
        onFailure: "handler",
      };
    }
    if (stepId === summary.handlerStepId) {
      return {
        ...step,
        graphErrorHandler: true,
        graphErrorHandlerScope: handlerScope,
        ...(handlerInput ? { graphErrorHandlerInput: handlerInput } : {}),
      };
    }
    return step;
  });
}

export function appendStepAfter<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  afterStepId: string | null,
): TStep[] {
  const existingIds = new Set(steps.map((step) => step.id));
  let index = steps.length + 1;
  let id = `step-${index}`;
  while (existingIds.has(id)) {
    index += 1;
    id = `step-${index}`;
  }

  const afterIndex = afterStepId ? steps.findIndex((step) => step.id === afterStepId) : -1;
  const insertAt = afterIndex >= 0 ? afterIndex + 1 : steps.length;
  const newStep = {
    id,
    title: "New step",
    description: "",
    type: "agent",
    toolName: "",
    toolArgs: "{}",
    agentName: "",
    tools: "",
    dependsOn: afterIndex >= 0 ? steps[afterIndex]!.id : "",
    onFailure: "",
    graphApprovalRequired: false,
    graphApprovalPrompt: "",
    graphApprovalRecipients: "",
    graphApprovalTimeoutSeconds: "",
    graphApprovalTimeoutAction: "",
    graphGroupId: "",
    graphGroupTitle: "",
    graphGroupColor: "#64748b",
    graphGroupCollapsed: false,
    graphContainerId: "",
    graphContainerType: "branch",
    graphContainerTitle: "",
    graphContainerDescription: "",
    graphContainerMode: "branch-one",
    graphContainerCondition: "",
    graphContainerIterator: "",
    graphContainerSkipFailure: false,
    graphContainerRunInParallel: false,
    graphContainerParallelism: "",
    graphRunStatus: "planned",
    graphRunIssueIdentifier: "",
    graphRunUpdatedAt: "",
    graphRunSummary: "",
    graphNote: "",
    graphEdgeMetadata: {},
    extra: {},
  } as unknown as TStep;

  return [...steps.slice(0, insertAt), newStep, ...steps.slice(insertAt)];
}

function workflowPaletteTemplate(
  kind: WorkflowGraphPaletteNodeKind,
  id: string,
  dependsOn: string,
): Record<string, unknown> {
  const base = {
    id,
    title: "Agent step",
    description: "",
    type: "agent",
    toolName: "",
    toolArgs: "{}",
    agentName: "",
    tools: "",
    dependsOn,
    onFailure: "",
    graphApprovalRequired: false,
    graphApprovalPrompt: "",
    graphApprovalRecipients: "",
    graphApprovalTimeoutSeconds: "",
    graphApprovalTimeoutAction: "",
    graphGroupId: "",
    graphGroupTitle: "",
    graphGroupColor: "#64748b",
    graphGroupCollapsed: false,
    graphContainerId: "",
    graphContainerType: "branch",
    graphContainerTitle: "",
    graphContainerDescription: "",
    graphContainerMode: "branch-one",
    graphContainerCondition: "",
    graphContainerIterator: "",
    graphContainerSkipFailure: false,
    graphContainerRunInParallel: false,
    graphContainerParallelism: "",
    graphRunStatus: "planned",
    graphRunIssueIdentifier: "",
    graphRunUpdatedAt: "",
    graphRunSummary: "",
    graphNote: "",
    graphEdgeMetadata: {},
    extra: {},
  };

  if (kind === "tool") {
    return {
      ...base,
      title: "Tool step",
      type: "tool",
    };
  }

  if (kind === "if") {
    return {
      ...base,
      title: "IF",
      type: "if",
      conditionGroup: cloneWorkflowConditionGroup(defaultIfConditionGroup),
      completionReason: "",
    };
  }

  if (kind === "complete") {
    return {
      ...base,
      title: "Complete",
      type: "complete",
      dependsOn: "",
      completionReason: "",
    };
  }

  if (kind === "branch") {
    return {
      ...base,
      title: "Branch",
      graphContainerId: `${id}-branch`,
      graphContainerType: "branch",
      graphContainerTitle: "Branch",
      graphContainerMode: "branch-one",
    };
  }

  if (kind === "loop") {
    return {
      ...base,
      title: "Loop",
      graphContainerId: `${id}-loop`,
      graphContainerType: "loop",
      graphContainerTitle: "Loop",
      graphContainerMode: "for-each",
      graphContainerIterator: "result.items",
      graphContainerRunInParallel: true,
      graphContainerParallelism: 4,
    };
  }

  if (kind === "failure-handler") {
    return {
      ...base,
      title: "Failure handler",
      onFailure: "escalate",
      graphEdgeMetadata: dependsOn
        ? {
          [dependsOn]: {
            kind: "failure",
            label: "failure",
            condition: "upstream step failed",
          },
        }
        : {},
    };
  }

  if (kind === "approval") {
    return {
      ...base,
      title: "Approval gate",
      graphApprovalRequired: true,
      graphApprovalPrompt: "Review and approve before continuing.",
      graphApprovalTimeoutAction: "cancel",
    };
  }

  return base;
}

export function insertWorkflowStepFromPalette<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  afterStepId: string | null,
  kind: WorkflowGraphPaletteNodeKind,
): TStep[] {
  const baseId = kind === "failure-handler" ? "failure-handler" : kind;
  const id = nextUniqueStepId(steps, baseId);
  const afterIndex = afterStepId ? steps.findIndex((step) => step.id.trim() === afterStepId.trim()) : -1;
  const insertAt = afterIndex >= 0 ? afterIndex + 1 : steps.length;
  const dependencyId = afterIndex >= 0 ? steps[afterIndex]!.id.trim() : "";
  const newStep = workflowPaletteTemplate(kind, id, dependencyId) as unknown as TStep;

  const next = [
    ...steps.slice(0, insertAt),
    newStep,
    ...steps.slice(insertAt),
  ];
  if (!dependencyId || kind === "if" || kind === "complete") return next;

  return next.map((step) => {
    if (step.id === id) return step;
    const dependencies = parseDependencies(step.dependsOn);
    if (!dependencies.includes(dependencyId)) return step;
    const rewiredDependencies = dependencies.map((dependency) => dependency === dependencyId ? id : dependency);
    const existingMetadata = step.graphEdgeMetadata && typeof step.graphEdgeMetadata === "object"
      ? step.graphEdgeMetadata
      : {};
    const rewiredMetadata = compactGraphEdgeMetadata(Object.fromEntries(
      Object.entries(existingMetadata).map(([sourceId, metadata]) => [
        sourceId === dependencyId ? id : sourceId,
        metadata,
      ]),
    ));
    return {
      ...step,
      dependsOn: formatDependencies(rewiredDependencies),
      graphEdgeMetadata: rewiredMetadata,
    };
  });
}

export {
  clearGraphRunOverlay,
};

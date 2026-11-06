// Builds the renderable workflow graph model (nodes, edges, layers, issues) from raw steps.
// Split out of workflow-graph.ts (pure move, function body unchanged).

import { readBooleanSetting, readPositiveInteger, readStepAdvanced, readStepDataFlow, readStepExecution, readStepResources, readStepTesting } from "./workflow-graph-step-metadata.js";
import { buildContainerBadges, buildStepMap, conditionalGraphEdgeMetadata, normalizeGraphContainerMode, readForwardConditionalDependencies, readGraphEdgeMetadata, readGraphPositionValue, readStepRunStatus } from "./workflow-graph-step-runtime.js";
import type { WorkflowGraphStep } from "./workflow-graph-types-core.js";
import type { WorkflowGraphContainerType, WorkflowGraphDiagnostics, WorkflowGraphEdge, WorkflowGraphGroup, WorkflowGraphIssue, WorkflowGraphNode } from "./workflow-graph-types-model.js";
import type { WorkflowGraphModel } from "./workflow-graph-types-test.js";
import { parseDependencies } from "./workflow-graph-dependencies.js";

export function buildWorkflowGraphModel<TStep extends WorkflowGraphStep>(
  steps: TStep[],
): WorkflowGraphModel<TStep> {
  const stepMap = buildStepMap(steps);
  const issuesById = new Map<string, WorkflowGraphIssue>();
  const layerMemo = new Map<string, number>();
  const visiting = new Set<string>();

  function addIssue(issue: WorkflowGraphIssue): void {
    if (!issuesById.has(issue.id)) issuesById.set(issue.id, issue);
  }

  const edges: WorkflowGraphEdge[] = [];
  for (const step of steps) {
    const target = step.id.trim();
    if (!target) {
      addIssue({
        id: `missing-step-id:${steps.indexOf(step)}`,
        severity: "error",
        code: "missing-step-id",
        message: "A step is missing an id.",
      });
      continue;
    }
    for (const source of parseDependencies(step.dependsOn)) {
      if (!stepMap.has(source)) {
        addIssue({
          id: `missing-dependency:${source}->${target}`,
          severity: "error",
          code: "missing-dependency",
          message: `Step "${target}" depends on missing step "${source}".`,
          stepId: target,
          sourceId: source,
          targetId: target,
        });
        continue;
      }
      edges.push({
        id: `${source}->${target}`,
        source,
        target,
        ...readGraphEdgeMetadata(step, source),
      });
    }
    for (const edge of readForwardConditionalDependencies(step)) {
      if (!stepMap.has(edge.stepId)) {
        addIssue({
          id: `missing-conditional-dependency:${edge.stepId}->${target}:${edge.when}`,
          severity: "error",
          code: "missing-dependency",
          message: `Step "${target}" has a conditional dependency on missing step "${edge.stepId}".`,
          stepId: target,
          sourceId: edge.stepId,
          targetId: target,
        });
        continue;
      }
      edges.push({
        id: `${edge.stepId}->${target}:${edge.when}`,
        source: edge.stepId,
        target,
        when: edge.when,
        ...conditionalGraphEdgeMetadata(edge.when),
      });
    }
  }

  function computeLayer(stepId: string): number {
    const cached = layerMemo.get(stepId);
    if (cached !== undefined) return cached;
    if (visiting.has(stepId)) {
      addIssue({
        id: `cycle:${stepId}`,
        severity: "error",
        code: "cycle",
        message: `Cycle detected near step "${stepId}".`,
        stepId,
      });
      return 0;
    }
    visiting.add(stepId);
    const step = stepMap.get(stepId);
    const dependencies = step
      ? Array.from(new Set([
        ...parseDependencies(step.dependsOn),
        ...readForwardConditionalDependencies(step).map((edge) => edge.stepId),
      ])).filter((dependency) => stepMap.has(dependency))
      : [];
    const layer = dependencies.length === 0
      ? 0
      : Math.max(...dependencies.map((dependency) => computeLayer(dependency))) + 1;
    visiting.delete(stepId);
    layerMemo.set(stepId, layer);
    return layer;
  }

  const layerCounts = new Map<number, number>();
  const nodes = steps.map((step, order) => {
    const id = step.id.trim();
    const layer = id ? computeLayer(id) : 0;
    const layerOrder = layerCounts.get(layer) ?? 0;
    layerCounts.set(layer, layerOrder + 1);
    const defaultX = 48 + layer * 230;
    const defaultY = 44 + layerOrder * 132;
    return {
      id,
      label: (typeof step.title === "string" && step.title.trim()) ? step.title.trim() : id || "Untitled step",
      kind: typeof step.type === "string" && step.type.trim() ? step.type.trim() : "agent",
      layer,
      order,
      x: readGraphPositionValue(step.graphPositionX) ?? defaultX,
      y: readGraphPositionValue(step.graphPositionY) ?? defaultY,
      step,
      runStatus: readStepRunStatus(step),
      advanced: readStepAdvanced(step),
      testing: readStepTesting(step),
      execution: readStepExecution(step),
      dataFlow: readStepDataFlow(step),
      resources: readStepResources(step),
    };
  });

  const incomingStepIds = new Set(edges.map((edge) => edge.target));
  const outgoingStepIds = new Set(edges.map((edge) => edge.source));
  const entryStepIds = nodes.map((node) => node.id).filter((id) => id && !incomingStepIds.has(id));
  const terminalStepIds = nodes.map((node) => node.id).filter((id) => id && !outgoingStepIds.has(id));
  const issues = Array.from(issuesById.values());
  const diagnostics: WorkflowGraphDiagnostics = {
    entryStepIds,
    terminalStepIds,
    issueCountBySeverity: {
      error: issues.filter((issue) => issue.severity === "error").length,
      warning: issues.filter((issue) => issue.severity === "warning").length,
      info: issues.filter((issue) => issue.severity === "info").length,
    },
    issues,
  };
  const warnings = diagnostics.issues.map((issue) => issue.message);

  const groupsById = new Map<string, Array<WorkflowGraphNode<TStep>>>();
  for (const node of nodes) {
    const groupId = typeof node.step.graphGroupId === "string" ? node.step.graphGroupId.trim() : "";
    if (!groupId) continue;
    const groupNodes = groupsById.get(groupId) ?? [];
    groupNodes.push(node);
    groupsById.set(groupId, groupNodes);
  }

  const groups = Array.from(groupsById.entries()).map(([id, groupNodes]) => {
    const firstStep = groupNodes[0]?.step;
    const minX = Math.min(...groupNodes.map((node) => node.x));
    const minY = Math.min(...groupNodes.map((node) => node.y));
    const maxX = Math.max(...groupNodes.map((node) => node.x + 172));
    const maxY = Math.max(...groupNodes.map((node) => node.y + 76));
    const title = typeof firstStep?.graphGroupTitle === "string" && firstStep.graphGroupTitle.trim()
      ? firstStep.graphGroupTitle.trim()
      : id;
    const color = typeof firstStep?.graphGroupColor === "string" && firstStep.graphGroupColor.trim()
      ? firstStep.graphGroupColor.trim()
      : "#64748b";
    const collapsedByDefault = groupNodes.some((node) => readBooleanSetting(node.step.graphGroupCollapsedByDefault) === true);
    const collapsedOverride = groupNodes
      .map((node) => readBooleanSetting(node.step.graphGroupCollapsed))
      .find((value): value is boolean => value !== undefined);
    const collapsed = collapsedOverride ?? collapsedByDefault;
    return {
      id,
      title,
      color,
      collapsed,
      collapsedByDefault,
      stepIds: groupNodes.map((node) => node.id),
      x: minX - 18,
      y: minY - 32,
      width: maxX - minX + 36,
      height: maxY - minY + 54,
    };
  });

  const containersById = new Map<string, Array<WorkflowGraphNode<TStep>>>();
  for (const node of nodes) {
    const containerId = typeof node.step.graphContainerId === "string" ? node.step.graphContainerId.trim() : "";
    if (!containerId) continue;
    const containerNodes = containersById.get(containerId) ?? [];
    containerNodes.push(node);
    containersById.set(containerId, containerNodes);
  }

  const containers = Array.from(containersById.entries()).map(([id, containerNodes]) => {
    const firstStep = containerNodes[0]?.step;
    const rawType = typeof firstStep?.graphContainerType === "string" ? firstStep.graphContainerType.trim() : "";
    const type: WorkflowGraphContainerType = rawType === "loop" ? "loop" : "branch";
    const minX = Math.min(...containerNodes.map((node) => node.x));
    const minY = Math.min(...containerNodes.map((node) => node.y));
    const maxX = Math.max(...containerNodes.map((node) => node.x + 172));
    const maxY = Math.max(...containerNodes.map((node) => node.y + 76));
    const title = typeof firstStep?.graphContainerTitle === "string" && firstStep.graphContainerTitle.trim()
      ? firstStep.graphContainerTitle.trim()
      : id;
    const description = typeof firstStep?.graphContainerDescription === "string"
      ? firstStep.graphContainerDescription.trim()
      : "";
    const mode = normalizeGraphContainerMode(type, firstStep?.graphContainerMode);
    const condition = typeof firstStep?.graphContainerCondition === "string"
      ? firstStep.graphContainerCondition.trim()
      : "";
    const iterator = typeof firstStep?.graphContainerIterator === "string"
      ? firstStep.graphContainerIterator.trim()
      : "";
    const skipFailure = readBooleanSetting(firstStep?.graphContainerSkipFailure) === true;
    const runInParallel = readBooleanSetting(firstStep?.graphContainerRunInParallel) === true;
    const parallelism = readPositiveInteger(firstStep?.graphContainerParallelism);
    return {
      id,
      type,
      title,
      description,
      mode,
      condition,
      iterator,
      skipFailure,
      runInParallel,
      parallelism,
      badges: buildContainerBadges({
        type,
        mode,
        condition,
        iterator,
        skipFailure,
        runInParallel,
        parallelism,
      }),
      stepIds: containerNodes.map((node) => node.id),
      x: minX - 32,
      y: minY - 54,
      width: maxX - minX + 64,
      height: maxY - minY + 86,
    };
  });

  const collapsedGroupByStepId = new Map<string, WorkflowGraphGroup>();
  for (const group of groups) {
    if (!group.collapsed) continue;
    for (const stepId of group.stepIds) collapsedGroupByStepId.set(stepId, group);
  }

  if (collapsedGroupByStepId.size === 0) {
    return { nodes, edges, groups, containers, warnings: Array.from(new Set(warnings)), diagnostics };
  }

  const visibleNodes: Array<WorkflowGraphNode<TStep>> = [];
  const emittedCollapsedGroups = new Set<string>();
  for (const node of nodes) {
    const collapsedGroup = collapsedGroupByStepId.get(node.id);
    if (!collapsedGroup) {
      visibleNodes.push(node);
      continue;
    }
    if (emittedCollapsedGroups.has(collapsedGroup.id)) continue;
    emittedCollapsedGroups.add(collapsedGroup.id);
    visibleNodes.push({
      id: `group:${collapsedGroup.id}`,
      label: collapsedGroup.title,
      kind: "group",
      layer: node.layer,
      order: node.order,
      x: collapsedGroup.x + 18,
      y: collapsedGroup.y + 32,
      step: node.step,
      runStatus: readStepRunStatus(node.step),
      advanced: readStepAdvanced(node.step),
      testing: readStepTesting(node.step),
      execution: readStepExecution(node.step),
      dataFlow: readStepDataFlow(node.step),
      resources: readStepResources(node.step),
    });
  }

  const visibleEdgesById = new Map<string, WorkflowGraphEdge>();
  for (const edge of edges) {
    const sourceGroup = collapsedGroupByStepId.get(edge.source);
    const targetGroup = collapsedGroupByStepId.get(edge.target);
    const source = sourceGroup ? `group:${sourceGroup.id}` : edge.source;
    const target = targetGroup ? `group:${targetGroup.id}` : edge.target;
    if (source === target) continue;
    const id = `${source}->${target}`;
    if (visibleEdgesById.has(id)) continue;
    visibleEdgesById.set(id, { ...edge, id, source, target });
  }

  return {
    nodes: visibleNodes,
    edges: Array.from(visibleEdgesById.values()),
    groups,
    containers,
    warnings: Array.from(new Set(warnings)),
    diagnostics,
  };
}

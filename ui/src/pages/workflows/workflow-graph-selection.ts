// Workflow graph selection, container and data-flow view models.
// Split out of workflow-graph.ts (pure move, function bodies unchanged).

import type { WorkflowGraphStep } from "./workflow-graph-types-core.js";
import type { WorkflowGraphContainerSummary, WorkflowGraphDataFlowMap, WorkflowGraphDataFlowResultRef, WorkflowGraphSelectionMode, WorkflowGraphSelectionSummary } from "./workflow-graph-types-model.js";
import { buildWorkflowGraphModel } from "./workflow-graph-model-build.js";

function collectExpressionRefs(expression: string, prefixes: string[]): string[] {
  const values: string[] = [];
  for (const prefix of prefixes) {
    const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matcher = new RegExp(`\\b${escapedPrefix}\\.([A-Za-z0-9_-]+)`, "g");
    for (const match of expression.matchAll(matcher)) {
      const value = (match[1] ?? "").trim();
      if (value) values.push(value);
    }
  }
  return Array.from(new Set(values));
}

function collectResultRefs(expression: string, availableStepIds: Set<string>): WorkflowGraphDataFlowResultRef[] {
  const refs: WorkflowGraphDataFlowResultRef[] = [];
  const seen = new Set<string>();
  for (const match of expression.matchAll(/\b([A-Za-z0-9_-]+)\.result(?:\.([A-Za-z0-9_.-]+))?/g)) {
    const stepId = (match[1] ?? "").trim();
    if (!stepId) continue;
    const path = (match[2] ?? "").trim();
    const key = `${stepId}:${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({
      stepId,
      path,
      available: availableStepIds.has(stepId),
    });
  }
  return refs;
}

function countBadge(count: number, label: string): string | null {
  if (count <= 0) return null;
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

export function buildWorkflowGraphDataFlowMap<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepId: string,
): WorkflowGraphDataFlowMap {
  const normalizedStepId = stepId.trim();
  const graph = buildWorkflowGraphModel(steps);
  const node = graph.nodes.find((candidate) => candidate.id === normalizedStepId);
  if (!node) {
    return {
      stepId: normalizedStepId,
      title: normalizedStepId,
      inputExpression: "",
      flowInputRefs: [],
      resultRefs: [],
      upstreamStepIds: [],
      missingStepIds: [],
      resourceRefs: [],
      secretRefs: [],
      outputContractBadges: [],
      blocked: true,
      badges: ["Missing step", "Blocked"],
      summary: "Choose an existing step to inspect its input transform.",
    };
  }

  const availableStepIds = new Set(graph.nodes.map((candidate) => candidate.id).filter((id) => id && id !== node.id));
  const inputExpression = node.dataFlow.inputExpression;
  const resultRefs = collectResultRefs(inputExpression, availableStepIds);
  const upstreamStepIds = Array.from(new Set(resultRefs.filter((ref) => ref.available).map((ref) => ref.stepId)));
  const missingStepIds = Array.from(new Set(resultRefs.filter((ref) => !ref.available).map((ref) => ref.stepId)));
  const flowInputRefs = collectExpressionRefs(inputExpression, ["flow_input", "flowInput", "inputs", "args"]);
  const resourceRefs = Array.from(new Set([
    ...node.resources.resourceRefs,
    ...collectExpressionRefs(inputExpression, ["resources", "resource"]),
  ]));
  const secretRefs = Array.from(new Set([
    ...node.resources.secretRefs,
    ...collectExpressionRefs(inputExpression, ["secrets", "secret", "vars"]),
  ]));
  const outputContractBadges = node.dataFlow.badges.filter((badge) => badge !== "Input map");
  const badges = [
    countBadge(flowInputRefs.length, "flow input"),
    countBadge(upstreamStepIds.length, "upstream result"),
    countBadge(resourceRefs.length, "resource"),
    countBadge(secretRefs.length, "secret"),
    countBadge(missingStepIds.length, "missing step"),
  ].filter((badge): badge is string => Boolean(badge));
  const blocked = missingStepIds.length > 0;
  if (blocked) badges.push("Blocked");
  if (badges.length === 0) badges.push("No input transform");
  const sourceParts = [
    countBadge(flowInputRefs.length, "flow input"),
    countBadge(upstreamStepIds.length, "upstream result"),
    countBadge(resourceRefs.length, "resource"),
    countBadge(secretRefs.length, "secret"),
  ].filter((part): part is string => Boolean(part));
  const summary = sourceParts.length > 0
    ? `${node.id} maps ${sourceParts.slice(0, -1).join(", ")}${sourceParts.length > 1 ? ", and " : ""}${sourceParts.at(-1)} into its step input${blocked ? `, but ${missingStepIds.length} referenced step${missingStepIds.length === 1 ? "" : "s"} are missing` : ""}.`
    : `${node.id} does not declare an input transform.`;

  return {
    stepId: node.id,
    title: node.label,
    inputExpression,
    flowInputRefs,
    resultRefs,
    upstreamStepIds,
    missingStepIds,
    resourceRefs,
    secretRefs,
    outputContractBadges,
    blocked,
    badges,
    summary,
  };
}

export function buildWorkflowGraphContainerSummary<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  containerId: string,
): WorkflowGraphContainerSummary {
  const normalizedContainerId = containerId.trim();
  const graph = buildWorkflowGraphModel(steps);
  const container = graph.containers.find((candidate) => candidate.id === normalizedContainerId);
  if (!container) {
    return {
      id: normalizedContainerId,
      type: "branch",
      title: normalizedContainerId,
      description: "",
      mode: "",
      stepIds: [],
      entryStepIds: [],
      terminalStepIds: [],
      inboundStepIds: [],
      outboundStepIds: [],
      badges: ["Missing container", "Blocked"],
      blocked: true,
      summary: "Choose an existing branch or loop container to inspect its graph boundary.",
    };
  }

  const stepIdSet = new Set(container.stepIds);
  const incomingByStepId = new Map<string, string[]>();
  const outgoingByStepId = new Map<string, string[]>();
  const inboundStepIds: string[] = [];
  const outboundStepIds: string[] = [];
  for (const edge of graph.edges) {
    const sourceInside = stepIdSet.has(edge.source);
    const targetInside = stepIdSet.has(edge.target);
    if (sourceInside && targetInside) {
      const outgoing = outgoingByStepId.get(edge.source) ?? [];
      outgoing.push(edge.target);
      outgoingByStepId.set(edge.source, outgoing);
      const incoming = incomingByStepId.get(edge.target) ?? [];
      incoming.push(edge.source);
      incomingByStepId.set(edge.target, incoming);
    } else if (!sourceInside && targetInside) {
      inboundStepIds.push(edge.source);
    } else if (sourceInside && !targetInside) {
      outboundStepIds.push(edge.target);
    }
  }

  const entryStepIds = container.stepIds.filter((stepId) => !incomingByStepId.has(stepId));
  const terminalStepIds = container.stepIds.filter((stepId) => !outgoingByStepId.has(stepId));
  const uniqueInboundStepIds = Array.from(new Set(inboundStepIds));
  const uniqueOutboundStepIds = Array.from(new Set(outboundStepIds));
  const badges = [
    ...container.badges,
    countBadge(container.stepIds.length, "step"),
    countBadge(uniqueInboundStepIds.length, "inbound"),
    countBadge(uniqueOutboundStepIds.length, "outbound"),
  ].filter((badge): badge is string => Boolean(badge));
  const entryText = entryStepIds.length > 0 ? entryStepIds.join(", ") : "no internal entry";
  const terminalText = terminalStepIds.length > 0 ? terminalStepIds.join(", ") : "no internal terminal";
  const summary = `${container.title} contains ${container.stepIds.length} step${container.stepIds.length === 1 ? "" : "s"} from ${entryText} to ${terminalText}, receives ${uniqueInboundStepIds.length} inbound step${uniqueInboundStepIds.length === 1 ? "" : "s"}, and hands off to ${uniqueOutboundStepIds.length} outbound step${uniqueOutboundStepIds.length === 1 ? "" : "s"}.`;

  return {
    id: container.id,
    type: container.type,
    title: container.title,
    description: container.description,
    mode: container.mode,
    stepIds: container.stepIds,
    entryStepIds,
    terminalStepIds,
    inboundStepIds: uniqueInboundStepIds,
    outboundStepIds: uniqueOutboundStepIds,
    badges,
    blocked: false,
    summary,
  };
}

export function expandWorkflowGraphSelection<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  seedStepIds: string[],
  mode: WorkflowGraphSelectionMode,
): string[] {
  const graph = buildWorkflowGraphModel(steps);
  const graphStepIds = new Set(graph.nodes.map((node) => node.id).filter(Boolean));
  const selectedStepIds = new Set(seedStepIds.map((stepId) => stepId.trim()).filter((stepId) => graphStepIds.has(stepId)));
  if (selectedStepIds.size === 0) return [];

  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  }

  const visit = (frontier: string[], adjacency: Map<string, string[]>): void => {
    const queue = [...frontier];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;
      for (const next of adjacency.get(current) ?? []) {
        if (selectedStepIds.has(next)) continue;
        selectedStepIds.add(next);
        queue.push(next);
      }
    }
  };

  const seeds = Array.from(selectedStepIds);
  if (mode === "upstream" || mode === "connected") visit(seeds, incoming);
  if (mode === "downstream" || mode === "connected") visit(seeds, outgoing);

  return graph.nodes.map((node) => node.id).filter((stepId) => selectedStepIds.has(stepId));
}

export function buildWorkflowGraphSelectionSummary<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  selectedStepIds: string[],
): WorkflowGraphSelectionSummary {
  const graph = buildWorkflowGraphModel(steps);
  const selectedStepIdSet = new Set(selectedStepIds.map((stepId) => stepId.trim()).filter(Boolean));
  const stepIds = graph.nodes.map((node) => node.id).filter((stepId) => selectedStepIdSet.has(stepId));
  if (stepIds.length === 0) {
    return {
      stepIds: [],
      entryStepIds: [],
      terminalStepIds: [],
      inboundStepIds: [],
      outboundStepIds: [],
      badges: ["No selection", "Blocked"],
      blocked: true,
      summary: "Select one or more graph steps to inspect bulk action boundaries.",
    };
  }

  const stepIdSet = new Set(stepIds);
  const incomingByStepId = new Map<string, string[]>();
  const outgoingByStepId = new Map<string, string[]>();
  const inboundStepIds: string[] = [];
  const outboundStepIds: string[] = [];
  for (const edge of graph.edges) {
    const sourceInside = stepIdSet.has(edge.source);
    const targetInside = stepIdSet.has(edge.target);
    if (sourceInside && targetInside) {
      outgoingByStepId.set(edge.source, [...(outgoingByStepId.get(edge.source) ?? []), edge.target]);
      incomingByStepId.set(edge.target, [...(incomingByStepId.get(edge.target) ?? []), edge.source]);
    } else if (!sourceInside && targetInside) {
      inboundStepIds.push(edge.source);
    } else if (sourceInside && !targetInside) {
      outboundStepIds.push(edge.target);
    }
  }

  const entryStepIds = stepIds.filter((stepId) => !incomingByStepId.has(stepId));
  const terminalStepIds = stepIds.filter((stepId) => !outgoingByStepId.has(stepId));
  const uniqueInboundStepIds = Array.from(new Set(inboundStepIds));
  const uniqueOutboundStepIds = Array.from(new Set(outboundStepIds));
  const badges = [
    stepIds.length > 0 ? `${stepIds.length} selected` : undefined,
    countBadge(uniqueInboundStepIds.length, "inbound"),
    countBadge(uniqueOutboundStepIds.length, "outbound"),
  ].filter((badge): badge is string => Boolean(badge));
  const entryText = entryStepIds.length > 0 ? entryStepIds.join(", ") : "no internal entry";
  const terminalText = terminalStepIds.length > 0 ? terminalStepIds.join(", ") : "no internal terminal";
  const summary = `Selection contains ${stepIds.length} step${stepIds.length === 1 ? "" : "s"} from ${entryText} to ${terminalText}, receives ${uniqueInboundStepIds.length} inbound step${uniqueInboundStepIds.length === 1 ? "" : "s"}, and hands off to ${uniqueOutboundStepIds.length} outbound step${uniqueOutboundStepIds.length === 1 ? "" : "s"}.`;

  return {
    stepIds,
    entryStepIds,
    terminalStepIds,
    inboundStepIds: uniqueInboundStepIds,
    outboundStepIds: uniqueOutboundStepIds,
    badges,
    blocked: false,
    summary,
  };
}

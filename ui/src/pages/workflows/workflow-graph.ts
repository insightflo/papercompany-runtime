import { parse as parseYaml } from "yaml";
import { parseDependencies } from "./workflow-graph-dependencies.js";
import { normalizeGraphRunStatus } from "./workflow-graph-run-status.js";
export { normalizeGraphEdgeKind } from "./workflow-graph-edge-kind.js";
export { normalizeGraphRunStatus } from "./workflow-graph-run-status.js";
export { parseDependencies } from "./workflow-graph-dependencies.js";
import { cloneWorkflowConditionGroup, defaultIfConditionGroup } from "./workflow-control-nodes.js";
import type { WorkflowGraphEdgeMetadataInput, WorkflowGraphStep, WorkflowGraphStepRunInput } from "./workflow-graph-types-core.js";
import type { WorkflowGraphContainer, WorkflowGraphContainerType, WorkflowGraphDraftDiff, WorkflowGraphEdge, WorkflowGraphFailureRouteOptions, WorkflowGraphGroup } from "./workflow-graph-types-model.js";
import type { WorkflowGraphManagementRunInput, WorkflowGraphManagementSummary, WorkflowGraphManagementSummaryInput, WorkflowGraphManagementTile, WorkflowGraphModel, WorkflowGraphStructurePaletteSummary, WorkflowGraphWorkbenchSummary } from "./workflow-graph-types-test.js";
import type { WorkflowGraphDefinitionNavigatorInput, WorkflowGraphDefinitionNavigatorItem, WorkflowGraphDefinitionNavigatorSummary, WorkflowGraphExportFormat, WorkflowGraphExportInput, WorkflowGraphExportSnapshot, WorkflowGraphPaletteNodeKind, WorkflowGraphReleaseReviewInput, WorkflowGraphReleaseReviewStage, WorkflowGraphReleaseReviewSummary, WorkflowGraphReleaseReviewTone, WorkflowGraphSearchResult, WorkflowGraphTriggerInput, WorkflowGraphTriggerSummary, WorkflowGraphYamlDraftParseResult } from "./workflow-graph-types-interface.js";
export type * from "./workflow-graph-types-core.js";
export type * from "./workflow-graph-types-model.js";
export type * from "./workflow-graph-types-test.js";
export type * from "./workflow-graph-types-interface.js";
import { normalizeApprovalTimeoutAction, normalizeRetryBackoff, parseRecipientList, parseReferenceList, readBooleanSetting } from "./workflow-graph-step-metadata.js";
import { buildStepMap, compactGraphEdgeMetadata, normalizeGraphContainerMode, normalizeWorkProducts, readRecord, readString } from "./workflow-graph-step-runtime.js";
import { buildWorkflowGraphModel } from "./workflow-graph-model-build.js";
export { buildWorkflowGraphModel } from "./workflow-graph-model-build.js";

import { readTrimmedString, readPlainObject } from "./workflow-graph-value-readers.js";
import { summarizeWorkflowGraphInterface, normalizeFlowInputs, normalizeFlowEnvVariables } from "./workflow-graph-flow-interface.js";
export { summarizeWorkflowGraphInterface, buildWorkflowGraphRequestFillPreview } from "./workflow-graph-flow-interface.js";
export { getWorkflowGraphStepContext } from "./workflow-graph-step-context.js";
import { summarizeWorkflowGraphTestInputLibrary, buildWorkflowGraphTestPlan } from "./workflow-graph-test-previews.js";
export { summarizeWorkflowGraphTestInputLibrary, buildWorkflowGraphTestRequestPreview, buildWorkflowGraphIterationTestPreview, buildWorkflowGraphSingleStepTestPreview, buildWorkflowGraphTestPlan, buildWorkflowGraphTestExecutionPreview } from "./workflow-graph-test-previews.js";

import { buildWorkflowGraphSelectionSummary } from "./workflow-graph-selection.js";
export { buildWorkflowGraphDataFlowMap, buildWorkflowGraphContainerSummary, expandWorkflowGraphSelection, buildWorkflowGraphSelectionSummary } from "./workflow-graph-selection.js";
export { buildWorkflowGraphInspectorSummary, buildWorkflowGraphFocusLensSummary, buildWorkflowGraphExecutionEvidenceSummary, buildWorkflowGraphRepairPlan } from "./workflow-graph-inspection.js";
import { hasPath, buildWorkflowGraphFailureRouteSummary } from "./workflow-graph-run-views.js";
export { buildWorkflowGraphFailureRouteSummary, buildWorkflowGraphTestDrawerSummary, buildWorkflowGraphEdgeImpactPreview, buildWorkflowGraphRestartPreview, buildWorkflowGraphRunDebugSummary } from "./workflow-graph-run-views.js";

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

function parseTriggerLabels(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.flatMap((entry) => parseTriggerLabels(entry))));
  }
  if (typeof value !== "string") return [];
  return Array.from(new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean)));
}

export function summarizeWorkflowGraphTriggers(input: WorkflowGraphTriggerInput): WorkflowGraphTriggerSummary {
  const cron = readTrimmedString(input.schedule);
  const timezone = readTrimmedString(input.timezone);
  const labels = parseTriggerLabels(input.triggerLabels);
  const lastRunAt = readTrimmedString(input.lastScheduledRunAt);
  const error = readTrimmedString(input.lastScheduleError);
  const errorAt = readTrimmedString(input.lastScheduleErrorAt);
  const hasSchedule = Boolean(cron);
  const hasLabels = labels.length > 0;
  const enabled = hasSchedule || hasLabels;
  const badges: string[] = [];
  if (hasSchedule) badges.push("Cron");
  if (timezone) badges.push(timezone);
  if (hasLabels) badges.push(`${labels.length} label${labels.length === 1 ? "" : "s"}`);
  if (error) badges.push("Schedule error");
  if (badges.length === 0) badges.push("Manual");
  const descriptionParts: string[] = [];
  if (hasSchedule) descriptionParts.push(`Cron ${cron}`);
  if (hasLabels) descriptionParts.push(`Labels ${labels.join(", ")}`);
  return {
    enabled,
    status: error ? "error" : enabled ? "active" : "manual",
    schedule: {
      cron,
      timezone,
      lastRunAt,
      error,
      errorAt,
    },
    labels,
    badges,
    description: descriptionParts.join(" · ") || "Manual run only",
  };
}

export function buildWorkflowGraphExportSnapshot(input: WorkflowGraphExportInput): WorkflowGraphExportSnapshot {
  const flowInterface = summarizeWorkflowGraphInterface(input);
  return {
    formatVersion: 1,
    metadata: {
      id: readTrimmedString(input.id),
      name: readTrimmedString(input.name),
      description: readTrimmedString(input.description),
      status: readTrimmedString(input.status) || "active",
    },
    settings: {
      schedule: readTrimmedString(input.schedule),
      timezone: readTrimmedString(input.timezone),
      triggerLabels: parseTriggerLabels(input.triggerLabels),
    },
    flowInterface: {
      inputs: flowInterface.inputs,
      envVariables: flowInterface.envVariables,
    },
    steps: Array.isArray(input.steps) ? input.steps : [],
  };
}

function formatYamlScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = String(value);
  if (!text) return '""';
  if (/^[A-Za-z0-9_./*@ -]+$/.test(text) && !/^\s|\s$/.test(text)) return text;
  return JSON.stringify(text);
}

function formatYamlValue(value: unknown, indent = 0): string {
  const prefix = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value.map((entry) => {
      if (entry && typeof entry === "object") {
        return `${prefix}- ${formatYamlValue(entry, indent + 2).trimStart()}`;
      }
      return `${prefix}- ${formatYamlScalar(entry)}`;
    }).join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return entries.map(([key, entry]) => {
      if (Array.isArray(entry) || (entry && typeof entry === "object")) {
        return `${prefix}${key}: ${formatYamlValue(entry, indent + 2) === "[]" || formatYamlValue(entry, indent + 2) === "{}" ? formatYamlValue(entry, indent + 2) : `\n${formatYamlValue(entry, indent + 2)}`}`;
      }
      return `${prefix}${key}: ${formatYamlScalar(entry)}`;
    }).join("\n");
  }
  return formatYamlScalar(value);
}

export function serializeWorkflowGraphExportSnapshot(
  snapshot: WorkflowGraphExportSnapshot,
  format: WorkflowGraphExportFormat,
): string {
  if (format === "yaml") {
    return `${formatYamlValue(snapshot)}\n`;
  }
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function normalizeSnapshotSteps(value: unknown): WorkflowGraphStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = readPlainObject(entry);
    const id = readTrimmedString(record.id);
    if (!id) return [];
    return [{
      ...record,
      id,
      title: readTrimmedString(record.title),
      type: readTrimmedString(record.type),
      dependsOn: parseDependencies(record.dependsOn),
    } as WorkflowGraphStep];
  });
}

function normalizeExportSnapshot(value: unknown): WorkflowGraphExportSnapshot {
  const record = readPlainObject(value);
  const metadata = readPlainObject(record.metadata);
  const settings = readPlainObject(record.settings);
  const flowInterface = readPlainObject(record.flowInterface);
  return {
    formatVersion: 1,
    metadata: {
      id: readTrimmedString(metadata.id),
      name: readTrimmedString(metadata.name),
      description: readTrimmedString(metadata.description),
      status: readTrimmedString(metadata.status) || "active",
    },
    settings: {
      schedule: readTrimmedString(settings.schedule),
      timezone: readTrimmedString(settings.timezone),
      triggerLabels: parseTriggerLabels(settings.triggerLabels),
    },
    flowInterface: {
      inputs: normalizeFlowInputs(flowInterface.inputs),
      envVariables: normalizeFlowEnvVariables(flowInterface.envVariables),
    },
    steps: normalizeSnapshotSteps(record.steps),
  };
}

export function parseWorkflowGraphYamlDraft(yamlText: string): WorkflowGraphYamlDraftParseResult {
  try {
    return {
      snapshot: normalizeExportSnapshot(parseYaml(yamlText)),
      error: "",
    };
  } catch (error) {
    return {
      snapshot: normalizeExportSnapshot({}),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildWorkflowGraphStructurePaletteSummary<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  selectedStepId: string,
  selectedPathStepIds: string[] = selectedStepId ? [selectedStepId] : [],
  failureRouteBlocked = false,
): WorkflowGraphStructurePaletteSummary {
  const graph = buildWorkflowGraphModel(steps);
  const stepId = selectedStepId.trim() || graph.nodes[0]?.id || "";
  const node = graph.nodes.find((candidate) => candidate.id === stepId);
  const selection = buildWorkflowGraphSelectionSummary(steps, selectedPathStepIds);
  const hasSelection = !selection.blocked && selection.stepIds.length > 0;
  const canInsertAfterSelection = Boolean(node || graph.nodes.length === 0);
  const title = node?.label || stepId || "No step selected";
  const blockedTransformDescription = selection.blocked
    ? "Select a graph node or path before using path transforms."
    : `${selection.stepIds.length} selected step${selection.stepIds.length === 1 ? "" : "s"} can be transformed.`;

  return {
    selectedStepId: stepId,
    title,
    tone: node ? "info" : graph.nodes.length === 0 ? "warning" : "neutral",
    summary: node
      ? `Add a node after ${title}, wrap the selected path, or route failures without leaving the graph.`
      : graph.nodes.length === 0
        ? "Start this workflow by adding an agent or tool node."
        : "Select a graph node to add adjacent steps and transform paths.",
    badges: [
      node ? node.kind : graph.nodes.length === 0 ? "empty graph" : "no selection",
      hasSelection ? `${selection.stepIds.length} selected` : "no path",
      selection.inboundStepIds.length > 0 ? `${selection.inboundStepIds.length} inbound` : "no inbound",
      selection.outboundStepIds.length > 0 ? `${selection.outboundStepIds.length} outbound` : "no outbound",
    ],
    addActions: [
      {
        id: "agent",
        label: "Agent",
        description: node ? "Add a company worker step after this node." : "Add the first company worker step.",
        tone: "success",
        disabled: !canInsertAfterSelection,
      },
      {
        id: "tool",
        label: "Tool",
        description: node ? "Add a system or integration action after this node." : "Add the first system or integration action.",
        tone: "info",
        disabled: !canInsertAfterSelection,
      },
      {
        id: "if",
        label: "IF",
        description: "Route execution through typed true and false outputs.",
        tone: "warning",
        disabled: !canInsertAfterSelection,
      },
      {
        id: "complete",
        label: "Complete",
        description: "Finish the workflow successfully on a selected branch.",
        tone: "success",
      },
      {
        id: "branch",
        label: "Branch",
        description: "Insert a condition split for alternative paths.",
        tone: "warning",
        disabled: !canInsertAfterSelection,
      },
      {
        id: "loop",
        label: "Loop",
        description: "Insert an iteration block for repeated work.",
        tone: "warning",
        disabled: !canInsertAfterSelection,
      },
      {
        id: "approval",
        label: "Approval",
        description: "Suspend execution for governed human review.",
        tone: "neutral",
        disabled: !canInsertAfterSelection,
      },
      {
        id: "failure-handler",
        label: "Failure",
        description: "Add a handler step for recovery paths.",
        tone: "danger",
        disabled: !canInsertAfterSelection,
      },
    ],
    transformActions: [
      {
        id: "group",
        label: "Group",
        description: hasSelection ? "Cluster selected steps as one navigable flow group." : blockedTransformDescription,
        tone: "neutral",
        disabled: !hasSelection,
      },
      {
        id: "branch-wrap",
        label: "Wrap branch",
        description: hasSelection ? "Turn the selected path into a conditional branch container." : blockedTransformDescription,
        tone: "warning",
        disabled: !hasSelection,
      },
      {
        id: "loop-wrap",
        label: "Wrap loop",
        description: hasSelection ? "Turn the selected path into an iteration container." : blockedTransformDescription,
        tone: "warning",
        disabled: !hasSelection,
      },
      {
        id: "route-failure",
        label: "Route failure",
        description: failureRouteBlocked
          ? "Choose or add a failure handler before routing this path."
          : "Route selected step failures to the configured handler.",
        tone: failureRouteBlocked ? "neutral" : "danger",
        disabled: !hasSelection || failureRouteBlocked,
      },
    ],
  };
}

export function buildWorkflowGraphWorkbenchSummary<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  selectedStepId: string,
  selectedPathStepIds: string[] = selectedStepId ? [selectedStepId] : [],
): WorkflowGraphWorkbenchSummary {
  const graph = buildWorkflowGraphModel(steps);
  const diagnostics = graph.diagnostics;
  const selection = buildWorkflowGraphSelectionSummary(steps, selectedPathStepIds);
  return {
    selectedStepId: selectedStepId.trim(),
    commandGroups: [
      {
        id: "canvas",
        label: "Canvas",
        actions: [
          { id: "fit-canvas", label: "Fit" },
          { id: "actual-size", label: "100%" },
          { id: "center-selected", label: "Center", disabled: !selectedStepId.trim() },
          { id: "diagnostics", label: "Diagnostics" },
        ],
      },
      {
        id: "add",
        label: "Add",
        actions: [
          { id: "agent", label: "+ Agent" },
          { id: "tool", label: "+ Tool" },
          { id: "if", label: "IF" },
          { id: "complete", label: "Complete" },
          { id: "branch", label: "Branch" },
          { id: "loop", label: "Loop" },
          { id: "approval", label: "Approval" },
          { id: "failure-handler", label: "Failure" },
        ],
      },
      {
        id: "path",
        label: "Path",
        actions: [
          { id: "upstream", label: "Upstream", disabled: !selectedStepId.trim() },
          { id: "downstream", label: "Downstream", disabled: !selectedStepId.trim() },
          { id: "connected", label: "Connected", disabled: !selectedStepId.trim() },
          { id: "group", label: "Group", disabled: selection.blocked },
          { id: "branch-wrap", label: "Branch", disabled: selection.blocked },
          { id: "loop-wrap", label: "Loop", disabled: selection.blocked },
          { id: "route-failure", label: "Route failure", disabled: selection.blocked },
        ],
      },
    ],
    statusBadges: [
      `${diagnostics.issueCountBySeverity.error} error${diagnostics.issueCountBySeverity.error === 1 ? "" : "s"}`,
      `${diagnostics.entryStepIds.length} entr${diagnostics.entryStepIds.length === 1 ? "y" : "ies"}`,
      `${diagnostics.terminalStepIds.length} terminal${diagnostics.terminalStepIds.length === 1 ? "" : "s"}`,
      selection.blocked ? "0 selected" : `${selection.stepIds.length} selected`,
    ],
    pathSummary: selection.summary,
    detailsHiddenByDefault: true,
  };
}

function stableDraftValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableDraftValue);
  if (!value || typeof value !== "object") return value ?? null;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableDraftValue(entry)]),
  );
}

function stableDraftString(value: unknown): string {
  return JSON.stringify(stableDraftValue(value));
}

function normalizeStepForDraftDiff(step: WorkflowGraphStep): Record<string, unknown> {
  const cleared = clearGraphRunOverlay(step);
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cleared).sort(([left], [right]) => left.localeCompare(right))) {
    if (key.startsWith("graphRun")) continue;
    if (key === "dependsOn") {
      normalized[key] = parseDependencies(value).sort();
      continue;
    }
    normalized[key] = stableDraftValue(value);
  }
  return normalized;
}

function diffStepFields(before: WorkflowGraphStep, after: WorkflowGraphStep): string[] {
  const beforeStep = normalizeStepForDraftDiff(before);
  const afterStep = normalizeStepForDraftDiff(after);
  const fields = new Set([...Object.keys(beforeStep), ...Object.keys(afterStep)]);
  return Array.from(fields)
    .sort((left, right) => left.localeCompare(right))
    .filter((field) => stableDraftString(beforeStep[field]) !== stableDraftString(afterStep[field]));
}

function edgeDraftSignature(edge: WorkflowGraphEdge): string {
  return stableDraftString({
    kind: edge.kind,
    label: edge.label,
    condition: edge.condition,
  });
}

function pluralizeDiff(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function summarizeWorkflowGraphDraftDiff(
  savedSteps: WorkflowGraphStep[],
  draftSteps: WorkflowGraphStep[],
): WorkflowGraphDraftDiff {
  const savedById = buildStepMap(savedSteps);
  const draftById = buildStepMap(draftSteps);
  const addedSteps = draftSteps.map((step) => step.id.trim()).filter((id) => id && !savedById.has(id));
  const removedSteps = savedSteps.map((step) => step.id.trim()).filter((id) => id && !draftById.has(id));
  const changedSteps = draftSteps.flatMap((step) => {
    const id = step.id.trim();
    if (!id || !savedById.has(id)) return [];
    const fields = diffStepFields(savedById.get(id)!, step);
    return fields.length > 0 ? [{ id, fields }] : [];
  });

  const savedEdges = buildWorkflowGraphModel(savedSteps).edges;
  const draftEdges = buildWorkflowGraphModel(draftSteps).edges;
  const savedEdgeById = new Map(savedEdges.map((edge) => [edge.id, edge]));
  const draftEdgeById = new Map(draftEdges.map((edge) => [edge.id, edge]));
  const addedEdges = draftEdges.map((edge) => edge.id).filter((id) => !savedEdgeById.has(id));
  const removedEdges = savedEdges.map((edge) => edge.id).filter((id) => !draftEdgeById.has(id));
  const changedEdges = draftEdges
    .filter((edge) => savedEdgeById.has(edge.id) && edgeDraftSignature(savedEdgeById.get(edge.id)!) !== edgeDraftSignature(edge))
    .map((edge) => edge.id);

  const summary: string[] = [];
  if (addedSteps.length > 0) summary.push(`${pluralizeDiff(addedSteps.length, "added step")}`);
  if (removedSteps.length > 0) summary.push(`${pluralizeDiff(removedSteps.length, "removed step")}`);
  if (changedSteps.length > 0) summary.push(`${pluralizeDiff(changedSteps.length, "changed step")}`);
  if (addedEdges.length > 0) summary.push(`${pluralizeDiff(addedEdges.length, "added edge")}`);
  if (removedEdges.length > 0) summary.push(`${pluralizeDiff(removedEdges.length, "removed edge")}`);
  if (changedEdges.length > 0) summary.push(`${pluralizeDiff(changedEdges.length, "changed edge")}`);

  const hasChanges = addedSteps.length > 0
    || removedSteps.length > 0
    || changedSteps.length > 0
    || addedEdges.length > 0
    || removedEdges.length > 0
    || changedEdges.length > 0;

  return {
    hasChanges,
    addedSteps,
    removedSteps,
    changedSteps,
    addedEdges,
    removedEdges,
    changedEdges,
    summary: hasChanges ? summary : ["No draft changes"],
  };
}

function statusBucket(status: unknown): "running" | "succeeded" | "failed" | "cancelled" | "other" {
  const normalized = readTrimmedString(status).toLowerCase();
  if (normalized === "running" || normalized === "queued" || normalized === "in_progress") return "running";
  if (normalized === "succeeded" || normalized === "completed" || normalized === "done" || normalized === "success") return "succeeded";
  if (normalized === "failed" || normalized === "error" || normalized === "timed_out") return "failed";
  if (normalized === "cancelled" || normalized === "canceled" || normalized === "aborted") return "cancelled";
  return "other";
}

function countRunsByBucket(runs: WorkflowGraphManagementRunInput[]): Record<ReturnType<typeof statusBucket>, number> {
  return runs.reduce<Record<ReturnType<typeof statusBucket>, number>>((counts, run) => {
    counts[statusBucket(run.status)] += 1;
    return counts;
  }, { running: 0, succeeded: 0, failed: 0, cancelled: 0, other: 0 });
}

function scopedManagementRuns(
  runs: WorkflowGraphManagementRunInput[] | undefined,
  workflowId: string,
): WorkflowGraphManagementRunInput[] {
  const list = Array.isArray(runs) ? runs : [];
  const id = workflowId.trim();
  if (!id) return list;
  return list.filter((run) => !run.workflowId || run.workflowId === id);
}

export function buildWorkflowGraphManagementSummary<TStep extends WorkflowGraphStep>(
  input: WorkflowGraphManagementSummaryInput<TStep>,
): WorkflowGraphManagementSummary {
  const savedSteps = Array.isArray(input.savedSteps) ? input.savedSteps : [];
  const draftSteps = Array.isArray(input.draftSteps) ? input.draftSteps : [];
  const draftDiff = savedSteps.length > 0
    ? summarizeWorkflowGraphDraftDiff(savedSteps, draftSteps)
    : summarizeWorkflowGraphDraftDiff(draftSteps, draftSteps);
  const targetStepId = readTrimmedString(input.selectedStepId) || draftSteps[0]?.id || "";
  const testPlan = buildWorkflowGraphTestPlan(draftSteps, targetStepId);
  const testLibrary = summarizeWorkflowGraphTestInputLibrary(input.interfaceInput ?? {});
  const activeRuns = scopedManagementRuns(input.activeRuns, readTrimmedString(input.workflowId));
  const recentRuns = scopedManagementRuns(input.recentRuns, readTrimmedString(input.workflowId));
  const activeBuckets = countRunsByBucket(activeRuns);
  const recentBuckets = countRunsByBucket(recentRuns);
  const latestRecentRun = recentRuns[0];
  const latestRecentBucket = latestRecentRun ? statusBucket(latestRecentRun.status) : "other";
  const draftChangeCount = draftDiff.addedSteps.length
    + draftDiff.removedSteps.length
    + draftDiff.changedSteps.length
    + draftDiff.addedEdges.length
    + draftDiff.removedEdges.length
    + draftDiff.changedEdges.length;

  const draftTile: WorkflowGraphManagementTile = {
    id: "draft",
    title: "Draft",
    status: draftDiff.hasChanges ? "changed" : "clean",
    tone: draftDiff.hasChanges ? "warning" : "success",
    summary: draftDiff.hasChanges
      ? `${draftChangeCount} draft change${draftChangeCount === 1 ? "" : "s"} waiting to be saved.`
      : "Draft matches the saved workflow definition.",
    badges: draftDiff.hasChanges ? draftDiff.summary : ["No draft changes"],
    actionLabel: draftDiff.hasChanges ? "Review diff" : "No diff",
  };

  const testTile: WorkflowGraphManagementTile = {
    id: "test",
    title: "Test",
    status: testPlan.blocked ? "blocked" : "ready",
    tone: testPlan.blocked ? "danger" : "info",
    summary: testPlan.summary,
    badges: [...testPlan.badges, ...testLibrary.badges].slice(0, 5),
    actionLabel: "Preview test",
  };

  const runsTile: WorkflowGraphManagementTile = {
    id: "runs",
    title: "Runs",
    status: activeRuns.length > 0 ? `${activeRuns.length} active` : "idle",
    tone: activeBuckets.failed > 0 ? "danger" : activeRuns.length > 0 ? "success" : "neutral",
    summary: activeRuns.length > 0
      ? `${activeRuns.length} active run${activeRuns.length === 1 ? "" : "s"} for this workflow.`
      : "No active runs for this workflow.",
    badges: [
      `${activeBuckets.running} running`,
      `${activeBuckets.failed} failed`,
      `${activeBuckets.other} other`,
    ],
    actionLabel: activeRuns.length > 0 ? "View active" : "Run workflow",
  };

  const historyTile: WorkflowGraphManagementTile = {
    id: "history",
    title: "History",
    status: recentRuns.length > 0 ? `${recentRuns.length} recent` : "empty",
    tone: latestRecentBucket === "failed" ? "danger" : recentRuns.length > 0 ? "info" : "neutral",
    summary: latestRecentRun
      ? `Latest recent run is ${readTrimmedString(latestRecentRun.status) || "unknown"}.`
      : "No recent run history for this workflow.",
    badges: [
      `${recentBuckets.succeeded} succeeded`,
      `${recentBuckets.failed} failed`,
      `${recentBuckets.cancelled} cancelled`,
    ],
    actionLabel: recentRuns.length > 0 ? "View history" : "No history",
  };

  return {
    tiles: [draftTile, testTile, runsTile, historyTile],
    badges: [
      draftDiff.hasChanges ? `${draftChangeCount} changes` : "clean draft",
      testPlan.blocked ? "test blocked" : "test ready",
      `${activeRuns.length} active runs`,
      `${recentRuns.length} recent runs`,
    ],
    hasBlockingIssue: testPlan.blocked || activeBuckets.failed > 0 || latestRecentBucket === "failed",
  };
}

export function buildWorkflowGraphReleaseReview<TStep extends WorkflowGraphStep>(
  input: WorkflowGraphReleaseReviewInput<TStep>,
): WorkflowGraphReleaseReviewSummary {
  const savedSteps = Array.isArray(input.savedSteps) ? input.savedSteps : [];
  const draftSteps = Array.isArray(input.draftSteps) ? input.draftSteps : [];
  const draftDiff = savedSteps.length > 0
    ? summarizeWorkflowGraphDraftDiff(savedSteps, draftSteps)
    : summarizeWorkflowGraphDraftDiff(draftSteps, draftSteps);
  const targetStepId = readTrimmedString(input.selectedStepId) || draftSteps[0]?.id || "";
  const testPlan = buildWorkflowGraphTestPlan(draftSteps, targetStepId);
  const activeRuns = scopedManagementRuns(input.activeRuns, readTrimmedString(input.workflowId));
  const recentRuns = scopedManagementRuns(input.recentRuns, readTrimmedString(input.workflowId));
  const activeBuckets = countRunsByBucket(activeRuns);
  const recentBuckets = countRunsByBucket(recentRuns);
  const latestRecentRun = recentRuns[0];
  const latestRecentBucket = latestRecentRun ? statusBucket(latestRecentRun.status) : "other";
  const draftChangeCount = draftDiff.addedSteps.length
    + draftDiff.removedSteps.length
    + draftDiff.changedSteps.length
    + draftDiff.addedEdges.length
    + draftDiff.removedEdges.length
    + draftDiff.changedEdges.length;
  const runHistoryRisk = activeBuckets.failed > 0 || latestRecentBucket === "failed" || recentBuckets.failed > 0;
  const blocked = testPlan.blocked;
  const decision: WorkflowGraphReleaseReviewSummary["decision"] = blocked
    ? "blocked"
    : draftDiff.hasChanges
      ? runHistoryRisk ? "risky-history" : "ready-to-save"
      : runHistoryRisk ? "risky-history" : "synced";
  const tone: WorkflowGraphReleaseReviewTone = decision === "blocked"
    ? "danger"
    : decision === "risky-history"
      ? "warning"
      : decision === "ready-to-save"
        ? "info"
        : "success";
  const title = decision === "blocked"
    ? "Release blocked"
    : decision === "ready-to-save"
      ? "Ready to save"
      : decision === "risky-history"
        ? "Review run history"
        : "Saved definition synced";
  const summary = decision === "blocked"
    ? "Resolve graph test blockers before saving this workflow definition."
    : decision === "ready-to-save"
      ? `${draftChangeCount} staged change${draftChangeCount === 1 ? "" : "s"} can update the saved runnable baseline.`
      : decision === "risky-history"
        ? "Recent failures exist; inspect run history before relying on the saved workflow."
        : "The graph matches the saved workflow definition.";
  const primaryAction = decision === "blocked"
    ? "Fix graph"
    : decision === "ready-to-save"
      ? "Save changes"
      : decision === "risky-history"
        ? "Inspect history"
        : "Run workflow";

  const localStage: WorkflowGraphReleaseReviewStage = {
    id: "local-edit",
    title: "Local edit",
    status: draftDiff.hasChanges ? "changed" : "clean",
    tone: draftDiff.hasChanges ? "warning" : "success",
    summary: draftDiff.hasChanges
      ? `${draftChangeCount} graph change${draftChangeCount === 1 ? "" : "s"} staged locally.`
      : "Local graph matches the saved baseline.",
    badges: draftDiff.hasChanges ? draftDiff.summary.slice(0, 4) : ["No local changes"],
  };

  const testStage: WorkflowGraphReleaseReviewStage = {
    id: "test-gate",
    title: "Test gate",
    status: testPlan.blocked ? "blocked" : "ready",
    tone: testPlan.blocked ? "danger" : "info",
    summary: testPlan.summary,
    badges: testPlan.badges.slice(0, 4),
  };

  const savedStage: WorkflowGraphReleaseReviewStage = {
    id: "saved-definition",
    title: "Saved definition",
    status: blocked ? "blocked" : draftDiff.hasChanges ? "pending save" : "synced",
    tone: blocked ? "danger" : draftDiff.hasChanges ? "warning" : "success",
    summary: blocked
      ? "Saved runnable baseline should not be updated until blockers are resolved."
      : draftDiff.hasChanges
        ? "Saving will update the workflow used by manual, schedule, label, and API runs."
        : "Manual, schedule, label, and API runs use this saved definition.",
    badges: [
      draftDiff.hasChanges ? `${draftChangeCount} staged` : "baseline current",
      savedSteps.length > 0 ? `${savedSteps.length} saved steps` : "new baseline",
    ],
  };

  const historyStage: WorkflowGraphReleaseReviewStage = {
    id: "run-history",
    title: "Run history",
    status: activeRuns.length > 0 ? `${activeRuns.length} active` : recentRuns.length > 0 ? `${recentRuns.length} recent` : "empty",
    tone: runHistoryRisk ? "danger" : activeRuns.length > 0 ? "success" : recentRuns.length > 0 ? "info" : "neutral",
    summary: runHistoryRisk
      ? `${recentBuckets.failed + activeBuckets.failed} failed run${recentBuckets.failed + activeBuckets.failed === 1 ? "" : "s"} need review.`
      : activeRuns.length > 0
        ? `${activeRuns.length} run${activeRuns.length === 1 ? "" : "s"} currently active for this workflow.`
        : recentRuns.length > 0
          ? `Latest recent run is ${readTrimmedString(latestRecentRun?.status) || "unknown"}.`
          : "No run history for this workflow yet.",
    badges: [
      `${activeRuns.length} active`,
      `${recentBuckets.succeeded} succeeded`,
      `${recentBuckets.failed + activeBuckets.failed} failed`,
    ],
  };

  return {
    decision,
    title,
    summary,
    tone,
    primaryAction,
    badges: [
      draftDiff.hasChanges ? `${draftChangeCount} changes` : "clean draft",
      testPlan.blocked ? "test blocked" : "test ready",
      `${activeRuns.length} active runs`,
      `${recentRuns.length} recent runs`,
    ],
    stages: [localStage, testStage, savedStage, historyStage],
    hasBlockingIssue: blocked,
  };
}

export function buildWorkflowGraphDefinitionNavigator<TStep extends WorkflowGraphStep>(
  input: WorkflowGraphDefinitionNavigatorInput<TStep>,
): WorkflowGraphDefinitionNavigatorSummary {
  const workflows = Array.isArray(input.workflows) ? input.workflows : [];
  const search = readTrimmedString(input.search).toLowerCase();
  const filter = input.filter ?? "all";
  const activeRuns = Array.isArray(input.activeRuns) ? input.activeRuns : [];
  const recentRuns = Array.isArray(input.recentRuns) ? input.recentRuns : [];

  const items = workflows.map<WorkflowGraphDefinitionNavigatorItem>((workflow, index) => {
    const id = readTrimmedString(workflow.id) || `workflow-${index + 1}`;
    const name = readTrimmedString(workflow.name) || "Untitled workflow";
    const description = readTrimmedString(workflow.description);
    const status = readTrimmedString(workflow.status) || "active";
    const normalizedStatus = status.toLowerCase();
    const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
    const trigger = summarizeWorkflowGraphTriggers({
      schedule: workflow.schedule,
      timezone: workflow.timezone,
      triggerLabels: workflow.triggerLabels,
      lastScheduledRunAt: workflow.lastScheduledRunAt,
      lastScheduleError: workflow.lastScheduleError,
      lastScheduleErrorAt: workflow.lastScheduleErrorAt,
    });
    const scopedActiveRuns = scopedManagementRuns(activeRuns, id);
    const scopedRecentRuns = scopedManagementRuns(recentRuns, id);
    const activeBuckets = countRunsByBucket(scopedActiveRuns);
    const recentBuckets = countRunsByBucket(scopedRecentRuns);
    const failedRunCount = activeBuckets.failed + recentBuckets.failed;
    const hasStatusProblem = normalizedStatus === "failed" || normalizedStatus === "error" || normalizedStatus === "blocked";
    const hasProblem = hasStatusProblem || Boolean(trigger.schedule.error) || failedRunCount > 0;
    const isScheduled = trigger.enabled;
    const isArchived = normalizedStatus === "archived";
    const badges = [
      isScheduled ? trigger.badges[0] ?? "Scheduled" : "Manual",
      trigger.schedule.timezone || "",
      `${steps.length} step${steps.length === 1 ? "" : "s"}`,
      scopedActiveRuns.length > 0 ? `${scopedActiveRuns.length} active` : "",
      failedRunCount > 0 ? `${failedRunCount} failed` : "",
    ].filter(Boolean);
    const miniSteps = steps.slice(0, 4).map((step) => ({
      id: readTrimmedString(step.id),
      title: readTrimmedString(step.title) || readTrimmedString(step.id) || "Step",
      type: readTrimmedString(step.type) || "agent",
    }));
    const matchText = [
      id,
      name,
      description,
      status,
      workflow.schedule,
      workflow.timezone,
      workflow.createParentIssuePolicy,
      ...trigger.labels,
      ...steps.flatMap((step) => [step.id, step.title, step.type]),
    ].map((part) => readTrimmedString(part).toLowerCase()).filter(Boolean).join(" ");

    return {
      id,
      name,
      description,
      status,
      stepCount: steps.length,
      miniSteps,
      trigger,
      activeRunCount: scopedActiveRuns.length,
      recentRunCount: scopedRecentRuns.length,
      failedRunCount,
      hasProblem,
      isScheduled,
      isArchived,
      badges,
      matchText,
    };
  });

  const matchesSearch = (item: WorkflowGraphDefinitionNavigatorItem): boolean => {
    if (!search) return true;
    return item.matchText.includes(search);
  };
  const matchesFilter = (item: WorkflowGraphDefinitionNavigatorItem): boolean => {
    if (filter === "active") return item.status.trim().toLowerCase() === "active";
    if (filter === "scheduled") return item.isScheduled;
    if (filter === "problems") return item.hasProblem;
    if (filter === "archived") return item.isArchived;
    return !item.isArchived;
  };
  const visibleItems = items.filter((item) => matchesSearch(item) && matchesFilter(item));
  const activeCount = items.filter((item) => item.status.trim().toLowerCase() === "active").length;
  const scheduledCount = items.filter((item) => item.isScheduled).length;
  const needsReviewCount = items.filter((item) => item.hasProblem).length;
  const pausedCount = items.filter((item) => item.status.trim().toLowerCase() === "paused").length;
  const archivedCount = items.filter((item) => item.isArchived).length;
  const activeRunCount = items.reduce((sum, item) => sum + item.activeRunCount, 0);

  return {
    items,
    visibleItems,
    stats: {
      total: items.length,
      visible: visibleItems.length,
      active: activeCount,
      scheduled: scheduledCount,
      activeRuns: activeRunCount,
      needsReview: needsReviewCount,
      paused: pausedCount,
      archived: archivedCount,
    },
    filters: [
      { id: "all", label: "All", count: items.filter((item) => !item.isArchived).length },
      { id: "active", label: "Active", count: activeCount },
      { id: "scheduled", label: "Scheduled", count: scheduledCount },
      { id: "problems", label: "Issues", count: needsReviewCount },
      { id: "archived", label: "Archived", count: archivedCount },
    ],
    badges: [
      `${scheduledCount} scheduled`,
      `${activeRunCount} active run${activeRunCount === 1 ? "" : "s"}`,
      `${needsReviewCount} need review`,
    ],
  };
}

function addSearchField(fields: Map<string, string[]>, field: string, value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) addSearchField(fields, field, entry);
    return;
  }
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return;
  const entries = fields.get(field) ?? [];
  entries.push(text);
  fields.set(field, entries);
}

export function searchWorkflowGraphNodes<TStep extends WorkflowGraphStep>(
  graph: WorkflowGraphModel<TStep>,
  query: string,
): WorkflowGraphSearchResult[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];

  const groupsByStepId = new Map<string, WorkflowGraphGroup[]>();
  for (const group of graph.groups) {
    for (const stepId of group.stepIds) {
      const groups = groupsByStepId.get(stepId) ?? [];
      groups.push(group);
      groupsByStepId.set(stepId, groups);
    }
  }

  const containersByStepId = new Map<string, WorkflowGraphContainer[]>();
  for (const container of graph.containers) {
    for (const stepId of container.stepIds) {
      const containers = containersByStepId.get(stepId) ?? [];
      containers.push(container);
      containersByStepId.set(stepId, containers);
    }
  }

  return graph.nodes.flatMap((node) => {
    const fields = new Map<string, string[]>();
    addSearchField(fields, "id", node.id);
    addSearchField(fields, "id", node.step.id);
    addSearchField(fields, "title", node.label);
    addSearchField(fields, "type", node.kind);
    addSearchField(fields, "note", node.step.graphNote);
    addSearchField(fields, "policy", [
      node.advanced.badges,
      node.advanced.earlyStopCondition,
      node.advanced.suspendUntil,
      node.advanced.suspendTimeoutAction,
      node.advanced.earlyReturnContentType,
      node.advanced.earlyReturnSchema,
      node.advanced.errorHandlerScope,
      node.advanced.errorHandlerInput,
      node.advanced.restartStrategy,
      node.advanced.restartInput,
    ]);
    addSearchField(fields, "approval", [
      node.advanced.approval.prompt,
      node.advanced.approval.recipients,
      node.advanced.approval.timeoutAction,
      node.advanced.approval.badges,
    ]);
    addSearchField(fields, "testing", [
      node.testing.mockResult,
      node.testing.pinnedResultRunId,
      node.testing.badges,
    ]);
    addSearchField(fields, "execution", [
      node.execution.concurrencyKey,
      node.execution.priority,
      node.execution.badges,
    ]);
    addSearchField(fields, "data", [
      node.dataFlow.inputExpression,
      node.dataFlow.outputSchema,
      node.dataFlow.workProductPattern,
      node.dataFlow.badges,
    ]);
    addSearchField(fields, "resources", [
      node.resources.resourceRefs,
      node.resources.secretRefs,
      node.resources.badges,
    ]);
    addSearchField(fields, "status", node.runStatus.status);
    addSearchField(fields, "issue", node.runStatus.issueIdentifier);
    addSearchField(fields, "run", node.runStatus.summary);
    addSearchField(fields, "run", node.runStatus.resultPreview);
    addSearchField(fields, "run", node.runStatus.logPreview);
    addSearchField(fields, "runtime", [
      node.runStatus.runtimeBadges,
      node.runStatus.concurrencyBlocked
        ? [
          node.runStatus.concurrencyBlocked.concurrencyKey,
          String(node.runStatus.concurrencyBlocked.concurrencyLimit ?? ""),
          String(node.runStatus.concurrencyBlocked.runningCount ?? ""),
          node.runStatus.concurrencyBlocked.checkedAt,
        ]
        : [],
      node.runStatus.retentionDeleted
        ? [
          "delete after use",
          node.runStatus.retentionDeleted.toolName,
          String(node.runStatus.retentionDeleted.success ?? ""),
          String(node.runStatus.retentionDeleted.exitCode ?? ""),
          node.runStatus.retentionDeleted.deletedAt,
        ]
        : [],
    ]);

    for (const group of groupsByStepId.get(node.step.id) ?? []) {
      addSearchField(fields, "group", [group.id, group.title]);
    }

    for (const container of containersByStepId.get(node.step.id) ?? []) {
      addSearchField(fields, "container", [
        container.id,
        container.type,
        container.title,
        container.description,
        container.mode,
        container.condition,
        container.iterator,
        container.badges,
      ]);
    }

    const matchedFields: string[] = [];
    const matchedText: string[] = [];
    for (const [field, values] of fields.entries()) {
      const matches = values.filter((value) => value.toLowerCase().includes(normalizedQuery));
      if (matches.length === 0) continue;
      matchedFields.push(field);
      matchedText.push(...matches);
    }
    if (matchedFields.length === 0) return [];

    return [{
      nodeId: node.id,
      stepId: node.step.id,
      label: node.label,
      kind: node.kind,
      matchFields: matchedFields,
      matchText: Array.from(new Set(matchedText)).join(" · "),
    }];
  });
}

export function updateStepAdvancedMetadata<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepId: string,
  patch: {
    onFailure?: string;
    maxRetries?: number;
    retryDelaySeconds?: number;
    retryBackoff?: string;
    retryJitter?: boolean;
    timeoutSeconds?: number;
    sleepSeconds?: number;
    suspendUntil?: string;
    suspendTimeoutSeconds?: number;
    suspendTimeoutAction?: string;
    earlyReturn?: boolean;
    earlyReturnContentType?: string;
    earlyReturnSchema?: string;
    errorHandler?: boolean;
    errorHandlerScope?: string;
    errorHandlerInput?: string;
    restartBoundary?: boolean;
    restartStrategy?: string;
    restartInput?: string;
    earlyStopCondition?: string;
    earlyStopLabelSkipped?: boolean;
  },
): TStep[] {
  const id = stepId.trim();
  if (!id) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (step.id !== id) return step;
    changed = true;
    const hasOnFailure = Object.hasOwn(patch, "onFailure");
    const hasMaxRetries = Object.hasOwn(patch, "maxRetries");
    const hasRetryDelaySeconds = Object.hasOwn(patch, "retryDelaySeconds");
    const hasRetryBackoff = Object.hasOwn(patch, "retryBackoff");
    const hasRetryJitter = Object.hasOwn(patch, "retryJitter");
    const hasTimeoutSeconds = Object.hasOwn(patch, "timeoutSeconds");
    const hasSleepSeconds = Object.hasOwn(patch, "sleepSeconds");
    const hasSuspendUntil = Object.hasOwn(patch, "suspendUntil");
    const hasSuspendTimeoutSeconds = Object.hasOwn(patch, "suspendTimeoutSeconds");
    const hasSuspendTimeoutAction = Object.hasOwn(patch, "suspendTimeoutAction");
    const hasEarlyReturn = Object.hasOwn(patch, "earlyReturn");
    const hasEarlyReturnContentType = Object.hasOwn(patch, "earlyReturnContentType");
    const hasEarlyReturnSchema = Object.hasOwn(patch, "earlyReturnSchema");
    const hasErrorHandler = Object.hasOwn(patch, "errorHandler");
    const hasErrorHandlerScope = Object.hasOwn(patch, "errorHandlerScope");
    const hasErrorHandlerInput = Object.hasOwn(patch, "errorHandlerInput");
    const hasRestartBoundary = Object.hasOwn(patch, "restartBoundary");
    const hasRestartStrategy = Object.hasOwn(patch, "restartStrategy");
    const hasRestartInput = Object.hasOwn(patch, "restartInput");
    const hasEarlyStopCondition = Object.hasOwn(patch, "earlyStopCondition");
    const hasEarlyStopLabelSkipped = Object.hasOwn(patch, "earlyStopLabelSkipped");
    const onFailure = hasOnFailure ? (patch.onFailure ?? "").trim() : undefined;
    const maxRetries = hasMaxRetries && patch.maxRetries !== undefined && Number.isFinite(patch.maxRetries) && patch.maxRetries >= 0
      ? Math.floor(patch.maxRetries)
      : undefined;
    const retryDelaySeconds = hasRetryDelaySeconds && patch.retryDelaySeconds !== undefined && Number.isFinite(patch.retryDelaySeconds) && patch.retryDelaySeconds >= 0
      ? Math.floor(patch.retryDelaySeconds)
      : undefined;
    const retryBackoff = hasRetryBackoff ? normalizeRetryBackoff(patch.retryBackoff) : undefined;
    const timeoutSeconds = hasTimeoutSeconds && patch.timeoutSeconds !== undefined && Number.isFinite(patch.timeoutSeconds) && patch.timeoutSeconds > 0
      ? Math.floor(patch.timeoutSeconds)
      : undefined;
    const sleepSeconds = hasSleepSeconds && patch.sleepSeconds !== undefined && Number.isFinite(patch.sleepSeconds) && patch.sleepSeconds > 0
      ? Math.floor(patch.sleepSeconds)
      : undefined;
    const suspendUntil = hasSuspendUntil ? (patch.suspendUntil ?? "").trim() : undefined;
    const suspendTimeoutSeconds = hasSuspendTimeoutSeconds && patch.suspendTimeoutSeconds !== undefined && Number.isFinite(patch.suspendTimeoutSeconds) && patch.suspendTimeoutSeconds > 0
      ? Math.floor(patch.suspendTimeoutSeconds)
      : undefined;
    const suspendTimeoutAction = hasSuspendTimeoutAction ? normalizeApprovalTimeoutAction(patch.suspendTimeoutAction) : undefined;
    const earlyReturnContentType = hasEarlyReturnContentType
      ? (patch.earlyReturnContentType ?? "").trim()
      : undefined;
    const earlyReturnSchema = hasEarlyReturnSchema
      ? (patch.earlyReturnSchema ?? "").trim()
      : undefined;
    const errorHandlerScope = hasErrorHandlerScope
      ? (patch.errorHandlerScope ?? "").trim()
      : undefined;
    const errorHandlerInput = hasErrorHandlerInput
      ? (patch.errorHandlerInput ?? "").trim()
      : undefined;
    const restartStrategy = hasRestartStrategy
      ? (patch.restartStrategy ?? "").trim()
      : undefined;
    const restartInput = hasRestartInput
      ? (patch.restartInput ?? "").trim()
      : undefined;
    const earlyStopCondition = hasEarlyStopCondition
      ? (patch.earlyStopCondition ?? "").trim()
      : undefined;
    return {
      ...step,
      ...(hasOnFailure ? { onFailure: onFailure || undefined } : {}),
      ...(hasMaxRetries ? { maxRetries } : {}),
      ...(hasRetryDelaySeconds ? { graphRetryDelaySeconds: retryDelaySeconds } : {}),
      ...(hasRetryBackoff ? { graphRetryBackoff: retryBackoff || undefined } : {}),
      ...(hasRetryJitter ? { graphRetryJitter: patch.retryJitter ? true : undefined } : {}),
      ...(hasTimeoutSeconds ? { timeoutSeconds } : {}),
      ...(hasSleepSeconds ? { graphSleepSeconds: sleepSeconds } : {}),
      ...(hasSuspendUntil ? { graphSuspendUntil: suspendUntil || undefined } : {}),
      ...(hasSuspendTimeoutSeconds ? { graphSuspendTimeoutSeconds: suspendTimeoutSeconds } : {}),
      ...(hasSuspendTimeoutAction ? { graphSuspendTimeoutAction: suspendTimeoutAction || undefined } : {}),
      ...(hasEarlyReturn ? { graphEarlyReturn: patch.earlyReturn ? true : undefined } : {}),
      ...(hasEarlyReturnContentType ? { graphEarlyReturnContentType: earlyReturnContentType || undefined } : {}),
      ...(hasEarlyReturnSchema ? { graphEarlyReturnSchema: earlyReturnSchema || undefined } : {}),
      ...(hasErrorHandler ? { graphErrorHandler: patch.errorHandler ? true : undefined } : {}),
      ...(hasErrorHandlerScope ? { graphErrorHandlerScope: errorHandlerScope || undefined } : {}),
      ...(hasErrorHandlerInput ? { graphErrorHandlerInput: errorHandlerInput || undefined } : {}),
      ...(hasRestartBoundary ? { graphRestartBoundary: patch.restartBoundary ? true : undefined } : {}),
      ...(hasRestartStrategy ? { graphRestartStrategy: restartStrategy || undefined } : {}),
      ...(hasRestartInput ? { graphRestartInput: restartInput || undefined } : {}),
      ...(hasEarlyStopCondition ? { graphEarlyStopCondition: earlyStopCondition || undefined } : {}),
      ...(hasEarlyStopLabelSkipped ? { graphEarlyStopLabelSkipped: patch.earlyStopLabelSkipped ? true : undefined } : {}),
    };
  });
  return changed ? next : steps;
}

export function updateStepApprovalMetadata<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepId: string,
  patch: {
    required?: boolean;
    prompt?: string;
    recipients?: string | string[];
    timeoutSeconds?: number;
    timeoutAction?: string;
  },
): TStep[] {
  const id = stepId.trim();
  if (!id) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (step.id !== id) return step;
    changed = true;
    const hasRequired = Object.hasOwn(patch, "required");
    const hasPrompt = Object.hasOwn(patch, "prompt");
    const hasRecipients = Object.hasOwn(patch, "recipients");
    const hasTimeoutSeconds = Object.hasOwn(patch, "timeoutSeconds");
    const hasTimeoutAction = Object.hasOwn(patch, "timeoutAction");
    const required = hasRequired ? patch.required === true : readBooleanSetting(step.graphApprovalRequired) === true;
    const prompt = hasPrompt ? (patch.prompt ?? "").trim() : undefined;
    const recipients = hasRecipients ? parseRecipientList(patch.recipients).join(", ") : undefined;
    const timeoutSeconds = hasTimeoutSeconds && patch.timeoutSeconds !== undefined && Number.isFinite(patch.timeoutSeconds) && patch.timeoutSeconds > 0
      ? Math.floor(patch.timeoutSeconds)
      : undefined;
    const timeoutAction = hasTimeoutAction ? normalizeApprovalTimeoutAction(patch.timeoutAction) : undefined;
    return {
      ...step,
      ...(hasRequired ? { graphApprovalRequired: required ? true : undefined } : {}),
      ...(hasPrompt ? { graphApprovalPrompt: prompt || undefined } : {}),
      ...(hasRecipients ? { graphApprovalRecipients: recipients || undefined } : {}),
      ...(hasTimeoutSeconds ? { graphApprovalTimeoutSeconds: timeoutSeconds } : {}),
      ...(hasTimeoutAction ? { graphApprovalTimeoutAction: timeoutAction || undefined } : {}),
      ...(!required && hasRequired ? {
        graphApprovalPrompt: undefined,
        graphApprovalRecipients: undefined,
        graphApprovalTimeoutSeconds: undefined,
        graphApprovalTimeoutAction: undefined,
      } : {}),
    };
  });
  return changed ? next : steps;
}

export function updateStepTestingMetadata<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepId: string,
  patch: {
    mockEnabled?: boolean;
    mockResult?: string;
    pinnedResultRunId?: string;
  },
): TStep[] {
  const id = stepId.trim();
  if (!id) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (step.id !== id) return step;
    changed = true;
    const hasMockEnabled = Object.hasOwn(patch, "mockEnabled");
    const hasMockResult = Object.hasOwn(patch, "mockResult");
    const hasPinnedResultRunId = Object.hasOwn(patch, "pinnedResultRunId");
    const mockEnabled = hasMockEnabled ? patch.mockEnabled === true : readBooleanSetting(step.graphMockEnabled) === true;
    const mockResult = hasMockResult ? (patch.mockResult ?? "").trim() : undefined;
    const pinnedResultRunId = hasPinnedResultRunId ? (patch.pinnedResultRunId ?? "").trim() : undefined;
    return {
      ...step,
      ...(hasMockEnabled ? { graphMockEnabled: mockEnabled ? true : undefined } : {}),
      ...(hasMockResult ? { graphMockResult: mockResult || undefined } : {}),
      ...(hasPinnedResultRunId ? { graphPinnedResultRunId: pinnedResultRunId || undefined } : {}),
      ...(!mockEnabled && hasMockEnabled ? {
        graphMockResult: undefined,
      } : {}),
    };
  });
  return changed ? next : steps;
}

export function updateStepExecutionMetadata<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepId: string,
  patch: {
    concurrencyKey?: string;
    concurrencyLimit?: number;
    priority?: string;
    cacheEnabled?: boolean;
    cacheTtlSeconds?: number;
    deleteAfterUse?: boolean;
  },
): TStep[] {
  const id = stepId.trim();
  if (!id) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (step.id !== id) return step;
    changed = true;
    const hasConcurrencyKey = Object.hasOwn(patch, "concurrencyKey");
    const hasConcurrencyLimit = Object.hasOwn(patch, "concurrencyLimit");
    const hasPriority = Object.hasOwn(patch, "priority");
    const hasCacheEnabled = Object.hasOwn(patch, "cacheEnabled");
    const hasCacheTtlSeconds = Object.hasOwn(patch, "cacheTtlSeconds");
    const hasDeleteAfterUse = Object.hasOwn(patch, "deleteAfterUse");
    const concurrencyKey = hasConcurrencyKey ? (patch.concurrencyKey ?? "").trim() : undefined;
    const concurrencyLimit = hasConcurrencyLimit && patch.concurrencyLimit !== undefined && Number.isFinite(patch.concurrencyLimit) && patch.concurrencyLimit > 0
      ? Math.floor(patch.concurrencyLimit)
      : undefined;
    const priority = hasPriority ? (patch.priority ?? "").trim().toLowerCase() : undefined;
    const cacheEnabled = hasCacheEnabled ? patch.cacheEnabled === true : readBooleanSetting(step.graphCacheEnabled) === true;
    const cacheTtlSeconds = hasCacheTtlSeconds && patch.cacheTtlSeconds !== undefined && Number.isFinite(patch.cacheTtlSeconds) && patch.cacheTtlSeconds > 0
      ? Math.floor(patch.cacheTtlSeconds)
      : undefined;
    return {
      ...step,
      ...(hasConcurrencyKey ? { graphConcurrencyKey: concurrencyKey || undefined } : {}),
      ...(hasConcurrencyLimit ? { graphConcurrencyLimit: concurrencyLimit } : {}),
      ...(hasPriority ? { graphPriority: priority || undefined } : {}),
      ...(hasCacheEnabled ? { graphCacheEnabled: cacheEnabled ? true : undefined } : {}),
      ...(hasCacheTtlSeconds ? { graphCacheTtlSeconds: cacheTtlSeconds } : {}),
      ...(hasDeleteAfterUse ? { graphDeleteAfterUse: patch.deleteAfterUse ? true : undefined } : {}),
      ...(!cacheEnabled && hasCacheEnabled ? {
        graphCacheTtlSeconds: undefined,
      } : {}),
    };
  });
  return changed ? next : steps;
}

export function updateStepDataFlowMetadata<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepId: string,
  patch: {
    inputExpression?: string;
    outputSchema?: string;
    workProductRequired?: boolean;
    workProductPattern?: string;
  },
): TStep[] {
  const id = stepId.trim();
  if (!id) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (step.id !== id) return step;
    changed = true;
    const hasInputExpression = Object.hasOwn(patch, "inputExpression");
    const hasOutputSchema = Object.hasOwn(patch, "outputSchema");
    const hasWorkProductRequired = Object.hasOwn(patch, "workProductRequired");
    const hasWorkProductPattern = Object.hasOwn(patch, "workProductPattern");
    const inputExpression = hasInputExpression ? (patch.inputExpression ?? "").trim() : undefined;
    const outputSchema = hasOutputSchema ? (patch.outputSchema ?? "").trim() : undefined;
    const workProductRequired = hasWorkProductRequired ? patch.workProductRequired === true : readBooleanSetting(step.graphWorkProductRequired) === true;
    const workProductPattern = hasWorkProductPattern ? (patch.workProductPattern ?? "").trim() : undefined;
    return {
      ...step,
      ...(hasInputExpression ? { graphInputExpression: inputExpression || undefined } : {}),
      ...(hasOutputSchema ? { graphOutputSchema: outputSchema || undefined } : {}),
      ...(hasWorkProductRequired ? { graphWorkProductRequired: workProductRequired ? true : undefined } : {}),
      ...(hasWorkProductPattern ? { graphWorkProductPattern: workProductPattern || undefined } : {}),
      ...(!workProductRequired && hasWorkProductRequired ? {
        graphWorkProductPattern: undefined,
      } : {}),
    };
  });
  return changed ? next : steps;
}

export function updateStepResourceMetadata<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepId: string,
  patch: {
    resourceRefs?: string | string[];
    secretRefs?: string | string[];
  },
): TStep[] {
  const id = stepId.trim();
  if (!id) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (step.id !== id) return step;
    changed = true;
    const hasResourceRefs = Object.hasOwn(patch, "resourceRefs");
    const hasSecretRefs = Object.hasOwn(patch, "secretRefs");
    const resourceRefs = hasResourceRefs ? parseReferenceList(patch.resourceRefs) : undefined;
    const secretRefs = hasSecretRefs ? parseReferenceList(patch.secretRefs) : undefined;
    return {
      ...step,
      ...(hasResourceRefs ? { graphResourceRefs: resourceRefs && resourceRefs.length > 0 ? resourceRefs : undefined } : {}),
      ...(hasSecretRefs ? { graphSecretRefs: secretRefs && secretRefs.length > 0 ? secretRefs : undefined } : {}),
    };
  });
  return changed ? next : steps;
}

export function updateGraphGroupMetadata<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  groupId: string,
  patch: { title?: string; color?: string; collapsedByDefault?: boolean },
): TStep[] {
  const id = groupId.trim();
  if (!id) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (step.graphGroupId !== id) return step;
    changed = true;
    return {
      ...step,
      ...(patch.title !== undefined ? { graphGroupTitle: patch.title.trim() || id } : {}),
      ...(patch.color !== undefined ? { graphGroupColor: patch.color.trim() || "#64748b" } : {}),
      ...(patch.collapsedByDefault !== undefined ? { graphGroupCollapsedByDefault: patch.collapsedByDefault ? true : undefined } : {}),
      ...(patch.collapsedByDefault === true && readBooleanSetting(step.graphGroupCollapsed) === undefined
        ? { graphGroupCollapsed: undefined }
        : {}),
    };
  });
  return changed ? next : steps;
}

export function assignStepsToGroup<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepIds: string[],
  group: { id: string; title?: string; color?: string },
): TStep[] {
  const id = group.id.trim();
  const title = group.title?.trim() || id;
  const color = group.color?.trim() || "#64748b";
  if (!id) return steps;
  const selectedIds = new Set(stepIds.map((stepId) => stepId.trim()).filter(Boolean));
  if (selectedIds.size === 0) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (!selectedIds.has(step.id)) return step;
    changed = true;
    return {
      ...step,
      graphGroupId: id,
      graphGroupTitle: title,
      graphGroupColor: color,
    };
  });
  return changed ? next : steps;
}

export function clearStepsGroup<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepIds: string[],
): TStep[] {
  const selectedIds = new Set(stepIds.map((stepId) => stepId.trim()).filter(Boolean));
  if (selectedIds.size === 0) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (!selectedIds.has(step.id)) return step;
    changed = true;
    return {
      ...step,
      graphGroupId: undefined,
      graphGroupTitle: undefined,
      graphGroupColor: undefined,
      graphGroupCollapsed: undefined,
      graphGroupCollapsedByDefault: undefined,
    };
  });
  return changed ? next : steps;
}

export function setGraphGroupCollapsed<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  groupId: string,
  collapsed: boolean,
): TStep[] {
  const id = groupId.trim();
  if (!id) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (step.graphGroupId !== id) return step;
    changed = true;
    return {
      ...step,
      graphGroupCollapsed: collapsed,
    };
  });
  return changed ? next : steps;
}

export function updateStepNote<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepId: string,
  note: string,
): TStep[] {
  const id = stepId.trim();
  if (!id) return steps;
  const graphNote = note.trim() || undefined;
  let changed = false;
  const next = steps.map((step) => {
    if (step.id !== id) return step;
    changed = true;
    return { ...step, graphNote };
  });
  return changed ? next : steps;
}

export function assignStepsToContainer<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepIds: string[],
  container: {
    id: string;
    type: WorkflowGraphContainerType;
    title?: string;
    description?: string;
    mode?: string;
    condition?: string;
    iterator?: string;
    skipFailure?: boolean;
    runInParallel?: boolean;
    parallelism?: number;
  },
): TStep[] {
  const id = container.id.trim();
  if (!id) return steps;
  const selectedIds = new Set(stepIds.map((stepId) => stepId.trim()).filter(Boolean));
  if (selectedIds.size === 0) return steps;
  const title = container.title?.trim() || id;
  const description = container.description?.trim() || "";
  const mode = normalizeGraphContainerMode(container.type, container.mode);
  const condition = container.condition?.trim() || "";
  const iterator = container.iterator?.trim() || "";
  const parallelism = container.parallelism !== undefined && Number.isFinite(container.parallelism) && container.parallelism > 0
    ? Math.floor(container.parallelism)
    : undefined;
  let changed = false;
  const next = steps.map((step) => {
    if (!selectedIds.has(step.id)) return step;
    changed = true;
    return {
      ...step,
      graphContainerId: id,
      graphContainerType: container.type,
      graphContainerTitle: title,
      graphContainerDescription: description,
      graphContainerMode: mode,
      graphContainerCondition: condition || undefined,
      graphContainerIterator: iterator || undefined,
      graphContainerSkipFailure: container.skipFailure ? true : undefined,
      graphContainerRunInParallel: container.runInParallel ? true : undefined,
      graphContainerParallelism: parallelism,
    };
  });
  return changed ? next : steps;
}

export function clearStepsContainer<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepIds: string[],
): TStep[] {
  const selectedIds = new Set(stepIds.map((stepId) => stepId.trim()).filter(Boolean));
  if (selectedIds.size === 0) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (!selectedIds.has(step.id)) return step;
    changed = true;
    return {
      ...step,
      graphContainerId: undefined,
      graphContainerType: undefined,
      graphContainerTitle: undefined,
      graphContainerDescription: undefined,
      graphContainerMode: undefined,
      graphContainerCondition: undefined,
      graphContainerIterator: undefined,
      graphContainerSkipFailure: undefined,
      graphContainerRunInParallel: undefined,
      graphContainerParallelism: undefined,
    };
  });
  return changed ? next : steps;
}

export function clearWorkflowContainer<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  containerId: string,
): TStep[] {
  const id = containerId.trim();
  if (!id) return steps;
  const stepIds = steps
    .filter((step) => typeof step.graphContainerId === "string" && step.graphContainerId.trim() === id)
    .map((step) => step.id);
  return stepIds.length > 0 ? clearStepsContainer(steps, stepIds) : steps;
}

export function updateContainerMetadata<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  containerId: string,
  patch: {
    type?: WorkflowGraphContainerType;
    title?: string;
    description?: string;
    mode?: string;
    condition?: string;
    iterator?: string;
    skipFailure?: boolean;
    runInParallel?: boolean;
    parallelism?: number;
  },
): TStep[] {
  const id = containerId.trim();
  if (!id) return steps;
  let changed = false;
  const next = steps.map((step) => {
    if (step.graphContainerId !== id) return step;
    changed = true;
    const type = patch.type ?? (step.graphContainerType === "loop" ? "loop" : "branch");
    const hasMode = Object.hasOwn(patch, "mode");
    const hasCondition = Object.hasOwn(patch, "condition");
    const hasIterator = Object.hasOwn(patch, "iterator");
    const hasSkipFailure = Object.hasOwn(patch, "skipFailure");
    const hasRunInParallel = Object.hasOwn(patch, "runInParallel");
    const hasParallelism = Object.hasOwn(patch, "parallelism");
    const parallelism = hasParallelism && patch.parallelism !== undefined && Number.isFinite(patch.parallelism) && patch.parallelism > 0
      ? Math.floor(patch.parallelism)
      : undefined;
    return {
      ...step,
      ...(patch.type ? { graphContainerType: patch.type } : {}),
      ...(patch.title !== undefined ? { graphContainerTitle: patch.title.trim() || id } : {}),
      ...(patch.description !== undefined ? { graphContainerDescription: patch.description.trim() } : {}),
      ...(hasMode ? { graphContainerMode: normalizeGraphContainerMode(type, patch.mode) } : {}),
      ...(hasCondition ? { graphContainerCondition: patch.condition?.trim() || undefined } : {}),
      ...(hasIterator ? { graphContainerIterator: patch.iterator?.trim() || undefined } : {}),
      ...(hasSkipFailure ? { graphContainerSkipFailure: patch.skipFailure ? true : undefined } : {}),
      ...(hasRunInParallel ? { graphContainerRunInParallel: patch.runInParallel ? true : undefined } : {}),
      ...(hasParallelism ? { graphContainerParallelism: parallelism } : {}),
    };
  });
  return changed ? next : steps;
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

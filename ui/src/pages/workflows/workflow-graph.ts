import { parseDependencies } from "./workflow-graph-dependencies.js";
export { normalizeGraphEdgeKind } from "./workflow-graph-edge-kind.js";
export { normalizeGraphRunStatus } from "./workflow-graph-run-status.js";
export { parseDependencies } from "./workflow-graph-dependencies.js";
import type { WorkflowGraphStep } from "./workflow-graph-types-core.js";
import type { WorkflowGraphContainer, WorkflowGraphDraftDiff, WorkflowGraphEdge, WorkflowGraphGroup } from "./workflow-graph-types-model.js";
import type { WorkflowGraphManagementRunInput, WorkflowGraphManagementSummary, WorkflowGraphManagementSummaryInput, WorkflowGraphManagementTile, WorkflowGraphModel, WorkflowGraphStructurePaletteSummary, WorkflowGraphWorkbenchSummary } from "./workflow-graph-types-test.js";
import type { WorkflowGraphDefinitionNavigatorInput, WorkflowGraphDefinitionNavigatorItem, WorkflowGraphDefinitionNavigatorSummary, WorkflowGraphReleaseReviewInput, WorkflowGraphReleaseReviewStage, WorkflowGraphReleaseReviewSummary, WorkflowGraphReleaseReviewTone, WorkflowGraphSearchResult } from "./workflow-graph-types-interface.js";
export type * from "./workflow-graph-types-core.js";
export type * from "./workflow-graph-types-model.js";
export type * from "./workflow-graph-types-test.js";
export type * from "./workflow-graph-types-interface.js";
import { buildStepMap } from "./workflow-graph-step-runtime.js";
import { buildWorkflowGraphModel } from "./workflow-graph-model-build.js";
export { buildWorkflowGraphModel } from "./workflow-graph-model-build.js";

import { readTrimmedString } from "./workflow-graph-value-readers.js";
export { summarizeWorkflowGraphInterface, buildWorkflowGraphRequestFillPreview } from "./workflow-graph-flow-interface.js";
export { getWorkflowGraphStepContext } from "./workflow-graph-step-context.js";
import { summarizeWorkflowGraphTestInputLibrary, buildWorkflowGraphTestPlan } from "./workflow-graph-test-previews.js";
export { summarizeWorkflowGraphTestInputLibrary, buildWorkflowGraphTestRequestPreview, buildWorkflowGraphIterationTestPreview, buildWorkflowGraphSingleStepTestPreview, buildWorkflowGraphTestPlan, buildWorkflowGraphTestExecutionPreview } from "./workflow-graph-test-previews.js";

import { buildWorkflowGraphSelectionSummary } from "./workflow-graph-selection.js";
export { buildWorkflowGraphDataFlowMap, buildWorkflowGraphContainerSummary, expandWorkflowGraphSelection, buildWorkflowGraphSelectionSummary } from "./workflow-graph-selection.js";
export { buildWorkflowGraphInspectorSummary, buildWorkflowGraphFocusLensSummary, buildWorkflowGraphExecutionEvidenceSummary, buildWorkflowGraphRepairPlan } from "./workflow-graph-inspection.js";
export { buildWorkflowGraphFailureRouteSummary, buildWorkflowGraphTestDrawerSummary, buildWorkflowGraphEdgeImpactPreview, buildWorkflowGraphRestartPreview, buildWorkflowGraphRunDebugSummary } from "./workflow-graph-run-views.js";

export { updateStepAdvancedMetadata, updateStepApprovalMetadata, updateStepTestingMetadata, updateStepExecutionMetadata, updateStepDataFlowMetadata, updateStepResourceMetadata, updateGraphGroupMetadata, assignStepsToGroup, clearStepsGroup, setGraphGroupCollapsed, updateStepNote, assignStepsToContainer, clearStepsContainer, clearWorkflowContainer, updateContainerMetadata } from "./workflow-graph-step-updates.js";
import { clearGraphRunOverlay } from "./workflow-graph-structure-edits.js";
export { setStepGraphRunStatus, applyStepRunsToGraphSteps, connectSteps, disconnectSteps, renameWorkflowStep, duplicateWorkflowStep, duplicateWorkflowContainer, removeWorkflowStep, updateGraphEdgeMetadata, applyWorkflowGraphFailureRoute, appendStepAfter, insertWorkflowStepFromPalette } from "./workflow-graph-structure-edits.js";
import { summarizeWorkflowGraphTriggers } from "./workflow-graph-export-yaml.js";
export { summarizeWorkflowGraphTriggers, buildWorkflowGraphExportSnapshot, serializeWorkflowGraphExportSnapshot, parseWorkflowGraphYamlDraft } from "./workflow-graph-export-yaml.js";

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

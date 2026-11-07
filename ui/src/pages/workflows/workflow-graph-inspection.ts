// Workflow graph inspector, focus-lens, execution-evidence and repair-plan view models.
// Split out of workflow-graph.ts (pure move, function bodies unchanged).

import { buildWorkflowGraphSelectionSummary } from "./workflow-graph-selection.js";
import type { WorkflowGraphStep } from "./workflow-graph-types-core.js";
import type { WorkflowGraphFocusLensSummary, WorkflowGraphFocusLensTone, WorkflowGraphInspectorSummary, WorkflowGraphNode, WorkflowGraphRepairItem, WorkflowGraphRepairPlan } from "./workflow-graph-types-model.js";
import type { WorkflowGraphExecutionEvidenceSummary } from "./workflow-graph-types-test.js";
import { buildWorkflowGraphModel } from "./workflow-graph-model-build.js";
import { readTrimmedString } from "./workflow-graph-value-readers.js";
import { getWorkflowGraphStepContext } from "./workflow-graph-step-context.js";

function invariantCountBadge(count: number, label: string): string {
  return `${count} ${label}`;
}

function countConfiguredStepPolicies<TStep extends WorkflowGraphStep>(node: WorkflowGraphNode<TStep> | undefined): number {
  if (!node) return 0;
  const { step, advanced, testing, execution, dataFlow, resources } = node;
  let count = 0;

  if (advanced.onFailure) count += 1;
  if (advanced.maxRetries !== null) count += 1;
  if (advanced.retryDelaySeconds !== null) count += 1;
  if (advanced.retryBackoff) count += 1;
  if (advanced.retryJitter) count += 1;
  if (advanced.timeoutSeconds !== null) count += 1;
  if (advanced.sleepSeconds !== null) count += 1;
  if (advanced.suspendUntil) count += 1;
  if (advanced.suspendTimeoutSeconds !== null) count += 1;
  if (advanced.suspendTimeoutAction) count += 1;
  if (advanced.earlyReturn) count += 1;
  if (advanced.earlyReturnContentType) count += 1;
  if (advanced.earlyReturnSchema) count += 1;
  if (advanced.errorHandler) count += 1;
  if (advanced.errorHandlerScope) count += 1;
  if (advanced.errorHandlerInput) count += 1;
  if (advanced.restartBoundary) count += 1;
  if (advanced.restartStrategy) count += 1;
  if (advanced.restartInput) count += 1;
  if (advanced.earlyStopCondition) count += 1;
  if (advanced.earlyStopLabelSkipped) count += 1;
  if (advanced.approval.required) count += 1;
  if (advanced.approval.prompt) count += 1;
  if (advanced.approval.recipients.length > 0) count += 1;
  if (advanced.approval.timeoutSeconds !== null) count += 1;
  if (advanced.approval.timeoutAction) count += 1;
  if (testing.mockEnabled) count += 1;
  if (testing.mockResult) count += 1;
  if (testing.pinnedResultRunId) count += 1;
  if (execution.concurrencyKey) count += 1;
  if (execution.concurrencyLimit !== null) count += 1;
  if (execution.priority) count += 1;
  if (execution.cacheEnabled) count += 1;
  if (execution.cacheTtlSeconds !== null) count += 1;
  if (execution.deleteAfterUse) count += 1;
  if (dataFlow.inputExpression) count += 1;
  if (dataFlow.outputSchema) count += 1;
  if (dataFlow.workProductRequired) count += 1;
  if (dataFlow.workProductPattern) count += 1;
  if (resources.resourceRefs.length > 0) count += 1;
  if (resources.secretRefs.length > 0) count += 1;
  if (readTrimmedString(step.graphGroupId)) count += 1;
  if (readTrimmedString(step.graphContainerId)) count += 1;
  if (readTrimmedString(step.graphNote)) count += 1;
  return count;
}

export function buildWorkflowGraphInspectorSummary<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  selectedStepId: string,
  selectedPathStepIds: string[] = selectedStepId ? [selectedStepId] : [],
): WorkflowGraphInspectorSummary {
  const graph = buildWorkflowGraphModel(steps);
  const stepId = selectedStepId.trim();
  const node = graph.nodes.find((candidate) => candidate.id === stepId);
  const context = getWorkflowGraphStepContext(steps, stepId);
  const repairPlan = buildWorkflowGraphRepairPlan(steps);
  const selection = buildWorkflowGraphSelectionSummary(steps, selectedPathStepIds);
  const policyCount = countConfiguredStepPolicies(node);
  const selectedLabel = stepId || "No selected step";
  const overviewBadges = [
    repairPlan.items.length === 0 ? "No repairs" : `${repairPlan.items.length} repair${repairPlan.items.length === 1 ? "" : "s"}`,
    selection.blocked ? "No selection" : `${selection.stepIds.length} selected`,
  ];
  const editBadges = [
    invariantCountBadge(context.directDependencyIds.length, "upstream"),
    invariantCountBadge(context.directDependentIds.length, "downstream"),
  ];
  const policyBadge = policyCount === 0 ? "No policies" : `${policyCount} ${policyCount === 1 ? "policy" : "policies"}`;

  return {
    defaultMode: "overview",
    selectedStepId: stepId,
    sections: [
      {
        mode: "overview",
        title: "Overview",
        badges: overviewBadges,
        summary: repairPlan.blocked
          ? `${repairPlan.summary} ${selection.summary}`
          : `Graph is structurally clear. ${selection.summary}`,
      },
      {
        mode: "edit",
        title: "Edit",
        badges: editBadges,
        summary: `${selectedLabel} has ${context.directDependencyIds.length} upstream and ${context.directDependentIds.length} downstream.`,
      },
      {
        mode: "policy",
        title: "Policy",
        badges: [policyBadge],
        summary: policyCount === 0
          ? `${selectedLabel} has no advanced controls configured.`
          : `${selectedLabel} has ${policyCount} advanced controls configured.`,
      },
      {
        mode: "raw",
        title: "Raw",
        badges: ["JSON", selectedLabel],
        summary: `Raw step JSON for ${selectedLabel} stays available without leaving the graph.`,
      },
    ],
  };
}

export function buildWorkflowGraphFocusLensSummary<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  selectedStepId: string,
  selectedPathStepIds: string[] = selectedStepId ? [selectedStepId] : [],
): WorkflowGraphFocusLensSummary {
  const graph = buildWorkflowGraphModel(steps);
  const stepId = selectedStepId.trim() || graph.nodes[0]?.id || "";
  const node = graph.nodes.find((candidate) => candidate.id === stepId);
  const context = getWorkflowGraphStepContext(steps, stepId);
  const repairPlan = buildWorkflowGraphRepairPlan(steps);
  const selection = buildWorkflowGraphSelectionSummary(steps, selectedPathStepIds);
  const policyCount = countConfiguredStepPolicies(node);
  const runStatus = node?.runStatus.status ?? "planned";
  const outputCount = node?.runStatus.workProducts.length ?? 0;
  const issueLabel = node?.runStatus.issueIdentifier || node?.runStatus.issueId || "";
  const hasErrors = graph.diagnostics.issueCountBySeverity.error > 0 || repairPlan.blocked;
  const hasRuntimeFailure = runStatus === "failed";
  const title = node?.label || stepId || "No step selected";
  const kind = node?.kind || "step";
  const tone: WorkflowGraphFocusLensTone = hasRuntimeFailure || hasErrors
    ? "danger"
    : runStatus === "running"
      ? "info"
      : policyCount > 0
        ? "warning"
        : node ? "success" : "neutral";
  const pathValue = `${context.directDependencyIds.length} upstream / ${context.directDependentIds.length} next`;
  const runtimeValue = hasRuntimeFailure
    ? "failed"
    : runStatus === "succeeded"
      ? outputCount > 0 ? `${outputCount} outputs` : "succeeded"
      : runStatus;
  const description = !node
    ? "Select a graph node to inspect its path, policies, runtime evidence, and next actions."
    : hasErrors
      ? `${title} is selected. Resolve structural diagnostics before trusting this graph.`
      : `${title} is selected with ${pathValue}. Details stay available without making the graph secondary.`;

  return {
    selectedStepId: stepId,
    title,
    description,
    tone,
    badges: [
      node ? kind : "no selection",
      repairPlan.items.length === 0 ? "No repairs" : `${repairPlan.items.length} repairs`,
      selection.blocked ? "No path" : `${selection.stepIds.length} path nodes`,
      issueLabel ? `issue ${issueLabel}` : "no issue",
    ],
    metrics: [
      {
        id: "step",
        label: "Step",
        value: kind,
        tone: node ? (kind === "tool" ? "info" : "success") : "neutral",
        detail: node?.id || "No selected node",
      },
      {
        id: "path",
        label: "Path",
        value: pathValue,
        tone: context.missingDependencyIds.length > 0 ? "danger" : "info",
        detail: context.missingDependencyIds.length > 0
          ? `${context.missingDependencyIds.length} missing dependencies`
          : `${context.upstreamStepIds.length} total upstream, ${context.downstreamStepIds.length} total downstream`,
      },
      {
        id: "controls",
        label: "Controls",
        value: policyCount === 0 ? "No policies" : `${policyCount} policies`,
        tone: policyCount > 0 ? "warning" : "neutral",
        detail: policyCount > 0 ? "Advanced controls are configured for this node." : "No advanced controls configured.",
      },
      {
        id: "runtime",
        label: "Runtime",
        value: runtimeValue,
        tone: hasRuntimeFailure ? "danger" : runStatus === "running" ? "info" : runStatus === "succeeded" ? "success" : "neutral",
        detail: issueLabel
          ? `Linked issue ${issueLabel}${outputCount > 0 ? ` with ${outputCount} work products` : ""}.`
          : outputCount > 0
            ? `${outputCount} work products are registered.`
            : "No linked runtime evidence for this selected step.",
      },
    ],
    actions: [
      { id: "edit", label: "Edit", disabled: !node },
      { id: "test", label: "Test", disabled: !node },
      { id: "evidence", label: "Evidence", disabled: !node },
      { id: "policy", label: "Policy", disabled: !node },
      { id: "raw", label: "Raw", disabled: !node },
      { id: "add-after", label: "Add after", disabled: !node },
      { id: "diagnostics", label: graph.diagnostics.issues.length > 0 ? "Diagnostics" : "Health" },
    ],
    detailsHiddenByDefault: true,
  };
}

export function buildWorkflowGraphExecutionEvidenceSummary<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  selectedStepId: string,
): WorkflowGraphExecutionEvidenceSummary {
  const graph = buildWorkflowGraphModel(steps);
  const stepId = selectedStepId.trim() || graph.nodes[0]?.id || "";
  const node = graph.nodes.find((candidate) => candidate.id === stepId);
  const runStatus = node?.runStatus;
  const title = node?.label || stepId || "No step selected";
  const status = runStatus?.status ?? "planned";
  const hasEvidence = Boolean(runStatus && (
    runStatus.stepRunId
    || runStatus.issueIdentifier
    || runStatus.updatedAt
    || runStatus.summary
    || runStatus.resultPreview
    || runStatus.logPreview
    || runStatus.workProducts.length > 0
    || status !== "planned"
  ));
  const hasDispatchError = Boolean(runStatus?.lastDispatchErrorAt || runStatus?.lastDispatchErrorSummary);
  const tone: WorkflowGraphFocusLensTone = !node
    ? "neutral"
    : hasDispatchError || status === "failed"
      ? "danger"
      : status === "succeeded" || (runStatus?.workProducts.length ?? 0) > 0
        ? "success"
        : status === "running"
          ? "info"
          : hasEvidence ? "info" : "neutral";
  const dispatchValue = hasDispatchError
    ? "error"
    : runStatus?.lastDispatchAcceptedAt
      ? "accepted"
      : runStatus?.lastDispatchAttemptAt
        ? "attempted"
        : "none";
  const outputCount = runStatus?.workProducts.length ?? 0;

  return {
    selectedStepId: stepId,
    title,
    tone,
    available: hasEvidence,
    summary: !node
      ? "Select a graph node to inspect run evidence."
      : hasEvidence
        ? `${title} has ${status} run evidence attached to the graph.`
        : `${title} has no run evidence yet. Run or inspect a workflow execution to populate this drawer.`,
    badges: [
      status,
      runStatus?.stepRunId ? `step run ${runStatus.stepRunId}` : "no step run",
      runStatus?.issueIdentifier ? `issue ${runStatus.issueIdentifier}` : "no issue",
      outputCount > 0 ? `${outputCount} output${outputCount === 1 ? "" : "s"}` : "no outputs",
      runStatus?.resultPreview ? "result" : runStatus?.logPreview ? "logs" : "no preview",
    ],
    metrics: [
      {
        id: "status",
        label: "Status",
        value: status,
        tone,
        detail: runStatus?.summary || "No run summary.",
      },
      {
        id: "issue",
        label: "Issue",
        value: runStatus?.issueIdentifier || "none",
        tone: runStatus?.issueIdentifier ? "info" : "neutral",
        detail: runStatus?.issueId || "No linked execution issue.",
      },
      {
        id: "dispatch",
        label: "Dispatch",
        value: dispatchValue,
        tone: hasDispatchError ? "danger" : runStatus?.lastDispatchAcceptedAt ? "success" : "neutral",
        detail: hasDispatchError
          ? runStatus?.lastDispatchErrorSummary || runStatus?.lastDispatchErrorAt || "Dispatch failed."
          : runStatus?.lastDispatchRequestId || "No dispatch request recorded.",
      },
      {
        id: "outputs",
        label: "Outputs",
        value: String(outputCount),
        tone: outputCount > 0 ? "success" : "neutral",
        detail: outputCount > 0 ? `${outputCount} work product${outputCount === 1 ? "" : "s"} registered.` : "No registered outputs.",
      },
    ],
    resultPreview: runStatus?.resultPreview ?? "",
    logPreview: runStatus?.logPreview ?? "",
    workProducts: runStatus?.workProducts ?? [],
  };
}

export function buildWorkflowGraphRepairPlan<TStep extends WorkflowGraphStep>(
  steps: TStep[],
): WorkflowGraphRepairPlan {
  const graph = buildWorkflowGraphModel(steps);
  const items = graph.diagnostics.issues.map((issue): WorkflowGraphRepairItem => {
    if (issue.code === "missing-dependency") {
      const source = issue.sourceId ?? "";
      const target = issue.targetId ?? issue.stepId ?? "";
      return {
        id: issue.id,
        severity: issue.severity,
        issueCode: issue.code,
        action: "connect-or-remove-dependency",
        title: "Resolve missing upstream",
        description: source && target
          ? `Step "${target}" references missing upstream "${source}". Connect it to an existing step or remove that dependency.`
          : issue.message,
        focusStepId: target,
        sourceStepId: source,
        targetStepId: target,
        badges: ["Missing upstream", "Blocks run"],
      };
    }
    if (issue.code === "missing-step-id") {
      return {
        id: issue.id,
        severity: issue.severity,
        issueCode: issue.code,
        action: "assign-step-id",
        title: "Assign step id",
        description: "One graph node has no step id. Give it a stable id before it can be connected or executed.",
        focusStepId: issue.stepId ?? "",
        badges: ["Invalid step", "Blocks run"],
      };
    }
    if (issue.code === "cycle") {
      const target = issue.stepId ?? issue.targetId ?? "";
      return {
        id: issue.id,
        severity: issue.severity,
        issueCode: issue.code,
        action: "disconnect-cycle-edge",
        title: "Break dependency cycle",
        description: target
          ? `Step "${target}" is part of a dependency cycle. Disconnect one cyclic edge before running this workflow.`
          : issue.message,
        focusStepId: target,
        targetStepId: target,
        badges: ["Cycle", "Blocks run"],
      };
    }
    const focus = issue.stepId ?? issue.targetId ?? "";
    return {
      id: issue.id,
      severity: issue.severity,
      issueCode: issue.code,
      action: "inspect-diagnostic",
      title: "Inspect diagnostic",
      description: issue.message,
      focusStepId: focus,
      sourceStepId: issue.sourceId,
      targetStepId: issue.targetId,
      badges: [issue.severity === "error" ? "Blocks run" : issue.severity],
    };
  });

  const blockingCount = items.filter((item) => item.severity === "error").length;
  if (items.length === 0) {
    return {
      items: [],
      badges: ["No repairs"],
      blocked: false,
      summary: "No graph repairs are needed before running this workflow.",
    };
  }

  const badges = [`${items.length} repair${items.length === 1 ? "" : "s"}`];
  if (blockingCount > 0) badges.push(`${blockingCount} blocking`);
  return {
    items,
    badges,
    blocked: blockingCount > 0,
    summary: `${items.length} graph repair${items.length === 1 ? "" : "s"} needed before this workflow can run; ${blockingCount} block execution.`,
  };
}

// Workflow graph run views: failure route, test drawer, edge impact, restart and run-debug summaries.
// Split out of workflow-graph.ts (pure move, function bodies unchanged).

import type { WorkflowGraphRunDebugInput, WorkflowGraphRunDebugSummary, WorkflowGraphRunDebugTileTone, WorkflowGraphRunStatus, WorkflowGraphStep, WorkflowGraphStepRunInput } from "./workflow-graph-types-core.js";
import type { WorkflowGraphFailureRouteOptions, WorkflowGraphFailureRouteSummary, WorkflowGraphIssue, WorkflowGraphTestDrawerSummary } from "./workflow-graph-types-model.js";
import type { WorkflowGraphRestartPreview, WorkflowGraphRestartStep } from "./workflow-graph-types-test.js";
import type { WorkflowGraphEdgeImpactAction, WorkflowGraphEdgeImpactPreview, WorkflowGraphInterfaceInput } from "./workflow-graph-types-interface.js";
import { parseDependencies } from "./workflow-graph-dependencies.js";
import { normalizeGraphRunStatus } from "./workflow-graph-run-status.js";
import { buildStepMap, normalizeWorkProducts } from "./workflow-graph-step-runtime.js";
import { buildWorkflowGraphModel } from "./workflow-graph-model-build.js";
import { readTrimmedString } from "./workflow-graph-value-readers.js";
import { getWorkflowGraphStepContext } from "./workflow-graph-step-context.js";
import { buildWorkflowGraphIterationTestPreview, buildWorkflowGraphSingleStepTestPreview, buildWorkflowGraphTestPlan, summarizeWorkflowGraphTestInputLibrary } from "./workflow-graph-test-previews.js";

function hasPath<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  fromId: string,
  toId: string,
  visited = new Set<string>(),
): boolean {
  if (fromId === toId) return true;
  if (visited.has(fromId)) return false;
  visited.add(fromId);

  const children = steps.filter((step) => parseDependencies(step.dependsOn).includes(fromId));
  return children.some((child) => hasPath(steps, child.id, toId, visited));
}

export function buildWorkflowGraphFailureRouteSummary<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  sourceStepIds: string[],
  handlerStepId: string,
  options: WorkflowGraphFailureRouteOptions = {},
): WorkflowGraphFailureRouteSummary {
  const stepMap = buildStepMap(steps);
  const handler = handlerStepId.trim();
  const label = options.label?.trim() || "Failure route";
  const condition = options.condition?.trim() || "upstream step failed";
  const normalizedSourceSet = new Set(sourceStepIds.map((stepId) => stepId.trim()).filter(Boolean));
  const sourceIds = steps
    .map((step) => step.id.trim())
    .filter((stepId) => normalizedSourceSet.has(stepId) && stepId !== handler);

  if (!handler || !stepMap.has(handler)) {
    return {
      sourceStepIds: sourceIds,
      handlerStepId: handler,
      label,
      condition,
      badges: ["Missing handler", "Blocked"],
      blocked: true,
      summary: "Choose an existing handler step before routing failures.",
    };
  }

  if (normalizedSourceSet.has(handler)) {
    return {
      sourceStepIds: sourceIds,
      handlerStepId: handler,
      label,
      condition,
      badges: ["Handler in selection", "Blocked"],
      blocked: true,
      summary: "The failure handler must sit outside the selected path.",
    };
  }

  if (sourceIds.length === 0) {
    return {
      sourceStepIds: [],
      handlerStepId: handler,
      label,
      condition,
      badges: ["No failure sources", "Blocked"],
      blocked: true,
      summary: "Select at least one source step before routing failures.",
    };
  }

  const cycleSource = sourceIds.find((sourceId) => hasPath(steps, handler, sourceId));
  if (cycleSource) {
    return {
      sourceStepIds: sourceIds,
      handlerStepId: handler,
      label,
      condition,
      badges: ["Cycle risk", "Blocked"],
      blocked: true,
      summary: `Routing ${cycleSource} to ${handler} would create a dependency cycle.`,
    };
  }

  return {
    sourceStepIds: sourceIds,
    handlerStepId: handler,
    label,
    condition,
    badges: [`${sourceIds.length} failure source${sourceIds.length === 1 ? "" : "s"}`, `handler ${handler}`, label],
    blocked: false,
    summary: `${sourceIds.length} selected step${sourceIds.length === 1 ? "" : "s"} will route failures to ${handler}.`,
  };
}

export function buildWorkflowGraphTestDrawerSummary<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  selectedStepId: string,
  interfaceInput: WorkflowGraphInterfaceInput = {},
): WorkflowGraphTestDrawerSummary {
  const graph = buildWorkflowGraphModel(steps);
  const stepId = selectedStepId.trim() || graph.nodes[0]?.id || "";
  const node = graph.nodes.find((candidate) => candidate.id === stepId);
  const targetId = node?.id ?? stepId;
  const testPlan = buildWorkflowGraphTestPlan(steps, targetId);
  const singleStep = buildWorkflowGraphSingleStepTestPreview(steps, targetId, interfaceInput);
  const restart = buildWorkflowGraphRestartPreview(steps, targetId);
  const loopContainer = graph.containers.find((container) => container.type === "loop");
  const iteration = buildWorkflowGraphIterationTestPreview(steps, loopContainer?.id ?? "", 0, {});
  const inputLibrary = summarizeWorkflowGraphTestInputLibrary(interfaceInput);
  const blocked = !node || testPlan.blocked || singleStep.blocked || restart.blocked;
  const title = node?.label || targetId || "No step selected";

  return {
    selectedStepId: targetId,
    title,
    tone: blocked ? "warning" : "info",
    summary: !node
      ? "Select a graph node before opening execution tests."
      : `Test drawer is ready for ${title}. Run this step, test up to it, or restart from it while keeping the graph visible.`,
    badges: [
      node ? node.kind : "no selection",
      testPlan.blocked ? "test blocked" : "test ready",
      restart.blocked ? "restart blocked" : "restartable",
      ...inputLibrary.badges.slice(0, 1),
    ],
    modes: [
      {
        id: "test-flow",
        title: "Test up to selected step",
        tone: testPlan.blocked ? "danger" : "success",
        badges: testPlan.badges,
        summary: testPlan.summary,
      },
      {
        id: "test-step",
        title: "Test this step",
        tone: singleStep.blocked ? "danger" : "info",
        badges: singleStep.badges,
        summary: singleStep.summary,
      },
      {
        id: "restart",
        title: "Restart from selected step",
        tone: restart.blocked ? "danger" : "warning",
        badges: restart.badges,
        summary: restart.summary,
      },
      {
        id: "iteration",
        title: "Test iteration",
        tone: iteration.blocked ? "neutral" : "info",
        badges: iteration.badges,
        summary: iteration.summary,
      },
      {
        id: "inputs",
        title: "Saved inputs",
        tone: inputLibrary.presets.length > 0 ? "success" : "neutral",
        badges: inputLibrary.badges,
        summary: inputLibrary.presets.length > 0
          ? `${inputLibrary.presets.length} saved input preset${inputLibrary.presets.length === 1 ? "" : "s"} can seed this test run.`
          : "No saved input presets are configured for this workflow.",
      },
    ],
  };
}

export function buildWorkflowGraphEdgeImpactPreview<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  sourceStepId: string,
  targetStepId: string,
  action: WorkflowGraphEdgeImpactAction,
): WorkflowGraphEdgeImpactPreview {
  const source = sourceStepId.trim();
  const target = targetStepId.trim();
  const stepMap = buildStepMap(steps);
  const normalizedAction: WorkflowGraphEdgeImpactAction = action === "disconnect" ? "disconnect" : "connect";
  const base = {
    action: normalizedAction,
    sourceStepId: source,
    targetStepId: target,
    impactedStepIds: [],
    downstreamStepIds: [],
  };

  if (!source || !target || !stepMap.has(source) || !stepMap.has(target)) {
    return {
      ...base,
      badges: ["Missing step", "Blocked"],
      blocked: true,
      summary: "Choose existing source and target steps before previewing edge impact.",
    };
  }
  if (source === target) {
    return {
      ...base,
      badges: ["Self edge", "Blocked"],
      blocked: true,
      summary: "A workflow step cannot depend on itself.",
    };
  }

  const targetDependencies = parseDependencies(stepMap.get(target)?.dependsOn);
  const edgeExists = targetDependencies.includes(source);
  if (normalizedAction === "connect" && !edgeExists && hasPath(steps, target, source)) {
    return {
      ...base,
      badges: ["Cycle risk", "Blocked"],
      blocked: true,
      summary: `Connecting ${source} -> ${target} would create a dependency cycle.`,
    };
  }
  if (normalizedAction === "disconnect" && !edgeExists) {
    return {
      ...base,
      badges: ["No edge", "Blocked"],
      blocked: true,
      summary: `No existing edge connects ${source} -> ${target}.`,
    };
  }

  const context = getWorkflowGraphStepContext(steps, target);
  const downstreamStepIds = context.downstreamStepIds;
  const impactedStepIds = [target, ...downstreamStepIds];
  const actionLabel = normalizedAction === "connect" ? "Connect edge" : "Remove edge";
  const alreadyConnectedBadge = normalizedAction === "connect" && edgeExists ? "Existing edge" : undefined;
  const badges = [
    actionLabel,
    `${impactedStepIds.length} impacted`,
    alreadyConnectedBadge,
  ].filter((badge): badge is string => Boolean(badge));
  return {
    ...base,
    impactedStepIds,
    downstreamStepIds,
    badges,
    blocked: false,
    summary: `${normalizedAction === "connect" ? "Connecting" : "Removing"} ${source} -> ${target} will affect ${impactedStepIds.join(", ")}.`,
  };
}

export function buildWorkflowGraphRestartPreview<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  restartStepId: string,
): WorkflowGraphRestartPreview {
  const graph = buildWorkflowGraphModel(steps);
  const normalizedRestartStepId = restartStepId.trim();
  const nodeIds = graph.nodes.map((node) => node.id).filter(Boolean);
  const restartExists = normalizedRestartStepId ? nodeIds.includes(normalizedRestartStepId) : false;
  if (!restartExists) {
    return {
      restartStepId: normalizedRestartStepId,
      reusedStepIds: [],
      rerunStepIds: [],
      blockedStepIds: [],
      blocked: true,
      steps: [],
      badges: ["No restart step", "Blocked"],
      summary: "Choose an existing step before previewing restart.",
    };
  }

  const context = getWorkflowGraphStepContext(steps, normalizedRestartStepId);
  const reusedSet = new Set(context.upstreamStepIds);
  const rerunSet = new Set([normalizedRestartStepId, ...context.downstreamStepIds]);
  const issuesByStepId = new Map<string, WorkflowGraphIssue[]>();
  for (const issue of graph.diagnostics.issues) {
    const stepId = issue.stepId ?? issue.targetId ?? "";
    if (!stepId) continue;
    const issues = issuesByStepId.get(stepId) ?? [];
    issues.push(issue);
    issuesByStepId.set(stepId, issues);
  }

  const previewSteps = graph.nodes.map((node): WorkflowGraphRestartStep => {
    const issues = issuesByStepId.get(node.id) ?? [];
    const hasBlockingIssue = issues.some((issue) => issue.severity === "error");
    if (hasBlockingIssue && !reusedSet.has(node.id) && !rerunSet.has(node.id)) {
      return {
        stepId: node.id,
        title: node.label,
        kind: node.kind,
        mode: "blocked",
        reason: issues.map((issue) => issue.message).join("; "),
        badges: ["Missing dependency"],
      };
    }
    if (reusedSet.has(node.id)) {
      return {
        stepId: node.id,
        title: node.label,
        kind: node.kind,
        mode: "reused",
        reason: "Previous result can be reused when restarting from the selected step.",
        badges: ["Reuse previous result"],
      };
    }
    return {
      stepId: node.id,
      title: node.label,
      kind: node.kind,
      mode: "rerun",
      reason: node.id === normalizedRestartStepId
        ? "This is the selected restart boundary."
        : "Downstream of the restart boundary and will run again.",
      badges: [node.id === normalizedRestartStepId ? "Restart here" : "Rerun downstream"],
    };
  });

  const reusedStepIds = nodeIds.filter((stepId) => reusedSet.has(stepId));
  const rerunStepIds = nodeIds.filter((stepId) => rerunSet.has(stepId));
  const blockedStepIds = previewSteps.filter((step) => step.mode === "blocked").map((step) => step.stepId);
  const badges = [
    `Reuse ${reusedStepIds.length} previous`,
    `Rerun ${rerunStepIds.length} step${rerunStepIds.length === 1 ? "" : "s"}`,
  ];
  if (blockedStepIds.length > 0) {
    badges.push(`${blockedStepIds.length} blocked outside restart`);
  }

  return {
    restartStepId: normalizedRestartStepId,
    reusedStepIds,
    rerunStepIds,
    blockedStepIds,
    blocked: false,
    steps: previewSteps,
    badges,
    summary: `Restart from ${normalizedRestartStepId} will reuse ${reusedStepIds.length} previous step${reusedStepIds.length === 1 ? "" : "s"} and rerun ${rerunStepIds.length} step${rerunStepIds.length === 1 ? "" : "s"}.`,
  };
}

export function buildWorkflowGraphRunDebugSummary<TStep extends WorkflowGraphStep>(
  input: WorkflowGraphRunDebugInput<TStep>,
): WorkflowGraphRunDebugSummary {
  const steps = Array.isArray(input.steps) ? input.steps : [];
  const stepRuns = Array.isArray(input.stepRuns) ? input.stepRuns : [];
  const runByStepId = new Map<string, WorkflowGraphStepRunInput>();
  for (const run of stepRuns) {
    const stepId = readTrimmedString(run.stepId);
    if (stepId) runByStepId.set(stepId, run);
  }
  const counts = {
    total: steps.length,
    planned: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    paused: 0,
    issues: 0,
    workProducts: 0,
  };
  const statusByStepId = new Map<string, WorkflowGraphRunStatus>();
  for (const step of steps) {
    const stepId = readTrimmedString(step.id);
    const run = runByStepId.get(stepId);
    const status = run ? normalizeGraphRunStatus(run.status) : "planned";
    statusByStepId.set(stepId, status);
    counts[status] += 1;
    if (run?.issueId || run?.issueIdentifier) counts.issues += 1;
    counts.workProducts += normalizeWorkProducts(run?.workProducts).length;
  }

  const failedStep = steps.find((step) => statusByStepId.get(readTrimmedString(step.id)) === "failed");
  const runningStep = steps.find((step) => statusByStepId.get(readTrimmedString(step.id)) === "running");
  const selectedStepId = readTrimmedString(input.selectedStepId);
  const selectedStep = selectedStepId ? steps.find((step) => readTrimmedString(step.id) === selectedStepId) : undefined;
  const succeededSteps = steps.filter((step) => statusByStepId.get(readTrimmedString(step.id)) === "succeeded");
  const focusStep = failedStep ?? runningStep ?? selectedStep ?? succeededSteps.at(-1) ?? steps[0];
  const focusStepId = readTrimmedString(focusStep?.id);
  const restartPreview = buildWorkflowGraphRestartPreview(steps, focusStepId);
  const focusRun = focusStepId ? runByStepId.get(focusStepId) : undefined;
  const focusStatus = focusStepId ? statusByStepId.get(focusStepId) ?? "planned" : "planned";
  const focusTitle = readTrimmedString(focusStep?.title) || focusStepId || "No step selected";
  const available = steps.length > 0 && stepRuns.length > 0;
  const tone: WorkflowGraphRunDebugTileTone = counts.failed > 0
    ? "danger"
    : counts.running > 0
      ? "info"
      : counts.succeeded > 0
        ? "success"
        : available ? "neutral" : "warning";
  const title = !available
    ? "Run detail unavailable"
    : counts.failed > 0
      ? "Focus failed step"
      : counts.running > 0
        ? "Follow running step"
        : "Run overlay ready";
  const focusSummary = readTrimmedString(focusRun?.lastDispatchErrorSummary)
    || readTrimmedString(focusRun?.metadata?.summary)
    || readTrimmedString(focusRun?.agentName)
    || `${focusTitle} is ${focusStatus}.`;
  const summary = !available
    ? "Select a run with loaded step details to inspect graph execution."
    : `${focusTitle} is ${focusStatus}; ${counts.succeeded} succeeded, ${counts.failed} failed, ${counts.running} running.`;
  const failedLabel = failedStep ? readTrimmedString(failedStep.title) || readTrimmedString(failedStep.id) : "None";

  return {
    available,
    focusStepId,
    title,
    summary,
    tone,
    badges: [
      `${counts.succeeded} succeeded`,
      `${counts.failed} failed`,
      `${counts.running} running`,
      focusStepId ? `focus ${focusStepId}` : "no focus",
    ],
    counts,
    restartPreview,
    tiles: [
      {
        id: "completed",
        title: "Completed",
        status: `${counts.succeeded} steps`,
        tone: counts.succeeded > 0 ? "success" : "neutral",
        summary: counts.succeeded > 0
          ? `${counts.succeeded} upstream or completed step${counts.succeeded === 1 ? "" : "s"} can provide context.`
          : "No completed steps are available in this run detail.",
        badges: [`${counts.succeeded} succeeded`, `${counts.skipped} skipped`],
      },
      {
        id: "failure",
        title: "Failure point",
        status: counts.failed > 0 ? failedLabel : focusStatus,
        tone: counts.failed > 0 ? "danger" : counts.running > 0 ? "info" : "success",
        summary: counts.failed > 0 ? focusSummary : `${focusTitle} is the current run focus.`,
        badges: [`${counts.failed} failed`, focusStepId ? focusStepId : "no focus"],
      },
      {
        id: "restart",
        title: "Restart plan",
        status: restartPreview.blocked ? "blocked" : `rerun ${restartPreview.rerunStepIds.length}`,
        tone: restartPreview.blocked ? "danger" : "warning",
        summary: restartPreview.summary,
        badges: restartPreview.badges,
      },
      {
        id: "evidence",
        title: "Evidence",
        status: `${counts.issues} issues`,
        tone: counts.workProducts > 0 ? "success" : counts.issues > 0 ? "info" : "neutral",
        summary: `${counts.issues} linked issue${counts.issues === 1 ? "" : "s"} and ${counts.workProducts} work product${counts.workProducts === 1 ? "" : "s"} are attached to this run.`,
        badges: [`${counts.issues} issues`, `${counts.workProducts} work products`],
      },
    ],
  };
}

export {
  hasPath,
};

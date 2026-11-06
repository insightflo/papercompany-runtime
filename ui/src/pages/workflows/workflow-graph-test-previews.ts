// Workflow graph test previews: input library, request/iteration/single-step previews, test plan and execution preview.
// Split out of workflow-graph.ts (pure move, function bodies unchanged).

import { readTrimmedString, readPlainObject, readArrayLike } from "./workflow-graph-value-readers.js";
import { summarizeWorkflowGraphInterface, parseFlowInputDefaultValue, readPresetArgs } from "./workflow-graph-flow-interface.js";
import { getWorkflowGraphStepContext } from "./workflow-graph-step-context.js";
import type { WorkflowGraphStep } from "./workflow-graph-types-core.js";
import type { WorkflowGraphIssue } from "./workflow-graph-types-model.js";
import type { WorkflowGraphIterationTestPreview, WorkflowGraphSingleStepTestContextResult, WorkflowGraphSingleStepTestPreview, WorkflowGraphTestExecutionPreview, WorkflowGraphTestExecutionStep, WorkflowGraphTestInputLibrarySummary, WorkflowGraphTestInputPreset, WorkflowGraphTestPlan, WorkflowGraphTestRequestPreview } from "./workflow-graph-types-test.js";
import type { WorkflowGraphInterfaceInput } from "./workflow-graph-types-interface.js";
import { buildWorkflowGraphModel } from "./workflow-graph-model-build.js";

export function summarizeWorkflowGraphTestInputLibrary(
  input: WorkflowGraphInterfaceInput,
): WorkflowGraphTestInputLibrarySummary {
  const legacyMetadata = readPlainObject(input.legacyMetadata);
  const rawPresets = readArrayLike(
    input.graphTestInputPresets
      ?? input.testInputPresets
      ?? legacyMetadata.graphTestInputPresets
      ?? legacyMetadata.testInputPresets,
  );
  const seen = new Set<string>();
  const presets: WorkflowGraphTestInputPreset[] = [];
  for (const entry of rawPresets) {
    const record = readPlainObject(entry);
    const name = readTrimmedString(record.name ?? record.title ?? record.id);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const args = readPresetArgs(record);
    presets.push({
      name,
      args,
      requestJson: `${JSON.stringify({ args }, null, 2)}\n`,
    });
  }
  return {
    presets,
    badges: presets.length > 0
      ? [`${presets.length} saved input${presets.length === 1 ? "" : "s"}`]
      : ["No saved inputs"],
  };
}

export function buildWorkflowGraphTestRequestPreview(
  input: WorkflowGraphInterfaceInput,
  selectedPresetName = "",
  fillArguments?: Record<string, unknown>,
): WorkflowGraphTestRequestPreview {
  const flowInterface = summarizeWorkflowGraphInterface(input);
  const baseArgs = Object.fromEntries(
    flowInterface.inputs.map((flowInput) => [flowInput.name, parseFlowInputDefaultValue(flowInput)]),
  );
  const inputLibrary = summarizeWorkflowGraphTestInputLibrary(input);
  const selectedPreset = inputLibrary.presets.find((preset) => preset.name === selectedPresetName.trim());
  const args = { ...baseArgs, ...(selectedPreset ? selectedPreset.args : {}), ...(fillArguments ?? {}) };
  const envPreview = Object.fromEntries(
    flowInterface.envVariables.map((envVariable) => [
      envVariable.name,
      envVariable.secret ? "<secret>" : envVariable.value,
    ]),
  );
  const requiredInputNames = flowInterface.inputs.filter((flowInput) => flowInput.required).map((flowInput) => flowInput.name);
  const secretEnvCount = flowInterface.envVariables.filter((envVariable) => envVariable.secret).length;
  const badges: string[] = [];
  if (flowInterface.inputs.length > 0) badges.push(`${flowInterface.inputs.length} arg${flowInterface.inputs.length === 1 ? "" : "s"}`);
  if (requiredInputNames.length > 0) badges.push(`${requiredInputNames.length} required`);
  if (flowInterface.envVariables.length > 0) badges.push(`${flowInterface.envVariables.length} env var${flowInterface.envVariables.length === 1 ? "" : "s"}`);
  if (secretEnvCount > 0) badges.push(`${secretEnvCount} secret`);
  if (selectedPreset) badges.push(`Preset ${selectedPreset.name}`);
  if (badges.length === 0) badges.push("No test inputs");
  return {
    arguments: args,
    envPreview,
    requiredInputNames,
    badges,
    requestJson: `${JSON.stringify({ args, env: envPreview }, null, 2)}\n`,
  };
}

export function buildWorkflowGraphIterationTestPreview<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  containerId: string,
  iterationIndex = 0,
  iterationValue: unknown = {},
): WorkflowGraphIterationTestPreview {
  const graph = buildWorkflowGraphModel(steps);
  const normalizedContainerId = containerId.trim();
  const container = graph.containers.find((candidate) => candidate.id === normalizedContainerId && candidate.type === "loop");
  const normalizedIterationIndex = Number.isInteger(iterationIndex) && iterationIndex >= 0 ? iterationIndex : 0;
  const allStepIds = graph.nodes.map((node) => node.id).filter(Boolean);

  if (!container) {
    return {
      containerId: normalizedContainerId,
      title: normalizedContainerId,
      iterationIndex: normalizedIterationIndex,
      iterationValue,
      iteratorExpression: "",
      stepIds: [],
      skippedStepIds: allStepIds,
      parallelism: null,
      skipFailure: false,
      runInParallel: false,
      blocked: true,
      badges: ["No loop container", "Blocked"],
      summary: "Choose a loop container before testing an iteration.",
      requestJson: `${JSON.stringify({
        loop: normalizedContainerId,
        iteration: normalizedIterationIndex,
        item: iterationValue,
        steps: [],
      }, null, 2)}\n`,
    };
  }

  const loopStepIds = container.stepIds.filter((stepId) => allStepIds.includes(stepId));
  const skippedStepIds = allStepIds.filter((stepId) => !loopStepIds.includes(stepId));
  const badges = [
    `Iteration ${normalizedIterationIndex}`,
    `${loopStepIds.length} loop step${loopStepIds.length === 1 ? "" : "s"}`,
  ];
  if (container.iterator) badges.push(`Iterator ${container.iterator}`);
  if (container.runInParallel && container.parallelism !== null) badges.push(`Parallel x${container.parallelism}`);
  else if (container.runInParallel) badges.push("Parallel");
  if (container.skipFailure) badges.push("Skip failure");
  const blocked = loopStepIds.length === 0;
  if (blocked) badges.push("Blocked");
  return {
    containerId: container.id,
    title: container.title,
    iterationIndex: normalizedIterationIndex,
    iterationValue,
    iteratorExpression: container.iterator,
    stepIds: loopStepIds,
    skippedStepIds,
    parallelism: container.parallelism,
    skipFailure: container.skipFailure,
    runInParallel: container.runInParallel,
    blocked,
    badges,
    summary: `Test iteration ${normalizedIterationIndex} of ${container.title} will run ${loopStepIds.length} loop step${loopStepIds.length === 1 ? "" : "s"}.`,
    requestJson: `${JSON.stringify({
      loop: container.id,
      iteration: normalizedIterationIndex,
      iterator: container.iterator,
      item: iterationValue,
      steps: loopStepIds,
      skipped_steps: skippedStepIds,
      parallelism: container.parallelism,
      skip_failure: container.skipFailure,
    }, null, 2)}\n`,
  };
}

export function buildWorkflowGraphSingleStepTestPreview<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  stepId: string,
  input: WorkflowGraphInterfaceInput,
  fillArguments?: Record<string, unknown>,
): WorkflowGraphSingleStepTestPreview {
  const graph = buildWorkflowGraphModel(steps);
  const normalizedStepId = stepId.trim();
  const node = graph.nodes.find((candidate) => candidate.id === normalizedStepId);
  const context = node
    ? getWorkflowGraphStepContext(steps, normalizedStepId)
    : {
      stepId: normalizedStepId,
      directDependencyIds: [],
      directDependentIds: [],
      upstreamStepIds: [],
      downstreamStepIds: [],
      missingDependencyIds: [],
    };
  const nodeById = new Map(graph.nodes.map((graphNode) => [graphNode.id, graphNode]));
  const contextResults = context.upstreamStepIds.flatMap((upstreamStepId): WorkflowGraphSingleStepTestContextResult[] => {
    const upstreamNode = nodeById.get(upstreamStepId);
    if (!upstreamNode) return [];
    if (upstreamNode.testing.mockEnabled) {
      const badges = ["Mocked"];
      if (upstreamNode.testing.mockResult) badges.push("Mock result");
      return [{
        stepId: upstreamNode.id,
        title: upstreamNode.label,
        kind: upstreamNode.kind,
        mode: "mocked",
        badges,
        value: parseJsonPreviewValue(upstreamNode.testing.mockResult),
      }];
    }
    if (upstreamNode.testing.pinnedResultRunId) {
      return [{
        stepId: upstreamNode.id,
        title: upstreamNode.label,
        kind: upstreamNode.kind,
        mode: "pinned",
        badges: ["Pinned result", upstreamNode.testing.pinnedResultRunId],
        pinnedResultRunId: upstreamNode.testing.pinnedResultRunId,
      }];
    }
    return [{
      stepId: upstreamNode.id,
      title: upstreamNode.label,
      kind: upstreamNode.kind,
      mode: "unavailable",
      badges: ["Needs prior result"],
    }];
  });
  const flowArguments = buildWorkflowGraphTestRequestPreview(input, "", fillArguments).arguments;
  const stepArguments = parseStepArguments(node?.step);
  const blocked = !node || context.missingDependencyIds.length > 0;
  const mockedCount = contextResults.filter((result) => result.mode === "mocked").length;
  const pinnedCount = contextResults.filter((result) => result.mode === "pinned").length;
  const unavailableCount = contextResults.filter((result) => result.mode === "unavailable").length;
  const badges = [node ? `Test step ${normalizedStepId}` : "No target step"];
  if (context.upstreamStepIds.length > 0) badges.push(`${context.upstreamStepIds.length} upstream context`);
  if (mockedCount > 0) badges.push(`${mockedCount} mocked upstream`);
  if (pinnedCount > 0) badges.push(`${pinnedCount} pinned upstream`);
  if (unavailableCount > 0) badges.push(`${unavailableCount} missing prior result`);
  if (context.downstreamStepIds.length > 0) badges.push(`${context.downstreamStepIds.length} downstream skipped`);
  if (context.missingDependencyIds.length > 0) badges.push(`${context.missingDependencyIds.length} missing dependenc${context.missingDependencyIds.length === 1 ? "y" : "ies"}`);
  if (blocked) badges.push("Blocked");
  const results = Object.fromEntries(contextResults.map((result) => [
    result.stepId,
    result.mode === "mocked"
      ? result.value
      : result.mode === "pinned"
        ? { pinnedResultRunId: result.pinnedResultRunId }
        : { unavailable: true },
  ]));
  return {
    stepId: normalizedStepId,
    title: node?.label ?? normalizedStepId,
    kind: node?.kind ?? "",
    flowArguments,
    stepArguments,
    inputExpression: node?.dataFlow.inputExpression ?? "",
    upstreamContextStepIds: context.upstreamStepIds,
    downstreamStepIds: context.downstreamStepIds,
    missingDependencyIds: context.missingDependencyIds,
    contextResults,
    blocked,
    badges,
    summary: node
      ? `Test this step will run only ${normalizedStepId} with ${context.upstreamStepIds.length} upstream context step${context.upstreamStepIds.length === 1 ? "" : "s"}.`
      : "Choose an existing step before testing a single step.",
    requestJson: `${JSON.stringify({
      flow_input: flowArguments,
      step_input: stepArguments,
      input_expression: node?.dataFlow.inputExpression ?? "",
      results,
    }, null, 2)}\n`,
  };
}

function parseJsonPreviewValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

function parseStepArguments(step: WorkflowGraphStep | undefined): Record<string, unknown> {
  if (!step || typeof step.toolArgs !== "string") return {};
  const parsed = parseJsonPreviewValue(step.toolArgs);
  return readPlainObject(parsed);
}

export function buildWorkflowGraphTestPlan<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  targetStepId: string,
): WorkflowGraphTestPlan {
  const graph = buildWorkflowGraphModel(steps);
  const normalizedTargetStepId = targetStepId.trim();
  const nodeIds = graph.nodes.map((node) => node.id).filter(Boolean);
  const targetExists = normalizedTargetStepId ? nodeIds.includes(normalizedTargetStepId) : false;
  const context = targetExists
    ? getWorkflowGraphStepContext(steps, normalizedTargetStepId)
    : {
      stepId: normalizedTargetStepId,
      directDependencyIds: [],
      directDependentIds: [],
      upstreamStepIds: [],
      downstreamStepIds: [],
      missingDependencyIds: [],
    };
  const includedIds = new Set<string>(targetExists ? [...context.upstreamStepIds, normalizedTargetStepId] : []);
  const stepIds = nodeIds.filter((stepId) => includedIds.has(stepId));
  const excludedStepIds = nodeIds.filter((stepId) => !includedIds.has(stepId));
  const includedDiagnostics = graph.diagnostics.issues.filter((issue) => {
    const relatedStepId = issue.stepId ?? issue.targetId ?? "";
    return relatedStepId ? includedIds.has(relatedStepId) : issue.severity === "error";
  });
  const blocked = !targetExists
    || context.missingDependencyIds.length > 0
    || includedDiagnostics.some((issue) => issue.severity === "error");
  const badges = [
    `Test ${stepIds.length} step${stepIds.length === 1 ? "" : "s"}`,
    targetExists ? `Stop at ${normalizedTargetStepId}` : "No target step",
  ];
  if (excludedStepIds.length > 0) {
    badges.push(`Skip ${excludedStepIds.length} downstream`);
  }
  if (blocked) {
    badges.push("Blocked");
  }

  let summary = targetExists
    ? `Test will run ${stepIds.length} step${stepIds.length === 1 ? "" : "s"} through ${normalizedTargetStepId}`
    : "Choose an existing step before testing this flow";
  if (targetExists && excludedStepIds.length > 0) {
    summary += ` and skip ${excludedStepIds.length} downstream step${excludedStepIds.length === 1 ? "" : "s"}`;
  }
  summary += ".";

  return {
    targetStepId: normalizedTargetStepId,
    stepIds,
    excludedStepIds,
    missingDependencyIds: context.missingDependencyIds,
    blocked,
    badges,
    summary,
  };
}

export function buildWorkflowGraphTestExecutionPreview<TStep extends WorkflowGraphStep>(
  steps: TStep[],
  targetStepId: string,
): WorkflowGraphTestExecutionPreview {
  const graph = buildWorkflowGraphModel(steps);
  const plan = buildWorkflowGraphTestPlan(steps, targetStepId);
  const includedIds = new Set(plan.stepIds);
  const issuesByStepId = new Map<string, WorkflowGraphIssue[]>();
  for (const issue of graph.diagnostics.issues) {
    const stepId = issue.stepId ?? issue.targetId ?? "";
    if (!stepId) continue;
    const issues = issuesByStepId.get(stepId) ?? [];
    issues.push(issue);
    issuesByStepId.set(stepId, issues);
  }

  const previewSteps = graph.nodes.map((node): WorkflowGraphTestExecutionStep => {
    const issues = issuesByStepId.get(node.id) ?? [];
    const hasBlockingIssue = issues.some((issue) => issue.severity === "error");
    if (hasBlockingIssue && !includedIds.has(node.id)) {
      return {
        stepId: node.id,
        title: node.label,
        kind: node.kind,
        mode: "blocked",
        reason: issues.map((issue) => issue.message).join("; "),
        badges: ["Missing dependency"],
      };
    }
    if (!includedIds.has(node.id)) {
      return {
        stepId: node.id,
        title: node.label,
        kind: node.kind,
        mode: "skipped",
        reason: "Downstream of the selected test target.",
        badges: ["Skipped downstream"],
      };
    }
    if (node.testing.mockEnabled) {
      const badges = ["Mocked"];
      if (node.testing.mockResult) badges.push("Mock result");
      return {
        stepId: node.id,
        title: node.label,
        kind: node.kind,
        mode: "mocked",
        reason: "Uses the configured mock result instead of dispatching the step.",
        badges,
      };
    }
    if (node.testing.pinnedResultRunId) {
      return {
        stepId: node.id,
        title: node.label,
        kind: node.kind,
        mode: "pinned",
        reason: "Replays a pinned run or step result for this test.",
        badges: ["Pinned result", node.testing.pinnedResultRunId],
      };
    }
    return {
      stepId: node.id,
      title: node.label,
      kind: node.kind,
      mode: "will-run",
      reason: "Dispatches during this test preview.",
      badges: ["Runs in test"],
    };
  });

  const mockCount = previewSteps.filter((step) => step.mode === "mocked").length;
  const pinnedCount = previewSteps.filter((step) => step.mode === "pinned").length;
  const skippedCount = previewSteps.filter((step) => step.mode === "skipped").length;
  const blockedCount = previewSteps.filter((step) => step.mode === "blocked").length;
  const badges = [`${plan.stepIds.length} included`];
  if (mockCount > 0) badges.push(`${mockCount} mock${mockCount === 1 ? "" : "s"}`);
  if (pinnedCount > 0) badges.push(`${pinnedCount} pinned`);
  if (skippedCount > 0) badges.push(`${skippedCount} skipped`);
  if (blockedCount > 0) badges.push(`${blockedCount} blocked`);

  const summaryParts = [`Test preview includes ${plan.stepIds.length} step${plan.stepIds.length === 1 ? "" : "s"}`];
  if (mockCount > 0) summaryParts.push(`uses ${mockCount} mock${mockCount === 1 ? "" : "s"}`);
  if (pinnedCount > 0) summaryParts.push(`replays ${pinnedCount} pinned result${pinnedCount === 1 ? "" : "s"}`);
  if (skippedCount > 0) summaryParts.push(`skips ${skippedCount} downstream step${skippedCount === 1 ? "" : "s"}`);
  if (blockedCount > 0) summaryParts.push(`blocks ${blockedCount} step${blockedCount === 1 ? "" : "s"} with missing dependencies`);

  const summary = summaryParts.length === 1
    ? `${summaryParts[0]}.`
    : `${summaryParts.slice(0, -1).join(", ")}, and ${summaryParts.at(-1)}.`;

  return {
    targetStepId: plan.targetStepId,
    steps: previewSteps,
    badges,
    summary,
  };
}

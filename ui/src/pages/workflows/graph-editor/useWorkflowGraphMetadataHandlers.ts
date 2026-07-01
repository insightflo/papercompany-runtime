import { parseOptionalNonNegativeInteger, parseOptionalPositiveInteger, type StepDraft } from "../step-draft.js";
import { updateGraphEdgeMetadata, updateStepAdvancedMetadata, updateStepApprovalMetadata, updateStepDataFlowMetadata, updateStepExecutionMetadata, updateStepNote, updateStepResourceMetadata, updateStepTestingMetadata, updateContainerMetadata, updateGraphGroupMetadata } from "../workflow-graph.js";

export function useWorkflowGraphMetadataHandlers({
  steps,
  onChange,
  selectedStep,
  setGraphError,
}: {
  steps: StepDraft[];
  onChange: (steps: StepDraft[]) => void;
  selectedStep: StepDraft | null;
  setGraphError: (error: string) => void;
}) {
  function updateSelected(patch: Partial<StepDraft>): void {
    if (!selectedStep) return;
    onChange(steps.map((step) => (step.id === selectedStep.id ? { ...step, ...patch } : step)));
  }

  function updateEdge(sourceId: string, patch: { kind?: string; label?: string; condition?: string }): void {
    if (!selectedStep) return;
    setGraphError("");
    onChange(updateGraphEdgeMetadata(steps, sourceId, selectedStep.id, patch));
  }

  function updateSelectedGroupMetadata(patch: { title?: string; color?: string; collapsedByDefault?: boolean }): void {
    if (!selectedStep) return;
    const groupId = selectedStep.graphGroupId.trim();
    if (!groupId) {
      onChange(steps.map((step) => step.id === selectedStep.id ? {
        ...step,
        ...(patch.title !== undefined ? { graphGroupTitle: patch.title } : {}),
        ...(patch.color !== undefined ? { graphGroupColor: patch.color } : {}),
        ...(patch.collapsedByDefault !== undefined ? { graphGroupCollapsedByDefault: patch.collapsedByDefault } : {}),
      } : step));
      return;
    }
    onChange(updateGraphGroupMetadata(steps, groupId, patch));
  }

  function updateSelectedAdvanced(patch: Partial<Pick<StepDraft, "onFailure" | "maxRetries" | "graphRetryDelaySeconds" | "graphRetryBackoff" | "graphRetryJitter" | "timeoutSeconds" | "graphSleepSeconds" | "graphSuspendUntil" | "graphSuspendTimeoutSeconds" | "graphSuspendTimeoutAction" | "graphEarlyReturn" | "graphEarlyReturnContentType" | "graphEarlyReturnSchema" | "graphErrorHandler" | "graphErrorHandlerScope" | "graphErrorHandlerInput" | "graphRestartBoundary" | "graphRestartStrategy" | "graphRestartInput" | "graphEarlyStopCondition" | "graphEarlyStopLabelSkipped">>): void {
    if (!selectedStep) return;
    const nextDraft = { ...selectedStep, ...patch };
    onChange(updateStepAdvancedMetadata(steps, selectedStep.id, {
      ...(Object.hasOwn(patch, "onFailure") ? { onFailure: nextDraft.onFailure } : {}),
      ...(Object.hasOwn(patch, "maxRetries") ? { maxRetries: parseOptionalNonNegativeInteger(String(nextDraft.maxRetries ?? "")) } : {}),
      ...(Object.hasOwn(patch, "graphRetryDelaySeconds") ? { retryDelaySeconds: parseOptionalPositiveInteger(String(nextDraft.graphRetryDelaySeconds ?? "")) } : {}),
      ...(Object.hasOwn(patch, "graphRetryBackoff") ? { retryBackoff: nextDraft.graphRetryBackoff } : {}),
      ...(Object.hasOwn(patch, "graphRetryJitter") ? { retryJitter: nextDraft.graphRetryJitter } : {}),
      ...(Object.hasOwn(patch, "timeoutSeconds") ? { timeoutSeconds: parseOptionalPositiveInteger(String(nextDraft.timeoutSeconds ?? "")) } : {}),
      ...(Object.hasOwn(patch, "graphSleepSeconds") ? { sleepSeconds: parseOptionalPositiveInteger(String(nextDraft.graphSleepSeconds ?? "")) } : {}),
      ...(Object.hasOwn(patch, "graphSuspendUntil") ? { suspendUntil: nextDraft.graphSuspendUntil } : {}),
      ...(Object.hasOwn(patch, "graphSuspendTimeoutSeconds") ? { suspendTimeoutSeconds: parseOptionalPositiveInteger(String(nextDraft.graphSuspendTimeoutSeconds ?? "")) } : {}),
      ...(Object.hasOwn(patch, "graphSuspendTimeoutAction") ? { suspendTimeoutAction: nextDraft.graphSuspendTimeoutAction } : {}),
      ...(Object.hasOwn(patch, "graphEarlyReturn") ? { earlyReturn: nextDraft.graphEarlyReturn } : {}),
      ...(Object.hasOwn(patch, "graphEarlyReturnContentType") ? { earlyReturnContentType: nextDraft.graphEarlyReturnContentType } : {}),
      ...(Object.hasOwn(patch, "graphEarlyReturnSchema") ? { earlyReturnSchema: nextDraft.graphEarlyReturnSchema } : {}),
      ...(Object.hasOwn(patch, "graphErrorHandler") ? { errorHandler: nextDraft.graphErrorHandler } : {}),
      ...(Object.hasOwn(patch, "graphErrorHandlerScope") ? { errorHandlerScope: nextDraft.graphErrorHandlerScope } : {}),
      ...(Object.hasOwn(patch, "graphErrorHandlerInput") ? { errorHandlerInput: nextDraft.graphErrorHandlerInput } : {}),
      ...(Object.hasOwn(patch, "graphRestartBoundary") ? { restartBoundary: nextDraft.graphRestartBoundary } : {}),
      ...(Object.hasOwn(patch, "graphRestartStrategy") ? { restartStrategy: nextDraft.graphRestartStrategy } : {}),
      ...(Object.hasOwn(patch, "graphRestartInput") ? { restartInput: nextDraft.graphRestartInput } : {}),
      ...(Object.hasOwn(patch, "graphEarlyStopCondition") ? { earlyStopCondition: nextDraft.graphEarlyStopCondition } : {}),
      ...(Object.hasOwn(patch, "graphEarlyStopLabelSkipped") ? { earlyStopLabelSkipped: nextDraft.graphEarlyStopLabelSkipped } : {}),
    }));
  }

  function updateSelectedApproval(patch: Partial<Pick<StepDraft, "graphApprovalRequired" | "graphApprovalPrompt" | "graphApprovalRecipients" | "graphApprovalTimeoutSeconds" | "graphApprovalTimeoutAction">>): void {
    if (!selectedStep) return;
    const nextDraft = { ...selectedStep, ...patch };
    onChange(updateStepApprovalMetadata(steps, selectedStep.id, {
      ...(Object.hasOwn(patch, "graphApprovalRequired") ? { required: nextDraft.graphApprovalRequired } : {}),
      ...(Object.hasOwn(patch, "graphApprovalPrompt") ? { prompt: nextDraft.graphApprovalPrompt } : {}),
      ...(Object.hasOwn(patch, "graphApprovalRecipients") ? { recipients: nextDraft.graphApprovalRecipients } : {}),
      ...(Object.hasOwn(patch, "graphApprovalTimeoutSeconds") ? { timeoutSeconds: parseOptionalPositiveInteger(String(nextDraft.graphApprovalTimeoutSeconds ?? "")) } : {}),
      ...(Object.hasOwn(patch, "graphApprovalTimeoutAction") ? { timeoutAction: nextDraft.graphApprovalTimeoutAction } : {}),
    }));
  }

  function updateSelectedTesting(patch: Partial<Pick<StepDraft, "graphMockEnabled" | "graphMockResult" | "graphPinnedResultRunId">>): void {
    if (!selectedStep) return;
    const nextDraft = { ...selectedStep, ...patch };
    onChange(updateStepTestingMetadata(steps, selectedStep.id, {
      ...(Object.hasOwn(patch, "graphMockEnabled") ? { mockEnabled: nextDraft.graphMockEnabled } : {}),
      ...(Object.hasOwn(patch, "graphMockResult") ? { mockResult: nextDraft.graphMockResult } : {}),
      ...(Object.hasOwn(patch, "graphPinnedResultRunId") ? { pinnedResultRunId: nextDraft.graphPinnedResultRunId } : {}),
    }));
  }

  function updateSelectedExecution(patch: Partial<Pick<StepDraft, "graphConcurrencyKey" | "graphConcurrencyLimit" | "graphPriority" | "graphCacheEnabled" | "graphCacheTtlSeconds" | "graphDeleteAfterUse">>): void {
    if (!selectedStep) return;
    const nextDraft = { ...selectedStep, ...patch };
    onChange(updateStepExecutionMetadata(steps, selectedStep.id, {
      ...(Object.hasOwn(patch, "graphConcurrencyKey") ? { concurrencyKey: nextDraft.graphConcurrencyKey } : {}),
      ...(Object.hasOwn(patch, "graphConcurrencyLimit") ? { concurrencyLimit: parseOptionalPositiveInteger(String(nextDraft.graphConcurrencyLimit ?? "")) } : {}),
      ...(Object.hasOwn(patch, "graphPriority") ? { priority: nextDraft.graphPriority } : {}),
      ...(Object.hasOwn(patch, "graphCacheEnabled") ? { cacheEnabled: nextDraft.graphCacheEnabled } : {}),
      ...(Object.hasOwn(patch, "graphCacheTtlSeconds") ? { cacheTtlSeconds: parseOptionalPositiveInteger(String(nextDraft.graphCacheTtlSeconds ?? "")) } : {}),
      ...(Object.hasOwn(patch, "graphDeleteAfterUse") ? { deleteAfterUse: nextDraft.graphDeleteAfterUse } : {}),
    }));
  }

  function updateSelectedDataFlow(patch: Partial<Pick<StepDraft, "graphInputExpression" | "graphOutputSchema" | "graphWorkProductRequired" | "graphWorkProductPattern">>): void {
    if (!selectedStep) return;
    const nextDraft = { ...selectedStep, ...patch };
    onChange(updateStepDataFlowMetadata(steps, selectedStep.id, {
      ...(Object.hasOwn(patch, "graphInputExpression") ? { inputExpression: nextDraft.graphInputExpression } : {}),
      ...(Object.hasOwn(patch, "graphOutputSchema") ? { outputSchema: nextDraft.graphOutputSchema } : {}),
      ...(Object.hasOwn(patch, "graphWorkProductRequired") ? { workProductRequired: nextDraft.graphWorkProductRequired } : {}),
      ...(Object.hasOwn(patch, "graphWorkProductPattern") ? { workProductPattern: nextDraft.graphWorkProductPattern } : {}),
    }));
  }

  function updateSelectedResources(patch: Partial<Pick<StepDraft, "graphResourceRefs" | "graphSecretRefs">>): void {
    if (!selectedStep) return;
    const nextDraft = { ...selectedStep, ...patch };
    onChange(updateStepResourceMetadata(steps, selectedStep.id, {
      ...(Object.hasOwn(patch, "graphResourceRefs") ? { resourceRefs: nextDraft.graphResourceRefs } : {}),
      ...(Object.hasOwn(patch, "graphSecretRefs") ? { secretRefs: nextDraft.graphSecretRefs } : {}),
    }));
  }

  function setSelectedNote(note: string): void {
    if (!selectedStep) return;
    onChange(updateStepNote(steps, selectedStep.id, note));
  }

  function updateSelectedContainerMetadata(patch: Partial<Pick<StepDraft, "graphContainerType" | "graphContainerTitle" | "graphContainerDescription" | "graphContainerMode" | "graphContainerCondition" | "graphContainerIterator" | "graphContainerSkipFailure" | "graphContainerRunInParallel" | "graphContainerParallelism">>): void {
    if (!selectedStep) return;
    const groupId = selectedStep.graphContainerId.trim();
    const nextDraft = { ...selectedStep, ...patch };
    const parsedParallelism = parseOptionalPositiveInteger(String(nextDraft.graphContainerParallelism ?? ""));
    if (!groupId) {
      onChange(steps.map((step) => step.id === selectedStep.id ? { ...step, ...patch } : step));
      return;
    }
    onChange(updateContainerMetadata(steps, groupId, {
      ...(Object.hasOwn(patch, "graphContainerType") ? { type: nextDraft.graphContainerType } : {}),
      ...(Object.hasOwn(patch, "graphContainerTitle") ? { title: nextDraft.graphContainerTitle } : {}),
      ...(Object.hasOwn(patch, "graphContainerDescription") ? { description: nextDraft.graphContainerDescription } : {}),
      ...(Object.hasOwn(patch, "graphContainerMode") ? { mode: nextDraft.graphContainerMode } : {}),
      ...(Object.hasOwn(patch, "graphContainerCondition") ? { condition: nextDraft.graphContainerCondition } : {}),
      ...(Object.hasOwn(patch, "graphContainerIterator") ? { iterator: nextDraft.graphContainerIterator } : {}),
      ...(Object.hasOwn(patch, "graphContainerSkipFailure") ? { skipFailure: nextDraft.graphContainerSkipFailure } : {}),
      ...(Object.hasOwn(patch, "graphContainerRunInParallel") ? { runInParallel: nextDraft.graphContainerRunInParallel } : {}),
      ...(Object.hasOwn(patch, "graphContainerParallelism") ? { parallelism: parsedParallelism } : {}),
    }));
  }
  return {
    updateSelected, updateEdge, updateSelectedGroupMetadata, updateSelectedAdvanced,
    updateSelectedApproval, updateSelectedTesting, updateSelectedExecution, updateSelectedDataFlow,
    updateSelectedResources, setSelectedNote, updateSelectedContainerMetadata,
  };
}

import type {
  WorkflowGraphContainerType,
  WorkflowGraphEdgeMetadataRecord,
  WorkflowGraphRunStatus,
  WorkflowGraphWorkProduct,
} from "./workflow-graph.js";
import type { WorkflowConditionGroup } from "@paperclipai/shared";

export type StepDraft = {
  id: string;
  title: string;
  description: string;
  type: "agent" | "tool" | "if" | "complete" | "workflow";
  conditionGroup: WorkflowConditionGroup;
  completionReason: string;
  toolName: string;
  toolArgs: string;
  agentId: string;
  agentName: string;
  tools: string;
  // [workflow child step] type==="workflow" 인 하위 워크플로 호출 대상 정의 id. 공유 검증기는
  //  type==="workflow" 일 때 이 필드를 필수로 요구한다(자기 자신 참조는 UI 선택기에서 제외).
  targetWorkflowId: string;
  dependsOn: string;
  // [descope v1 D1] workflow 스텝 wait 계약 — 생략 또는 리터럴 true 만 허용한다.
  // false 는 초안 타입에서 표현 불가(typed invalid)이며, 직렬화는 true 만 emission 하고
  // import 된 invalid 값은 침묵 강등/제거 없이 extra 통과 후 공유 검증기가 거부한다.
  wait?: true;
  onFailure: string;
  maxRetries: string | number;
  graphRetryDelaySeconds: string | number;
  graphRetryBackoff: string;
  graphRetryJitter: boolean;
  timeoutSeconds: string | number;
  graphSleepSeconds: string | number;
  graphSuspendUntil: string;
  graphSuspendTimeoutSeconds: string | number;
  graphSuspendTimeoutAction: string;
  graphEarlyReturn: boolean;
  graphEarlyReturnContentType: string;
  graphEarlyReturnSchema: string;
  graphErrorHandler: boolean;
  graphErrorHandlerScope: string;
  graphErrorHandlerInput: string;
  graphRestartBoundary: boolean;
  graphRestartStrategy: string;
  graphRestartInput: string;
  graphEarlyStopCondition: string;
  graphEarlyStopLabelSkipped: boolean;
  graphApprovalRequired: boolean;
  graphApprovalPrompt: string;
  graphApprovalRecipients: string;
  graphApprovalTimeoutSeconds: string | number;
  graphApprovalTimeoutAction: string;
  graphMockEnabled: boolean;
  graphMockResult: string;
  graphPinnedResultRunId: string;
  graphConcurrencyKey: string;
  graphConcurrencyLimit: string | number;
  graphPriority: string;
  graphCacheEnabled: boolean;
  graphCacheTtlSeconds: string | number;
  graphDeleteAfterUse: boolean;
  graphInputExpression: string;
  graphOutputSchema: string;
  graphWorkProductRequired: boolean;
  graphWorkProductPattern: string;
  contractPreconditions: string;
  contractPostconditions: string;
  contractUndefinedBehaviors: string;
  graphResourceRefs: string;
  graphSecretRefs: string;
  graphPositionX: string | number;
  graphPositionY: string | number;
  graphGroupId: string;
  graphGroupTitle: string;
  graphGroupColor: string;
  graphGroupCollapsed?: boolean;
  graphGroupCollapsedByDefault: boolean;
  graphContainerId: string;
  graphContainerType: WorkflowGraphContainerType;
  graphContainerTitle: string;
  graphContainerDescription: string;
  graphContainerMode: string;
  graphContainerCondition: string;
  graphContainerIterator: string;
  graphContainerSkipFailure: boolean;
  graphContainerRunInParallel: boolean;
  graphContainerParallelism: string | number;
  graphRunStatus: WorkflowGraphRunStatus;
  graphRunStepRunId?: string;
  graphRunIssueId?: string;
  graphRunIssueIdentifier: string;
  graphRunUpdatedAt: string;
  graphRunSummary: string;
  graphRunStartedAt?: string;
  graphRunCompletedAt?: string;
  graphRunLastDispatchAttemptAt?: string;
  graphRunLastDispatchAcceptedAt?: string;
  graphRunLastDispatchErrorAt?: string;
  graphRunLastDispatchErrorSummary?: string;
  graphRunLastDispatchRequestId?: string;
  graphRunResultPreview?: string;
  graphRunLogPreview?: string;
  graphRunWorkProducts?: WorkflowGraphWorkProduct[];
  graphNote: string;
  graphEdgeMetadata: WorkflowGraphEdgeMetadataRecord;
  extra: Record<string, unknown>;
};

export type WorkflowStepDraftInput = Array<{
  id: string;
  title: string;
  type?: string;
  toolName?: string;
  agentName?: string;
  dependsOn?: string[];
  [key: string]: unknown;
}>;

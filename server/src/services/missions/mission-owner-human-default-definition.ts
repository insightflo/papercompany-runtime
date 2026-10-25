import type { OperatorDecisionDefinition } from "@paperclipai/shared/types/operator-decision";
import {
  WORKFLOW_RESTART_FROM_START_OPTION_DESCRIPTION,
  WORKFLOW_RESTART_FROM_START_OPTION_ID,
  WORKFLOW_RESTART_FROM_START_OPTION_LABEL,
  WORKFLOW_RESTART_FROM_START_SCOPE,
} from "./workflow-restart-option.js";

export function buildDefaultOwnerHumanDefinition(
  evidenceRefs: { label: string; href: string }[],
  workflowRunId?: string | null,
): OperatorDecisionDefinition {
  const option = (id: string, label: string, description: string, fact: string) => ({
    id, label, description,
    facts: [{ label: "선택 시", value: fact.slice(0, 200), status: "known" as const }],
    evidenceRefs,
  });
  return {
    options: [
      ...(workflowRunId ? [{
        id: WORKFLOW_RESTART_FROM_START_OPTION_ID,
        label: WORKFLOW_RESTART_FROM_START_OPTION_LABEL,
        description: WORKFLOW_RESTART_FROM_START_OPTION_DESCRIPTION,
        facts: [{ label: "선택 시", value: `실패 실행 ${workflowRunId} 대신 새 최상위 실행을 생성합니다`, status: "known" as const }],
        evidenceRefs,
        recommended: true,
        recommendationReason: "완료된 수집 단계까지 다시 수행해야 하는 실패를 보드 권한으로 복구합니다.",
      }] : []),
      option("approve", "승인", "요청된 다음 단계를 승인합니다", "오너가 승인받은 다음 단계를 자기 권한으로 진행합니다"),
      option("hold", "보류", "진행을 보류하고 현재 상태를 유지합니다", "실행은 보류되고 요청은 대기 상태로 남습니다"),
      option("reject", "반려", "핸드오프 요청을 반려합니다", "요청이 반려되고 사유가 오너에게 전달됩니다"),
    ],
    actions: [
      { id: "approve", label: "승인", outcome: "approve", tone: "primary", requiresSelection: true },
      { id: "hold", label: "보류", outcome: "hold", tone: "neutral", requiresSelection: true },
      { id: "reject", label: "반려", outcome: "reject", tone: "danger", requiresSelection: true },
    ],
    selection: { min: 1, max: 1 },
    comment: { mode: "required", label: "결정 사유", placeholder: "승인·보류·반려 사유를 남겨 주세요", maxLength: 2_000 },
    approvedScope: ["operator_decision.resolve", ...(workflowRunId ? [WORKFLOW_RESTART_FROM_START_SCOPE] : [])],
    forbiddenScope: ["agent_substitute_submission", ...(workflowRunId ? [] : ["auto_execution"])],
  };
}

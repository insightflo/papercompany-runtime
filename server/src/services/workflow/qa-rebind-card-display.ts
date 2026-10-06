import type { CreateOperatorDecisionInput } from "@paperclipai/shared/types/operator-decision";
import type { SystemLanguage } from "../missions/system-language.js";
import { QA_REBIND_CARD_SOURCE_TYPE, qaRebindCardRequestKey, qaRebindCardSourceId, type QaRebindClaim } from "./qa-rebind-card-contract.js";

export function buildQaRebindCard(candidate: QaRebindClaim, missionId: string | null,
  approvalTargetHash: string, cascade: boolean, language: SystemLanguage): CreateOperatorDecisionInput {
  const text = (en: string, ko: string) => language === "ko" ? ko : en;
  const subject = text("Review the failed publication step before retrying", "실패한 발행 단계를 다시 실행할지 검토해 주세요");
  const notice = cascade
    ? text("Downstream steps were stopped together. This card cannot safely restart them; only closing is available.", "뒤따르는 단계도 함께 중단됐습니다. 이 카드로 안전하게 재시작할 수 없어 닫기만 가능합니다.")
    : text("Approval requests one bounded retry after checking the same evidence and execution target again. Missing or changed evidence remains blocked.", "승인하면 같은 근거와 실행 대상을 다시 확인한 뒤 해당 단계만 한 번 재시도합니다. 근거가 없거나 바뀌면 실행하지 않습니다.");
  const href = missionId ? `/missions/${missionId}` : `/api/workflow-runs/${candidate.workflowRunId}/detail`;
  const option = (id: string, label: string, description: string) => ({ id, label, description, facts: [], evidenceRefs: [] });
  return {
    schemaVersion: 1, requestKey: qaRebindCardRequestKey(candidate.workflowRunId, candidate.consumerStepId, approvalTargetHash),
    priority: "high", interactionType: "single_select", title: subject, description: notice,
    sourceType: QA_REBIND_CARD_SOURCE_TYPE, sourceId: qaRebindCardSourceId(candidate.id, approvalTargetHash),
    sourceContext: { missionId, workflowId: null, workflowRunId: candidate.workflowRunId, artifactRefs: [] },
    issueId: null, continuationMode: "none",
    definition: {
      options: [...(cascade ? [] : [option("approve", text("Approve one retry", "재시도 1회 승인"), notice)]),
        option("dismiss", text("Close without retry", "재시도 없이 닫기"), text("The workflow remains stopped. No agent is notified.", "작업 흐름은 중단 상태로 유지되며 에이전트에게 알리지 않습니다."))],
      actions: [{ id: "submit", label: text("Submit decision", "결정 제출"), outcome: "submit", tone: "primary", requiresSelection: true }],
      selection: { min: 1, max: 1 }, comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 },
      approvedScope: ["operator_decision.resolve"], forbiddenScope: ["producer_auto_rework", "cascade_reset"],
      humanReview: {
        schemaVersion: "human-review-v1", decisionSubject: subject,
        evidence: [{ label: text("Workflow evidence", "작업 흐름 근거"), href,
          location: `${candidate.workflowRunId} / ${candidate.consumerStepId}`.slice(0, 300),
          description: `${candidate.reasonCode ?? "card_required"} / ${approvalTargetHash}` }],
        interpretation: notice,
        impact: { ifApproved: notice, ifRejected: text("No execution is requested.", "실행을 요청하지 않습니다."),
          ifWrong: text("Repeating publication may duplicate external effects. Check the recorded evidence first.", "발행을 반복하면 외부 결과가 중복될 수 있습니다. 먼저 기록된 근거를 확인해 주세요.") },
        unresolvedFacts: cascade ? [notice] : [text("This candidate was not eligible for automatic recovery.", "이 후보는 자동 복구 조건을 충족하지 못했습니다.")],
        questions: [text("Is a retry appropriate for this exact target?", "이 실행 대상의 재시도가 적절한가요?")],
        recommendedNextStep: text("Inspect the evidence, then approve or close the card.", "근거를 확인한 뒤 승인하거나 카드를 닫아 주세요."),
        requiredReviewer: "human-operator",
      },
    },
  };
}

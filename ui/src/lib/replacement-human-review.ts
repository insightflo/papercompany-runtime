import { humanReviewPacketSchema, type Approval } from "@paperclipai/shared";
import { replacementApprovalPayloadSchema } from "@paperclipai/shared/validators/workflow-replacement";

export function replacementHumanReview(approval: Approval) {
  const result = replacementApprovalPayloadSchema.safeParse(approval.payload);
  if (!result.success) return null;
  const p = result.data;
  return humanReviewPacketSchema.parse({
    schemaVersion: "human-review-v1", decisionSubject: "실패한 실행을 유지하고 새 실행을 처음부터 만들도록 승인할까요?",
    interpretation: "현재 책임자의 명시적 재시작 결정에 연결된 일회성 교체 요청입니다. 승인은 실행 완료나 즉시 시작을 뜻하지 않습니다.",
    impact: {
      ifApproved: "승인한 입력·정의로 예약된 대상 실행 하나를 만들 수 있습니다. 생성 직전에 현재 실패 상태와 실행 충돌을 다시 검사합니다.",
      ifRejected: "이 요청으로는 교체 실행을 만들 수 없습니다. 원 실행은 그대로 남습니다.",
      ifWrong: "이미 수행한 외부 발행이나 비용 지출을 중복할 수 있습니다. 외부 효과를 먼저 확인해야 합니다.",
    },
    unresolvedFacts: ["외부 효과 확인은 운영자가 제출한 확인입니다. 이 승인 화면이 외부 시스템의 실제 상태를 검증하지는 않습니다."],
    questions: ["원 실행의 외부 발행·저장·비용 효과를 대사했습니까?", "아래 입력·정의 식별 해시와 예약 대상이 승인하려는 범위입니까?"],
    recommendedNextStep: "원 실행과 입력을 확인하고 승인·거절하거나 수정 요청하세요. 실패한 교체를 자동으로 다시 교체하지 않습니다.",
    requiredReviewer: "해당 회사의 보드 운영자",
    evidence: [{ label: "원 실행과 단계 기록", href: `/missions/${p.missionId}`, location: `미션 > 워크플로우 실행 ${p.sourceRunId} · 실패 세대 ${p.requestGeneration} · 권한 버전 ${p.sourceAuthorityVersion}`, description: "실패 상태와 원 실행의 결과를 확인하세요." }],
  });
}

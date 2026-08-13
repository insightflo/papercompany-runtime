import { humanReviewPacketSchema, type Approval, type HumanReviewPacket } from "@paperclipai/shared";

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function approvalHumanReview(approval: Approval): HumanReviewPacket | null {
  const payload = (approval.payload ?? {}) as Record<string, unknown>;
  const explicit = humanReviewPacketSchema.safeParse(payload.humanReview);
  if (explicit.success) return explicit.data;
  if (approval.type === "hire_agent") {
    const name = text(payload.name);
    const role = text(payload.role);
    const agentId = text(payload.agentId);
    if (!name || !role || !agentId) return null;
    return humanReviewPacketSchema.parse({
      schemaVersion: "human-review-v1",
      decisionSubject: `${name} Agent 채용과 실행 권한을 승인할까요?`,
      interpretation: `${name}을 ${role} 역할의 Agent로 활성화하는 요청입니다.`,
      impact: {
        ifApproved: "Agent가 활성화되고 설정된 도구, 실행 환경, 월 예산 안에서 업무를 시작할 수 있습니다.",
        ifRejected: "Agent는 활성화되지 않고 실행 권한도 부여되지 않습니다.",
        ifWrong: "잘못된 역할, 도구 권한 또는 예산으로 Agent가 회사 업무를 수행할 수 있습니다.",
      },
      unresolvedFacts: [], questions: ["역할, 보고 관계, 도구 권한과 월 예산이 운영 의도와 일치합니까?"],
      recommendedNextStep: "Agent 설정 원본을 확인한 뒤 승인하거나 수정을 요청하세요.", requiredReviewer: "회사 운영자",
      evidence: [{ label: "Agent 설정 원본", href: `/agents/${agentId}`, location: "Agent 상세 > 구성", description: "승인 시 활성화될 실제 Agent 설정" }],
    });
  }
  if (approval.type === "budget_override_required") {
    const scopeName = text(payload.scopeName) || text(payload.scopeType);
    if (!scopeName) return null;
    return humanReviewPacketSchema.parse({
      schemaVersion: "human-review-v1", decisionSubject: `${scopeName}의 예산 제한을 초과하도록 허용할까요?`,
      interpretation: "현재 지출이 설정된 예산 제한에 도달해 자동 실행이 중지된 상태입니다.",
      impact: { ifApproved: "조정한 예산 범위 안에서 실행을 재개할 수 있습니다.", ifRejected: "현재 예산 제한과 자동 중지 상태를 유지합니다.", ifWrong: "의도하지 않은 추가 비용이 발생하거나 필요한 업무가 중단될 수 있습니다." },
      unresolvedFacts: [], questions: ["추가 지출이 필요한 이유와 남은 업무 범위를 확인했습니까?"],
      recommendedNextStep: "비용 화면에서 한도, 실제 사용액, 대상 범위와 기간을 확인하세요.", requiredReviewer: "예산 권한이 있는 운영자",
      evidence: [{ label: "예산 정책과 사용 내역", href: "/costs", location: `비용 > ${scopeName}`, description: "현재 한도와 실제 사용액" }],
    });
  }
  return null;
}

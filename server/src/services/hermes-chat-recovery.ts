// server/src/services/hermes-chat-recovery.ts
//
// [파일 목적] Hermes chat(sidebar/Telegram)에서 recovery 질문을 감지하고, mission을 식별할 수 있으면
//   getMissionRecoveryAdvice로 구조화 처방을 계산해 context에 붙인다. 양 채널(hermes-chat route +
//   telegram commands)이 공유하는 얇은 레이어. advice 본체 로직은 mission-recovery-advice.ts에 있다.
// [주요 흐름]
//   detectRecoveryQuestion → resolveMissionIdForRecovery → getMissionRecoveryAdvice(fail-open)
// [외부 연결] getMissionRecoveryAdvice(mission-recovery-advice.ts). 결과는 호출측이
//   contextSnapshot.paperclipHermesChat.recoveryAdvice(nested key) 아래에만 저장한다.
// [수정시 주의]
//   - advice를 top-level에 spread하지 말 것(verdict reader 충돌, peer P2 제약).
//   - recovery 질문이 아니거나 missionId를 못 찾으면 null → chat은 정상 진행(advice 없이).
import type { Db } from "@paperclipai/db";
import { getMissionRecoveryAdvice, type MissionRecoveryAdvice } from "./missions/mission-recovery-advice.js";

// 한국어/영문 recovery 질문 표현. 과 매칭보다 누락이 나으므로 넓게.
const RECOVERY_QUESTION_PATTERNS: RegExp[] = [
  /왜\s*멈[춤푸]/i,
  /깨우려면|깨워\s*줘|깨워라|재개\s*시켜|다시\s*시작\s*시켜|다시\s*돌려/i,
  /막혔|막힘|막힌\s*사유|blocked\s*reason|stuck/i,
  /unblock|언블럭|차단\s*해제/i,
  /what\s+should\s+i\s+say|뭐라고\s+(하|지시|쓰)|어떻게\s+지시/i,
  /why\s+(is|was)\s+(this|it)\s+stopped|stopped/i,
  /qa\s+(is\s+)?stuck|qa가\s+막혔/i,
  /how\s+do\s+i\s+unblock|어떻게\s+풀/i,
];

export function detectRecoveryQuestion(text: string | null | undefined): boolean {
  if (!text) return false;
  return RECOVERY_QUESTION_PATTERNS.some((re) => re.test(text));
}

/**
 * [목적] sidebar pageContext 또는 telegram 메시지 텍스트에서 missionId를 추출.
 * [입력] currentPage(sidebar), messageText(telegram URL 파싱 포함).
 * [출력] mission UUID or null.
 */
export function resolveMissionIdForRecovery(input: {
  currentPage: Record<string, unknown> | null;
  messageText: string;
}): string | null {
  const { currentPage, messageText } = input;

  // 1) sidebar pageContext: kind=mission → entityId; facts.missionId; path 파싱.
  if (currentPage && typeof currentPage === "object") {
    if (currentPage.kind === "mission" && typeof currentPage.entityId === "string") {
      return currentPage.entityId;
    }
    const facts = currentPage.facts;
    if (facts && typeof facts === "object" && typeof (facts as Record<string, unknown>).missionId === "string") {
      return (facts as Record<string, unknown>).missionId as string;
    }
    const path = typeof currentPage.path === "string" ? currentPage.path : null;
    if (path) {
      const m = path.match(/\/missions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (m) return m[1];
    }
  }

  // 2) telegram: 메시지 본문의 mission URL/id 파싱.
  if (messageText) {
    const urlMatch = messageText.match(/\/missions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (urlMatch) return urlMatch[1];
  }
  return null;
}

function resolveIssueIdForRecovery(currentPage: Record<string, unknown> | null): string | null {
  if (!currentPage || typeof currentPage !== "object") return null;
  if (currentPage.kind === "issue" && typeof currentPage.entityId === "string") {
    return currentPage.entityId;
  }
  const facts = currentPage.facts;
  if (facts && typeof facts === "object" && typeof (facts as Record<string, unknown>).issueId === "string") {
    return (facts as Record<string, unknown>).issueId as string;
  }
  return null;
}

/**
 * [목적] recovery 질문이면 처방을 계산해 반환. 아니면 null.
 * [주의] fail-open — advice 계산 실패해도 chat 자체은 진행돼야 한다.
 */
export async function resolveRecoveryAdviceForChat(
  db: Db,
  input: {
    companyId: string;
    currentPage: Record<string, unknown> | null;
    messageText: string;
  },
): Promise<MissionRecoveryAdvice | null> {
  if (!detectRecoveryQuestion(input.messageText)) return null;
  const missionId = resolveMissionIdForRecovery(input);
  if (!missionId) return null;
  const issueId = resolveIssueIdForRecovery(input.currentPage);
  try {
    return await getMissionRecoveryAdvice(db, {
      companyId: input.companyId,
      missionId,
      issueId,
    });
  } catch {
    // [주의] advice 실패가 chat을 막으면 안 됨. null로 정상 진행.
    return null;
  }
}

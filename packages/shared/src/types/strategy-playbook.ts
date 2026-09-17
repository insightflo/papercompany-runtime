/**
 * 전략 플레이북 항목 타입 (쇼츠 컴퍼니 Phase F).
 *
 * DB 테이블 strategy_playbook_entries 와 1:1 대응하는 응답 타입과 수명주기 상태.
 * 생성은 언제나 '제안(proposed)'이며, 활성화(active)/은퇴(retired)는 보드 전용 전이다.
 */

export type StrategyPlaybookChannel = "knowledge" | "shopping";

export type StrategyPlaybookStatus = "proposed" | "active" | "retired";

export interface StrategyPlaybookEntry {
  id: string;
  companyId: string;
  channel: StrategyPlaybookChannel;
  triggerType: string;
  conditionJson: Record<string, unknown>;
  actionType: string;
  actionJson: Record<string, unknown>;
  evidenceRefs: string[];
  status: StrategyPlaybookStatus;
  proposedByAgentId: string | null;
  activatedAt: string | null;
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

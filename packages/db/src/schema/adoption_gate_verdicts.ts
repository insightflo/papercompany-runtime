import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

// [판정 실체화 — 자기개선 채택 게이트] 오너가 게이트 판정을 자기 인증하는 구멍을 닫는
//   내구 판정 원장. 피어/검증 에이전트가 후보 해시에 묶은 PASS/FAIL을 구조화 레코드로
//   남기고, apply는 이 원장에서만 판정을 읽는다(에이전트 호출자 기준 — 보드는 운영자
//   권한으로 인라인 판정 허용). 자연어 판정은 절대 권위가 아니다(규칙 8).
export const adoptionGateVerdicts = pgTable(
  "adoption_gate_verdicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    gateOwner: text("gate_owner").notNull(),
    candidateHash: text("candidate_hash").notNull(),
    verdict: text("verdict").notNull(),
    note: text("note"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCandidateIdx: index("adoption_gate_verdicts_company_candidate_idx").on(table.companyId, table.candidateHash),
    companyGateIdx: index("adoption_gate_verdicts_company_gate_idx").on(table.companyId, table.gateOwner),
  }),
);

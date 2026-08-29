import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

// [파일 목적] 사고→패턴 지식 위키 — 회사 단위 큐레이션 패턴 카드 저장소.
//   미션 실패/사고 해소 시 감독자(미션 오너)가 "무엇이 어떻게 실패했고 무엇이 통했는지"를
//   구조화 레코드로 제출한다(구조화 레코드만 권위 — 규칙 8. 코멘트/프로즈는 표시용).
//   소비는 기획/진단/자기개선의 검색 전용이며 실행 에이전트 컨텍스트 주입은 금지된다
//   (컨텍스트 비대 방어 + WikiSkill ablation 근거 — 별도 위키(agent_wiki_entries)의
//   audience 게이트와 동일 원칙).
// [불변식] append-only — 앱 계층이 insert/select만 노출하고 수정은 supersede 체인으로만
//   대체한다(새 카드 발행 + 이전 카드의 superseded_by_id 갱신). 실패한 지식도 남아 다음
//   진단이 같은 실수를 반복하지 않게 한다.
// [외부 연결] FK: companies(cascade) / agents(set null, 컴파일한 오너 에이전트).
//   service: server/src/services/knowledge-patterns.ts. routes: routes/knowledge-patterns.ts.
// [수정시 주의] 스키마 변경 시 수기 마이그레이션 규약 준수(journal drift — 0096 참조).
export const companyKnowledgePatterns = pgTable(
  "company_knowledge_patterns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // failure_mode | success_recipe | constraint
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    // 구조화 증거 참조: [{type: mission|workflow_run|issue|transition_event|pr, id, note}]
    evidence: jsonb("evidence").$type<Array<Record<string, unknown>>>().notNull().default([]),
    symptoms: text("symptoms"),
    rootCause: text("root_cause"),
    whatWorked: text("what_worked"),
    scopeTags: text("scope_tags").array().notNull().default([]),
    source: text("source").notNull(), // mission_owner_compile | agent_candidate | operator
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    supersededById: uuid("superseded_by_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKindIdx: index("company_knowledge_patterns_company_kind_idx").on(table.companyId, table.kind),
    companyCreatedIdx: index("company_knowledge_patterns_company_created_idx").on(table.companyId, table.createdAt),
  }),
);

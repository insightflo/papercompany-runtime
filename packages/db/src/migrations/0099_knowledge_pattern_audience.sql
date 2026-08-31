-- 0099: company_knowledge_patterns에 audience 추가 (P2 — 큐레이션 카드 관련도 주입).
--   fail-closed (#163 교훈): 기본값 'ops' = 주입 대상 아님. 사람이 audience='agent'로
--   큐레이션한(active) 카드만 스텝 디스패치 프롬프트에 소량 주입된다.
--   기계 카운터 위키(agent_wiki_entries.audience)와 동일한 게이트 어휘를 쓴다.
ALTER TABLE "company_knowledge_patterns" ADD COLUMN IF NOT EXISTS "audience" text NOT NULL DEFAULT 'ops';

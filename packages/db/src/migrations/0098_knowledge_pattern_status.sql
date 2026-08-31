-- 0098: company_knowledge_patterns에 draft 상태 + 결함 서명 추가.
--   P1(반복 QA 기계 교정 → 패턴 카드 자동 초안): 기계적 재작업 감지가 동일 결함 서명
--   2회째를 감지하면 source='auto_rework_draft', status='draft' 초안 카드를 생성한다.
--   기존 행은 전부 active(사람이 만든 카드 — 승인 게이트 이전 자산 존중).
--   defect_signature는 회사 단위 유일 — 초안 카드 중복 생성 방지(idempotency).
ALTER TABLE "company_knowledge_patterns" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'active';
--> statement-breakpoint
ALTER TABLE "company_knowledge_patterns" ADD COLUMN IF NOT EXISTS "defect_signature" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_knowledge_patterns_company_signature_uq"
  ON "company_knowledge_patterns" ("company_id", "defect_signature")
  WHERE "defect_signature" IS NOT NULL;

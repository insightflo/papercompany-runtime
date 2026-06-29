-- [목적] 자동 trigger(dedupe)의 select-then-insert race 방지.
--   같은 (company, target_type, trigger_source, target_id) 의 "열린" review item 은 1개만 존재.
--   closed/terminal 상태는 제외 → 닫힌 item 이후 동일 대상 새 item 생성 허용(조건 5).
--   target_id NULL: Postgres 가 NULL 을 서로 다른 값으로 보므로, NULL target_id 끼리는 중복 허용.
--   자동 trigger(oversight/delivery/final-QA/plan-QA)는 항상 target_id 를 세팅하므로 이 인덱스로 보호됨.
--   additive (CREATE UNIQUE INDEX IF NOT EXISTS).
CREATE UNIQUE INDEX IF NOT EXISTS "quality_review_items_open_dedupe_uq"
  ON "quality_review_items" ("company_id", "target_type", "trigger_source", "target_id")
  WHERE "status" NOT IN ('resolved_pass', 'resolved_fail', 'dismissed', 'closed', 'evaluator_promoted', 'evaluator_rejected');

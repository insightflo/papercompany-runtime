-- [C1 2026-11-08] 미션당 pending mission_owner_human_input 카드 1장 계약의 DB 수준 보장.
-- 기존 위반 정리: 같은 미션에 pending 카드가 2장 이상이면 가장 오래된 1장만 남기고
-- 나머지를 취소한다(R2 계약 — 첫 카드가 계속 표면이고 이후 발행은 SELECT→INSERT 레이스 부산물).
-- A1 사전 확인(2026-11-08, 읽기 전용 SELECT): pending 중복 미션 0건, pending 총 0건 — 실제로는 무동작.
UPDATE "operator_decisions" AS "keep"
SET "status" = 'cancelled',
    "cancelled_at" = now(),
    "updated_at" = now()
FROM "operator_decisions" AS "older"
WHERE "keep"."source_type" = 'mission_owner_human_input'
  AND "keep"."status" = 'pending'
  AND "keep"."source_context" ->> 'missionId' IS NOT NULL
  AND "older"."source_type" = 'mission_owner_human_input'
  AND "older"."status" = 'pending'
  AND "older"."company_id" = "keep"."company_id"
  AND "older"."source_context" ->> 'missionId' = "keep"."source_context" ->> 'missionId'
  AND ("older"."created_at", "older"."id") < ("keep"."created_at", "keep"."id");
--> statement-breakpoint
CREATE UNIQUE INDEX "operator_decisions_pending_mission_human_input_uq" ON "operator_decisions" USING btree ("company_id",("source_context" ->> 'missionId')) WHERE "operator_decisions"."source_type" = 'mission_owner_human_input' and "operator_decisions"."status" = 'pending';

-- [TS하드닝 #1 DB절반 2026-11-09] workflow_runs.status 도메인 CHECK 제약 정규화.
-- 배경: 0046_papercompany_core.sql 이 CREATE TABLE 안에 status CHECK 를 인라인으로
-- 만들었고 Postgres가 workflow_runs_status_check 로 자동 명명했으나 Drizzle 스키마에는
-- 선언이 없어 제약-스키마 표류 상태였다. 이 마이그레이션은 동일 도메인의 제약을 저널이
-- 추적하는 명시 제약으로 재선언한다.
-- 2단계 적용: DROP → ADD CONSTRAINT ... NOT VALID → VALIDATE CONSTRAINT.
--   NOT VALID 로 추가해 기존 행 검증을 VALIDATE 단계로 분리하고, VALIDATE 로
--   convalidated=true 상태를 확정한다. 트랜잭션 안에서 실행되므로 DROP/ADD 사이에
--   다른 트랜잭션에 보이는 무제약 창은 없다.
ALTER TABLE "workflow_runs" DROP CONSTRAINT "workflow_runs_status_check";--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_status_check" CHECK ("workflow_runs"."status" in
    ('pending','running','completed','failed','cancelled')) NOT VALID;--> statement-breakpoint
ALTER TABLE "workflow_runs" VALIDATE CONSTRAINT "workflow_runs_status_check";

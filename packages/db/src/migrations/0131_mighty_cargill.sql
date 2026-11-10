-- [TS하드닝 #1 DB CHECK 2차 2026-11-10] heartbeat_runs.status 도메인 CHECK 제약 도입.
-- 배경: A1 실측에 코드 도메인(HEARTBEAT_RUN_STATUSES 6값) 밖 'done' 1행이 있어
-- 1차(#693)에서 heartbeat_runs 항목이 중단됐다. hbdone-report 판정: 서비스 경로가
-- 아닌 out-of-band SQL 1회성 보정 흔적(코드·이력 어디에도 'done'/finalization_version=2
-- 기록 경로가 없고, settled_at=finished_at 마이크로초 동일값은 코드가 만들 수 없는 조합).
-- 순서(반드시 이 순서): (1) 고아 1행 정정 → (2) ADD CONSTRAINT ... NOT VALID →
-- (3) VALIDATE CONSTRAINT. 정정 없이 VALIDATE 하면 SQLSTATE 23514 로 실패한다.
-- NOT VALID 는 신규·갱신 행에 즉시 적용되며, 파일 전체가 한 트랜잭션으로 실행돼
-- 어느 단계든 실패하면 정정 UPDATE 까지 함께 롤백된다.
-- pre-image(되돌리기용, hbdone-report §5 사전 기록):
--   id=2a1b9e3c-480f-41dd-8c3c-22df24d3ef74, status='done', finalization_version=2,
--   settled_at=finished_at='2026-09-12 20:04:30.937325+00',
--   updated_at='2026-09-12 20:04:11.291+00', exit_code=143.
-- 되돌리기 SQL(제약이 validated 상태면 'done' 복원이 거부되므로 제약을 먼저 내린다):
--   ALTER TABLE "heartbeat_runs" DROP CONSTRAINT "heartbeat_runs_status_check";
--   UPDATE heartbeat_runs
--      SET status = 'done'
--    WHERE id     = '2a1b9e3c-480f-41dd-8c3c-22df24d3ef74'
--      AND status = 'succeeded'
--      AND finalization_version = 2
--      AND updated_at = '2026-09-12 20:04:11.291+00';
-- (1) 고아 1행 정정 — id+status='done'+finalization_version=2+updated_at 고정의
-- 다중 가드라 대상 외 행·재실행 모두 0행이다. updated_at 은 갱신하지 않는다
-- (원 관측 시각 보존 — '언제 끝났는가' 지표 왜곡 방지).
UPDATE heartbeat_runs
   SET status = 'succeeded'          -- updated_at 은 건드리지 않는다(원 관측 시각 보존)
 WHERE id     = '2a1b9e3c-480f-41dd-8c3c-22df24d3ef74'
   AND status = 'done'
   AND finalization_version = 2
   AND updated_at = '2026-09-12 20:04:11.291+00';   -- 낙관적 가드(값이 바뀌었으면 0행)--> statement-breakpoint
-- (2) 도메인 CHECK 추가 — 기존 행 검증은 다음 VALIDATE 단계로 분리한다.
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_status_check" CHECK ("heartbeat_runs"."status" in
    ('queued','running','succeeded','failed','cancelled','timed_out')) NOT VALID;--> statement-breakpoint
-- (3) 기존 행 전수 검증 — 도메인 밖 값이 남아 있으면 23514 로 실패하며 마이그레이션
-- 트랜잭션 전체가 롤백된다(정정 UPDATE 포함 — 배포가 시끄럽게 멈추는 의도된 동작).
ALTER TABLE "heartbeat_runs" VALIDATE CONSTRAINT "heartbeat_runs_status_check";

-- Mission ↔ Project 직접 연결: missions.project_id 컬럼 추가.
-- 용도: new mission 생성 시 project를 지정하고, missions 리스트/상세에서 project를 표시하기 위한
--   authoritative 1-hop 링크. 기존 goalId → project_goals(M:N, 손실 가능) 파생 경로를 대체한다.
-- 동기: mission에 working directory(project primary workspace)가 연결되지 않아 발생한
--   run-fail(broad scan 차단, ephemeral outputs 소실)을 project 연결로 해소하기 위한 스키마 기반.
-- 주의: project_id는 nullable. 미연결 mission(goalId만 있는 레거시 포함)은 NULL로 둔다.
--   goalId와 중복될 수 있으나 project_id를 권위로, goalId는 보조로 사용한다.
-- 적용: drizzle migrate runner가 .sql을 파일명순으로 적용(journal 불필요, 0048~0063과 동일 패턴).
-- Rollback: ALTER TABLE "missions" DROP COLUMN "project_id"; (index는 컬럼 drop 시 자동 제거)

ALTER TABLE "missions" ADD COLUMN "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX "idx_missions_project_id" ON "missions" ("project_id");

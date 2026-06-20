-- Workflow control-flow(P1 skeleton): workflow_step_runs 에 loop iteration 카운터 추가.
-- 용도: bounded back-edge loop(QA 반려 -> rework -> 재QA) 가 step 을 re-run 할 때마다 증가.
-- maxIterations hard cap 판정에 쓰여 무한 loop(가즈아 25h hang) 을 회피한다.
-- 주의: retry_count(adapter/heartbeat 재시도 횟수) 와 의미가 다르다. DTO 에도 별도 노출.
ALTER TABLE "workflow_step_runs" ADD COLUMN "iteration_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

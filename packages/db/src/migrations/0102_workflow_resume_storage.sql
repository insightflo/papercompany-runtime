-- 0102: workflow resume 저장소 3 테이블 (additive only).
--   Task6a: workflow_resume_requests (bounded resume 요청, idempotent replay key),
--           workflow_resume_executions (영구 실행 항목, 요청당 1건).
--   Task7:  workflow_late_evidence_submissions (완료 producer 재실행 없는 늦은 근거 intake).
--   CHECK 제약(상태 enum, attempts/generation >= 0, lease paired)은 DB 에서도 fail-closed.
--   감사 레코드이므로 모든 FK 는 no action (cascade 없음).
--   artifactId 는 기존 artifact 저장소 issue_work_products 를 참조한다(등록 전 null).
-- 비고: `pnpm db:generate` 은 stale 0048 snapshot 기준으로 기존 25개 테이블 재생성/충돌
--   drift SQL 을 생성하므로(메타/이력 보존 원칙에 따라 폐기, 전체 출력은
--   /tmp/mission-resume-real-delivery/generated-0048_woozy_anthem.sql 참조),
--   저장소 기존 컨벤션(0101과 동일)에 따라 본 3 테이블로 스코프된 문장만 수기 작성했다.
--   생성기가 만든 동일 문장은 generated SQL 352-419(테이블), 582-594(FK),
--   665-670(인덱스) 행과 일치한다.

CREATE TABLE "workflow_resume_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"snapshot_hash" text NOT NULL,
	"definition_hash" text NOT NULL,
	"request_body" jsonb NOT NULL,
	"before_state" jsonb NOT NULL,
	"applied_generations" jsonb NOT NULL,
	"state" text DEFAULT 'pending_delivery' NOT NULL,
	"code" text,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"delivery_attempts" integer DEFAULT 0 NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_resume_requests_state_check" CHECK ("workflow_resume_requests"."state" in ('pending_delivery', 'accepted', 'blocked', 'cancelled')),
	CONSTRAINT "workflow_resume_requests_delivery_attempts_check" CHECK ("workflow_resume_requests"."delivery_attempts" >= 0),
	CONSTRAINT "workflow_resume_requests_lease_check" CHECK (("workflow_resume_requests"."lease_owner" is null and "workflow_resume_requests"."lease_until" is null) or ("workflow_resume_requests"."lease_owner" is not null and "workflow_resume_requests"."lease_until" is not null))
);
--> statement-breakpoint
CREATE TABLE "workflow_resume_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"authority_version" integer NOT NULL,
	"generations" jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"code" text,
	CONSTRAINT "workflow_resume_executions_state_check" CHECK ("workflow_resume_executions"."state" in ('queued', 'running', 'completed', 'blocked', 'cancelled')),
	CONSTRAINT "workflow_resume_executions_authority_version_check" CHECK ("workflow_resume_executions"."authority_version" >= 0),
	CONSTRAINT "workflow_resume_executions_attempts_check" CHECK ("workflow_resume_executions"."attempts" >= 0),
	CONSTRAINT "workflow_resume_executions_lease_check" CHECK (("workflow_resume_executions"."lease_owner" is null and "workflow_resume_executions"."lease_until" is null) or ("workflow_resume_executions"."lease_owner" is not null and "workflow_resume_executions"."lease_until" is not null))
);
--> statement-breakpoint
CREATE TABLE "workflow_late_evidence_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"step_run_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"execution_generation" integer NOT NULL,
	"spec_sha256" text NOT NULL,
	"manifest_object" text NOT NULL,
	"manifest_sha256" text NOT NULL,
	"request_hash" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"state" text DEFAULT 'pending_readback' NOT NULL,
	"artifact_id" uuid,
	"readback_hash" text,
	"code" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "workflow_late_evidence_submissions_state_check" CHECK ("workflow_late_evidence_submissions"."state" in ('pending_readback', 'verified', 'blocked')),
	CONSTRAINT "workflow_late_evidence_submissions_execution_generation_check" CHECK ("workflow_late_evidence_submissions"."execution_generation" >= 0),
	CONSTRAINT "workflow_late_evidence_submissions_attempts_check" CHECK ("workflow_late_evidence_submissions"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "workflow_resume_requests" ADD CONSTRAINT "workflow_resume_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_resume_requests" ADD CONSTRAINT "workflow_resume_requests_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_resume_requests" ADD CONSTRAINT "workflow_resume_requests_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_resume_executions" ADD CONSTRAINT "workflow_resume_executions_request_id_workflow_resume_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."workflow_resume_requests"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_resume_executions" ADD CONSTRAINT "workflow_resume_executions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_resume_executions" ADD CONSTRAINT "workflow_resume_executions_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_resume_executions" ADD CONSTRAINT "workflow_resume_executions_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_late_evidence_submissions" ADD CONSTRAINT "workflow_late_evidence_submissions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_late_evidence_submissions" ADD CONSTRAINT "workflow_late_evidence_submissions_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_late_evidence_submissions" ADD CONSTRAINT "workflow_late_evidence_submissions_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_late_evidence_submissions" ADD CONSTRAINT "workflow_late_evidence_submissions_step_run_id_workflow_step_runs_id_fk" FOREIGN KEY ("step_run_id") REFERENCES "public"."workflow_step_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_late_evidence_submissions" ADD CONSTRAINT "workflow_late_evidence_submissions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_late_evidence_submissions" ADD CONSTRAINT "workflow_late_evidence_submissions_artifact_id_issue_work_products_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."issue_work_products"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_late_evidence_submissions_step_idempotency_uq" ON "workflow_late_evidence_submissions" USING btree ("company_id","step_run_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "idx_workflow_late_evidence_submissions_state_created_at" ON "workflow_late_evidence_submissions" USING btree ("state","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_resume_executions_request_uq" ON "workflow_resume_executions" USING btree ("request_id");
--> statement-breakpoint
CREATE INDEX "idx_workflow_resume_executions_state_lease_until" ON "workflow_resume_executions" USING btree ("state","lease_until");
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_resume_requests_run_idempotency_uq" ON "workflow_resume_requests" USING btree ("company_id","workflow_run_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "idx_workflow_resume_requests_state_lease_until" ON "workflow_resume_requests" USING btree ("state","lease_until");

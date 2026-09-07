-- 0101: workflow → workflow 자식 실행(n8n "Execute Workflow") 지원, additive only.
--   workflow_runs: 부모 run 연결 컬럼(self-FK, indexed) — 자식 run 의 깊이/루트 추적용.
--   workflow_step_invocations: 부모 step-run 당 UNIQUE 1행. 자식 run 생성의 멱등 클레임 —
--     UNIQUE(parent_step_run_id) 로 동시/재진입 dispatch 에서도 자식 run 이 1개만 성립하고,
--     conflict 시 기존 자식을 재사용한다(크래시 복구 의미론). generation 은 policy-retry 가
--     CAS 갱신하며, 회복 경로(reconciler/conflict)는 기존 세대를 재사용한다.
--     child_run_id NULL 허용(FK ON DELETE SET NULL tombstone): NULL 의 의미는 state 로 구분한다 —
--     'claimed'+NULL 은 클레임 후 자식 생성 전 크래시(re-dispatch), 'linked'+NULL 은 링크됐던
--     자식의 삭제(settlement 대상 fenced child_run_failed). 클레임+자식 run 생성+링크는
--     단일 트랜잭션으로 커밋되며, 커밋 승자만 자식을 실행한다(이중 실행 차단).

ALTER TABLE "workflow_runs" ADD COLUMN "parent_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "parent_step_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "root_run_id" uuid;
--> statement-breakpoint
-- [fix4] 자식 초기화 소유/임대/마감/materialization 영수증 — 내구 실행 권위.
ALTER TABLE "workflow_runs" ADD COLUMN "child_start_token" uuid;
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "child_start_lease_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "child_start_deadline_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "child_start_materialized_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_child_start_lease_pair_ck" CHECK ((child_start_token IS NULL) = (child_start_lease_expires_at IS NULL));
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_parent_run_id_workflow_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_parent_step_run_id_workflow_step_runs_id_fk" FOREIGN KEY ("parent_step_run_id") REFERENCES "public"."workflow_step_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_root_run_id_workflow_runs_id_fk" FOREIGN KEY ("root_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_workflow_runs_parent_run_id" ON "workflow_runs" USING btree ("parent_run_id");
--> statement-breakpoint
CREATE INDEX "idx_workflow_runs_parent_step_run_id" ON "workflow_runs" USING btree ("parent_step_run_id");
--> statement-breakpoint
CREATE INDEX "idx_workflow_runs_root_run_id" ON "workflow_runs" USING btree ("root_run_id");
--> statement-breakpoint
CREATE TABLE "workflow_step_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"parent_step_run_id" uuid NOT NULL,
	"child_run_id" uuid,
	"state" text DEFAULT 'claimed' NOT NULL,
	"wait" boolean DEFAULT true NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_step_invocations" ADD CONSTRAINT "workflow_step_invocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_step_invocations" ADD CONSTRAINT "workflow_step_invocations_parent_step_run_id_workflow_step_runs_id_fk" FOREIGN KEY ("parent_step_run_id") REFERENCES "public"."workflow_step_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_step_invocations" ADD CONSTRAINT "workflow_step_invocations_child_run_id_workflow_runs_id_fk" FOREIGN KEY ("child_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_step_invocations_parent_step_run_id_uq" ON "workflow_step_invocations" USING btree ("parent_step_run_id");
--> statement-breakpoint
CREATE INDEX "idx_workflow_step_invocations_company_id" ON "workflow_step_invocations" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "idx_workflow_step_invocations_child_run_id" ON "workflow_step_invocations" USING btree ("child_run_id");
--> statement-breakpoint
-- [fix4] run+step 식별 유일성 — 동시 materialization 이 동일 스텝을 이중 생성하지 못한다.
CREATE UNIQUE INDEX "workflow_step_runs_run_step_uq" ON "workflow_step_runs" USING btree ("workflow_run_id","step_id");

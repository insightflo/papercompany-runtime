-- 0101: workflow run definition immutable snapshot 테이블 (additive only).
--   Task5a1: run 생성 시점의 normalized 실행 정의를 1회 캡처하는 불변 스냅샷.
--   workflow_run_id PK — 갱신/덮어쓰기 경로 없이 충돌을 거부하며, run 삭제 시 cascade.
--   CHECK 제약은 raw corrupt 입력(version/mode/hash/jsonb shape)을 DB 에서도 거부한다(fail-closed).
--   비고: drizzle-kit generate 은 stale 0048 snapshot 기준으로 광범위한 drift SQL 을
--   생성하므로(메타/이력 보존 원칙에 따라 폐기, /tmp/task5a1-generator-output 참조),
--   저장소 기존 컨벤션에 따라 본 테이블로 스코프된 문장만 수기 작성했다.
--   생성기가 만든 동일 문장은 generated SQL 372-388, 515-516 행과 일치한다.

CREATE TABLE "workflow_run_definitions" (
	"workflow_run_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"definition_hash" text NOT NULL,
	"execution_mode" text NOT NULL,
	"steps" jsonb NOT NULL,
	"normalizer_version" integer DEFAULT 1 NOT NULL,
	"provenance" jsonb NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_run_definitions_schema_version_check" CHECK ("workflow_run_definitions"."schema_version" = 1),
	CONSTRAINT "workflow_run_definitions_normalizer_version_check" CHECK ("workflow_run_definitions"."normalizer_version" = 1),
	CONSTRAINT "workflow_run_definitions_execution_mode_check" CHECK ("workflow_run_definitions"."execution_mode" in ('static_dag', 'dynamic_owner_plan')),
	CONSTRAINT "workflow_run_definitions_definition_hash_check" CHECK ("workflow_run_definitions"."definition_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workflow_run_definitions_steps_json_type_check" CHECK (jsonb_typeof("workflow_run_definitions"."steps") = 'array'),
	CONSTRAINT "workflow_run_definitions_provenance_json_type_check" CHECK (jsonb_typeof("workflow_run_definitions"."provenance") = 'object')
);
--> statement-breakpoint
ALTER TABLE "workflow_run_definitions" ADD CONSTRAINT "workflow_run_definitions_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_run_definitions" ADD CONSTRAINT "workflow_run_definitions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;

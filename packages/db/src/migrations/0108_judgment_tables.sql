-- 0108: judgment_definitions / judgment_calls (판단 계층 B-1).
--   pnpm db:generate 는 meta 스냅샷 충돌(0103/0106 이 같은 prevId 를 가짐 — 기존 결함,
--   0107 주석에 문서화됨)으로 실행 자체가 실패한다. 0107 과 같은 저장소 관행대로
--   증분 CREATE TABLE 만 수기 작성하고 journal 에 등록한다. 런타임은 journal + SQL
--   파일만 적용한다(client.ts 참조).
--   판단 결과는 권고다: outcome 'executed'/'observed' 는 예약어이며 현재 생성 경로는
--   'observed' 뿐이다. 실행제어 경로(하트비트/워크플로우/PLAN-QA)는 이 테이블을 읽지 않는다.

CREATE TABLE "judgment_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"provider_id" text NOT NULL,
	"model_id" text NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "judgment_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"definition_version" integer NOT NULL,
	"context_type" text NOT NULL,
	"context_id" text NOT NULL,
	"correlation_key" text,
	"input_state" jsonb NOT NULL,
	"questions" jsonb NOT NULL,
	"answers" jsonb,
	"outcome" text NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(12, 6),
	"provider_id" text,
	"model_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "judgment_definitions" ADD CONSTRAINT "judgment_definitions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "judgment_calls" ADD CONSTRAINT "judgment_calls_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "judgment_calls" ADD CONSTRAINT "judgment_calls_definition_id_judgment_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."judgment_definitions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "judgment_definitions_company_name_version_uq" ON "judgment_definitions" USING btree ("company_id", "name", "version");
--> statement-breakpoint
CREATE INDEX "idx_judgment_calls_company_context_created_at" ON "judgment_calls" USING btree ("company_id", "context_type", "context_id", "created_at");
--> statement-breakpoint
CREATE INDEX "idx_judgment_calls_correlation_key" ON "judgment_calls" USING btree ("correlation_key");

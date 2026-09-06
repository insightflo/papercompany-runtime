-- 0100: n8n-style workflow webhook 구성/접수 테이블 (additive only).
--   workflow_webhook_configs: 워크플로우당 1행(UNIQUE workflow_id). secret_ref 는
--     versioned company secret 의 name 참조("workflow-webhook:<workflowId>")이며
--     시크릿 값 자체는 company_secrets/company_secret_versions 에만 저장된다.
--   workflow_webhook_deliveries: 수신 접수 영수증. (company, workflow, idempotency_key)
--     UNIQUE 로 재생 방지 — 동시 수신에서도 1행만 성립. (workflow_id, received_at)
--     인덱스로 쿼타 윈도우 카운트를 단일 트랜잭션 안에서 계산한다.
--   run_id 는 트리거 성공 후 바인딩되는 표시 값이며 실행 권위가 아니다.

CREATE TABLE "workflow_webhook_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"secret_ref" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"secret_last4" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"run_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_webhook_configs" ADD CONSTRAINT "workflow_webhook_configs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_webhook_configs" ADD CONSTRAINT "workflow_webhook_configs_workflow_id_workflow_definitions_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_definitions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_webhook_deliveries" ADD CONSTRAINT "workflow_webhook_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workflow_webhook_deliveries" ADD CONSTRAINT "workflow_webhook_deliveries_workflow_id_workflow_definitions_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_definitions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_webhook_configs_workflow_id_uq" ON "workflow_webhook_configs" USING btree ("workflow_id");
--> statement-breakpoint
CREATE INDEX "idx_workflow_webhook_configs_company_id" ON "workflow_webhook_configs" USING btree ("company_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_webhook_deliveries_idempotency_uq" ON "workflow_webhook_deliveries" USING btree ("company_id","workflow_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "idx_workflow_webhook_deliveries_workflow_received_at" ON "workflow_webhook_deliveries" USING btree ("workflow_id","received_at");

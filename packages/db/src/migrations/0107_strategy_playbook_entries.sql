-- 0107: strategy_playbook_entries (쇼츠 컴퍼니 Phase F).
--   pnpm db:generate 는 meta 스냅샷 충돌(0103/0106 이 같은 prevId 를 가짐 — 기존 결함)으로
--   실행 자체가 실패한다. 0100~0102 와 같은 저장소 관행대로 증분 CREATE TABLE 만 수기
--   작성하고 journal 에 등록한다. 런타임은 journal + SQL 파일만 적용한다.
--   에이전트는 status='proposed' 행만 생성할 수 있고 active/retired 전이는 보드 전용.
--   channel/status 는 enum 이 아니라 text + 애플리케이션 검증으로 관리한다.

CREATE TABLE "strategy_playbook_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"trigger_type" text NOT NULL,
	"condition_json" jsonb NOT NULL,
	"action_type" text NOT NULL,
	"action_json" jsonb NOT NULL,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"proposed_by_agent_id" uuid,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "strategy_playbook_entries" ADD CONSTRAINT "strategy_playbook_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "strategy_playbook_entries" ADD CONSTRAINT "strategy_playbook_entries_proposed_by_agent_id_agents_id_fk" FOREIGN KEY ("proposed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_strategy_playbook_entries_company_id" ON "strategy_playbook_entries" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "idx_strategy_playbook_entries_status" ON "strategy_playbook_entries" USING btree ("status");

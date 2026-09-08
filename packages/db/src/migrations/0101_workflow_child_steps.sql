-- 0101: workflow → workflow 자식 실행(n8n "Execute Workflow"), descope v1 계약.
--   [descope v1] 이 마이그레이션은 미출하(never shipped) — in-place 편집만 허용되며
--   호환 마이그레이션/데이터 수리는 금지된다.
--   workflow_runs: 부모 run 연결 컬럼(self-FK, indexed) — 자식 run 의 깊이/루트 추적용.
--   workflow_step_invocations: 부모 step-run 당 UNIQUE 1행. 자식 run 생성의 멱등 클레임.
--     descope v1 상태 기계(설계 §2):
--       state='claimed' + NULL  → 트랜잭션 로컬 구성 상태만 허용(커밋 불가 — deferred 트리거).
--       state='linked' + nonNULL → 정상 링크(Ready/Linked/Initializing/Materialized/Terminal).
--       state='linked' + NULL   → 자식 삭제 tombstone(FK ON DELETE SET NULL) — 재생성 금지,
--         bound pending 부모 스텝은 child_run_failed 로 정산.
--     generation 은 항상 1(재시도 세대 없음 — descope D2). wait 컬럼 없음(descope D1 —
--     wait:true only, 요청 모드의 내구 기록 자체를 제거한다).
--   [descope D6] 정의 활성 자식 존재 중 archive/삭제 차단 트리거 + claim 쪽 잠금 직렬화는
--   애플리케이션(repo lock 순서)과 이 트리거가 이중 방어한다.

ALTER TABLE "workflow_runs" ADD COLUMN "parent_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "parent_step_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "root_run_id" uuid;
--> statement-breakpoint
-- 자식 초기화 소유/임대/마감/materialization 영수증 — 내구 실행 권위.
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
	-- [r8 finding 1] 보존된 대상 정의 신원 — 자식 run 삭제로 대상 정의가 지워져도 invocation 이
	-- 이력을 유지한다(cascading/SET NULL FK 아님 — 완전 정산 후 정의 삭제를 막지 않는다).
	"target_workflow_id" uuid NOT NULL,
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
-- [descope v1] 상태 기계 SQL CHECK — claimed/linked 외 상태와 generation != 1 은 새 데이터에서
-- 구조적으로 불가능하다(고아 수리/재시도 세대 부활 금지).
ALTER TABLE "workflow_step_invocations" ADD CONSTRAINT "workflow_step_invocations_state_ck" CHECK ("state" IN ('claimed', 'linked'));
--> statement-breakpoint
ALTER TABLE "workflow_step_invocations" ADD CONSTRAINT "workflow_step_invocations_generation_one_ck" CHECK ("generation" = 1);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_step_invocations_parent_step_run_id_uq" ON "workflow_step_invocations" USING btree ("parent_step_run_id");
--> statement-breakpoint
-- [descope v1] 두 invocation 이 하나의 자식 run 을 공유하지 못한다(비 NULL 링크에만 적용 —
-- tombstone 의 NULL 은 제외).
CREATE UNIQUE INDEX "workflow_step_invocations_child_run_id_uq" ON "workflow_step_invocations" USING btree ("child_run_id") WHERE "child_run_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "idx_workflow_step_invocations_company_id" ON "workflow_step_invocations" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "idx_workflow_step_invocations_child_run_id" ON "workflow_step_invocations" USING btree ("child_run_id");
--> statement-breakpoint
CREATE INDEX "idx_workflow_step_invocations_target_workflow_id" ON "workflow_step_invocations" USING btree ("target_workflow_id");
--> statement-breakpoint
-- [r8 finding 1] 대상 신원 불변 — 정상 런타임 writer 는 이 컬럼을 갱신하지 않는다. 신원 보호용
-- 새 데이터 불변식(수리 아님). 변경 시도는 23514 로 거부된다.
CREATE OR REPLACE FUNCTION workflow_step_invocations_target_identity_immutable() RETURNS trigger AS $$
BEGIN
	IF NEW."target_workflow_id" IS DISTINCT FROM OLD."target_workflow_id" THEN
		RAISE EXCEPTION 'workflow_child_target_identity_immutable' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "workflow_step_invocations_target_identity_immutable_trg"
BEFORE UPDATE OF "target_workflow_id" ON "workflow_step_invocations"
FOR EACH ROW
EXECUTE FUNCTION "workflow_step_invocations_target_identity_immutable"();
--> statement-breakpoint
-- 자식 초기화 식별 유일성 — 동시 materialization 이 동일 스텝을 이중 생성하지 못한다.
CREATE UNIQUE INDEX "workflow_step_runs_run_step_uq" ON "workflow_step_runs" USING btree ("workflow_run_id","step_id");
--> statement-breakpoint
-- [descope v1] 커밋 시 linked 강제(deferred constraint trigger): 클레임+자식 생성+링크는 단일
-- 트랜잭션으로만 커밋될 수 있다. 커밋 시점에 현재 행을 ID 로 재조회해 최종 상태가 linked 가
-- 아니면 전체 트랜잭션이 롤백된다 — committed claimed 행은 새 데이터에서 기계적으로 불가능.
CREATE OR REPLACE FUNCTION workflow_step_invocations_require_linked_at_commit() RETURNS trigger AS $$
DECLARE current_state text;
BEGIN
	SELECT state INTO current_state FROM workflow_step_invocations WHERE id = NEW.id;
	IF current_state IS DISTINCT FROM 'linked' THEN
		RAISE EXCEPTION 'workflow_step_invocation_committed_non_linked' USING ERRCODE = '23514';
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "workflow_step_invocations_linked_at_commit_trg"
AFTER INSERT OR UPDATE OF "state", "child_run_id" ON "workflow_step_invocations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "workflow_step_invocations_require_linked_at_commit"();
--> statement-breakpoint
-- [descope D6 + r8 finding 1] 정의 활성 자식 invocation 캐논컬 가드 — 애플리케이션과 양쪽
-- 트리거가 이 함수 하나만 호출한다(두 번째 손복사 술어 금지). VOLATILE: 가드 읽기가 정의 행
-- 잠금 획득 이전이 아닌 이후 커밋된 클레임을 봐야 한다. 활성 = 완전 정산+법정(valid settled)
-- 이 아닌 연관 행 하나라도 존재. LEFT JOIN 으로 불량 참조를 보존해 fail-closed 하며,
-- 커밋된 claimed/retry 표식/깨진 포인터/회사 불일치/불법 종말 자식(영수증·임대 규칙 위반)도
-- 보호를 유지한다. S.pending 은 C 가 완료돼도 항상 보호, C.pending/running 은 S 가 종말이어도
-- 항상 보호한다. 존재하지 않는 대상 정의는 '정당히 삭제된 정산 이력'에서만 허용된다.
-- 표시 전용 프로젝션/정의 스텝 텍스트로 유실 신원을 복구하지 않는다.
CREATE OR REPLACE FUNCTION workflow_definition_has_active_child_invocations(
	definition_id uuid
) RETURNS boolean LANGUAGE sql VOLATILE AS $$
WITH inv AS (
	SELECT i.id, i.child_run_id, i.parent_step_run_id,
			p.workflow_id AS parent_definition_id,
			cp.workflow_id AS marked_parent_definition_id,
			c.workflow_id AS child_definition_id, i.target_workflow_id,
			(
				p.id IS NOT NULL AND s.id IS NOT NULL
				AND i.company_id = p.company_id
				AND i.state = 'linked' AND i.generation = 1
				AND s.retry_count = 0
				AND NOT(COALESCE(s.metadata, '{}'::jsonb) ? 'workflowRetry')
				AND s.status IN ('completed','failed','skipped')
				AND (td.id IS NULL OR td.company_id = i.company_id)
				AND (
					i.child_run_id IS NULL
					OR (
						c.id IS NOT NULL AND c.company_id = i.company_id
						AND c.parent_run_id = p.id AND c.parent_step_run_id = s.id
						AND c.workflow_id = i.target_workflow_id
						AND c.status IN ('completed','failed','cancelled','aborted','timed-out')
						AND c.child_start_token IS NULL
						AND c.child_start_lease_expires_at IS NULL
						AND (
							c.child_start_materialized_at IS NOT NULL
							OR (c.status <> 'completed' AND NOT EXISTS (
								SELECT 1 FROM workflow_step_runs cs WHERE cs.workflow_run_id = c.id
							))
						)
					)
				)
			) IS TRUE AS fully_settled_valid
	FROM workflow_step_invocations i
	LEFT JOIN workflow_step_runs s ON s.id = i.parent_step_run_id
	LEFT JOIN workflow_runs p ON p.id = s.workflow_run_id
	LEFT JOIN workflow_runs c ON c.id = i.child_run_id
	LEFT JOIN workflow_runs cp ON cp.id = c.parent_run_id
	LEFT JOIN workflow_definitions td ON td.id = i.target_workflow_id
)
SELECT EXISTS (
	SELECT 1 FROM inv
	WHERE (parent_definition_id = definition_id
			OR marked_parent_definition_id = definition_id
			OR child_definition_id = definition_id
			OR target_workflow_id = definition_id)
		AND NOT fully_settled_valid
) OR EXISTS (
	SELECT 1 FROM workflow_runs mc
	LEFT JOIN workflow_runs mp ON mp.id = mc.parent_run_id
	LEFT JOIN workflow_step_runs ms ON ms.id = mc.parent_step_run_id
	LEFT JOIN workflow_runs msp ON msp.id = ms.workflow_run_id
	WHERE (mc.parent_run_id IS NOT NULL OR mc.parent_step_run_id IS NOT NULL
			OR mc.triggered_by = 'workflow-step')
		AND (mc.workflow_id = definition_id OR mp.workflow_id = definition_id
			OR msp.workflow_id = definition_id)
		AND NOT EXISTS (
			SELECT 1 FROM inv
			WHERE inv.child_run_id = mc.id
				AND inv.parent_step_run_id = mc.parent_step_run_id
				AND inv.fully_settled_valid
		)
);
$$;
--> statement-breakpoint
-- [descope D6] 정의 archive/삭제 트리거 — 캐논컬 가드 함수 단일 호출(설계 r8 §1). 부모
-- run/step 행은 잠그지 않는다(잠금 순서 역전 방지). TG_OP 반환 규칙: DELETE 는 OLD(행 삭제
-- 진행), UPDATE 는 NEW(archive 갱신 진행) — 반대 반환은 연산을 조용히 무효화한다.
CREATE OR REPLACE FUNCTION workflow_definitions_block_active_child_invocations() RETURNS trigger AS $$
BEGIN
	IF workflow_definition_has_active_child_invocations(OLD.id) THEN
		RAISE EXCEPTION 'workflow_definition_has_active_child_invocations' USING ERRCODE = '23514';
	END IF;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "workflow_definitions_block_active_child_archive_trg"
BEFORE UPDATE OF "status" ON "workflow_definitions"
FOR EACH ROW
WHEN (OLD."status" IS DISTINCT FROM 'archived' AND NEW."status" = 'archived')
EXECUTE FUNCTION "workflow_definitions_block_active_child_invocations"();
--> statement-breakpoint
CREATE TRIGGER "workflow_definitions_block_active_child_delete_trg"
BEFORE DELETE ON "workflow_definitions"
FOR EACH ROW
EXECUTE FUNCTION "workflow_definitions_block_active_child_invocations"();

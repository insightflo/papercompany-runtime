import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { workflowRuns } from "./workflow_runs.js";

/**
 * [파일 목적] Task5a1 실행정의 불변 스냅샷 테이블. run 생성 시점의 normalized 실행 정의를
 *   한 번만 기록하고 이후 수정/덮어쓰기 경로를 두지 않는다(PK 충돌 = 거부).
 * [외부 연결] 서버 워크플로 capture/load(execution-definition.ts)만 쓰며, importer/backfill
 *   route 나 app UPDATE 경로는 없다. consumer(dispatch/resume)는 후속 슬라이스.
 * [수정시 주의] CHECK 제약(schema_version/normalizer_version/execution_mode/hash/jsonb shape)은
 *   raw corrupt 입력을 DB 에서도 거부하는 fail-closed 계약이다. 임의 완화 금지.
 */

export const workflowRunDefinitions = pgTable(
  "workflow_run_definitions",
  {
    workflowRunId: uuid("workflow_run_id")
      .primaryKey()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    schemaVersion: integer("schema_version").notNull().default(1),
    definitionHash: text("definition_hash").notNull(),
    executionMode: text("execution_mode").notNull(),
    steps: jsonb("steps").$type<unknown[]>().notNull(),
    normalizerVersion: integer("normalizer_version").notNull().default(1),
    provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    schemaVersionCheck: check(
      "workflow_run_definitions_schema_version_check",
      sql`${table.schemaVersion} = 1`,
    ),
    normalizerVersionCheck: check(
      "workflow_run_definitions_normalizer_version_check",
      sql`${table.normalizerVersion} = 1`,
    ),
    executionModeCheck: check(
      "workflow_run_definitions_execution_mode_check",
      sql`${table.executionMode} in ('static_dag', 'dynamic_owner_plan')`,
    ),
    definitionHashCheck: check(
      "workflow_run_definitions_definition_hash_check",
      sql`${table.definitionHash} ~ '^[0-9a-f]{64}$'`,
    ),
    stepsJsonTypeCheck: check(
      "workflow_run_definitions_steps_json_type_check",
      sql`jsonb_typeof(${table.steps}) = 'array'`,
    ),
    provenanceJsonTypeCheck: check(
      "workflow_run_definitions_provenance_json_type_check",
      sql`jsonb_typeof(${table.provenance}) = 'object'`,
    ),
  }),
);

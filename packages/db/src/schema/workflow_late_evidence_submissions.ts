import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { issueWorkProducts } from "./issue_work_products.js";
import { missions } from "./missions.js";
import { workflowRuns } from "./workflow_runs.js";
import { workflowStepRuns } from "./workflow_step_runs.js";
import { workflowCuJobs } from "./workflow_cu_jobs.js";

/**
 * [목적] Task7 완료 producer 를 다시 실행하지 않는 늦은 근거 제출의 durable intake.
 *   manifest/readback hash 와 idempotency key 를 남겨 재조정(reconcile)이 안전해야 한다.
 *   artifactId 는 기존 artifact 저장소(issue_work_products) 행을 가리킨다(등록 전에는 null).
 *   감사 레코드이므로 FK 는 cascade 없이 no action.
 */
export const workflowLateEvidenceSubmissions = pgTable(
  "workflow_late_evidence_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    missionId: uuid("mission_id").notNull().references(() => missions.id),
    workflowRunId: uuid("workflow_run_id").notNull().references(() => workflowRuns.id),
    stepRunId: uuid("step_run_id").notNull().references(() => workflowStepRuns.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    executionGeneration: integer("execution_generation").notNull(),
    specSha256: text("spec_sha256").notNull(),
    manifestObject: text("manifest_object").notNull(),
    manifestSha256: text("manifest_sha256").notNull(),
    requestHash: text("request_hash").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    state: text("state").notNull().default("pending_readback"),
    artifactId: uuid("artifact_id").references(() => issueWorkProducts.id),
    readbackHash: text("readback_hash"),
    code: text("code"),
    // Task2 private immutable export/result bytes. Neither these nor receiver success mark verified.
    cuJobId: uuid("cu_job_id").references(() => workflowCuJobs.id),
    cuSnapshotBase64: text("cu_snapshot_base64"),
    cuSnapshotSha256: text("cu_snapshot_sha256"),
    cuResultBase64: text("cu_result_base64"),
    cuResultSha256: text("cu_result_sha256"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
  },
  (table) => ({
    stepIdempotencyUq: uniqueIndex("workflow_late_evidence_submissions_step_idempotency_uq").on(
      table.companyId,
      table.stepRunId,
      table.idempotencyKey,
    ),
    stateCreatedIdx: index("idx_workflow_late_evidence_submissions_state_created_at").on(
      table.state,
      table.createdAt,
    ),
    stateCheck: check(
      "workflow_late_evidence_submissions_state_check",
      sql`${table.state} in ('pending_readback', 'verified', 'blocked')`,
    ),
    executionGenerationCheck: check(
      "workflow_late_evidence_submissions_execution_generation_check",
      sql`${table.executionGeneration} >= 0`,
    ),
    attemptsCheck: check(
      "workflow_late_evidence_submissions_attempts_check",
      sql`${table.attempts} >= 0`,
    ),
  }),
);

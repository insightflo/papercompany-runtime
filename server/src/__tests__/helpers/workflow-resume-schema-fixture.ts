import { randomUUID } from "node:crypto";
import {
  workflowLateEvidenceSubmissions,
  workflowResumeExecutions,
  workflowResumeRequests,
  type Db,
} from "@paperclipai/db";
import {
  seedCompanyWithMission,
  seedWorkflowDefinition,
  seedWorkflowRun,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
  type RawSql,
} from "./workflow-execution-definition-fixture.js";
/**
 * [목적] Task6a/Task7 resume 저장소 테이블(workflow_resume_requests /
 *   workflow_resume_executions / workflow_late_evidence_submissions) 검증 픽스처.
 *   실제 임베디드 PostgreSQL 에 마이그레이션을 적용하고 company→mission→run→step→issue
 *   최소 scope 을 시딩한다. mock DB 없음, 프로덕션 데이터 없음.
 */

export type ResumeSchemaFixtureDb = {
  connectionString: string;
  db: Db;
  sql: RawSql;
  cleanup(): Promise<void>;
};

export type ResumeSchemaFixture =
  | { supported: false; reason: string }
  | ({ supported: true } & ResumeSchemaFixtureDb);

export async function startResumeSchemaFixture(testName: string): Promise<ResumeSchemaFixture> {
  const base = await startExecutionDefinitionFixture(testName);
  if (!base.supported) return base;
  const fixture: ExecutionDefinitionFixture = base;
  return {
    supported: true,
    connectionString: fixture.connectionString,
    db: fixture.db,
    sql: fixture.sql,
    cleanup: () => fixture.cleanup(),
  };
}

export type ResumeScopeIds = {
  companyId: string;
  agentId: string;
  missionId: string;
  workflowId: string;
  workflowRunId: string;
  stepRunId: string;
  issueId: string;
};

export async function seedResumeScope(sql: RawSql, prefix: string): Promise<ResumeScopeIds> {
  const company = await seedCompanyWithMission(sql, prefix);
  const workflowId = await seedWorkflowDefinition(sql, {
    companyId: company.companyId,
    name: `resume-schema-${prefix}`,
  });
  const workflowRunId = await seedWorkflowRun(sql, {
    workflowId,
    companyId: company.companyId,
    missionId: company.missionId,
    status: "completed",
  });
  const stepRunId = randomUUID();
  await sql`
    INSERT INTO workflow_step_runs (id, workflow_run_id, step_id, status)
    VALUES (${stepRunId}, ${workflowRunId}, 'resume-step', 'completed')
  `;
  const issueId = randomUUID();
  await sql`
    INSERT INTO issues (id, company_id, mission_id, title)
    VALUES (${issueId}, ${company.companyId}, ${company.missionId}, ${'Resume schema issue ' + prefix})
  `;
  return {
    companyId: company.companyId,
    agentId: company.agentId,
    missionId: company.missionId,
    workflowId,
    workflowRunId,
    stepRunId,
    issueId,
  };
}

export async function seedIssueWorkProduct(
  sql: RawSql,
  input: { companyId: string; issueId: string },
): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO issue_work_products (id, company_id, issue_id, type, provider, title, status)
    VALUES (${id}, ${input.companyId}, ${input.issueId}, 'video', 'test-provider', ${'Resume evidence ' + input.issueId}, 'completed')
  `;
  return id;
}

/** postgres.js 가 던지는 서버 에러(code/constraint_name 노출). */
export type PgServerError = Error & { code?: string; constraint_name?: string };

export async function capturePgError(promise: Promise<unknown>): Promise<PgServerError> {
  try {
    await promise;
  } catch (error) {
    return error as PgServerError;
  }
  throw new Error("Expected the statement to be rejected by the database");
}

export function hex64(seed: string): string {
  let out = "";
  for (let i = 0; i < 64; i += 1) out += ((seed.charCodeAt(i % seed.length) + i) % 16).toString(16);
  return out;
}

/** 3 테이블 drizzle insert 빌더. overrides 로 제약 위반 케이스를 쉽게 조립한다. */
export function buildResumeSchemaWriters(db: Db, scope: ResumeScopeIds) {
  const insertRequest = (overrides: Record<string, unknown> = {}) =>
    db.insert(workflowResumeRequests).values({
      companyId: scope.companyId,
      missionId: scope.missionId,
      workflowRunId: scope.workflowRunId,
      idempotencyKey: randomUUID(),
      requestHash: hex64("request"),
      snapshotHash: hex64("snapshot"),
      definitionHash: hex64("definition"),
      requestBody: { reason: "flaky-dispatch", snapshotToken: "token-1" },
      beforeState: { missionStatus: "completed", runStatus: "completed" },
      appliedGenerations: { publish: 3 },
      ...overrides,
    } as never);
  const insertExecution = (requestId: string, overrides: Record<string, unknown> = {}) =>
    db.insert(workflowResumeExecutions).values({
      requestId,
      companyId: scope.companyId,
      missionId: scope.missionId,
      workflowRunId: scope.workflowRunId,
      authorityVersion: 2,
      generations: { publish: 4 },
      ...overrides,
    } as never);
  const insertLateEvidence = (overrides: Record<string, unknown> = {}) =>
    db.insert(workflowLateEvidenceSubmissions).values({
      companyId: scope.companyId,
      missionId: scope.missionId,
      workflowRunId: scope.workflowRunId,
      stepRunId: scope.stepRunId,
      issueId: scope.issueId,
      executionGeneration: 3,
      specSha256: hex64("spec"),
      manifestObject: `company-storage/run/${scope.stepRunId}/manifest.json`,
      manifestSha256: hex64("manifest"),
      requestHash: hex64("late-request"),
      idempotencyKey: randomUUID(),
      ...overrides,
    } as never);
  const newRequestId = async (overrides: Record<string, unknown> = {}) => {
    const [row] = await insertRequest(overrides).returning({ id: workflowResumeRequests.id });
    return row.id;
  };
  const newLateEvidenceId = async (overrides: Record<string, unknown> = {}) => {
    const [row] = await insertLateEvidence(overrides).returning({
      id: workflowLateEvidenceSubmissions.id,
    });
    return row.id;
  };
  return { insertRequest, insertExecution, insertLateEvidence, newRequestId, newLateEvidenceId };
}

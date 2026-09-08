import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import {
  buildResumeSchemaWriters,
  capturePgError,
  hex64,
  seedIssueWorkProduct,
  seedResumeScope,
  startResumeSchemaFixture,
  type RawSql,
  type ResumeSchemaFixture,
  type ResumeScopeIds,
} from "./helpers/workflow-resume-schema-fixture.js";

/**
 * [목적] Task6a/Task7 resume 저장소 3 테이블의 실DB 계약 검증 (임베디드 PostgreSQL).
 *   상태 표시로 성공을 추론하지 않는다. CHECK/FK/unique 제약 위반과 정확히 저장된
 *   컬럼 값(snake_case 매핑, default, jsonb 타입, transaction rollback)만 단언한다.
 *   엔드포인트/apply/dispatch 서비스는 이 슬라이스 범위가 아니다.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("workflow resume storage schema", () => {
  let fixture: ResumeSchemaFixture;
  let db: Db;
  let sql: RawSql;
  let scope: ResumeScopeIds;
  let writers: ReturnType<typeof buildResumeSchemaWriters>;

  beforeAll(async () => {
    fixture = await startResumeSchemaFixture("resume-schema-");
    if (!fixture.supported) throw new Error(fixture.reason);
    db = fixture.db;
    sql = fixture.sql;
    scope = await seedResumeScope(sql, "RS1");
    const seededWorkProductId = await seedIssueWorkProduct(sql, {
      companyId: scope.companyId,
      issueId: scope.issueId,
    });
    writers = buildResumeSchemaWriters(db, scope);
    (writers as unknown as { workProductId: string }).workProductId = seededWorkProductId;
  }, 60_000);
  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  const workProductId = () => (writers as unknown as { workProductId: string }).workProductId;

  /** raw postgres.js 클라이언트는 timestamptz 를 문자열로 반환한다. */
  const toIso = (value: unknown) =>
    value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();

  it("persists resume requests with exact column values and typed defaults", async () => {
    const acceptedAt = new Date("2026-09-07T10:00:00.000Z");
    const leaseUntil = new Date("2026-09-07T10:05:00.000Z");
    const id = await writers.newRequestId({
      requestHash: hex64("full-request"),
      snapshotHash: hex64("full-snapshot"),
      definitionHash: hex64("full-definition"),
      requestBody: { snapshotToken: "t", reason: "r" },
      beforeState: { runStatus: "completed" },
      appliedGenerations: { "publish-clip": 7 },
      state: "blocked",
      code: "conflicting_run",
      leaseOwner: "worker-1",
      leaseUntil,
      deliveryAttempts: 2,
      acceptedAt,
    });
    const [row] = await sql`SELECT * FROM workflow_resume_requests WHERE id = ${id}`;
    expect(row).toMatchObject({
      company_id: scope.companyId,
      mission_id: scope.missionId,
      workflow_run_id: scope.workflowRunId,
      request_hash: hex64("full-request"),
      snapshot_hash: hex64("full-snapshot"),
      definition_hash: hex64("full-definition"),
      request_body: { snapshotToken: "t", reason: "r" },
      before_state: { runStatus: "completed" },
      applied_generations: { "publish-clip": 7 },
      state: "blocked",
      code: "conflicting_run",
      lease_owner: "worker-1",
      delivery_attempts: 2,
    });
    expect(toIso((row as Record<string, unknown>).lease_until)).toBe(leaseUntil.toISOString());
    expect(toIso((row as Record<string, unknown>).accepted_at)).toBe(acceptedAt.toISOString());

    const minimalId = await writers.newRequestId();
    const [minimal] = await sql`SELECT * FROM workflow_resume_requests WHERE id = ${minimalId}`;
    expect(minimal).toMatchObject({
      state: "pending_delivery",
      code: null,
      lease_owner: null,
      lease_until: null,
      delivery_attempts: 0,
      accepted_at: null,
    });
    const createdAt = new Date((minimal as Record<string, unknown>).created_at as string).getTime();
    expect(Math.abs(Date.now() - createdAt)).toBeLessThan(10_000);
  });

  it("rejects invalid state, negative attempts, half leases, duplicate keys, missing FKs", async () => {
    const badState = await capturePgError(writers.insertRequest({ state: "delivered" }));
    expect(badState.code).toBe("23514");
    expect(badState.constraint_name).toBe("workflow_resume_requests_state_check");

    const negativeAttempts = await capturePgError(writers.insertRequest({ deliveryAttempts: -1 }));
    expect(negativeAttempts.constraint_name).toBe("workflow_resume_requests_delivery_attempts_check");

    const ownerOnly = await capturePgError(writers.insertRequest({ leaseOwner: "worker-2" }));
    expect(ownerOnly.constraint_name).toBe("workflow_resume_requests_lease_check");
    const untilOnly = await capturePgError(
      writers.insertRequest({ leaseUntil: new Date("2026-09-07T11:00:00.000Z") }),
    );
    expect(untilOnly.constraint_name).toBe("workflow_resume_requests_lease_check");

    const key = randomUUID();
    await writers.insertRequest({ idempotencyKey: key });
    const duplicate = await capturePgError(writers.insertRequest({ idempotencyKey: key }));
    expect(duplicate.code).toBe("23505");
    expect(duplicate.constraint_name).toBe("workflow_resume_requests_run_idempotency_uq");

    const missingMission = await capturePgError(writers.insertRequest({ missionId: randomUUID() }));
    expect(missingMission.code).toBe("23503");
  });

  it("rolls back paired request+execution writes atomically", async () => {
    const sentinel = new Error("sentinel-rollback");
    let caught: unknown = null;
    try {
      await db.transaction(async (tx) => {
        const txWriters = buildResumeSchemaWriters(tx as unknown as Db, scope);
        const requestId = await txWriters.newRequestId({
          requestHash: hex64("tx-request"),
        });
        await txWriters.insertExecution(requestId);
        throw sentinel;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(sentinel);
    const [counts] = await sql`
      SELECT
        (SELECT count(*) FROM workflow_resume_requests WHERE request_hash = ${hex64("tx-request")}) AS requests,
        (SELECT count(*) FROM workflow_resume_executions) AS executions
    `;
    expect(counts).toMatchObject({ requests: "0", executions: "0" });
  });

  it("persists executions with defaults, exact values, and one-per-request uniqueness", async () => {
    const requestId = await writers.newRequestId();
    await writers.insertExecution(requestId, {
      state: "running",
      leaseOwner: "executor-1",
      leaseUntil: new Date("2026-09-07T12:00:00.000Z"),
      attempts: 1,
    });
    const [row] = await sql`SELECT * FROM workflow_resume_executions WHERE request_id = ${requestId}`;
    expect(row).toMatchObject({
      request_id: requestId,
      company_id: scope.companyId,
      mission_id: scope.missionId,
      workflow_run_id: scope.workflowRunId,
      authority_version: 2,
      generations: { publish: 4 },
      state: "running",
      lease_owner: "executor-1",
      attempts: 1,
      completed_at: null,
      code: null,
    });

    const duplicate = await capturePgError(writers.insertExecution(requestId));
    expect(duplicate.code).toBe("23505");
    expect(duplicate.constraint_name).toBe("workflow_resume_executions_request_uq");

    const badState = await capturePgError(
      writers.insertExecution(await writers.newRequestId(), { state: "paused" }),
    );
    expect(badState.constraint_name).toBe("workflow_resume_executions_state_check");
    const negativeAuthority = await capturePgError(
      writers.insertExecution(await writers.newRequestId(), { authorityVersion: -1 }),
    );
    expect(negativeAuthority.constraint_name).toBe(
      "workflow_resume_executions_authority_version_check",
    );
    const negativeAttempts = await capturePgError(
      writers.insertExecution(await writers.newRequestId(), { attempts: -2 }),
    );
    expect(negativeAttempts.constraint_name).toBe("workflow_resume_executions_attempts_check");
    const unpairedLease = await capturePgError(
      writers.insertExecution(await writers.newRequestId(), { leaseOwner: "executor-2" }),
    );
    expect(unpairedLease.constraint_name).toBe("workflow_resume_executions_lease_check");
  });

  it("persists late evidence with defaults, optional artifact FK, and constraint rejections", async () => {
    const verifiedId = await writers.newLateEvidenceId({
      artifactId: workProductId(),
      readbackHash: hex64("readback"),
      state: "verified",
      attempts: 1,
      verifiedAt: new Date("2026-09-07T13:00:00.000Z"),
    });
    const [row] = await sql`SELECT * FROM workflow_late_evidence_submissions WHERE id = ${verifiedId}`;
    expect(row).toMatchObject({
      company_id: scope.companyId,
      mission_id: scope.missionId,
      workflow_run_id: scope.workflowRunId,
      step_run_id: scope.stepRunId,
      issue_id: scope.issueId,
      execution_generation: 3,
      spec_sha256: hex64("spec"),
      manifest_sha256: hex64("manifest"),
      request_hash: hex64("late-request"),
      state: "verified",
      artifact_id: workProductId(),
      readback_hash: hex64("readback"),
      attempts: 1,
      code: null,
    });

    const pendingId = await writers.newLateEvidenceId();
    const [pending] = await sql`
      SELECT * FROM workflow_late_evidence_submissions WHERE id = ${pendingId}
    `;
    expect(pending).toMatchObject({
      state: "pending_readback",
      artifact_id: null,
      readback_hash: null,
      code: null,
      attempts: 0,
      verified_at: null,
    });

    const badState = await capturePgError(writers.insertLateEvidence({ state: "verified_early" }));
    expect(badState.constraint_name).toBe("workflow_late_evidence_submissions_state_check");
    const negativeGeneration = await capturePgError(
      writers.insertLateEvidence({ executionGeneration: -1 }),
    );
    expect(negativeGeneration.constraint_name).toBe(
      "workflow_late_evidence_submissions_execution_generation_check",
    );
    const negativeAttempts = await capturePgError(writers.insertLateEvidence({ attempts: -1 }));
    expect(negativeAttempts.constraint_name).toBe("workflow_late_evidence_submissions_attempts_check");
    const unknownArtifact = await capturePgError(writers.insertLateEvidence({ artifactId: randomUUID() }));
    expect(unknownArtifact.code).toBe("23503");

    const key = randomUUID();
    await writers.insertLateEvidence({ idempotencyKey: key });
    const duplicate = await capturePgError(writers.insertLateEvidence({ idempotencyKey: key }));
    expect(duplicate.code).toBe("23505");
    expect(duplicate.constraint_name).toBe("workflow_late_evidence_submissions_step_idempotency_uq");
  });

  it("creates pending lookup and uniqueness indexes", async () => {
    const indexes = await sql`
      SELECT indexname FROM pg_indexes WHERE tablename IN (
        'workflow_resume_requests', 'workflow_resume_executions', 'workflow_late_evidence_submissions'
      )
    `;
    const names = indexes.map((row) => (row as Record<string, unknown>).indexname);
    expect(names).toContain("workflow_resume_requests_run_idempotency_uq");
    expect(names).toContain("idx_workflow_resume_requests_state_lease_until");
    expect(names).toContain("workflow_resume_executions_request_uq");
    expect(names).toContain("idx_workflow_resume_executions_state_lease_until");
    expect(names).toContain("workflow_late_evidence_submissions_step_idempotency_uq");
    expect(names).toContain("idx_workflow_late_evidence_submissions_state_created_at");
  });
});

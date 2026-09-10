import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { createDb, issues, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { startExecutionDefinitionFixture } from "./helpers/workflow-execution-definition-fixture.js";
import type { ResumeExecutionHistoryScope } from "../services/workflow/resume/read-model.js";
import {
  canonicalWorkspaceDomain,
  captureHttpError,
  cleanupWorkspaceTables,
  dropIssueExecutionWorkspaceFk,
  expectDomainUnchanged,
  expectReason,
  findIssueExecutionWorkspaceFk,
  linkIssueExecutionWorkspace,
  readMissionWorkspacesReadonly,
  readModelScope,
  restoreIssueExecutionWorkspaceFk,
  seedExecutionWorkspace,
  seedForeignReadModelGraph,
  seedLinkedWakeup,
  seedReadModelHeartbeat,
  seedReadModelIssue,
  seedSelectedGraph,
  seedWorkspaceScopedOperation,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-resume-workspaces-fixture.js";

/**
 * [purpose] Task5c3e scope/precedence rejections via public readResumeMissionWorkspaceHistory —
 *   모든 호출(파싱 오류 포함)은 readMissionWorkspacesReadonly 안의 실제 repeatable-read read-only
 *   트랜잭션에서 실행된다(mocked read surface 없음). 타회사 오염 workspace/operation 은 정확한
 *   reason 으로, 결손 참조는 fixed missing_execution_workspace 로 거부되며 회사 검증이 missing
 *   검사보다 먼저다. 결손 참조는 격리 fixture 안에서 pg_constraint 로 발견한 FK 를 임시 drop 해
 *   시딩하고 finally 에서 데이터·원래 제약을 원복한다. accepted reader 의 오류는 그대로 전파된다.
 *   Real embedded Postgres, no mocks, no skipped suites. 파일 내 테스트는 직렬 실행이다.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
if (!embeddedPostgresSupport.supported) throw new Error(embeddedPostgresSupport.reason);

describe("readResumeMissionWorkspaceHistory — scope, precedence, and missing-reference rejections", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("resume-workspaces-scope-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = createDb(fixture.connectionString);
  }, 60_000);

  afterEach(async () => {
    await cleanupWorkspaceTables(db);
  });

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  /** [오염 독립 경로] seed → baseline → 공개 호출 거부 단언 → 무변화. 다른 원인 없이 단일 경로만 시딩. */
  async function rejectReason(
    seed: () => Promise<ResumeExecutionHistoryScope>,
    message: string,
    reason: string,
  ) {
    const scope = await seed();
    const before = await canonicalWorkspaceDomain(db);
    const error = await captureHttpError(expectDomainUnchanged(db, before, () =>
      readMissionWorkspacesReadonly(db, scope)));
    expectReason(error, message, reason);
    expect(await canonicalWorkspaceDomain(db)).toEqual(before);
  }

  it("rejects a foreign workspace whose only seed is a mission issue executionWorkspaceId", async () => {
    await rejectReason(async () => {
      const { graph } = await seedSelectedGraph(fixture.sql, db);
      const foreign = await seedForeignReadModelGraph(fixture.sql, db);
      const foreignWorkspace = await seedExecutionWorkspace(db, { companyId: foreign.companyId });
      const issueId = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
      await linkIssueExecutionWorkspace(db, issueId, foreignWorkspace);
      return readModelScope(graph);
    }, "scope_mismatch", "execution_workspace_company_mismatch");
  }, 30_000);

  it("rejects a foreign null-heartbeat operation on a same-company seeded workspace", async () => {
    await rejectReason(async () => {
      const { graph } = await seedSelectedGraph(fixture.sql, db);
      const foreign = await seedForeignReadModelGraph(fixture.sql, db);
      const workspaceId = await seedExecutionWorkspace(db, { companyId: graph.companyId });
      const issueId = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
      await linkIssueExecutionWorkspace(db, issueId, workspaceId);
      await seedWorkspaceScopedOperation(db, {
        companyId: foreign.companyId, executionWorkspaceId: workspaceId, phase: "cleanup", status: "running",
      });
      return readModelScope(graph);
    }, "scope_mismatch", "workspace_operation_company_mismatch");
  }, 30_000);

  it("rejects a foreign operation bound to an unrelated heartbeat on a same-company seeded workspace", async () => {
    await rejectReason(async () => {
      const { graph } = await seedSelectedGraph(fixture.sql, db);
      const foreign = await seedForeignReadModelGraph(fixture.sql, db);
      const workspaceId = await seedExecutionWorkspace(db, { companyId: graph.companyId });
      const issueId = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
      await linkIssueExecutionWorkspace(db, issueId, workspaceId);
      const foreignHeartbeat = await seedReadModelHeartbeat(db, {
        companyId: foreign.companyId, agentId: foreign.agentId,
      });
      await seedWorkspaceScopedOperation(db, {
        companyId: foreign.companyId, executionWorkspaceId: workspaceId, heartbeatRunId: foreignHeartbeat,
        phase: "exec", status: "running",
      });
      return readModelScope(graph);
    }, "scope_mismatch", "workspace_operation_company_mismatch");
  }, 30_000);

  it("checks every workspace company before operation company when both are joined", async () => {
    await rejectReason(async () => {
      const { graph } = await seedSelectedGraph(fixture.sql, db);
      const foreign = await seedForeignReadModelGraph(fixture.sql, db);
      const foreignWorkspace = await seedExecutionWorkspace(db, { companyId: foreign.companyId });
      const issueId = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
      await linkIssueExecutionWorkspace(db, issueId, foreignWorkspace);
      await seedWorkspaceScopedOperation(db, {
        companyId: foreign.companyId, executionWorkspaceId: foreignWorkspace, phase: "cleanup",
      });
      return readModelScope(graph);
      // workspace 와 operation 이 모두 오염 — workspace 회사 오류가 먼저 나야 한다.
    }, "scope_mismatch", "execution_workspace_company_mismatch");
  }, 30_000);

  it("ignores unrelated foreign workspaces and their operations that are never joined", async () => {
    const { graph } = await seedSelectedGraph(fixture.sql, db);
    const foreign = await seedForeignReadModelGraph(fixture.sql, db);
    const foreignWorkspace = await seedExecutionWorkspace(db, { companyId: foreign.companyId });
    const foreignOp = await seedWorkspaceScopedOperation(db, {
      companyId: foreign.companyId, executionWorkspaceId: foreignWorkspace, phase: "cleanup", status: "running",
    });
    const ownWorkspace = await seedExecutionWorkspace(db, { companyId: graph.companyId });
    const ownIssue = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    await linkIssueExecutionWorkspace(db, ownIssue, ownWorkspace);
    const ownOp = await seedWorkspaceScopedOperation(db, {
      companyId: graph.companyId, executionWorkspaceId: ownWorkspace, phase: "cleanup", status: "succeeded",
    });

    const before = await canonicalWorkspaceDomain(db);
    const result = await expectDomainUnchanged(db, before, () =>
      readMissionWorkspacesReadonly(db, readModelScope(graph)));

    // 조인되지 않은 타회사 행은 거부도 실패도 아닌 미수집 대상이다.
    expect(result.executionWorkspaces.map((row) => row.id)).toEqual([ownWorkspace]);
    expect(result.resources.workspaceOperations.map((row) => row.id)).toEqual([ownOp]);
    expect(result.resources.workspaceOperations.map((row) => row.id)).not.toContain(foreignOp);
  }, 30_000);

  it("propagates accepted collector company errors unchanged before any workspace query", async () => {
    const { graph } = await seedSelectedGraph(fixture.sql, db);
    const foreign = await seedForeignReadModelGraph(fixture.sql, db);
    const foreignHeartbeat = await seedReadModelHeartbeat(db, {
      companyId: foreign.companyId, agentId: foreign.agentId,
    });
    await seedLinkedWakeup(db, {
      companyId: graph.companyId, agentId: graph.agentId, missionId: graph.missionId, runId: foreignHeartbeat,
    });

    const before = await canonicalWorkspaceDomain(db);
    const error = await captureHttpError(expectDomainUnchanged(db, before, () =>
      readMissionWorkspacesReadonly(db, readModelScope(graph))));
    expectReason(error, "scope_mismatch", "heartbeat_company_mismatch");
  }, 30_000);

  it("propagates invalid selected scope unchanged (strict parsing errors, in readonly transactions)", async () => {
    const { graph } = await seedSelectedGraph(fixture.sql, db);
    const scope = readModelScope(graph);
    const before = await canonicalWorkspaceDomain(db);

    await expect(expectDomainUnchanged(db, before, () =>
      readMissionWorkspacesReadonly(db, { ...scope, extra: "key" } as never))).rejects.toBeInstanceOf(ZodError);
    expect(await canonicalWorkspaceDomain(db)).toEqual(before);
    await expect(expectDomainUnchanged(db, before, () =>
      readMissionWorkspacesReadonly(db, { ...scope, companyId: "not-a-uuid" } as never)))
      .rejects.toBeInstanceOf(ZodError);
    expect(await canonicalWorkspaceDomain(db)).toEqual(before);
  }, 30_000);

  it("rejects a dangling issue executionWorkspaceId with missing_execution_workspace (temporary FK drop, restored in finally)", async () => {
    const { graph } = await seedSelectedGraph(fixture.sql, db);
    const fk = await findIssueExecutionWorkspaceFk(fixture.sql);
    await dropIssueExecutionWorkspaceFk(fixture.sql, fk);
    const danglingId = randomUUID();
    try {
      await db.insert(issues).values({
        id: randomUUID(),
        companyId: graph.companyId,
        missionId: graph.missionId,
        title: "dangling workspace reference",
        status: "in_progress",
        originKind: "workflow_execution",
        executionWorkspaceId: danglingId,
      });
      const before = await canonicalWorkspaceDomain(db);
      const error = await captureHttpError(expectDomainUnchanged(db, before, () =>
        readMissionWorkspacesReadonly(db, readModelScope(graph))));
      expectReason(error, "resume_history_unproven", "missing_execution_workspace");
      expect(await canonicalWorkspaceDomain(db)).toEqual(before);
    } finally {
      await db.delete(issues).where(eq(issues.executionWorkspaceId, danglingId)); // 데이터 원복
      await restoreIssueExecutionWorkspaceFk(fixture.sql, fk); // 원래 제약 복원
    }
    // 복원 실제 확인 — 존재/개수뿐 아니라 캡처한 원래 정의(pg_get_constraintdef)와 정확 대조.
    const check = await fixture.sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conname = ${fk.name} AND conrelid = 'issues'::regclass AND contype = 'f'`;
    expect((check[0] as { definition: string } | undefined)?.definition).toBe(fk.definition);
  }, 30_000);

  it("rejects an operation company mismatch before a coexisting dangling missing workspace reference", async () => {
    const { graph } = await seedSelectedGraph(fixture.sql, db);
    const foreign = await seedForeignReadModelGraph(fixture.sql, db);
    const workspaceId = await seedExecutionWorkspace(db, { companyId: graph.companyId });
    const seededIssue = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    await linkIssueExecutionWorkspace(db, seededIssue, workspaceId);
    await seedWorkspaceScopedOperation(db, {
      companyId: foreign.companyId, executionWorkspaceId: workspaceId, phase: "cleanup", status: "running",
    });
    const fk = await findIssueExecutionWorkspaceFk(fixture.sql);
    await dropIssueExecutionWorkspaceFk(fixture.sql, fk);
    const danglingId = randomUUID();
    try {
      await db.insert(issues).values({
        id: randomUUID(),
        companyId: graph.companyId,
        missionId: graph.missionId,
        title: "dangling workspace reference with foreign operation",
        status: "in_progress",
        originKind: "workflow_execution",
        executionWorkspaceId: danglingId,
      });
      const before = await canonicalWorkspaceDomain(db);
      const error = await captureHttpError(expectDomainUnchanged(db, before, () =>
        readMissionWorkspacesReadonly(db, readModelScope(graph))));
      // 회사 검증이 missing 검사보다 먼저다 — dangling seed 가 있어도 operation 오염이 먼저 거부된다.
      expectReason(error, "scope_mismatch", "workspace_operation_company_mismatch");
    } finally {
      await db.delete(issues).where(eq(issues.executionWorkspaceId, danglingId));
      await restoreIssueExecutionWorkspaceFk(fixture.sql, fk);
    }
    // 복원 실제 확인 — 캡처한 원래 정의와 정확 대조(개수뿐인 확인이 아니다).
    const check = await fixture.sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conname = ${fk.name} AND conrelid = 'issues'::regclass AND contype = 'f'`;
    expect((check[0] as { definition: string } | undefined)?.definition).toBe(fk.definition);
  }, 30_000);
});

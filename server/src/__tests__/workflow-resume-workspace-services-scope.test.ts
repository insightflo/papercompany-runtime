import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  executionWorkspaces,
  workspaceRuntimeServices,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { startExecutionDefinitionFixture } from "./helpers/workflow-execution-definition-fixture.js";
import { readResumeMissionLinkedHistory } from "../services/workflow/resume/read-model-links.js";
import { readResumeMissionWorkspaceHistory } from "../services/workflow/resume/read-model-workspaces.js";
import type { ResumeExecutionHistoryScope } from "../services/workflow/resume/read-model.js";
import {
  canonicalWorkspaceDomain,
  captureHttpError,
  cleanupWorkspaceTables,
  expectDomainUnchanged,
  expectReason,
  linkIssueExecutionWorkspace,
  readMissionWorkspacesReadonly,
  readModelScope,
  seedExecutionWorkspace,
  seedForeignReadModelGraph,
  seedReadModelHeartbeat,
  seedReadModelIssue,
  seedSelectedGraph,
  seedWorkspaceRuntimeServiceRow,
  seedWorkspaceScopedOperation,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-resume-workspaces-fixture.js";

/**
 * [purpose] Task5c3f workspace service discovery scope/DB 검증 via public
 *   readResumeMissionWorkspaceHistory — 타회사 service 는 정확한 reason 으로 거부(executionWorkspaceId
 *   경로와 scopeId-only 경로 각각), workspace seed 부재 시 무관/타회사 service 미수집과
 *   projectId/cwd/sourceIssueId/derivedFrom 미순회, 실제 repeatable-read read-only 트랜잭션 안의
 *   공개 호출 반등등 + canonical service union, 실제 INSERT/UPDATE 의 SQLSTATE 25006 거부.
 *   모든 호출은 fresh canonical baseline+finally 무변화로 감싼다. Real embedded Postgres, no mocks.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
if (!embeddedPostgresSupport.supported) throw new Error(embeddedPostgresSupport.reason);

describe("readResumeMissionWorkspaceHistory — service scope rejection and readonly DB proof", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("resume-workspace-services-scope-");
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

  it("rejects a foreign-company service joined by executionWorkspaceId on a same-company seeded workspace", async () => {
    await rejectReason(async () => {
      const { graph } = await seedSelectedGraph(fixture.sql, db);
      const foreign = await seedForeignReadModelGraph(fixture.sql, db);
      const workspaceId = await seedExecutionWorkspace(db, { companyId: graph.companyId });
      const issueId = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
      await linkIssueExecutionWorkspace(db, issueId, workspaceId);
      // FK 는 id 전용이라 타회사 company 행도 실제 insert 된다 — 어떤 FK 도 비활성하지 않는다.
      await seedWorkspaceRuntimeServiceRow(db, {
        companyId: foreign.companyId, executionWorkspaceId: workspaceId,
        scopeType: "execution_workspace", scopeId: workspaceId, status: "running",
      });
      return readModelScope(graph);
    }, "scope_mismatch", "workspace_service_company_mismatch");
  }, 30_000);

  it("rejects a foreign-company service matched only by execution_workspace scopeId with executionWorkspaceId null", async () => {
    await rejectReason(async () => {
      const { graph } = await seedSelectedGraph(fixture.sql, db);
      const foreign = await seedForeignReadModelGraph(fixture.sql, db);
      const workspaceId = await seedExecutionWorkspace(db, { companyId: graph.companyId });
      const issueId = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
      await linkIssueExecutionWorkspace(db, issueId, workspaceId);
      const id = await seedWorkspaceRuntimeServiceRow(db, {
        companyId: foreign.companyId, executionWorkspaceId: workspaceId,
        scopeType: "execution_workspace", scopeId: workspaceId,
      });
      await db.update(workspaceRuntimeServices).set({ executionWorkspaceId: null })
        .where(eq(workspaceRuntimeServices.id, id));
      return readModelScope(graph);
    }, "scope_mismatch", "workspace_service_company_mismatch");
  }, 30_000);

  it("excludes unrelated same-company and foreign services without seeds and never traverses projectId/cwd/sourceIssueId/derivedFrom", async () => {
    const { graph } = await seedSelectedGraph(fixture.sql, db);
    const foreign = await seedForeignReadModelGraph(fixture.sql, db);
    // workspace seed 가 하나도 없는 상태 — seed 로 쓰지 않는 포인터들만 시딩한다.
    const foreignWs = await seedExecutionWorkspace(db, { companyId: foreign.companyId });
    const foreignSvc = await seedWorkspaceRuntimeServiceRow(db, {
      companyId: foreign.companyId, executionWorkspaceId: foreignWs,
      scopeType: "execution_workspace", scopeId: foreignWs,
    });
    const unrelatedWs = await seedExecutionWorkspace(db, { companyId: graph.companyId, name: "unrelated" });
    const unrelatedSvc = await seedWorkspaceRuntimeServiceRow(db, {
      companyId: graph.companyId, executionWorkspaceId: unrelatedWs,
      scopeType: "execution_workspace", scopeId: unrelatedWs,
    });
    const issueA = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    const sourceIssueWs = await seedExecutionWorkspace(db, {
      companyId: graph.companyId, sourceIssueId: issueA, name: "source-issue-only",
    });
    const derivedWs = await seedExecutionWorkspace(db, {
      companyId: graph.companyId, derivedFromExecutionWorkspaceId: sourceIssueWs, name: "derived-only",
    });
    const [wsRow] = await db.select().from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, sourceIssueWs));
    const projectSvc = await seedWorkspaceRuntimeServiceRow(db, {
      companyId: graph.companyId, executionWorkspaceId: sourceIssueWs,
      scopeType: "project", scopeId: wsRow!.projectId!,
    });
    await db.update(workspaceRuntimeServices)
      .set({ executionWorkspaceId: null, cwd: "/tmp/never-traversed" })
      .where(eq(workspaceRuntimeServices.id, projectSvc));

    const scope = readModelScope(graph);
    const before = await canonicalWorkspaceDomain(db);
    const base = await expectDomainUnchanged(db, before, () =>
      db.transaction((tx) => readResumeMissionLinkedHistory(tx, scope),
        { isolationLevel: "repeatable read", accessMode: "read only" }));
    const result = await expectDomainUnchanged(db, before, () => readMissionWorkspacesReadonly(db, scope));
    // seed 없음 — 조기 종료로 base service 와 정확히 같고 포인터 대상도 발견되지 않는다.
    expect(result.executionWorkspaces).toEqual([]);
    expect(result.resources.workspaceRuntimeServices).toEqual([]);
    expect(result.resources.workspaceRuntimeServices).toEqual(base.resources.workspaceRuntimeServices);
    for (const excluded of [foreignSvc, unrelatedSvc, projectSvc]) {
      expect(result.resources.workspaceRuntimeServices.map((row) => row.id)).not.toContain(excluded);
    }
    expect(before.executionWorkspaces.map((row) => row.id).sort())
      .toEqual([foreignWs, unrelatedWs, sourceIssueWs, derivedWs].sort()); // 대상들이 실재함을 확인

    // 실재하는 seed 하나 — 그 workspace 의 service 만 반환, 나머지는 계속 제외.
    const workspaceId = await seedExecutionWorkspace(db, { companyId: graph.companyId });
    const issueId = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    await linkIssueExecutionWorkspace(db, issueId, workspaceId);
    const ownSvc = await seedWorkspaceRuntimeServiceRow(db, {
      companyId: graph.companyId, executionWorkspaceId: workspaceId,
      scopeType: "execution_workspace", scopeId: workspaceId, status: "running",
    });
    const before2 = await canonicalWorkspaceDomain(db);
    const result2 = await expectDomainUnchanged(db, before2, () => readMissionWorkspacesReadonly(db, scope));
    expect(result2.resources.workspaceRuntimeServices)
      .toEqual(before2.workspaceRuntimeServices.filter((row) => row.id === ownSvc));
    expect(result2.executionWorkspaces.map((row) => row.id)).toEqual([workspaceId]);
    for (const excluded of [foreignSvc, unrelatedSvc, projectSvc]) {
      expect(result2.resources.workspaceRuntimeServices.map((row) => row.id)).not.toContain(excluded);
    }
  }, 30_000);

  it("proves repeatable-read read-only settings, per-call canonical invariance, repeat equality, and the exact canonical service union", async () => {
    const { graph, selectedStepRowIds } = await seedSelectedGraph(fixture.sql, db);
    const heartbeat = await seedReadModelHeartbeat(db, {
      companyId: graph.companyId, agentId: graph.agentId, workflowStepRunId: selectedStepRowIds[0]!,
    });
    const workspaceId = await seedExecutionWorkspace(db, { companyId: graph.companyId });
    const issueId = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    await linkIssueExecutionWorkspace(db, issueId, workspaceId);
    const baseSvc = await seedWorkspaceRuntimeServiceRow(db, {
      companyId: graph.companyId, executionWorkspaceId: workspaceId, startedByRunId: heartbeat, scopeType: "issue",
    }); // base 가 이미 보는 service — 병합 경로
    const wsSvc = await seedWorkspaceRuntimeServiceRow(db, {
      companyId: graph.companyId, executionWorkspaceId: workspaceId,
      scopeType: "execution_workspace", scopeId: workspaceId, status: "starting",
    }); // workspace 발견 전용 service
    const cleanupOp = await seedWorkspaceScopedOperation(db, {
      companyId: graph.companyId, executionWorkspaceId: workspaceId, heartbeatRunId: heartbeat,
      phase: "cleanup", status: "succeeded",
    });
    const scope = readModelScope(graph);
    const before = await canonicalWorkspaceDomain(db);

    await expectDomainUnchanged(db, before, () => db.transaction(async (tx) => {
      const isolation = await tx.execute<{ transaction_isolation: string }>(sql`SHOW transaction_isolation`);
      const readOnly = await tx.execute<{ transaction_read_only: string }>(sql`SHOW transaction_read_only`);
      expect(isolation[0]?.transaction_isolation).toBe("repeatable read");
      expect(readOnly[0]?.transaction_read_only).toBe("on");

      // 세 공개 호출 각각 fresh baseline 재캡처 + finally 비교.
      const base = await expectDomainUnchanged(db, before, () => readResumeMissionLinkedHistory(tx, scope));
      const first = await expectDomainUnchanged(db, before, () => readResumeMissionWorkspaceHistory(tx, scope));
      const second = await expectDomainUnchanged(db, before, () => readResumeMissionWorkspaceHistory(tx, scope));
      expect(second).toEqual(first); // 두 호출 exact deep equality
      expect(second.selected).toEqual(base.selected);
      expect(second.missionRuns).toEqual(base.missionRuns);
      expect(second.missionSteps).toEqual(base.missionSteps);
      expect(second.history).toEqual(base.history);
      expect(second.resources.finalizations).toEqual(base.resources.finalizations);
      expect(second.resources.finalizationSteps).toEqual(base.resources.finalizationSteps);
      expect(second.resources.missionAgentRuntimes).toEqual(base.resources.missionAgentRuntimes);
      expect(second.executionWorkspaces).toEqual(before.executionWorkspaces.filter((row) => row.id === workspaceId));
      expect(second.resources.workspaceOperations.map((row) => row.id)).toEqual([cleanupOp]);
      // operation 은 ID 뿐 아니라 전체 행이 base 와 before 로 exact 일치(계획 case8, unchanged).
      expect(second.resources.workspaceOperations)
        .toEqual(base.resources.workspaceOperations);
      expect(second.resources.workspaceOperations)
        .toEqual(before.workspaceOperations.filter((row) => row.id === cleanupOp));
      // service 는 base+workspace 발견의 exact canonical union.
      expect(second.resources.workspaceRuntimeServices).toEqual(before.workspaceRuntimeServices);
      expect(second.resources.workspaceRuntimeServices.map((row) => row.id)).toEqual([baseSvc, wsSvc].sort());
    }, { isolationLevel: "repeatable read", accessMode: "read only" }));
  }, 30_000);

  it("rejects real workspaceRuntimeServices INSERT and UPDATE in separate readonly transactions with 25006 and no successful write", async () => {
    const { graph } = await seedSelectedGraph(fixture.sql, db);
    const workspaceId = await seedExecutionWorkspace(db, { companyId: graph.companyId });
    const serviceId = await seedWorkspaceRuntimeServiceRow(db, {
      companyId: graph.companyId, executionWorkspaceId: workspaceId,
      scopeType: "execution_workspace", scopeId: workspaceId, status: "running",
    }); // setup 쓰기는 probe 밖
    const before = await canonicalWorkspaceDomain(db);

    let insertCode: unknown;
    await expectDomainUnchanged(db, before, async () => {
      try {
        await db.transaction(async (tx) => {
          await tx.insert(workspaceRuntimeServices).values({
            id: randomUUID(),
            companyId: graph.companyId,
            executionWorkspaceId: workspaceId,
            scopeType: "execution_workspace",
            scopeId: workspaceId,
            serviceName: "must-not-be-inserted",
            status: "running",
            lifecycle: "ephemeral",
            provider: "docker",
          });
        }, { isolationLevel: "repeatable read", accessMode: "read only" });
      } catch (error) {
        insertCode = (error as { code?: unknown }).code;
      }
    });
    expect(insertCode).toBe("25006"); // 실제 INSERT 거부 — 가정이 아닌 SQLSTATE 증명

    let updateCode: unknown;
    await expectDomainUnchanged(db, before, async () => {
      try {
        await db.transaction(async (tx) => {
          await tx.update(workspaceRuntimeServices).set({ status: "mutated-by-fixture-probe" })
            .where(eq(workspaceRuntimeServices.id, serviceId));
        }, { isolationLevel: "repeatable read", accessMode: "read only" });
      } catch (error) {
        updateCode = (error as { code?: unknown }).code;
      }
    });
    expect(updateCode).toBe("25006"); // 실제 UPDATE 거부 — 성공한 쓰기 없음(헬퍼 finally 비교)
  }, 30_000);
});

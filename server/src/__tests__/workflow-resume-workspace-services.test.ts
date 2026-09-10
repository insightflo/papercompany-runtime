import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, workspaceRuntimeServices, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { startExecutionDefinitionFixture } from "./helpers/workflow-execution-definition-fixture.js";
import {
  canonicalWorkspaceDomain,
  cleanupWorkspaceTables,
  expectDomainUnchanged,
  linkIssueExecutionWorkspace,
  readMissionWorkspacesReadonly,
  readModelScope,
  seedExecutionWorkspace,
  seedReadModelHeartbeat,
  seedReadModelIssue,
  seedSelectedGraph,
  seedWorkspaceRuntimeServiceRow,
  seedWorkspaceScopedOperation,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-resume-workspaces-fixture.js";

/**
 * [purpose] Task5c3f workspace service discovery via public readResumeMissionWorkspaceHistory —
 *   executionWorkspaceId 일치 또는 scopeType='execution_workspace'+scopeId 일치인 runtime service
 *   전체 행을 다른 heartbeat 가 시작했어도 발견한다. status/lifecycle raw 보존, base-linked 서비스와
 *   PK 접합 1회 병합 + lexical 정렬, executionWorkspaceId=null 인 scope-only 매치, 교차 포인터
 *   workspace 미순회, project/agent/run scope 부재. 모든 공개 호출은 실제 repeatable-read read-only
 *   트랜잭션이며 매 호출 fresh canonical baseline+finally 무변화. Real embedded Postgres, no mocks.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
if (!embeddedPostgresSupport.supported) throw new Error(embeddedPostgresSupport.reason);

describe("readResumeMissionWorkspaceHistory — workspace runtime service discovery", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("resume-workspace-services-");
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

  it("discovers a running service with no heartbeat and no issue linkage solely from the issue→workspace seed (exact full row)", async () => {
    const { graph } = await seedSelectedGraph(fixture.sql, db);
    const workspaceId = await seedExecutionWorkspace(db, { companyId: graph.companyId });
    const issueId = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    await linkIssueExecutionWorkspace(db, issueId, workspaceId);
    const id = await seedWorkspaceRuntimeServiceRow(db, {
      companyId: graph.companyId, executionWorkspaceId: workspaceId,
      scopeType: "execution_workspace", scopeId: workspaceId, status: "running",
    });
    const before = await canonicalWorkspaceDomain(db);
    const result = await expectDomainUnchanged(db, before,
      () => readMissionWorkspacesReadonly(db, readModelScope(graph)));
    // ID 뿐 아니라 exact full row — canonical 행과 정확 대조.
    expect(result.resources.workspaceRuntimeServices)
      .toEqual(before.workspaceRuntimeServices.filter((row) => row.id === id));
    expect(result.resources.workspaceRuntimeServices.map((row) => row.id)).toEqual([id]);
    expect(result.executionWorkspaces).toEqual(before.executionWorkspaces.filter((row) => row.id === workspaceId));
  }, 30_000);

  it("matches services by execution_workspace scopeId alone with executionWorkspaceId null and never by project/agent/run scope", async () => {
    const { graph } = await seedSelectedGraph(fixture.sql, db);
    // heartbeat 이 아닌 workspace UUID 를 scopeId 로 쓴다 — run scope 가 base heartbeat 와 우연 일치 불가.
    const workspaceId = await seedExecutionWorkspace(db, { companyId: graph.companyId });
    const issueId = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    await linkIssueExecutionWorkspace(db, issueId, workspaceId);
    const scopeOnly = await seedWorkspaceRuntimeServiceRow(db, {
      companyId: graph.companyId, executionWorkspaceId: workspaceId,
      scopeType: "execution_workspace", scopeId: workspaceId,
    });
    const runScope = await seedWorkspaceRuntimeServiceRow(db, {
      companyId: graph.companyId, executionWorkspaceId: workspaceId, scopeType: "run", scopeId: workspaceId,
    });
    const projectScope = await seedWorkspaceRuntimeServiceRow(db, {
      companyId: graph.companyId, executionWorkspaceId: workspaceId, scopeType: "project_workspace", scopeId: workspaceId,
    });
    const agentScope = await seedWorkspaceRuntimeServiceRow(db, {
      companyId: graph.companyId, executionWorkspaceId: workspaceId, scopeType: "agent", scopeId: workspaceId,
    });
    // helper 에 없는 필드는 승인된 패턴대로 직접 update(setup) — executionWorkspaceId 만 null 화.
    for (const target of [scopeOnly, runScope, projectScope, agentScope]) {
      await db.update(workspaceRuntimeServices).set({ executionWorkspaceId: null })
        .where(eq(workspaceRuntimeServices.id, target));
    }
    const before = await canonicalWorkspaceDomain(db);
    const result = await expectDomainUnchanged(db, before,
      () => readMissionWorkspacesReadonly(db, readModelScope(graph)));
    expect(result.resources.workspaceRuntimeServices)
      .toEqual(before.workspaceRuntimeServices.filter((row) => row.id === scopeOnly));
    expect(result.resources.workspaceRuntimeServices.map((row) => row.id)).toEqual([scopeOnly]);
    for (const excluded of [runScope, projectScope, agentScope]) {
      expect(result.resources.workspaceRuntimeServices.map((row) => row.id)).not.toContain(excluded);
    }
  }, 30_000);

  it("preserves every status and both lifecycles as raw full rows without widening history by the service owner heartbeat", async () => {
    const { graph } = await seedSelectedGraph(fixture.sql, db);
    const workspaceId = await seedExecutionWorkspace(db, { companyId: graph.companyId });
    const issueId = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    await linkIssueExecutionWorkspace(db, issueId, workspaceId);
    // mission-selected/mission-root 에 연결되지 않은 같은 회사 heartbeat — accepted helper 로 시딩.
    const unrelatedHb = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId });
    const statuses = ["running", "stopped", "failed", "starting", "unknown"];
    const statusIds: string[] = [];
    for (const status of statuses) {
      statusIds.push(await seedWorkspaceRuntimeServiceRow(db, {
        companyId: graph.companyId, executionWorkspaceId: workspaceId,
        scopeType: "execution_workspace", scopeId: workspaceId, status,
      }));
    }
    const sharedId = await seedWorkspaceRuntimeServiceRow(db, {
      companyId: graph.companyId, executionWorkspaceId: workspaceId,
      scopeType: "execution_workspace", scopeId: workspaceId, status: "stopped",
    });
    await db.update(workspaceRuntimeServices).set({ lifecycle: "shared" })
      .where(eq(workspaceRuntimeServices.id, sharedId));
    const ownerServiceId = await seedWorkspaceRuntimeServiceRow(db, {
      companyId: graph.companyId, executionWorkspaceId: workspaceId, startedByRunId: unrelatedHb,
      scopeType: "execution_workspace", scopeId: workspaceId,
    });
    const before = await canonicalWorkspaceDomain(db);
    const result = await expectDomainUnchanged(db, before,
      () => readMissionWorkspacesReadonly(db, readModelScope(graph)));
    // DB 전체 서비스 행 = 발견 union — 전체 raw 행(status/lifecycle 포함) 보존.
    expect(result.resources.workspaceRuntimeServices).toEqual(before.workspaceRuntimeServices);
    const byId = new Map(result.resources.workspaceRuntimeServices.map((row) => [row.id, row]));
    expect([...byId.keys()].sort()).toEqual([...statusIds, sharedId, ownerServiceId].sort());
    for (const [index, status] of statuses.entries()) {
      expect(byId.get(statusIds[index]!)?.status).toBe(status);
      expect(byId.get(statusIds[index]!)?.lifecycle).toBe("ephemeral");
    }
    expect(byId.get(sharedId)?.lifecycle).toBe("shared");
    // service 원본 owner heartbeat 는 raw 행에 보존되지만 이력 확장에는 절대 쓰이지 않는다.
    expect(byId.get(ownerServiceId)?.startedByRunId).toBe(unrelatedHb);
    expect(result.history.heartbeats.map((row) => row.id)).not.toContain(unrelatedHb);
  }, 30_000);

  it("merges base-linked and workspace-discovered services once by primary key in lexical order preserving null-workspace rows", async () => {
    const { graph } = await seedSelectedGraph(fixture.sql, db);
    const w1 = await seedExecutionWorkspace(db, { companyId: graph.companyId });
    const w2 = await seedExecutionWorkspace(db, { companyId: graph.companyId });
    const issue1 = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    await linkIssueExecutionWorkspace(db, issue1, w1);
    const issue2 = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    await linkIssueExecutionWorkspace(db, issue2, w2);
    const dual = await seedWorkspaceRuntimeServiceRow(db, {
      companyId: graph.companyId, executionWorkspaceId: w1, issueId: issue1, scopeType: "issue",
    }); // base(issueId)+workspace(executionWorkspaceId) 이중 경로 — PK 접합 1회
    const onW1 = await seedWorkspaceRuntimeServiceRow(db, {
      companyId: graph.companyId, executionWorkspaceId: w1, scopeType: "execution_workspace", scopeId: w1,
    });
    const onW2 = await seedWorkspaceRuntimeServiceRow(db, {
      companyId: graph.companyId, executionWorkspaceId: w2, scopeType: "execution_workspace", scopeId: w2,
    });
    const nullWs = await seedWorkspaceRuntimeServiceRow(db, {
      companyId: graph.companyId, executionWorkspaceId: w2, issueId: issue2, scopeType: "issue",
    });
    await db.update(workspaceRuntimeServices).set({ executionWorkspaceId: null })
      .where(eq(workspaceRuntimeServices.id, nullWs)); // base-linked 이지만 workspace 없는 행 보존 대상
    const before = await canonicalWorkspaceDomain(db);
    const result = await expectDomainUnchanged(db, before,
      () => readMissionWorkspacesReadonly(db, readModelScope(graph)));
    // canonical 전체 행 union — lexical 정렬, 각 PK 정확 1회.
    expect(result.resources.workspaceRuntimeServices).toEqual(before.workspaceRuntimeServices);
    expect(result.resources.workspaceRuntimeServices.map((row) => row.id))
      .toEqual([dual, nullWs, onW1, onW2].sort());
    expect(result.resources.workspaceRuntimeServices.filter((row) => row.id === dual)).toHaveLength(1);
    expect(result.executionWorkspaces).toEqual(before.executionWorkspaces.filter((row) => [w1, w2].includes(row.id)));
  }, 30_000);

  it("returns a same-company scopeId match unchanged even when it points at another workspace and never recurses there", async () => {
    const { graph } = await seedSelectedGraph(fixture.sql, db);
    const w1 = await seedExecutionWorkspace(db, { companyId: graph.companyId });
    const w2 = await seedExecutionWorkspace(db, { companyId: graph.companyId, name: "other" });
    const issue1 = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    await linkIssueExecutionWorkspace(db, issue1, w1);
    const cross = await seedWorkspaceRuntimeServiceRow(db, {
      companyId: graph.companyId, executionWorkspaceId: w2, scopeType: "execution_workspace", scopeId: w1,
    });
    const onW2 = await seedWorkspaceRuntimeServiceRow(db, {
      companyId: graph.companyId, executionWorkspaceId: w2, scopeType: "execution_workspace", scopeId: w2,
    });
    const opOnW2 = await seedWorkspaceScopedOperation(db, {
      companyId: graph.companyId, executionWorkspaceId: w2, phase: "cleanup", status: "running",
    });
    const before = await canonicalWorkspaceDomain(db);
    const result = await expectDomainUnchanged(db, before,
      () => readMissionWorkspacesReadonly(db, readModelScope(graph)));
    // scopeId 매치는 raw 그대로 반환 — executionWorkspaceId(다른 workspace)로 고치지 않는다.
    expect(result.resources.workspaceRuntimeServices)
      .toEqual(before.workspaceRuntimeServices.filter((row) => row.id === cross));
    expect(result.resources.workspaceRuntimeServices[0]!.executionWorkspaceId).toBe(w2);
    expect(result.executionWorkspaces.map((row) => row.id)).toEqual([w1]); // w2 재귀 미순회
    expect(result.resources.workspaceRuntimeServices.map((row) => row.id)).not.toContain(onW2);
    expect(result.resources.workspaceOperations.map((row) => row.id)).not.toContain(opOnW2);
  }, 30_000);
});

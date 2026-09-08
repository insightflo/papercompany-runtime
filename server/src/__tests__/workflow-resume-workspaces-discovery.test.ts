import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, missionAgentRuntimes, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { startExecutionDefinitionFixture } from "./helpers/workflow-execution-definition-fixture.js";
import { readResumeMissionLinkedHistory } from "../services/workflow/resume/read-model-links.js";
import {
  canonicalWorkspaceDomain,
  cleanupWorkspaceTables,
  expectDomainUnchanged,
  linkIssueExecutionWorkspace,
  readMissionWorkspacesReadonly,
  readModelScope,
  seedExecutionWorkspace,
  seedForeignReadModelGraph,
  seedReadModelHeartbeat,
  seedReadModelIssue,
  seedResourceMissionRuntime,
  seedSelectedGraph,
  seedWorkspaceRuntimeServiceRow,
  seedWorkspaceScopedOperation,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-resume-workspaces-fixture.js";

/**
 * [purpose] Task5c3e workspace discovery via public readResumeMissionWorkspaceHistory (항상 실제
 *   repeatable-read read-only 트랜잭션): issue/service/operation seed 경로 각각의 독립 발견 증명,
 *   null-heartbeat 정리 연산(accepted heartbeat-only linked base reader 는 누락), shared workspace 타-heartbeat 연산
 *   raw 병합, 중복 경로 PK 접합, seed 부재/비-FK 포인터(resourceId/sourceIssueId/derivedFrom) 미순회
 *   한계 문서화. 시딩은 baseline 전, 매 certified 호출 후 전체 도메인 비교(헬퍼가 매 호출 fresh baseline 재캡처).
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
if (!embeddedPostgresSupport.supported) throw new Error(embeddedPostgresSupport.reason);

describe("readResumeMissionWorkspaceHistory — workspace discovery", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("resume-workspaces-discovery-");
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

  it("discovers an issue-only workspace and its null-heartbeat cleanup operation that the base reader omits", async () => {
    const { graph } = await seedSelectedGraph(fixture.sql, db);
    const workspaceId = await seedExecutionWorkspace(db, { companyId: graph.companyId });
    const issueId = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    await linkIssueExecutionWorkspace(db, issueId, workspaceId);
    const cleanupOp = await seedWorkspaceScopedOperation(db, {
      companyId: graph.companyId, executionWorkspaceId: workspaceId,
      phase: "cleanup", command: "rm -rf .paperclip/worktree", status: "succeeded", exitCode: 0,
    });
    const scope = readModelScope(graph);
    const before = await canonicalWorkspaceDomain(db); // 기준 baseline — 헬퍼가 매 호출 fresh immediate baseline 재캡처

    const base = await expectDomainUnchanged(db, before, () =>
      db.transaction((tx) => readResumeMissionLinkedHistory(tx, scope),
        { isolationLevel: "repeatable read", accessMode: "read only" }));
    expect(base.resources.workspaceOperations).toEqual([]); // heartbeat-only accepted linked base reader 는 정리 연산을 누락한다

    const result = await expectDomainUnchanged(db, before, () => readMissionWorkspacesReadonly(db, scope));
    expect(result.executionWorkspaces).toEqual(before.executionWorkspaces.filter((row) => row.id === workspaceId));
    expect(result.resources.workspaceOperations.map((row) => row.id)).toEqual([cleanupOp]);
    expect(result.resources.workspaceOperations)
      .toEqual(before.workspaceOperations.filter((row) => row.id === cleanupOp));
    const opRow = result.resources.workspaceOperations[0]!;
    expect(opRow.executionWorkspaceId).toBe(workspaceId);
    expect(opRow.heartbeatRunId).toBeNull();
  }, 30_000);

  it("discovers a service-only workspace whose service is selected by issueId", async () => {
    const { graph } = await seedSelectedGraph(fixture.sql, db);
    const workspaceId = await seedExecutionWorkspace(db, { companyId: graph.companyId });
    const issueId = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    await seedWorkspaceRuntimeServiceRow(db, {
      companyId: graph.companyId, executionWorkspaceId: workspaceId, issueId, scopeType: "issue",
    });
    const cleanupOp = await seedWorkspaceScopedOperation(db, {
      companyId: graph.companyId, executionWorkspaceId: workspaceId, phase: "cleanup", status: "succeeded",
    });

    const before = await canonicalWorkspaceDomain(db);
    const result = await expectDomainUnchanged(db, before, () => readMissionWorkspacesReadonly(db, readModelScope(graph)));

    expect(result.executionWorkspaces).toEqual(before.executionWorkspaces.filter((row) => row.id === workspaceId));
    expect(result.resources.workspaceOperations).toEqual(before.workspaceOperations.filter((row) => row.id === cleanupOp));
    expect(result.executionWorkspaces.map((row) => row.id)).toEqual([workspaceId]);
    expect(result.resources.workspaceOperations.map((row) => row.id)).toEqual([cleanupOp]);
  }, 30_000);

  it("discovers a service-only workspace whose service is selected by startedByRunId", async () => {
    const { graph, selectedStepRowIds } = await seedSelectedGraph(fixture.sql, db);
    const heartbeat = await seedReadModelHeartbeat(db, {
      companyId: graph.companyId, agentId: graph.agentId, workflowStepRunId: selectedStepRowIds[0]!,
    });
    const workspaceId = await seedExecutionWorkspace(db, { companyId: graph.companyId });
    // startedByRunId 만 — issueId/scopeId-run 경로 없는 단일 seed.
    await seedWorkspaceRuntimeServiceRow(db, {
      companyId: graph.companyId, executionWorkspaceId: workspaceId, startedByRunId: heartbeat, scopeType: "issue",
    });
    const cleanupOp = await seedWorkspaceScopedOperation(db, {
      companyId: graph.companyId, executionWorkspaceId: workspaceId, phase: "cleanup", status: "succeeded",
    });

    const before = await canonicalWorkspaceDomain(db);
    const result = await expectDomainUnchanged(db, before, () => readMissionWorkspacesReadonly(db, readModelScope(graph)));

    expect(result.history.heartbeats.map((row) => row.id)).toEqual([heartbeat]);
    expect(result.executionWorkspaces).toEqual(before.executionWorkspaces.filter((row) => row.id === workspaceId));
    expect(result.resources.workspaceOperations).toEqual(before.workspaceOperations.filter((row) => row.id === cleanupOp));
    expect(result.executionWorkspaces.map((row) => row.id)).toEqual([workspaceId]);
    expect(result.resources.workspaceOperations.map((row) => row.id)).toEqual([cleanupOp]);
  }, 30_000);

  it("discovers an operation-only workspace selected by a known heartbeat operation plus its cleanup operation", async () => {
    const { graph, selectedStepRowIds } = await seedSelectedGraph(fixture.sql, db);
    const heartbeat = await seedReadModelHeartbeat(db, {
      companyId: graph.companyId, agentId: graph.agentId, workflowStepRunId: selectedStepRowIds[0]!,
    });
    const workspaceId = await seedExecutionWorkspace(db, { companyId: graph.companyId });
    const knownOp = await seedWorkspaceScopedOperation(db, {
      companyId: graph.companyId, executionWorkspaceId: workspaceId, heartbeatRunId: heartbeat,
      phase: "exec", command: "pnpm build", status: "succeeded", exitCode: 0,
    });
    const cleanupOp = await seedWorkspaceScopedOperation(db, {
      companyId: graph.companyId, executionWorkspaceId: workspaceId, phase: "cleanup", status: "succeeded",
    });

    const before = await canonicalWorkspaceDomain(db);
    const result = await expectDomainUnchanged(db, before, () => readMissionWorkspacesReadonly(db, readModelScope(graph)));

    expect(result.executionWorkspaces).toEqual(before.executionWorkspaces.filter((row) => row.id === workspaceId));
    expect(result.resources.workspaceOperations.map((row) => row.id)).toEqual([knownOp, cleanupOp].sort());
    expect(result.resources.workspaceOperations)
      .toEqual(before.workspaceOperations.filter((row) => [knownOp, cleanupOp].includes(row.id)));
  }, 30_000);

  it("merges shared-workspace operations with unrelated heartbeats and raw statuses, excluding unjoined workspaces and never widening history", async () => {
    const { graph, selectedStepRowIds } = await seedSelectedGraph(fixture.sql, db);
    const knownHb = await seedReadModelHeartbeat(db, {
      companyId: graph.companyId, agentId: graph.agentId, workflowStepRunId: selectedStepRowIds[0]!,
    });
    const unrelatedHb = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId });
    const sharedId = await seedExecutionWorkspace(db, { companyId: graph.companyId });
    const unrelatedId = await seedExecutionWorkspace(db, { companyId: graph.companyId, name: "unrelated" });
    const foreignGraph = await seedForeignReadModelGraph(fixture.sql, db);
    const foreignId = await seedExecutionWorkspace(db, { companyId: foreignGraph.companyId, name: "foreign" });
    const startedAt = new Date("2026-09-08T00:00:00.000Z");
    const finishedAt = new Date("2026-09-08T00:01:30.000Z");
    const knownOp = await seedWorkspaceScopedOperation(db, {
      companyId: graph.companyId, executionWorkspaceId: sharedId, heartbeatRunId: knownHb,
      phase: "exec", command: "pnpm test", status: "succeeded", exitCode: 0, startedAt, finishedAt,
      metadata: { origin: "known-heartbeat" },
    });
    const unrelatedOp = await seedWorkspaceScopedOperation(db, {
      companyId: graph.companyId, executionWorkspaceId: sharedId, heartbeatRunId: unrelatedHb,
      phase: "exec", command: "pnpm lint", status: "running", startedAt, metadata: { origin: "unrelated-heartbeat" },
    });
    const cleanupOp = await seedWorkspaceScopedOperation(db, {
      companyId: graph.companyId, executionWorkspaceId: sharedId,
      phase: "cleanup", command: "rm -rf tmp", status: "finalizing-unknown-text", exitCode: null,
      finishedAt, metadata: { cleanup: true },
    });
    const unrelatedWorkspaceOp = await seedWorkspaceScopedOperation(db, {
      companyId: graph.companyId, executionWorkspaceId: unrelatedId, phase: "cleanup", status: "running",
    });
    const foreignOp = await seedWorkspaceScopedOperation(db, {
      companyId: foreignGraph.companyId, executionWorkspaceId: foreignId, phase: "cleanup", status: "running",
    });

    const before = await canonicalWorkspaceDomain(db);
    const result = await expectDomainUnchanged(db, before, () => readMissionWorkspacesReadonly(db, readModelScope(graph)));

    expect(result.executionWorkspaces.map((row) => row.id)).toEqual([sharedId]);
    expect(result.resources.workspaceOperations.map((row) => row.id)).toEqual([knownOp, unrelatedOp, cleanupOp].sort());
    expect(result.history.heartbeats.map((row) => row.id)).toEqual([knownHb]); // unrelated heartbeat 미확장
    const raw = result.resources.workspaceOperations.find((row) => row.id === unrelatedOp)!;
    expect(raw.status).toBe("running"); // raw 상태 그대로 — 해석/실행 없음
    expect(raw.metadata).toEqual({ origin: "unrelated-heartbeat" });
    expect(raw.command).toBe("pnpm lint");
    expect(raw.startedAt).toEqual(startedAt);
    expect(raw.heartbeatRunId).toBe(unrelatedHb);
    const cleanup = result.resources.workspaceOperations.find((row) => row.id === cleanupOp)!;
    expect(cleanup.status).toBe("finalizing-unknown-text");
    expect(cleanup.heartbeatRunId).toBeNull();
    expect(cleanup.exitCode).toBeNull();
    expect(cleanup.finishedAt).toEqual(finishedAt);
    expect(cleanup.metadata).toEqual({ cleanup: true });
    for (const stray of [unrelatedWorkspaceOp, foreignOp]) {
      expect(result.resources.workspaceOperations.map((row) => row.id)).not.toContain(stray);
    }
  }, 30_000);

  it("collapses duplicate seed paths into one workspace row and merges duplicate operations by primary key", async () => {
    const { graph, selectedStepRowIds } = await seedSelectedGraph(fixture.sql, db);
    const heartbeat = await seedReadModelHeartbeat(db, {
      companyId: graph.companyId, agentId: graph.agentId, workflowStepRunId: selectedStepRowIds[0]!,
    });
    const workspaceId = await seedExecutionWorkspace(db, { companyId: graph.companyId });
    const issueId = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    await linkIssueExecutionWorkspace(db, issueId, workspaceId);
    const serviceId = await seedWorkspaceRuntimeServiceRow(db, {
      companyId: graph.companyId, executionWorkspaceId: workspaceId, issueId, scopeType: "issue",
    });
    const dualOp = await seedWorkspaceScopedOperation(db, {
      companyId: graph.companyId, executionWorkspaceId: workspaceId, heartbeatRunId: heartbeat,
      phase: "exec", status: "succeeded",
    });
    const nullWorkspaceOp = await seedWorkspaceScopedOperation(db, {
      companyId: graph.companyId, executionWorkspaceId: null, heartbeatRunId: heartbeat,
      phase: "exec", status: "succeeded",
    });

    const before = await canonicalWorkspaceDomain(db);
    const result = await expectDomainUnchanged(db, before, () => readMissionWorkspacesReadonly(db, readModelScope(graph)));

    // issue/service/operation 세 경로가 같은 workspace 를 seed — dedupe 로 정확히 1 행.
    expect(result.executionWorkspaces).toHaveLength(1);
    expect(result.executionWorkspaces).toEqual(before.executionWorkspaces.filter((row) => row.id === workspaceId));
    expect(result.resources.workspaceOperations.map((row) => row.id)).toEqual([dualOp, nullWorkspaceOp].sort());
    expect(result.resources.workspaceOperations.filter((row) => row.id === dualOp)).toHaveLength(1); // PK 접합 1회
    const dual = result.resources.workspaceOperations.find((row) => row.id === dualOp)!;
    expect(dual.heartbeatRunId).toBe(heartbeat);
    expect(dual.executionWorkspaceId).toBe(workspaceId);
    // workspace 없는 구 heartbeat-linked 연산은 그대로 보존된다.
    const preserved = result.resources.workspaceOperations.find((row) => row.id === nullWorkspaceOp)!;
    expect(preserved.executionWorkspaceId).toBeNull();
    expect(result.resources.workspaceRuntimeServices.map((row) => row.id)).toEqual([serviceId]);
  }, 30_000);

  it("returns no workspaces and unchanged base operations when no explicit executionWorkspaceId seed exists", async () => {
    const { graph, selectedStepRowIds } = await seedSelectedGraph(fixture.sql, db);
    const heartbeat = await seedReadModelHeartbeat(db, {
      companyId: graph.companyId, agentId: graph.agentId, workflowStepRunId: selectedStepRowIds[0]!,
    });
    const legacyOp = await seedWorkspaceScopedOperation(db, {
      companyId: graph.companyId, executionWorkspaceId: null, heartbeatRunId: heartbeat, phase: "exec",
    });
    // 관련 없는 DB workspace(+그 위의 연산)는 seed 가 아니다 — seed 는 명시적 참조 필드뿐이다.
    const unrelatedId = await seedExecutionWorkspace(db, { companyId: graph.companyId, name: "unreferenced" });
    const unrelatedOp = await seedWorkspaceScopedOperation(db, {
      companyId: graph.companyId, executionWorkspaceId: unrelatedId, phase: "cleanup",
    });
    const scope = readModelScope(graph);
    const before = await canonicalWorkspaceDomain(db);

    const base = await expectDomainUnchanged(db, before, () =>
      db.transaction((tx) => readResumeMissionLinkedHistory(tx, scope),
        { isolationLevel: "repeatable read", accessMode: "read only" }));
    const result = await expectDomainUnchanged(db, before, () => readMissionWorkspacesReadonly(db, scope));

    expect(result.executionWorkspaces).toEqual([]);
    expect(result.resources.workspaceOperations.map((row) => row.id)).toEqual([legacyOp]);
    expect(result.resources.workspaceOperations).toEqual(base.resources.workspaceOperations); // base 연산 무변화
    expect(result.resources.workspaceOperations.map((row) => row.id)).not.toContain(unrelatedOp);
    expect(result.selected).toEqual(base.selected);
    expect(result.history.heartbeats.map((row) => row.id)).toEqual([heartbeat]);
  }, 30_000);

  it("does not seed workspaces from runtime.workspaceId, sourceIssueId, or derivedFromExecutionWorkspaceId (documented limitation)", async () => {
    const { graph } = await seedSelectedGraph(fixture.sql, db);
    const issueId = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    const runtimeId = await seedResourceMissionRuntime(db, {
      companyId: graph.companyId, missionId: graph.missionId, agentId: graph.agentId,
    });
    // 세 workspace 모두 실재한다 — 잘못 seed 하면 아래 단언이 실패한다.
    const sourceIssueWorkspace = await seedExecutionWorkspace(db, {
      companyId: graph.companyId, sourceIssueId: issueId, name: "source-issue-only",
    });
    const derivedWorkspace = await seedExecutionWorkspace(db, {
      companyId: graph.companyId, derivedFromExecutionWorkspaceId: sourceIssueWorkspace, name: "derived-only",
    });
    const runtimePointerWorkspace = await seedExecutionWorkspace(db, {
      companyId: graph.companyId, name: "runtime-pointer-only",
    });
    // missionAgentRuntimes.workspaceId 는 FK 가 아닌 plain uuid 컬럼이다.
    await db.update(missionAgentRuntimes).set({ workspaceId: runtimePointerWorkspace })
      .where(eq(missionAgentRuntimes.id, runtimeId));

    const before = await canonicalWorkspaceDomain(db);
    const result = await expectDomainUnchanged(db, before, () => readMissionWorkspacesReadonly(db, readModelScope(graph)));

    expect(result.executionWorkspaces).toEqual([]); // 비-FK 포인터/자기참조 열은 seed 가 아니다
    expect(result.resources.missionAgentRuntimes.map((row) => row.id)).toEqual([runtimeId]);
    expect(before.executionWorkspaces.map((row) => row.id).sort())
      .toEqual([sourceIssueWorkspace, derivedWorkspace, runtimePointerWorkspace].sort());
  }, 30_000);
});

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, executionWorkspaces, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { startExecutionDefinitionFixture } from "./helpers/workflow-execution-definition-fixture.js";
import { readResumeMissionLinkedHistory } from "../services/workflow/resume/read-model-links.js";
import { readResumeMissionWorkspaceHistory } from "../services/workflow/resume/read-model-workspaces.js";
import {
  canonicalWorkspaceDomain,
  cleanupWorkspaceTables,
  expectDomainUnchanged,
  linkIssueExecutionWorkspace,
  readMissionWorkspacesReadonly,
  readModelScope,
  seedExecutionWorkspace,
  seedReadModelIssue,
  seedSelectedGraph,
  seedWorkspaceScopedOperation,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-resume-workspaces-fixture.js";

/**
 * [purpose] Task5c3e whole-domain DB proof via public readResumeMissionWorkspaceHistory: 공개
 *   reader 호출과 같은 트랜잭션 안에서 SHOW transaction_isolation/transaction_read_only 로
 *   repeatable read + read only 를 증명하고, 공개 호출마다 expectDomainUnchanged 헬퍼가 fresh
 *   immediate baseline 을 재캡처해 finally 비교를 보장하며, base 는 accepted linked reader 로 두
 *   번의 호출이 exact deep equality 임을 확인한다. 또한 실제 readonly 트랜잭션 안의 workspace
 *   INSERT/UPDATE 가 SQLSTATE 25006 으로 거부되고 성공한 쓰기가 없음, 실재하는 seed 들에 대해
 *   lexical 다중 workspace 정확 행/연산과 derivedFrom 조상/자손 미순회를 증명한다.
 *   Real embedded Postgres, no mocks.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
if (!embeddedPostgresSupport.supported) throw new Error(embeddedPostgresSupport.reason);

describe("readResumeMissionWorkspaceHistory — transaction boundary and write protection", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("resume-workspaces-db-");
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

  it("proves repeatable-read read-only session settings, per-call canonical invariance, and exact field equality with the linked base reader", async () => {
    const { graph } = await seedSelectedGraph(fixture.sql, db);
    const workspaceId = await seedExecutionWorkspace(db, { companyId: graph.companyId });
    const issueId = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    await linkIssueExecutionWorkspace(db, issueId, workspaceId);
    const cleanupOp = await seedWorkspaceScopedOperation(db, {
      companyId: graph.companyId, executionWorkspaceId: workspaceId,
      phase: "cleanup", command: "rm -rf .paperclip/worktree", status: "succeeded", exitCode: 0,
    });
    const scope = readModelScope(graph);
    const before = await canonicalWorkspaceDomain(db);

    // 트랜잭션 전체를 헬퍼로 감싼다 — 도중 실패해도 finally canonical 비교가 보장된다.
    await expectDomainUnchanged(db, before, () => db.transaction(async (tx) => {
      // 공개 reader 와 같은 트랜잭션 안의 실제 세션 설정 — 다른 연결/사전 확인이 아니다.
      const isolation = await tx.execute<{ transaction_isolation: string }>(sql`SHOW transaction_isolation`);
      const readOnly = await tx.execute<{ transaction_read_only: string }>(sql`SHOW transaction_read_only`);
      expect(isolation[0]?.transaction_isolation).toBe("repeatable read");
      expect(readOnly[0]?.transaction_read_only).toBe("on");

      // 세 공개 호출을 각각 헬퍼로 감싼다 — 호출마다 fresh baseline 캡처 + finally 비교.
      const base = await expectDomainUnchanged(db, before, () => readResumeMissionLinkedHistory(tx, scope));
      const first = await expectDomainUnchanged(db, before, () => readResumeMissionWorkspaceHistory(tx, scope));
      const second = await expectDomainUnchanged(db, before, () => readResumeMissionWorkspaceHistory(tx, scope));
      expect(second).toEqual(first); // 두 호출 exact deep equality

      // [불변 필드 정확 동일] workspace 발견은 linked base 필드를 하나도 바꾸지 않는다.
      expect(second.selected).toEqual(base.selected);
      expect(second.missionRuns).toEqual(base.missionRuns);
      expect(second.missionSteps).toEqual(base.missionSteps);
      expect(second.history).toEqual(base.history);
      expect(second.resources.finalizations).toEqual(base.resources.finalizations);
      expect(second.resources.finalizationSteps).toEqual(base.resources.finalizationSteps);
      expect(second.resources.workspaceRuntimeServices).toEqual(base.resources.workspaceRuntimeServices);
      expect(second.resources.missionAgentRuntimes).toEqual(base.resources.missionAgentRuntimes);
      expect(second.executionWorkspaces).toEqual(before.executionWorkspaces.filter((row) => row.id === workspaceId));
      expect(second.resources.workspaceOperations.map((row) => row.id)).toEqual([cleanupOp]);
    }, { isolationLevel: "repeatable read", accessMode: "read only" }));
  }, 30_000);

  it("proves actual write protection: workspace INSERT and UPDATE in the readonly transaction fail with 25006 without any write", async () => {
    const { graph } = await seedSelectedGraph(fixture.sql, db);
    const workspaceId = await seedExecutionWorkspace(db, { companyId: graph.companyId });
    const before = await canonicalWorkspaceDomain(db);
    expect(before.executionWorkspaces.map((row) => row.id)).toEqual([workspaceId]);

    // 각 거부 probe 마다 헬퍼가 fresh baseline 을 캡처하고 finally 에서 canonical 무변화를 비교한다.
    let insertCode: unknown;
    await expectDomainUnchanged(db, before, async () => {
      try {
        await db.transaction(async (tx) => {
          await tx.insert(executionWorkspaces).values({
            companyId: graph.companyId,
            projectId: before.executionWorkspaces[0]!.projectId,
            mode: "worktree",
            strategyType: "local_path",
            name: "must-not-be-inserted",
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
          await tx.update(executionWorkspaces).set({ status: "mutated-by-fixture-probe" })
            .where(eq(executionWorkspaces.id, workspaceId));
        }, { isolationLevel: "repeatable read", accessMode: "read only" });
      } catch (error) {
        updateCode = (error as { code?: unknown }).code;
      }
    });
    expect(updateCode).toBe("25006"); // 실제 UPDATE 거부 — 성공한 쓰기 없음(헬퍼 finally 비교)
  }, 30_000);

  it("returns exact lexical multi-workspace rows and operations without ancestry traversal when real seeds exist", async () => {
    const { graph } = await seedSelectedGraph(fixture.sql, db);
    // A 는 issue-linked seed(derivedFrom=P), B 는 독립 issue seed, C 는 derivedFrom=A 인 자손.
    // P 와 C 는 이 reader 가 순회하지 않는 derivedFromExecutionWorkspaceId 로만 도달한다.
    const parentId = await seedExecutionWorkspace(db, { companyId: graph.companyId, name: "ancestor-p" });
    const aId = await seedExecutionWorkspace(db, {
      companyId: graph.companyId, derivedFromExecutionWorkspaceId: parentId, name: "linked-a",
    });
    const bId = await seedExecutionWorkspace(db, { companyId: graph.companyId, name: "independent-b" });
    const cId = await seedExecutionWorkspace(db, {
      companyId: graph.companyId, derivedFromExecutionWorkspaceId: aId, name: "descendant-c",
    });
    const issueA = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    await linkIssueExecutionWorkspace(db, issueA, aId);
    const issueB = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    await linkIssueExecutionWorkspace(db, issueB, bId);
    const opA = await seedWorkspaceScopedOperation(db, {
      companyId: graph.companyId, executionWorkspaceId: aId, phase: "cleanup", status: "succeeded",
    });
    const opB = await seedWorkspaceScopedOperation(db, {
      companyId: graph.companyId, executionWorkspaceId: bId, phase: "cleanup", status: "succeeded",
    });
    const opP = await seedWorkspaceScopedOperation(db, {
      companyId: graph.companyId, executionWorkspaceId: parentId, phase: "cleanup", status: "succeeded",
    });
    const opC = await seedWorkspaceScopedOperation(db, {
      companyId: graph.companyId, executionWorkspaceId: cId, phase: "cleanup", status: "succeeded",
    });

    const scope = readModelScope(graph);
    const before = await canonicalWorkspaceDomain(db);
    const result = await expectDomainUnchanged(db, before, () => readMissionWorkspacesReadonly(db, scope));

    // 실재하는 두 seed workspace 만 — id lexical 정렬의 정확한 full 행/full 연산. P/C 미순회.
    expect(result.executionWorkspaces.map((row) => row.id)).toEqual([aId, bId].sort());
    expect(result.executionWorkspaces)
      .toEqual(before.executionWorkspaces.filter((row) => [aId, bId].includes(row.id)));
    expect(result.resources.workspaceOperations.map((row) => row.id)).toEqual([opA, opB].sort());
    expect(result.resources.workspaceOperations)
      .toEqual(before.workspaceOperations.filter((row) => [opA, opB].includes(row.id)));
    for (const excluded of [parentId, cId]) {
      expect(result.executionWorkspaces.map((row) => row.id)).not.toContain(excluded);
    }
    for (const excludedOp of [opP, opC]) {
      expect(result.resources.workspaceOperations.map((row) => row.id)).not.toContain(excludedOp);
    }
  }, 30_000);
});

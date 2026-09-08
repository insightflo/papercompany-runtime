import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { readResumeExecutionHistory } from "../services/workflow/resume/read-model.js";
import { checkObservedResourceConflicts } from "../services/workflow/resume/observed-resource-conflicts.js";
import {
  canonicalHistoryRows,
  canonicalResourceRows,
  cleanupResourceTables,
  readModelScope,
  seedReadModelGraph,
  seedReadModelHeartbeat,
  seedReadModelIssue,
  seedReadModelStepRun,
  seedResourceMissionRuntime,
  seedResourceRuntimeService,
  seedResourceWorkspaceOperation,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
  type ReadModelGraph,
} from "./helpers/workflow-resume-resource-fixture.js";

/**
 * [purpose] Task5c3b observed resource conflict filter — REAL embedded PostgreSQL integration.
 *   The accepted SELECT-only readResumeExecutionHistory runs inside a repeatable-read READ-ONLY
 *   transaction (session settings asserted) and the pure filter consumes its result; repeated
 *   calls in the same tx are equal, and old history PLUS the five resource tables are canonically
 *   unchanged before/after. All mutations happen OUTSIDE the readonly tx between calls. No
 *   finalization/engine/adapter process is started; mock DB/loader is never used.
 *   Empty blockers here still prove ONLY "no conflict in collected rows" — never quiescence or
 *   resume eligibility (unmapped/shared-workspace rows are not collected at all).
 */

const T0 = new Date("2024-06-01T00:00:00.000Z");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEP("checkObservedResourceConflicts — embedded PG reader integration", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("resume-observed-resource-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = createDb(fixture.connectionString);
  }, 60_000);

  afterEach(async () => {
    await cleanupResourceTables(db);
  });

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  /** frozen 그래프 + scoped 이력(issue/step/heartbeat)을 실제 DB 에 시딩하고 id 를 돌려준다. */
  async function seedScopedHistory(): Promise<{ graph: ReadModelGraph; scope: ReturnType<typeof readModelScope>; heartbeatId: string; issueId: string }> {
    const graph = await seedReadModelGraph(fixture.sql, db);
    const [stepA, stepB] = graph.definitionStepIds;
    const issueId = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    const stepARunId = await seedReadModelStepRun(db, { runId: graph.runId, stepId: stepA!, issueId });
    await seedReadModelStepRun(db, { runId: graph.runId, stepId: stepB! });
    const heartbeatId = await seedReadModelHeartbeat(db, {
      companyId: graph.companyId,
      agentId: graph.agentId,
      issueId,
      workflowStepRunId: stepARunId,
    });
    return { graph, scope: readModelScope(graph, stepA!), heartbeatId, issueId };
  }

  /** repeatable-read + read-only TX 안에서 reader+filter 를 호출하고 세션 설정까지 단언한다. */
  async function filterHistoryReadonly(scope: ReturnType<typeof readModelScope>) {
    return db.transaction(async (tx) => {
      const settings = await tx.execute<{ read_only: string; isolation: string }>(
        sql`SELECT current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation`,
      );
      expect(settings[0]?.read_only).toBe("on");
      expect(settings[0]?.isolation).toBe("repeatable read");
      const history = await readResumeExecutionHistory(tx, scope);
      const first = checkObservedResourceConflicts(history);
      const second = checkObservedResourceConflicts(history);
      expect(second).toEqual(first); // 같은 TX 안 반복 판정 — 완전 동일
      return { history, blockers: first };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  async function expectCanonicalUnchanged(scope: ReturnType<typeof readModelScope>, run: () => Promise<unknown>) {
    const before = { ...await canonicalHistoryRows(db, scope.workflowRunId), ...await canonicalResourceRows(db) };
    await run();
    const after = { ...await canonicalHistoryRows(db, scope.workflowRunId), ...await canonicalResourceRows(db) };
    expect(after).toEqual(before);
  }

  it("returns [] for a coherent terminal operation over real DB rows; canonical rows unchanged", async () => {
    const { graph, scope, heartbeatId } = await seedScopedHistory();
    const operationId = await seedResourceWorkspaceOperation(db, {
      companyId: graph.companyId,
      heartbeatRunId: heartbeatId,
      phase: "test",
      status: "succeeded",
      startedAt: T0,
      finishedAt: T0, // 동일 시각도 유효
    });
    await expectCanonicalUnchanged(scope, async () => {
      const { history, blockers } = await filterHistoryReadonly(scope);
      // [] 가 빈 수집 오독으로 pass 되지 않게 — reader 가 수용 operation 을 실제 담았음을 먼저 단언.
      expect(history.workspaceOperations.map((row) => row.id)).toContain(operationId);
      expect(blockers).toEqual([]);
    });
  }, 30_000);

  it("active service with stoppedAt and runtime queue/current-issue conflicts survive real DB rows", async () => {
    const { graph, scope, heartbeatId, issueId } = await seedScopedHistory();
    const operationId = await seedResourceWorkspaceOperation(db, {
      companyId: graph.companyId,
      heartbeatRunId: heartbeatId,
      phase: "test",
      status: "skipped",
      startedAt: T0,
      finishedAt: T0,
    });
    // The stop writer records stopped before termination; a running/starting row remains nonterminal even with stoppedAt. Timestamps never override the state rule.
    const serviceId = await seedResourceRuntimeService(db, {
      companyId: graph.companyId,
      startedByRunId: heartbeatId,
      scopeType: "run",
      scopeId: heartbeatId,
      status: "running",
      stoppedAt: new Date("2024-06-01T02:00:00.000Z"),
    });
    // idle 이지만 queue/현재 issue 소유가 남은 runtime — owner_present 로 차단.
    const runtimeId = await seedResourceMissionRuntime(db, {
      companyId: graph.companyId,
      missionId: graph.missionId,
      agentId: graph.agentId,
      status: "idle",
      lastRunId: heartbeatId,
      currentIssueId: issueId,
      queueDepth: 2,
      processPid: null,
    });
    await expectCanonicalUnchanged(scope, async () => {
      const { history, blockers } = await filterHistoryReadonly(scope);
      expect(history.workspaceOperations.map((row) => row.id)).toContain(operationId);
      // codepoint 정렬: mission_runtime < workspace_service. 유효 operation 은 blocker 없음.
      expect(blockers).toEqual([
        { code: "active_work", resourceKind: "mission_runtime", resourceId: runtimeId, reason: "resource_owner_present" },
        { code: "active_work", resourceKind: "workspace_service", resourceId: serviceId, reason: "resource_not_terminal" },
      ]);
      expect(blockers.some((blocker) => blocker.resourceId === operationId)).toBe(false);
    });
  }, 30_000);

  it("survives a scope with zero collected resource rows — [] stays a non-eligible negative result", async () => {
    const { scope } = await seedScopedHistory();
    await expectCanonicalUnchanged(scope, async () => {
      expect((await filterHistoryReadonly(scope)).blockers).toEqual([]);
    });
  }, 30_000);
});

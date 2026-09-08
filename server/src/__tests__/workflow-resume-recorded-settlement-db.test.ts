import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, heartbeatRunFinalizationSteps, heartbeatRuns, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { readResumeExecutionHistory } from "../services/workflow/resume/read-model.js";
import { checkRecordedHeartbeatSettlements } from "../services/workflow/resume/recorded-settlement.js";
import { Q_STAGE } from "../services/heartbeat-finalization/stage-classifier.js";
import {
  acceptedSettlementRecords,
  canonicalHistoryRows,
  canonicalResourceRows,
  cleanupResourceTables,
  readModelScope,
  seedCompleteStepRuns,
  seedReadModelGraph,
  seedReadModelIssue,
  seedReadModelStepRun,
  seedSettlementRecords,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
  type ReadModelGraph,
  type SettlementRecords,
} from "./helpers/workflow-resume-settlement-fixture.js";

/**
 * [purpose] Task5c3a recorded settlement — REAL embedded PostgreSQL integration. The public
 *   readResumeExecutionHistory runs inside a repeatable-read READ-ONLY transaction (session
 *   settings asserted via current_setting) and the pure checker consumes its result; repeated
 *   calls in the same tx are equal, and the whole old history PLUS the five resource tables are
 *   canonically unchanged before/after. All mutations happen OUTSIDE the readonly tx between
 *   calls. No finalization engine is started (no writes/probes); mock DB/loader is never used.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEP("checkRecordedHeartbeatSettlements — embedded PG reader integration", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("resume-recorded-settlement-");
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

  /** frozen 그래프 + 완결 producer heartbeat/parent/Q+C stage 를 실제 DB에 시딩한다. */
  async function seedProducerGraph(): Promise<{
    graph: ReadModelGraph;
    scope: ReturnType<typeof readModelScope>;
    producer: SettlementRecords;
  }> {
    const graph = await seedReadModelGraph(fixture.sql, db);
    const [stepA, stepB] = graph.definitionStepIds;
    const issueId = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    const stepARunId = await seedReadModelStepRun(db, { runId: graph.runId, stepId: stepA!, issueId });
    await seedReadModelStepRun(db, { runId: graph.runId, stepId: stepB! });
    const producer = acceptedSettlementRecords({
      id: randomUUID(),
      companyId: graph.companyId,
      agentId: graph.agentId,
      issueId,
      executionScopeKind: "workflow_step",
      workflowStepRunId: stepARunId,
      workflowExecutionGeneration: 1,
    });
    await seedSettlementRecords(db, producer);
    return { graph, scope: readModelScope(graph, stepA!), producer };
  }

  /** repeatable-read + read-only TX 안에서 reader+checker 를 호출하고 세션 설정까지 단언한다. */
  async function checkHistoryReadonly(scope: ReturnType<typeof readModelScope>) {
    return db.transaction(async (tx) => {
      const settings = await tx.execute<{ read_only: string; isolation: string }>(
        sql`SELECT current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation`,
      );
      expect(settings[0]?.read_only).toBe("on");
      expect(settings[0]?.isolation).toBe("repeatable read");
      const history = await readResumeExecutionHistory(tx, scope);
      const first = checkRecordedHeartbeatSettlements(history);
      const second = checkRecordedHeartbeatSettlements(history);
      expect(second).toEqual(first); // 같은 TX 안 반복 판정 — 완전 동일
      return first;
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  async function expectCanonicalUnchanged(scope: ReturnType<typeof readModelScope>, run: () => Promise<unknown>) {
    const before = { ...await canonicalHistoryRows(db, scope.workflowRunId), ...await canonicalResourceRows(db) };
    await run();
    const after = { ...await canonicalHistoryRows(db, scope.workflowRunId), ...await canonicalResourceRows(db) };
    expect(after).toEqual(before);
  }

  it("returns [] for a coherent settled v1 producer graph; old history + five resource tables unchanged", async () => {
    const { scope } = await seedProducerGraph();
    await expectCanonicalUnchanged(scope, async () => {
      expect(await checkHistoryReadonly(scope)).toEqual([]);
    });
  }, 30_000);

  it("blocks legacy version0 and historical nonterminal heartbeats with id-sorted deterministic output; rows unchanged", async () => {
    const { graph, scope, producer } = await seedProducerGraph();
    const [stepA] = graph.definitionStepIds;
    const stepARunId = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, producer.heartbeat.id)))[0]!
      .workflowStepRunId!;

    // legacy v0 heartbeat — 인증된 내구 정산 증거가 없는 구세대(같은 step run 에 연결).
    const legacy = acceptedSettlementRecords({
      id: randomUUID(),
      companyId: graph.companyId,
      agentId: graph.agentId,
      executionScopeKind: "workflow_step",
      workflowStepRunId: stepARunId,
    });
    legacy.heartbeat.finalizationVersion = 0;
    legacy.heartbeat.settledAt = null;
    legacy.heartbeat.executorOwnerReleasedAt = null;
    legacy.heartbeat.terminalDecidedAt = null;
    legacy.heartbeat.executionEpoch = null;
    legacy.heartbeat.executionToken = null;
    legacy.finalization.finalizationVersion = 0;

    // 역사적 nonterminal heartbeat — 활성 작업으로 차단되어야 한다(구세대라도 검사 대상).
    const historical = acceptedSettlementRecords({
      id: randomUUID(),
      companyId: graph.companyId,
      agentId: graph.agentId,
      executionScopeKind: "workflow_step",
      workflowStepRunId: stepARunId,
    });
    historical.heartbeat.status = "running";

    await seedSettlementRecords(db, legacy);
    await seedSettlementRecords(db, historical);

    // producer 는 blocker 가 없어야 하므로 기대 id 목록은 legacy+historical 두 개(정렬)뿐이다.
    const expectedIds = [legacy.heartbeat.id, historical.heartbeat.id]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    await expectCanonicalUnchanged(scope, async () => {
      const blockers = await checkHistoryReadonly(scope);
      expect(blockers.map((blocker) => blocker.heartbeatRunId)).toEqual(expectedIds);
      // producer 는 blocker 없음 — legacy/historical 만 정렬 순서로 나온다.
      expect(blockers.filter((blocker) => blocker.heartbeatRunId === producer.heartbeat.id)).toEqual([]);
      expect(blockers.filter((blocker) => blocker.heartbeatRunId === legacy.heartbeat.id)).toEqual([
        { code: "active_work", heartbeatRunId: legacy.heartbeat.id, reason: "settlement_unproven" },
      ]);
      expect(blockers.filter((blocker) => blocker.heartbeatRunId === historical.heartbeat.id)).toEqual([
        { code: "active_work", heartbeatRunId: historical.heartbeat.id, reason: "heartbeat_not_terminal" },
      ]);
    });
  }, 30_000);

  it("blocks malformed/missing proof (settledAt nulled, required Q stage deleted); restoring re-validates to []", async () => {
    const { scope, producer } = await seedProducerGraph();
    const producerId = producer.heartbeat.id;

    // [변이는 readonly TX 밖에서만] settledAt 제거 → settlement_unproven.
    await db.update(heartbeatRuns).set({ settledAt: null }).where(eq(heartbeatRuns.id, producerId));
    expect(await checkHistoryReadonly(scope)).toEqual([
      { code: "active_work", heartbeatRunId: producerId, reason: "settlement_unproven" },
    ]);

    // 복구 → 다시 [].
    await db.update(heartbeatRuns).set({ settledAt: new Date("2024-06-01T00:00:00.000Z") })
      .where(eq(heartbeatRuns.id, producerId));
    expect(await checkHistoryReadonly(scope)).toEqual([]);

    // required Q stage 행 삭제 → finalization_stages_unproven.
    const missionIdle = (await db.select().from(heartbeatRunFinalizationSteps)
      .where(eq(heartbeatRunFinalizationSteps.stageKind, Q_STAGE.missionRuntimeIdle))).at(0)!;
    await db.delete(heartbeatRunFinalizationSteps).where(eq(heartbeatRunFinalizationSteps.id, missionIdle.id));
    expect(await checkHistoryReadonly(scope)).toEqual([
      { code: "active_work", heartbeatRunId: producerId, reason: "finalization_stages_unproven" },
    ]);

    // 재삽입 복구 → [].
    await db.insert(heartbeatRunFinalizationSteps).values(missionIdle);
    expect(await checkHistoryReadonly(scope)).toEqual([]);
  }, 30_000);
});

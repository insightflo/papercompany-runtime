import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agentWakeupRequests, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { readResumeExecutionHistory } from "../services/workflow/resume/read-model.js";
import {
  canonicalHistoryRows,
  captureHttpError,
  cleanupReadModelTables,
  readModelScope,
  seedAdditionalMission,
  seedForeignReadModelGraph,
  seedReadModelGraph,
  seedReadModelIssue,
  seedReadModelStepRun,
  seedWorkflowRun,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-resume-read-model-fixture.js";

/**
 * [purpose] Task5c2b — legacy JSON-only discovery safety surface. Non-string values, malformed
 *   UUID text, nested lookalikes, prose and whitespace-padded ids must never match and never
 *   throw; a matching JSON reference must win even when the typed column points to an unrelated
 *   same-company mission/run/step; typed+JSON double matches return exactly once; foreign-company
 *   JSON matches are rejected as scope_mismatch (no company prefilter); repeats are stable inside
 *   a real REPEATABLE READ READ ONLY transaction with zero state mutation.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEP("readResumeExecutionHistory — legacy JSON discovery safety", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("resume-read-model-legacy-scope-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = createDb(fixture.connectionString);
  }, 60_000);

  afterEach(async () => {
    await cleanupReadModelTables(db);
  });

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  async function insertLegacyWakeup(input: {
    companyId: string; agentId: string; payload: unknown;
    typedMissionId?: string; typedWorkflowRunId?: string; typedStepRunId?: string; typedIssueId?: string;
  }): Promise<string> {
    const [row] = await db.insert(agentWakeupRequests).values({
      companyId: input.companyId,
      agentId: input.agentId,
      source: "legacy-json-test",
      reason: "legacy-json-test",
      status: "queued",
      payload: input.payload as Record<string, unknown> | null,
      ...(input.typedMissionId !== undefined ? { missionId: input.typedMissionId } : {}),
      ...(input.typedWorkflowRunId !== undefined ? { workflowRunId: input.typedWorkflowRunId } : {}),
      ...(input.typedStepRunId !== undefined ? { workflowStepRunId: input.typedStepRunId } : {}),
      ...(input.typedIssueId !== undefined ? { issueId: input.typedIssueId } : {}),
    }).returning();
    return row!.id;
  }

  async function insertLegacyHeartbeat(input: {
    companyId: string; agentId: string; contextSnapshot: unknown;
    typedStepRunId?: string; typedIssueId?: string;
  }): Promise<string> {
    const [row] = await db.insert(heartbeatRuns).values({
      companyId: input.companyId,
      agentId: input.agentId,
      status: "succeeded",
      contextSnapshot: input.contextSnapshot as Record<string, unknown> | null,
      ...(input.typedStepRunId !== undefined ? { workflowStepRunId: input.typedStepRunId } : {}),
      ...(input.typedIssueId !== undefined ? { issueId: input.typedIssueId } : {}),
    }).returning();
    return row!.id;
  }

  async function seedGraphWithIssueAndSteps() {
    const graph = await seedReadModelGraph(fixture.sql, db);
    const knownIssueId = await seedReadModelIssue(db, {
      companyId: graph.companyId, missionId: graph.missionId,
    });
    const stepRunIds: string[] = [];
    for (const stepId of graph.definitionStepIds) {
      stepRunIds.push(await seedReadModelStepRun(db, { runId: graph.runId, stepId }));
    }
    return { graph, knownIssueId, stepRunIds };
  }

  /** [Task5c2b-fix1] 공개 reader 호출은 전부 실제 REPEATABLE READ READ ONLY 트랜잭션 안에서 실행한다. */
  function readHistory(scope: Parameters<typeof readResumeExecutionHistory>[1]) {
    return db.transaction((tx) => readResumeExecutionHistory(tx, scope), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
  }

  it("ignores null/scalar/array column JSON and number/bool/null/array key values, top-level false/empty object, malformed UUID text, nested lookalikes, prose and whitespace-padded ids without throwing", async () => {
    const { graph, knownIssueId } = await seedGraphWithIssueAndSteps();
    const controls: unknown[] = [
      null, // 전체 컬럼 null
      "legacy-scalar-string", // 전체 컬럼 scalar
      7, // 전체 컬럼 number
      false, // 전체 컬럼 boolean false
      [{ missionId: graph.missionId }], // 전체 컬럼 array
      {}, // 빈 객체 — 일치 키 없음
      { missionId: null }, // null 값 — 문자열 참조가 아니다
      { missionId: 42 }, // number 값
      { missionId: true }, // boolean 값
      { missionId: [graph.missionId] }, // array 값
      { missionId: { value: graph.missionId } }, // object 값
      { missionId: "not-a-uuid" }, // malformed 텍스트 — UUID 캐스팅 없어 예외 없음
      { nested: { missionId: graph.missionId } }, // nested lookalike
      { taskKey: `memo ${knownIssueId} prose` }, // ID 를 포함하는 산문 — substring 매칭 금지
      { taskId: ` ${knownIssueId} ` }, // whitespace-padded — trim heuristics 금지
      { someOtherId: graph.missionId }, // 미지 키
    ];
    for (const payload of controls) {
      await insertLegacyWakeup({ companyId: graph.companyId, agentId: graph.agentId, payload });
    }
    for (const contextSnapshot of controls) {
      await insertLegacyHeartbeat({ companyId: graph.companyId, agentId: graph.agentId, contextSnapshot });
    }

    const result = await readHistory(readModelScope(graph, graph.definitionStepIds[0]!));

    expect(result.wakeups).toEqual([]);
    expect(result.heartbeats).toEqual([]);
  }, 30_000);

  it("includes JSON-matching rows even when the typed association points to an unrelated same-company mission/run/step/issue", async () => {
    const { graph } = await seedGraphWithIssueAndSteps();
    const otherMissionId = await seedAdditionalMission(fixture.sql, graph.companyId, graph.agentId);
    const unrelatedRunId = await seedWorkflowRun(fixture.sql, {
      workflowId: graph.workflowId, companyId: graph.companyId, missionId: otherMissionId,
    });
    const unrelatedStepRunId = await seedReadModelStepRun(db, { runId: unrelatedRunId, stepId: "resume-step-a" });
    // 같은 회사 다른 mission 소유의 무관 issue — reader 는 raw 이력 수집일 뿐, 이슈 소유나 실행 권한을 검증/주장하지 않는다.
    const unrelatedIssueId = await seedReadModelIssue(db, {
      companyId: graph.companyId, missionId: otherMissionId,
    });
    const wakeupId = await insertLegacyWakeup({
      companyId: graph.companyId, agentId: graph.agentId,
      payload: { workflowRunId: graph.runId }, // JSON 은 scope 와 일치
      typedMissionId: otherMissionId,
      typedWorkflowRunId: unrelatedRunId,
      typedStepRunId: unrelatedStepRunId,
      typedIssueId: unrelatedIssueId,
    });
    const heartbeatId = await insertLegacyHeartbeat({
      companyId: graph.companyId, agentId: graph.agentId,
      contextSnapshot: { missionId: graph.missionId }, // JSON 은 scope 와 일치
      typedStepRunId: unrelatedStepRunId,
      typedIssueId: unrelatedIssueId,
    });

    const result = await readHistory(readModelScope(graph, graph.definitionStepIds[0]!));

    // typed ID nonnull 이 JSON 연관을 숨기지 않는다 — 두 행 모두 정확히 1회 반환(actual 순서 그대로).
    expect(result.wakeups.map((row) => row.id)).toEqual([wakeupId]);
    expect(result.heartbeats.map((row) => row.id)).toEqual([heartbeatId]);
    // 충돌하는 typed 필드는 원본 그대로 보존 — reader 는 raw 행을 수집할 뿐 재기록하지 않는다.
    const wakeRow = result.wakeups.find((row) => row.id === wakeupId)!;
    expect(wakeRow.missionId).toBe(otherMissionId);
    expect(wakeRow.workflowRunId).toBe(unrelatedRunId);
    expect(wakeRow.workflowStepRunId).toBe(unrelatedStepRunId);
    expect(wakeRow.issueId).toBe(unrelatedIssueId);
    const heartbeatRow = result.heartbeats.find((row) => row.id === heartbeatId)!;
    expect(heartbeatRow.workflowStepRunId).toBe(unrelatedStepRunId);
    expect(heartbeatRow.issueId).toBe(unrelatedIssueId);
  }, 30_000);

  it("returns a row matching BOTH typed and legacy JSON associations exactly once", async () => {
    const { graph, stepRunIds } = await seedGraphWithIssueAndSteps();
    await insertLegacyWakeup({
      companyId: graph.companyId, agentId: graph.agentId,
      payload: { missionId: graph.missionId, workflowRunId: graph.runId },
      typedMissionId: graph.missionId,
    });
    await insertLegacyHeartbeat({
      companyId: graph.companyId, agentId: graph.agentId,
      contextSnapshot: { workflowStepRunId: stepRunIds[0], missionId: graph.missionId },
      typedStepRunId: stepRunIds[0],
    });

    const result = await readHistory(readModelScope(graph, graph.definitionStepIds[0]!));

    expect(result.wakeups).toHaveLength(1);
    expect(result.wakeups[0]!.payload).toEqual({ missionId: graph.missionId, workflowRunId: graph.runId });
    expect(result.heartbeats).toHaveLength(1);
    expect(result.heartbeats[0]!.contextSnapshot).toEqual({
      workflowStepRunId: stepRunIds[0], missionId: graph.missionId,
    });
  }, 30_000);

  it("rejects foreign-company wake and heartbeat whose legacy JSON matches the scope with scope_mismatch (no company prefilter)", async () => {
    const { graph, knownIssueId } = await seedGraphWithIssueAndSteps();
    const foreign = await seedForeignReadModelGraph(fixture.sql, db);
    const scope = readModelScope(graph, graph.definitionStepIds[0]!);

    await insertLegacyWakeup({
      companyId: foreign.companyId, agentId: foreign.agentId, payload: { missionId: graph.missionId },
    });
    const wakeError = await captureHttpError(readHistory(scope));
    expect(wakeError.message).toBe("scope_mismatch");
    expect((wakeError.details as { reason: string }).reason).toBe("wakeup_company_mismatch");

    // heartbeat 단계 검증을 위해 첫 단계의 foreign wakeup 을 테스트가 직접 제거한 뒤 재시도한다.
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, foreign.companyId));

    await insertLegacyHeartbeat({
      companyId: foreign.companyId, agentId: foreign.agentId, contextSnapshot: { taskKey: knownIssueId },
    });
    const heartbeatError = await captureHttpError(readHistory(scope));
    expect(heartbeatError.message).toBe("scope_mismatch");
    expect((heartbeatError.details as { reason: string }).reason).toBe("heartbeat_company_mismatch");
  }, 30_000);

  it("repeat SELECT in a real repeatable-read read-only transaction returns identical results with zero state mutation", async () => {
    const { graph, knownIssueId } = await seedGraphWithIssueAndSteps();
    const legacyWakeup = await insertLegacyWakeup({
      companyId: graph.companyId, agentId: graph.agentId,
      payload: { missionId: graph.missionId, taskId: knownIssueId },
    });
    const legacyHeartbeat = await insertLegacyHeartbeat({
      companyId: graph.companyId, agentId: graph.agentId, contextSnapshot: { taskKey: knownIssueId },
    });
    await insertLegacyWakeup({ companyId: graph.companyId, agentId: graph.agentId, payload: null });
    const before = await canonicalHistoryRows(db, graph.runId);

    // 두 공개 reader 호출 모두 같은 REPEATABLE READ READ ONLY 트랜잭션 안에서 실행한다.
    const scope = readModelScope(graph, graph.definitionStepIds[0]!);
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      const first = await readResumeExecutionHistory(tx, scope);
      const second = await readResumeExecutionHistory(tx, scope);
      expect(second).toEqual(first);
      expect(first.wakeups.map((row) => row.id)).toEqual([legacyWakeup]);
      expect(first.heartbeats.map((row) => row.id)).toEqual([legacyHeartbeat]);
    });
    // 트랜잭션 밖 before/after 비교로 상태 무변경을 증명한다.
    expect(await canonicalHistoryRows(db, graph.runId)).toEqual(before);
  }, 30_000);
});

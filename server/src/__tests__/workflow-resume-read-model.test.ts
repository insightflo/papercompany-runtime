import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { readResumeExecutionHistory } from "../services/workflow/resume/read-model.js";
import {
  canonicalHistoryRows,
  captureHttpError,
  cleanupReadModelTables,
  editLiveDefinition,
  readModelScope,
  seedForeignReadModelGraph,
  seedReadModelDelegation,
  seedReadModelGraph,
  seedReadModelHeartbeat,
  seedReadModelIssue,
  seedReadModelStepRun,
  seedReadModelWakeup,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-resume-read-model-fixture.js";

/**
 * [purpose] Task5c2a scoped SELECT-only execution-history reader — valid frozen history,
 *   raw row/metadata preservation, live-definition independence, and a REAL read-only
 *   repeatable-read caller transaction proof (actual observed DB rows before/after a
 *   valid and a blocked call; read-only mode proven by rejecting a real UPDATE in a
 *   separate rolled-back tx — mock recording is not claimed as DB proof).
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEP("readResumeExecutionHistory — frozen scoped history", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("resume-read-model-");
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

  /** [재사용] frozen 2-step graph + 대표 이력 1세트(전부 실제 insert, mock 없음). */
  async function seedValidHistory() {
    const graph = await seedReadModelGraph(fixture.sql, db);
    const [stepA, stepB] = graph.definitionStepIds;
    const ownerWakeupId = await seedReadModelWakeup(db, {
      id: randomUUID(),
      companyId: graph.companyId,
      agentId: graph.agentId,
    });
    const ownerHeartbeatId = await seedReadModelHeartbeat(db, {
      id: randomUUID(),
      companyId: graph.companyId,
      agentId: graph.agentId,
      workflowExecutionGeneration: 0,
    });
    // [step-only 연관] issueA 는 missionId 없이 step 참조로만 연결된다.
    const issueA = await seedReadModelIssue(db, { companyId: graph.companyId });
    const stepARunId = await seedReadModelStepRun(db, {
      runId: graph.runId,
      stepId: stepA!,
      issueId: issueA,
      status: "running",
      startedAt: new Date("2024-05-01T10:00:00.000Z"),
      lastDispatchRequestId: "req-read-model-a",
      dispatchOwnerWakeupRequestId: ownerWakeupId,
      dispatchOwnerHeartbeatRunId: ownerHeartbeatId,
      metadata: {
        toolQueue: { status: "queued", queuedAt: "2024-05-01T09:59:00.000Z" },
        toolInvocation: { toolName: "resume-test-tool", args: { query: "ai-news", depth: 2 } },
        dispatch: { requestId: "req-read-model-a", accepted: true },
      },
    });
    // executionRunId 로만 연결되는 별도 heartbeat — issue/step/wakeup 참조 없이 issueB seed 전에 시딩.
    const executionRunHeartbeatId = await seedReadModelHeartbeat(db, {
      companyId: graph.companyId,
      agentId: graph.agentId,
    });
    const issueB = await seedReadModelIssue(db, {
      companyId: graph.companyId,
      missionId: graph.missionId,
      title: "Step B issue",
      checkoutRunId: ownerHeartbeatId,
      executionRunId: executionRunHeartbeatId,
    });
    const stepBRunId = await seedReadModelStepRun(db, {
      runId: graph.runId,
      stepId: stepB!,
      issueId: issueB,
      status: "completed",
      executionGeneration: 3,
      completedAt: new Date("2024-05-01T11:00:00.000Z"),
    });
    const missionWakeupId = await seedReadModelWakeup(db, {
      companyId: graph.companyId,
      agentId: graph.agentId,
      missionId: graph.missionId,
    });
    const issueHeartbeatId = await seedReadModelHeartbeat(db, {
      companyId: graph.companyId,
      agentId: graph.agentId,
      issueId: issueA,
      status: "running",
      workflowExecutionGeneration: 3,
    });
    const foreign = await seedForeignReadModelGraph(fixture.sql, db);
    const delegationId = await seedReadModelDelegation(db, {
      sourceCompanyId: graph.companyId,
      sourceWorkflowRunId: graph.runId,
      sourceWorkflowStepRunId: stepBRunId,
      sourceIssueId: issueB,
      targetCompanyId: foreign.companyId,
      targetIssueId: foreign.issueId,
    });
    // 무관(링크 없는) 외부 회사 행 — reader 가 절대 반환하면 안 된다.
    const foreignWakeupId = await seedReadModelWakeup(db, {
      companyId: foreign.companyId,
      agentId: foreign.agentId,
      missionId: foreign.missionId,
    });
    const foreignHeartbeatId = await seedReadModelHeartbeat(db, {
      companyId: foreign.companyId,
      agentId: foreign.agentId,
      workflowStepRunId: foreign.stepRunId,
    });
    return {
      graph,
      stepA: stepA!,
      issueA,
      issueB,
      stepARunId,
      stepBRunId,
      ownerWakeupId,
      missionWakeupId,
      ownerHeartbeatId,
      issueHeartbeatId,
      executionRunHeartbeatId,
      delegationId,
      foreignWakeupId,
      foreignHeartbeatId,
      foreignCompanyId: foreign.companyId,
    };
  }

  it("returns frozen two-step history: full raw rows, toolQueue/toolInvocation/dispatch metadata preserved, live definition edit ignored", async () => {
    const seeded = await seedValidHistory();
    await editLiveDefinition(db, seeded.graph.workflowId, {
      name: "live-renamed-after-capture",
      stepsJson: [{ id: "live-only-step", name: "Live only step", agentId: "", dependencies: [] }],
    });

    const result = await readResumeExecutionHistory(db, readModelScope(seeded.graph, seeded.stepA));

    expect(result.scope).toEqual(readModelScope(seeded.graph, seeded.stepA));
    expect(result.mission.id).toBe(seeded.graph.missionId);
    expect(result.mission.companyId).toBe(seeded.graph.companyId);
    expect(result.run.id).toBe(seeded.graph.runId);
    // frozen definition — live edit 가 반환 steps 를 바꾸지 않는다.
    expect(result.definition.source).toBe("snapshot");
    expect(result.definition.steps.map((step) => step.id)).toEqual(seeded.graph.definitionStepIds);
    expect(result.definition.steps.find((step) => step.id === seeded.stepA)?.name).toBe("Resume step A");

    // full rows, 결정적 id 정렬, Date 보존, raw metadata 보존.
    expect(result.steps.map((row) => row.id)).toEqual([...result.steps.map((row) => row.id)].sort());
    const stepARow = result.steps.find((row) => row.stepId === seeded.stepA)!;
    expect(stepARow.startedAt).toBeInstanceOf(Date);
    expect(stepARow.lastDispatchRequestId).toBe("req-read-model-a");
    expect(stepARow.metadata).toEqual({
      toolQueue: { status: "queued", queuedAt: "2024-05-01T09:59:00.000Z" },
      toolInvocation: { toolName: "resume-test-tool", args: { query: "ai-news", depth: 2 } },
      dispatch: { requestId: "req-read-model-a", accepted: true },
    });
    expect(result.steps).toEqual((await canonicalHistoryRows(db, seeded.graph.runId)).stepRuns);

    // [순서 증명] 반환 배열을 mutate 하지 않고 복사본과 비교해 각 목록의 id 오름차순을 단언.
    const historyLists: Array<Array<{ id: string }>> = [
      result.issues, result.wakeups, result.heartbeats, result.delegations,
    ];
    for (const rows of historyLists) {
      expect(rows.map((row) => row.id)).toEqual([...rows.map((row) => row.id)].sort());
    }
    // issueA(step-only, missionId null)와 issueB(mission-linked) 둘 다 반환된다.
    expect(result.issues.map((row) => row.id)).toEqual([seeded.issueA, seeded.issueB].sort());
    expect(result.issues.find((row) => row.id === seeded.issueB)?.checkoutRunId).toBe(seeded.ownerHeartbeatId);
    expect(result.issues.find((row) => row.id === seeded.issueB)?.executionRunId).toBe(seeded.executionRunHeartbeatId);

    expect(result.wakeups.map((row) => row.id)).toEqual([seeded.ownerWakeupId, seeded.missionWakeupId].sort());
    expect(result.wakeups.map((row) => row.id)).not.toContain(seeded.foreignWakeupId);
    expect(result.heartbeats.map((row) => row.id))
      .toEqual([seeded.ownerHeartbeatId, seeded.issueHeartbeatId, seeded.executionRunHeartbeatId].sort());
    // explicit 0 generation 이 falsy 취급되지 않고 raw 로 보존된다.
    expect(result.heartbeats.find((row) => row.id === seeded.ownerHeartbeatId)?.workflowExecutionGeneration).toBe(0);
    expect(result.heartbeats.find((row) => row.id === seeded.issueHeartbeatId)?.status).toBe("running");
    expect(result.heartbeats.map((row) => row.id)).not.toContain(seeded.foreignHeartbeatId);

    // 원격(counterpart) 행 보존 — 타회사 target 도 raw 그대로.
    expect(result.delegations.map((row) => row.id)).toEqual([seeded.delegationId]);
    expect(result.delegations[0]!.targetCompanyId).toBe(seeded.foreignCompanyId);
  }, 30_000);

  it("READ ONLY caller transaction: observed DB rows byte-stable before/after valid and blocked calls; UPDATE rejected in read-only tx", async () => {
    const graph = await seedReadModelGraph(fixture.sql, db);
    const [stepA, stepB] = graph.definitionStepIds;
    const issueA = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    const stepARunId = await seedReadModelStepRun(db, {
      runId: graph.runId,
      stepId: stepA!,
      issueId: issueA,
      status: "running",
      metadata: { toolQueue: { status: "queued" } },
    });
    await seedReadModelStepRun(db, { runId: graph.runId, stepId: stepB! });
    const scope = readModelScope(graph, stepA!);
    const beforeValid = await canonicalHistoryRows(db, graph.runId);

    // [실증 1] 실제 REPEATABLE READ, READ ONLY 트랜잭션 안에서 reader 호출(유효 호출).
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      const result = await readResumeExecutionHistory(tx, scope);
      expect(result.steps).toHaveLength(2);
      expect(result.issues.map((row) => row.id)).toEqual([issueA]);
    });
    expect(await canonicalHistoryRows(db, graph.runId)).toEqual(beforeValid);

    // [실증 2] 차단 호출(scope 오염: 타회사 heartbeat 가 우리 step run 에 연결) — reader reject, DB 무변화.
    const foreign = await seedForeignReadModelGraph(fixture.sql, db);
    await seedReadModelHeartbeat(db, {
      companyId: foreign.companyId,
      agentId: foreign.agentId,
      workflowStepRunId: stepARunId,
    });
    const beforeBlocked = await canonicalHistoryRows(db, graph.runId);
    let blockedMessage = "";
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      blockedMessage = (await captureHttpError(readResumeExecutionHistory(tx, scope))).message;
      throw new Error("rollback-blocked-transaction");
    }).catch(() => {});
    expect(blockedMessage).toBe("scope_mismatch");
    expect(await canonicalHistoryRows(db, graph.runId)).toEqual(beforeBlocked);

    // [실증 3] READ ONLY 모드가 실제로 UPDATE 를 거부함을 별도 rollback 트랜잭션에서 증명.
    // captureHttpError 는 임의 오류를 HttpError 로 강제 캐스팅하므로 read-only 증명에는 쓰지 않는다 —
    // catch 한 원본 오류의 cause 쇄를 테스트 전용 narrow 타입으로 검사해 SQLSTATE 를 직접 확인한다.
    interface PgErrorShape { readonly code?: string; readonly message?: unknown; readonly cause?: unknown }
    const collectPgErrorChain = (error: unknown): PgErrorShape[] => {
      const chain: PgErrorShape[] = [];
      let current: unknown = error;
      while (typeof current === "object" && current !== null) {
        chain.push(current as PgErrorShape);
        current = (current as PgErrorShape).cause;
      }
      return chain;
    };
    let updateError: unknown;
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      try {
        await tx.execute(sql`UPDATE workflow_step_runs SET status = 'mutated' WHERE workflow_run_id = ${graph.runId}`);
      } catch (error) {
        updateError = error;
      }
      throw new Error("rollback-update-proof-transaction");
    }).catch(() => {});
    // SQLSTATE 25006(read_only_sql_transaction) 과 read-only 트랜잭션 메시지가 cause 쇄에 있어야 증명 —
    // 임의 SQL/FK/syntax 오류는 read-only 모드의 증거가 아니다.
    const updateErrorChain = collectPgErrorChain(updateError);
    expect(updateErrorChain.some((e) => e.code === "25006")).toBe(true);
    expect(updateErrorChain.some((e) => /read-only/i.test(String(e.message ?? "")))).toBe(true);
    expect(await canonicalHistoryRows(db, graph.runId)).toEqual(beforeBlocked);
  }, 30_000);
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createDb, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { readResumeExecutionHistory } from "../services/workflow/resume/read-model.js";
import {
  canonicalHistoryRows,
  canonicalResourceRows,
  cleanupResourceTables,
  readModelScope,
  readResourceHistoryReadonly,
  seedAdditionalMission,
  seedCompleteStepRuns,
  seedForeignReadModelGraph,
  seedReadModelGraph,
  seedReadModelHeartbeat,
  seedReadModelIssue,
  seedReadModelStepRun,
  startExecutionDefinitionFixture,
  seedResourceFinalization,
  seedResourceFinalizationStep,
  seedResourceMissionRuntime,
  seedResourceRuntimeService,
  seedResourceWorkspaceOperation,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-resume-resource-fixture.js";

/**
 * [purpose] Task5c2c raw resource/finalization collection via public readResumeExecutionHistory
 *   (항상 repeatable-read read-only 트랜잭션 헬퍼 경유):
 *   pristine graph -> five empty arrays (no broad selects), full raw rows across terminal/unknown
 *   statuses/versions/leases/payload with duplicate stageKind retained in deterministic id order
 *   (전체 raw-row 계약: 다섯 배열 전부 canonicalResourceRows 와 전체 비교), each independent
 *   service association, REAL read-only repeatable-read caller tx proof (session settings +
 *   read twice equal; canonical rows of old history + all FIVE resource tables unchanged).
 *   mission-runtime scope 연관/moved lastRunId 와 거부 precedence 는 resource-scope.test.ts 로.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEP("readResumeExecutionHistory — raw resource/finalization collection", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("resume-read-model-resources-");
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

  it("returns all five resource arrays empty for a pristine graph; unrelated same/foreign rows excluded without broad selects", async () => {
    const graph = await seedReadModelGraph(fixture.sql, db);
    await seedCompleteStepRuns(db, graph);
    // 같은 회사 무관 heartbeat + 그에 붙은 finalization/operation — scope 이력에 없으므로 제외.
    const strayHeartbeatId = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId });
    await seedResourceFinalization(db, { companyId: graph.companyId, heartbeatRunId: strayHeartbeatId });
    await seedResourceWorkspaceOperation(db, { companyId: graph.companyId, heartbeatRunId: strayHeartbeatId, phase: "stray" });
    // 링크 없는 같은 회사 service(비-run scope)·다른 mission runtime — 제외.
    await seedResourceRuntimeService(db, { companyId: graph.companyId, scopeType: "project", scopeId: null });
    const otherMission = await seedAdditionalMission(fixture.sql, graph.companyId, graph.agentId);
    await seedResourceMissionRuntime(db, { companyId: graph.companyId, missionId: otherMission, agentId: graph.agentId });
    // 외부 회사 무관 행들 — 어떤 scoped link 도 없음.
    const foreign = await seedForeignReadModelGraph(fixture.sql, db);
    const foreignHeartbeatId = await seedReadModelHeartbeat(db, {
      companyId: foreign.companyId, agentId: foreign.agentId, workflowStepRunId: foreign.stepRunId,
    });
    await seedResourceFinalization(db, { companyId: foreign.companyId, heartbeatRunId: foreignHeartbeatId });
    await seedResourceWorkspaceOperation(db, { companyId: foreign.companyId, heartbeatRunId: foreignHeartbeatId, phase: "foreign" });
    await seedResourceRuntimeService(db, { companyId: foreign.companyId, scopeType: "workspace", scopeId: randomUUID() });
    await seedResourceMissionRuntime(db, { companyId: foreign.companyId, missionId: foreign.missionId, agentId: foreign.agentId });

    const result = await readResourceHistoryReadonly(db, readModelScope(graph));
    expect(result.finalizations).toEqual([]);
    expect(result.finalizationSteps).toEqual([]);
    expect(result.workspaceOperations).toEqual([]);
    expect(result.workspaceRuntimeServices).toEqual([]);
    expect(result.missionAgentRuntimes).toEqual([]);
    expect(result.heartbeats).toEqual([]); // stray/foreign heartbeat 도 scope 이력엔 없음
  }, 30_000);

  it("collects full raw rows across terminal/unknown statuses, version 0/1, leases+Date+payload, duplicate stageKind — id order preserved", async () => {
    const graph = await seedReadModelGraph(fixture.sql, db);
    const [stepA, stepB] = graph.definitionStepIds;
    const issueA = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    const stepARunId = await seedReadModelStepRun(db, { runId: graph.runId, stepId: stepA!, issueId: issueA });
    await seedReadModelStepRun(db, { runId: graph.runId, stepId: stepB! });
    // 여러 heartbeat generation(gen 0/5, terminal/unknown status) — 각각 finalization.
    const hb0 = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId, workflowStepRunId: stepARunId, workflowExecutionGeneration: 0, status: "succeeded" });
    const hb5 = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId, workflowStepRunId: stepARunId, workflowExecutionGeneration: 5, status: "mystery_unknown_status" });
    const leaseToken0 = randomUUID();
    const fin0 = await seedResourceFinalization(db, {
      companyId: graph.companyId, heartbeatRunId: hb0, terminalOutcome: "completed", finalizationVersion: 0,
      state: "completed", leaseEpoch: 2, leaseToken: leaseToken0, owner: "finalizer-1",
      leaseExpiresAt: new Date("2024-06-01T00:00:00.000Z"), attempts: 1, maxAttempts: 3,
    });
    const fin5 = await seedResourceFinalization(db, {
      companyId: graph.companyId, heartbeatRunId: hb5, terminalOutcome: "failed", finalizationVersion: 1,
      state: "pending", lastError: "boom",
    });
    // duplicate stageKind — 다른 idempotencyKey 면 정당하므로 전부 보존.
    const stageLeaseToken = randomUUID();
    const stageA = await seedResourceFinalizationStep(db, {
      companyId: graph.companyId, heartbeatRunId: hb0, heartbeatRunFinalizationId: fin0,
      stageKind: "ledger", idempotencyKey: "k-1", state: "applied", payload: { rows: 3, note: "keep" },
    });
    const stageB = await seedResourceFinalizationStep(db, {
      companyId: graph.companyId, heartbeatRunId: hb0, heartbeatRunFinalizationId: fin0,
      stageKind: "ledger", idempotencyKey: "k-2", state: "weird_unknown_state", leaseEpoch: 4, leaseToken: stageLeaseToken,
      leaseOwner: "stage-owner", leaseExpiresAt: new Date("2024-06-02T00:00:00.000Z"), payload: {},
    });
    const stageC = await seedResourceFinalizationStep(db, {
      companyId: graph.companyId, heartbeatRunId: hb5, heartbeatRunFinalizationId: fin5,
      stageKind: "cleanup", idempotencyKey: "k-3",
    });
    const opRunning = await seedResourceWorkspaceOperation(db, {
      companyId: graph.companyId, heartbeatRunId: hb0, phase: "build", status: "running",
      command: "pnpm build", stdoutExcerpt: "ok",
    });
    const opFailed = await seedResourceWorkspaceOperation(db, {
      companyId: graph.companyId, heartbeatRunId: hb5, phase: "test", status: "failed", exitCode: 1,
      finishedAt: new Date("2024-06-03T00:00:00.000Z"),
    });
    const svc = await seedResourceRuntimeService(db, {
      companyId: graph.companyId, startedByRunId: hb0, scopeType: "run", scopeId: hb0,
      serviceName: "api", status: "running", lifecycle: "ephemeral", provider: "docker", port: 8080,
    });
    const rt = await seedResourceMissionRuntime(db, {
      companyId: graph.companyId, missionId: graph.missionId, agentId: graph.agentId, status: "busy", lastRunId: hb5,
      lastRunStatus: "completed", currentIssueId: issueA, queueDepth: 4, processPid: 4242,
      stoppedAt: new Date("2024-06-04T00:00:00.000Z"), stateJson: { bootstrapContextInjected: true },
    });

    const result = await readResourceHistoryReadonly(db, readModelScope(graph, stepA!));
    // [순서] 실제 배열을 정렬하지 않고 기대값을 id 오름차순으로 만들어 대조.
    expect(result.finalizations.map((row) => row.id)).toEqual([fin0, fin5].sort());
    expect(result.finalizationSteps.map((row) => row.id)).toEqual([stageA, stageB, stageC].sort());
    expect(result.workspaceOperations.map((row) => row.id)).toEqual([opRunning, opFailed].sort());
    expect(result.workspaceRuntimeServices.map((row) => row.id)).toEqual([svc]);
    expect(result.missionAgentRuntimes.map((row) => row.id)).toEqual([rt]);
    expect(result.heartbeats.map((row) => row.id)).toEqual([hb0, hb5].sort());

    const fin0Row = result.finalizations.find((row) => row.id === fin0)!;
    expect(fin0Row).toMatchObject({
      finalizationVersion: 0, terminalOutcome: "completed", finalizerLeaseToken: leaseToken0,
      finalizerOwner: "finalizer-1", attempts: 1,
    });
    expect(fin0Row.finalizerLeaseExpiresAt).toBeInstanceOf(Date);
    const fin5Row = result.finalizations.find((row) => row.id === fin5)!;
    expect(fin5Row).toMatchObject({ finalizationVersion: 1, state: "pending", lastError: "boom" });
    // duplicate stageKind 유지 + unknown state/lease/payload raw 보존.
    const ledgerRows = result.finalizationSteps.filter((row) => row.stageKind === "ledger");
    expect(ledgerRows.map((row) => row.idempotencyKey).sort()).toEqual(["k-1", "k-2"]);
    const stageBRow = result.finalizationSteps.find((row) => row.id === stageB)!;
    expect(stageBRow.state).toBe("weird_unknown_state");
    expect(stageBRow.leaseToken).toBe(stageLeaseToken);
    expect(stageBRow.leaseExpiresAt).toBeInstanceOf(Date);
    expect(result.finalizationSteps.find((row) => row.id === stageA)!.payload).toEqual({ rows: 3, note: "keep" });
    const opFailedRow = result.workspaceOperations.find((row) => row.id === opFailed)!;
    expect(opFailedRow.status).toBe("failed");
    expect(opFailedRow.exitCode).toBe(1);
    expect(opFailedRow.finishedAt).toBeInstanceOf(Date);
    const rtRow = result.missionAgentRuntimes.find((row) => row.id === rt)!;
    expect(rtRow.status).toBe("busy");
    expect(rtRow.queueDepth).toBe(4);
    expect(rtRow.processPid).toBe(4242); // raw 보존 — process.kill 호출 따위 없음(읽기만 한다)
    expect(rtRow.stoppedAt).toBeInstanceOf(Date);
    expect(rtRow.lastRunStatus).toBe("completed");
    // [전체 raw-row 계약] 이 테스트 fixture 의 다섯 resource 테이블은 scoped 행만 있으므로,
    //   반환된 다섯 배열 전부가 canonical 전체 행(미지 컬럼/lease/Date 포함)과 정확히 같아야 한다.
    const canonical = await canonicalResourceRows(db);
    expect(result.finalizations).toEqual(canonical.finalizations);
    expect(result.finalizationSteps).toEqual(canonical.finalizationSteps);
    expect(result.workspaceOperations).toEqual(canonical.workspaceOperations);
    expect(result.workspaceRuntimeServices).toEqual(canonical.workspaceRuntimeServices);
    expect(result.missionAgentRuntimes).toEqual(canonical.missionAgentRuntimes);
  }, 30_000);

  it("collects services by each independent association; matching scopeId in non-run scope excluded; overlapping predicates without duplicates", async () => {
    const graph = await seedReadModelGraph(fixture.sql, db);
    const [stepA, stepB] = graph.definitionStepIds;
    const issueA = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    const stepARunId = await seedReadModelStepRun(db, { runId: graph.runId, stepId: stepA!, issueId: issueA });
    await seedReadModelStepRun(db, { runId: graph.runId, stepId: stepB! });
    const hb = await seedReadModelHeartbeat(db, {
      companyId: graph.companyId, agentId: graph.agentId, workflowStepRunId: stepARunId,
    });
    const byRun = await seedResourceRuntimeService(db, {
      companyId: graph.companyId, startedByRunId: hb, scopeType: "project", scopeId: null, serviceName: "by-run",
    });
    const byIssue = await seedResourceRuntimeService(db, {
      companyId: graph.companyId, issueId: issueA, scopeType: "workspace", scopeId: null, serviceName: "by-issue",
    });
    // run-scope 연관 — startedByRunId/issueId 는 null.
    const byRunScope = await seedResourceRuntimeService(db, {
      companyId: graph.companyId, scopeType: "run", scopeId: hb, serviceName: "by-run-scope",
    });
    const overlap = await seedResourceRuntimeService(db, {
      companyId: graph.companyId, startedByRunId: hb, issueId: issueA, scopeType: "run", scopeId: hb,
      serviceName: "overlap",
    });
    // 같은 scopeId 문자열이라도 non-run scope 단독으로는 매치되지 않는다.
    const wrongScope = await seedResourceRuntimeService(db, {
      companyId: graph.companyId, scopeType: "workspace", scopeId: hb, serviceName: "wrong-scope",
    });

    const result = await readResourceHistoryReadonly(db, readModelScope(graph, stepA!));
    const ids = result.workspaceRuntimeServices.map((row) => row.id);
    expect(ids).toEqual([byRun, byIssue, byRunScope, overlap].sort());
    expect(new Set(ids).size).toBe(ids.length); // 겹치는 술어도 중복 행 없음
    expect(ids).not.toContain(wrongScope);
  }, 30_000);

  it("read twice in one repeatable-read read-only tx returns equal full results; canonical old-history + FIVE resource tables unchanged", async () => {
    const graph = await seedReadModelGraph(fixture.sql, db);
    const [stepA, stepB] = graph.definitionStepIds;
    const issueA = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    const stepARunId = await seedReadModelStepRun(db, { runId: graph.runId, stepId: stepA!, issueId: issueA });
    await seedReadModelStepRun(db, { runId: graph.runId, stepId: stepB! });
    const hb = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId, workflowStepRunId: stepARunId });
    const fin = await seedResourceFinalization(db, { companyId: graph.companyId, heartbeatRunId: hb });
    const stage = await seedResourceFinalizationStep(db, {
      companyId: graph.companyId, heartbeatRunId: hb, heartbeatRunFinalizationId: fin,
      stageKind: "ledger", idempotencyKey: "k-1",
    });
    await seedResourceWorkspaceOperation(db, { companyId: graph.companyId, heartbeatRunId: hb, phase: "build" });
    await seedResourceRuntimeService(db, { companyId: graph.companyId, startedByRunId: hb, scopeType: "run", scopeId: hb });
    await seedResourceMissionRuntime(db, { companyId: graph.companyId, missionId: graph.missionId, agentId: graph.agentId });
    const scope = readModelScope(graph, stepA!);
    const before = { ...await canonicalHistoryRows(db, graph.runId), ...await canonicalResourceRows(db) };

    // SET 명령 대신 트랜잭션 설정으로 repeatable-read read-only 를 연다(같은 TX 안 반복 읽기는
    //   reader 를 직접(tx,..) 호출 — 헬퍼는 TX 를 한 번 더 감싸므로 여기선 쓰지 않는다).
    await db.transaction(async (tx) => {
      // [설정 증명] 실제 세션 설정으로 이 TX 가 read-only repeatable-read 로 열렸음을 확인.
      const settings = await tx.execute<{ read_only: string; isolation: string }>(
        sql`SELECT current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation`,
      );
      expect(settings[0]?.read_only).toBe("on");
      expect(settings[0]?.isolation).toBe("repeatable read");
      const first = await readResumeExecutionHistory(tx, scope);
      const second = await readResumeExecutionHistory(tx, scope);
      expect(second).toEqual(first); // 같은 repeatable-read readonly TX 안에서 두 번 읽기 — 완전 동일
      expect(first.finalizations.map((row) => row.id)).toEqual([fin]);
      expect(first.finalizationSteps.map((row) => row.id)).toEqual([stage]);
      expect(first.workspaceOperations).toHaveLength(1);
      expect(first.workspaceRuntimeServices).toHaveLength(1);
      expect(first.missionAgentRuntimes).toHaveLength(1);
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    const after = { ...await canonicalHistoryRows(db, graph.runId), ...await canonicalResourceRows(db) };
    expect(after).toEqual(before); // 성공 경로에서도 어떤 테이블도 변하지 않음
  }, 30_000);
});

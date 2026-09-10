import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { readResumeMissionHistory } from "../services/workflow/resume/read-model-mission.js";
import {
  canonicalMissionDomain,
  cleanupResourceTables,
  readMissionHistoryReadonly,
  readModelScope,
  seedAdditionalMission,
  seedCompleteStepRuns,
  seedForeignReadModelGraph,
  seedLegacyJsonHeartbeat,
  seedLegacyJsonWakeup,
  seedMissionSiblingRun,
  seedReadModelGraph,
  seedReadModelHeartbeat,
  seedReadModelIssue,
  seedReadModelStepRun,
  seedReadModelWakeup,
  seedResourceFinalization,
  seedResourceMissionRuntime,
  seedWorkflowDefinition,
  seedWorkflowRun,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-resume-mission-fixture.js";

/**
 * [purpose] Task5c3c whole-mission root enumeration via public readResumeMissionHistory
 *   (항상 실제 repeatable-read read-only 트랜잭션): selected + same-mission sibling roots of
 *   every status/definition/snapshot-state are retained with FULL rows; same-company
 *   other-mission and unrelated foreign-company runs are excluded; legacy JSON-only sibling
 *   run links discovered with exact top-level string equality only; repeat-read equality +
 *   session settings proof + whole-domain canonical unchanged. Real embedded Postgres, no
 *   mocks, no skipped suites.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEP("readResumeMissionHistory — mission root enumeration", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("resume-mission-roots-");
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

  /** frozen selected graph + 1:1 step rows — collector 통과 최소 selected 그래프. */
  async function seedSelectedGraph() {
    const graph = await seedReadModelGraph(fixture.sql, db);
    const selectedStepRowIds = await seedCompleteStepRuns(db, graph);
    return { graph, selectedStepRowIds };
  }

  it("retains selected + same-mission sibling roots of every status/definition with full rows; excludes other-mission and foreign-company runs", async () => {
    const { graph, selectedStepRowIds } = await seedSelectedGraph();
    const [stepA] = graph.definitionStepIds;
    // 형제 root: 다른 정의(running) / 같은 정의(completed) / pending(+legacy semantic step) /
    // failed(zero-step) / cancelled(+step). metadata {} legacy run, frozen snapshot 없음.
    const runningRun = await seedMissionSiblingRun(fixture.sql, { companyId: graph.companyId, missionId: graph.missionId, status: "running" });
    const completedRun = await seedMissionSiblingRun(fixture.sql, { companyId: graph.companyId, missionId: graph.missionId, workflowId: graph.workflowId, status: "completed" });
    const pendingRun = await seedMissionSiblingRun(fixture.sql, { companyId: graph.companyId, missionId: graph.missionId, status: "pending", metadata: {} });
    await seedReadModelStepRun(db, { runId: pendingRun, stepId: "legacy-sib-step", executionGeneration: 4 });
    const failedRun = await seedMissionSiblingRun(fixture.sql, { companyId: graph.companyId, missionId: graph.missionId, status: "failed" });
    const cancelledRun = await seedMissionSiblingRun(fixture.sql, { companyId: graph.companyId, missionId: graph.missionId, status: "cancelled" });
    await seedReadModelStepRun(db, { runId: cancelledRun, stepId: "legacy-sib-step-2" });
    // 제외 대상: 같은 회사 다른 mission run, 외국 회사 무관 mission run.
    const otherMission = await seedAdditionalMission(fixture.sql, graph.companyId, graph.agentId);
    const otherMissionRun = await seedWorkflowRun(fixture.sql, { workflowId: graph.workflowId, companyId: graph.companyId, missionId: otherMission, status: "pending" });
    const foreign = await seedForeignReadModelGraph(fixture.sql, db);
    const foreignWorkflowId = await seedWorkflowDefinition(fixture.sql, { companyId: foreign.companyId, name: "foreign-mission-run", stepsJson: [] });
    const foreignRun = await seedWorkflowRun(fixture.sql, { workflowId: foreignWorkflowId, companyId: foreign.companyId, missionId: foreign.missionId, status: "running" });

    const result = await readMissionHistoryReadonly(db, readModelScope(graph));

    const rootIds = result.missionRuns.map((row) => row.id);
    const expectedIds = [graph.runId, runningRun, completedRun, pendingRun, failedRun, cancelledRun].sort();
    expect(rootIds).toEqual(expectedIds);
    expect(rootIds).toEqual([...rootIds].sort());
    expect(new Set(rootIds).size).toBe(rootIds.length);
    expect(rootIds).not.toContain(otherMissionRun);
    expect(rootIds).not.toContain(foreignRun);
    // [전체 행 비교] id 뿐 아니라 full row 가 canonical DB rows 와 정확히 같다.
    const canonical = await canonicalMissionDomain(db);
    expect(result.missionRuns).toEqual(canonical.runs.filter((row) => expectedIds.includes(row.id)));
    expect(result.missionSteps).toEqual(canonical.stepRuns.filter((row) => expectedIds.includes(row.workflowRunId)));
    expect(result.missionSteps.map((row) => row.id)).toEqual([...result.missionSteps.map((row) => row.id)].sort());
    // status 필터 없음 — 모든 status root 가 raw 보존된다.
    const statusById = new Map(result.missionRuns.map((row) => [row.id, row.status]));
    expect(statusById.get(runningRun)).toBe("running");
    expect(statusById.get(completedRun)).toBe("completed");
    expect(statusById.get(pendingRun)).toBe("pending");
    expect(statusById.get(failedRun)).toBe("failed");
    expect(statusById.get(cancelledRun)).toBe("cancelled");
    // selected 결과는 selected-reader 계약 그대로 — frozen steps 1:1.
    expect(result.selected.run.id).toBe(graph.runId);
    expect(result.selected.steps.map((row) => row.id).sort()).toEqual([...selectedStepRowIds].sort());
    expect(result.missionSteps.some((row) => row.workflowRunId === graph.runId && row.stepId === stepA)).toBe(true);
  }, 30_000);

  it("discovers legacy JSON-only sibling workflowRunId links for wakeup AND heartbeat with typed fields null; substring/number/nonstring values not accepted", async () => {
    const { graph } = await seedSelectedGraph();
    const sibling = await seedMissionSiblingRun(fixture.sql, { companyId: graph.companyId, missionId: graph.missionId, status: "completed" });
    const legacyWakeup = await seedLegacyJsonWakeup(db, {
      companyId: graph.companyId, agentId: graph.agentId, payload: { workflowRunId: sibling },
    });
    const legacyHeartbeat = await seedLegacyJsonHeartbeat(db, {
      companyId: graph.companyId, agentId: graph.agentId, contextSnapshot: { workflowRunId: sibling },
    });
    // decoy: substring/number/object/null 값 — 정확한 최상위 "문자열" 동등만 받아들여진다.
    const decoyWakeups: string[] = [];
    for (const payload of [
      { workflowRunId: sibling + "x" }, { workflowRunId: 12345 }, { workflowRunId: { nested: true } }, { workflowRunId: null },
    ]) {
      decoyWakeups.push(await seedLegacyJsonWakeup(db, { companyId: graph.companyId, agentId: graph.agentId, payload }));
    }
    const decoyHeartbeat = await seedLegacyJsonHeartbeat(db, {
      companyId: graph.companyId, agentId: graph.agentId, contextSnapshot: { workflowRunId: 99 },
    });

    const result = await readMissionHistoryReadonly(db, readModelScope(graph));

    expect(result.history.wakeups.map((row) => row.id)).toEqual([legacyWakeup]);
    expect(result.history.heartbeats.map((row) => row.id)).toEqual([legacyHeartbeat]);
    const wakeRow = result.history.wakeups[0]!;
    expect(wakeRow.payload).toEqual({ workflowRunId: sibling });
    expect(wakeRow.missionId).toBeNull();
    expect(wakeRow.workflowRunId).toBeNull();
    expect(wakeRow.workflowStepRunId).toBeNull();
    expect(wakeRow.issueId).toBeNull();
    const heartbeatRow = result.history.heartbeats[0]!;
    expect(heartbeatRow.contextSnapshot).toEqual({ workflowRunId: sibling });
    expect(heartbeatRow.issueId).toBeNull();
    expect(heartbeatRow.workflowStepRunId).toBeNull();
    expect(heartbeatRow.wakeupRequestId).toBeNull();
    for (const decoy of [...decoyWakeups, decoyHeartbeat]) {
      expect(result.history.wakeups.map((row) => row.id)).not.toContain(decoy);
      expect(result.history.heartbeats.map((row) => row.id)).not.toContain(decoy);
    }
  }, 30_000);

  it("outputs each database id once in sorted order when multiple run histories rediscover the same mission issue/wakeup/heartbeat/runtime; full rows preserved", async () => {
    const graph = await seedReadModelGraph(fixture.sql, db);
    const sharedIssue = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    // selected step 이(가) 같은 issue 를 참조 — selected/sibling 양쪽 history 가 재발견한다.
    await seedReadModelStepRun(db, { runId: graph.runId, stepId: graph.definitionStepIds[0]!, issueId: sharedIssue });
    await seedReadModelStepRun(db, { runId: graph.runId, stepId: graph.definitionStepIds[1]! });
    const sibling = await seedMissionSiblingRun(fixture.sql, { companyId: graph.companyId, missionId: graph.missionId });
    await seedReadModelStepRun(db, { runId: sibling, stepId: "sib-shared-step", issueId: sharedIssue });
    const firstWakeup = await seedReadModelWakeup(db, { companyId: graph.companyId, agentId: graph.agentId, missionId: graph.missionId });
    const secondWakeup = await seedReadModelWakeup(db, { companyId: graph.companyId, agentId: graph.agentId, missionId: graph.missionId });
    const sharedHeartbeat = await seedLegacyJsonHeartbeat(db, {
      companyId: graph.companyId, agentId: graph.agentId, contextSnapshot: { missionId: graph.missionId },
    });
    const sharedRuntime = await seedResourceMissionRuntime(db, {
      companyId: graph.companyId, missionId: graph.missionId, agentId: graph.agentId,
    });

    const result = await readMissionHistoryReadonly(db, readModelScope(graph));
    expect(result.history.issues.map((row) => row.id)).toEqual([sharedIssue]);
    expect(result.history.wakeups.map((row) => row.id)).toEqual([firstWakeup, secondWakeup].sort());
    expect(result.history.heartbeats.map((row) => row.id)).toEqual([sharedHeartbeat]);
    expect(result.resources.missionAgentRuntimes.map((row) => row.id)).toEqual([sharedRuntime]);
    const canonical = await canonicalMissionDomain(db);
    expect(result.history.issues).toEqual(canonical.issues.filter((row) => row.id === sharedIssue));
    expect(result.history.wakeups).toEqual(canonical.wakeups.filter((row) => [firstWakeup, secondWakeup].includes(row.id)));
    expect(result.history.heartbeats).toEqual(canonical.heartbeats.filter((row) => row.id === sharedHeartbeat));
    expect(result.resources.missionAgentRuntimes).toEqual(canonical.missionAgentRuntimes.filter((row) => row.id === sharedRuntime));
  }, 30_000);

  it("proves session settings and read-twice equality inside one repeatable-read read-only tx; whole-domain canonical unchanged", async () => {
    const { graph, selectedStepRowIds } = await seedSelectedGraph();
    const sibling = await seedMissionSiblingRun(fixture.sql, { companyId: graph.companyId, missionId: graph.missionId, status: "running" });
    const siblingStep = await seedReadModelStepRun(db, { runId: sibling, stepId: "sib-repeat-step", executionGeneration: 2 });
    const issue = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    const wakeup = await seedReadModelWakeup(db, { companyId: graph.companyId, agentId: graph.agentId, missionId: graph.missionId });
    const heartbeat = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId, issueId: issue });
    const finalization = await seedResourceFinalization(db, { companyId: graph.companyId, heartbeatRunId: heartbeat });
    const before = await canonicalMissionDomain(db);
    const scope = readModelScope(graph);

    await db.transaction(async (tx) => {
      // [설정 증명] 이 TX 가 실제로 read-only repeatable-read 로 열렸음을 세션 설정으로 확인.
      const settings = await tx.execute<{ read_only: string; isolation: string }>(
        sql`SELECT current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation`,
      );
      expect(settings[0]?.read_only).toBe("on");
      expect(settings[0]?.isolation).toBe("repeatable read");
      const first = await readResumeMissionHistory(tx, scope);
      const second = await readResumeMissionHistory(tx, scope);
      expect(second).toEqual(first); // 같은 TX 안 두 번 읽기 — 완전 동일
      expect(first.missionRuns.map((row) => row.id).sort()).toEqual([graph.runId, sibling].sort());
      expect(first.missionSteps.map((row) => row.id).sort()).toEqual([...selectedStepRowIds, siblingStep].sort());
      expect(first.history.issues.map((row) => row.id)).toEqual([issue]);
      expect(first.history.wakeups.map((row) => row.id)).toEqual([wakeup]);
      expect(first.history.heartbeats.map((row) => row.id)).toEqual([heartbeat]);
      expect(first.resources.finalizations.map((row) => row.id)).toEqual([finalization]);
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    expect(await canonicalMissionDomain(db)).toEqual(before); // 성공 경로에서도 무변화
  }, 30_000);
});

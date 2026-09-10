import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import {
  captureHttpError,
  cleanupResourceTables,
  readModelScope,
  readResourceHistoryReadonly,
  seedAdditionalMission,
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
  type ExecutionDefinitionFixture,
  type ReadModelGraph,
} from "./helpers/workflow-resume-resource-fixture.js";

/**
 * [purpose] Task5c2c mission-runtime scope association + rejection precedence, always through the
 *   real repeatable-read read-only helper: a same-mission runtime whose lastRunId was moved OUT of
 *   the scoped history (real same-company UNLINKED heartbeat) is still included via missionId
 *   alone while the heartbeat itself stays absent from the returned history; other-mission
 *   run-only / issue-only / bootstrap-only controls preserved; and a foreign-company stage whose
 *   parent relation is ALSO invalid is rejected by finalization_step_company_mismatch BEFORE any
 *   parent judgement (real, independent FKs on both sides).
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEP("readResumeExecutionHistory — runtime scope association and rejection precedence", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("resume-read-model-resource-scope-");
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

  it("collects mission runtimes by missionId/lastRunId/currentIssueId; runtime whose lastRunId moved to an unlinked same-company heartbeat stays included while that heartbeat is excluded; issue-only graph works with zero heartbeats", async () => {
    // [issue-only] heartbeat 이 하나도 없는 이력 — issue 는 step 참조로만 scope 에 들어온다.
    const graph = await seedReadModelGraph(fixture.sql, db);
    const [stepA, stepB] = graph.definitionStepIds;
    const issueA = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    await seedReadModelStepRun(db, { runId: graph.runId, stepId: stepA!, issueId: issueA });
    await seedReadModelStepRun(db, { runId: graph.runId, stepId: stepB! });
    const otherMission = await seedAdditionalMission(fixture.sql, graph.companyId, graph.agentId);
    const issueOnlySvc = await seedResourceRuntimeService(db, {
      companyId: graph.companyId, issueId: issueA, scopeType: "project", scopeId: null,
    });
    // 다른 mission 소속 runtime 이 우리 issue 를 currentIssueId 로 참조 — raw conflict 로 보존.
    const viaIssueRuntime = await seedResourceMissionRuntime(db, {
      companyId: graph.companyId, missionId: otherMission, agentId: graph.agentId,
      workspaceKey: "via-issue", currentIssueId: issueA, status: "busy",
    });
    const resultIssueOnly = await readResourceHistoryReadonly(db, readModelScope(graph, stepA!));
    expect(resultIssueOnly.heartbeats).toEqual([]);
    expect(resultIssueOnly.finalizations).toEqual([]); // 빈 id 집합 — 질의 없이 []
    expect(resultIssueOnly.workspaceOperations).toEqual([]);
    expect(resultIssueOnly.workspaceRuntimeServices.map((row) => row.id)).toEqual([issueOnlySvc]);
    expect(resultIssueOnly.missionAgentRuntimes.map((row) => row.id)).toEqual([viaIssueRuntime]);

    // [heartbeat graph] missionId/lastRunId/currentIssueId 각 연관 + 실제 moved lastRunId 증명.
    const graph2 = await seedReadModelGraph(fixture.sql, db);
    const [step2A, step2B] = graph2.definitionStepIds;
    const issue2 = await seedReadModelIssue(db, { companyId: graph2.companyId, missionId: graph2.missionId });
    const step2ARunId = await seedReadModelStepRun(db, { runId: graph2.runId, stepId: step2A!, issueId: issue2 });
    await seedReadModelStepRun(db, { runId: graph2.runId, stepId: step2B! });
    const hb2 = await seedReadModelHeartbeat(db, { companyId: graph2.companyId, agentId: graph2.agentId, workflowStepRunId: step2ARunId });
    const secondMission = await seedAdditionalMission(fixture.sql, graph2.companyId, graph2.agentId);
    const bootstrapOnly = await seedResourceMissionRuntime(db, {
      companyId: graph2.companyId, missionId: graph2.missionId, agentId: graph2.agentId, workspaceKey: "bootstrap",
    });
    // [moved lastRunId 실증] 같은 회사의 링크 없는(unlinked: issue/wakeup/step 어디에도 묶이지
    //   않은) heartbeat 을 실제로 만들고, 같은 mission runtime 의 lastRunId 가 그것을 가리키며
    //   currentIssueId 는 null 이다. 이 runtime 은 missionId 술어 하나로만 포함되어야 하고,
    //   그 heartbeat 자체는 scope 이력에 없다 — NULL lastRunId 어설션만으론 증명되지 않았던 케이스.
    const unlinkedHb = await seedReadModelHeartbeat(db, { companyId: graph2.companyId, agentId: graph2.agentId });
    const movedRuntime = await seedResourceMissionRuntime(db, {
      companyId: graph2.companyId, missionId: graph2.missionId, agentId: graph2.agentId,
      workspaceKey: "moved", lastRunId: unlinkedHb, currentIssueId: null,
    });
    // [기존 케이스 보존] 다른 mission 이 scoped run 으로만 묶인 행 + 완전 무관 다른 mission 행.
    const otherMissionRunRuntime = await seedResourceMissionRuntime(db, {
      companyId: graph2.companyId, missionId: secondMission, agentId: graph2.agentId,
      workspaceKey: "other-mission-run", lastRunId: hb2,
    });
    const missionRun = await seedResourceMissionRuntime(db, {
      companyId: graph2.companyId, missionId: graph2.missionId, agentId: graph2.agentId,
      workspaceKey: "mission-run", lastRunId: hb2, currentIssueId: issue2,
    });
    const unrelated = await seedResourceMissionRuntime(db, {
      companyId: graph2.companyId, missionId: secondMission, agentId: graph2.agentId, workspaceKey: "unrelated",
    });

    const result = await readResourceHistoryReadonly(db, readModelScope(graph2, step2A!));
    const runtimeIds = result.missionAgentRuntimes.map((row) => row.id);
    expect(runtimeIds).toEqual([bootstrapOnly, movedRuntime, missionRun, otherMissionRunRuntime].sort());
    expect(new Set(runtimeIds).size).toBe(runtimeIds.length);
    expect(runtimeIds).not.toContain(unrelated); // 무관 다른 mission 행 제외
    // lastRunId 가 scope 밖(unlinked heartbeat)으로 옮겨간 같은-mission 행도 missionId 로 포함된다.
    const movedRow = result.missionAgentRuntimes.find((row) => row.id === movedRuntime)!;
    expect(movedRow.missionId).toBe(graph2.missionId);
    expect(movedRow.lastRunId).toBe(unlinkedHb);
    expect(movedRow.currentIssueId).toBeNull();
    // bootstrap-only(링크 없는 같은 mission) 행도 그대로 포함된다.
    expect(result.missionAgentRuntimes.find((row) => row.id === bootstrapOnly)?.lastRunId).toBeNull();
    // unlinked heartbeat 자체는 반환 이력에 없다 — missionId 연관만으로 runtime 이 포함됐음을 증명.
    expect(result.heartbeats.map((row) => row.id)).toEqual([hb2]);
  }, 30_000);

  it("rejects a foreign stage whose parent relation is ALSO invalid before any parent judgement: finalization_step_company_mismatch precedes the parent error", async () => {
    const graph = await seedReadModelGraph(fixture.sql, db);
    const [stepA, stepB] = graph.definitionStepIds;
    const issueA = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    const stepARunId = await seedReadModelStepRun(db, { runId: graph.runId, stepId: stepA!, issueId: issueA });
    await seedReadModelStepRun(db, { runId: graph.runId, stepId: stepB! });
    const hb = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId, workflowStepRunId: stepARunId });
    const fin = await seedResourceFinalization(db, { companyId: graph.companyId, heartbeatRunId: hb });
    // [두 결함 동시 존재] 외부 회사 stage: parent FK 는 우리 finalization(실존 — FK 유효)을 가리키고,
    //   stage 의 heartbeatRunId 는 실존하는 다른 외부 heartbeat 를 가리킨다(두 FK 독립적이므로
    //   insert 성공). parent.heartbeatRunId(우리 hb) ≠ stage.heartbeatRunId(외부 hb) 이므로
    //   run_mismatch 도 성립하지만, 회사 검증이 parent 판정보다 먼저다 — precedence 증명.
    const foreign = await seedForeignReadModelGraph(fixture.sql, db);
    const foreignHb = await seedReadModelHeartbeat(db, {
      companyId: foreign.companyId, agentId: foreign.agentId, workflowStepRunId: foreign.stepRunId,
    });
    await seedResourceFinalizationStep(db, {
      companyId: foreign.companyId, heartbeatRunId: foreignHb,
      heartbeatRunFinalizationId: fin, stageKind: "ledger", idempotencyKey: "foreign-and-run-mismatch",
    });
    const error = await captureHttpError(
      readResourceHistoryReadonly(db, readModelScope(graph, stepA!)),
    );
    expect(error.status).toBe(422);
    expect(error.message).toBe("scope_mismatch");
    expect((error.details as { reason: string }).reason).toBe("finalization_step_company_mismatch");
  }, 30_000);
});

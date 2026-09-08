import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDb, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import type { HttpError } from "../errors.js";
import {
  canonicalHistoryRows,
  canonicalResourceRows,
  captureHttpError,
  cleanupResourceTables,
  readModelScope,
  readResourceHistoryReadonly,
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
  type ReadModelGraph,
} from "./helpers/workflow-resume-resource-fixture.js";

/**
 * [purpose] Task5c2c rejection paths: foreign-company contamination on each of the FIVE resource
 *   tables through valid scoped links (exact scope_mismatch reasons, never silently omitted),
 *   foreign-only unlinked controls excluded, independently-valid-FK stage parent validation
 *   (parent_unproven / run_mismatch / valid parent works), and a representative error-path
 *   canonical before/after proof: the expected HttpError is captured OUTSIDE a real
 *   repeatable-read read-only transaction (helper), so unrelated failures are never swallowed.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEP("readResumeExecutionHistory — resource links and contamination rejections", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("resume-read-model-resource-links-");
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

  /** scope 이력에 heartbeat 1개(issue-linked)와 (기본) finalization 1개가 잡힌 최소 그래프. */
  async function seedScopedGraphWithHeartbeat(
    options?: { withFinalization?: boolean },
  ): Promise<{ graph: ReadModelGraph; hb: string; fin: string | null; scopeStep: string }> {
    const withFinalization = options?.withFinalization ?? true;
    const graph = await seedReadModelGraph(fixture.sql, db);
    const [stepA, stepB] = graph.definitionStepIds;
    const issueA = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    const stepARunId = await seedReadModelStepRun(db, { runId: graph.runId, stepId: stepA!, issueId: issueA });
    await seedReadModelStepRun(db, { runId: graph.runId, stepId: stepB! });
    const hb = await seedReadModelHeartbeat(db, {
      companyId: graph.companyId, agentId: graph.agentId, workflowStepRunId: stepARunId,
    });
    const fin = withFinalization
      ? await seedResourceFinalization(db, { companyId: graph.companyId, heartbeatRunId: hb })
      : null;
    return { graph, hb, fin, scopeStep: stepA! };
  }

  function expectScopeMismatch(error: HttpError, reason: string): void {
    expect(error.status).toBe(422);
    expect(error.message).toBe("scope_mismatch");
    expect((error.details as { reason: string }).reason).toBe(reason);
  }

  it("rejects foreign contamination on each of the five tables via valid scoped links with exact reasons; unlinked foreign controls excluded", async () => {
    // [대조군] 링크 없는 외부 행만 있는 그래프 — 오염 전 다섯 배열 전부 비어 있어야 한다.
    const control = await seedScopedGraphWithHeartbeat();
    const foreign = await seedForeignReadModelGraph(fixture.sql, db);
    const foreignHb = await seedReadModelHeartbeat(db, {
      companyId: foreign.companyId, agentId: foreign.agentId, workflowStepRunId: foreign.stepRunId,
    });
    const foreignFin = await seedResourceFinalization(db, { companyId: foreign.companyId, heartbeatRunId: foreignHb });
    await seedResourceFinalizationStep(db, {
      companyId: foreign.companyId, heartbeatRunId: foreignHb,
      heartbeatRunFinalizationId: foreignFin,
      stageKind: "foreign", idempotencyKey: "fk-1",
    });
    await seedResourceWorkspaceOperation(db, { companyId: foreign.companyId, heartbeatRunId: foreignHb, phase: "foreign" });
    await seedResourceRuntimeService(db, { companyId: foreign.companyId, scopeType: "workspace", scopeId: randomUUID() });
    await seedResourceMissionRuntime(db, { companyId: foreign.companyId, missionId: foreign.missionId, agentId: foreign.agentId });
    const controlResult = await readResourceHistoryReadonly(db, readModelScope(control.graph, control.scopeStep));
    expect(controlResult.finalizations.map((row) => row.id)).toEqual([control.fin]); // 우리 것만
    expect(controlResult.finalizationSteps).toEqual([]);
    expect(controlResult.workspaceOperations).toEqual([]);
    expect(controlResult.workspaceRuntimeServices).toEqual([]);
    expect(controlResult.missionAgentRuntimes).toEqual([]);

    // [1] finalization: 외부 회사 행이 우리 heartbeat 를 가리킴(FK 유효, 우리 finalization 이 아직
    //     그 heartbeat 의 유니크 슬롯을 차지하지 않은 상태) — 숨기지 않고 거부.
    const c1 = await seedScopedGraphWithHeartbeat({ withFinalization: false });
    await seedResourceFinalization(db, { companyId: foreign.companyId, heartbeatRunId: c1.hb });
    expectScopeMismatch(
      await captureHttpError(readResourceHistoryReadonly(db, readModelScope(c1.graph, c1.scopeStep))),
      "finalization_company_mismatch",
    );

    // [2] finalization step: 외부 회사 stage 가 우리 finalization(parent) 을 가리킴 — 거부.
    const c2 = await seedScopedGraphWithHeartbeat();
    await seedResourceFinalizationStep(db, {
      companyId: foreign.companyId, heartbeatRunId: c2.hb, heartbeatRunFinalizationId: c2.fin!,
      stageKind: "ledger", idempotencyKey: "foreign-stage-1",
    });
    expectScopeMismatch(
      await captureHttpError(readResourceHistoryReadonly(db, readModelScope(c2.graph, c2.scopeStep))),
      "finalization_step_company_mismatch",
    );

    // [3] workspace operation: 외부 회사 행이 우리 heartbeat 를 가리킴 — 거부.
    const c3 = await seedScopedGraphWithHeartbeat();
    await seedResourceWorkspaceOperation(db, { companyId: foreign.companyId, heartbeatRunId: c3.hb, phase: "build" });
    expectScopeMismatch(
      await captureHttpError(readResourceHistoryReadonly(db, readModelScope(c3.graph, c3.scopeStep))),
      "workspace_operation_company_mismatch",
    );

    // [4] workspace runtime service: 외부 회사 행이 startedByRunId 로 우리 heartbeat 참조 — 거부.
    const c4 = await seedScopedGraphWithHeartbeat();
    await seedResourceRuntimeService(db, {
      companyId: foreign.companyId, startedByRunId: c4.hb, scopeType: "run", scopeId: c4.hb,
    });
    expectScopeMismatch(
      await captureHttpError(readResourceHistoryReadonly(db, readModelScope(c4.graph, c4.scopeStep))),
      "workspace_service_company_mismatch",
    );

    // [5] mission runtime: heartbeat 없이 missionId 만으로 붙은 외부 회사 행 — 거부.
    const c5 = await seedReadModelGraph(fixture.sql, db);
    await seedCompleteStepRuns(db, c5);
    await seedResourceMissionRuntime(db, {
      companyId: foreign.companyId, missionId: c5.missionId, agentId: foreign.agentId,
    });
    expectScopeMismatch(
      await captureHttpError(readResourceHistoryReadonly(db, readModelScope(c5))),
      "mission_runtime_company_mismatch",
    );
  }, 60_000);

  it("validates independently valid stage FKs: heartbeat-scoped stage with out-of-scope parent -> parent_unproven; parent-scoped stage with other heartbeat -> run_mismatch; matching parent works", async () => {
    const seeded = await seedScopedGraphWithHeartbeat();
    const foreign = await seedForeignReadModelGraph(fixture.sql, db);
    // parent 가 선택되지 않는 외부 heartbeat + 그 위의 외부 finalization(FK 는 전부 유효).
    const foreignHb = await seedReadModelHeartbeat(db, {
      companyId: foreign.companyId, agentId: foreign.agentId, workflowStepRunId: foreign.stepRunId,
    });
    const outOfScopeFin = await seedResourceFinalization(db, {
      companyId: foreign.companyId, heartbeatRunId: foreignHb,
    });

    // [case 1] stage 의 scope 면은 우리 heartbeat, parent FK 는 scope 밖 finalization —
    //   heartbeat 술어로 조회되고 parent 가 선택 집합에 없으므로 parent_unproven.
    await seedResourceFinalizationStep(db, {
      companyId: seeded.graph.companyId, heartbeatRunId: seeded.hb,
      heartbeatRunFinalizationId: outOfScopeFin, stageKind: "ledger", idempotencyKey: "orphan-parent",
    });
    const unproven = await captureHttpError(
      readResourceHistoryReadonly(db, readModelScope(seeded.graph, seeded.scopeStep)),
    );
    expect(unproven.status).toBe(422);
    expect(unproven.message).toBe("resume_history_unproven");
    expect((unproven.details as { reason: string }).reason).toBe("finalization_parent_unproven");

    // [case 2] stage 의 scope 면은 parent(우리 finalization), heartbeat FK 는 다른 heartbeat —
    //   parent 술어로만 조회되고(critical OR path) parent.heartbeatRunId 와 모순 -> run_mismatch.
    await cleanupResourceTables(db);
    const seeded2 = await seedScopedGraphWithHeartbeat();
    const otherSameCompanyHb = await seedReadModelHeartbeat(db, {
      companyId: seeded2.graph.companyId, agentId: seeded2.graph.agentId,
    });
    await seedResourceFinalizationStep(db, {
      companyId: seeded2.graph.companyId, heartbeatRunId: otherSameCompanyHb,
      heartbeatRunFinalizationId: seeded2.fin!, stageKind: "ledger", idempotencyKey: "contradictory-run",
    });
    const mismatch = await captureHttpError(
      readResourceHistoryReadonly(db, readModelScope(seeded2.graph, seeded2.scopeStep)),
    );
    expect(mismatch.status).toBe(422);
    expect(mismatch.message).toBe("resume_history_unproven");
    expect((mismatch.details as { reason: string }).reason).toBe("finalization_run_mismatch");

    // [case 3] parent 와 heartbeat 가 일치하는 정상 stage — 수집된다(정책 거절 아님).
    //   case 2 의 모순 stage 가 남아 있으면 같은 reject 가 재발하므로 새 그래프에서 증명한다.
    await cleanupResourceTables(db);
    const seeded3 = await seedScopedGraphWithHeartbeat();
    const validStage = await seedResourceFinalizationStep(db, {
      companyId: seeded3.graph.companyId, heartbeatRunId: seeded3.hb,
      heartbeatRunFinalizationId: seeded3.fin!, stageKind: "ledger", idempotencyKey: "valid-stage",
    });
    const ok = await readResourceHistoryReadonly(db, readModelScope(seeded3.graph, seeded3.scopeStep));
    expect(ok.finalizationSteps.map((row) => row.id)).toEqual([validStage]);
  }, 60_000);

  it("representative error path is read-only: scope_mismatch inside repeatable-read readonly tx leaves canonical old-history + FIVE resource tables unchanged", async () => {
    const seeded = await seedScopedGraphWithHeartbeat();
    const foreign = await seedForeignReadModelGraph(fixture.sql, db);
    await seedResourceFinalizationStep(db, {
      companyId: foreign.companyId, heartbeatRunId: seeded.hb, heartbeatRunFinalizationId: seeded.fin!,
      stageKind: "ledger", idempotencyKey: "contaminated",
    });
    const before = { ...await canonicalHistoryRows(db, seeded.graph.runId), ...await canonicalResourceRows(db) };

    // 기대한 HttpError 를 readonly 트랜잭션 바깥에서 captureHttpError 로 포착한다 — rollback 용
    //   throw + .catch(()=>{}) 로 무관한 실패를 삼키는 대신, 실제 reject 원인을 그대로 단언한다.
    const error = await captureHttpError(
      readResourceHistoryReadonly(db, readModelScope(seeded.graph, seeded.scopeStep)),
    );
    expect(error.status).toBe(422);
    expect(error.message).toBe("scope_mismatch");
    expect((error.details as { reason: string }).reason).toBe("finalization_step_company_mismatch");
    const after = { ...await canonicalHistoryRows(db, seeded.graph.runId), ...await canonicalResourceRows(db) };
    expect(after).toEqual(before); // reject 경로에서도 DB 무변화
  }, 30_000);
});

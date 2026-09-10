import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { createDb, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import type { HttpError } from "../errors.js";
import { readResumeExecutionHistory } from "../services/workflow/resume/read-model.js";
import {
  captureHttpError, cleanupReadModelTables, corruptSnapshotSteps, readModelScope, readSnapshotRow,
  seedAdditionalMission, seedCompanyWithMission, seedForeignReadModelGraph, seedReadModelDelegation,
  seedReadModelGraph, seedReadModelHeartbeat, seedReadModelIssue, seedReadModelStepRun,
  seedReadModelWakeup, seedWorkflowDefinition, seedWorkflowRun, startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture, type ReadModelGraph,
} from "./helpers/workflow-resume-read-model-fixture.js";

/**
 * [purpose] Task5c2a read-model scope/validation rejections — schema gating before any query,
 *   mission/run/start resolution, snapshot fail-closed (no repair/backfill), exact step-set
 *   equality, dangling FK-free pointers, foreign contamination rejected (not omitted), raw
 *   history breadth, delegation scoped-side validation, ordering, empty-set SQL safety.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEP("readResumeExecutionHistory — scope and validation rejections", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("resume-read-model-scope-");
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

  /** frozen 정의의 모든 step id 에 1:1 step run 행을 시딩하고 행 id 들을 돌려준다. */
  async function seedCompleteSteps(graph: ReadModelGraph, firstIssueId?: string): Promise<string[]> {
    const rowIds: string[] = [];
    for (const [index, stepId] of graph.definitionStepIds.entries()) {
      rowIds.push(await seedReadModelStepRun(db, {
        runId: graph.runId, stepId, ...(index === 0 && firstIssueId ? { issueId: firstIssueId } : {}),
      }));
    }
    return rowIds;
  }

  async function rejectsWith(scope: Record<string, unknown>, message: string): Promise<HttpError> {
    const error = await captureHttpError(readResumeExecutionHistory(db, scope as never));
    expect(error.message).toBe(message);
    return error;
  }

  function expectUnproven(error: HttpError, reason: string): void {
    expect(error.status).toBe(422);
    expect(error.message).toBe("resume_history_unproven");
    expect((error.details as { reason: string }).reason).toBe(reason);
  }

  it("rejects invalid scope before any db.select (hostile select surface proves no prequery)", async () => {
    const hostileDb = {
      select: () => {
        throw new Error("db must not be queried before scope validation");
      },
    } as unknown as Pick<Db, "select">;
    const base = {
      companyId: randomUUID(), missionId: randomUUID(), workflowRunId: randomUUID(), startStepId: "resume-step-a",
    };
    await expect(readResumeExecutionHistory(hostileDb, { ...base, companyId: "not-a-uuid" }))
      .rejects.toBeInstanceOf(ZodError);
    await expect(readResumeExecutionHistory(hostileDb, { ...base, extra: "key" } as never))
      .rejects.toBeInstanceOf(ZodError);
    const missingStep = { companyId: base.companyId, missionId: base.missionId, workflowRunId: base.workflowRunId };
    await expect(readResumeExecutionHistory(hostileDb, missingStep as never)).rejects.toBeInstanceOf(ZodError);
  });

  it("rejects missing/foreign mission, missing/wrong-company/wrong-mission run, and unknown start step", async () => {
    const graph = await seedReadModelGraph(fixture.sql, db);
    const foreign = await seedForeignReadModelGraph(fixture.sql, db);
    const secondMission = await seedAdditionalMission(fixture.sql, graph.companyId, graph.agentId);
    const startStepId = graph.definitionStepIds[0]!;

    await rejectsWith({ ...readModelScope(graph), missionId: randomUUID() }, "Mission not found");
    await rejectsWith({
      companyId: foreign.companyId, missionId: graph.missionId, workflowRunId: graph.runId, startStepId,
    }, "Mission not found");
    await rejectsWith({ ...readModelScope(graph), workflowRunId: randomUUID() }, "Workflow run not found");
    await rejectsWith({
      companyId: foreign.companyId, missionId: foreign.missionId, workflowRunId: graph.runId, startStepId,
    }, "Workflow run not found");
    await rejectsWith({
      companyId: graph.companyId, missionId: secondMission, workflowRunId: graph.runId, startStepId,
    }, "Workflow run not found");
    await rejectsWith({ ...readModelScope(graph), startStepId: "ghost-step" }, "Workflow step not found");
  });

  it("rejects missing historical snapshot and corrupt snapshot; performs no repair/backfill", async () => {
    const { companyId, agentId, missionId } = await seedCompanyWithMission(
      fixture.sql,
      "RMNS" + randomUUID().slice(0, 8),
    );
    const workflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId,
      stepsJson: [{ id: "s", name: "S", agentId: "", dependencies: [] }],
    });
    const runId = await seedWorkflowRun(fixture.sql, { workflowId, companyId, missionId });
    const missing = await rejectsWith({ companyId, missionId, workflowRunId: runId, startStepId: "s" }, "historical_definition_unproven");
    expect(missing.status).toBe(422);
    expect(await readSnapshotRow(fixture.sql, runId)).toBeNull(); // reject 후 snapshot backfill 없음

    const graph = await seedReadModelGraph(fixture.sql, db);
    await corruptSnapshotSteps(fixture.sql, graph.runId);
    const corrupt = await rejectsWith(readModelScope(graph), "historical_definition_unproven");
    expect(corrupt.status).toBe(422);
    // 수리/backfill 없음 — corrupt snapshot 행이 그대로 남는다.
    const row = await readSnapshotRow(fixture.sql, graph.runId);
    expect((row!.steps as Array<{ id: string }>)[0]!.id).toBe("tampered");
  });

  it("rejects missing/extra step rows — exact step-id set comparison, not array position", async () => {
    const missing = await seedReadModelGraph(fixture.sql, db);
    await seedReadModelStepRun(db, { runId: missing.runId, stepId: missing.definitionStepIds[0]! });
    expectUnproven(await rejectsWith(readModelScope(missing), "resume_history_unproven"), "step_set_mismatch");

    const extra = await seedReadModelGraph(fixture.sql, db);
    await seedCompleteSteps(extra);
    await seedReadModelStepRun(db, { runId: extra.runId, stepId: "resume-step-extra" });
    expectUnproven(await rejectsWith(readModelScope(extra), "resume_history_unproven"), "step_set_mismatch");

    // Duplicate step IDs in this SELECT are structurally unreachable:
    // workflow_step_runs_run_step_uq enforces (workflow_run_id, step_id), and
    // readResumeExecutionHistory selects only workflowRunId = run.id. A same-step
    // row in a second run is excluded, not a duplicate candidate. The production
    // defensive check remains; missing/extra cases above cover step_set_mismatch.
  });

  it("rejects dangling FK-free owner pointers and foreign-company linked rows instead of omitting them", async () => {
    const missingOwner = await seedReadModelGraph(fixture.sql, db);
    await seedReadModelStepRun(db, {
      runId: missingOwner.runId, stepId: missingOwner.definitionStepIds[0]!,
      dispatchOwnerWakeupRequestId: randomUUID(),
    });
    await seedReadModelStepRun(db, { runId: missingOwner.runId, stepId: missingOwner.definitionStepIds[1]! });
    expectUnproven(await rejectsWith(readModelScope(missingOwner), "resume_history_unproven"), "missing_wakeup_owner");

    const missingHeartbeat = await seedReadModelGraph(fixture.sql, db);
    await seedReadModelStepRun(db, {
      runId: missingHeartbeat.runId, stepId: missingHeartbeat.definitionStepIds[0]!,
      dispatchOwnerHeartbeatRunId: randomUUID(),
    });
    await seedReadModelStepRun(db, { runId: missingHeartbeat.runId, stepId: missingHeartbeat.definitionStepIds[1]! });
    expectUnproven(await rejectsWith(readModelScope(missingHeartbeat), "resume_history_unproven"), "missing_heartbeat_owner");

    // 타회사 issue 로 step 연결(FK 허용) — id-IN 경로로 반환되어 scope_mismatch(누락 아님).
    const foreign = await seedForeignReadModelGraph(fixture.sql, db);
    const foreignIssue = await seedReadModelGraph(fixture.sql, db);
    await seedCompleteSteps(foreignIssue, foreign.issueId);
    await rejectsWith(readModelScope(foreignIssue), "scope_mismatch");

    // 타회사 wakeup 이 우리 missionId 참조 — company 필터로 숨기지 않고 거부.
    const foreignWakeup = await seedReadModelGraph(fixture.sql, db);
    await seedCompleteSteps(foreignWakeup);
    await seedReadModelWakeup(db, {
      companyId: foreign.companyId, agentId: foreign.agentId, missionId: foreignWakeup.missionId,
    });
    await rejectsWith(readModelScope(foreignWakeup), "scope_mismatch");

    // 타회사 heartbeat 가 우리 step run 참조 — 거부.
    const foreignHeartbeat = await seedReadModelGraph(fixture.sql, db);
    const [linkedStepRunId] = await seedCompleteSteps(foreignHeartbeat);
    await seedReadModelHeartbeat(db, {
      companyId: foreign.companyId, agentId: foreign.agentId, workflowStepRunId: linkedStepRunId,
    });
    await rejectsWith(readModelScope(foreignHeartbeat), "scope_mismatch");

    // 같은 회사 다른 mission issue 를 step 이 참조 — scope_mismatch(null missionId 만 허용).
    const otherMission = await seedReadModelGraph(fixture.sql, db);
    const secondMission = await seedAdditionalMission(fixture.sql, otherMission.companyId, otherMission.agentId);
    const otherMissionIssue = await seedReadModelIssue(db, { companyId: otherMission.companyId, missionId: secondMission });
    await seedCompleteSteps(otherMission, otherMissionIssue);
    await rejectsWith(readModelScope(otherMission), "scope_mismatch");
  }, 30_000);

  it("preserves mission-only wakeup, owner-ID-only wakeup/heartbeat, issue-linked/prior-generation/unknown-status heartbeats; excludes unlinked foreign rows", async () => {
    const graph = await seedReadModelGraph(fixture.sql, db);
    const [stepA] = graph.definitionStepIds;
    const ownerWakeupId = await seedReadModelWakeup(db, { id: randomUUID(), companyId: graph.companyId, agentId: graph.agentId });
    const ownerHeartbeatId = await seedReadModelHeartbeat(db, { id: randomUUID(), companyId: graph.companyId, agentId: graph.agentId });
    const issueA = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    const stepARunId = await seedReadModelStepRun(db, {
      runId: graph.runId,
      stepId: stepA!,
      issueId: issueA,
      executionGeneration: 2,
      dispatchOwnerWakeupRequestId: ownerWakeupId,
      dispatchOwnerHeartbeatRunId: ownerHeartbeatId,
    });
    await seedReadModelStepRun(db, { runId: graph.runId, stepId: graph.definitionStepIds[1]! });
    const missionWakeupId = await seedReadModelWakeup(db, {
      companyId: graph.companyId, agentId: graph.agentId, missionId: graph.missionId,
    });
    const priorHeartbeatId = await seedReadModelHeartbeat(db, {
      companyId: graph.companyId, agentId: graph.agentId,
      workflowStepRunId: stepARunId, workflowExecutionGeneration: 1,
    });
    const unknownHeartbeatId = await seedReadModelHeartbeat(db, {
      companyId: graph.companyId, agentId: graph.agentId,
      workflowStepRunId: stepARunId, status: "mystery_unknown_status", workflowExecutionGeneration: 9,
    });
    const foreign = await seedForeignReadModelGraph(fixture.sql, db);
    const foreignWakeupId = await seedReadModelWakeup(db, {
      companyId: foreign.companyId, agentId: foreign.agentId, missionId: foreign.missionId,
    });
    const foreignHeartbeatId = await seedReadModelHeartbeat(db, { companyId: foreign.companyId, agentId: foreign.agentId });

    const result = await readResumeExecutionHistory(db, readModelScope(graph, stepA!));
    expect(result.wakeups.map((row) => row.id).sort()).toEqual([ownerWakeupId, missionWakeupId].sort());
    expect(result.wakeups.map((row) => row.id)).not.toContain(foreignWakeupId);
    expect(result.heartbeats.map((row) => row.id).sort())
      .toEqual([ownerHeartbeatId, priorHeartbeatId, unknownHeartbeatId].sort());
    expect(result.heartbeats.map((row) => row.id)).not.toContain(foreignHeartbeatId);
    // status/executionGeneration 필터 없음 — 이전 generation 과 미지 status 도 raw 보존.
    expect(result.heartbeats.find((row) => row.id === priorHeartbeatId)?.workflowExecutionGeneration).toBe(1);
    expect(result.heartbeats.find((row) => row.id === unknownHeartbeatId)?.status).toBe("mystery_unknown_status");
  }, 30_000);

  it("preserves outgoing/incoming delegations with remote counterpart; rejects scoped-side company mismatch", async () => {
    const graph = await seedReadModelGraph(fixture.sql, db);
    const foreign = await seedForeignReadModelGraph(fixture.sql, db);
    const [stepA, stepB] = graph.definitionStepIds;
    const issueB = await seedReadModelIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    const stepBRunId = await seedReadModelStepRun(db, { runId: graph.runId, stepId: stepB!, issueId: issueB });
    await seedReadModelStepRun(db, { runId: graph.runId, stepId: stepA! });
    const outgoingId = await seedReadModelDelegation(db, {
      sourceCompanyId: graph.companyId, sourceWorkflowRunId: graph.runId,
      sourceWorkflowStepRunId: stepBRunId, sourceIssueId: issueB,
      targetCompanyId: foreign.companyId, targetIssueId: foreign.issueId,
    });
    const incomingId = await seedReadModelDelegation(db, {
      sourceCompanyId: foreign.companyId, sourceWorkflowRunId: foreign.runId,
      sourceWorkflowStepRunId: foreign.stepRunId, sourceIssueId: foreign.issueId,
      targetCompanyId: graph.companyId, targetIssueId: issueB,
    });

    const result = await readResumeExecutionHistory(db, readModelScope(graph, stepB!));
    expect(result.delegations.map((row) => row.id).sort()).toEqual([outgoingId, incomingId].sort());
    expect(result.delegations.find((row) => row.id === outgoingId)?.targetCompanyId).toBe(foreign.companyId);
    expect(result.delegations.find((row) => row.id === incomingId)?.sourceCompanyId).toBe(foreign.companyId);

    // source-side 오염: 우리 run/step 인데 sourceCompanyId 가 타회사.
    await cleanupReadModelTables(db);
    const mismatch = await seedReadModelGraph(fixture.sql, db);
    const foreign2 = await seedForeignReadModelGraph(fixture.sql, db);
    const [mismatchStepRunId] = await seedCompleteSteps(mismatch);
    await seedReadModelDelegation(db, {
      sourceCompanyId: foreign2.companyId, sourceWorkflowRunId: mismatch.runId,
      sourceWorkflowStepRunId: mismatchStepRunId, targetCompanyId: foreign2.companyId,
      targetIssueId: foreign2.issueId,
    });
    await rejectsWith(readModelScope(mismatch), "scope_mismatch");

    // target-side 오염: 우리 issue 인데 targetCompanyId 가 타회사.
    const targetMismatch = await seedReadModelGraph(fixture.sql, db);
    const foreign3 = await seedForeignReadModelGraph(fixture.sql, db);
    const ourIssue = await seedReadModelIssue(db, { companyId: targetMismatch.companyId, missionId: targetMismatch.missionId });
    await seedCompleteSteps(targetMismatch);
    await seedReadModelDelegation(db, {
      sourceCompanyId: foreign3.companyId, sourceWorkflowRunId: foreign3.runId,
      sourceWorkflowStepRunId: foreign3.stepRunId, targetCompanyId: foreign3.companyId,
      targetIssueId: ourIssue,
    });
    await rejectsWith(readModelScope(targetMismatch), "scope_mismatch");
  }, 30_000);

  it("returns deterministic id ordering and empty association sets without invalid SQL", async () => {
    const graph = await seedReadModelGraph(fixture.sql, db);
    await seedReadModelStepRun(db, { runId: graph.runId, stepId: graph.definitionStepIds[1]! });
    await seedReadModelStepRun(db, { runId: graph.runId, stepId: graph.definitionStepIds[0]! });

    const result = await readResumeExecutionHistory(db, readModelScope(graph));
    expect(result.steps.map((row) => row.id)).toEqual([...result.steps.map((row) => row.id)].sort());
    // issue/wakeup/heartbeat/delegation 연관 전부 빈 집합 — inArray([]) 없이 빈 배열 반환.
    expect(result.issues).toEqual([]);
    expect(result.wakeups).toEqual([]);
    expect(result.heartbeats).toEqual([]);
    expect(result.delegations).toEqual([]);
    expect(result.mission.id).toBe(graph.missionId);
    expect(result.run.id).toBe(graph.runId);
  });
});

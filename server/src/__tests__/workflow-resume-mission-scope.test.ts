import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { createDb, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import type { HttpError } from "../errors.js";
import {
  canonicalMissionDomain,
  captureHttpError,
  cleanupResourceTables,
  readMissionHistoryReadonly,
  readModelScope,
  readSnapshotRow,
  seedAdditionalMission,
  seedForeignReadModelGraph,
  seedMissionSiblingRun,
  seedReadModelGraph,
  seedReadModelHeartbeat,
  seedReadModelIssue,
  seedReadModelStepRun,
  seedReadModelWakeup,
  seedWorkflowDefinition,
  seedWorkflowRun,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-resume-mission-fixture.js";

/**
 * [purpose] Task5c3c scope/validation rejections through public readResumeMissionHistory —
 *   모든 호출은 readMissionHistoryReadonly wrapper 안의 실제 repeatable-read read-only 트랜잭션
 *   (mocked read surface 없음). malformed scope 입력은 그 트랜잭션 경로에서 ZodError 로 거부되고
 *   도메인 무변화(reader source 의 pre-query 순서는 source 리뷰에서 검증 — 이 테스트가 호출 순서를
 *   기계적으로 증명하지는 않음): selected-reader validation unchanged (no legacy backfill), foreign-company mission-run
 *   contamination rejected before sibling history reads, foreign-company sibling step-linked
 *   issue/wakeup/heartbeat rejected per independent path, dangling sibling dispatch owners
 *   and replication-drift missing issue rejected, whole-domain canonical unchanged on every
 *   rejection. Real embedded Postgres, no mocks, no skipped suites.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEP("readResumeMissionHistory — scope and validation rejections", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("resume-mission-scope-");
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
    for (const stepId of graph.definitionStepIds) {
      await seedReadModelStepRun(db, { runId: graph.runId, stepId });
    }
    return graph;
  }

  function expectReason(error: HttpError, message: string, reason: string): void {
    expect(error.status).toBe(422);
    expect(error.message).toBe(message);
    expect((error.details as { reason: string }).reason).toBe(reason);
  }

  it("rejects malformed scope input through the actual readonly transaction without any domain mutation", async () => {
    const graph = await seedSelectedGraph();
    const before = await canonicalMissionDomain(db); // 거부 경로 무변화 기준점
    const scope = readModelScope(graph);
    await expect(
      readMissionHistoryReadonly(db, { ...scope, companyId: "not-a-uuid" } as never),
    ).rejects.toBeInstanceOf(ZodError);
    expect(await canonicalMissionDomain(db)).toEqual(before); // non-UUID companyId 거부 무변화
    await expect(
      readMissionHistoryReadonly(db, { ...scope, extra: "key" } as never),
    ).rejects.toBeInstanceOf(ZodError);
    expect(await canonicalMissionDomain(db)).toEqual(before); // 과잉 키 거부 무변화
    const missingStart = {
      companyId: scope.companyId, missionId: scope.missionId, workflowRunId: scope.workflowRunId,
    };
    await expect(readMissionHistoryReadonly(db, missingStart as never)).rejects.toBeInstanceOf(ZodError);
    expect(await canonicalMissionDomain(db)).toEqual(before); // startStepId 누락 거부 무변화
  }, 30_000);

  it("keeps selected-reader validation unchanged: foreign/missing mission, missing snapshot without backfill, ghost start step, step-set mismatch", async () => {
    const graph = await seedSelectedGraph();
    const foreign = await seedForeignReadModelGraph(fixture.sql, db);
    const startStepId = graph.definitionStepIds[0]!;
    const rawSiblingRun = await seedWorkflowRun(fixture.sql, {
      workflowId: graph.workflowId, companyId: graph.companyId, missionId: graph.missionId, status: "pending",
    });

    // selected step set 이 정의와 1:1 이 아니면 기존 step_set_mismatch 그대로 — 첫 거부 전에 전부 시딩.
    const incomplete = await seedReadModelGraph(fixture.sql, db);
    await seedReadModelStepRun(db, { runId: incomplete.runId, stepId: incomplete.definitionStepIds[0]! });

    const before = await canonicalMissionDomain(db); // 모든 seeding 이 끝난 뒤 단일 무변화 기준점

    const error = await captureHttpError(readMissionHistoryReadonly(db, {
      companyId: graph.companyId, missionId: randomUUID(), workflowRunId: graph.runId, startStepId,
    }));
    expect(error.message).toBe("Mission not found");
    expect(await canonicalMissionDomain(db)).toEqual(before); // missing-mission 거부 경로 무변화
    const foreignMission = await captureHttpError(readMissionHistoryReadonly(db, {
      companyId: foreign.companyId, missionId: graph.missionId, workflowRunId: graph.runId, startStepId,
    }));
    expect(foreignMission.message).toBe("Mission not found");
    expect(await canonicalMissionDomain(db)).toEqual(before); // foreign-mission 거부 경로 무변화
    // snapshot 없는 raw sibling run 을 selected 로 — historical fail-closed, backfill 없음.
    const missingSnapshot = await captureHttpError(readMissionHistoryReadonly(db, {
      companyId: graph.companyId, missionId: graph.missionId, workflowRunId: rawSiblingRun, startStepId,
    }));
    expect(missingSnapshot.message).toBe("historical_definition_unproven");
    expect(await canonicalMissionDomain(db)).toEqual(before); // missing-snapshot 거부 경로 무변화
    expect(await readSnapshotRow(fixture.sql, rawSiblingRun)).toBeNull(); // reject 후 snapshot backfill 없음
    const ghostStep = await captureHttpError(readMissionHistoryReadonly(db, {
      ...readModelScope(graph), startStepId: "ghost-step",
    }));
    expect(ghostStep.message).toBe("Workflow step not found");
    expect(await canonicalMissionDomain(db)).toEqual(before); // ghost-start-step 거부 경로 무변화
    const mismatch = await captureHttpError(readMissionHistoryReadonly(db, readModelScope(incomplete)));
    expectReason(mismatch, "resume_history_unproven", "step_set_mismatch");
    expect(await canonicalMissionDomain(db)).toEqual(before); // step-set-mismatch 거부 경로 무변화
  }, 30_000);

  it("rejects a foreign-company run carrying the selected missionId with mission_run_company_mismatch before any sibling history read", async () => {
    const graph = await seedSelectedGraph();
    const foreign = await seedForeignReadModelGraph(fixture.sql, db);
    // FK 독립 유효 insert: 타회사 company + 타회사 workflow definition 이지만 mission_id 는 selected mission.
    const foreignWorkflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId: foreign.companyId, name: "contam-" + randomUUID().slice(0, 8), stepsJson: [],
    });
    const contaminatedRun = await seedWorkflowRun(fixture.sql, {
      workflowId: foreignWorkflowId, companyId: foreign.companyId, missionId: graph.missionId, status: "pending",
    });
    // ordering 증명: 유효 형제 step 을 타회사 heartbeat 가 참조 — sibling read 가 먼저면 이 reason 이 나온다.
    const validSibling = await seedMissionSiblingRun(fixture.sql, { companyId: graph.companyId, missionId: graph.missionId, status: "running" });
    const siblingStep = await seedReadModelStepRun(db, { runId: validSibling, stepId: "sib-order-step" });
    await seedReadModelHeartbeat(db, { companyId: foreign.companyId, agentId: foreign.agentId, workflowStepRunId: siblingStep });

    const before = await canonicalMissionDomain(db);
    const error = await captureHttpError(readMissionHistoryReadonly(db, readModelScope(graph)));
    expectReason(error, "scope_mismatch", "mission_run_company_mismatch");
    const after = await canonicalMissionDomain(db);
    expect(after).toEqual(before);
    expect(after.runs.some((row) => row.id === contaminatedRun)).toBe(true); // 오염 row 도 제거되지 않는다
  }, 30_000);

  it("rejects foreign-company sibling step-linked issue/wakeup/heartbeat each through its own existing scope error; same-company different-mission step issue rejects mission error", async () => {
    // path 1: 형제 step 이 타회사 issue 참조(FK 유효 — row 존재).
    const issueGraph = await seedSelectedGraph();
    const foreignIssue = await seedForeignReadModelGraph(fixture.sql, db);
    const issueSibling = await seedMissionSiblingRun(fixture.sql, { companyId: issueGraph.companyId, missionId: issueGraph.missionId });
    await seedReadModelStepRun(db, { runId: issueSibling, stepId: "sib-foreign-issue", issueId: foreignIssue.issueId });
    // path 2: 타회사 wakeup 이 형제 step 참조(wakeup queue 컬럼은 FK-free).
    const wakeupGraph = await seedSelectedGraph();
    const foreignWakeup = await seedForeignReadModelGraph(fixture.sql, db);
    const wakeupSibling = await seedMissionSiblingRun(fixture.sql, { companyId: wakeupGraph.companyId, missionId: wakeupGraph.missionId });
    const wakeupSiblingStep = await seedReadModelStepRun(db, { runId: wakeupSibling, stepId: "sib-foreign-wakeup" });
    await seedReadModelWakeup(db, { companyId: foreignWakeup.companyId, agentId: foreignWakeup.agentId, workflowStepRunId: wakeupSiblingStep });
    // path 3: 타회사 heartbeat 가 형제 step 참조.
    const heartbeatGraph = await seedSelectedGraph();
    const foreignHeartbeat = await seedForeignReadModelGraph(fixture.sql, db);
    const heartbeatSibling = await seedMissionSiblingRun(fixture.sql, { companyId: heartbeatGraph.companyId, missionId: heartbeatGraph.missionId });
    const heartbeatSiblingStep = await seedReadModelStepRun(db, { runId: heartbeatSibling, stepId: "sib-foreign-heartbeat" });
    await seedReadModelHeartbeat(db, { companyId: foreignHeartbeat.companyId, agentId: foreignHeartbeat.agentId, workflowStepRunId: heartbeatSiblingStep });
    // path 4: 같은 회사 다른 mission issue 를 형제 step 이 참조.
    const missionGraph = await seedSelectedGraph();
    const otherMission = await seedAdditionalMission(fixture.sql, missionGraph.companyId, missionGraph.agentId);
    const otherMissionIssue = await seedReadModelIssue(db, { companyId: missionGraph.companyId, missionId: otherMission });
    const missionSibling = await seedMissionSiblingRun(fixture.sql, { companyId: missionGraph.companyId, missionId: missionGraph.missionId });
    await seedReadModelStepRun(db, { runId: missionSibling, stepId: "sib-other-mission", issueId: otherMissionIssue });

    const before = await canonicalMissionDomain(db);
    expectReason(
      await captureHttpError(readMissionHistoryReadonly(db, readModelScope(issueGraph))),
      "scope_mismatch", "issue_company_mismatch",
    );
    expectReason(
      await captureHttpError(readMissionHistoryReadonly(db, readModelScope(wakeupGraph))),
      "scope_mismatch", "wakeup_company_mismatch",
    );
    expectReason(
      await captureHttpError(readMissionHistoryReadonly(db, readModelScope(heartbeatGraph))),
      "scope_mismatch", "heartbeat_company_mismatch",
    );
    expectReason(
      await captureHttpError(readMissionHistoryReadonly(db, readModelScope(missionGraph))),
      "scope_mismatch", "issue_mission_mismatch",
    );
    expect(await canonicalMissionDomain(db)).toEqual(before); // 오염 거부 경로 전체 무변화
  }, 30_000);

  it("rejects dangling sibling dispatch owners despite terminal run status, and a replication-drift missing referenced issue", async () => {
    // path 1: completed(terminal) 형제 run 의 step 이 없는 wakeup owner 를 당한다 — 무시되지 않는다.
    const wakeupGraph = await seedSelectedGraph();
    const completedSibling = await seedMissionSiblingRun(fixture.sql, { companyId: wakeupGraph.companyId, missionId: wakeupGraph.missionId, status: "completed" });
    await seedReadModelStepRun(db, { runId: completedSibling, stepId: "sib-dangle-a", dispatchOwnerWakeupRequestId: randomUUID() });
    // path 2: cancelled 형제 run 의 step 이 없는 heartbeat owner 를 당한다.
    const heartbeatGraph = await seedSelectedGraph();
    const cancelledSibling = await seedMissionSiblingRun(fixture.sql, { companyId: heartbeatGraph.companyId, missionId: heartbeatGraph.missionId, status: "cancelled" });
    await seedReadModelStepRun(db, { runId: cancelledSibling, stepId: "sib-dangle-b", dispatchOwnerHeartbeatRunId: randomUUID() });
    // path 3: replication/legacy drift — FK 제약을 우회해 존재하지 않는 issue 를 참조하는 형제 step.
    //   (임베디드 test DB 안에서의 시딩 기법일 뿐, reader 는 실제 DB rows 만 읽는다.)
    const issueGraph = await seedSelectedGraph();
    const failedSibling = await seedMissionSiblingRun(fixture.sql, { companyId: issueGraph.companyId, missionId: issueGraph.missionId, status: "failed" });
    await fixture.sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`INSERT INTO workflow_step_runs (workflow_run_id, step_id, issue_id, status, metadata)
        VALUES (${failedSibling}, 'sib-drift-step', ${randomUUID()}, 'pending', '{}'::jsonb)`;
    });

    const before = await canonicalMissionDomain(db);
    expectReason(
      await captureHttpError(readMissionHistoryReadonly(db, readModelScope(wakeupGraph))),
      "resume_history_unproven", "missing_wakeup_owner",
    );
    expectReason(
      await captureHttpError(readMissionHistoryReadonly(db, readModelScope(heartbeatGraph))),
      "resume_history_unproven", "missing_heartbeat_owner",
    );
    expectReason(
      await captureHttpError(readMissionHistoryReadonly(db, readModelScope(issueGraph))),
      "resume_history_unproven", "missing_issue",
    );
    expect(await canonicalMissionDomain(db)).toEqual(before); // missing-reference 거부 경로 무변화
  }, 30_000);
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import {
  countFenceTransitionEvents,
  countFenceWorkProducts,
  loadFenceActivityLog,
  loadFenceIssue,
  loadFenceStepRun,
  seedFenceGraph,
  seedFenceHeartbeatRun,
  seedFenceIssue,
  seedFenceStepRun,
  seedFenceWakeup,
  setFenceRunMetadata,
  startFenceFixture,
  type FenceFixture,
} from "./helpers/workflow-resume-stale-fences-fixture.js";
import { completeLinkedWorkflowStepRunsForIssue } from "../services/workflow/issue-step-closeout.js";
import {
  recordResumeStaleResultRejected,
  resolveHeartbeatResumeScopeFence,
} from "../services/workflow/resume-scope-fence.js";

/**
 * [목적] Task6c stale-generation result fence (실DB) — contract C(heartbeat settlement fence +
 *   linked step closeout fence). acting heartbeat run 의 기록 링크(generation/stamp)가 현재 행과
 *   정확히 일치할 때만 settlement mutation 이 진행된다. 진단 activity log 는 표시/감사 전용이며
 *   실행 권위로 파싱되지 않는다(AGENTS.md 규칙 8). mock DB/엔진 없음.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let fixture: FenceFixture;
let db: Db;

beforeAll(async () => {
  fixture = await startFenceFixture("resume-stale-fences-settle-");
  if (!fixture.supported) throw new Error(fixture.reason);
  db = fixture.db;
}, 60_000);
afterAll(async () => {
  if (fixture?.supported) await fixture.cleanup();
});

describeEmbeddedPostgres("task6c stale fences — heartbeat settlement (contract C)", () => {
  it("rejects a settled heartbeat whose recorded generation is stale: diagnostic logged once, no mutation", async () => {
    const resumeStamp = randomUUID();
    const graph = await seedFenceGraph(db, "FENCE-C1", { runMetadata: { resumeRequestId: resumeStamp } });
    const issueId = await seedFenceIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    const stepRun = await seedFenceStepRun(db, {
      runId: graph.runId,
      values: {
        status: "running",
        startedAt: new Date("2026-09-09T02:00:00.000Z"),
        issueId,
        executionGeneration: 2,
        statusTransitionVersion: 2,
        metadata: { resumeRequestId: resumeStamp },
      },
    });
    // acting heartbeat run 은 이전 세대(1)를 알고 있었다 — 그 사이 resume 가 2 로 bump 했다.
    const wakeup = await seedFenceWakeup(db, {
      companyId: graph.companyId,
      agentId: graph.agentId,
      issueId,
      missionId: graph.missionId,
      workflowRunId: graph.runId,
      workflowStepRunId: stepRun.id,
      workflowExecutionGeneration: 1,
    });
    const heartbeatRun = await seedFenceHeartbeatRun(db, {
      companyId: graph.companyId,
      agentId: graph.agentId,
      issueId,
      workflowStepRunId: stepRun.id,
      workflowExecutionGeneration: 1,
      wakeupRequestId: wakeup.id,
      contextSnapshot: { workflowRunId: graph.runId, workflowStepRunId: stepRun.id, issueId },
    });

    const verdict = await resolveHeartbeatResumeScopeFence(db, heartbeatRun);
    expect(verdict).toEqual({
      action: "reject",
      workflowRunId: graph.runId,
      workflowStepRunId: stepRun.id,
      gotGeneration: 2,
      wantGeneration: 1,
      reason: "generation_mismatch",
    });

    // settlement 이 fence reject 를 기록하는 경로는 정확히 한 번 호출하는 구조다 — 1회 호출 후
    // 정확히 1건의 진단 row 만 검증한다(표시/감사 전용, 실행 권위 아님).
    await recordResumeStaleResultRejected(db, {
      companyId: graph.companyId,
      issueId,
      heartbeatRunId: heartbeatRun.id,
      verdict,
    });
    const diagnostics = await loadFenceActivityLog(fixture.sql, "workflow.resume_stale_result_rejected");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      actor_type: "system",
      entity_type: "issue",
      entity_id: issueId,
      run_id: heartbeatRun.id,
    });
    expect(diagnostics[0]?.details).toMatchObject({
      workflowRunId: graph.runId,
      stepRunId: stepRun.id,
      gotGeneration: 2,
      wantGeneration: 1,
    });

    // skip mutation: issue 는 done 으로 바뀌지 않고 step run 도 완료되지 않는다(fence 가 게이트).
    const issueAfter = await loadFenceIssue(fixture.sql, issueId);
    expect(issueAfter?.status).toBe("in_progress");
    const stepAfter = await loadFenceStepRun(fixture.sql, stepRun.id);
    expect(stepAfter).toMatchObject({ status: "running", execution_generation: 2 });
    expect(await countFenceWorkProducts(fixture.sql, issueId)).toBe(0);
  });

  it("allows settlement on an exact generation match with v1 disabled and closes the linked step run", async () => {
    const resumeStamp = randomUUID();
    const graph = await seedFenceGraph(db, "FENCE-C2", { runMetadata: { resumeRequestId: resumeStamp } });
    const issueId = await seedFenceIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    const stepRun = await seedFenceStepRun(db, {
      runId: graph.runId,
      values: {
        status: "running",
        startedAt: new Date("2026-09-09T02:00:00.000Z"),
        issueId,
        executionGeneration: 3,
        statusTransitionVersion: 3,
        metadata: { resumeRequestId: resumeStamp },
      },
    });
    const heartbeatRun = await seedFenceHeartbeatRun(db, {
      companyId: graph.companyId,
      agentId: graph.agentId,
      issueId,
      workflowStepRunId: stepRun.id,
      workflowExecutionGeneration: 3,
      contextSnapshot: { workflowRunId: graph.runId, workflowStepRunId: stepRun.id, issueId },
    });

    const verdict = await resolveHeartbeatResumeScopeFence(db, heartbeatRun);
    expect(verdict).toEqual({ action: "allow" });

    const completedIds = await completeLinkedWorkflowStepRunsForIssue({
      db,
      issueId,
      completedAt: new Date("2026-09-09T03:00:00.000Z"),
      heartbeatRunId: heartbeatRun.id,
    });
    expect(completedIds).toEqual([stepRun.id]);
    const after = await loadFenceStepRun(fixture.sql, stepRun.id);
    expect(after).toMatchObject({ status: "completed", execution_generation: 3 });
  });

  it("skips only the closeout step run whose resume stamp lags the run's current resume epoch", async () => {
    const graph = await seedFenceGraph(db, "FENCE-C3", { runMetadata: { resumeRequestId: randomUUID() } });
    const staleStamp = randomUUID();
    const currentStamp = randomUUID();
    const issueId = await seedFenceIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    const staleStep = await seedFenceStepRun(db, {
      runId: graph.runId,
      stepId: "stale-step",
      values: {
        status: "running",
        issueId,
        executionGeneration: 1,
        metadata: { resumeRequestId: staleStamp },
      },
    });
    const currentStep = await seedFenceStepRun(db, {
      runId: graph.runId,
      stepId: "current-step",
      values: {
        status: "running",
        issueId,
        executionGeneration: 2,
        metadata: { resumeRequestId: currentStamp },
      },
    });
    // run 은 이미 다음 resume epoch(currentStamp)로 이동했다 — staleStep 만 뒤처져 있다.
    await setFenceRunMetadata(db, graph.runId, { resumeRequestId: currentStamp });

    const completedIds = await completeLinkedWorkflowStepRunsForIssue({
      db,
      issueId,
      completedAt: new Date("2026-09-09T04:00:00.000Z"),
    });
    expect(completedIds).toEqual([currentStep.id]);
    const staleAfter = await loadFenceStepRun(fixture.sql, staleStep.id);
    expect(staleAfter).toMatchObject({ status: "running", execution_generation: 1 });
    expect(await countFenceTransitionEvents(fixture.sql, staleStep.id)).toBe(0);

    // ordinary regression: stamp 없는 step 들은 기존과 동일하게 모두 완료된다.
    const ordinaryGraph = await seedFenceGraph(db, "FENCE-C3-ORD");
    const ordinaryIssue = await seedFenceIssue(db, { companyId: ordinaryGraph.companyId, missionId: ordinaryGraph.missionId });
    const ordinaryStep = await seedFenceStepRun(db, {
      runId: ordinaryGraph.runId,
      values: { status: "running", issueId: ordinaryIssue },
    });
    const ordinaryCompleted = await completeLinkedWorkflowStepRunsForIssue({
      db,
      issueId: ordinaryIssue,
      completedAt: new Date("2026-09-09T04:00:00.000Z"),
    });
    expect(ordinaryCompleted).toEqual([ordinaryStep.id]);
  });
});

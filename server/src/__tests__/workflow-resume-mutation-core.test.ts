import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { workflowStepRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import {
  loadMutationCoreStepRun,
  seedMutationCoreDelegation,
  seedMutationCoreGraph,
  seedMutationCoreIssue,
  seedMutationCoreOtherRun,
  seedMutationCoreStepRun,
  startMutationCoreFixture,
  type MutationCoreFixture,
} from "./helpers/workflow-resume-mutation-core-fixture.js";
import { captureHttpError } from "./helpers/workflow-execution-definition-fixture.js";
import { withResumeSerialization } from "../services/workflow/resume/serialization.js";
import { resetForResume } from "../services/workflow/resume/reset.js";

/**
 * [목적] Task6a resume mutation core 의 reset(resetForResume) 실DB 검증 (임베디드 PostgreSQL).
 *   계약 필드만 리셋(나머지 보존), generation/transitionVersion +1, delegation supersede +
 *   authority transition 영속, stale CAS conflict 와 트랜잭션 전체 롤백, 입력 계약 위반 거부.
 *   serialization 잠금/정렬/lock 유지 검증은 workflow-resume-serialization-core.test.ts,
 *   prototype-key 생성 맵 계약은 workflow-resume-generation-keys.test.ts 로 분리되어 있다.
 *   apply/dispatcher 마운트는 이 슬라이스 범위가 아니다.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const NOW = new Date("2026-09-08T01:00:00.000Z");

describeEmbeddedPostgres("workflow resume mutation core", () => {
  let fixture: MutationCoreFixture;
  let db: Db;

  beforeAll(async () => {
    fixture = await startMutationCoreFixture("resume-mutation-core-");
    if (!fixture.supported) throw new Error(fixture.reason);
    db = fixture.db;
  }, 60_000);
  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  const fullResetValues = () => ({
    status: "failed",
    executionGeneration: 5,
    statusTransitionVersion: 7,
    retryCount: 3,
    iterationIndex: 2,
    originalStatus: "running",
    agentName: "agent-x",
    dispatchAuthorityKind: "wakeup",
    legacyPluginStepEntityId: randomUUID(),
    sessionId: "sess-1",
    startedAt: new Date("2026-09-07T09:05:00.000Z"),
    completedAt: new Date("2026-09-07T09:30:00.000Z"),
    dispatchOwnerWakeupRequestId: randomUUID(),
    dispatchOwnerHeartbeatRunId: randomUUID(),
    evidenceReadyAt: new Date("2026-09-07T09:20:00.000Z"),
    dispatchReadyAt: new Date("2026-09-07T09:21:00.000Z"),
    lastDispatchAttemptAt: new Date("2026-09-07T09:22:00.000Z"),
    lastDispatchAcceptedAt: new Date("2026-09-07T09:23:00.000Z"),
    lastDispatchErrorAt: new Date("2026-09-07T09:24:00.000Z"),
    lastDispatchErrorSummary: "boom",
    lastDispatchRequestId: "dispatch-1",
    metadata: {
      failureCascadeSkipped: true,
      controlFlowSkipped: true,
      controlNodeGraceWait: 1200,
      controlNodeResult: { verdict: "changes" },
      controlNodeError: "stale",
      graphWorkProductRequired: true,
      executionControls: { attempts: 1 },
      snapshotToken: "tok",
      customAlpha: 1,
      customBeta: "b",
      customGamma: [1, 2],
      customDelta: { nested: true },
      customEpsilon: null,
      loopCap: 5,
    },
  });

  const runTransitionEventCount = async (runId: string) => {
    const rows = await fixture.sql`
      SELECT count(*)::int AS count FROM workflow_transition_events WHERE workflow_run_id = ${runId}`;
    return (rows[0] as { count: number }).count;
  };

  it("resets exactly the contract fields and preserves counters, history and metadata", async () => {
    const graph = await seedMutationCoreGraph(fixture.sql, "RESET");
    const requestId = randomUUID();
    const issueId = await seedMutationCoreIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    const step = await seedMutationCoreStepRun(db, { runId: graph.runId, stepId: "reset-me", values: fullResetValues() });
    await seedMutationCoreDelegation(db, {
      sourceCompanyId: graph.companyId,
      sourceWorkflowRunId: graph.runId,
      sourceWorkflowStepRunId: step.id,
      sourceExecutionGeneration: 5,
      targetCompanyId: graph.companyId,
      targetIssueId: issueId,
    });
    const applied = await withResumeSerialization(db, graph, ({ tx, steps }) =>
      resetForResume(tx, {
        companyId: graph.companyId,
        workflowRunId: graph.runId,
        requestId,
        steps: steps.filter((row) => row.stepId === "reset-me"),
        now: NOW,
      }));
    expect(applied).toEqual({ "reset-me": 6 });
    const row = (await loadMutationCoreStepRun(fixture.sql, step.id))!;
    expect(row).toMatchObject({
      step_id: "reset-me",
      status: "pending",
      execution_generation: 6,
      status_transition_version: 8,
      retry_count: 3,
      iteration_index: 2,
      original_status: "running",
      agent_name: "agent-x",
      dispatch_authority_kind: "wakeup",
      legacy_plugin_step_entity_id: step.legacyPluginStepEntityId,
      issue_id: null,
      started_at: null,
      completed_at: null,
      dispatch_owner_wakeup_request_id: null,
      dispatch_owner_heartbeat_run_id: null,
      evidence_ready_at: null,
      dispatch_ready_at: null,
      session_id: null,
      last_dispatch_attempt_at: null,
      last_dispatch_accepted_at: null,
      last_dispatch_error_at: null,
      last_dispatch_error_summary: null,
      last_dispatch_request_id: null,
    });
    expect(row.metadata).toEqual({
      graphWorkProductRequired: true,
      executionControls: { attempts: 1 },
      snapshotToken: "tok",
      customAlpha: 1,
      customBeta: "b",
      customGamma: [1, 2],
      customDelta: { nested: true },
      customEpsilon: null,
      loopCap: 5,
      resumeRequestId: requestId,
    });
    const delegation = (await fixture.sql`
      SELECT * FROM workflow_delegations WHERE source_workflow_step_run_id = ${step.id}`)[0] as Record<string, unknown>;
    expect(delegation).toMatchObject({ status: "superseded", source_execution_generation: 5 });
    expect((delegation.metadata as Record<string, unknown>).supersededGeneration).toBe(5);
    const events = (await fixture.sql`
      SELECT * FROM workflow_transition_events
      WHERE workflow_run_id = ${graph.runId} AND idempotency_key = ${`resume:${requestId}:${step.id}:6`}`) as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      company_id: graph.companyId,
      workflow_run_id: graph.runId,
      workflow_step_run_id: step.id,
      execution_generation: 6,
      reason: "workflow_resume_reset",
    });
    expect(events[0]!.payload).toEqual({ resumeRequestId: requestId, previousGeneration: 5 });
  });

  it("stale CAS after a first reset throws 409 and rolls the whole transaction back", async () => {
    const graph = await seedMutationCoreGraph(fixture.sql, "CAS");
    const first = await seedMutationCoreStepRun(db, { runId: graph.runId, stepId: "cas-1", values: { status: "failed", executionGeneration: 2, statusTransitionVersion: 1 } });
    const second = await seedMutationCoreStepRun(db, { runId: graph.runId, stepId: "cas-2", values: { status: "failed", executionGeneration: 2, statusTransitionVersion: 1 } });
    const stale = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, graph.runId));
    // 직렬화 캡처 이후 외부 커넥션이 두 번째 step 을 선점 — 잠금 없는 stale rows 로 reset 시도.
    // status CHECK 허용값(running)으로 유효하게 선점하며, stale snapshot(status failed) 과의
    // CAS 불일치가 409 conflict 를 유도한다 (DB CHECK 실패가 아님).
    const external = fixture.openConnection();
    try {
      await external.update(workflowStepRuns).set({ status: "running" }).where(eq(workflowStepRuns.id, second.id));
    } finally {
      await external.$client.end({ timeout: 5 }).catch(() => {});
    }
    const error = await captureHttpError(db.transaction((tx) => resetForResume(tx, {
      companyId: graph.companyId,
      workflowRunId: graph.runId,
      requestId: randomUUID(),
      steps: stale.filter((row) => row.id === first.id || row.id === second.id),
      now: NOW,
    })));
    expect(error.status).toBe(409);
    expect(await loadMutationCoreStepRun(fixture.sql, first.id)).toMatchObject({
      execution_generation: 2,
      status_transition_version: 1,
      status: "failed",
    });
    expect(await loadMutationCoreStepRun(fixture.sql, second.id)).toMatchObject({ status: "running" });
    expect(await runTransitionEventCount(graph.runId)).toBe(0);
    expect(await fixture.sql`SELECT count(*)::int AS count FROM workflow_delegations WHERE source_workflow_run_id = ${graph.runId}`)
      .toEqual([{ count: 0 }]);
  });

  it("rejects invalid reset inputs with 400 without writing", async () => {
    const graph = await seedMutationCoreGraph(fixture.sql, "REJECT");
    const otherRunId = await seedMutationCoreOtherRun(fixture.sql, graph, "REJECT");
    const ok = await seedMutationCoreStepRun(db, { runId: graph.runId, stepId: "ok", values: { status: "failed" } });
    const done = await seedMutationCoreStepRun(db, { runId: graph.runId, stepId: "done", values: { status: "completed" } });
    const running = await seedMutationCoreStepRun(db, { runId: graph.runId, stepId: "busy", values: { status: "running" } });
    const owned = await seedMutationCoreStepRun(db, {
      runId: graph.runId,
      stepId: "owned",
      values: { status: "failed", issueId: await seedMutationCoreIssue(db, { companyId: graph.companyId, missionId: graph.missionId }) },
    });
    const crossRun = await seedMutationCoreStepRun(db, { runId: otherRunId, stepId: "cross", values: { status: "failed" } });
    const maxed = await seedMutationCoreStepRun(db, {
      runId: graph.runId,
      stepId: "maxed",
      values: { status: "failed", executionGeneration: 2147483647 },
    });
    const attempt = (steps: Parameters<typeof resetForResume>[1]["steps"]) => captureHttpError(db.transaction((tx) =>
      resetForResume(tx, { companyId: graph.companyId, workflowRunId: graph.runId, requestId: randomUUID(), steps, now: NOW })));
    expect((await attempt([])).status).toBe(400);
    expect((await attempt([ok, ok])).status).toBe(400);
    expect((await attempt([ok, { ...ok, id: randomUUID() }])).status).toBe(400);
    expect((await attempt([crossRun])).status).toBe(400);
    expect((await attempt([done])).status).toBe(400);
    expect((await attempt([running])).status).toBe(400);
    expect((await attempt([owned])).status).toBe(400);
    expect((await attempt([maxed])).status).toBe(400);
    expect((await attempt([{ ...ok, executionGeneration: -1 }])).status).toBe(400);
    expect((await attempt([{ ...ok, status: "skipped", statusTransitionVersion: 2147483647 }])).status).toBe(400);
    expect(await loadMutationCoreStepRun(fixture.sql, ok.id)).toMatchObject({
      status: "failed",
      execution_generation: 0,
      status_transition_version: 0,
    });
    expect(await runTransitionEventCount(graph.runId)).toBe(0);
  });

  it("preserves sibling steps, other runs and the source issue", async () => {
    const graph = await seedMutationCoreGraph(fixture.sql, "PRESERVE");
    const otherRunId = await seedMutationCoreOtherRun(fixture.sql, graph, "PRESERVE");
    const target = await seedMutationCoreStepRun(db, { runId: graph.runId, stepId: "target", values: { status: "failed", executionGeneration: 1 } });
    const sibling = await seedMutationCoreStepRun(db, {
      runId: graph.runId,
      stepId: "sibling",
      values: { status: "completed", executionGeneration: 9, retryCount: 4, metadata: { keepMe: true } },
    });
    const outside = await seedMutationCoreStepRun(db, { runId: otherRunId, stepId: "outside", values: { status: "running", executionGeneration: 3 } });
    const issueId = await seedMutationCoreIssue(db, { companyId: graph.companyId, missionId: graph.missionId, title: "preserve issue" });
    await withResumeSerialization(db, graph, ({ tx, steps }) => resetForResume(tx, {
      companyId: graph.companyId,
      workflowRunId: graph.runId,
      requestId: randomUUID(),
      steps: steps.filter((row) => row.id === target.id),
      now: NOW,
    }));
    expect(await loadMutationCoreStepRun(fixture.sql, sibling.id)).toMatchObject({
      status: "completed",
      execution_generation: 9,
      retry_count: 4,
    });
    expect((await loadMutationCoreStepRun(fixture.sql, sibling.id))!.metadata).toEqual({ keepMe: true });
    expect(await loadMutationCoreStepRun(fixture.sql, outside.id)).toMatchObject({
      status: "running",
      execution_generation: 3,
    });
    expect(await fixture.sql`SELECT status, title FROM issues WHERE id = ${issueId}`)
      .toEqual([{ status: "in_progress", title: "preserve issue" }]);
    expect(await fixture.sql`SELECT status FROM workflow_runs WHERE id = ${graph.runId}`)
      .toEqual([{ status: "running" }]);
  });
});

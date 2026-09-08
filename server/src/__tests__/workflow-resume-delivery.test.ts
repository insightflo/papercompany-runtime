import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { workflowResumeExecutions, workflowResumeRequests, workflowRuns, workflowStepRuns } from "@paperclipai/db";import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { seedCompanyOnly, seedWorkflowDefinition, sleep } from "./helpers/workflow-execution-definition-fixture.js";
import {
  loadDeliveryExecution,
  loadDeliveryRequest,
  markRunPendingDelivery,
  resetResumeDeliveryIsolation,
  seedQueuedToolStepRun,
  seedResumeDeliveryGraph,
} from "./helpers/workflow-resume-delivery-fixture.js";
import {
  startNativeEntryFixture,
  type NativeEntryFixture,
} from "./helpers/workflow-resume-native-entry-fixture.js";
import { insertMutationCoreResumeRequest, seedMutationCoreStepRun } from "./helpers/workflow-resume-mutation-core-fixture.js";

// External-effect mocks only (agent wakeups). DB, engine, queue and dispatcher run on real PG.
const { heartbeatWakeup } = vi.hoisted(() => ({ heartbeatWakeup: vi.fn() }));
vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return { ...actual, heartbeatService: () => ({ wakeup: heartbeatWakeup }) };
});
vi.mock("../services/issue-assignment-wakeup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issue-assignment-wakeup.js")>();
  return {
    ...actual,
    queueIssueAssignmentWakeup: (input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0]) =>
      actual.queueIssueAssignmentWakeup({ ...input, heartbeat: { wakeup: heartbeatWakeup } }),
  };
});

import {
  processQueuedWorkflowToolStepRuns,
  setWorkflowToolStepExecutor,
  type WorkflowToolStepQueueDispatchResult,
} from "../services/workflow/dag-engine.js";
import { dispatchAcceptedResumeWork } from "../services/workflow/resume/dispatcher.js";
import {
  claimPendingResumeRequests,
  claimStaleResumeExecutions,
} from "../services/workflow/resume/execution-queue.js";
import { withResumeSerialization } from "../services/workflow/resume/serialization.js";
import { createWorkflowRunWithDefinition } from "../services/workflow/workflow-run-create.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping resume delivery tests: ${embeddedPostgresSupport.reason ?? "unsupported host"}`);
}

describeEP("workflow resume delivery (execution queue + dispatcher)", () => {
  let fixture: Extract<NativeEntryFixture, { supported: true }>;
  let db: Db;
  let extraConnections: Db[];
  const NOW = new Date("2026-09-08T01:00:00.000Z");

  beforeAll(async () => {
    const started = await startNativeEntryFixture("resume-delivery-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = fixture.db;
    extraConnections = [];
  }, 60_000);
  afterAll(async () => {
    for (const connection of extraConnections) {
      await connection.$client.end({ timeout: 5 }).catch(() => {});
    }
    if (fixture?.supported) await fixture.cleanup();
  });
  beforeEach(async () => {
    heartbeatWakeup.mockReset();
    setWorkflowToolStepExecutor(null);
    // [격리] 공유 PG 인스턴스에서 이전 테스트의 미종결 resume 행이 다음 dispatch 패스에
    //   걸리는 것을 막는다(전역 dispatcher 에는 스코프 필터가 없다). 프로덕션 로직 아님.
    await resetResumeDeliveryIsolation(db, NOW);
  });
  afterEach(() => setWorkflowToolStepExecutor(null));

  function openConnection(): Db {
    const connection = fixture.openConnection();
    extraConnections.push(connection);
    return connection;
  }

  it("claims pending requests with lease+attempt bump, skips live leases, takes over expired leases", async () => {
    const graph = await seedResumeDeliveryGraph(fixture.sql, db, { prefix: "rdq-claim" });
    const claimableId = await markRunPendingDelivery(db, graph, {});
    const liveId = randomUUID();
    await insertMutationCoreResumeRequest(db, {
      id: liveId,
      companyId: graph.companyId,
      missionId: graph.missionId,
      workflowRunId: graph.runId,
      state: "pending_delivery",
      appliedGenerations: {},
    });
    await db.update(workflowResumeRequests).set({
      leaseOwner: "resume-dispatcher:live",
      leaseUntil: sql`clock_timestamp() + interval '20 seconds'`,
    }).where(eq(workflowResumeRequests.id, liveId));

    const claimed = await claimPendingResumeRequests(db, { now: NOW });

    expect(claimed.map((row) => row.id)).toEqual([claimableId]);
    const live = await loadDeliveryRequest(fixture.sql, liveId);
    const claimedRow = await loadDeliveryRequest(fixture.sql, claimableId);
    expect(live!.delivery_attempts).toBe(0);
    expect(claimedRow!.delivery_attempts).toBe(1);
    expect(String(claimedRow!.lease_owner)).toContain("resume-dispatcher:");
    const [lease] = await fixture.sql`SELECT lease_until > clock_timestamp()
      AND lease_until <= clock_timestamp() + interval '30 seconds' AS valid
      FROM workflow_resume_requests WHERE id = ${claimableId}`;
    expect(lease!.valid).toBe(true);
  });

  it("two concurrent dispatchers race the same pending request — exactly one SKIP LOCKED claim wins", async () => {
    const graph = await seedResumeDeliveryGraph(fixture.sql, db, { prefix: "rdq-race" });
    const requestId = await markRunPendingDelivery(db, graph, {});
    const second = openConnection();

    const firstPromise = claimPendingResumeRequests(db, { now: NOW });
    await sleep(20);
    const secondResult = await claimPendingResumeRequests(second, { now: NOW });
    const firstResult = await firstPromise;

    expect(firstResult).toHaveLength(1);
    expect(firstResult[0]!.id).toBe(requestId);
    expect(secondResult).toHaveLength(0);
  });

  it("claims stale queued/running executions for re-entry but not completed or live-leased ones", async () => {
    const graph = await seedResumeDeliveryGraph(fixture.sql, db, { prefix: "rdq-exec" });
    const staleId = await markRunPendingDelivery(db, graph, {});
    const liveId = randomUUID();
    await insertMutationCoreResumeRequest(db, {
      id: liveId,
      companyId: graph.companyId,
      missionId: graph.missionId,
      workflowRunId: graph.runId,
      state: "accepted",
      appliedGenerations: {},
    });
    for (const [requestId, leaseUntil] of [
      [staleId, sql`clock_timestamp() - interval '1 second'`],
      [liveId, sql`clock_timestamp() + interval '20 seconds'`],
    ] as const) {
      await db.insert(workflowResumeExecutions).values({
        requestId,
        companyId: graph.companyId,
        missionId: graph.missionId,
        workflowRunId: graph.runId,
        authorityVersion: 3,
        generations: { [graph.stepId]: 3 },
        state: "running",
        leaseOwner: "resume-dispatcher:seed",
        leaseUntil,
        attempts: 1,
      });
    }

    const claimed = await claimStaleResumeExecutions(db, { now: NOW });

    expect(claimed.map((row) => row.requestId)).toEqual([staleId]);
    expect(claimed[0]!.attempts).toBe(2);
    expect(claimed[0]!.state).toBe("running");
    expect(String(claimed[0]!.leaseOwner)).toContain("resume-dispatcher:");
  });

  it("crash after accept: expired-lease re-entry completes idempotently without duplicate writes", async () => {
    const graph = await seedResumeDeliveryGraph(fixture.sql, db, { prefix: "rdq-crash", stepType: "tool" });
    const requestId = await markRunPendingDelivery(db, graph, {});

    // Pass 1: accept commits, then the pipeline throws at readiness (executor down) — crash equivalent.
    const failed = await dispatchAcceptedResumeWork(db, { now: NOW });
    expect(failed.acceptedCount).toBe(1);
    expect(failed.completedCount).toBe(0);
    expect(failed.failedCount).toBe(1);
    const afterCrash = await loadDeliveryExecution(fixture.sql, requestId);
    expect(afterCrash!.state).toBe("running");
    expect(afterCrash!.attempts).toBe(1);
    const afterCrashRequest = await loadDeliveryRequest(fixture.sql, requestId);
    const acceptedAt = afterCrashRequest!.accepted_at;

    // Pass 2: lease expired + executor restored — re-entry completes the SAME execution.
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));
    await db.update(workflowResumeExecutions).set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(workflowResumeExecutions.requestId, requestId));
    const rerun = await dispatchAcceptedResumeWork(db);
    expect(rerun.completedCount).toBe(1);
    const execution = await loadDeliveryExecution(fixture.sql, requestId);
    expect(execution!.state).toBe("completed");
    expect(execution!.completed_at).not.toBeNull();
    expect(execution!.attempts).toBe(2);
    expect(execution!.generations).toEqual({ [graph.stepId]: 3 });
    const request = await loadDeliveryRequest(fixture.sql, requestId);
    expect(request!.state).toBe("accepted");
    expect(request!.accepted_at).toBe(acceptedAt);
    expect(request!.delivery_attempts).toBe(1);
    const executionCount = await fixture
      .sql`SELECT count(*)::int AS c FROM workflow_resume_executions WHERE request_id = ${requestId}`;
    expect((executionCount[0] as { c: number }).c).toBe(1);
    const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, graph.runId));
    expect(steps).toHaveLength(1);
    expect(steps[0]!.executionGeneration).toBe(3);
    expect(steps[0]!.lastDispatchRequestId).not.toBeNull();
    expect((steps[0]!.metadata as Record<string, unknown>).resumeRequestId).toBe(requestId);

    // Pass 3: terminal execution is never re-claimed.
    const third = await dispatchAcceptedResumeWork(db);
    expect(third.claimedCount + third.acceptedCount + third.completedCount).toBe(0);
  });

  it("queue claim serializes behind an in-flight apply lock and proceeds after commit without deadlock", async () => {
    const graph = await seedResumeDeliveryGraph(fixture.sql, db, { prefix: "rdq-lock", stepType: "tool" });
    await seedQueuedToolStepRun(db, {
      runId: graph.runId,
      stepId: graph.stepId,
      requestId: `${graph.runId}:${graph.stepId}:1`,
      now: NOW,
    });
    const executor = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(executor);
    const second = openConnection();
    let claimPromise!: Promise<WorkflowToolStepQueueDispatchResult>;
    let settledUnderApplyLock = false;

    await withResumeSerialization(
      db,
      { companyId: graph.companyId, missionId: graph.missionId, runId: graph.runId },
      async () => {
        claimPromise = processQueuedWorkflowToolStepRuns(second, { now: NOW });
        void claimPromise.then(() => {
          settledUnderApplyLock = true;
        });
        await sleep(150);
        expect(settledUnderApplyLock).toBe(false);
      },
    );
    const result = await claimPromise;

    expect(result.claimedCount).toBe(1);
    expect(result.executedCount).toBe(1);
    expect(executor).toHaveBeenCalledTimes(1);
    const [stepRun] = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, graph.runId));
    expect(stepRun!.lastDispatchAcceptedAt).not.toBeNull();
    expect((stepRun!.metadata as Record<string, unknown>).toolQueue).toMatchObject({ status: "claimed" });
  });

  it("ordinary mission-less queued tool step still claims + dispatches after the bounded claim lock", async () => {
    const { companyId } = await seedCompanyOnly(fixture.sql, `rdq-nomission-${randomUUID().slice(0, 8)}`);
    const workflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId,
      name: "resume-delivery-ordinary",
      stepsJson: [{
        id: "plain-tool",
        name: "Plain tool",
        type: "tool",
        agentId: "",
        toolNames: ["sync-tool"],
        toolArgs: {},
        dependencies: [],
      }],
    });
    const run = await createWorkflowRunWithDefinition(db, { workflowId, companyId, triggeredBy: "task6b-delivery-test" });
    await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, run.id));
    const runId = run.id;
    await seedQueuedToolStepRun(db, { runId, stepId: "plain-tool", requestId: `${runId}:plain-tool:1`, now: NOW });
    const executor = vi.fn().mockResolvedValue({ accepted: true });
    setWorkflowToolStepExecutor(executor);

    const result = await processQueuedWorkflowToolStepRuns(db, { now: NOW });

    expect(result.claimedCount).toBe(1);
    expect(result.executedCount).toBe(1);
    expect(executor).toHaveBeenCalledTimes(1);
  });
});

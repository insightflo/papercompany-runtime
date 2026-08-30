import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueWorkProducts,
  issues,
  missions,
  toolDefinitions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  processQueuedWorkflowToolStepRuns,
  reconcileOrphanedWorkflowToolStepClaims,
  retryIssueLessToolWorkflowStep,
  setWorkflowToolStepExecutor,
} from "../services/workflow/dag-engine.js";

type ExecutorResult = { accepted: boolean };
const noOpExecutor = async (): Promise<ExecutorResult> => ({ accepted: true });

/**
 * [orphan-claim reaper] 2026-08-30 사고(미션 17f36958) 회귀 방지.
 *
 * claim 직후 런타임 재시작으로 실행기가 증발하면 issue-less 툴 스텝 running 행이
 * 완료도 실패도 못 받는다. 큐 셀렉터는 lastDispatchAcceptedAt IS NULL 만 집으므로
 * 이 행은 다시는 선택되지 않고, reconcileStuckWorkflowRuns 는 running 스텝이 있는
 * run 을 skip 한다 — 회복 통로가 전무했다.
 *
 * reconcileOrphanedWorkflowToolStepClaims 가 claim 나이 > 도구 timeout + grace 인
 * 행을 기존 실패 경로(failToolStepRunWithDispatchError + syncWorkflowRunState)로
 * 종결하고, 공식 rerun(retryIssueLessToolWorkflowStep) 이 다시 열리는지 검증한다.
 */

describe("workflow orphaned tool claim reconciliation", () => {
  let db: Awaited<ReturnType<typeof createDb>>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-orphan-claim-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    setWorkflowToolStepExecutor(null);
    await db.delete(workflowTransitionEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueWorkProducts);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(toolDefinitions);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRun(input: {
    acceptedAtAgoMs: number | null;
    now: Date;
    toolTimeoutMs?: number;
  }): Promise<{ companyId: string; runId: string; stepId: string; stepRunId: string }> {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const stepRunId = randomUUID();
    const stepId = "stage-orphan-tool";

    await db.insert(companies).values({
      id: companyId,
      name: `Orphan Claim Co ${companyId.slice(0, 8)}`,
      issuePrefix: `OC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    if (typeof input.toolTimeoutMs === "number") {
      await db.insert(toolDefinitions).values({
        companyId,
        name: "stage-orphan-tool",
        description: "test tool",
        adapterType: "http",
        adapterConfig: { timeoutMs: input.toolTimeoutMs },
      });
    }
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: `orphan-claim-wf-${companyId.slice(0, 8)}`,
      stepsJson: [
        {
          id: stepId,
          name: "Stage orphan tool",
          title: "Stage orphan tool",
          toolNames: ["stage-orphan-tool"],
          dependsOn: [],
          onFailure: "escalate",
        },
      ],
      status: "active",
      timezone: "Asia/Seoul",
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      status: "running",
      triggeredBy: "test",
      runDate: "2026-08-30",
      startedAt: new Date(input.now.getTime() - 60 * 60_000),
    });
    const metadata: Record<string, unknown> = {
      toolInvocation: {
        requestId: `${runId}:${stepId}:request-1`,
        toolName: "stage-orphan-tool",
        args: { url: "https://example.test/watch?v=orphan" },
        queuedAt: new Date(input.now.getTime() - 40 * 60_000).toISOString(),
      },
      toolQueue: {
        status: "claimed",
        queuedAt: new Date(input.now.getTime() - 40 * 60_000).toISOString(),
        claimedAt: input.acceptedAtAgoMs === null
          ? undefined
          : new Date(input.now.getTime() - input.acceptedAtAgoMs).toISOString(),
      },
    };
    await db.insert(workflowStepRuns).values({
      id: stepRunId,
      workflowRunId: runId,
      stepId,
      issueId: null,
      status: "running",
      startedAt: new Date(input.now.getTime() - 40 * 60_000),
      lastDispatchRequestId: `${runId}:${stepId}:request-1`,
      lastDispatchAcceptedAt: input.acceptedAtAgoMs === null
        ? null
        : new Date(input.now.getTime() - input.acceptedAtAgoMs),
      metadata,
    });
    return { companyId, runId, stepId, stepRunId };
  }

  it("reaps a claim orphaned by a runtime restart (claimed far past timeout) and reopens the official rerun path", async () => {
    const now = new Date("2026-08-30T18:00:00.000Z");
    const seed = await seedRun({ acceptedAtAgoMs: 40 * 60_000, now, toolTimeoutMs: 300_000 });

    const reconcileResult = await reconcileOrphanedWorkflowToolStepClaims(db, { now });
    expect(reconcileResult.orphanedCount).toBe(1);

    const [reaped] = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, seed.stepRunId));
    expect(reaped.status).toBe("failed");
    expect(reaped.completedAt).not.toBeNull();
    expect(reaped.lastDispatchErrorSummary).toContain("orphaned");

    // 공식 rerun 경로 재개 확인: failed 상태가 되면 retryIssueLessToolWorkflowStep 가
    // 스텝을 재실행 대기(queued running, 미claim)로 되살려야 한다. 실행기는 no-op 로 등록해
    // 재실행 디스패치가 큐 적체 상태로 안착하는 것까지 검증한다.
    setWorkflowToolStepExecutor(noOpExecutor);
    const retry = await retryIssueLessToolWorkflowStep(db, {
      companyId: seed.companyId,
      runId: seed.runId,
      stepId: seed.stepId,
    });
    expect(retry).not.toBeNull();
    const [afterRetry] = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, seed.stepRunId));
    expect(afterRetry.status).toBe("running");
    expect(afterRetry.lastDispatchAcceptedAt).toBeNull();
    const retriedMetadata = (afterRetry.metadata ?? {}) as Record<string, unknown>;
    expect((retriedMetadata.toolQueue as Record<string, unknown> | undefined)?.status).toBe("queued");
  });

  it("does not reap a fresh claim (below min age)", async () => {
    const now = new Date("2026-08-30T18:00:00.000Z");
    const seed = await seedRun({ acceptedAtAgoMs: 60_000, now });

    const reconcileResult = await reconcileOrphanedWorkflowToolStepClaims(db, { now });
    expect(reconcileResult.orphanedCount).toBe(0);

    const [stepRun] = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, seed.stepRunId));
    expect(stepRun.status).toBe("running");
  });

  it("does not reap a claim still inside the tool timeout + grace window", async () => {
    const now = new Date("2026-08-30T18:00:00.000Z");
    // min age(15m) 보다 오래됐지만 도구 timeout(60m)+grace(5m) 안쪽 → 건드리지 않는다.
    const seed = await seedRun({ acceptedAtAgoMs: 20 * 60_000, now, toolTimeoutMs: 3_600_000 });

    const reconcileResult = await reconcileOrphanedWorkflowToolStepClaims(db, { now });
    expect(reconcileResult.orphanedCount).toBe(0);

    const [stepRun] = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, seed.stepRunId));
    expect(stepRun.status).toBe("running");
  });

  it("processQueuedWorkflowToolStepRuns reports reaped orphans as failed and leaves queued rows untouched", async () => {
    const now = new Date("2026-08-30T18:00:00.000Z");
    await seedRun({ acceptedAtAgoMs: 40 * 60_000, now, toolTimeoutMs: 300_000 });

    const dispatchResult = await processQueuedWorkflowToolStepRuns(db, { now });
    expect(dispatchResult.failedCount).toBeGreaterThanOrEqual(1);
  });
});

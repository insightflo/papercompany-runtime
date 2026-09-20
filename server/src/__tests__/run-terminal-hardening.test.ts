// [purpose] run-terminal 경계 강화 회귀 — (1) 레거시 무범프 재오픈 충돌 자가치유,
//   (2) 이슈 없는 run 의 재시도 예약 채널 평가, (3) 재시도 스케줄러 재오픈의 권한버전 범프.
//   2026-09-19/20 프로덕션 웨지(동일 버전 상이 결정 충돌 500)와 검토 봇 지적의 재발 방지.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  workflowRuns,
  workflowStepRuns,
  workflowTerminalDecisions,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  cleanupTerminalBoundaryTables,
  hoursFromNow,
  retryMetadata,
  seedBoundaryWorld,
  stepRunsOf,
  type BoundaryWorld,
} from "./helpers/run-terminal-boundary-fixture.js";
import { evaluateRecoveryChannels, finalizeRunTerminal } from "../services/workflow/run-terminal-boundary.js";
import { scheduleWorkflowStepRetry } from "../services/workflow/step-retry-scheduler.js";
import { markRunStatus } from "./helpers/workflow-frozen-execution-fixture.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping run-terminal-hardening tests: ${support.reason ?? "unsupported host"}`);
}

const FAILED_CAUSE = { policy: "recovery_deadline_hard", discovery: "stuck_diagnostic", origin: "reconciler", reason: "wedge reproduction" } as const;
const COMPLETED_CAUSE = { policy: "outcome_convergence", discovery: "engine_recompute", origin: "dag_engine" } as const;

let db: Db;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

beforeAll(async () => {
  tempDb = await startEmbeddedPostgresTestDatabase("terminal-hardening-");
  db = createDb(tempDb.connectionString);
});

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
  await tempDb.cleanup();
});

describeEP("terminal decision self-heal after legacy un-bumped reopen", () => {
  it("re-finalization at a conflicted (run, version) bumps the version instead of throwing", async () => {
    await cleanupTerminalBoundaryTables(db);
    const world = await seedBoundaryWorld(db);

    // 1) 최초 failed 종결 — 결정 기록 @ 버전 0.
    const first = await finalizeRunTerminal(db, {
      runId: world.runId, companyId: world.companyId, expectedAuthorityVersion: 0,
      decision: "failed", cause: { ...FAILED_CAUSE }, gatePolicy: "immediate",
      now: new Date(), stepRuns: [],
    });
    expect(first.kind).toBe("finalized");

    // 2) 레거시 무범프 재오픈 재현 — 가드 이전 시대의 resume/스케줄러는 버전을 올리지 않았다.
    await markRunStatus(db, world.runId, "running");
    await db.update(workflowRuns).set({ completedAt: null }).where(eq(workflowRuns.id, world.runId));

    // 3) 재종결(다른 결정) — 과거엔 "terminal decision conflict" 500. 이제 자가치유.
    const healed = await finalizeRunTerminal(db, {
      runId: world.runId, companyId: world.companyId, expectedAuthorityVersion: 0,
      decision: "completed", cause: { ...COMPLETED_CAUSE }, gatePolicy: "immediate",
      now: new Date(), stepRuns: [],
    });
    expect(healed.kind).toBe("finalized");
    if (healed.kind !== "finalized") return;
    expect(healed.decidedAuthorityVersion).toBe(1);
    expect(healed.decision).toBe("completed");
    expect(healed.run.status).toBe("completed");
    expect(healed.run.dispatchAuthorityVersion).toBe(1);

    // 두 결정 모두 보존 — (run,0)=failed / (run,1)=completed. 이력 위조 없음.
    const decisions = await db
      .select({ version: workflowTerminalDecisions.decidedAuthorityVersion, decision: workflowTerminalDecisions.decision })
      .from(workflowTerminalDecisions)
      .where(eq(workflowTerminalDecisions.workflowRunId, world.runId));
    expect(decisions).toEqual(expect.arrayContaining([
      { version: 0, decision: "failed" },
      { version: 1, decision: "completed" },
    ]));

    // 4) 같은 결정 재관측은 여전히 멱등 already_finalized.
    const again = await finalizeRunTerminal(db, {
      runId: world.runId, companyId: world.companyId, expectedAuthorityVersion: 1,
      decision: "completed", cause: { ...COMPLETED_CAUSE }, gatePolicy: "immediate",
      now: new Date(), stepRuns: [],
    });
    expect(again.kind).toBe("already_finalized");
  });
});

describeEP("recovery gate evaluates retry reservations for issue-less runs", () => {
  it("issue-less stepRuns with a live waiting retry keep the gate open", async () => {
    await cleanupTerminalBoundaryTables(db);
    const world = await seedBoundaryWorld(db);
    // 이슈 없는 스텝(도구 스텝) + 살아있는 재시도 예약 — 게이트 입력은 실제 스텝 모양 그대로.
    const [toolStep] = await db.insert(workflowStepRuns).values({
      workflowRunId: world.runId, stepId: "tool", status: "failed", issueId: null,
      metadata: retryMetadata("waiting", 1, 3, hoursFromNow(1)),
    }).returning({ id: workflowStepRuns.id });
    const gate = await evaluateRecoveryChannels(db, {
      runId: world.runId, companyId: world.companyId, missionId: null,
      stepRuns: [{
        id: toolStep!.id, stepId: "tool", issueId: null, status: "failed",
        metadata: retryMetadata("waiting", 1, 3, hoursFromNow(1)),
      }],
      now: new Date(),
    });
    expect(gate.kind).toBe("open");
  });

  it("issue-less stepRuns without reservations stay clear", async () => {
    await cleanupTerminalBoundaryTables(db);
    const world = await seedBoundaryWorld(db);
    const gate = await evaluateRecoveryChannels(db, {
      runId: world.runId, companyId: world.companyId, missionId: null,
      stepRuns: stepRunsOf(world), now: new Date(),
    });
    expect(gate.kind).toBe("clear");
  });
});

describeEP("step retry scheduler reopen bumps authority version", () => {
  it("scheduling a retry on a failed run reopens running with dispatchAuthorityVersion + 1", async () => {
    await cleanupTerminalBoundaryTables(db);
    const world = await seedBoundaryWorld(db);
    const completedAt = new Date();
    const requestId = `hardening-${randomUUID()}`;
    const [stepRun] = await db.insert(workflowStepRuns).values({
      workflowRunId: world.runId, stepId: "retry", status: "failed", completedAt,
      lastDispatchRequestId: requestId, metadata: {},
    }).returning({ id: workflowStepRuns.id });
    await markRunStatus(db, world.runId, "failed");

    const scheduled = await scheduleWorkflowStepRetry(db, {
      companyId: world.companyId, workflowRunId: world.runId, stepRunId: stepRun!.id,
      retryNumber: 1, maxRetries: 1, delaySeconds: 0,
      observedStatus: "failed", observedRetryCount: 0, observedCompletedAt: completedAt,
      observedLastDispatchRequestId: requestId, observedMetadataSnapshot: {},
      observedExecutionGeneration: 0, errorSummary: null,
    });
    expect(scheduled.result).toBe("scheduled");

    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, world.runId));
    expect(run?.status).toBe("running");
    expect(run?.completedAt).toBeNull();
    // [웨지 재발 방지] 재오픈은 새 권한 버전을 부여한다 — 재종결 결정은 (run, N+1) 에 기록된다.
    expect(run?.dispatchAuthorityVersion).toBe(1);
  });
});

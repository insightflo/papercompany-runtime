// [purpose] 종결/복구 경계의 스텝 세대 울타리 회귀 — 늦은 정산과 늦은 쓰기가
//   종결·복구 이전 세대로 현재 스텝 행을 오염하지 않는지 검증한다.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  heartbeatRunFinalizations,
  heartbeatRunFinalizationSteps,
  heartbeatRuns,
  instanceSettings,
  workflowStepRuns,
  workflowTransitionEvents,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  cleanupTerminalBoundaryTables,
  seedBoundaryWorld,
  type BoundaryWorld,
} from "./helpers/run-terminal-boundary-fixture.js";
import { finalizeRunTerminal } from "../services/workflow/run-terminal-boundary.js";
import { atomicStructuralCompletion } from "../services/workflow/control-flow/structural-completion.js";
import { recoverTerminalRun } from "../services/workflow/run-recovery-authority.js";
import { ensureFinalization, recordStage } from "../services/heartbeat-finalization/finalization-state.js";
import { settleRunIfReady } from "../services/heartbeat-finalization/settlement.js";
import { C_STAGE, Q_STAGE, STAGE_CLASS } from "../services/heartbeat-finalization/stage-classifier.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping terminal generation stamp tests: ${support.reason ?? "unsupported host"}`);
}

const FAILED_CAUSE = {
  policy: "recovery_deadline_hard",
  discovery: "stuck_diagnostic",
  origin: "reconciler",
  reason: "generation fencing",
} as const;

let db: Db;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

beforeAll(async () => {
  tempDb = await startEmbeddedPostgresTestDatabase("terminal-generation-stamp-");
  db = createDb(tempDb.connectionString);
  await db.insert(instanceSettings).values({
    singletonKey: "default",
    general: {},
    experimental: { enableHeartbeatFinalizationV1: true },
  } as never);
});

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
  await tempDb.cleanup();
});

async function finalize(world: BoundaryWorld) {
  const result = await finalizeRunTerminal(db, {
    runId: world.runId,
    companyId: world.companyId,
    expectedAuthorityVersion: 0,
    decision: "failed",
    cause: { ...FAILED_CAUSE },
    gatePolicy: "immediate",
    now: new Date(),
    stepRuns: [],
  });
  expect(result.kind).toBe("finalized");
}

async function generations(...runIds: string[]) {
  const rows = await db.select({
    workflowRunId: workflowStepRuns.workflowRunId,
    executionGeneration: workflowStepRuns.executionGeneration,
  }).from(workflowStepRuns);
  return runIds.map((runId) => rows.filter((row) => row.workflowRunId === runId)
    .map((row) => row.executionGeneration));
}

async function seedSettledHeartbeatWithStaleGeneration(world: BoundaryWorld) {
  const runId = crypto.randomUUID();
  await db.insert(heartbeatRuns).values({
    id: runId,
    companyId: world.companyId,
    agentId: world.agentId,
    issueId: world.stepIssueId,
    invocationSource: "automation",
    status: "succeeded",
    terminalOutcome: "succeeded",
    finalizationVersion: 1,
    executionEpoch: 0,
    executionToken: runId,
    workflowStepRunId: world.stepRunId,
    workflowExecutionGeneration: 0,
    executionScopeKind: "workflow_step",
  } as never);
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  const fin = await ensureFinalization(db, run!, new Date());
  for (const kind of [
    Q_STAGE.executorQuiescence,
    Q_STAGE.workspaceOperationsSettled,
    Q_STAGE.runtimeServicesStopped,
    Q_STAGE.missionRuntimeIdle,
  ]) {
    await recordStage(db, {
      companyId: world.companyId, runId, finalizationId: fin.id,
      stageClass: STAGE_CLASS.quiescence, stageKind: kind,
      idempotencyKey: `q:${kind}`, state: "done",
    });
  }
  for (const kind of [C_STAGE.issuePromotion, C_STAGE.workflowEvidenceSync, C_STAGE.missionHandoff]) {
    await recordStage(db, {
      companyId: world.companyId, runId, finalizationId: fin.id,
      stageClass: STAGE_CLASS.compensable, stageKind: kind,
      idempotencyKey: `c:${kind}`, state: "done",
    });
  }
  return run!;
}

describeEP("terminal and recovery generation stamping", () => {
  it("increments every run step at terminalization without touching another run", async () => {
    await cleanupTerminalBoundaryTables(db);
    const target = await seedBoundaryWorld(db, { runStatus: "running" });
    const other = await seedBoundaryWorld(db, { runStatus: "running" });
    await finalize(target);
    expect(await generations(target.runId, other.runId)).toEqual([[1], [0]]);
  });

  it("increments again on official recovery and leaves already-consumed retries frozen", async () => {
    await cleanupTerminalBoundaryTables(db);
    const world = await seedBoundaryWorld(db, { runStatus: "running" });
    await finalize(world);
    const reference = crypto.randomUUID();
    const recovered = await recoverTerminalRun(db, {
      runId: world.runId,
      companyId: world.companyId,
      expectedAuthorityVersion: 0,
      expectedDecision: "failed",
      recoveryKind: "manual_resume",
      requestedBy: "board",
      requestReference: reference,
      now: new Date(),
    });
    expect(recovered.kind).toBe("recovered");
    const retry = await recoverTerminalRun(db, {
      runId: world.runId,
      companyId: world.companyId,
      expectedAuthorityVersion: 0,
      expectedDecision: "failed",
      recoveryKind: "manual_resume",
      requestedBy: "board",
      requestReference: reference,
      now: new Date(),
    });
    expect(retry.kind).toBe("already_consumed");
    expect(await generations(world.runId)).toEqual([[2]]);
  });

  it("gracefully settles a late heartbeat whose generation was fenced", async () => {
    await cleanupTerminalBoundaryTables(db);
    const world = await seedBoundaryWorld(db, { runStatus: "running" });
    await finalize(world);
    const run = await seedSettledHeartbeatWithStaleGeneration(world);
    await expect(settleRunIfReady(db, run, new Date())).resolves.toBe("settled");
    const [heartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(heartbeat?.settledAt).not.toBeNull();
    const [stepRun] = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, world.stepRunId));
    expect(stepRun?.executionGeneration).toBe(1);
    expect(stepRun?.dispatchReadyAt).toBeNull();
    const stages = await db.select().from(heartbeatRunFinalizationSteps)
      .where(eq(heartbeatRunFinalizationSteps.heartbeatRunId, run.id));
    expect(stages.length).toBeGreaterThan(0);
    const finalization = await db.select().from(heartbeatRunFinalizations)
      .where(eq(heartbeatRunFinalizations.heartbeatRunId, run.id));
    expect(finalization).toHaveLength(1);
  });
});

describe("structural gate late completion is generation-fenced", () => {
  it("a post-terminal structural completion with the stale generation loses CAS without ledger writes", async () => {
    await cleanupTerminalBoundaryTables(db);
    const world = await seedBoundaryWorld(db, { runStatus: "running" });
    // 구조 게이트 스텝 실행(running) — 관측 세대 0.
    const [gate] = await db.insert(workflowStepRuns).values({
      workflowRunId: world.runId, stepId: "gate", status: "running", issueId: null,
      iterationIndex: 0, lastDispatchRequestId: "req-gen-fence",
    }).returning({ id: workflowStepRuns.id, generation: workflowStepRuns.executionGeneration });
    // 종결 — Worker A 스탬프가 세대를 0→1 로 올린다(상태·requestId 는 그대로).
    const finalized = await finalizeRunTerminal(db, {
      runId: world.runId, companyId: world.companyId, expectedAuthorityVersion: 0,
      decision: "failed", cause: { policy: "recovery_deadline_hard", discovery: "stuck_diagnostic", origin: "reconciler", reason: "gen fence" },
      gatePolicy: "immediate", now: new Date(), stepRuns: [],
    });
    expect(finalized.kind).toBe("finalized");

    const beforeEvents = (await db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents)).length;
    const result = await atomicStructuralCompletion({
      db,
      step: { id: "gate", name: "[QA] Structural gate", agentId: "", type: "tool", qaType: "structural", toolNames: ["validate-contract"], dependencies: [], graphWorkProductRequired: false } as never,
      success: true, data: { verdict: "pass" },
      companyId: world.companyId, workflowRunId: world.runId, workflowStepRunId: gate!.id,
      missionId: world.missionId, issueId: null, requestId: "req-gen-fence",
      producerToken: { producerStepId: "p", iterationIndex: 0, completedAt: new Date().toISOString() },
      observedStatus: "running", observedIterationIndex: 0,
      observedRequestId: "req-gen-fence", observedCompletedAt: null,
      observedExecutionGeneration: gate!.generation,
      patch: { startedAt: new Date(), completedAt: new Date(), metadata: {}, fallbackFailureSummary: null },
    });
    // [봇 bug·medium 재발 방지] 상태·requestId 는 그대로여도 세대가 올랐으면 낡은 완료다.
    expect(result.casWon).toBe(false);
    expect((await db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents)).length).toBe(beforeEvents);
    const [row] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, gate!.id));
    expect(row?.status).toBe("running");
  });
});

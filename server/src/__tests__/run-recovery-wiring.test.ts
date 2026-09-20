// [purpose] run-recovery-service v1 배선 회귀 — resume/이슈없는 재시도/언블록 해결이 공식
//   복구(1회 소비·권한버전 검증)를 경유하는지, 플래그 off 는 기존 경로를 유지하는지.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  instanceSettings,
  issues,
  missions,
  workflowDefinitions,
  workflowRecoveryAuthorities,
  workflowRuns,
  workflowStepRuns,
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
  type BoundaryWorld,
} from "./helpers/run-terminal-boundary-fixture.js";
import { runOf, setRunRecoveryFlags } from "./helpers/run-reopen-guard-fixture.js";
import { testWake } from "./helpers/cap-override-fixtures.js";
import { finalizeRunTerminal } from "../services/workflow/run-terminal-boundary.js";
import { resumeWorkflowRun } from "../services/workflow/workflow-store.js";
import { dispatchSourceIssueNativeResume } from "../services/workflow/source-issue-native-resume.js";
import { retryIssueLessToolWorkflowStepInternal } from "../services/workflow/retry-issue-less-manual.js";
import { loadWorkflowExecutionContext } from "../services/workflow/workflow-execution-context.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping run-recovery-wiring tests: ${support.reason ?? "unsupported host"}`);
}

const FAILED_CAUSE = { policy: "recovery_deadline_hard", discovery: "stuck_diagnostic", origin: "reconciler", reason: "wiring contract" } as const;

let db: Db;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

beforeAll(async () => {
  tempDb = await startEmbeddedPostgresTestDatabase("recovery-wiring-");
  db = createDb(tempDb.connectionString);
});

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
  await tempDb.cleanup();
});

async function seedFailedDecisionWorld(): Promise<BoundaryWorld> {
  await cleanupTerminalBoundaryTables(db);
  await setRunRecoveryFlags(db, true, true);
  const world = await seedBoundaryWorld(db, { runStatus: "running" });
  const finalized = await finalizeRunTerminal(db, {
    runId: world.runId, companyId: world.companyId, expectedAuthorityVersion: 0,
    decision: "failed", cause: { ...FAILED_CAUSE }, gatePolicy: "immediate",
    now: new Date(), stepRuns: [],
  });
  expect(finalized.kind).toBe("finalized");
  return world;
}

const authoritiesOf = (runId: string) =>
  db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.workflowRunId, runId));

describeEP("resume wiring", () => {
  it("recovery ON: decision-backed failed resume consumes a manual_resume authority and bumps version", async () => {
    const world = await seedFailedDecisionWorld();
    const resumed = await resumeWorkflowRun(db, world.runId, world.companyId);
    expect(resumed?.status).toBe("running");
    expect((await runOf(db, world.runId))?.dispatchAuthorityVersion).toBe(1);
    const authorities = await authoritiesOf(world.runId);
    expect(authorities).toHaveLength(1);
    expect(authorities[0]?.recoveryKind).toBe("manual_resume");
  });

  it("recovery OFF: same resume keeps the legacy CAS+bump path with zero authority rows", async () => {
    await cleanupTerminalBoundaryTables(db);
    await setRunRecoveryFlags(db, true, false);
    const world = await seedBoundaryWorld(db, { runStatus: "running" });
    const finalized = await finalizeRunTerminal(db, {
      runId: world.runId, companyId: world.companyId, expectedAuthorityVersion: 0,
      decision: "failed", cause: { ...FAILED_CAUSE }, gatePolicy: "immediate", now: new Date(), stepRuns: [],
    });
    expect(finalized.kind).toBe("finalized");
    const resumed = await resumeWorkflowRun(db, world.runId, world.companyId);
    expect(resumed?.status).toBe("running");
    expect((await runOf(db, world.runId))?.dispatchAuthorityVersion).toBe(1);
    expect(await authoritiesOf(world.runId)).toHaveLength(0);
  });

  it("cancelled terminal resume is still refused regardless of the recovery flag", async () => {
    await cleanupTerminalBoundaryTables(db);
    await setRunRecoveryFlags(db, true, true);
    const world = await seedBoundaryWorld(db, { runStatus: "cancelled" });
    await expect(resumeWorkflowRun(db, world.runId, world.companyId)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("workflow_run_resume_not_allowed"),
    });
    expect(await authoritiesOf(world.runId)).toHaveLength(0);
  });
});

describeEP("supervision issue-less retry wiring", () => {
  it("decision-backed failed retry consumes a supervision_tool_retry authority with the retry key", async () => {
    await cleanupTerminalBoundaryTables(db);
    await setRunRecoveryFlags(db, true, true);
    const world = await seedBoundaryWorld(db, { runStatus: "running" });
    // 이슈 없는 도구 스텝(실패) — 감독 재시도 대상 모양. 정의에도 같은 스텝을 둔다
    // (loadWorkflowExecutionContext 는 정의 steps 에서 스텝을 찾는다).
    await db.update(workflowDefinitions).set({
      stepsJson: [{ id: "tool", name: "Tool", agentId: world.agentId, dependencies: [], description: "" }],
    }).where(eq(workflowDefinitions.id, world.workflowId));
    const [toolStep] = await db.insert(workflowStepRuns).values({
      workflowRunId: world.runId, stepId: "tool", status: "failed", issueId: null,
      metadata: {},
    }).returning({ id: workflowStepRuns.id });
    const finalized = await finalizeRunTerminal(db, {
      runId: world.runId, companyId: world.companyId, expectedAuthorityVersion: 0,
      decision: "failed", cause: { ...FAILED_CAUSE }, gatePolicy: "immediate",
      now: new Date(), stepRuns: [],
    });
    expect(finalized.kind).toBe("finalized");

    let synced = 0;
    const result = await retryIssueLessToolWorkflowStepInternal({
      db, companyId: world.companyId, runId: world.runId, stepId: "tool",
      recoveryRequestReference: "supervision-retry-1",
      loadWorkflowExecutionContext: loadWorkflowExecutionContext as never,
      isIssueLessToolStep: () => true,
      resetUnlaunchedTerminalStepRuns: async () => [],
      syncWorkflowRunState: async () => { synced += 1; return { status: "running" } as never; },
    });
    expect(result?.stepRunId).toBe(toolStep!.id);
    expect(synced).toBe(1);
    expect((await runOf(db, world.runId))?.status).toBe("running");
    expect((await runOf(db, world.runId))?.dispatchAuthorityVersion).toBe(1);
    const authorities = await authoritiesOf(world.runId);
    expect(authorities).toHaveLength(1);
    expect(authorities[0]?.recoveryKind).toBe("supervision_tool_retry");
    expect(authorities[0]?.requestReference).toBe("supervision-retry-1");
  });
});

describeEP("source-issue unblock wiring", () => {
  async function seedUnblockWorld(stepMetadata: Record<string, unknown>) {
    await cleanupTerminalBoundaryTables(db);
    await setRunRecoveryFlags(db, true, true);
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const sourceIssueId = randomUUID();
    const stepRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Unblock Co", issuePrefix: `UB${companyId.replace(/-/g, "").slice(0, 6)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Unblock Worker", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "Unblock mission", status: "active", startedAt: new Date() });
    await db.insert(workflowDefinitions).values({
      id: workflowId, companyId, name: "unblock-wf",
      stepsJson: [{ id: "producer", name: "Produce", agentId, dependencies: [], description: "Produce" }],
    });
    await db.insert(workflowRuns).values({
      id: runId, workflowId, companyId, missionId, status: "running", triggeredBy: "test", startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: sourceIssueId, companyId, missionId, identifier: `UB-${randomUUID().slice(0, 6)}`,
      title: "Unblock source issue", status: "done", originKind: "workflow_execution", originRunId: runId,
    });
    await db.insert(workflowStepRuns).values({
      id: stepRunId, workflowRunId: runId, stepId: "producer", issueId: sourceIssueId,
      status: "failed", metadata: stepMetadata,
    });
    const finalized = await finalizeRunTerminal(db, {
      runId, companyId, expectedAuthorityVersion: 0,
      decision: "failed", cause: { ...FAILED_CAUSE }, gatePolicy: "immediate",
      now: new Date(), stepRuns: [],
    });
    expect(finalized.kind).toBe("finalized");
    return { companyId, runId, sourceIssueId, stepRunId };
  }

  it("clear gate: stale unblock cannot revive the finalized run — report_only, zero authority rows", async () => {
    const world = await seedUnblockWorld({});
    const outcome = await dispatchSourceIssueNativeResume(db, {
      companyId: world.companyId, issueId: world.sourceIssueId, wakeFn: testWake(db),
    });
    expect(outcome.kind).toBe("report_only");
    expect((await runOf(db, world.runId))?.status).toBe("failed");
    expect(await authoritiesOf(world.runId)).toHaveLength(0);
  });

  it("wake failure after formal recovery leaves the run running — no mixed-version restore", async () => {
    // [봇 지적 재발 방지 — bug·high] 복구 소비(버전 범프) 후 wake 단계 실패 시 무조건
    //   failed 원상복구하면 결정은 v 에 남고 버전은 v+1 인 혼합 상태가 된다. 복구는
    //   정당했으므로 run 은 running@v+1 로 유지하고 wake 결과만 report_only 로 보고한다.
    const world = await seedUnblockWorld(retryMetadata("waiting", 1, 3, hoursFromNow(1)));
    const outcome = await dispatchSourceIssueNativeResume(db, {
      companyId: world.companyId, issueId: world.sourceIssueId,
      wakeFn: async () => false,
    });
    expect(outcome.kind).toBe("report_only");
    const run = await runOf(db, world.runId);
    expect(run?.status).toBe("running");
    expect(run?.dispatchAuthorityVersion).toBe(1);
    const authorities = await authoritiesOf(world.runId);
    expect(authorities).toHaveLength(1);
  });

  it("open gate (live retry reservation): unblock consumes a source_issue_unblock authority and dispatches", async () => {
    const world = await seedUnblockWorld(retryMetadata("waiting", 1, 3, hoursFromNow(1)));
    const outcome = await dispatchSourceIssueNativeResume(db, {
      companyId: world.companyId, issueId: world.sourceIssueId, wakeFn: testWake(db),
    });
    expect(outcome.kind).toBe("dispatched");
    expect((await runOf(db, world.runId))?.status).toBe("running");
    expect((await runOf(db, world.runId))?.dispatchAuthorityVersion).toBe(1);
    const authorities = await authoritiesOf(world.runId);
    expect(authorities).toHaveLength(1);
    expect(authorities[0]?.recoveryKind).toBe("source_issue_unblock");
    expect(authorities[0]?.requestReference).toBe(world.sourceIssueId);
  });
});

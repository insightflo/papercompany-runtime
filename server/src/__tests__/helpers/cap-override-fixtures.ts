// server/src/__tests__/helpers/cap-override-fixtures.ts
//
// [목적] cap-override 테스트(applied/reject/integration)가 공유하는 embedded-postgres seed fixture.
//   failed run + completed producer(at/beyond cap) + QA back-edge + current official RC verdict +
//   owner-action(mission_main_executor_unblock) + 실제 owner decision comment(issue_comments) 상태를
//   조립한다.
// [😎 teardown] 테스트 간 embedded-postgres start/stop 반복(ECONNRESET/shutting-down 원인) 을 피하기 위해
//   하나의 공유 DB(startCapOverrideTestDb, beforeAll) 에 seed 한다. 테스트 격리는 afterEach row 삭제가
//   아니라 seed 의 randomUUID company/mission/issue 스코프로 보장된다(모든 쿼리가 company-scoped).
//   [😎] wake 가 fire-and-forget executeRun 을 trigger 하므로 afterAll 에서 heartbeat_runs queued/running
//   이 0 이 될 때까지 bounded poll 한 뒤 tempDb.cleanup() 한다(ECONNRESET/shutting-down 원천 차단).
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issueComments, issues,
  missions, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents,
  type Db,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";
import { buildQaCapKey } from "../../services/workflow/source-issue-cap-override.js";
import { wakeExistingWorkflowStepIssue } from "../../services/workflow/dag-engine.js";

type StepRun = typeof workflowStepRuns.$inferSelect;

export const PRODUCER = "produce";
export const QA = "qa-validate";
export const MAX_ITER = 1;
const PRODUCER_COMPLETED = new Date("2026-07-10T00:00:00.000Z");
const QA_RC_AT = new Date("2026-07-10T00:05:00.000Z");
const DECISION_AT = new Date("2026-07-10T00:20:00.000Z");
const RUN_STARTED = new Date("2026-07-09T00:00:00.000Z");
const RUN_COMPLETED = new Date("2026-07-10T00:06:00.000Z");
const PRODUCER_STARTED = new Date("2026-07-09T00:01:00.000Z");
export const PRODUCER_ISSUE_UPDATED_AT = new Date("2026-07-10T00:07:00.000Z");
export const FORWARD_APPLIED_AT = new Date("2026-07-10T00:21:00.000Z");

export interface SharedTestDb { db: Db; cleanup: () => Promise<void>; }

export async function startCapOverrideTestDb(): Promise<SharedTestDb> {
  const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cap-override-");
  const db = createDb(tempDb.connectionString);
  return { db, cleanup: async () => { await tempDb.cleanup(); } };
}

// [😎] wake claims fire async executeRun() (heartbeat.ts) — executeRun 은 heartbeat_run 이 terminal
//   된 뒤에도 후속 작업(stdout log append, final status write)을 잠시 더 한다. 따라서 queued/running
//   이 0 이 된 직후에 cleanup 하면 후속 작업이 죽은 DB 를 쳐 ECONNREFUSED/shutting-down stderr 가 남는다.
//   → queued/running=0 을 짧은 안정화 구간(settleMs) 동안 "연속"으로 확인한 뒤에 cleanup 한다.
//   전체 timeout 초과 시 silent return 없이 throw(실행이 실제로 종료되지 않음을 실패로 드러냄).
//   테스트 격리는 row 삭제가 아니라 seed 의 randomUUID company/issue 스코프(모든 쿼리 company-scoped)로 보장.
export async function drainHeartbeatRuns(db: Db, timeoutMs = 10000, settleMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let zeroSince: number | null = null;
  while (Date.now() < deadline) {
    const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(heartbeatRuns).where(inArray(heartbeatRuns.status, ["queued", "running"]));
    if ((row?.count ?? 0) === 0) {
      if (zeroSince === null) zeroSince = Date.now();
      if (Date.now() - zeroSince >= settleMs) return;   // continuous 0 over the stabilization window
    } else {
      zeroSince = null;                                  // new in-flight work appeared — restart the window
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`drainHeartbeatRuns timed out after ${timeoutMs}ms — in-flight heartbeat execution did not settle (queued/running did not stay at 0)`);
}

export interface SeedOpts {
  producerIteration?: number;
  runStatus?: string;
  producerIssueStatus?: string;
  qaStepRunStatus?: string;
  verdictOrigin?: "workflow_api" | "heartbeat_result";
  verdictObservedAt?: Date;
  verdictKind?: string;
  heartbeatSeed?: boolean;
  producerMetadata?: Record<string, unknown>;
  // owner decision comment variants (authority rejection cases).
  skipDecisionComment?: boolean;
  decisionAuthorAgentId?: string;   // default: owner agent (authorized). override to test wrong author.
  decision?: string;                // default: retry_source_issue. override to test wrong decision.
  decisionCreatedAt?: Date;         // default: after producer completion. override to test stale.
}

export interface Seed {
  companyId: string;
  ownerAgentId: string;
  producerAgentId: string;
  qaAgentId: string;
  missionId: string;
  workflowId: string;
  workflowRunId: string;
  producerIssueId: string;
  qaIssueId: string;
  producerStepRunId: string;
  qaStepRunId: string;
  heartbeatRunId: string;
  ownerActionIssueId: string;
  decisionCommentId: string;
  producerIteration: number;
  runInitialStatus: string;
  producerIssueInitialStatus: string;
  producerMetadata: Record<string, unknown>;
}

export async function seedCapExhaustedRun(db: Db, overrides: SeedOpts = {}): Promise<Seed> {
  const companyId = randomUUID();
  const ownerAgentId = randomUUID();
  const producerAgentId = randomUUID();
  const qaAgentId = randomUUID();
  const missionId = randomUUID();
  const workflowId = randomUUID();
  const workflowRunId = randomUUID();
  const producerIssueId = randomUUID();
  const qaIssueId = randomUUID();
  const producerStepRunId = randomUUID();
  const qaStepRunId = randomUUID();
  const heartbeatRunId = randomUUID();
  const ownerActionIssueId = randomUUID();
  const decisionCommentId = randomUUID();
  const issuePrefix = "CO" + companyId.replace(/-/g, "").slice(0, 6).toUpperCase();

  await db.insert(companies).values({ id: companyId, name: "Cap Override Co", issuePrefix, requireBoardApprovalForNewAgents: false });
  await db.insert(agents).values([
    { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    { id: producerAgentId, companyId, name: "Producer Agent", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    { id: qaAgentId, companyId, name: "QA Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
  ]);
  await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Cap override mission", status: "active" });
  await db.insert(workflowDefinitions).values({
    id: workflowId, companyId, name: "cap-override-loop",
    stepsJson: [
      { id: PRODUCER, name: "Produce artifact", agentId: producerAgentId, dependencies: [], conditionalDependencies: [{ stepId: QA, when: "qa_request_changes", isBackEdge: true, maxIterations: MAX_ITER }], description: "Produce the artifact" },
      { id: QA, name: "[QA] Validate the produced artifact", agentId: qaAgentId, dependencies: [PRODUCER], description: "QA gate" },
    ],
  });
  await db.insert(workflowRuns).values({
    id: workflowRunId, workflowId, companyId, missionId, triggeredBy: "system",
    status: overrides.runStatus ?? "failed", startedAt: RUN_STARTED, completedAt: RUN_COMPLETED,
  });
  await db.insert(issues).values([
    { id: producerIssueId, companyId, missionId, title: "Produce artifact", status: overrides.producerIssueStatus ?? "todo", assigneeAgentId: producerAgentId, originKind: "workflow_execution", originRunId: workflowRunId, startedAt: PRODUCER_STARTED, completedAt: PRODUCER_COMPLETED, updatedAt: PRODUCER_ISSUE_UPDATED_AT },
    { id: qaIssueId, companyId, missionId, title: "[QA] Validate", status: "done", assigneeAgentId: qaAgentId, originKind: "workflow_execution", originRunId: workflowRunId, startedAt: new Date("2026-07-10T00:00:01.000Z") },
  ]);
  await db.insert(workflowStepRuns).values([
    { id: producerStepRunId, workflowRunId, stepId: PRODUCER, issueId: producerIssueId, status: "completed", iterationIndex: overrides.producerIteration ?? MAX_ITER, startedAt: PRODUCER_STARTED, completedAt: PRODUCER_COMPLETED, lastDispatchRequestId: "prod-req-1", metadata: overrides.producerMetadata ?? {} },
    { id: qaStepRunId, workflowRunId, stepId: QA, issueId: qaIssueId, status: overrides.qaStepRunStatus ?? "failed", iterationIndex: 0, startedAt: new Date("2026-07-10T00:00:01.000Z"), completedAt: QA_RC_AT, lastDispatchRequestId: "qa-req-1" },
  ]);
  if (overrides.heartbeatSeed !== false) {
    const wakeupId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: wakeupId, companyId, agentId: qaAgentId, source: "workflow.dispatch", status: "completed", workflowStepRunId: qaStepRunId, issueId: qaIssueId, reason: "workflow_step_runnable", requestKind: "workflow_resume", requestedAt: QA_RC_AT });
    await db.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId, agentId: qaAgentId, issueId: qaIssueId, status: "succeeded", wakeupRequestId: wakeupId, startedAt: QA_RC_AT, finishedAt: QA_RC_AT, createdAt: QA_RC_AT });
  }
  // current official QA request_changes verdict (workflow_api source, heartbeatRunId bound).
  await db.insert(workflowTransitionEvents).values({
    companyId, missionId, workflowRunId, workflowStepRunId: qaStepRunId, issueId: qaIssueId, heartbeatRunId: overrides.heartbeatSeed === false ? null : heartbeatRunId,
    eventType: "workflow_validation_verdict", layer: "workflow_validation", verdict: "request_changes", decision: "request_changes",
    reason: overrides.verdictOrigin ?? "workflow_api", reasonCode: overrides.verdictOrigin ?? "workflow_api", createdAt: overrides.verdictObservedAt ?? QA_RC_AT,
    payload: { kind: overrides.verdictKind ?? "workflow_validation_verdict", workflowRunId, stepRunId: qaStepRunId, issueId: qaIssueId, verdict: "request_changes", diagnostics: ["fix the gaps"] },
  });
  const capKey = buildQaCapKey({ companyId, workflowRunId, producerStepId: PRODUCER, qaStepId: QA, producerIteration: overrides.producerIteration ?? MAX_ITER, producerCompletedAt: PRODUCER_COMPLETED });
  // owner-action issue: originKind=mission_main_executor_unblock, assignee=mission owner, marker in description.
  await db.insert(issues).values({
    id: ownerActionIssueId, companyId, missionId, title: "Owner retry unblock", status: "done",
    description: `QA cap handoff\nqa-cap-key:${capKey}`,
    originKind: "mission_main_executor_unblock", originId: qaIssueId, assigneeAgentId: ownerAgentId, startedAt: new Date("2026-07-10T00:10:00.000Z"),
  });
  // [authority] real owner decision comment(issue_comments) on the owner-action issue — retry_source_issue,
  //   authored by the mission owner, post-dating the cap handoff. cap-override validates this comment by ID.
  if (!overrides.skipDecisionComment) {
    const decisionValue = overrides.decision ?? "retry_source_issue";
    await db.insert(issueComments).values({
      id: decisionCommentId, companyId, issueId: ownerActionIssueId, authorAgentId: overrides.decisionAuthorAgentId ?? ownerAgentId,
      createdAt: overrides.decisionCreatedAt ?? DECISION_AT,
      body: [
        "### Mission owner decision",
        `Decision: ${decisionValue}`,
        `Source issue: ${producerIssueId}`,
        "Reason: QA cap exhausted; one more producer retry is warranted.",
        "Next action: retry the producer beyond the QA rework cap.",
        "Evidence: current official request_changes verdict + qa-cap-key handoff marker.",
      ].join("\n"),
    });
  }
  return {
    companyId, ownerAgentId, producerAgentId, qaAgentId, missionId, workflowId, workflowRunId,
    producerIssueId, qaIssueId, producerStepRunId, qaStepRunId, heartbeatRunId, ownerActionIssueId,
    decisionCommentId,
    producerIteration: overrides.producerIteration ?? MAX_ITER,
    runInitialStatus: overrides.runStatus ?? "failed",
    producerIssueInitialStatus: overrides.producerIssueStatus ?? "todo",
    producerMetadata: overrides.producerMetadata ?? {},
  };
}

export async function reloadRun(db: Db, runId: string) {
  const [row] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
  return row!;
}
export async function reloadStepRun(db: Db, runId: string, stepId: string): Promise<StepRun> {
  const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
  return rows.find((r) => r.stepId === stepId)!;
}
export async function auditEvents(db: Db, companyId: string) {
  return db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.companyId, companyId), eq(workflowTransitionEvents.eventType, "owner_cap_override_retry"))).orderBy(desc(workflowTransitionEvents.createdAt));
}
export function capOwnerAction(seed: Seed, decisionCommentId: string = seed.decisionCommentId) {
  return { ownerActionIssueId: seed.ownerActionIssueId, missionId: seed.missionId, decisionCommentId };
}
// [test isolation] no-spawn wake: production wakeExistingWorkflowStepIssue 를 대체해 codex spawn 없이 exact-key
// agentWakeupRequests row(queued, requestKind=workflow_resume, run/stepRun/issue bind) 만 생성한다. test 주입 전용.
export function testWake(db: Db): typeof wakeExistingWorkflowStepIssue {
  return async (input) => {
    const agentId = (input.step as { agentId?: string }).agentId;
    if (!agentId) return false;
    // input.db may be the fenced transaction DB; use it so wake row + accepted mark share one tx.
    const wakeDb = input.db as unknown as Db;
    await wakeDb.insert(agentWakeupRequests).values({ companyId: input.run.companyId, agentId, source: "test.wake", status: "queued", reason: "workflow_step_runnable", requestKind: "workflow_resume", workflowRunId: input.run.id, workflowStepRunId: input.stepRunId ?? null, issueId: input.issueId, idempotencyKey: input.idempotencyKey ?? null, requestedAt: new Date() });
    return true;
  };
}

// production basePayload identity 와 동일한 audit payload(recovery identity fail-closed 통과용).
export function buildCapOverrideAuditPayload(seed: Seed, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "owner_cap_override_retry",
    status: "pending",
    ownerActionIssueId: seed.ownerActionIssueId,
    decisionCommentId: seed.decisionCommentId,
    missionId: seed.missionId,
    missionOwnerAgentId: seed.ownerAgentId,
    workflowRunId: seed.workflowRunId,
    workflowDefinitionId: seed.workflowId,
    producerIssueId: seed.producerIssueId,
    producerStepId: PRODUCER,
    producerStepRunId: seed.producerStepRunId,
    qaStepId: QA,
    qaStepRunId: seed.qaStepRunId,
    fromIteration: seed.producerIteration,
    toIteration: seed.producerIteration + 1,
    cap: MAX_ITER,
    generation: seed.producerIteration,
    producerCleanedMetadata: {},
    dispatchEpoch: 0,
    wakeIdempotencyKey: `cap-override-wake:${seed.decisionCommentId}`,
    verdictHeartbeatRunId: seed.heartbeatRunId,
    producerCompletedAt: PRODUCER_COMPLETED.toISOString(),
    forwardedIssueUpdatedAt: FORWARD_APPLIED_AT.toISOString(),
    priorSnapshot: {
      run: { id: seed.workflowRunId, status: seed.runInitialStatus, startedAt: RUN_STARTED.toISOString(), completedAt: RUN_COMPLETED.toISOString() },
      stepRun: {
        id: seed.producerStepRunId,
        status: "completed",
        iterationIndex: seed.producerIteration,
        startedAt: PRODUCER_STARTED.toISOString(),
        completedAt: PRODUCER_COMPLETED.toISOString(),
        lastDispatchAttemptAt: null,
        lastDispatchAcceptedAt: null,
        lastDispatchErrorAt: null,
        lastDispatchErrorSummary: null,
        lastDispatchRequestId: "prod-req-1",
        metadata: seed.producerMetadata,
      },
      issue: {
        id: seed.producerIssueId,
        status: seed.producerIssueInitialStatus,
        completedAt: PRODUCER_COMPLETED.toISOString(),
        updatedAt: PRODUCER_ISSUE_UPDATED_AT.toISOString(),
      },
    },
    ...overrides,
  };
}

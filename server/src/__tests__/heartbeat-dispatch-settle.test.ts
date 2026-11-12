import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentWakeupRequests,
  heartbeatRuns,
  issueComments,
  issues,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import {
  applySigner,
  resetReviewedPolicies,
  seedResumeApplyScenario,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
  type RawSql,
  type ResumeApplyScenario,
} from "./helpers/workflow-resume-apply-fixture.js";
import { settleDispatchBoundTerminalFailure } from "../services/heartbeat-dispatch-settle.js";
import { previewResume } from "../services/workflow/resume/preview.js";

/** [목적] 결함-1 수정 검증 — issue+step 바인딩 디스패치 런의 종말 실패(재시도 소진)가
 *  스텝 failed 전이 + 이슈 blocked 정산을 만들고, 정산 후 resume preview 가 열리는지 증명.
 *  reviewed-policy manifest 만 모듈 경계 fixture(기존 패턴 동일), 나머지는 실제 모듈/실DB. */

vi.mock("../services/workflow/resume/reviewed-policy.js", async () => {
  const helper = await import("./helpers/workflow-resume-apply-fixture.js");
  return { REVIEWED_RESUME_POLICIES: helper.TEST_REVIEWED_POLICIES };
});

const describeEmbeddedPostgres = (await getEmbeddedPostgresTestSupport()).supported ? describe : describe.skip;
const NOW = new Date("2026-09-08T01:00:00.000Z");
const scopeOf = (scenario: ResumeApplyScenario, startStepId = "gate") => ({
  companyId: scenario.companyId,
  missionId: scenario.missionId,
  workflowRunId: scenario.runId,
  startStepId,
});

type BoundScenario = {
  issue: typeof issues.$inferSelect;
  wakeup: typeof agentWakeupRequests.$inferSelect;
  run: typeof heartbeatRuns.$inferSelect;
};

async function seedBoundFailure(db: Db, scenario: ResumeApplyScenario, overrides: {
  issueStatus?: string;
  runStatus?: string;
  unbindRun?: boolean;
} = {}): Promise<BoundScenario> {
  const [issue] = await db.insert(issues).values({
    companyId: scenario.companyId,
    missionId: scenario.missionId,
    title: "Dispatch-bound step issue",
    status: overrides.issueStatus ?? "in_progress",
    assigneeAgentId: scenario.agentId,
  }).returning();
  const [wakeup] = await db.insert(agentWakeupRequests).values({
    companyId: scenario.companyId,
    agentId: scenario.agentId,
    source: "workflow.dispatch",
    status: "failed",
    workflowStepRunId: scenario.stepRunIds.redo,
  }).returning();
  // 재시도 소진 직전 상태 재현: 스텝 running + 오너 참조 살아있음(종말 웨이크업/런을 가리킴).
  await db.update(workflowStepRuns).set({
    status: "running",
    issueId: issue!.id,
    startedAt: new Date("2026-09-07T09:30:00.000Z"),
    dispatchOwnerWakeupRequestId: wakeup!.id,
    dispatchOwnerHeartbeatRunId: null,
  }).where(eq(workflowStepRuns.id, scenario.stepRunIds.redo));
  const [run] = await db.insert(heartbeatRuns).values({
    companyId: scenario.companyId,
    agentId: scenario.agentId,
    status: overrides.runStatus ?? "failed",
    startedAt: new Date("2026-09-07T09:31:00.000Z"),
    finishedAt: new Date("2026-09-07T09:35:00.000Z"),
    error: "HTTP 429: adapter quota exhausted after retries",
    issueId: overrides.unbindRun ? null : issue!.id,
    workflowStepRunId: overrides.unbindRun ? null : scenario.stepRunIds.redo,
  }).returning();
  await db.update(workflowStepRuns).set({ dispatchOwnerHeartbeatRunId: run!.id })
    .where(eq(workflowStepRuns.id, scenario.stepRunIds.redo));
  return { issue: issue!, wakeup: wakeup!, run: run! };
}

describeEmbeddedPostgres("heartbeat dispatch-bound terminal settle", () => {
  let fixture: ExecutionDefinitionFixture;
  let db: Db;
  let sql: RawSql;

  beforeAll(async () => {
    fixture = await startExecutionDefinitionFixture("dispatch-settle-");
    if (!fixture.supported) throw new Error(fixture.reason);
    db = fixture.db;
    sql = fixture.sql;
  }, 60_000);
  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });
  beforeEach(() => {
    resetReviewedPolicies();
  });

  it("pre-fix blocks preview; after settle step failed + issue blocked + resume preview eligible", async () => {
    const scenario = await seedResumeApplyScenario(db, sql, "settle-429-");
    const bound = await seedBoundFailure(db, scenario);

    // 수정 전 상태 재현 — 실패 직후 시각(임계 무활동 미달): 스텝 running → preview 는
    //   active_work 로 봉쇄된다(사고 당시의 chicken-and-egg 그대로).
    const justFailed = new Date("2026-09-07T09:36:00.000Z");
    const before = await previewResume(db, scopeOf(scenario), applySigner(justFailed));
    expect(before.preview.eligible).toBe(false);
    expect(before.preview.blockers.some((b) => b.code === "active_work")).toBe(true);

    await settleDispatchBoundTerminalFailure({ db, run: bound.run });

    const step = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, scenario.stepRunIds.redo)).then((rows) => rows[0]!);
    expect(step.status).toBe("failed");
    expect(step.completedAt).not.toBeNull();
    expect(step.dispatchOwnerWakeupRequestId).toBeNull();
    expect(step.dispatchOwnerHeartbeatRunId).toBeNull();
    expect(step.lastDispatchErrorSummary).toContain("429");

    const transitions = await db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.workflowStepRunId, step.id));
    expect(transitions.some((t) => t.toStatus === "failed" && t.heartbeatRunId === bound.run.id)).toBe(true);

    const issue = await db.select().from(issues).where(eq(issues.id, bound.issue.id)).then((r) => r[0]!);
    expect(issue.status).toBe("blocked");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id));
    expect(comments).toHaveLength(1);
    const activities = await db.select().from(activityLog)
      .where(eq(activityLog.entityId, issue.id));
    expect(activities.some((a) => a.action === "issue.run_failure_auto_blocked" && a.runId === bound.run.id)).toBe(true);

    // 종말 전이 후 설계된 재개 경로가 동작한다 — 같은 "실패 직후" 시각에도
    //   (stuck 임계 대기 없이) preview 가 곧바로 eligible 이 된다.
    const after = await previewResume(db, scopeOf(scenario), applySigner(justFailed));
    expect(after.preview.eligible).toBe(true);
    expect(after.preview.token).toBeTruthy();
  });

  it("is a no-op for succeeded and unbound runs, and leaves in_review issues untouched", async () => {
    const scenario = await seedResumeApplyScenario(db, sql, "settle-noop-");
    const ok = await seedBoundFailure(db, scenario, { runStatus: "succeeded" });
    await settleDispatchBoundTerminalFailure({ db, run: ok.run });
    let issue = await db.select().from(issues).where(eq(issues.id, ok.issue.id)).then((r) => r[0]!);
    expect(issue.status).toBe("in_progress");
    let step = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, scenario.stepRunIds.redo)).then((r) => r[0]!);
    expect(step.status).toBe("running");

    const detached = await seedBoundFailure(db, scenario, { unbindRun: true });
    await settleDispatchBoundTerminalFailure({ db, run: detached.run });
    issue = await db.select().from(issues).where(eq(issues.id, detached.issue.id)).then((r) => r[0]!);
    expect(issue.status).toBe("in_progress");

    const review = await seedBoundFailure(db, scenario, { issueStatus: "in_review" });
    await settleDispatchBoundTerminalFailure({ db, run: review.run });
    issue = await db.select().from(issues).where(eq(issues.id, review.issue.id)).then((r) => r[0]!);
    expect(issue.status).toBe("in_review");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id))).toHaveLength(0);
  });

  it("is idempotent: a second settle produces no extra comment or activity row", async () => {
    const scenario = await seedResumeApplyScenario(db, sql, "settle-idem-");
    const bound = await seedBoundFailure(db, scenario);
    await settleDispatchBoundTerminalFailure({ db, run: bound.run });
    await settleDispatchBoundTerminalFailure({ db, run: bound.run });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, bound.issue.id))).toHaveLength(1);
    const activities = await db.select().from(activityLog).where(eq(activityLog.entityId, bound.issue.id));
    expect(activities.filter((a) => a.runId === bound.run.id)).toHaveLength(1);
    const transitions = await db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.workflowStepRunId, scenario.stepRunIds.redo));
    expect(transitions.filter((t) => t.toStatus === "failed")).toHaveLength(1);
  });
});

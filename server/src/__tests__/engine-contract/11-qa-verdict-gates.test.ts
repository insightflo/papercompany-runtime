// engine-contract S21·S22 — QA 판정(verdict) 기록·재오픈 차단 계약 (#416·#118 회귀).
// 판정 권위는 workflow_transition_events 의 공식 이벤트뿐이다: originKind/stepRun/heartbeat
// 바인딩을 갖춘 후보만 기록되고, 재오픈(recheck)은 생산자 완료가 판정 이후일 때만 발화한다.
// seed: 순수 DB 행 → entry: recordWorkflowValidationVerdict / syncWorkflowRunState
// → assert: workflow_transition_events / agent_wakeup_requests / activity_log 최종 행만.
import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  issues,
  missions,
  workflowStepRuns,
  workflowTransitionEvents,
  type Db,
} from "@paperclipai/db";
import { recordWorkflowValidationVerdict } from "../../services/workflow/validation-verdict-ledger.js";
import { syncWorkflowRunState } from "../../services/workflow/dag-engine.js";
import {
  MIN,
  describeEP,
  seedHeartbeatRun,
  seedWorkflow,
  startContractDb,
  type ContractDb,
} from "./helpers.js";

let w: ContractDb;

beforeAll(async () => {
  w = await startContractDb("contract-qa-verdict-", { finalizationV1: true });
}, 120_000);

afterAll(async () => {
  await w.temp.cleanup();
});

const T0 = new Date(Date.now() - 3 * 60 * MIN);
const TV = new Date(Date.now() - 2 * 60 * MIN);

/** 생산자 step → QA step 1-hop 토폴로지: definition/run + done 이슈 2개 + step run 2개 + 판정 이벤트·heartbeat. */
async function seedQaReworkWorld(db: Db, input: { producerCompletedAt: Date }) {
  const [mission] = await db.insert(missions).values({
    companyId: w.companyId, title: "qa-gate mission", status: "active", ownerAgentId: w.agentId,
  }).returning();
  const producerStepId = `produce-${mission.id.slice(0, 8)}`;
  const qaStepId = `qa-${mission.id.slice(0, 8)}`;
  // isQaLikeStep 은 title/name 이 아니라 type/qaType 필드만 본다.
  const steps = [
    { id: producerStepId, name: "Produce", agentId: w.agentId, dependencies: [] as string[] },
    { id: qaStepId, type: "qa", name: "[QA] Review", agentId: w.agentId, dependencies: [producerStepId] },
  ];
  const wf = await seedWorkflow(db, {
    companyId: w.companyId,
    missionId: mission.id,
    steps,
  });
  const [producerIssue] = await db.insert(issues).values({
    companyId: w.companyId, missionId: mission.id, title: "Produce", status: "done",
    assigneeAgentId: w.agentId, originKind: "workflow_execution", originRunId: wf.run.id,
    startedAt: T0, completedAt: input.producerCompletedAt,
  }).returning();
  const [qaIssue] = await db.insert(issues).values({
    companyId: w.companyId, missionId: mission.id, title: "[QA] Review", status: "done",
    assigneeAgentId: w.agentId, originKind: "workflow_execution", originRunId: wf.run.id,
    startedAt: T0, completedAt: TV,
  }).returning();
  const [producerStepRun, qaStepRun] = await db.insert(workflowStepRuns).values([
    {
      workflowRunId: wf.run.id, stepId: producerStepId, status: "completed",
      issueId: producerIssue.id, iterationIndex: 1, startedAt: T0,
      completedAt: input.producerCompletedAt, metadata: {},
    },
    {
      workflowRunId: wf.run.id, stepId: qaStepId, status: "failed",
      issueId: qaIssue.id, iterationIndex: 0, startedAt: T0, completedAt: TV, metadata: {},
    },
  ]).returning();
  const verdictRun = await seedHeartbeatRun(db, {
    companyId: w.companyId, agentId: w.agentId, issueId: qaIssue.id,
    status: "succeeded", createdAt: new Date(TV.getTime() - MIN), updatedAt: TV,
    finishedAt: TV,
  });
  const [verdictEvent] = await db.insert(workflowTransitionEvents).values({
    companyId: w.companyId, missionId: mission.id, workflowRunId: wf.run.id,
    workflowStepRunId: qaStepRun!.id, issueId: qaIssue.id, heartbeatRunId: verdictRun.id,
    eventType: "workflow_validation_verdict", layer: "workflow_validation",
    verdict: "request_changes", decision: "request_changes",
    reason: "workflow_api", reasonCode: "workflow_api",
    idempotencyKey: `contract-qa-verdict:${qaIssue.id}`,
    payload: { kind: "workflow_validation_verdict", verdict: "request_changes" },
    createdAt: TV,
  }).returning();
  return { mission, wf, producerIssue, qaIssue, producerStepRun, qaStepRun, verdictRun, verdictEvent };
}

describeEP("engine-contract S21/S22 — QA verdict record & recheck gate", () => {
  it("S21: workflow_execution 후보는 공식 verdict 이벤트를 남기고 비후보는 기록되지 않는다", async () => {
    // PASS: workflow_execution 이슈 + stepRun 바인딩 + 이슈 스코프 heartbeat → 기록 수용.
    const seeded = await seedQaReworkWorld(w.db, { producerCompletedAt: TV });
    const { qaIssue } = seeded;
    const verdictRun = await seedHeartbeatRun(w.db, {
      companyId: w.companyId, agentId: w.agentId, issueId: qaIssue.id,
      status: "running",
    });

    const result = await recordWorkflowValidationVerdict({
      db: w.db, issue: qaIssue, verdict: "request_changes", source: "workflow_api",
      actorAgentId: w.agentId, heartbeatRunId: verdictRun.id, sourceText: "needs rework",
    });
    expect(result.isCandidate).toBe(true);
    expect(result.satisfied).toBe(true);
    expect(result.verdict).toBe("request_changes");

    const events = await w.db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.issueId, qaIssue.id),
      eq(workflowTransitionEvents.heartbeatRunId, verdictRun.id),
    ));
    expect(events.length).toBe(1);
    const event = events[0]!;
    expect(event.eventType).toBe("workflow_validation_verdict");
    expect(event.layer).toBe("workflow_validation");
    expect(event.reason).toBe("workflow_api");
    expect(event.verdict).toBe("request_changes");
    expect(event.workflowRunId).toBe(seeded.wf.run.id);
    expect(event.workflowStepRunId).toBe(seeded.qaStepRun!.id);
    expect(event.idempotencyKey).toContain(`workflow-validation-verdict:${w.companyId}:${qaIssue.id}:${seeded.qaStepRun!.id}:run:${verdictRun.id}`);

    // FAIL: manual origin 이슈(stepRun 없음)는 후보가 아니다 — 판정은 기록되지 않는다.
    const [manualIssue] = await w.db.insert(issues).values({
      companyId: w.companyId, missionId: seeded.mission.id, title: "manual note",
      status: "done", assigneeAgentId: w.agentId, originKind: "manual",
    }).returning();
    const rejected = await recordWorkflowValidationVerdict({
      db: w.db, issue: manualIssue, verdict: "pass", source: "workflow_api",
      actorAgentId: w.agentId, heartbeatRunId: verdictRun.id,
    });
    expect(rejected.isCandidate).toBe(false);
    expect(rejected.satisfied).toBe(false);
    expect(rejected.verdict).toBeNull();
    const manualEvents = await w.db.select().from(workflowTransitionEvents).where(
      eq(workflowTransitionEvents.issueId, manualIssue.id),
    );
    expect(manualEvents.length).toBe(0);
  });

  it("S22: 생산자 완료가 판정 이후면 recheck 웨이크가 큐잉되고 판정 이전이면 차단된다", async () => {
    // PASS: 생산자 재완료가 request_changes 관측 이후 → 공식 재점검 웨이크 발화(재오픈 허가).
    const fresh = await seedQaReworkWorld(w.db, {
      producerCompletedAt: new Date(Date.now() - 60 * MIN),
    });
    await syncWorkflowRunState(w.db, fresh.wf.run.id, "workflow_sync");

    const wakes = await w.db.select().from(agentWakeupRequests).where(
      eq(agentWakeupRequests.issueId, fresh.qaIssue.id),
    );
    expect(wakes.length).toBeGreaterThanOrEqual(1);
    expect(wakes.some((wake) => wake.payload?.mutation === "workflow_resume")).toBe(true);
    const recheckLogs = await w.db.select().from(activityLog).where(and(
      eq(activityLog.companyId, w.companyId),
      eq(activityLog.action, "workflow.validation_recheck_queued"),
      eq(activityLog.entityId, fresh.qaIssue.id),
    ));
    expect(recheckLogs.length).toBe(1);

    // FAIL: 생산자 완료가 판정 이전(소비된 판정)이면 recheck 는 발화하지 않는다(재오픈 차단).
    const stale = await seedQaReworkWorld(w.db, {
      producerCompletedAt: new Date(T0.getTime() + MIN),
    });
    await syncWorkflowRunState(w.db, stale.wf.run.id, "workflow_sync");

    const staleWakes = await w.db.select().from(agentWakeupRequests).where(
      eq(agentWakeupRequests.issueId, stale.qaIssue.id),
    );
    expect(staleWakes.length).toBe(0);
    const staleLogs = await w.db.select().from(activityLog).where(and(
      eq(activityLog.companyId, w.companyId),
      eq(activityLog.action, "workflow.validation_recheck_queued"),
      eq(activityLog.entityId, stale.qaIssue.id),
    ));
    expect(staleLogs.length).toBe(0);
  });
});

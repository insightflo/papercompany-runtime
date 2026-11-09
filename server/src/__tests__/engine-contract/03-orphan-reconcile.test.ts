// engine-contract S04·S05 — workflow orphan close + stuck reconciler liveness 게이트 (#683 회귀).
// seed: 순수 DB 행 → entry: cancelMissionWorkflowRuns / reconcileStuckWorkflowRuns → assert: 최종 DB 행만.
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  issues,
  missions,
  workflowStepInvocations,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import { cancelMissionWorkflowRuns } from "../../services/workflow/workflow-cancellation.js";
import { reconcileStuckWorkflowRuns } from "../../services/workflow/reconciler.js";
import {
  MIN,
  describeEP,
  fetchHeartbeatRun,
  fetchStepRun,
  fetchWorkflowRun,
  seedHeartbeatRun,
  seedWorkflow,
  startContractDb,
  type ContractDb,
} from "./helpers.js";

let w: ContractDb;

beforeAll(async () => {
  w = await startContractDb("contract-orphan-", { finalizationV1: true, runTerminalBoundaryV1: true });
}, 120_000);

afterAll(async () => {
  await w.temp.cleanup();
});

describeEP("engine-contract S04/S05 — orphan close & stuck reconcile (#683)", () => {
  it("S04: 미션 취소는 비종결 run 을 닫고 자식에 전파하며 완료 증거 run 은 보존한다", async () => {
    const [mission] = await w.db
      .insert(missions)
      .values({
        companyId: w.companyId,
        title: "orphan mission",
        status: "active",
        ownerAgentId: w.agentId,
      })
      .returning();

    // 비종결 run A + running step(issue 잠금) + pending step
    const wfA = await seedWorkflow(w.db, {
      companyId: w.companyId,
      missionId: mission.id,
      steps: [
        { id: "a", name: "A", agentId: w.agentId, dependencies: [] },
        { id: "b", name: "B", agentId: w.agentId, dependencies: ["a"] },
      ],
    });
    const [issueA] = await w.db.insert(issues).values({
      companyId: w.companyId,
      missionId: mission.id,
      title: "exec issue A",
      status: "in_progress",
      assigneeAgentId: w.agentId,
      originKind: "workflow_execution",
      originRunId: wfA.run.id,
    }).returning();
    const stepsA = await w.db.insert(workflowStepRuns).values([
      {
        workflowRunId: wfA.run.id, stepId: "a", status: "running", issueId: issueA.id,
        startedAt: new Date(Date.now() - 30 * MIN), metadata: {},
      },
      { workflowRunId: wfA.run.id, stepId: "b", status: "pending", metadata: {} },
    ]).returning();
    await w.db.update(issues)
      .set({ executionRunId: (await seedHeartbeatRun(w.db, {
        companyId: w.companyId, agentId: w.agentId, issueId: issueA.id,
        workflowStepRunId: stepsA[0]!.id, status: "running",
      })).id })
      .where(eq(issues.id, issueA.id));
    await w.db.update(issues).set({ checkoutRunId: issueA.executionRunId }).where(eq(issues.id, issueA.id));

    // 자식 run — 부모 취소가 전파되어야 한다. linked 자식 계약대로 invocation 링크까지 시드.
    const stepB = stepsA.find((s) => s.stepId === "b")!;
    const child = await seedWorkflow(w.db, {
      companyId: w.companyId,
      missionId: mission.id,
      steps: [],
      run: {
        parentRunId: wfA.run.id,
        parentStepRunId: stepB.id,
        triggeredBy: "workflow-step",
        status: "running",
        workflowId: wfA.definition.id,
      },
    });
    await w.db.insert(workflowStepInvocations).values({
      companyId: w.companyId,
      parentStepRunId: stepB.id,
      childRunId: child.run.id,
      state: "linked",
      generation: 1,
      targetWorkflowId: wfA.definition.id,
    });

    // 완료 증거 run B — 취소가 건드리면 안 된다.
    const wfB = await seedWorkflow(w.db, {
      companyId: w.companyId,
      missionId: mission.id,
      steps: [{ id: "a", name: "A", agentId: w.agentId, dependencies: [] }],
      run: { status: "completed", completedAt: new Date(Date.now() - 61 * MIN) },
    });
    const [issueB] = await w.db.insert(issues).values({
      companyId: w.companyId, missionId: mission.id, title: "done issue", status: "done",
      assigneeAgentId: w.agentId, originKind: "workflow_execution", originRunId: wfB.run.id,
      completedAt: new Date(Date.now() - 61 * MIN),
    }).returning();
    const evidenceRun = await seedHeartbeatRun(w.db, {
      companyId: w.companyId, agentId: w.agentId, issueId: issueB.id,
      status: "succeeded", terminalOutcome: "succeeded", resultJson: { ok: true },
      finishedAt: new Date(Date.now() - 61 * MIN), settledAt: new Date(Date.now() - 61 * MIN),
    });

    const result = await cancelMissionWorkflowRuns(w.db, { companyId: w.companyId, missionId: mission.id });
    expect(result.cancelledRunIds).toContain(wfA.run.id);
    expect(result.cancelledRunIds).not.toContain(wfB.run.id);

    const a = await fetchWorkflowRun(w.db, wfA.run.id);
    expect(a.status).toBe("cancelled");
    expect(a.completedAt).not.toBeNull();
    expect((await fetchWorkflowRun(w.db, child.run.id)).status).toBe("cancelled");

    const [ia] = await w.db.select().from(issues).where(eq(issues.id, issueA.id));
    expect(ia.status).toBe("cancelled");
    expect(ia.executionRunId).toBeNull();
    expect(ia.checkoutRunId).toBeNull();

    const b = await fetchWorkflowRun(w.db, wfB.run.id);
    expect(b.status).toBe("completed");
    const evidence = await fetchHeartbeatRun(w.db, evidenceRun.id);
    expect(evidence.status).toBe("succeeded");
    expect(evidence.resultJson).toEqual({ ok: true });

    // 장부: 취소된 run 에만 전이 이벤트, 보존된 run 에는 없다.
    const eventsA = await w.db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.workflowRunId, wfA.run.id));
    expect(eventsA.some((e) => e.reasonCode === "workflow_cancellation")).toBe(true);
    const eventsB = await w.db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.workflowRunId, wfB.run.id));
    expect(eventsB.length).toBe(0);
  });

  it("S05: stuck reconciler — 사망 heartbeat 의 stale step 은 수렴시키고 생존 실행은 보호한다", async () => {
    // 수렴 케이스: running step + 이미 정산된 heartbeat → run 을 failed 로 회수.
    const dead = await seedWorkflow(w.db, {
      companyId: w.companyId,
      steps: [{ id: "a", name: "A", agentId: w.agentId, dependencies: [] }],
      run: { startedAt: new Date(Date.now() - 90 * MIN) },
    });
    const [deadIssue] = await w.db.insert(issues).values({
      companyId: w.companyId, title: "dead step issue", status: "cancelled",
      assigneeAgentId: w.agentId, originKind: "workflow_execution", originRunId: dead.run.id,
    }).returning();
    const [deadStep] = await w.db.insert(workflowStepRuns).values({
      workflowRunId: dead.run.id, stepId: "a", status: "running", issueId: deadIssue.id,
      startedAt: new Date(Date.now() - 85 * MIN), metadata: {},
    }).returning();
    await seedHeartbeatRun(w.db, {
      companyId: w.companyId, agentId: w.agentId, issueId: deadIssue.id,
      workflowStepRunId: deadStep.id, status: "succeeded", terminalOutcome: "succeeded",
      settledAt: new Date(Date.now() - 80 * MIN),
    });

    // 보호 케이스: running step + live heartbeat → reconcile 은 손대지 않는다.
    const live = await seedWorkflow(w.db, {
      companyId: w.companyId,
      steps: [{ id: "a", name: "A", agentId: w.agentId, dependencies: [] }],
      run: { startedAt: new Date(Date.now() - 90 * MIN) },
    });
    const [liveIssue] = await w.db.insert(issues).values({
      companyId: w.companyId, title: "live step issue", status: "in_progress",
      assigneeAgentId: w.agentId, originKind: "workflow_execution", originRunId: live.run.id,
    }).returning();
    const [liveStep] = await w.db.insert(workflowStepRuns).values({
      workflowRunId: live.run.id, stepId: "a", status: "running", issueId: liveIssue.id,
      startedAt: new Date(Date.now() - 85 * MIN), metadata: {},
    }).returning();
    await seedHeartbeatRun(w.db, {
      companyId: w.companyId, agentId: w.agentId, issueId: liveIssue.id,
      workflowStepRunId: liveStep.id, status: "running",
    });

    const results = await reconcileStuckWorkflowRuns(w.db, 60);
    const deadResult = results.find((r) => r.runId === dead.run.id);
    const liveResult = results.find((r) => r.runId === live.run.id);
    expect(deadResult?.action).toBe("recovered");
    expect(liveResult?.action).toBe("skipped");

    expect((await fetchWorkflowRun(w.db, dead.run.id)).status).toBe("failed");
    expect((await fetchWorkflowRun(w.db, dead.run.id)).completedAt).not.toBeNull();
    expect((await fetchWorkflowRun(w.db, live.run.id)).status).toBe("running");
    expect((await fetchStepRun(w.db, liveStep.id)).status).toBe("running");
  });
});

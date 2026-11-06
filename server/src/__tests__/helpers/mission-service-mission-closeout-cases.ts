import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, companies, issueComments, issues, missionPlanArtifacts, missions, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { missionService } from "../../services/missions.js";
import { createMissionOwnerDecisionFixture } from "./mission-owner-decision-fixture.js";

export function registerMissionCloseoutCases(getDb: () => ReturnType<typeof createDb>) {
  const recordOwnerDecision = createMissionOwnerDecisionFixture(getDb);
  it("reuses the canonical owner anchor when an already-applied producer retry leaves the gate blocked", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const onOwnerActionCreated = vi.fn();

    await db.insert(companies).values({ id: companyId, name: "Retry Unresolved Company", issuePrefix: `RU${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: producerAgentId, companyId, name: "Producer Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Retry unresolved mission", status: "active" });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "retry-unresolved-loop",
      stepsJson: [
        { id: "produce", name: "Produce signal analysis", agentId: producerAgentId, dependencies: [] },
        { id: "qa", name: "Inspect signal analysis", agentId: qaAgentId, dependencies: ["produce"] },
      ],
    });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId, triggeredBy: "system", status: "running" });

    const producerIssue = await issueService(db).create(companyId, { assigneeAgentId: producerAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "done", title: "Produce signal analysis" });
    const qaIssue = await issueService(db).create(companyId, { assigneeAgentId: qaAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "blocked", title: "Inspect signal analysis" });
    await db.insert(workflowStepRuns).values([
      { workflowRunId, stepId: "produce", issueId: producerIssue.id, status: "completed", completedAt: new Date("2026-07-06T07:34:00.000Z") },
      { workflowRunId, stepId: "qa", issueId: qaIssue.id, status: "failed", completedAt: new Date("2026-07-06T07:35:00.000Z") },
    ]);
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: qaIssue.id, status: "done", title: "Retry missing signal analysis" });
    await db.update(issues).set({ completedAt: new Date("2026-07-06T07:36:00.000Z") }).where(eq(issues.id, ownerAction.id));
    await db.insert(issueComments).values([
      {
        companyId,
        issueId: ownerAction.id,
        authorAgentId: ownerAgentId,
        body: [
          "### Mission owner decision",
          "Decision: retry_source_issue",
          `Source issue: ${qaIssue.identifier}`,
          `Rework target: ${producerIssue.identifier}`,
          "Reason: producer must provide signal-analysis evidence before QA can complete.",
        ].join("\n"),
      },
      {
        companyId,
        issueId: producerIssue.id,
        authorAgentId: ownerAgentId,
        body: [
          "### Mission owner retry applied",
          `<!-- mission-owner-decision-applied:${JSON.stringify({ ownerActionIssueId: ownerAction.id, sourceIssueId: producerIssue.id, decision: "retry_source_issue" })} -->`,
          "Action: retry_source_issue already reopened this producer once.",
        ].join("\n"),
      },
    ]);
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: ownerAction.id,
      ownerAgentId,
      sourceIssueId: qaIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: qaIssue.identifier ?? qaIssue.id,
        reworkTargetRef: producerIssue.identifier ?? producerIssue.id,
        reason: "producer must provide signal-analysis evidence before QA can complete.",
      },
    });
    await db.insert(workflowTransitionEvents).values({
      companyId,
      missionId,
      issueId: ownerAction.id,
      eventType: "mission_owner_retry_wakeup",
      layer: "mission_owner_recovery",
      decision: "retry_source_issue",
      reason: "owner_recovery_api",
      reasonCode: "owner_recovery_api",
      idempotencyKey: `mission-owner-decision-wakeup:${missionId}:${ownerAction.id}:${producerIssue.id}:retry_source_issue`,
      toStatus: "dispatched",
      payload: { sourceIssueId: producerIssue.id },
    });

    const svc = missionService(db, { onOwnerActionCreated });
    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-07-06T08:00:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });

    expect(result.findings.join("\n")).toContain("owner_action_retry_unresolved_escalated");
    expect(result.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "request_replan", issueId: qaIssue.id, safeToAutoApply: false }),
      expect.objectContaining({ type: "escalate_blocked", issueId: ownerAction.id, safeToAutoApply: false }),
    ]));
    expect(result.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "owner_decision_retry_unresolved",
        ownerActionIssueId: ownerAction.id,
        sourceIssueId: producerIssue.id,
        blockedIssueId: qaIssue.id,
        resultStatus: "todo",
        wakeupDispatchStatus: "not_requested",
      }),
    ]));
    expect(onOwnerActionCreated).toHaveBeenCalledTimes(1);
    const successor = onOwnerActionCreated.mock.calls[0]![0].issue;
    expect(successor.id).not.toBe(ownerAction.id);
    expect(onOwnerActionCreated).toHaveBeenCalledWith(expect.objectContaining({
      sourceIssue: expect.objectContaining({ id: qaIssue.id }), reason: "mission_unblock_action_created",
    }));
    await expect(db.select().from(issues).where(eq(issues.id, ownerAction.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "done", completedAt: new Date("2026-07-06T07:36:00.000Z") }));
    await expect(db.select().from(issues).where(eq(issues.id, producerIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "done" }));
    await expect(db.select().from(issues).where(eq(issues.id, qaIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "blocked" }));
    const ownerActionBody = await db.select().from(issueComments).where(eq(issueComments.issueId, successor.id)).then((rows) => rows.map((row) => row.body).join("\n"));
    expect(ownerActionBody).toContain("mission-owner-retry-unresolved");
    expect(ownerActionBody).toContain("Required next decision");
    expect(await db.select().from(issues).where(and(eq(issues.originKind, "mission_main_executor_unblock"), eq(issues.originId, qaIssue.id), eq(issues.status, "todo")))).toEqual([expect.objectContaining({ id: successor.id })]);
    onOwnerActionCreated.mockClear();
    const second = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-07-06T08:01:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(second.findings.join("\n")).toContain("owner_action_retry_unresolved_already_escalated");
    expect(second.appliedActions).toEqual([]);
    expect(onOwnerActionCreated).not.toHaveBeenCalled();
    const ownerActionBodies = await db.select().from(issueComments).where(eq(issueComments.issueId, successor.id));
    expect(ownerActionBodies.filter((row) => row.body.includes("mission-owner-retry-unresolved"))).toHaveLength(1);
  });

  it("settles an orphaned active mission whose run completed and only the oversight issue remains open", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const completedAt = new Date("2026-08-15T14:40:52.000Z");

    await db.insert(companies).values({ id: companyId, name: "Settlement Orphan Company", issuePrefix: `SO${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Settlement orphan mission", status: "active", startedAt: new Date("2026-08-14T08:00:00.000Z") });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "settle-orphan",
      stepsJson: [
        { id: "produce", name: "Produce report", agentId: workerAgentId, dependencies: [] },
      ],
    });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId, triggeredBy: "system", status: "completed", startedAt: new Date("2026-08-14T08:00:00.000Z"), completedAt });
    const producerIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "done", title: "Produce report" });
    await db.update(issues).set({ completedAt }).where(eq(issues.id, producerIssue.id));
    await db.insert(workflowStepRuns).values([
      { workflowRunId, stepId: "produce", issueId: producerIssue.id, status: "completed", startedAt: new Date("2026-08-14T08:00:00.000Z"), completedAt },
    ]);
    const oversightIssue = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_oversight", status: "todo", title: "[OVERSIGHT] settle-orphan" });

    const svc = missionService(db, {});
    const result = await svc.runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date("2026-08-15T14:50:00.000Z"),
      applySafeActions: true,
      applyOwnerDecisionActions: true,
      dispatchOwnerDecisionWakeups: true,
    });

    // 선택: 실행은 완료됐지만 oversight 만 열려 있으면 settlement 후보로 감독 스윕에 들어와야 한다.
    expect(result.missionIds).toContain(missionId);
    const settledMission = await db.select().from(missions).where(eq(missions.id, missionId)).then((rows) => rows[0]);
    expect(settledMission?.status).toBe("completed");
    const settledOversight = await db.select().from(issues).where(eq(issues.id, oversightIssue.id)).then((rows) => rows[0]);
    expect(settledOversight?.status).toBe("done");
    expect(result.missions[0]?.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "mission_settled_from_workflow_runs", missionId, resultStatus: "completed" }),
    ]));
  });

  it("requests mission closeout once when a terminal workflow run leaves the mission active (closeout bridge)", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const completedAt = new Date("2026-08-15T14:40:52.000Z");
    const onMissionTerminalRunCloseoutWakeRequested = vi.fn();

    await db.insert(companies).values({ id: companyId, name: "Closeout Bridge Company", issuePrefix: `CB${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Closeout bridge mission", status: "active", startedAt: new Date("2026-08-14T08:00:00.000Z") });
    await db.insert(workflowDefinitions).values({
      id: workflowId, companyId, name: "closeout-bridge",
      stepsJson: [{ id: "produce", name: "Produce report", agentId: workerAgentId, dependencies: [] }],
    });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId, triggeredBy: "system", status: "completed", startedAt: new Date("2026-08-14T08:00:00.000Z"), completedAt });
    const producerIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "done", title: "Produce report" });
    await db.update(issues).set({ completedAt }).where(eq(issues.id, producerIssue.id));
    await db.insert(workflowStepRuns).values([
      { workflowRunId, stepId: "produce", issueId: producerIssue.id, status: "completed", startedAt: new Date("2026-08-14T08:00:00.000Z"), completedAt },
    ]);
    await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_oversight", status: "todo", title: "[OVERSIGHT] closeout-bridge" });
    // 열린 비-oversight 이슈 → settlement 차단(종결 브리지가 대신 발동해야 하는 상황).
    await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "todo", title: "Residual open work" });
    // plan 은 아직 running → rule_mismatch + terminal run → closeout bridge.
    await db.insert(missionPlanArtifacts).values({
      companyId, missionId, revision: 1, status: "active", ownerAgentId,
      missionGoal: "Closeout bridge plan", refs: { executionUnits: [{ sourceRef: { type: "native_workflow_run", id: workflowRunId }, status: "running" }] },
      assumptions: [], requiredInputs: [], successCriteria: [], risks: [], steps: [],
    });

    const svc = missionService(db, { onMissionTerminalRunCloseoutWakeRequested });
    const first = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-08-15T14:50:00.000Z"), applySafeActions: true, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });

    expect(first.findings.join("\n")).toContain(`rule_mismatch: plan unit=native_workflow_run:${workflowRunId} status=running runtime_status=completed`);
    expect(first.findings.join("\n")).toContain(`workflow_run_terminal_closeout_wake_requested: run=${workflowRunId} status=completed`);
    expect(onMissionTerminalRunCloseoutWakeRequested).toHaveBeenCalledTimes(1);
    expect(onMissionTerminalRunCloseoutWakeRequested).toHaveBeenCalledWith(expect.objectContaining({
      run: { id: workflowRunId, status: "completed" },
      planUnitKey: `native_workflow_run:${workflowRunId}`,
    }));
    // mission 은 여전히 active(열린 owner work) — 종결은 오너 몫.
    await expect(db.select().from(missions).where(eq(missions.id, missionId)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "active" }));

    // 멱등: 두 번째 스윕에는 재발사하지 않는다(마커 클레임).
    const second = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-08-15T14:55:00.000Z"), applySafeActions: true, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(second.findings.join("\n")).not.toContain("workflow_run_terminal_closeout_wake_requested");
    expect(onMissionTerminalRunCloseoutWakeRequested).toHaveBeenCalledTimes(1);
  });
}

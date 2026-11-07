import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, companies, issueComments, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { missionService } from "../../services/missions.js";
import { createMissionOwnerDecisionFixture } from "./mission-owner-decision-fixture.js";

export function registerMissionRetryApplicationCases(getDb: () => ReturnType<typeof createDb>) {
  const recordOwnerDecision = createMissionOwnerDecisionFixture(getDb);
  it("half-applied owner retry (wakeup marker not_requested) re-dispatches instead of stalling forever", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({ status: "dispatched", runId: "run-1" });

    await db.insert(companies).values({ id: companyId, name: "Half Applied Company", issuePrefix: `HA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: producerAgentId, companyId, name: "Producer Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Half applied retry mission", status: "active" });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "half-applied-loop",
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
    await db.insert(issueComments).values({
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
    });
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
    const wakeupKey = `mission-owner-decision-wakeup:${missionId}:${ownerAction.id}:${producerIssue.id}:retry_source_issue`;
    // [half-applied] apply marker recorded + wakeup marker recorded with not_requested
    //   (2026-08-15 GAZ ef12d027 stall: native resume could not prove a link, so nothing was dispatched).
    await db.insert(workflowTransitionEvents).values([
      {
        companyId,
        missionId,
        issueId: ownerAction.id,
        eventType: "mission_owner_retry_apply",
        layer: "mission_owner_recovery",
        decision: "retry_source_issue",
        reason: "owner_recovery_api",
        reasonCode: "owner_recovery_api",
        idempotencyKey: `${wakeupKey}:apply`,
        toStatus: "done",
        payload: { sourceIssueId: producerIssue.id },
      },
      {
        companyId,
        missionId,
        issueId: ownerAction.id,
        eventType: "mission_owner_retry_wakeup",
        layer: "mission_owner_recovery",
        decision: "retry_source_issue",
        reason: "owner_recovery_api",
        reasonCode: "owner_recovery_api",
        idempotencyKey: wakeupKey,
        toStatus: "not_requested",
        payload: { sourceIssueId: producerIssue.id },
      },
    ]);

    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-07-06T08:00:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });

    // 핵심: not_requested 마커는 '이미 적용됨'이 아니다 — 재발사가 일어나야 한다.
    expect(result.findings.join("\n")).not.toContain("owner_action_decision_already_applied");
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledTimes(1);
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledWith(expect.objectContaining({
      targetAgentId: producerAgentId,
      idempotencyKey: wakeupKey,
    }));
    expect(result.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "owner_decision_retry_source_issue",
        ownerActionIssueId: ownerAction.id,
        sourceIssueId: producerIssue.id,
        wakeupDispatchStatus: "dispatched",
      }),
    ]));
    // dispatch-only: 반쪽 적용 상태에선 apply(reopen/재코멘트)를 반복하지 않는다.
    await expect(db.select().from(issues).where(eq(issues.id, producerIssue.id)).then((rows) =>rows[0])).resolves.toEqual(expect.objectContaining({ status: "done" }));

    // 수렴: 발사 마커가 dispatched 로 기록된 뒤엔 재발사하지 않는다.
    onOwnerDecisionRetrySourceIssueApplied.mockClear();
    const second = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-07-06T08:05:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(onOwnerDecisionRetrySourceIssueApplied).not.toHaveBeenCalled();
    expect(second.appliedActions.filter((action) => action.type === "owner_decision_retry_source_issue")).toEqual([]);
  });

  it("applies retry_source_issue with no source assignee but skips explicit wakeup dispatch", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn();
    await db.insert(companies).values({ id: companyId, name: "Retry No Assignee Company", issuePrefix: `RA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "No assignee retry mission", status: "active" });
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const blockedIssue = await issueService(db).create(companyId, { missionId, originKind: "workflow_execution", status: "blocked", title: "Unassigned blocked source" });
    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 10 * 60 * 1000) });
    const unblockIssue = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock")).then((rows) => rows[0]!);
    // [owner-action contract] 이 테스트는 source assignee 없는 케이스 자체가 목적이므로 guard를 우회해 fixture done 처리.
    await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, unblockIssue.id));
    await db.insert(issueComments).values({ companyId, issueId: unblockIssue.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${blockedIssue.identifier}`, "Reason: retry unassigned source"].join("\n") });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: unblockIssue.id,
      ownerAgentId,
      sourceIssueId: blockedIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: blockedIssue.identifier ?? blockedIssue.id,
        reason: "retry unassigned source",
      },
    });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(onOwnerDecisionRetrySourceIssueApplied).not.toHaveBeenCalled();
    expect(result.findings.join("\n")).toContain("source issue has no assignee; wakeup dispatch skipped");
    expect(result.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "owner_decision_retry_source_issue", sourceIssueId: blockedIssue.id, resultStatus: "blocked", wakeupDispatchStatus: "skipped_no_assignee" }),
    ]));
    await expect(db.select().from(issues).where(eq(issues.id, blockedIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "blocked", assigneeAgentId: null }));
    const sourceBody = await db.select().from(issueComments).where(eq(issueComments.issueId, blockedIssue.id)).then((rows) => rows.map((row) => row.body).join("\n"));
    expect(sourceBody).not.toContain("mission-owner-decision-applied");
    expect(sourceBody).not.toContain("mission-owner-decision-wakeup-dispatched");
  });

  it("does not mutate or dispatch missing, cross-mission, terminal, or hidden retry_source_issue sources", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const otherMissionId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn(), onOwnerActionCreated = vi.fn();
    await db.insert(companies).values({ id: companyId, name: "Retry Safety Company", issuePrefix: `RS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([{ id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }, { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }]);
    await db.insert(missions).values([{ id: missionId, companyId, ownerAgentId, title: "Retry safety mission", status: "active" }, { id: otherMissionId, companyId, ownerAgentId, title: "Other mission", status: "active" }]);
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied, onOwnerActionCreated });
    const terminalIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "done", title: "Terminal source" });
    const crossMissionIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId: otherMissionId, originKind: "workflow_execution", status: "blocked", title: "Cross mission source" });
    const hiddenIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Hidden source" });
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, hiddenIssue.id));
    for (const [sourceIssue, title] of [[terminalIssue, "Terminal owner action"], [crossMissionIssue, "Cross mission owner action"], [hiddenIssue, "Hidden owner action"]] as const) {
      const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "done", title });
      await db.insert(issueComments).values({ companyId, issueId: ownerAction.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${sourceIssue.identifier}`, "Reason: should not mutate"].join("\n") });
      await recordOwnerDecision({
        companyId,
        missionId,
        ownerActionIssueId: ownerAction.id,
        ownerAgentId,
        sourceIssueId: sourceIssue.id,
        submission: {
          decision: "retry_source_issue",
          sourceIssueRef: sourceIssue.identifier ?? sourceIssue.id,
          reason: "should not mutate",
        },
      });
    }
    const missingSourceId = randomUUID(); const missingOwnerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: missingSourceId, status: "done", title: "Missing owner action" });
    await db.insert(issueComments).values({ companyId, issueId: missingOwnerAction.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${missingSourceId}`, "Reason: should not mutate missing source"].join("\n") });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: missingOwnerAction.id,
      ownerAgentId,
      sourceIssueId: missingSourceId,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: missingSourceId,
        reason: "should not mutate missing source",
      },
    });
    const readSourcesAndAnchors = () => db.select().from(issues).where(eq(issues.companyId, companyId)).orderBy(issues.id).then((rows) => rows.filter((row) => row.originKind !== "mission_main_executor_oversight")); const before = await readSourcesAndAnchors();
    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(result.appliedActions).toEqual([]);
    expect(result.findings.join("\n")).toContain("owner_action_decision_not_applied");
    expect(onOwnerDecisionRetrySourceIssueApplied).not.toHaveBeenCalled(); expect(onOwnerActionCreated).not.toHaveBeenCalled();
    expect(await readSourcesAndAnchors()).toEqual(before);
    await expect(db.select().from(issues).where(eq(issues.id, terminalIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "done", assigneeAgentId: workerAgentId }));
    await expect(db.select().from(issues).where(eq(issues.id, crossMissionIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "blocked", assigneeAgentId: workerAgentId }));
    await expect(db.select().from(issues).where(eq(issues.id, hiddenIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "blocked", assigneeAgentId: workerAgentId }));
  });
}

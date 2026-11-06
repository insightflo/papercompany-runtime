import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, companies, heartbeatRuns, issueComments, issues, missionPlanArtifacts, missions, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { missionService } from "../../services/missions.js";
import { createMissionOwnerDecisionFixture } from "./mission-owner-decision-fixture.js";

export function registerMissionRetryApplyCases(getDb: () => ReturnType<typeof createDb>) {
  const recordOwnerDecision = createMissionOwnerDecisionFixture(getDb);
  it("explicitly applies retry_source_issue owner decisions without changing source assignee or waking execution by default", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn();

    await db.insert(companies).values({ id: companyId, name: "Apply Retry Company", issuePrefix: `AR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Apply retry mission", status: "active" });

    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const blockedIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked retry source" });
    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 10 * 60 * 1000) });
    const unblockIssue = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock")).then((rows) => rows[0]!);
    // [owner-action contract] seed queued wakeup evidence for source (new guard requires it).
    await db.insert(agentWakeupRequests).values({ companyId, agentId: workerAgentId, source: "automation", status: "queued", issueId: unblockIssue.originId!, requestedAt: new Date() });
    await issueService(db).update(unblockIssue.id, { status: "done" });
    await db.insert(issueComments).values({
      companyId,
      issueId: unblockIssue.id,
      authorAgentId: ownerAgentId,
      body: [
        "### Mission owner decision",
        "Decision: retry_source_issue",
        `Source issue: ${blockedIssue.identifier}`,
        "Reason: Owner confirmed the blocker has cleared.",
        "Next action: Retry the source issue without reassignment.",
        "Evidence: Owner reviewed blocker details.",
      ].join("\n"),
    });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: unblockIssue.id,
      ownerAgentId,
      sourceIssueId: blockedIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: blockedIssue.identifier ?? blockedIssue.id,
        reason: "Owner confirmed the blocker has cleared.",
        nextAction: "Retry the source issue without reassignment.",
        evidence: "Owner reviewed blocker details.",
      },
    });

    const readOnlyResult = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000) });
    expect(readOnlyResult.appliedActions).toEqual([]);
    await expect(db.select().from(issues).where(eq(issues.id, blockedIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "blocked", assigneeAgentId: workerAgentId }));

    const applyResult = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 30 * 60 * 1000), applyOwnerDecisionActions: true });
    expect(applyResult.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "owner_decision_retry_source_issue", missionId, ownerActionIssueId: unblockIssue.id, sourceIssueId: blockedIssue.id, resultStatus: "blocked" }),
    ]));
    await expect(db.select().from(issues).where(eq(issues.id, blockedIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "blocked", assigneeAgentId: workerAgentId }));
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, blockedIssue.id))).resolves.toHaveLength(0);
    expect(onOwnerDecisionRetrySourceIssueApplied).not.toHaveBeenCalled();
    const sourceComments = await db.select().from(issueComments).where(eq(issueComments.issueId, blockedIssue.id));
    expect(sourceComments.map((comment) => comment.body).join("\n")).not.toContain("mission-owner-decision-applied");
    expect(sourceComments.map((comment) => comment.body).join("\n")).toContain("request native workflow resume");
    expect(sourceComments.map((comment) => comment.body).join("\n")).not.toContain("mission-owner-decision-wakeup-dispatched");
  });

  it("[Patch 2 cap-exhausted] native-loop producer at rework cap → AUTO retry_source_issue NOT skipped; producer reopen unauthorized → request_replan", async () => {
    const db = getDb();
    // 회귀 대상: producer rework cap(maxIterations) 이 소진된 native-loop 미션에서 AUTO(grace default)
    //   retry_source_issue 가 기존엔 owner_action_skipped_native_loop 로 막혀 매달리고 있었다.
    //   기대: cap 소진 시 guard 가 skip 을 풀고 owner_action_native_loop_cap_exhausted finding + producer 재오픈.
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const producerIssueId = randomUUID();
    const qaIssueId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "Cap Exhausted Company", issuePrefix: `CE${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: producerAgentId, companyId, name: "Producer Agent", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Cap exhausted mission", status: "active" });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "cap-exhausted-loop",
      stepsJson: [
        { id: "produce", name: "Produce artifact", agentId: producerAgentId, dependencies: [], conditionalDependencies: [{ stepId: "qa-validate", when: "qa_request_changes", isBackEdge: true, maxIterations: 1 }], description: "Produce the artifact" },
        { id: "qa-validate", name: "Validate the produced artifact", qaType: "semantic", agentId: qaAgentId, dependencies: ["produce"], description: "QA gate" },
      ],
    });
    await db.insert(workflowRuns).values({ id: runId, workflowId, companyId, missionId, triggeredBy: "system", status: "running", startedAt: new Date("2026-06-18T07:00:00.000Z") });
    await db.insert(issues).values([
      { id: producerIssueId, companyId, missionId, title: "cap-exhausted: Produce artifact", status: "done", assigneeAgentId: producerAgentId, originKind: "workflow_execution", originId: runId, originRunId: runId, startedAt: new Date("2026-06-18T07:01:00.000Z"), completedAt: new Date("2026-06-18T07:05:00.000Z") },
      { id: qaIssueId, companyId, missionId, title: "cap-exhausted: Validate the produced artifact", status: "blocked", assigneeAgentId: qaAgentId, originKind: "workflow_execution", originId: runId, originRunId: runId, startedAt: new Date("2026-06-18T07:03:00.000Z") },
    ]);
    await db.insert(workflowStepRuns).values([
      { workflowRunId: runId, stepId: "produce", issueId: producerIssueId, status: "completed", iterationIndex: 1, startedAt: new Date("2026-06-18T07:01:00.000Z"), completedAt: new Date("2026-06-18T07:05:00.000Z") },
      { workflowRunId: runId, stepId: "qa-validate", issueId: qaIssueId, status: "failed", iterationIndex: 0, startedAt: new Date("2026-06-18T07:03:00.000Z"), completedAt: new Date("2026-06-18T07:10:00.000Z") },
    ]);
    // producer iterationIndex=1 == maxIterations=1 → cap exhausted.

    const svc = missionService(db, {});
    // 1차 supervision: qaIssue 가 blocked+stale → unblock issue 생성(originId=qaIssue).
    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 10 * 60 * 1000) });
    const unblockIssue = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock")).then((rows) => rows[0] ?? null);
    expect(unblockIssue).toBeTruthy();
    expect(unblockIssue!.originId).toBe(qaIssueId);
    // grace window(20min) 을 넘기기 위해 unblock issue 의 createdAt 을 과거로 세팅(AUTO default 유도).
    //   이 케이스는 structured owner decision 이 없을 때의 grace-default AUTO 경로 회귀 — ledger 기록 없음.
    await db.update(issues).set({ createdAt: new Date("2026-06-18T07:00:00.000Z") }).where(eq(issues.id, unblockIssue!.id));

    // 2차 supervision (applyOwnerDecisionActions + grace 초과) → AUTO retry_source_issue 발화.
    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 30 * 60 * 1000), applyOwnerDecisionActions: true });

    // cap exhausted → skip 안 함(owner_action_native_loop_cap_exhausted finding). 단 producer reopen 은
    //   authorizeProducerRework(explicit target/fresh RC 없음 → unauthorized) 로 차단 → request_replan(codex nuance).
    expect(result.findings.join("\n")).toContain("owner_action_native_loop_cap_exhausted");
    expect(result.findings.join("\n")).not.toContain("owner_action_skipped_native_loop");
    expect(result.findings.join("\n")).toContain("producer_rework_unauthorized");
    expect(result.appliedActions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "owner_decision_retry_source_issue", sourceIssueId: producerIssueId }),
    ]));
    const producerAfter = await db.select().from(issues).where(eq(issues.id, producerIssueId)).then((rows) => rows[0]!);
    expect(producerAfter.status).toBe("done");
    expect(result.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "request_replan", issueId: producerIssueId }),
    ]));
  });

  it("does not apply retry_source_issue when the active plan says the source prerequisites are blocked", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn();

    await db.insert(companies).values({ id: companyId, name: "Plan Gated Retry Company", issuePrefix: `PR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "QA Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Plan gated retry mission", status: "active" });
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const blockedIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, createdByUserId: "test-operator", missionId, originKind: "workflow_execution", status: "blocked", title: "QA blocked before source artifact" });
    await db.insert(missionPlanArtifacts).values({
      companyId,
      missionId,
      revision: 1,
      status: "active",
      ownerAgentId,
      missionGoal: "Plan gated retry mission",
      refs: {
        schemaVersion: 3,
        selectedExecutionUnits: [{
          id: "qa-before-source",
          kind: "mission_issue",
          title: "QA blocked before source artifact",
          selectionState: "selected",
          executionState: "blocked",
          dependencyTreatment: "blocked",
          reason: "Source artifact is not complete yet.",
          sourceRef: { type: "mission_issue", id: blockedIssue.id, issueId: blockedIssue.id },
        }],
      },
      assumptions: [],
      requiredInputs: [],
      successCriteria: [],
      risks: [],
      steps: [
        { id: "source", title: "Collect source artifact", status: "planned" },
        { id: "qa", title: "Run QA after source artifact", status: "planned" },
      ],
    });
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: blockedIssue.id, status: "done", title: "Retry QA source too early" });
    await db.insert(issueComments).values({ companyId, issueId: ownerAction.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${blockedIssue.identifier}`, "Reason: retry anyway"].join("\n") });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: ownerAction.id,
      ownerAgentId,
      sourceIssueId: blockedIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: blockedIssue.identifier ?? blockedIssue.id,
        reason: "retry anyway",
      },
    });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });

    expect(result.findings.join("\n")).toContain("owner_action_decision_not_applied");
    expect(result.findings.join("\n")).toContain("prerequisites are blocked");
    expect(result.appliedActions).toEqual([]);
    expect(onOwnerDecisionRetrySourceIssueApplied).not.toHaveBeenCalled();
    await expect(db.select().from(issues).where(eq(issues.id, blockedIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "blocked", assigneeAgentId: workerAgentId }));
    const sourceBody = await db.select().from(issueComments).where(eq(issueComments.issueId, blockedIssue.id)).then((rows) => rows.map((row) => row.body).join("\n"));
    expect(sourceBody).not.toContain("mission-owner-decision-applied");
  });
}

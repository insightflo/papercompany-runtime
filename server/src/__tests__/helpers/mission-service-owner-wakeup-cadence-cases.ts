import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, companies, heartbeatRuns, issueComments, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { missionService } from "../../services/missions.js";
import { buildQaReworkCapDescription } from "../../services/missions/qa-rework-cap-oversight.js";
import { loadConsecutiveQaRejectTrend } from "../../services/missions/qa-rework-cap-oversight-detection.js";
import { createMissionOwnerDecisionFixture } from "./mission-owner-decision-fixture.js";

export function registerMissionOwnerWakeupCadenceCases(getDb: () => ReturnType<typeof createDb>) {
  const recordOwnerDecision = createMissionOwnerDecisionFixture(getDb);
  it("re-wakes the owner once when a recorded retry decision keeps failing to dispatch (dispatch-stall escalation)", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    // 재발사가 계속 not_requested 로 실패하는 상황(원 사고: 6시간 무응답).
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({ status: "not_requested", reason: "cap_override_no_marker" });
    const onOwnerDecisionDispatchStalledWakeRequested = vi.fn().mockResolvedValue(undefined);

    await db.insert(companies).values({ id: companyId, name: "Stalled Escalation Company", issuePrefix: `SE${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: producerAgentId, companyId, name: "Producer Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Stalled escalation mission", status: "active" });
    await db.insert(workflowDefinitions).values({
      id: workflowId, companyId, name: "stalled-escalation-loop",
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
      companyId, issueId: ownerAction.id, authorAgentId: ownerAgentId,
      body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${qaIssue.identifier}`, `Rework target: ${producerIssue.identifier}`, "Reason: producer must fix the artifact."].join("\n"),
    });
    await recordOwnerDecision({
      companyId, missionId, ownerActionIssueId: ownerAction.id, ownerAgentId, sourceIssueId: qaIssue.id,
      submission: { decision: "retry_source_issue", sourceIssueRef: qaIssue.identifier ?? qaIssue.id, reworkTargetRef: producerIssue.identifier ?? producerIssue.id, reason: "producer must fix the artifact." },
    });
    const wakeupKey = `mission-owner-decision-wakeup:${missionId}:${ownerAction.id}:${producerIssue.id}:retry_source_issue`;
    await db.insert(workflowTransitionEvents).values([
      { companyId, missionId, issueId: ownerAction.id, eventType: "mission_owner_retry_apply", layer: "mission_owner_recovery", decision: "retry_source_issue", reason: "owner_recovery_api", reasonCode: "owner_recovery_api", idempotencyKey: `${wakeupKey}:apply`, toStatus: "done", payload: { sourceIssueId: producerIssue.id } },
      { companyId, missionId, issueId: ownerAction.id, eventType: "mission_owner_retry_wakeup", layer: "mission_owner_recovery", decision: "retry_source_issue", reason: "owner_recovery_api", reasonCode: "owner_recovery_api", idempotencyKey: wakeupKey, toStatus: "not_requested", payload: { sourceIssueId: producerIssue.id } },
    ]);

    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied, onOwnerDecisionDispatchStalledWakeRequested });
    const first = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-07-06T08:00:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });

    expect(first.findings.join("\n")).toContain("owner_action_retry_wakeup_stalled");
    expect(first.findings.join("\n")).toContain("owner_decision_dispatch_stalled_wake_requested");
    expect(onOwnerDecisionDispatchStalledWakeRequested).toHaveBeenCalledTimes(1);
    expect(onOwnerDecisionDispatchStalledWakeRequested).toHaveBeenCalledWith(expect.objectContaining({
      ownerActionIssue: expect.objectContaining({ id: ownerAction.id }),
      sourceIssue: expect.objectContaining({ id: producerIssue.id }),
      dispatchStatus: "not_requested",
    }));

    // 두 번째 스윕: 재발사는 계속 시도하되(기존 동작), 오너 재깨움은 1회로 멱등.
    const second = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-07-06T08:05:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledTimes(2);
    expect(onOwnerDecisionDispatchStalledWakeRequested).toHaveBeenCalledTimes(1);
    expect(second.findings.join("\n")).not.toContain("owner_decision_dispatch_stalled_wake_requested");
  });

  it("counts consecutive QA rejects for the repeated-defect trend and enriches the cap description", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const heartbeatRunId = randomUUID();
    const at = (h: number) => new Date(`2026-08-17T0${h}:00:00.000Z`);

    await db.insert(companies).values({ id: companyId, name: "Reject Trend Company", issuePrefix: `RT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "QA Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "[QA] Inspect", status: "done", originKind: "workflow_execution" });
    await db.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId, agentId, issueId, status: "succeeded", startedAt: at(1), finishedAt: at(1) });
    const verdict = (verdictValue: string, hour: number, reason: string | null) => ({
      companyId, issueId, heartbeatRunId, eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: verdictValue, decision: verdictValue, reason: "workflow_api", reasonCode: "workflow_api",
      createdAt: at(hour), payload: { kind: "workflow_validation_verdict", verdict: verdictValue, ...(reason ? { reason } : {}) },
    });
    await db.insert(workflowTransitionEvents).values([
      verdict("pass", 1, "earlier pass"),
      verdict("request_changes", 2, "contrast 4.47:1 below 4.5:1"),
      verdict("request_changes", 3, "contrast 4.47:1 below 4.5:1"),
      verdict("request_changes", 4, "contrast 4.47:1 below 4.5:1"),
    ]);

    const trend = await loadConsecutiveQaRejectTrend(db, companyId, issueId);
    expect(trend.count).toBe(3);
    expect(trend.latestReason).toContain("4.47");

    // 최신이 pass 면 연속 0.
    await db.insert(workflowTransitionEvents).values(verdict("pass", 5, "fixed"));
    expect((await loadConsecutiveQaRejectTrend(db, companyId, issueId)).count).toBe(0);

    // 설명 강화: 연속 ≥2면 추세 경고, 1이면 없음.
    const exhaustion = {
      workflowRunId: "run-1", producerStepId: "materialize", qaStepId: "inspection", qaStepRunId: "step-run-1",
      producerIteration: 6, maxIterations: 2, producerCompletedAt: at(4), producerIssueId: "prod-1", qaIssueId: issueId,
    } as never;
    const enriched = buildQaReworkCapDescription({ keyMarker: "qa-cap-key:1", exhaustion, missionTitle: "GAZ", workflowName: "gazua-evening", rejectTrend: { count: 4, latestReason: "contrast 4.02:1 below 4.5:1" } });
    expect(enriched).toContain("Consecutive QA rejects on this gate: 4");
    expect(enriched).toContain("원천(생성기/템플릿/스킬)");
    expect(enriched).toContain("Latest QA defect: contrast 4.02:1 below 4.5:1");
    const plain = buildQaReworkCapDescription({ keyMarker: "qa-cap-key:2", exhaustion, missionTitle: "GAZ", workflowName: "gazua-evening", rejectTrend: { count: 1, latestReason: null } });
    expect(plain).not.toContain("Consecutive QA rejects");
  });

  it("wakes the owner for periodic mission review while work is in flight (bucket-idempotent)", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const onMissionOwnerPeriodicReviewWakeRequested = vi.fn();

    await db.insert(companies).values({ id: companyId, name: "Periodic Review Company", issuePrefix: `PR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Periodic review mission", status: "active", startedAt: new Date("2026-08-18T09:00:00.000Z") });
    await db.insert(workflowDefinitions).values({
      id: workflowId, companyId, name: "periodic-review",
      stepsJson: [{ id: "produce", name: "Produce report", agentId: workerAgentId, dependencies: [] }],
    });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId, triggeredBy: "system", status: "running", startedAt: new Date("2026-08-18T09:30:00.000Z") });
    const producerIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "in_progress", title: "Produce report" });
    await db.insert(workflowStepRuns).values([
      { workflowRunId, stepId: "produce", issueId: producerIssue.id, status: "running", startedAt: new Date("2026-08-18T09:30:00.000Z") },
    ]);
    await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_oversight", status: "todo", title: "[OVERSIGHT] periodic-review" });

    const svc = missionService(db, { onMissionOwnerPeriodicReviewWakeRequested });
    // 같은 30분 버킷 안의 두 스윕 → 1회만 깨움.
    const first = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-08-18T10:07:00.000Z"), applySafeActions: false, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(first.findings.join("\n")).toContain("mission_owner_periodic_review_wake_requested");
    expect(onMissionOwnerPeriodicReviewWakeRequested).toHaveBeenCalledTimes(1);
    expect(onMissionOwnerPeriodicReviewWakeRequested).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId }),
      inFlightUnitLabels: expect.arrayContaining([`native_workflow_run:${workflowRunId}:running`]),
    }));

    const second = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-08-18T10:12:00.000Z"), applySafeActions: false, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(second.findings.join("\n")).not.toContain("mission_owner_periodic_review_wake_requested");
    expect(onMissionOwnerPeriodicReviewWakeRequested).toHaveBeenCalledTimes(1);

    // 다음 버킷 → 다시 1회.
    const third = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-08-18T10:38:00.000Z"), applySafeActions: false, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(third.findings.join("\n")).toContain("mission_owner_periodic_review_wake_requested");
    expect(onMissionOwnerPeriodicReviewWakeRequested).toHaveBeenCalledTimes(2);
  });

  it("does not wake for periodic review when execution is fully settled", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const completedAt = new Date("2026-08-18T11:00:00.000Z");
    const onMissionOwnerPeriodicReviewWakeRequested = vi.fn();

    await db.insert(companies).values({ id: companyId, name: "Settled Review Company", issuePrefix: `SR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Settled review mission", status: "active", startedAt: new Date("2026-08-18T09:00:00.000Z") });
    await db.insert(workflowDefinitions).values({
      id: workflowId, companyId, name: "settled-review",
      stepsJson: [{ id: "produce", name: "Produce report", agentId: workerAgentId, dependencies: [] }],
    });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId, triggeredBy: "system", status: "completed", startedAt: new Date("2026-08-18T09:30:00.000Z"), completedAt });
    const producerIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId, status: "done", title: "Produce report" });
    await db.update(issues).set({ completedAt }).where(eq(issues.id, producerIssue.id));
    await db.insert(workflowStepRuns).values([
      { workflowRunId, stepId: "produce", issueId: producerIssue.id, status: "completed", startedAt: new Date("2026-08-18T09:30:00.000Z"), completedAt },
    ]);
    await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_oversight", status: "todo", title: "[OVERSIGHT] settled-review" });

    const svc = missionService(db, { onMissionOwnerPeriodicReviewWakeRequested });
    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-08-18T11:10:00.000Z"), applySafeActions: true, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(onMissionOwnerPeriodicReviewWakeRequested).not.toHaveBeenCalled();
    // settlement 가 미션을 종결했고 리뷰 대상이 없다.
    await expect(db.select().from(missions).where(eq(missions.id, missionId)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "completed" }));
  });
}

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, companies, heartbeatRuns, issueComments, issues, missions, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { missionService } from "../../services/missions.js";

export function registerMissionStaleSourceClassificationCases(getDb: () => ReturnType<typeof createDb>) {
  it("re-wakes an existing stale owner-action issue after a failed heartbeat run", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const failedRunId = randomUUID();
    const onOwnerActionCreated = vi.fn();

    await db.insert(companies).values({ id: companyId, name: "Owner Action Failed Run Company", issuePrefix: `OF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Owner action failed-run liveness mission", status: "active" });
    const svc = missionService(db, { onOwnerActionCreated });
    await svc.ensureMissionExecutionPlan({ companyId, missionId, sourceHints: { workflowName: "Owner Action Failed Run Workflow" } });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "todo", title: "Todo source already has owner action" });
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: null, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "todo", title: "Existing unassigned owner action after failed heartbeat" });
    await db.update(issues).set({ createdAt: new Date("2026-06-02T00:00:00.000Z"), updatedAt: new Date("2026-06-02T00:00:00.000Z") }).where(inArray(issues.id, [sourceIssue.id, ownerAction.id]));
    await db.insert(heartbeatRuns).values({
      id: failedRunId,
      companyId,
      agentId: ownerAgentId,
      issueId: ownerAction.id,
      status: "failed",
      startedAt: new Date("2026-06-02T00:01:00.000Z"),
      finishedAt: new Date("2026-06-02T00:02:00.000Z"),
      error: "Process lost",
      errorCode: "process_lost",
    });

    const result = await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: new Date("2026-06-02T00:10:00.000Z") });

    expect(result.missionIds).toContain(missionId);
    expect(result.missions[0]?.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("owner_action_stalled_after_failed_run"),
      expect.stringContaining(failedRunId),
    ]));
    const ownerActions = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(ownerActions).toEqual([
      expect.objectContaining({ id: ownerAction.id, missionId, originId: sourceIssue.id, status: "todo", assigneeAgentId: null }),
    ]);
    expect(onOwnerActionCreated).toHaveBeenCalledTimes(1);
    expect(onOwnerActionCreated).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId }),
      issue: expect.objectContaining({ id: ownerAction.id, originKind: "mission_main_executor_unblock", originId: sourceIssue.id }),
      sourceIssue: expect.objectContaining({ id: sourceIssue.id, status: "todo" }),
    }));
  });

  it("keeps unblock owner actions flat when the source issue is already nested", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "Nested Source Unblock Company", issuePrefix: `NS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Nested source unblock mission", status: "active" });

    const parentIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Parent source" });
    const nestedSource = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, parentId: parentIssue.id, originKind: "manual", status: "blocked", title: "Nested source" });

    const ownerAction = await missionService(db).ensureMainExecutorUnblockIssue(
      (await db.select().from(missions).where(eq(missions.id, missionId)).then((rows) => rows[0]!)),
      nestedSource,
    );

    expect(ownerAction).toEqual(expect.objectContaining({
      originKind: "mission_main_executor_unblock",
      originId: nestedSource.id,
      parentId: null,
    }));
  });

  it("does not classify a zero exit code heartbeat as failed stale queue evidence", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const succeededRunId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "Zero Exit Queue Company", issuePrefix: `ZE${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Zero exit stale queue mission", status: "active" });
    const svc = missionService(db);
    await svc.ensureMissionExecutionPlan({ companyId, missionId, sourceHints: { workflowName: "Zero Exit Workflow" } });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "todo", title: "Todo source after clean exit" });
    await db.update(issues).set({ createdAt: new Date("2026-06-02T00:00:00.000Z"), updatedAt: new Date("2026-06-02T00:00:00.000Z") }).where(eq(issues.id, sourceIssue.id));
    await db.insert(heartbeatRuns).values({
      id: succeededRunId,
      companyId,
      agentId: workerAgentId,
      issueId: sourceIssue.id,
      status: "succeeded",
      startedAt: new Date("2026-06-02T00:01:00.000Z"),
      finishedAt: new Date("2026-06-02T00:02:00.000Z"),
      exitCode: 0,
    });

    const result = await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: new Date("2026-06-02T00:10:00.000Z") });
    const findings = result.missions[0]?.findings.join("\n") ?? "";

    expect(findings).not.toContain("stale_todo_after_failed_run");
    expect(findings).toContain("stale_todo_no_active_execution");
  });

  it("active supervision escalates a stale todo source after timed_out execution", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const timedOutRunId = randomUUID();
    const onOwnerActionCreated = vi.fn();

    await db.insert(companies).values({ id: companyId, name: "Timed Out Todo Escalation Company", issuePrefix: `TT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Timed out todo escalation mission", status: "active" });
    const svc = missionService(db, { onOwnerActionCreated });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "todo", title: "Timed out todo source" });
    await db.insert(heartbeatRuns).values({
      id: timedOutRunId,
      companyId,
      agentId: workerAgentId,
      issueId: sourceIssue.id,
      status: "timed_out",
      startedAt: new Date("2026-06-02T00:00:00.000Z"),
      finishedAt: new Date("2026-06-02T00:30:00.000Z"),
    });

    const result = await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000) });

    expect(result.missionIds).toContain(missionId);
    expect(result.missions[0]?.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("stale_todo_after_failed_run"),
    ]));
    const ownerActions = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(ownerActions).toHaveLength(1);
    expect(ownerActions[0]).toEqual(expect.objectContaining({ missionId, originId: sourceIssue.id, status: "todo", assigneeAgentId: ownerAgentId }));
    expect(ownerActions[0]?.description).toContain("timed_out");
    expect(ownerActions[0]?.description).toContain(timedOutRunId);
    expect(ownerActions[0]?.description).toContain("retry_source_issue");
    expect(onOwnerActionCreated).toHaveBeenCalledTimes(1);
    expect(onOwnerActionCreated).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId }),
      issue: expect.objectContaining({ originKind: "mission_main_executor_unblock", originId: sourceIssue.id }),
      sourceIssue: expect.objectContaining({ id: sourceIssue.id, status: "todo" }),
    }));
  });

  it("treats a todo source with a pending queued execution-request as waiting, not stale (Phase 1.5)", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "Queue Wait Company", issuePrefix: `QW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Queue wait mission", status: "active" });
    const svc = missionService(db);
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "todo", title: "Todo source with pending queue request" });
    // 옛날 createdAt → ageMs 가 staleAfter(1min) 를 넘게(10min).
    await db.update(issues).set({ createdAt: new Date("2026-06-02T00:00:00.000Z"), updatedAt: new Date("2026-06-02T00:00:00.000Z") }).where(eq(issues.id, sourceIssue.id));
    // pending execution-request (wakeup queue): status=queued, runId=null, payload.issueId=source.
    // requestedAt 를 now 기준 2min 전으로 → TTL(staleAfter*4=4min) 이내 → 대기 상태.
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId: workerAgentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: sourceIssue.id },
      status: "queued",
      runId: null,
      requestedAt: new Date("2026-06-02T00:08:00.000Z"),
    });

    const result = await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: new Date("2026-06-02T00:10:00.000Z") });
    const findings = result.missions[0]?.findings.join("\n") ?? "";

    // [AREA: wakeup queue / Phase 1.5] pending queue request 가 있으므로 대기로 해석, stale 오판 방지.
    expect(findings).toContain("queued_waiting_for_execution");
    expect(findings).not.toContain("stale_todo_no_active_execution");
  });

  it("does not directly wake a stale in_progress source after terminal heartbeat execution without diagnosis", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const timedOutRunId = randomUUID();
    const onStaleSourceIssueWakeupRequested = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-in-progress", runId: "run-in-progress" });

    await db.insert(companies).values({ id: companyId, name: "Stale In Progress Wake Company", issuePrefix: `IP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Stale in-progress wake mission", status: "active" });
    const svc = missionService(db, { onStaleSourceIssueWakeupRequested });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "in_progress", title: "In-progress source after timed out run" });
    await db.update(issues).set({ createdAt: new Date("2026-06-02T00:00:00.000Z"), updatedAt: new Date("2026-06-02T00:00:00.000Z") }).where(eq(issues.id, sourceIssue.id));
    await db.insert(heartbeatRuns).values({
      id: timedOutRunId,
      companyId,
      agentId: workerAgentId,
      issueId: sourceIssue.id,
      status: "timed_out",
      startedAt: new Date("2026-06-02T00:00:00.000Z"),
      finishedAt: new Date("2026-06-02T00:30:00.000Z"),
      errorCode: "timeout",
    });

    const result = await svc.runActiveMissionOwnerSupervision({
      companyId,
      staleAfterMinutes: 1,
      now: new Date("2026-06-02T00:45:00.000Z"),
      dispatchStaleSourceIssueWakeups: true,
    });
    const idempotencyKey = `mission-stale-source-wakeup:${missionId}:${sourceIssue.id}:${timedOutRunId}`;

    expect(result.missionIds).toContain(missionId);
    expect(result.missions[0]?.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("stale_in_progress_after_failed_run"),
      expect.stringContaining(timedOutRunId),
      expect.stringContaining("diagnosed_only"),
      expect.stringContaining("stale_source_wakeup_requires_diagnosis"),
    ]));
    expect(onStaleSourceIssueWakeupRequested).not.toHaveBeenCalled();
    expect(result.missions[0]?.appliedActions).toEqual([]);
    const sourceComments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    const sourceBody = sourceComments.map((comment) => comment.body).join("\n");
    expect(sourceBody).not.toContain("### Mission supervision stale source wakeup dispatched");
    expect(sourceBody).not.toContain(idempotencyKey);
  });
}

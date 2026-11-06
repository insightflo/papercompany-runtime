import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, companies, heartbeatRuns, issueComments, issueWorkProducts, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { missionService } from "../../services/missions.js";
import { createMissionOwnerDecisionFixture } from "./mission-owner-decision-fixture.js";

export function registerMissionStaleRetryDispatchCases(getDb: () => ReturnType<typeof createDb>) {
  const recordOwnerDecision = createMissionOwnerDecisionFixture(getDb);
  it("dispatches explicit retry_source_issue wakeup for a stale todo source after failed execution", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const failedRunId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-todo", runId: "run-todo" });

    await db.insert(companies).values({ id: companyId, name: "Wake Todo Retry Company", issuePrefix: `WT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Wake stale todo retry mission", status: "active" });
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "todo", title: "Stale todo wake source" });
    await db.insert(heartbeatRuns).values({
      id: failedRunId,
      companyId,
      agentId: workerAgentId,
      issueId: sourceIssue.id,
      status: "timed_out",
      startedAt: new Date("2026-05-31T00:00:00.000Z"),
      finishedAt: new Date("2026-05-31T00:15:00.000Z"),
      errorCode: "timeout",
    });
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "done", title: "Retry stale todo source" });
    await db.insert(issueComments).values({ companyId, issueId: ownerAction.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${sourceIssue.identifier}`, "Reason: retry stale todo after failed execution"].join("\n") });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: ownerAction.id,
      ownerAgentId,
      sourceIssueId: sourceIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: sourceIssue.identifier ?? sourceIssue.id,
        reason: "retry stale todo after failed execution",
      },
    });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-05-31T01:00:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    const idempotencyKey = `mission-owner-decision-wakeup:${missionId}:${ownerAction.id}:${sourceIssue.id}:retry_source_issue:event:${(await db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.issueId, ownerAction.id), eq(workflowTransitionEvents.eventType, "mission_owner_decision"))))[0]!.id}`;

    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledTimes(1);
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId, ownerAgentId }),
      ownerActionIssue: expect.objectContaining({ id: ownerAction.id, assigneeAgentId: ownerAgentId }),
      sourceIssue: expect.objectContaining({ id: sourceIssue.id, assigneeAgentId: workerAgentId, status: "todo" }),
      targetAgentId: workerAgentId,
      idempotencyKey,
    }));
    expect(result.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "owner_decision_retry_source_issue", sourceIssueId: sourceIssue.id, resultStatus: "todo", wakeupDispatchStatus: "dispatched", idempotencyKey }),
    ]));
    const sourceComments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    const sourceBody = sourceComments.map((comment) => comment.body).join("\n");
    expect(sourceBody).toContain("mission-owner-decision-applied");
    expect(sourceBody).toContain("mission-owner-decision-wakeup-dispatched");
  });

  it("dispatches a workProduct-reuse wake when a blocked producer has no workProduct, a stalled recovery, and the artifact file exists", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const producerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepId = "build-tech-scout-html-report";
    const timedOutRecoveryRunId = randomUUID();
    const onWorkProductReuseWakeRequested = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-reuse", runId: "run-reuse" });

    const workProductRoot = mkdtempSync(path.join(os.tmpdir(), "wf-reuse-"));
    await db.insert(companies).values({ id: companyId, name: "WorkProduct Reuse Company", issuePrefix: `WR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false, workProductRoot });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: producerAgentId, companyId, name: "Producer Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "WorkProduct reuse mission", status: "active" });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Producer Workflow", stepsJson: [{ id: stepId, name: "Build report", dependencies: [], graphWorkProductRequired: true }] });
    const svc = missionService(db, { onWorkProductReuseWakeRequested });

    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: producerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked producer (no workProduct)" });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId, triggeredBy: "system", status: "running" });
    await db.insert(workflowStepRuns).values({ id: randomUUID(), workflowRunId, stepId, issueId: sourceIssue.id, status: "completed", metadata: { graphWorkProductRequired: true } });

    // recovery (unblock) issue for the source whose heartbeat run timed out (RES-350 scenario)
    const recoveryIssue = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "todo", title: "[Unblock] blocked producer" });
    await db.insert(heartbeatRuns).values({ id: timedOutRecoveryRunId, companyId, agentId: ownerAgentId, issueId: recoveryIssue.id, status: "timed_out", startedAt: new Date("2026-06-25T00:00:00.000Z"), finishedAt: new Date("2026-06-25T00:30:00.000Z"), errorCode: "execution_stale_timeout" });

    // expected artifact file already exists under the step output dir (registration is the only gap)
    const stepOutputDir = path.join(workProductRoot, "missions", missionId, "runs", workflowRunId, "steps", stepId);
    const artifactPath = path.join(stepOutputDir, "index.html");
    mkdirSync(stepOutputDir, { recursive: true });
    writeFileSync(artifactPath, "<html>report</html>");
    // (no issueWorkProducts inserted for the source -> listForIssue is empty)

    const result = await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: new Date("2026-06-25T01:00:00.000Z") });
    const idempotencyKey = `mission-workproduct-reuse-wakeup:${missionId}:${sourceIssue.id}:${artifactPath}`;

    expect(result.missionIds).toContain(missionId);
    expect(onWorkProductReuseWakeRequested).toHaveBeenCalledTimes(1);
    expect(onWorkProductReuseWakeRequested).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId }),
      sourceIssue: expect.objectContaining({ id: sourceIssue.id }),
      targetAgentId: producerAgentId,
      artifactPath,
      stalledRecoveryIssueId: recoveryIssue.id,
      idempotencyKey,
    }));
    expect(result.missions[0]?.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "workproduct_reuse_wakeup", sourceIssueId: sourceIssue.id, artifactPath, idempotencyKey }),
    ]));
    const sourceCommentRows = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    const sourceBody = sourceCommentRows.map((comment) => comment.body).join("\n");
    expect(sourceBody).toContain("workProduct-reuse wakeup dispatched");
    expect(sourceBody).toContain("POST /api/issues/{issueId}/workflow/artifacts");
    expect(sourceBody).toContain("This is the only registration authority.");
    expect(sourceBody).toContain(artifactPath);
    expect(sourceBody).toContain("or an `[ARTIFACT]` marker to register");
    expect(sourceBody).toContain("Comments, stdout, and artifact markers are no longer registration authority");
    expect(sourceBody).not.toContain(`[ARTIFACT]: ${artifactPath}`);
    expect(sourceBody).toContain(idempotencyKey);
    const reuseEvents = await db
      .select({ id: workflowTransitionEvents.id })
      .from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.idempotencyKey, idempotencyKey));
    expect(reuseEvents).toHaveLength(1);

    // idempotent: a second sweep must NOT dispatch another reuse wake
    await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: new Date("2026-06-25T01:05:00.000Z") });
    expect(onWorkProductReuseWakeRequested).toHaveBeenCalledTimes(1);

    rmSync(workProductRoot, { recursive: true, force: true });
  });

  it("does not dispatch a workProduct-reuse wake when the artifact file is absent (no fake success)", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const producerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepId = "build-tech-scout-html-report";
    const timedOutRecoveryRunId = randomUUID();
    const onWorkProductReuseWakeRequested = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-reuse-2", runId: "run-reuse-2" });

    const workProductRoot = mkdtempSync(path.join(os.tmpdir(), "wf-reuse-noop-"));
    await db.insert(companies).values({ id: companyId, name: "WorkProduct Reuse Noop Company", issuePrefix: `WN${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false, workProductRoot });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: producerAgentId, companyId, name: "Producer Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "WorkProduct reuse noop mission", status: "active" });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Producer Workflow Noop", stepsJson: [{ id: stepId, name: "Build report", dependencies: [], graphWorkProductRequired: true }] });
    const svc = missionService(db, { onWorkProductReuseWakeRequested });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: producerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked producer noop (no workProduct, no file)" });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId, companyId, missionId, triggeredBy: "system", status: "running" });
    await db.insert(workflowStepRuns).values({ id: randomUUID(), workflowRunId, stepId, issueId: sourceIssue.id, status: "completed", metadata: { graphWorkProductRequired: true } });
    const recoveryIssue = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "todo", title: "[Unblock] blocked producer noop" });
    await db.insert(heartbeatRuns).values({ id: timedOutRecoveryRunId, companyId, agentId: ownerAgentId, issueId: recoveryIssue.id, status: "timed_out", startedAt: new Date("2026-06-25T00:00:00.000Z"), finishedAt: new Date("2026-06-25T00:30:00.000Z"), errorCode: "execution_stale_timeout" });
    // intentionally DO NOT create the artifact file -> wake must not fire

    const result = await svc.runActiveMissionOwnerSupervision({ companyId, staleAfterMinutes: 1, now: new Date("2026-06-25T01:00:00.000Z") });

    expect(onWorkProductReuseWakeRequested).not.toHaveBeenCalled();
    expect((result.missions[0]?.appliedActions ?? []).filter((action) => action.type === "workproduct_reuse_wakeup")).toEqual([]);

    rmSync(workProductRoot, { recursive: true, force: true });
  });
}

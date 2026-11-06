import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, companies, heartbeatRuns, issueComments, issues, missions, workflowTransitionEvents, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { missionService } from "../../services/missions.js";
import { createMissionOwnerDecisionFixture } from "./mission-owner-decision-fixture.js";

export function registerMissionRetryDispatchCases(getDb: () => ReturnType<typeof createDb>) {
  const recordOwnerDecision = createMissionOwnerDecisionFixture(getDb);
  it("dispatches one explicit retry_source_issue wakeup to the source assignee with idempotency marker", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-1", runId: "run-1" });

    await db.insert(companies).values({ id: companyId, name: "Wake Retry Company", issuePrefix: `WR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Wake retry mission", status: "active" });
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const blockedIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked wake source" });
    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 10 * 60 * 1000) });
    const unblockIssue = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock")).then((rows) => rows[0]!);
    // [owner-action contract] seed queued wakeup evidence for source (new guard requires it).
    await db.insert(agentWakeupRequests).values({ companyId, agentId: workerAgentId, source: "automation", status: "queued", issueId: unblockIssue.originId!, requestedAt: new Date() });
    await issueService(db).update(unblockIssue.id, { status: "done" });
    await db.insert(issueComments).values({ companyId, issueId: unblockIssue.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${blockedIssue.identifier}`, "Reason: retry and wake once"].join("\n") });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: unblockIssue.id,
      ownerAgentId,
      sourceIssueId: blockedIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: blockedIssue.identifier ?? blockedIssue.id,
        reason: "retry and wake once",
      },
    });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    const idempotencyKey = `mission-owner-decision-wakeup:${missionId}:${unblockIssue.id}:${blockedIssue.id}:retry_source_issue:event:${(await db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.issueId, unblockIssue.id), eq(workflowTransitionEvents.eventType, "mission_owner_decision"))))[0]!.id}`;

    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledTimes(1);
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId, ownerAgentId }),
      ownerActionIssue: expect.objectContaining({ id: unblockIssue.id, assigneeAgentId: ownerAgentId }),
      sourceIssue: expect.objectContaining({ id: blockedIssue.id, assigneeAgentId: workerAgentId }),
      targetAgentId: workerAgentId,
      idempotencyKey,
    }));
    expect(result.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "owner_decision_retry_source_issue", sourceIssueId: blockedIssue.id, wakeupDispatchStatus: "dispatched", idempotencyKey }),
    ]));
    await expect(db.select().from(issues).where(eq(issues.id, blockedIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({ status: "blocked", assigneeAgentId: workerAgentId }));
    const sourceComments = await db.select().from(issueComments).where(eq(issueComments.issueId, blockedIssue.id));
    const sourceBody = sourceComments.map((comment) => comment.body).join("\n");
    expect(sourceBody).toContain("mission-owner-decision-applied");
    expect(sourceBody).toContain("mission-owner-decision-wakeup-dispatched");
    expect(sourceBody).toContain(idempotencyKey);
  });

  it("applies reassign_source_issue to the source issue and wakes the new assignee", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const operationsAgentId = randomUUID();
    const synthesisAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-reassign", runId: "run-reassign" });

    await db.insert(companies).values({ id: companyId, name: "Wake Reassign Company", issuePrefix: `WA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      {
        id: operationsAgentId,
        companyId,
        name: "Hermes Operations Manager",
        role: "pm",
        status: "active",
        adapterType: "hermes_local",
        adapterConfig: {},
        runtimeConfig: { domain: "operations", operatingMode: "chief_of_staff_liaison" },
        permissions: {},
      },
      { id: synthesisAgentId, companyId, name: "Synthesis Editor", role: "pm", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { domain: "synthesis" }, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Wake reassign mission", status: "active" });
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: operationsAgentId, missionId, originKind: "workflow_execution", status: "todo", title: "Publish approved manual" });
    const staleRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: staleRunId,
      companyId,
      agentId: operationsAgentId,
      issueId: sourceIssue.id,
      invocationSource: "assignment",
      status: "failed",
      startedAt: new Date("2026-06-28T03:06:44.526Z"),
      finishedAt: new Date("2026-06-28T03:07:44.526Z"),
      createdAt: new Date("2026-06-28T03:06:44.502Z"),
    });
    await db.update(issues).set({
      assigneeUserId: randomUUID(),
      checkoutRunId: staleRunId,
      executionRunId: staleRunId,
      executionAgentNameKey: "hermes-operations-manager",
      executionLockedAt: new Date("2026-06-28T03:06:44.526Z"),
      completedAt: new Date("2026-06-28T03:07:44.526Z"),
      cancelledAt: new Date("2026-06-28T03:08:44.526Z"),
    }).where(eq(issues.id, sourceIssue.id));
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "done", title: "Reassign publish source" });
    await db.insert(issueComments).values({
      companyId,
      issueId: ownerAction.id,
      authorAgentId: ownerAgentId,
      body: [
        "### Mission owner decision",
        "Decision: reassign_source_issue",
        `Source issue: ${sourceIssue.identifier}`,
        "Reason: Hermes is a liaison and must not directly execute the publish issue.",
        `Next action: Reassign ${sourceIssue.identifier} to Synthesis Editor ${synthesisAgentId} and wake it.`,
      ].join("\n"),
    });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: ownerAction.id,
      ownerAgentId,
      sourceIssueId: sourceIssue.id,
      submission: {
        decision: "reassign_source_issue",
        sourceIssueRef: sourceIssue.identifier ?? sourceIssue.id,
        targetAgentId: synthesisAgentId,
        reason: "Hermes is a liaison and must not directly execute the publish issue.",
        nextAction: `Target agent: ${synthesisAgentId}`,
      },
    });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    const idempotencyKey = `mission-owner-decision-wakeup:${missionId}:${ownerAction.id}:${sourceIssue.id}:reassign_source_issue`;

    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledTimes(1);
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId, ownerAgentId }),
      ownerActionIssue: expect.objectContaining({ id: ownerAction.id, assigneeAgentId: ownerAgentId }),
      sourceIssue: expect.objectContaining({
        id: sourceIssue.id,
        assigneeAgentId: synthesisAgentId,
        assigneeUserId: null,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
      }),
      targetAgentId: synthesisAgentId,
      idempotencyKey,
    }));
    expect(result.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "owner_decision_reassign_source_issue",
        sourceIssueId: sourceIssue.id,
        previousAgentId: operationsAgentId,
        targetAgentId: synthesisAgentId,
        wakeupDispatchStatus: "dispatched",
        idempotencyKey,
      }),
    ]));
    await expect(db.select().from(issues).where(eq(issues.id, sourceIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({
      status: "todo",
      assigneeAgentId: synthesisAgentId,
      assigneeUserId: null,
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      completedAt: null,
      cancelledAt: null,
    }));
    const sourceBody = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id)).then((rows) => rows.map((comment) => comment.body).join("\n"));
    expect(sourceBody).toContain("mission-owner-decision-applied");
    expect(sourceBody).toContain("reassign_source_issue");
    expect(sourceBody).toContain("mission-owner-decision-wakeup-dispatched");
    expect(sourceBody).toContain(idempotencyKey);
  });

  it("carries the latest REQUEST_CHANGES summary into retry_source_issue comments and wake context", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-qa-summary", runId: "run-qa-summary" });

    await db.insert(companies).values({ id: companyId, name: "Retry QA Summary Company", issuePrefix: `RQ${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Retry QA summary mission", status: "active" });

    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const sourceIssue = await issueService(db).create(companyId, {
      assigneeAgentId: workerAgentId,
      missionId,
      originKind: "workflow_execution",
      status: "blocked",
      title: "Synthesize report draft",
    });
    const requestChangesSummary = "REQUEST_CHANGES: Tables in Top25 전체 표 have incorrect column counts because the 비고 column contains unescaped pipe characters.";
    const ownerAction = await issueService(db).create(companyId, {
      assigneeAgentId: ownerAgentId,
      description: [
        "Mission-owner signal from validation gate.",
        "",
        "### Validation excerpt",
        "```text",
        requestChangesSummary,
        "```",
      ].join("\n"),
      missionId,
      originKind: "mission_main_executor_unblock",
      originId: sourceIssue.id,
      status: "done",
      title: "Retry report producer after QA request changes",
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: ownerAction.id,
      authorAgentId: ownerAgentId,
      body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${sourceIssue.identifier}`, "Reason: retry with latest QA summary"].join("\n"),
    });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: ownerAction.id,
      ownerAgentId,
      sourceIssueId: sourceIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: sourceIssue.identifier ?? sourceIssue.id,
        reason: "retry with latest QA summary",
      },
    });

    await svc.runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date("2026-06-30T23:40:00.000Z"),
      applyOwnerDecisionActions: true,
      dispatchOwnerDecisionWakeups: true,
    });

    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledTimes(1);
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledWith(expect.objectContaining({
      sourceIssue: expect.objectContaining({ id: sourceIssue.id }),
      targetAgentId: workerAgentId,
      decisionCommentId: expect.any(String),
    }));
    const sourceComments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    const sourceBody = sourceComments.map((comment) => comment.body).join("\n");
    expect(sourceBody).toContain("Latest REQUEST_CHANGES summary");
    expect(sourceBody).toContain(requestChangesSummary);
  });
}

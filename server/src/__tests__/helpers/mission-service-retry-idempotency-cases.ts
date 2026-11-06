import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, companies, heartbeatRuns, issueComments, issues, missions, workflowTransitionEvents, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { missionService } from "../../services/missions.js";
import { createMissionOwnerDecisionFixture } from "./mission-owner-decision-fixture.js";

export function registerMissionRetryIdempotencyCases(getDb: () => ReturnType<typeof createDb>) {
  const recordOwnerDecision = createMissionOwnerDecisionFixture(getDb);
  it("dispatches a retry_source_issue wakeup when an earlier apply marker exists without a dispatch marker", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-late" });
    await db.insert(companies).values({ id: companyId, name: "Late Wake Dispatch Company", issuePrefix: `LW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Late wake retry mission", status: "active" });
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Previously applied source" });
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "done", title: "Retry applied without dispatch" });
    await db.insert(issueComments).values({ companyId, issueId: ownerAction.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${sourceIssue.identifier}`, "Reason: retry once then dispatch later"].join("\n") });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: ownerAction.id,
      ownerAgentId,
      sourceIssueId: sourceIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: sourceIssue.identifier ?? sourceIssue.id,
        reason: "retry once then dispatch later",
      },
    });

    const first = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-05-31T01:00:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: false });
    expect(first.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "owner_decision_retry_source_issue", sourceIssueId: sourceIssue.id, wakeupDispatchStatus: "not_requested" }),
    ]));
    expect(onOwnerDecisionRetrySourceIssueApplied).not.toHaveBeenCalled();

    const second = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-05-31T02:00:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    const idempotencyKey = `mission-owner-decision-wakeup:${missionId}:${ownerAction.id}:${sourceIssue.id}:retry_source_issue:event:${(await db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.issueId, ownerAction.id), eq(workflowTransitionEvents.eventType, "mission_owner_decision"))))[0]!.id}`;
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledTimes(1);
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledWith(expect.objectContaining({ targetAgentId: workerAgentId, idempotencyKey }));
    expect(second.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "owner_decision_retry_source_issue", sourceIssueId: sourceIssue.id, wakeupDispatchStatus: "dispatched", idempotencyKey }),
    ]));
    const sourceComments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    const applyMarkers = sourceComments.filter((row) => row.body.includes("mission-owner-decision-applied"));
    const wakeupMarkers = sourceComments.filter((row) => row.body.includes("mission-owner-decision-wakeup-dispatched"));
    expect(applyMarkers).toHaveLength(1);
    expect(wakeupMarkers).toHaveLength(1);
  });

  it("re-wakes a half-applied validator retry after a completed child correction and carries repair evidence into the wake comment", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const validatorAgentId = randomUUID();
    const missionId = randomUUID();
    const succeededRunId = randomUUID();
    const correctedPngPath = "/Users/kwak/Personal/obsidian/600. Improvements/603.TechNews/202606/20260602-techcrunch-ai-knowledge-comic.png";
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-validator" });
    await db.insert(companies).values({ id: companyId, name: "Validator Child Correction Company", issuePrefix: `VC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: validatorAgentId, companyId, name: "Validator Agent", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Validator retry mission", status: "active" });
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const sourceIssue = await issueService(db).create(companyId, { assigneeAgentId: validatorAgentId, createdByUserId: "test-operator", missionId, originKind: "workflow_execution", status: "todo", title: "RES-132 validator retry source" });
    await db.insert(heartbeatRuns).values({ id: succeededRunId, companyId, agentId: validatorAgentId, issueId: sourceIssue.id, status: "succeeded", startedAt: new Date("2026-06-02T08:00:00.000Z"), finishedAt: new Date("2026-06-02T08:10:00.000Z"), exitCode: 0 });
    const ownerAction = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, originKind: "mission_main_executor_unblock", originId: sourceIssue.id, status: "done", title: "Retry validator after corrected PNG" });
    await db.insert(issueComments).values({ companyId, issueId: ownerAction.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${sourceIssue.identifier}`, "Reason: corrected child PNG is ready; run validator again"].join("\n") });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: ownerAction.id,
      ownerAgentId,
      sourceIssueId: sourceIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: sourceIssue.identifier ?? sourceIssue.id,
        reason: "corrected child PNG is ready; run validator again",
      },
    });
    await db.insert(workflowTransitionEvents).values({
      companyId,
      missionId,
      issueId: ownerAction.id,
      eventType: "mission_owner_retry_apply",
      layer: "mission_owner_recovery",
      decision: "retry_source_issue",
      reason: "owner_recovery_api",
      reasonCode: "owner_recovery_api",
      idempotencyKey: `mission-owner-decision-wakeup:${missionId}:${ownerAction.id}:${sourceIssue.id}:retry_source_issue:apply`,
      payload: { sourceIssueId: sourceIssue.id },
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: sourceIssue.id,
      authorAgentId: ownerAgentId,
      body: [
        "### Mission owner retry applied",
        `<!-- mission-owner-decision-applied:${JSON.stringify({ ownerActionIssueId: ownerAction.id, sourceIssueId: sourceIssue.id, decision: "retry_source_issue" })} -->`,
        "Action: earlier supervision applied the owner retry but did not dispatch a wakeup.",
      ].join("\n"),
    });
    const childCorrection = await issueService(db).create(companyId, { assigneeAgentId: ownerAgentId, missionId, parentId: sourceIssue.id, originKind: "mission_repair_child", status: "done", title: "RES-152 corrected PNG ready" });
    await db.insert(issueComments).values({ companyId, issueId: childCorrection.id, authorAgentId: ownerAgentId, body: [
      "### Corrected validation artifact",
      `Corrected PNG path: ${correctedPngPath}`,
      "RES-148 repair spec: Recheck the original repair spec before deciding PASS.",
      "Existing REQUEST_CHANGES objection panel 3: verify the panel 3 objection is resolved.",
      "Existing REQUEST_CHANGES objection panel 5: verify the panel 5 objection is resolved.",
      "Gate: return only PASS or REQUEST_CHANGES; do not edit the artifact.",
      "Telegram/send is forbidden before PASS.",
    ].join("\n") });

    const second = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date("2026-06-02T08:40:00.000Z"), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    const idempotencyKey = `mission-owner-decision-wakeup:${missionId}:${ownerAction.id}:${sourceIssue.id}:retry_source_issue`;

    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledTimes(1);
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledWith(expect.objectContaining({
      targetAgentId: validatorAgentId,
      idempotencyKey,
      decisionCommentId: expect.any(String),
    }));
    expect(second.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "owner_decision_retry_source_issue", sourceIssueId: sourceIssue.id, wakeupDispatchStatus: "dispatched", idempotencyKey }),
    ]));
    const sourceBody = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id)).then((rows) => rows.map((row) => row.body).join("\n"));
    expect(sourceBody).toContain("### Validator retry evidence");
    expect(sourceBody).toContain(correctedPngPath);
    expect(sourceBody).toContain("RES-148 repair spec");
    expect(sourceBody).toContain("panel 3");
    expect(sourceBody).toContain("panel 5");
    expect(sourceBody).toContain("PASS or REQUEST_CHANGES");
    expect(sourceBody).toContain("Telegram/send is forbidden before PASS");
    expect(sourceBody).not.toContain("Direct modification");
  });

  it("does not apply or dispatch the same retry_source_issue owner decision twice", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-1" });
    await db.insert(companies).values({ id: companyId, name: "Retry Idempotent Company", issuePrefix: `RI${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Idempotent retry mission", status: "active" });
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const blockedIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked source" });
    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 10 * 60 * 1000) });
    const unblockIssue = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock")).then((rows) => rows[0]!);
    // [owner-action contract] seed queued wakeup evidence for source (new guard requires it).
    await db.insert(agentWakeupRequests).values({ companyId, agentId: workerAgentId, source: "automation", status: "queued", issueId: unblockIssue.originId!, requestedAt: new Date() });
    await issueService(db).update(unblockIssue.id, { status: "done" });
    await db.insert(issueComments).values({ companyId, issueId: unblockIssue.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${blockedIssue.identifier}`, "Reason: retry once"].join("\n") });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: unblockIssue.id,
      ownerAgentId,
      sourceIssueId: blockedIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: blockedIssue.identifier ?? blockedIssue.id,
        reason: "retry once",
      },
    });

    const first = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    const second = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 30 * 60 * 1000), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    expect(first.appliedActions).toHaveLength(1);
    expect(second.appliedActions).toEqual([]);
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledTimes(1);
    const sourceComments = await db.select().from(issueComments).where(eq(issueComments.issueId, blockedIssue.id));
    const applyMarkers = sourceComments.filter((row) => row.body.includes("mission-owner-decision-applied"));
    const wakeupMarkers = sourceComments.filter((row) => row.body.includes("mission-owner-decision-wakeup-dispatched"));
    expect(applyMarkers).toHaveLength(1);
    expect(wakeupMarkers).toHaveLength(1);
  });
}

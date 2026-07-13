import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issueComments, issues, missions, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { asc, eq } from "drizzle-orm";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { hermesChatService } from "../services/hermes-chat.js";
import { completeUnblockActionWithSourceHandback } from "../services/missions/owner-action-completion.js";
import { gatherUnblockSourceEvidence } from "../services/missions/owner-action-unblock-handback.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

// [목적] mission_main_executor_unblock done closeout guard가 GAZ-315 silent success를 막는지 검증.
//   source(originId)가 blocked이고 wakeup도 없으면 done 거부; source 회복 또는 wakeup dispatch 시 허용.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres owner-action closeout guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("owner-action closeout guard (mission_main_executor_unblock)", () => {
  let db: ReturnType<typeof createDb>;
  let svc: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-owner-action-guard-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Owner Action Co",
      issuePrefix: `OA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    agentId = (await hermesChatService(db).ensureOperationsAgent(companyId)).id;
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertUnblockWithSource(sourceStatus: string) {
    const [source] = await db
      .insert(issues)
      .values({ companyId, title: "blocked source", status: sourceStatus, originKind: "workflow_execution", assigneeAgentId: agentId })
      .returning({ id: issues.id });
    const [unblock] = await db
      .insert(issues)
      .values({
        companyId,
        title: "unblock action",
        status: "todo",
        originKind: "mission_main_executor_unblock",
        originId: source.id,
      })
      .returning({ id: issues.id });
    return { sourceId: source.id, unblockId: unblock.id };
  }

  it("rejects done when the source is still blocked and no wakeup was dispatched (GAZ-315 silent success)", async () => {
    const { unblockId } = await insertUnblockWithSource("blocked");
    // source blocked + no wakeup → guard must reject.
    await expect(svc.update(unblockId, { status: "done" })).rejects.toThrow(/Cannot complete this owner-action/);
  });

  it("allows done when the source recovered (no longer blocked)", async () => {
    const { unblockId } = await insertUnblockWithSource("todo");
    const updated = await svc.update(unblockId, { status: "done" });
    expect(updated?.status).toBe("done");
  });

  it("allows done when a wakeup was dispatched to the source", async () => {
    const { sourceId, unblockId } = await insertUnblockWithSource("blocked");
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      issueId: sourceId,
      requestedAt: new Date(),
    });
    const updated = await svc.update(unblockId, { status: "done" });
    expect(updated?.status).toBe("done");
  });

  it("does not affect non-owner-action issue completion", async () => {
    const [leaf] = await db
      .insert(issues)
      .values({ companyId, title: "manual leaf", status: "todo", originKind: "manual" })
      .returning({ id: issues.id });
    const updated = await svc.update(leaf.id, { status: "done" });
    expect(updated?.status).toBe("done");
  });

  it("rejects done when only a skipped wakeup exists (skipped is not execution evidence)", async () => {
    const [source] = await db
      .insert(issues)
      .values({ companyId, title: "blocked source skipped-only", status: "blocked", originKind: "workflow_execution", assigneeAgentId: agentId })
      .returning({ id: issues.id });
    const [unblock] = await db
      .insert(issues)
      .values({ companyId, title: "unblock skipped-only", status: "todo", originKind: "mission_main_executor_unblock", originId: source.id })
      .returning({ id: issues.id });

    // skipped wakeup — not valid execution-queue evidence.
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      status: "skipped",
      issueId: source.id,
      requestedAt: new Date(),
    });

    // guard must reject: skipped is not queued/deferred/coalesced.
    await expect(svc.update(unblock.id, { status: "done" })).rejects.toThrow(/Cannot complete this owner-action/);
  });

  it("rejects done when queued wakeup targets a wrong agent (not the source assignee)", async () => {
    const [source] = await db
      .insert(issues)
      .values({ companyId, title: "blocked source wrong-agent", status: "blocked", originKind: "workflow_execution", assigneeAgentId: agentId })
      .returning({ id: issues.id });
    const [unblock] = await db
      .insert(issues)
      .values({ companyId, title: "unblock wrong-agent", status: "todo", originKind: "mission_main_executor_unblock", originId: source.id })
      .returning({ id: issues.id });

    // queued wakeup for a DIFFERENT agent, not the source assignee.
    const wrongAgentId = randomUUID();
    await db.insert(agents).values({ id: wrongAgentId, companyId, name: "Wrong Agent", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: wrongAgentId,
      source: "automation",
      status: "queued",
      issueId: source.id,
      requestedAt: new Date(),
    });

    // guard must reject: wakeup agentId !== source.assigneeAgentId.
    await expect(svc.update(unblock.id, { status: "done" })).rejects.toThrow(/Cannot complete this owner-action/);
  });

  // workflow step run 을 source issue 에 연결하는 최소 fixture. native workflow_resume
  // dispatch 분기를 검증하기 위해 쓴다.
  async function seedSourceWithStepRun(status = "blocked") {
    const workflowRunId = randomUUID();
    const workflowId = randomUUID();
    const stepRunId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Unblock source workflow",
      stepsJson: [{ id: "src", name: "Source step", agentId, dependencies: [] }],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      triggeredBy: "system",
      status: "running",
      startedAt: new Date(),
    });
    const [source] = await db
      .insert(issues)
      .values({ companyId, title: "blocked source with step run", status, originKind: "workflow_execution", assigneeAgentId: agentId })
      .returning({ id: issues.id });
    await db.insert(workflowStepRuns).values({
      id: stepRunId,
      workflowRunId,
      stepId: "src",
      issueId: source.id,
      status: "running",
      startedAt: new Date(),
    });
    const [unblock] = await db
      .insert(issues)
      .values({ companyId, title: "unblock for step-linked source", status: "todo", originKind: "mission_main_executor_unblock", originId: source.id })
      .returning({ id: issues.id });
    return { source, unblock, workflowRunId, stepRunId };
  }

  it("completion dispatches native workflow_resume via the validated DAG helper (real agent_wakeup_requests row, no direct source retry)", async () => {
    const { source, unblock, workflowRunId, stepRunId } = await seedSourceWithStepRun();
    const [sourceBefore] = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, source.id));

    const result = await completeUnblockActionWithSourceHandback(db, {
      unblockIssueId: unblock.id,
      companyId,
      actor: { agentId },
    });

    // [req] dispatchKind workflow_resume — wakeExistingWorkflowStepIssue owns the contract.
    expect(result.dispatchKind).toBe("workflow_resume");

    // native dispatch evidence: a REAL agent_wakeup_requests row with reason=workflow_step_runnable
    //   and payload mutation=workflow_resume carrying the official workflowRunId/workflowStepRunId.
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, source.id));
    const wake = wakes.find((w) => w.reason === "workflow_step_runnable") ?? null;
    expect(wake).not.toBeNull();
    const payload = (wake?.payload ?? {}) as Record<string, unknown>;
    expect(payload.mutation).toBe("workflow_resume");
    expect(payload.workflowRunId).toBe(workflowRunId);
    expect(payload.workflowStepRunId).toBe(stepRunId);
    expect(wake?.agentId).toBe(agentId);

    const [sourceAfter] = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, source.id));
    expect(sourceAfter).toEqual(sourceBefore);

    // structured Oversight handback report recorded, with the native recommendation.
    const comments = await db.select({ body: issueComments.body }).from(issueComments).where(eq(issueComments.issueId, unblock.id));
    expect(comments.some((c) => c.body?.startsWith("[owner-action-handback-report]"))).toBe(true);
    expect(comments.some((c) => c.body?.includes("recommendedNativeAction: workflow_resume"))).toBe(true);

    const [doneRow] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, unblock.id)).limit(1);
    expect(doneRow?.status).toBe("done");
  });

  it("completion is observe-only (no new dispatch) when a live wakeup already covers the source", async () => {
    const { source, unblock } = await seedSourceWithStepRun();
    // live NATIVE workflow_resume wake covering the source -> already in native queue
    //   (findExistingWorkflowResumeWake matches reason=workflow_step_runnable + payload mutation=workflow_resume).
    await db.insert(agentWakeupRequests).values({
      companyId, agentId, source: "automation", status: "queued", issueId: source.id, requestedAt: new Date(),
      reason: "workflow_step_runnable",
      requestKind: "workflow_resume",
      payload: { issueId: source.id, mutation: "workflow_resume" },
    });
    const wakesBefore = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, source.id));

    const result = await completeUnblockActionWithSourceHandback(db, {
      unblockIssueId: unblock.id, companyId, actor: { agentId },
    });

    expect(result.dispatchKind).toBe("native_resume_in_flight");
    // no NEW wake beyond the seeded native one — observe-only did not dispatch.
    const wakesAfter = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, source.id));
    expect(wakesAfter).toHaveLength(wakesBefore.length);
    const comments = await db.select({ body: issueComments.body }).from(issueComments).where(eq(issueComments.issueId, unblock.id));
    expect(comments.some((c) => c.body?.includes("recommendedNativeAction: native_resume_in_flight"))).toBe(true);
    const [doneRow] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, unblock.id)).limit(1);
    expect(doneRow?.status).toBe("done");
  });

  it("completion is report-only with no dispatch when the source has no provable native step link", async () => {
    const handoffOwnerId = randomUUID();
    await db.insert(agents).values({
      id: handoffOwnerId,
      companyId,
      name: "Paused report-only owner",
      role: "operator",
      status: "paused",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const [mission] = await db
      .insert(missions)
      .values({ companyId, ownerAgentId: handoffOwnerId, title: "report-only no-step mission", status: "active" })
      .returning({ id: missions.id });
    const [source] = await db
      .insert(issues)
      .values({ companyId, missionId: mission.id, title: "blocked source no step", status: "blocked", originKind: "workflow_execution", assigneeAgentId: agentId })
      .returning({ id: issues.id });
    const [unblock] = await db
      .insert(issues)
      .values({ companyId, missionId: mission.id, title: "unblock no-step", status: "todo", originKind: "mission_main_executor_unblock", originId: source.id })
      .returning({ id: issues.id });
    await db.insert(issues).values({
      companyId,
      missionId: mission.id,
      title: "report-only no-step oversight",
      status: "todo",
      originKind: "mission_main_executor_oversight",
      assigneeAgentId: handoffOwnerId,
    });
    const [sourceBefore] = await db
      .select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId, checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, source.id));

    const result = await completeUnblockActionWithSourceHandback(db, {
      unblockIssueId: unblock.id, companyId, actor: { agentId },
    });

    expect(result.dispatchKind).toBe("report_only");
    // no wake row at all for the source.
    const wakes = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, source.id));
    expect(wakes).toHaveLength(0);
    const [sourceAfter] = await db
      .select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId, checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, source.id));
    expect(sourceAfter).toEqual(sourceBefore);
    const comments = await db.select({ body: issueComments.body }).from(issueComments).where(eq(issueComments.issueId, unblock.id));
    expect(comments.some((c) => c.body?.includes("recommendedNativeAction: report_only"))).toBe(true);
    expect(comments.some((c) => c.body?.includes("failureClass: blocked_no_native_step"))).toBe(true);
    const [doneRow] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, unblock.id)).limit(1);
    expect(doneRow?.status).toBe("done");
  });

  it("report-only hands a no-assignee source to its active Oversight issue", async () => {
    const handoffOwnerId = randomUUID();
    await db.insert(agents).values({
      id: handoffOwnerId,
      companyId,
      name: "Paused handoff owner",
      role: "operator",
      status: "paused",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const [mission] = await db
      .insert(missions)
      .values({ companyId, ownerAgentId: handoffOwnerId, title: "report-only handoff mission", status: "active" })
      .returning({ id: missions.id });
    const [source] = await db
      .insert(issues)
      .values({ companyId, missionId: mission.id, title: "blocked source without assignee", status: "blocked", originKind: "workflow_execution" })
      .returning({ id: issues.id });
    const [unblock] = await db
      .insert(issues)
      .values({ companyId, missionId: mission.id, title: "report-only unblock", status: "todo", originKind: "mission_main_executor_unblock", originId: source.id })
      .returning({ id: issues.id });
    const [activeOversight] = await db
      .insert(issues)
      .values({
        companyId,
        missionId: mission.id,
        title: "active oversight receives report-only handoff",
        status: "todo",
        originKind: "mission_main_executor_oversight",
        assigneeAgentId: handoffOwnerId,
      })
      .returning({ id: issues.id });

    const result = await completeUnblockActionWithSourceHandback(db, {
      unblockIssueId: unblock.id,
      companyId,
      actor: { agentId },
    });

    expect(result.dispatchKind).toBe("report_only");
    expect(result.oversightWakeupRequestId).toBeTruthy();
    const [handoffWake] = await db
      .select({
        issueId: agentWakeupRequests.issueId,
        agentId: agentWakeupRequests.agentId,
        reason: agentWakeupRequests.reason,
        runId: agentWakeupRequests.runId,
        status: agentWakeupRequests.status,
        requestedAt: agentWakeupRequests.requestedAt,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, result.oversightWakeupRequestId!));
    expect(handoffWake?.issueId).toBe(activeOversight.id);
    expect(handoffWake?.agentId).toBe(handoffOwnerId);
    expect(handoffWake?.reason).toBe("owner_action_unblock_handback_report");
    expect(handoffWake?.status).toBe("queued");
    expect(handoffWake?.runId).toBeNull();
    const comments = await db
      .select({ id: issueComments.id, body: issueComments.body, createdAt: issueComments.createdAt })
      .from(issueComments)
      .where(eq(issueComments.issueId, unblock.id))
      .orderBy(asc(issueComments.createdAt));
    const report = comments.find((comment) => comment.body.startsWith("[owner-action-handback-report]"));
    expect(report).toBeTruthy();
    expect(report?.createdAt.getTime()).toBeLessThanOrEqual(handoffWake!.requestedAt.getTime());
    const [ledger] = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.entityId, unblock.id));
    expect(ledger?.details?.reportCommentId).toBe(report?.id);
    const ownerRuns = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, handoffOwnerId));
    expect(ownerRuns).toHaveLength(0);
    const [doneRow] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, unblock.id)).limit(1);
    expect(doneRow?.status).toBe("done");
  });

  it("restores terminal Oversight before handing off a report-only unblock", async () => {
    const handoffOwnerId = randomUUID();
    await db.insert(agents).values({
      id: handoffOwnerId,
      companyId,
      name: "Paused terminal-only handoff owner",
      role: "operator",
      status: "paused",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const [mission] = await db
      .insert(missions)
      .values({ companyId, ownerAgentId: handoffOwnerId, title: "missing oversight mission", status: "active" })
      .returning({ id: missions.id });
    const [source] = await db
      .insert(issues)
      .values({ companyId, missionId: mission.id, title: "blocked source missing oversight", status: "blocked", originKind: "workflow_execution" })
      .returning({ id: issues.id });
    const [unblock] = await db
      .insert(issues)
      .values({ companyId, missionId: mission.id, title: "unblock missing oversight", status: "todo", originKind: "mission_main_executor_unblock", originId: source.id })
      .returning({ id: issues.id });
    const [terminalOversight] = await db
      .insert(issues)
      .values({
        companyId,
        missionId: mission.id,
        title: "terminal oversight is restored for handoff",
        status: "done",
        originKind: "mission_main_executor_oversight",
        assigneeAgentId: handoffOwnerId,
      })
      .returning({ id: issues.id });

    const result = await completeUnblockActionWithSourceHandback(db, {
      unblockIssueId: unblock.id,
      companyId,
      actor: { agentId },
    });

    const [handoffWake] = await db
      .select({ issueId: agentWakeupRequests.issueId })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, result.oversightWakeupRequestId!));
    expect(handoffWake?.issueId).toBe(terminalOversight.id);
    const [restoredOversight] = await db
      .select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, terminalOversight.id));
    expect(restoredOversight).toEqual({ status: "todo", assigneeAgentId: handoffOwnerId });
    const [unblockAfter] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, unblock.id)).limit(1);
    expect(unblockAfter?.status).toBe("done");
  });

  it("reports the newest run with a failure signal even when its status is not terminal-failed", async () => {
    const [source] = await db
      .insert(issues)
      .values({ companyId, title: "failure-signaled source", status: "blocked", originKind: "workflow_execution", assigneeAgentId: agentId })
      .returning({ id: issues.id });
    const failureRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: failureRunId,
      companyId,
      agentId,
      issueId: source.id,
      status: "succeeded",
      errorCode: "late_failure_signal",
      exitCode: 7,
    });
    const [sourceRow] = await db.select().from(issues).where(eq(issues.id, source.id)).limit(1);
    expect(sourceRow).toBeTruthy();

    const evidence = await gatherUnblockSourceEvidence(db, { companyId, source: sourceRow! });
    expect(evidence.failedRunId).toBe(failureRunId);
    expect(evidence.failedRunErrorCode).toBe("late_failure_signal");
    expect(evidence.failedRunExitCode).toBe(7);
  });

  // valid structured report body for guard tests. sourceIssueId MUST match the unblock's originId.
  function validReportBody(sourceIssueId: string): string {
    return [
      "[owner-action-handback-report]",
      "Structured Oversight handback report.",
      "",
      `sourceIssueId: ${sourceIssueId}`,
      "sourceIssueIdentifier: none",
      "sourceStatus: blocked",
      "failedRunId: none",
      "failedRunStatus: none",
      "failureClass: blocked_no_native_step",
      "evidence:",
      "- workflowRunId: none",
      "- workflowStepRunId: none",
      "- stepId: none",
      "- liveRunId: none",
      "- liveWakeupRequestId: none",
      "sourceLiveRunWakeState: none",
      "recommendedNativeAction: report_only",
      "dispatchedWakeupRequestId: none",
    ].join("\n");
  }

  it("guard REJECTS done when only a bare marker comment is present (marker alone must not close)", async () => {
    const { unblock } = await seedSourceWithStepRun();
    const svc2 = issueService(db);
    await svc2.addComment(unblock.id, "[owner-action-handback-report]", { userId: "guard-test" });
    await expect(svc2.update(unblock.id, { status: "done" })).rejects.toThrow(/Cannot complete this owner-action/);
  });

  it("guard REJECTS done when a structured report names a foreign sourceIssueId (mismatched originId)", async () => {
    const { unblock } = await seedSourceWithStepRun();
    const svc2 = issueService(db);
    await svc2.addComment(unblock.id, validReportBody(randomUUID()), { userId: "guard-test" });
    await expect(svc2.update(unblock.id, { status: "done" })).rejects.toThrow(/Cannot complete this owner-action/);
  });

  it("guard REJECTS done when a report is missing required fields (malformed)", async () => {
    const { source, unblock } = await seedSourceWithStepRun();
    const svc2 = issueService(db);
    // marker + sourceIssueId only — no failureClass/evidence/sourceLiveRunWakeState/recommendedNativeAction.
    await svc2.addComment(unblock.id, `[owner-action-handback-report]\nsourceIssueId: ${source.id}`, { userId: "guard-test" });
    await expect(svc2.update(unblock.id, { status: "done" })).rejects.toThrow(/Cannot complete this owner-action/);
  });

  it("guard REJECTS done when 'evidence:' appears only as a substring inside another field (no structural evidence block)", async () => {
    const { source, unblock } = await seedSourceWithStepRun();
    const svc2 = issueService(db);
    // All required fields present + sourceIssueId matches + valid enums, but "evidence:" is embedded
    // in the note line's VALUE — there is no standalone `evidence:` header and no `- key: value` item.
    // A substring `body.includes("evidence:")` check would accept this; the structural check must reject it.
    const malicious = [
      "[owner-action-handback-report]",
      "note: this serves as evidence: of completion",
      `sourceIssueId: ${source.id}`,
      "failedRunId: none",
      "failureClass: blocked_no_native_step",
      "sourceLiveRunWakeState: none",
      "recommendedNativeAction: report_only",
    ].join("\n");
    await svc2.addComment(unblock.id, malicious, { userId: "guard-test" });
    await expect(svc2.update(unblock.id, { status: "done" })).rejects.toThrow(/Cannot complete this owner-action/);
  });

  it("guard rejects a fully-validated but agent-authored report without a server handback ledger", async () => {
    const { source, unblock } = await seedSourceWithStepRun();
    const svc2 = issueService(db);
    await svc2.addComment(unblock.id, validReportBody(source.id), { userId: "guard-test" });
    await expect(svc2.update(unblock.id, { status: "done" })).rejects.toThrow(/Cannot complete this owner-action/);
  });

  // [Phase 2 route] POST /issues/:id/owner-action/complete-with-handback
  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Reflect.set(req, "actor", { type: "board", userId: "test-board", isInstanceAdmin: true, source: "local_implicit" });
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }

  it("route happy path: completes via report-only when source has no native step link, returns done", async () => {
    const handoffOwnerId = randomUUID();
    await db.insert(agents).values({
      id: handoffOwnerId,
      companyId,
      name: "Paused route handoff owner",
      role: "operator",
      status: "paused",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const [mission] = await db
      .insert(missions)
      .values({ companyId, ownerAgentId: handoffOwnerId, title: "route handoff mission", status: "active" })
      .returning({ id: missions.id });
    const [source] = await db
      .insert(issues)
      .values({ companyId, missionId: mission.id, title: "source for route", status: "blocked", originKind: "workflow_execution", assigneeAgentId: agentId })
      .returning({ id: issues.id });
    const [unblock] = await db
      .insert(issues)
      .values({ companyId, missionId: mission.id, title: "unblock for route", status: "todo", originKind: "mission_main_executor_unblock", originId: source.id })
      .returning({ id: issues.id });
    await db.insert(issues).values({
      companyId,
      missionId: mission.id,
      title: "route handoff oversight",
      status: "todo",
      originKind: "mission_main_executor_oversight",
      assigneeAgentId: handoffOwnerId,
    });

    // no pre-seeded wakeup, no step run -> completion is report-only (no direct source retry),
    // and the structured report lets the closeout guard pass.
    const app = buildApp();
    const res = await request(app).post(`/api/issues/${unblock.id}/owner-action/complete-with-handback`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
    expect(res.body.sourceIssueId).toBe(source.id);

    const comments = await db.select({ body: issueComments.body }).from(issueComments).where(eq(issueComments.issueId, unblock.id));
    expect(comments.some((c) => c.body?.startsWith("[owner-action-handback-report]"))).toBe(true);
  });

  it("route rejects non-owner-action issue with 422", async () => {
    const [leaf] = await db
      .insert(issues)
      .values({ companyId, title: "manual leaf for route", status: "todo", originKind: "manual" })
      .returning({ id: issues.id });

    const app = buildApp();
    const res = await request(app).post(`/api/issues/${leaf.id}/owner-action/complete-with-handback`);
    expect(res.status).toBe(422);
  });
});

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueInboxArchives,
  issues,
  missionPlanArtifacts,
  missions,
  srbIssuePairs,
  srbLinks,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { createSrbPairSync } from "../services/srb/pair-sync.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function decisionComment(decision: Record<string, unknown>) {
  return `### Mission owner plan decision
\`\`\`json
${JSON.stringify(decision)}
\`\`\``;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService.list participantAgentId", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-service-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(srbIssuePairs);
    await db.delete(srbLinks);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(missionPlanArtifacts);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns issues an agent participated in across the supported signals", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "OtherAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const assignedIssueId = randomUUID();
    const createdIssueId = randomUUID();
    const commentedIssueId = randomUUID();
    const activityIssueId = randomUUID();
    const excludedIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: assignedIssueId,
        companyId,
        title: "Assigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        createdByAgentId: otherAgentId,
      },
      {
        id: createdIssueId,
        companyId,
        title: "Created issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
      {
        id: commentedIssueId,
        companyId,
        title: "Commented issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
      },
      {
        id: activityIssueId,
        companyId,
        title: "Activity issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
      },
      {
        id: excludedIssueId,
        companyId,
        title: "Excluded issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
        assigneeAgentId: otherAgentId,
      },
    ]);

    await db.insert(issueComments).values({
      companyId,
      issueId: commentedIssueId,
      authorAgentId: agentId,
      body: "Investigating this issue.",
    });

    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: activityIssueId,
      agentId,
      details: { changed: true },
    });

    const result = await svc.list(companyId, { participantAgentId: agentId });
    const resultIds = new Set(result.map((issue) => issue.id));

    expect(resultIds).toEqual(new Set([
      assignedIssueId,
      createdIssueId,
      commentedIssueId,
      activityIssueId,
    ]));
    expect(resultIds.has(excludedIssueId)).toBe(false);
  });

  it("combines participation filtering with search", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const matchedIssueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: matchedIssueId,
        companyId,
        title: "Invoice reconciliation",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
      {
        id: otherIssueId,
        companyId,
        title: "Weekly planning",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
    ]);

    const result = await svc.list(companyId, {
      participantAgentId: agentId,
      q: "invoice",
    });

    expect(result.map((issue) => issue.id)).toEqual([matchedIssueId]);
  });

  it("hides archived inbox issues until new external activity arrives", async () => {
    const companyId = randomUUID();
    const userId = "user-1";
    const otherUserId = "user-2";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const visibleIssueId = randomUUID();
    const archivedIssueId = randomUUID();
    const resurfacedIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: visibleIssueId,
        companyId,
        title: "Visible issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        createdAt: new Date("2026-03-26T10:00:00.000Z"),
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: archivedIssueId,
        companyId,
        title: "Archived issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        createdAt: new Date("2026-03-26T11:00:00.000Z"),
        updatedAt: new Date("2026-03-26T11:00:00.000Z"),
      },
      {
        id: resurfacedIssueId,
        companyId,
        title: "Resurfaced issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T12:00:00.000Z"),
      },
    ]);

    await svc.archiveInbox(
      companyId,
      archivedIssueId,
      userId,
      new Date("2026-03-26T12:30:00.000Z"),
    );
    await svc.archiveInbox(
      companyId,
      resurfacedIssueId,
      userId,
      new Date("2026-03-26T13:00:00.000Z"),
    );

    await db.insert(issueComments).values({
      companyId,
      issueId: resurfacedIssueId,
      authorUserId: otherUserId,
      body: "This should bring the issue back into Mine.",
      createdAt: new Date("2026-03-26T13:30:00.000Z"),
      updatedAt: new Date("2026-03-26T13:30:00.000Z"),
    });

    const archivedFiltered = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });

    expect(archivedFiltered.map((issue) => issue.id)).toEqual([
      resurfacedIssueId,
      visibleIssueId,
    ]);

    await svc.unarchiveInbox(companyId, archivedIssueId, userId);

    const afterUnarchive = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });

    expect(new Set(afterUnarchive.map((issue) => issue.id))).toEqual(new Set([
      visibleIssueId,
      archivedIssueId,
      resurfacedIssueId,
    ]));
  });

  it("mirrors checkout and release status transitions for mirror_source_status pairs", async () => {
    const sourceCompanyId = randomUUID();
    const mirrorCompanyId = randomUUID();
    const sourceAgentId = randomUUID();
    const mirrorAgentId = randomUUID();
    const linkId = randomUUID();
    const sourceIssueId = randomUUID();
    const mirrorIssueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values([
      {
        id: sourceCompanyId,
        name: "Source Co",
        issuePrefix: `SC${sourceCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: mirrorCompanyId,
        name: "Mirror Co",
        issuePrefix: `MC${mirrorCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(agents).values([
      {
        id: sourceAgentId,
        companyId: sourceCompanyId,
        name: "Source Agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: mirrorAgentId,
        companyId: mirrorCompanyId,
        name: "Mirror Agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(srbLinks).values({
      id: linkId,
      localCompanyId: sourceCompanyId,
      remoteCompanyId: mirrorCompanyId,
      remoteServerUrl: null,
      direction: "two_way",
      createdBy: "test",
    });

    await db.insert(issues).values([
      {
        id: sourceIssueId,
        companyId: sourceCompanyId,
        title: "Source issue",
        status: "todo",
      },
      {
        id: mirrorIssueId,
        companyId: mirrorCompanyId,
        title: "Mirror issue",
        status: "todo",
        assigneeAgentId: mirrorAgentId,
      },
    ]);

    await db.insert(srbIssuePairs).values({
      linkId,
      sourceCompanyId,
      sourceIssueId,
      mirrorCompanyId,
      mirrorIssueId,
      statusSyncMode: "mirror_source_status",
      createdBy: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: sourceCompanyId,
      agentId: sourceAgentId,
      invocationSource: "on_demand",
      status: "running",
      contextSnapshot: {},
    });

    const checkedOut = await svc.checkout(sourceIssueId, sourceAgentId, ["todo"], runId);
    expect(checkedOut?.status).toBe("in_progress");

    const mirrorInProgress = await db
      .select()
      .from(issues)
      .where(eq(issues.id, mirrorIssueId))
      .then((rows) => rows[0] ?? null);
    expect(mirrorInProgress?.status).toBe("in_progress");

    const released = await svc.release(sourceIssueId, sourceAgentId, runId);
    expect(released?.status).toBe("todo");
    expect(released?.checkoutRunId).toBeNull();
    expect(released?.executionRunId).toBeNull();

    const mirrorReleased = await db
      .select()
      .from(issues)
      .where(eq(issues.id, mirrorIssueId))
      .then((rows) => rows[0] ?? null);
    expect(mirrorReleased?.status).toBe("todo");
  });

  it("audits terminal SRB mirror status sync mismatches without blocking the mirror update", async () => {
    const sourceCompanyId = randomUUID();
    const mirrorCompanyId = randomUUID();
    const linkId = randomUUID();
    const sourceIssueId = randomUUID();
    const mirrorIssueId = randomUUID();

    await db.insert(companies).values([
      {
        id: sourceCompanyId,
        name: "SourceCo",
        issuePrefix: `SRC${sourceCompanyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: mirrorCompanyId,
        name: "MirrorCo",
        issuePrefix: `MIR${mirrorCompanyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(srbLinks).values({
      id: linkId,
      localCompanyId: sourceCompanyId,
      remoteCompanyId: mirrorCompanyId,
      remoteServerUrl: null,
      direction: "two_way",
      createdBy: "test",
    });

    await db.insert(issues).values([
      {
        id: sourceIssueId,
        companyId: sourceCompanyId,
        title: "Source issue",
        status: "in_progress",
      },
      {
        id: mirrorIssueId,
        companyId: mirrorCompanyId,
        title: "PG사 결제 API 응답 오류",
        description: "시스템: 결제 API\n증상: 외부 PG사 API timeout\n시간: 오늘 오전부터 반복. 벤더 확인 필요.",
        status: "in_progress",
      },
    ]);

    await db.insert(srbIssuePairs).values({
      linkId,
      sourceCompanyId,
      sourceIssueId,
      mirrorCompanyId,
      mirrorIssueId,
      statusSyncMode: "mirror_source_status",
      createdBy: "test",
    });

    const pairSync = createSrbPairSync(db);
    await pairSync.syncSourceStatus({ sourceIssueId, sourceStatus: "done" });

    const mirrorDone = await db
      .select()
      .from(issues)
      .where(eq(issues.id, mirrorIssueId))
      .then((rows) => rows[0] ?? null);
    expect(mirrorDone?.status).toBe("done");

    const audit = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "maintenance_decision_action_mismatch"))
      .then((rows) => rows[0] ?? null);
    expect(audit).toEqual(expect.objectContaining({
      companyId: mirrorCompanyId,
      actorType: "system",
      actorId: "srb-status-sync",
      entityType: "issue",
      entityId: mirrorIssueId,
    }));
    expect(audit?.details).toEqual(expect.objectContaining({
      attemptedAction: "srb.mirror_status_sync",
      attemptedStatus: "done",
      recommendedNextAction: "vendor_handoff",
      mismatchReasons: expect.arrayContaining(["vendor_handoff_required_before_close"]),
    }));
  });
});

describeEmbeddedPostgres("issueService assertCheckoutOwner malformed same-run lock remediation", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-service-lock-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(srbIssuePairs);
    await db.delete(srbLinks);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("repairs malformed same-run locks when executionRunId already matches the actor run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      contextSnapshot: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Malformed same-run lock",
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: runId,
      executionLockedAt: new Date(),
    });

    const ownership = await svc.assertCheckoutOwner(issueId, agentId, runId);

    expect(ownership).toEqual(expect.objectContaining({
      id: issueId,
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      adoptedFromRunId: null,
      repairedMalformedExecutionLock: true,
    }));

    const repaired = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(repaired).toEqual({
      checkoutRunId: runId,
      executionRunId: runId,
    });
  });

  it("adopts stale terminal execution locks with no checkout lock during checkout", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const staleRunId = randomUUID();
    const nextRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Research Worker",
      role: "researcher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: staleRunId,
        companyId,
        agentId,
        invocationSource: "targeted_wakeup",
        status: "cancelled",
        contextSnapshot: {},
        finishedAt: new Date(),
      },
      {
        id: nextRunId,
        companyId,
        agentId,
        invocationSource: "targeted_wakeup",
        status: "running",
        contextSnapshot: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue with stale execution lock only",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: staleRunId,
      executionLockedAt: new Date(),
    });

    const checkedOut = await svc.checkout(issueId, agentId, ["todo"], nextRunId);

    expect(checkedOut).toEqual(expect.objectContaining({
      id: issueId,
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: nextRunId,
      executionRunId: nextRunId,
    }));
  });

  it("rejects missing parent issues before insert", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await expect(
      svc.create(companyId, {
        title: "Child with stale parent",
        status: "todo",
        priority: "medium",
        parentId: randomUUID(),
      }),
    ).rejects.toThrow("Parent issue not found");
  });

  it("inherits the parent mission when creating a sub-issue without missionId", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const parentIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Mission Owner",
      role: "owner",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Mission-scoped execution",
      status: "active",
    });
    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      missionId,
      title: "Mission issue",
      status: "todo",
      priority: "medium",
    });

    const child = await svc.create(companyId, {
      parentId: parentIssueId,
      title: "Mission child issue",
      status: "todo",
      priority: "medium",
    });

    expect(child).toEqual(expect.objectContaining({
      parentId: parentIssueId,
      missionId,
    }));
  });

  it("rejects creating issues for terminal missions", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const assigneeAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: assigneeAgentId,
        companyId,
        name: "Worker",
        role: "worker",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Cancelled mission",
      status: "cancelled",
    });

    await expect(
      svc.create(companyId, {
        missionId,
        assigneeAgentId,
        title: "Late recovery source task",
        status: "todo",
        priority: "medium",
      }),
    ).rejects.toThrow("Cannot create issues for a completed or cancelled mission");
  });

  it("rejects reopening an issue inside a terminal mission", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Mission Owner",
      role: "owner",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Cancelled mission",
      status: "cancelled",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      title: "Cancelled mission issue",
      status: "cancelled",
      priority: "medium",
    });

    await expect(svc.update(issueId, { status: "todo" })).rejects.toThrow(
      "Cannot reopen or execute issues for a completed or cancelled mission",
    );
  });

  it("rejects mission-owner planned downstream child issues before upstream artifacts", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const assigneeAgentId = randomUUID();
    const sourceAgentId = randomUUID();
    const missionId = randomUUID();
    const parentIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: assigneeAgentId,
        companyId,
        name: "Report Validator",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: sourceAgentId,
        companyId,
        name: "Source Researcher",
        role: "worker",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Mission-scoped execution",
      status: "active",
    });
    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      missionId,
      assigneeAgentId,
      originKind: "research_director_plan",
      title: "[Dossier-A] Source dossiers for candidates",
      status: "in_progress",
      priority: "medium",
    });

    await expect(
      svc.create(companyId, {
        missionId,
        assigneeAgentId,
        originKind: "research_director_plan",
        title: "[Validation] Independent QA of evidence, claims, and HTML file",
        status: "todo",
        priority: "medium",
      }),
    ).rejects.toThrow("Mission downstream issue creation is not allowed");
    const sourceIssue = await svc.create(companyId, {
      missionId,
      assigneeAgentId: sourceAgentId,
      originKind: "research_director_plan",
      title: "[Dossier-A] Source dossiers for candidates",
      status: "todo",
      priority: "medium",
    });
    await expect(
      svc.create(companyId, {
        missionId,
        parentId: parentIssueId,
        assigneeAgentId,
        createdByAgentId: assigneeAgentId,
        title: "[RES-458][QA] Independent URL/status and claim-evidence check",
        status: "todo",
        priority: "medium",
      }),
    ).rejects.toThrow("Mission downstream issue creation is not allowed");
    await expect(
      svc.create(companyId, {
        parentId: parentIssueId,
        assigneeAgentId,
        createdByAgentId: assigneeAgentId,
        title: "[Synthesis] HTML report compilation",
        status: "todo",
        priority: "medium",
      }),
    ).rejects.toThrow("Mission downstream issue creation is not allowed");
    const agentSourceChildIssue = await svc.create(companyId, {
      parentId: parentIssueId,
      assigneeAgentId: sourceAgentId,
      createdByAgentId: sourceAgentId,
      title: "[RES-458][Source] Direct URL harvest",
      status: "backlog",
      priority: "medium",
    });

    expect(sourceIssue.status).toBe("todo");
    expect(agentSourceChildIssue.status).toBe("todo");
  });

  it("rejects hyphenated research director downstream issues before upstream artifacts", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const assigneeAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: assigneeAgentId,
        companyId,
        name: "Synthesis Editor",
        role: "worker",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Mission-scoped execution",
      status: "active",
    });

    await expect(
      svc.create(companyId, {
        missionId,
        assigneeAgentId,
        originKind: "research-director-plan",
        title: "Synthesis + HTML authoring: verified packets only",
        status: "todo",
        priority: "high",
      }),
    ).rejects.toThrow("Mission downstream issue creation is not allowed");

    await expect(
      svc.create(companyId, {
        missionId,
        assigneeAgentId,
        originKind: "research-director-plan",
        title: "[Source] Evidence matrix and HTML shell draft",
        status: "todo",
        priority: "medium",
      }),
    ).rejects.toThrow("Mission downstream issue creation is not allowed");
  });

  it("rejects mission owner plan child downstream issues before upstream artifacts", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const assigneeAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: assigneeAgentId,
        companyId,
        name: "Report Validator",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Mission-scoped execution",
      status: "active",
    });

    await expect(
      svc.create(companyId, {
        missionId,
        assigneeAgentId,
        originKind: "research_director_plan_child",
        title: "[Validation Gate] HTML file independent verification",
        status: "todo",
        priority: "high",
      }),
    ).rejects.toThrow("Mission downstream issue creation is not allowed");
  });

  it("allows plan materialization as mission-level ACTION/QA/OVERSIGHT sibling issues", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const missionId = randomUUID();
    const planIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: workerAgentId,
        companyId,
        name: "Source Researcher",
        role: "worker",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: qaAgentId,
        companyId,
        name: "QA Validator",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Mission-scoped execution",
      status: "planning",
    });
    await db.insert(issues).values({
      id: planIssueId,
      companyId,
      missionId,
      assigneeAgentId: ownerAgentId,
      originKind: "mission_main_executor_plan",
      title: "[PLAN] Mission work structure",
      status: "in_progress",
      priority: "medium",
    });

    const actionIssue = await svc.create(companyId, {
      missionId,
      assigneeAgentId: workerAgentId,
      createdByAgentId: ownerAgentId,
      originKind: "mission_action",
      title: "[ACTION] Source dossiers for candidates",
      status: "todo",
      priority: "medium",
    });
    const qaIssue = await svc.create(companyId, {
      missionId,
      assigneeAgentId: qaAgentId,
      createdByAgentId: ownerAgentId,
      originKind: "mission_qa",
      title: "[QA] Independent evidence and claim verification",
      status: "todo",
      priority: "high",
    });
    const oversightIssue = await svc.create(companyId, {
      missionId,
      assigneeAgentId: ownerAgentId,
      createdByAgentId: ownerAgentId,
      originKind: "mission_main_executor_oversight",
      title: "[OVERSIGHT] Failure/retry/escalation decisions",
      status: "todo",
      priority: "medium",
    });

    expect(actionIssue).toEqual(expect.objectContaining({ parentId: null, issueGroup: "action" }));
    expect(qaIssue).toEqual(expect.objectContaining({ parentId: null, issueGroup: "qa" }));
    expect(oversightIssue).toEqual(expect.objectContaining({ parentId: null, issueGroup: "oversight" }));

    await expect(
      svc.create(companyId, {
        missionId,
        parentId: planIssueId,
        assigneeAgentId: qaAgentId,
        createdByAgentId: ownerAgentId,
        originKind: "mission_qa",
        title: "[QA] Plan-child validation should not be allowed",
        status: "todo",
        priority: "high",
      }),
    ).rejects.toThrow("Mission downstream issue creation is not allowed");
  });

  it("rejects nested mission child issues created by workers", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const planIssueId = randomUUID();
    const sourceIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: workerAgentId,
        companyId,
        name: "Research Worker",
        role: "worker",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Mission-scoped execution",
      status: "active",
    });
    await db.insert(issues).values([
      {
        id: planIssueId,
        companyId,
        missionId,
        assigneeAgentId: ownerAgentId,
        originKind: "mission_main_executor_plan",
        title: "[Plan] Mission",
        status: "done",
        priority: "medium",
      },
      {
        id: sourceIssueId,
        companyId,
        missionId,
        parentId: planIssueId,
        assigneeAgentId: workerAgentId,
        originKind: "manual",
        title: "[Source] First wave packet",
        status: "in_progress",
        priority: "medium",
      },
    ]);

    await expect(
      svc.create(companyId, {
        missionId,
        parentId: sourceIssueId,
        assigneeAgentId: workerAgentId,
        createdByAgentId: workerAgentId,
        title: "[Source Audit] Worker-created subpacket",
        status: "todo",
        priority: "medium",
      }),
    ).rejects.toThrow("Mission nested child issue creation is not allowed");
  });

  it("limits system-created mission child issue bursts without createdByAgentId", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const assigneeAgentId = randomUUID();
    const missionId = randomUUID();
    const parentIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: assigneeAgentId,
        companyId,
        name: "Researcher",
        role: "worker",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Mission-scoped execution",
      status: "active",
    });
    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      missionId,
      assigneeAgentId: ownerAgentId,
      originKind: "mission_main_executor_plan",
      title: "[Plan] Mission",
      status: "in_progress",
      priority: "medium",
    });

    for (let index = 0; index < 6; index += 1) {
      await svc.create(companyId, {
        missionId,
        parentId: parentIssueId,
        assigneeAgentId,
        title: `[Source] System packet ${index + 1}`,
        status: "todo",
        priority: "medium",
      });
    }

    await expect(
      svc.create(companyId, {
        missionId,
        parentId: parentIssueId,
        assigneeAgentId,
        title: "[Source] System packet 7",
        status: "todo",
        priority: "medium",
      }),
    ).rejects.toThrow("Mission child issue burst limit exceeded");
  });

  it("limits agent-created mission child issue bursts per parent", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const assigneeAgentId = randomUUID();
    const missionId = randomUUID();
    const parentIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: assigneeAgentId,
        companyId,
        name: "Researcher",
        role: "worker",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Mission-scoped execution",
      status: "active",
    });
    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      missionId,
      assigneeAgentId: ownerAgentId,
      originKind: "mission_main_executor_plan",
      title: "[Plan] Mission",
      status: "in_progress",
      priority: "medium",
    });

    for (let index = 0; index < 6; index += 1) {
      const issue = await svc.create(companyId, {
        missionId,
        parentId: parentIssueId,
        assigneeAgentId,
        createdByAgentId: ownerAgentId,
        title: `[Source] Packet ${index + 1}`,
        status: "todo",
        priority: "medium",
      });
      expect(issue.status).toBe("todo");
    }

    await expect(
      svc.create(companyId, {
        missionId,
        parentId: parentIssueId,
        assigneeAgentId,
        createdByAgentId: ownerAgentId,
        title: "[Source] Packet 7",
        status: "todo",
        priority: "medium",
      }),
    ).rejects.toThrow("Mission child issue burst limit exceeded");
  });
});

describeEmbeddedPostgres("issueService.addComment mission owner planning ingestion", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-owner-plan-comments-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(missionPlanArtifacts);
    await db.delete(issues);
    await db.delete(workflowDefinitions);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedPlanningFixture() {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const missionId = randomUUID();
    const planningIssueId = randomUUID();
    const normalIssueId = randomUUID();
    const workflowDefinitionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Issue Plan Company",
      issuePrefix: `IP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "operator",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other Agent",
        role: "worker",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Planning mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowDefinitionId,
      companyId,
      name: "Smoke workflow",
    });
    await db.insert(issues).values([
      {
        id: planningIssueId,
        companyId,
        missionId,
        title: "Mission owner planning",
        originKind: "mission_main_executor_plan",
        status: "todo",
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: normalIssueId,
        companyId,
        missionId,
        title: "Normal workflow issue",
        originKind: "workflow_execution",
        status: "todo",
      },
    ]);

    return { companyId, ownerAgentId, otherAgentId, missionId, planningIssueId, normalIssueId, workflowDefinitionId };
  }

  function validDecision(missionId: string, workflowDefinitionId: string, title = "Run smoke") {
    return {
      missionId,
      missionGoal: "Ship controlled rollout",
      selectedExecutionUnits: [
        {
          id: `wf:${workflowDefinitionId}:step:smoke`,
          kind: "workflow_definition_step",
          title,
          selectionState: "selected",
          reason: "Required for validation",
          sourceRef: { type: "workflow_definition_step", id: workflowDefinitionId, stepId: "smoke" },
        },
      ],
      ruleRefs: ["rule:security"],
      kbRefs: ["kb:rollout"],
      requiredInputs: ["stagingUrl"],
      successCriteria: ["smoke passes"],
      steps: [{ id: "step-1", title: "Verify staging" }],
    };
  }

  async function activePlans(missionId: string) {
    return db
      .select()
      .from(missionPlanArtifacts)
      .where(eq(missionPlanArtifacts.missionId, missionId))
      .then((rows) => rows.filter((row) => row.status === "active"));
  }

  async function recordedActivities() {
    return db.select().from(activityLog).where(eq(activityLog.action, "mission.owner_plan.recorded"));
  }

  it("records an authorized owner planning decision comment as the active mission plan and audit activity", async () => {
    const { companyId, ownerAgentId, missionId, planningIssueId, workflowDefinitionId } = await seedPlanningFixture();
    const decision = validDecision(missionId, workflowDefinitionId);

    const comment = await svc.addComment(planningIssueId, decisionComment(decision), { agentId: ownerAgentId });

    expect(comment).toEqual(expect.objectContaining({ issueId: planningIssueId, authorAgentId: ownerAgentId }));
    const plans = await activePlans(missionId);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toEqual(expect.objectContaining({
      companyId,
      missionId,
      revision: 1,
      missionGoal: "Ship controlled rollout",
      requiredInputs: ["stagingUrl"],
      successCriteria: ["smoke passes"],
      steps: [{ id: "step-1", title: "Verify staging" }],
    }));
    expect(plans[0]!.refs).toMatchObject({
      selectedExecutionUnits: decision.selectedExecutionUnits,
      ownerPlanDecision: {
        planningIssueId,
        commentId: comment.id,
        decisionHash: expect.any(String),
      },
      paqoWorkflow: {
        workflowDefinitionId: expect.any(String),
        workflowRunId: expect.any(String),
        workflowName: "PAQO WBS: Ship controlled rollout",
        dependencyModel: "workflow_dag_intra_mission",
      },
    });

    const paqoDefinitions = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.name, "PAQO WBS: Ship controlled rollout"));
    expect(paqoDefinitions).toHaveLength(1);
    const paqoRuns = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, paqoDefinitions[0]!.id));
    expect(paqoRuns).toHaveLength(1);
    expect(paqoRuns[0]).toMatchObject({ companyId, missionId, status: "running" });
    const paqoStepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, paqoRuns[0]!.id));
    expect(paqoStepRuns).toHaveLength(2);
    const qaStepRun = paqoStepRuns.find((stepRun) => stepRun.stepId.startsWith("qa-"));
    expect(qaStepRun).toMatchObject({ issueId: null, status: "pending" });

    const activities = await recordedActivities();
    expect(activities).toHaveLength(1);
    expect(activities[0]).toEqual(expect.objectContaining({
      companyId,
      actorType: "agent",
      actorId: ownerAgentId,
      agentId: ownerAgentId,
      entityType: "mission",
      entityId: missionId,
    }));
    expect(activities[0]!.details).toMatchObject({
      missionPlanArtifactId: plans[0]!.id,
      revision: 1,
      planningIssueId,
      commentId: comment.id,
      decisionMakerKind: "agent",
      decisionMakerId: ownerAgentId,
      decisionHash: expect.any(String),
      idempotencyKey: expect.stringContaining(comment.id),
    });
  });

  it("does not duplicate a revision or activity when the same planning decision is posted again", async () => {
    const { ownerAgentId, missionId, planningIssueId, workflowDefinitionId } = await seedPlanningFixture();
    const decision = validDecision(missionId, workflowDefinitionId);

    await svc.addComment(planningIssueId, decisionComment(decision), { agentId: ownerAgentId });
    await svc.addComment(planningIssueId, decisionComment(decision), { agentId: ownerAgentId });

    const plans = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, missionId));
    expect(plans).toHaveLength(1);
    expect(await recordedActivities()).toHaveLength(1);
  });

  it("does not duplicate a revision or activity when a later planning comment repeats the same latest decision", async () => {
    const { ownerAgentId, missionId, planningIssueId, workflowDefinitionId } = await seedPlanningFixture();
    const decision = validDecision(missionId, workflowDefinitionId);

    await svc.addComment(planningIssueId, decisionComment(decision), { agentId: ownerAgentId });
    await svc.addComment(planningIssueId, "Acknowledged; proceed with that plan.", { agentId: ownerAgentId });

    const plans = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, missionId));
    expect(plans).toHaveLength(1);
    expect(await recordedActivities()).toHaveLength(1);
  });

  it("ignores decision-looking comments on non-planning issues", async () => {
    const { ownerAgentId, missionId, normalIssueId, workflowDefinitionId } = await seedPlanningFixture();

    await svc.addComment(normalIssueId, decisionComment(validDecision(missionId, workflowDefinitionId)), { agentId: ownerAgentId });

    expect(await activePlans(missionId)).toHaveLength(0);
    expect(await recordedActivities()).toHaveLength(0);
  });

  it("keeps unauthorized planning comments without recording a mission plan", async () => {
    const { otherAgentId, missionId, planningIssueId, workflowDefinitionId } = await seedPlanningFixture();

    const comment = await svc.addComment(planningIssueId, decisionComment(validDecision(missionId, workflowDefinitionId)), {
      agentId: otherAgentId,
    });

    expect(comment.authorAgentId).toBe(otherAgentId);
    expect(await activePlans(missionId)).toHaveLength(0);
    expect(await recordedActivities()).toHaveLength(0);
  });

  it("keeps invalid planning decision comments without recording a revision or activity", async () => {
    const { ownerAgentId, missionId, planningIssueId } = await seedPlanningFixture();
    const invalidDecision = {
      ...validDecision(missionId, randomUUID()),
      selectedExecutionUnits: [{ sourceRef: { type: "workflow_definition_step", id: randomUUID() } }],
    };

    const comment = await svc.addComment(planningIssueId, decisionComment(invalidDecision), { agentId: ownerAgentId });

    expect(comment.body).toContain("Mission owner plan decision");
    expect(await activePlans(missionId)).toHaveLength(0);
    expect(await recordedActivities()).toHaveLength(0);
  });

  it("still returns the comment and updates issue updatedAt", async () => {
    const { ownerAgentId, planningIssueId } = await seedPlanningFixture();
    const before = await db
      .select({ updatedAt: issues.updatedAt })
      .from(issues)
      .where(eq(issues.id, planningIssueId))
      .then((rows) => rows[0]!.updatedAt);

    const comment = await svc.addComment(planningIssueId, "Plain comment", { agentId: ownerAgentId });

    expect(comment).toEqual(expect.objectContaining({ issueId: planningIssueId, body: "Plain comment" }));
    const after = await db
      .select({ updatedAt: issues.updatedAt })
      .from(issues)
      .where(eq(issues.id, planningIssueId))
      .then((rows) => rows[0]!.updatedAt);
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });
});

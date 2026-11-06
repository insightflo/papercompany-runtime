import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issueComments, issueInboxArchives, issueWorkProducts, issues, missionPlanArtifacts, missions, srbIssuePairs, srbLinks } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { createSrbPairSync } from "../services/srb/pair-sync.ts";
import { setPublicUrlReadbackFetcher } from "../services/public-url-readback.ts";
import { registerIssuesServiceLockCasesA } from "./helpers/issues-service-lock-cases-a.js";
import { registerIssuesServiceLockCasesB } from "./helpers/issues-service-lock-cases-b.js";
import { registerIssuesServicePlanVerdictCases } from "./helpers/issues-service-plan-verdict-cases.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

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
    setPublicUrlReadbackFetcher(null);
    await db.delete(issueComments);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(srbIssuePairs);
    await db.delete(srbLinks);
    await db.delete(heartbeatRuns);
    await db.delete(issueWorkProducts);
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

  it("rejects agent-created loose mission-level structure issues", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Research Company",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Research Director",
        role: "ceo",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: workerAgentId,
        companyId,
        name: "Technology Research Agent",
        role: "researcher",
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
      title: "Research mission",
      status: "active",
    });

    await expect(svc.create(companyId, {
      assigneeAgentId: workerAgentId,
      createdByAgentId: ownerAgentId,
      missionId,
      originKind: "manual",
      status: "todo",
      title: "[ACTION] Evidence collection",
    })).rejects.toThrow(/server-native DAG/i);

    await expect(svc.create(companyId, {
      createdByUserId: "operator",
      missionId,
      originKind: "manual",
      status: "todo",
      title: "[ACTION] Operator-created unassigned issue",
    })).resolves.toEqual(expect.objectContaining({ assigneeAgentId: null }));

    const parentIssue = await svc.create(companyId, {
      assigneeAgentId: workerAgentId,
      createdByUserId: "operator",
      missionId,
      originKind: "manual",
      status: "todo",
      title: "[ACTION] Operator-created parent issue",
    });

    await expect(svc.create(companyId, {
      assigneeAgentId: workerAgentId,
      createdByAgentId: ownerAgentId,
      missionId,
      originKind: "manual",
      parentId: parentIssue.id,
      status: "todo",
      title: "[ACTION] Assigned subtask under an existing structure issue",
    })).resolves.toEqual(expect.objectContaining({ assigneeAgentId: workerAgentId }));
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
    setPublicUrlReadbackFetcher(null);
    await db.delete(issueComments);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(srbIssuePairs);
    await db.delete(srbLinks);
    await db.delete(heartbeatRuns);
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createManualOnboardingActionFixture() {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();
    const productUrl = "https://manual-onboarding.pages.dev/onboarding/concepts/feynman-method-v2/index.html";

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
        name: "Manual Onboarding Publisher",
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
      title: "Feynman method onboarding publish",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      assigneeAgentId: workerAgentId,
      originKind: "workflow_execution",
      title: "[ACTION] QA 통과 보고서를 manual-onboarding-publisher로 게시",
      description: "Delivery Verification: public URL must contain the expected title/topic/content marker.",
      status: "todo",
      priority: "medium",
    });
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "preview_url",
      provider: "manual_onboarding",
      title: "파인만 방법론: 초보자를 위한 판단 보고서",
      url: productUrl,
      externalId: "concepts/feynman-method-v2/index.html",
      status: "active",
      isPrimary: true,
      metadata: { source: "mission_owner_unblock_recovery" },
    });

    return { issueId, productUrl };
  }

  registerIssuesServiceLockCasesA({
    getDb: () => db,
    getSvc: () => svc,
    createManualOnboardingActionFixture,
  });

  registerIssuesServiceLockCasesB({
    getDb: () => db,
    getSvc: () => svc,
  });
});


registerIssuesServicePlanVerdictCases(embeddedPostgresSupport.supported);

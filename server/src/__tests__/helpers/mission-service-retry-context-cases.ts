import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, companies, issueComments, issueWorkProducts, issues, missions, workflowTransitionEvents, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { missionService } from "../../services/missions.js";
import { createMissionOwnerDecisionFixture } from "./mission-owner-decision-fixture.js";

export function registerMissionRetryContextCases(getDb: () => ReturnType<typeof createDb>) {
  const recordOwnerDecision = createMissionOwnerDecisionFixture(getDb);
  it("bundles original source instruction + active workProducts + latest REQUEST_CHANGES into the retry wake context (inactive/foreign excluded)", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({ wakeupRequestId: "wake-bundle-ctx", runId: "run-bundle-ctx" });

    await db.insert(companies).values({ id: companyId, name: "Retry Bundle Context Company", issuePrefix: `RB${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Retry bundle context mission", status: "active" });

    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });

    const distinctiveInstruction = "Distinctive-ORIG-INSTRUCTION: rebuild the Top25 table generator so every 비고 cell escapes pipe characters before rendering.";
    const sourceIssue = await issueService(db).create(companyId, {
      assigneeAgentId: workerAgentId,
      missionId,
      originKind: "workflow_execution",
      status: "blocked",
      title: "Synthesize distinctive report draft",
      description: distinctiveInstruction,
    });

    const activeProductTitle = "Distinctive-ACTIVE-PRODUCT tech-ai-news obsidian note";
    const activeProductUrl = "https://example.test/distinctive/active.md";
    const activeProductExternalId = "/distinctive/artifacts/active-note.md";
    const activeProductMetadataPath = "/distinctive/vault/active-note.md";
    const inactiveProductTitle = "Distinctive-INACTIVE-PRODUCT archived superseded draft (must be excluded)";
    const foreignMissionProductTitle = "Distinctive-FOREIGN-MISSION-PRODUCT same company different mission (must be excluded)";
    const foreignCompanyProductTitle = "Distinctive-FOREIGN-COMPANY-PRODUCT different company (must be excluded)";

    await db.insert(issueWorkProducts).values({ companyId, issueId: sourceIssue.id, type: "local_file", provider: "local_file", title: activeProductTitle, url: activeProductUrl, externalId: activeProductExternalId, metadata: { path: activeProductMetadataPath }, status: "active" });
    await db.insert(issueWorkProducts).values({ companyId, issueId: sourceIssue.id, type: "local_file", provider: "local_file", title: inactiveProductTitle, url: "https://example.test/distinctive/inactive.md", status: "archived" });

    // same company, different mission + different source issue — must be excluded by mission+source scope.
    const foreignMissionId = randomUUID();
    await db.insert(missions).values({ id: foreignMissionId, companyId, ownerAgentId, title: "Foreign mission", status: "active" });
    const foreignMissionSourceIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId: foreignMissionId, originKind: "workflow_execution", status: "todo", title: "Foreign mission source issue" });
    await db.insert(issueWorkProducts).values({ companyId, issueId: foreignMissionSourceIssue.id, type: "local_file", provider: "local_file", title: foreignMissionProductTitle, url: "https://example.test/distinctive/foreign-mission.md", status: "active" });

    // true foreign-COMPANY isolation: active product in a different company must be excluded by company scope.
    const foreignCompanyId = randomUUID();
    const foreignCompanyAgentId = randomUUID();
    const foreignCompanyMissionId = randomUUID();
    await db.insert(companies).values({ id: foreignCompanyId, name: "Foreign Company", issuePrefix: `FC${foreignCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: foreignCompanyAgentId, companyId: foreignCompanyId, name: "Foreign Worker", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(missions).values({ id: foreignCompanyMissionId, companyId: foreignCompanyId, ownerAgentId: foreignCompanyAgentId, title: "Foreign company mission", status: "active" });
    const foreignCompanySourceIssue = await issueService(db).create(foreignCompanyId, { assigneeAgentId: foreignCompanyAgentId, missionId: foreignCompanyMissionId, originKind: "workflow_execution", status: "todo", title: "Foreign company source issue" });
    await db.insert(issueWorkProducts).values({ companyId: foreignCompanyId, issueId: foreignCompanySourceIssue.id, type: "local_file", provider: "local_file", title: foreignCompanyProductTitle, url: "https://example.test/distinctive/foreign-company.md", status: "active" });

    const requestChangesSummary = "REQUEST_CHANGES: Distinctive-RC regenerate the infographic; 3 hallucinated panels and 8 missing source articles remain.";
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
      title: "Retry report producer with bundled context",
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: ownerAction.id,
      authorAgentId: ownerAgentId,
      body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${sourceIssue.identifier}`, "Reason: retry with full source context"].join("\n"),
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
        reason: "retry with full source context",
      },
    });

    await svc.runMainExecutorSupervision({
      missionId,
      staleAfterMinutes: 1,
      now: new Date("2026-07-01T01:30:00.000Z"),
      applyOwnerDecisionActions: true,
      dispatchOwnerDecisionWakeups: true,
    });

    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledTimes(1);
    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledWith(expect.objectContaining({
      sourceIssue: expect.objectContaining({ id: sourceIssue.id }),
      targetAgentId: workerAgentId,
    }));

    const sourceComments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    const sourceBody = sourceComments.map((comment) => comment.body).join("\n");
    // (1) original source issue title + description
    expect(sourceBody).toContain("Original source issue instruction:");
    expect(sourceBody).toContain("Title: Synthesize distinctive report draft");
    expect(sourceBody).toContain(distinctiveInstruction);
    // (2) that source issue's own active workProducts — title + url + externalId + metadata path
    expect(sourceBody).toContain("Active workProducts on this source issue");
    expect(sourceBody).toContain(activeProductTitle);
    expect(sourceBody).toContain(`url=${activeProductUrl}`);
    expect(sourceBody).toContain(`externalId=${activeProductExternalId}`);
    expect(sourceBody).toContain(`path=${activeProductMetadataPath}`);
    // (3) exact latest REQUEST_CHANGES feedback
    expect(sourceBody).toContain("Latest REQUEST_CHANGES summary");
    expect(sourceBody).toContain(requestChangesSummary);
    // inactive product excluded (status != active)
    expect(sourceBody).not.toContain(inactiveProductTitle);
    // same-company different mission/source excluded (mission+source scope)
    expect(sourceBody).not.toContain(foreignMissionProductTitle);
    // true foreign-company isolation excluded (company scope)
    expect(sourceBody).not.toContain(foreignCompanyProductTitle);
  });

  it("marks retry_source_issue wakeup handled when workflow resume already dispatched it", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const onOwnerDecisionRetrySourceIssueApplied = vi.fn().mockResolvedValue({
      status: "workflow_already_dispatched",
      workflowWakeupRequestId: "workflow-wake-1",
      runId: "workflow-run-1",
    });

    await db.insert(companies).values({ id: companyId, name: "Workflow Handled Retry Company", issuePrefix: `WH${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Mission Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Worker Agent", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Workflow handled retry mission", status: "active" });
    const svc = missionService(db, { onOwnerDecisionRetrySourceIssueApplied });
    const blockedIssue = await issueService(db).create(companyId, { assigneeAgentId: workerAgentId, missionId, originKind: "workflow_execution", status: "blocked", title: "Blocked workflow source" });
    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 10 * 60 * 1000) });
    const unblockIssue = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock")).then((rows) => rows[0]!);
    // [owner-action contract] seed queued wakeup evidence for source (new guard requires it).
    await db.insert(agentWakeupRequests).values({ companyId, agentId: workerAgentId, source: "automation", status: "queued", issueId: unblockIssue.originId!, requestedAt: new Date() });
    await issueService(db).update(unblockIssue.id, { status: "done" });
    await db.insert(issueComments).values({ companyId, issueId: unblockIssue.id, authorAgentId: ownerAgentId, body: ["### Mission owner decision", "Decision: retry_source_issue", `Source issue: ${blockedIssue.identifier}`, "Reason: retry via workflow wake"].join("\n") });
    await recordOwnerDecision({
      companyId,
      missionId,
      ownerActionIssueId: unblockIssue.id,
      ownerAgentId,
      sourceIssueId: blockedIssue.id,
      submission: {
        decision: "retry_source_issue",
        sourceIssueRef: blockedIssue.identifier ?? blockedIssue.id,
        reason: "retry via workflow wake",
      },
    });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 1, now: new Date(Date.now() + 20 * 60 * 1000), applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true });
    const idempotencyKey = `mission-owner-decision-wakeup:${missionId}:${unblockIssue.id}:${blockedIssue.id}:retry_source_issue:event:${(await db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.issueId, unblockIssue.id), eq(workflowTransitionEvents.eventType, "mission_owner_decision"))))[0]!.id}`;

    expect(onOwnerDecisionRetrySourceIssueApplied).toHaveBeenCalledWith(expect.objectContaining({ targetAgentId: workerAgentId, idempotencyKey }));
    expect(result.appliedActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "owner_decision_retry_source_issue", sourceIssueId: blockedIssue.id, wakeupDispatchStatus: "workflow_already_dispatched", idempotencyKey }),
    ]));
    const sourceBody = await db.select().from(issueComments).where(eq(issueComments.issueId, blockedIssue.id)).then((rows) => rows.map((row) => row.body).join("\n"));
    expect(sourceBody).toContain("Mission owner retry wakeup handled by workflow");
    expect(sourceBody).toContain("mission-owner-decision-wakeup-dispatched");
    expect(sourceBody).toContain(idempotencyKey);
  });
}

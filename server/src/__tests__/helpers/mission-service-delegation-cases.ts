import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, issueWorkProducts, issues, missionDelegations, missions, type createDb } from "@paperclipai/db";
import { missionService } from "../../services/missions.js";
import { missionDelegationService } from "../../services/mission-delegations.js";

export function registerMissionDelegationCases(getDb: () => ReturnType<typeof createDb>) {
  it("creates and finalizes a cross-company mission delegation", async () => {
    const db = getDb();
    const sourceCompanyId = randomUUID();
    const targetCompanyId = randomUUID();
    const sourceOwnerAgentId = randomUUID();
    const targetOwnerAgentId = randomUUID();

    await db.insert(companies).values([
      {
        id: sourceCompanyId,
        name: "Development Company",
        issuePrefix: `DV${sourceCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: targetCompanyId,
        name: "Research Company",
        issuePrefix: `RS${targetCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(agents).values([
      {
        id: sourceOwnerAgentId,
        companyId: sourceCompanyId,
        name: "Dev CEO",
        role: "ceo",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: targetOwnerAgentId,
        companyId: targetCompanyId,
        name: "Research CEO",
        role: "ceo",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const missionsSvc = missionService(db);
    const sourceMission = await missionsSvc.create({
      companyId: sourceCompanyId,
      ownerAgentId: sourceOwnerAgentId,
      title: "Build daily trend dashboard",
      description: "Development mission that needs research input.",
      status: "active",
    });

    const created = await missionDelegationService(db).create({
      sourceMissionId: sourceMission.id,
      targetCompanyId,
      targetOwnerAgentId,
      title: "Research daily trend briefing sources",
      description: "Research and return grouped news source material.",
    });

    expect(created.delegation.sourceMissionId).toBe(sourceMission.id);
    expect(created.delegation.targetMissionId).toBe(created.targetMission.id);
    expect(created.sourceIssue.status).toBe("blocked");
    expect(created.targetMission.companyId).toBe(targetCompanyId);
    expect(created.targetMission.title).toContain("[DELEGATED]");

    const [targetWorkIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.missionId, created.targetMission.id))
      .limit(1);
    expect(targetWorkIssue).toBeTruthy();

    await db.insert(issueWorkProducts).values({
      companyId: targetCompanyId,
      issueId: targetWorkIssue.id,
      type: "html_report",
      provider: "test",
      externalId: "research-report-1",
      title: "Daily trend research report",
      url: "file:///tmp/daily-trend.html",
      status: "ready",
      reviewState: "accepted",
      isPrimary: true,
      healthStatus: "healthy",
      summary: "Grouped news research output.",
    });

    await missionsSvc.update(created.targetMission.id, { status: "completed" });

    const [updatedDelegation] = await db
      .select()
      .from(missionDelegations)
      .where(eq(missionDelegations.id, created.delegation.id));
    expect(updatedDelegation.status).toBe("completed");
    expect(updatedDelegation.completedAt).toBeInstanceOf(Date);

    const [sourceIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, created.sourceIssue.id));
    expect(sourceIssue.status).toBe("done");

    const copiedProducts = await db
      .select()
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.issueId, created.sourceIssue.id));
    expect(copiedProducts).toHaveLength(1);
    expect(copiedProducts[0]).toMatchObject({
      companyId: sourceCompanyId,
      provider: "delegated_mission",
      title: "Daily trend research report",
      url: "file:///tmp/daily-trend.html",
    });
  });

  it("applies mission status timestamp side effects on status-only updates", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Mission Status Company",
      issuePrefix: `MS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Mission Owner",
      role: "operator",
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
      title: "Status-only update mission",
      status: "planning",
    });

    const svc = missionService(db);
    const completed = await svc.update(missionId, { status: "completed" });

    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBeInstanceOf(Date);

    const active = await svc.update(missionId, { status: "active" });

    expect(active.status).toBe("active");
    expect(active.startedAt).toBeInstanceOf(Date);
    expect(active.completedAt).toBeNull();
  });
}

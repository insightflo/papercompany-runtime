import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, missions, workflowDefinitions, workflowRuns, type createDb } from "@paperclipai/db";
import { missionService } from "../../services/missions.js";

export function registerMissionListingCases(getDb: () => ReturnType<typeof createDb>) {
  it("filters listed missions by inclusive created date range", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Date Filter Mission Company",
      issuePrefix: `DF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      timezone: "Asia/Seoul",
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

    await db.insert(missions).values([
      {
        id: randomUUID(),
        companyId,
        ownerAgentId,
        title: "Before range",
        status: "active",
        createdAt: new Date("2026-03-31T14:59:59.999Z"),
      },
      {
        id: randomUUID(),
        companyId,
        ownerAgentId,
        title: "Inside range start",
        status: "active",
        createdAt: new Date("2026-03-31T15:00:00.000Z"),
      },
      {
        id: randomUUID(),
        companyId,
        ownerAgentId,
        title: "Inside range end",
        status: "active",
        createdAt: new Date("2026-04-29T14:59:59.999Z"),
      },
      {
        id: randomUUID(),
        companyId,
        ownerAgentId,
        title: "After range",
        status: "active",
        createdAt: new Date("2026-04-29T15:00:00.000Z"),
      },
    ]);

    const result = await missionService(db).list({
      companyId,
      from: "2026-04-01",
      to: "2026-04-29",
      sortBy: "createdAt",
      sortOrder: "asc",
    });

    expect(result.map((mission) => mission.title)).toEqual([
      "Inside range start",
      "Inside range end",
    ]);
  });

  it("breaks updatedAt ties deterministically (newer createdAt first, then id desc)", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const tiedUpdatedAt = new Date("2026-08-27T04:26:53.970Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Tie Sort Mission Company",
      issuePrefix: `TS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Tie Sort Owner",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // 동일 updatedAt 타이: createdAt도 같으면 id desc로, createdAt이 다르면 최신 createdAt 우선.
    // 삽입 순서(id 0000 먼저, ffff 나중; 오래 만든 것 먼저)와 기대 순서를 반대로 놓아
    // tiebreaker 없는 현재 구현이 힙 순서(삽입 순)를 반환하면 실패하도록 만든다.
    await db.insert(missions).values([
      {
        id: "00000000-0000-4000-8000-000000000000",
        companyId,
        ownerAgentId,
        title: "Tie same-created low-id",
        status: "active",
        createdAt: new Date("2026-08-20T00:00:00.000Z"),
        updatedAt: tiedUpdatedAt,
      },
      {
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        companyId,
        ownerAgentId,
        title: "Tie same-created high-id",
        status: "active",
        createdAt: new Date("2026-08-20T00:00:00.000Z"),
        updatedAt: tiedUpdatedAt,
      },
      {
        id: "11111111-1111-4111-8111-111111111111",
        companyId,
        ownerAgentId,
        title: "Tie newer-created",
        status: "active",
        createdAt: new Date("2026-08-26T00:00:00.000Z"),
        updatedAt: tiedUpdatedAt,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        companyId,
        ownerAgentId,
        title: "Distinct newer updatedAt",
        status: "active",
        createdAt: new Date("2026-08-19T00:00:00.000Z"),
        updatedAt: new Date("2026-08-27T04:32:03.615Z"),
      },
    ]);

    const result = await missionService(db).list({
      companyId,
      sortBy: "updatedAt",
      sortOrder: "desc",
    });

    expect(result.map((mission) => mission.title)).toEqual([
      "Distinct newer updatedAt",
      "Tie newer-created",
      "Tie same-created high-id",
      "Tie same-created low-id",
    ]);
  });

  it("does not re-stamp updatedAt when explicitly reconciling an already-settled workflow mission twice", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const runCompletedAt = new Date("2026-08-27T02:39:53.000Z");
    const settledUpdatedAt = new Date("2026-08-27T02:39:53.000Z");
    const missionId = randomUUID();
    const workflowId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Noop Reconcile Company",
      issuePrefix: `NR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Noop Reconcile Owner",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "youtube-report", stepsJson: [] });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "2026-08-27 youtube-report",
      description: "Created automatically for workflow run: run-1",
      status: "completed",
      startedAt: new Date("2026-08-27T01:52:23.000Z"),
      completedAt: runCompletedAt,
      updatedAt: settledUpdatedAt,
    });
    await db.insert(workflowRuns).values({
      id: randomUUID(),
      workflowId,
      companyId,
      missionId,
      triggeredBy: "board",
      status: "completed",
      startedAt: new Date("2026-08-27T01:52:23.000Z"),
      completedAt: runCompletedAt,
      runDate: "2026-08-27",
    });

    await missionService(db).reconcileById(missionId);
    await missionService(db).reconcileById(missionId);

    const [row] = await db.select({ updatedAt: missions.updatedAt }).from(missions).where(eq(missions.id, missionId));
    expect(row?.updatedAt.getTime()).toBe(settledUpdatedAt.getTime());
  });

  it("interprets date-only mission filters as local-day boundaries", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Local Date Filter Mission Company",
      issuePrefix: `LD${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      timezone: "Asia/Seoul",
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

    await db.insert(missions).values([
      {
        id: randomUUID(),
        companyId,
        ownerAgentId,
        title: "Local Apr 29 late night",
        status: "active",
        createdAt: new Date("2026-04-29T14:59:59.000Z"),
      },
      {
        id: randomUUID(),
        companyId,
        ownerAgentId,
        title: "Local Apr 30 morning",
        status: "active",
        createdAt: new Date("2026-04-29T22:00:00.000Z"),
      },
    ]);

    const result = await missionService(db).list({
      companyId,
      from: "2026-04-29",
      to: "2026-04-29",
      sortBy: "createdAt",
      sortOrder: "asc",
    });

    expect(result.map((mission) => mission.title)).toEqual(["Local Apr 29 late night"]);
  });
}

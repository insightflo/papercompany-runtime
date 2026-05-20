import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvalComments,
  approvals,
  companies,
  createDb,
  issueApprovals,
  issueComments,
  issues,
  missionPlanArtifacts,
  missions,
  type Db,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { missionRoutes } from "../routes/missions.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres mission governance thread route tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`);
}

type Actor =
  | { type: "board"; source: "session"; userId: string; companyIds: string[]; isInstanceAdmin?: boolean }
  | { type: "board"; source: "local_implicit"; userId: string };

function createApp(db: Db, actor: Actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", missionRoutes(db));
  app.use(errorHandler);
  return app;
}

function prefix(id: string, marker: string) {
  return `${marker}${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

describeEmbeddedPostgres("mission governance thread route", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-governance-thread-route-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(approvalComments);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(missionPlanArtifacts);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(marker: string) {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${marker} Company`,
      issuePrefix: prefix(companyId, marker),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: `${marker} Owner`,
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, ownerAgentId };
  }

  async function seedMission(companyId: string, ownerAgentId: string, title = "Governed mission") {
    const missionId = randomUUID();
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title,
      status: "active",
    });
    return missionId;
  }

  it("returns mission/company scoped governance thread payload for an authorized actor", async () => {
    const company = await seedCompany("GT");
    const missionId = await seedMission(company.companyId, company.ownerAgentId);
    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId: company.companyId,
      actorType: "system",
      actorId: "system",
      action: "route.visible",
      entityType: "mission",
      entityId: missionId,
      details: {},
    });

    const res = await request(createApp(db, { type: "board", source: "session", userId: "board", companyIds: [company.companyId] }))
      .get(`/api/missions/${missionId}/governance-thread`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      missionId,
      companyId: company.companyId,
      events: expect.any(Array),
      summary: expect.objectContaining({ totalEventCount: expect.any(Number), latestEvents: expect.any(Array), openDecisions: expect.any(Array) }),
    }));
    expect(res.body.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ companyId: company.companyId, scope: expect.objectContaining({ missionId }) }),
      expect.objectContaining({ sourceRef: expect.objectContaining({ type: "activity_log" }), summary: "route.visible" }),
    ]));
    expect(res.body.events.every((event: { companyId: string; scope: { missionId: string } }) => event.companyId === company.companyId && event.scope.missionId === missionId)).toBe(true);
  });

  it("returns access error without leaking governance payload for a mission in an inaccessible company", async () => {
    const allowed = await seedCompany("OK");
    const forbidden = await seedCompany("NO");
    const missionId = await seedMission(forbidden.companyId, forbidden.ownerAgentId, "Forbidden mission");
    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId: forbidden.companyId,
      actorType: "system",
      actorId: "system",
      action: "secret.governance.payload",
      entityType: "mission",
      entityId: missionId,
      details: {},
    });

    const res = await request(createApp(db, { type: "board", source: "session", userId: "board", companyIds: [allowed.companyId] }))
      .get(`/api/missions/${missionId}/governance-thread`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "User does not have access to this company" });
    expect(JSON.stringify(res.body)).not.toContain("secret.governance.payload");
    expect(res.body).not.toHaveProperty("events");
    expect(res.body).not.toHaveProperty("summary");
  });

  it("uses the existing not-found convention for a missing mission id", async () => {
    const company = await seedCompany("NF");
    const missingMissionId = randomUUID();

    const res = await request(createApp(db, { type: "board", source: "session", userId: "board", companyIds: [company.companyId] }))
      .get(`/api/missions/${missingMissionId}/governance-thread`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: `Mission not found: ${missingMissionId}` });
  });

  it("keeps similarly-shaped governance evidence isolated to the selected mission and company", async () => {
    const selected = await seedCompany("SA");
    const other = await seedCompany("OB");
    const selectedMissionId = await seedMission(selected.companyId, selected.ownerAgentId, "Selected mission");
    const otherMissionId = await seedMission(other.companyId, other.ownerAgentId, "Other mission");
    const selectedIssueId = randomUUID();
    const otherIssueId = randomUUID();
    await db.insert(issues).values([
      { id: selectedIssueId, companyId: selected.companyId, missionId: selectedMissionId, title: "Shared evidence shape", status: "blocked", priority: "high", assigneeAgentId: selected.ownerAgentId, issueNumber: 1 },
      { id: otherIssueId, companyId: other.companyId, missionId: otherMissionId, title: "Shared evidence shape", status: "blocked", priority: "high", assigneeAgentId: other.ownerAgentId, issueNumber: 1 },
    ]);
    await db.insert(issueComments).values([
      { id: randomUUID(), companyId: selected.companyId, issueId: selectedIssueId, authorUserId: "operator", body: `selected evidence ${selectedMissionId}` },
      { id: randomUUID(), companyId: other.companyId, issueId: otherIssueId, authorUserId: "operator", body: `other leak ${selectedMissionId}` },
    ]);
    const selectedApprovalId = randomUUID();
    const otherApprovalId = randomUUID();
    await db.insert(approvals).values([
      { id: selectedApprovalId, companyId: selected.companyId, type: "publish", status: "pending", payload: { marker: "selected approval" } },
      { id: otherApprovalId, companyId: other.companyId, type: "publish", status: "pending", payload: { marker: "other approval leak", missionId: selectedMissionId } },
    ]);
    await db.insert(issueApprovals).values([
      { companyId: selected.companyId, issueId: selectedIssueId, approvalId: selectedApprovalId },
      { companyId: other.companyId, issueId: otherIssueId, approvalId: otherApprovalId },
    ]);
    await db.insert(approvalComments).values([
      { id: randomUUID(), companyId: selected.companyId, approvalId: selectedApprovalId, authorUserId: "operator", body: "selected approval comment" },
      { id: randomUUID(), companyId: other.companyId, approvalId: otherApprovalId, authorUserId: "operator", body: `other approval leak ${selectedMissionId}` },
    ]);

    const res = await request(createApp(db, { type: "board", source: "session", userId: "board", companyIds: [selected.companyId] }))
      .get(`/api/missions/${selectedMissionId}/governance-thread`);

    expect(res.status).toBe(200);
    expect(res.body.missionId).toBe(selectedMissionId);
    expect(res.body.companyId).toBe(selected.companyId);
    expect(res.body.events.some((event: { companyId: string }) => event.companyId === other.companyId)).toBe(false);
    expect(res.body.events.some((event: { scope: { missionId: string } }) => event.scope.missionId === otherMissionId)).toBe(false);
    expect(res.body.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceRef: expect.objectContaining({ type: "issue_comment" }), scope: expect.objectContaining({ issueId: selectedIssueId }) }),
      expect.objectContaining({ sourceRef: expect.objectContaining({ type: "approval" }), scope: expect.objectContaining({ approvalId: selectedApprovalId }) }),
      expect.objectContaining({ sourceRef: expect.objectContaining({ type: "approval_comment" }), scope: expect.objectContaining({ approvalId: selectedApprovalId }) }),
    ]));
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(otherIssueId);
    expect(serialized).not.toContain(otherApprovalId);
    expect(serialized).not.toContain("other leak");
    expect(serialized).not.toContain("other approval leak");
  });
});

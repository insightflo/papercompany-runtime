import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, issues, missions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { listCompanyHumanOperatorRequests } from "../services/missions/human-operator-requests.js";
import { HUMAN_OPERATOR_REQUEST_ACTION } from "../services/missions/human-operator-alert-events.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("listCompanyHumanOperatorRequests source routing", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-human-operator-listing-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 }); await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function seedOwnerUnblockRequest(input: { ownerStatus: string; sourceStatus: string; missionStatus?: string }) {
    companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const ownerIssueId = randomUUID();
    const sourceIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Human Operator Co",
      issuePrefix: `HO${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Mission Owner",
      role: "ceo",
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
      title: "Human operator routing mission",
      status: input.missionStatus ?? "active",
    });
    await db.insert(issues).values([
      {
        id: ownerIssueId,
        companyId,
        missionId,
        title: "owner unblock action",
        status: input.ownerStatus,
        assigneeAgentId: agentId,
      },
      {
        id: sourceIssueId,
        companyId,
        missionId,
        title: "source blocked deliverable",
        status: input.sourceStatus,
      },
    ]);
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: HUMAN_OPERATOR_REQUEST_ACTION,
      entityType: "issue",
      entityId: ownerIssueId,
      details: {
        missionId,
        issueId: ownerIssueId,
        sourceIssueId,
        decisionEventId: randomUUID(),
        decision: "escalate",
        reason: "preview_url workProduct missing",
        actorType: "agent",
        actorId: agentId,
      },
    });
    return { ownerIssueId, sourceIssueId, missionId };
  }

  it("routes the operator to the open source issue when the owner unblock issue is done", async () => {
    const { sourceIssueId } = await seedOwnerUnblockRequest({ ownerStatus: "done", sourceStatus: "blocked" });

    const requests = await listCompanyHumanOperatorRequests(db, { companyId });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.issueId).toBe(sourceIssueId);
    expect(requests[0]!.event.scope?.issueId).toBe(sourceIssueId);
    expect(requests[0]!.event.suggestedResumeTarget?.issueId).toBe(sourceIssueId);
  });

  it("hides the request when both source and owner unblock issues are closed", async () => {
    await seedOwnerUnblockRequest({ ownerStatus: "done", sourceStatus: "done" });

    const requests = await listCompanyHumanOperatorRequests(db, { companyId });

    expect(requests).toHaveLength(0);
  });

  it("hides the request when the mission is closed", async () => {
    await seedOwnerUnblockRequest({ ownerStatus: "done", sourceStatus: "blocked", missionStatus: "completed" });

    const requests = await listCompanyHumanOperatorRequests(db, { companyId });

    expect(requests).toHaveLength(0);
  });

  it("still lists the request via the owner issue when source issue is not provided", async () => {
    companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const ownerIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Owner Only Co",
      issuePrefix: `OO${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Mission Owner",
      role: "ceo",
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
      title: "Owner-only mission",
      status: "active",
    });
    await db.insert(issues).values({
      id: ownerIssueId,
      companyId,
      missionId,
      title: "open owner unblock",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: HUMAN_OPERATOR_REQUEST_ACTION,
      entityType: "issue",
      entityId: ownerIssueId,
      details: {
        missionId,
        issueId: ownerIssueId,
        decisionEventId: randomUUID(),
        decision: "request_input",
        actorType: "agent",
        actorId: agentId,
      },
    });

    const requests = await listCompanyHumanOperatorRequests(db, { companyId });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.issueId).toBe(ownerIssueId);
  });

});

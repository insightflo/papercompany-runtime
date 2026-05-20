import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  companies,
  createDb,
  issueApprovals,
  issueComments,
  issues,
  missions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildMissionSupervisionContext } from "../services/missions/mission-supervision-context.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres mission supervision context tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`);
}

describeEmbeddedPostgres("mission supervision context", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-supervision-context-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("includes a read-only compact governance thread with latest events and open decisions", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();
    const approvalId = randomUUID();
    const otherCompanyId = randomUUID();
    const otherOwnerAgentId = randomUUID();

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Supervision Governance Context",
        issuePrefix: `SG${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other Context Company",
        issuePrefix: `OC${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "operator",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherOwnerAgentId,
        companyId: otherCompanyId,
        name: "Other Owner",
        role: "operator",
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
      title: "Governed mission context",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      title: "Governed publish decision",
      status: "blocked",
      priority: "high",
      assigneeAgentId: ownerAgentId,
      issueNumber: 1,
    });
    await db.insert(issueComments).values([
      {
        id: randomUUID(),
        companyId,
        issueId,
        authorAgentId: ownerAgentId,
        body: "Owner needs approval before publish.",
      },
      {
        id: randomUUID(),
        companyId: otherCompanyId,
        issueId,
        authorAgentId: otherOwnerAgentId,
        body: "Cross-company comment must not appear.",
      },
    ]);
    await db.insert(approvals).values([
      {
        id: approvalId,
        companyId,
        type: "publish",
        status: "pending",
        payload: { channel: "blog" },
      },
      {
        id: randomUUID(),
        companyId: otherCompanyId,
        type: "publish",
        status: "pending",
        payload: { channel: "other" },
      },
    ]);
    await db.insert(issueApprovals).values({ companyId, issueId, approvalId });

    const context = await buildMissionSupervisionContext(db, { missionId });

    expect(context.governanceThread).not.toBeNull();
    expect(context.governanceThread?.summary.latestEvents.length).toBeGreaterThan(0);
    expect(context.governanceThread?.summary.latestEvents.length).toBeLessThanOrEqual(5);
    expect(context.governanceThread?.summary.openDecisions).toEqual([
      expect.objectContaining({
        eventType: "approval_requested",
        scope: expect.objectContaining({ missionId, issueId, approvalId }),
        sourceRef: expect.objectContaining({ type: "approval", id: approvalId }),
      }),
    ]);
    expect(context.governanceThread?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "status_changed", sourceRef: expect.objectContaining({ type: "mission", id: missionId }) }),
      expect.objectContaining({ eventType: "status_changed", sourceRef: expect.objectContaining({ type: "issue", id: issueId }) }),
    ]));
    expect(context.governanceThread?.events.some((event) => event.companyId === otherCompanyId)).toBe(false);
  });
});

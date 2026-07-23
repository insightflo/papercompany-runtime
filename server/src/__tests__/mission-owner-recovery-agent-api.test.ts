import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issues, missions, workflowTransitionEvents } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { submitMissionOwnerDecision } from "../services/missions/mission-owner-recovery-agent-api.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;

let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

beforeAll(async () => {
  tempDb = await startEmbeddedPostgresTestDatabase("owner-recovery-agent-api-");
}, 60_000);

afterAll(async () => {
  await tempDb?.cleanup();
});

describeEP("mission owner recovery decision API source scope", () => {
  let db!: ReturnType<typeof createDb>;

  beforeAll(() => {
    db = createDb(tempDb!.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function seedOwnerAction() {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const sourceIssueId = randomUUID();
    const ownerActionIssueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Owner recovery API company",
      issuePrefix: `OR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Mission owner",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Recovery mission", status: "active" });
    await db.insert(issues).values([
      { id: sourceIssueId, companyId, missionId, title: "Scoped source", status: "blocked", originKind: "workflow_execution" },
      {
        id: ownerActionIssueId,
        companyId,
        missionId,
        title: "Owner action",
        status: "in_progress",
        originKind: "mission_main_executor_unblock",
        originId: sourceIssueId,
        assigneeAgentId: ownerAgentId,
      },
    ]);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: ownerAgentId, issueId: ownerActionIssueId, status: "running" });
    await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, ownerActionIssueId));
    return { companyId, ownerAgentId, missionId, ownerActionIssueId, runId };
  }

  async function submit(seed: Awaited<ReturnType<typeof seedOwnerAction>>) {
    return submitMissionOwnerDecision({
      db,
      issueId: seed.ownerActionIssueId,
      actor: { actorType: "agent", actorId: seed.ownerAgentId, agentId: seed.ownerAgentId, runId: seed.runId },
      data: { decision: "recover_artifact" },
    });
  }

  it("fails closed for dangling, cross-company, and cross-mission owner-action sources", async () => {
    const seed = await seedOwnerAction();
    const missingSourceId = randomUUID();
    await db.update(issues).set({ originId: missingSourceId }).where(eq(issues.id, seed.ownerActionIssueId));
    await expect(submit(seed)).rejects.toThrow("requires a source issue in the same company and mission");

    const otherMissionId = randomUUID();
    const crossMissionSourceId = randomUUID();
    await db.insert(missions).values({ id: otherMissionId, companyId: seed.companyId, ownerAgentId: seed.ownerAgentId, title: "Other mission", status: "active" });
    await db.insert(issues).values({ id: crossMissionSourceId, companyId: seed.companyId, missionId: otherMissionId, title: "Cross mission", status: "todo" });
    await db.update(issues).set({ originId: crossMissionSourceId }).where(eq(issues.id, seed.ownerActionIssueId));
    await expect(submit(seed)).rejects.toThrow("requires a source issue in the same company and mission");

    const foreignCompanyId = randomUUID();
    const foreignAgentId = randomUUID();
    const foreignMissionId = randomUUID();
    const crossCompanySourceId = randomUUID();
    await db.insert(companies).values({ id: foreignCompanyId, name: "Foreign company", issuePrefix: "FOR", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: foreignAgentId, companyId: foreignCompanyId, name: "Foreign owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(missions).values({ id: foreignMissionId, companyId: foreignCompanyId, ownerAgentId: foreignAgentId, title: "Foreign mission", status: "active" });
    await db.insert(issues).values({ id: crossCompanySourceId, companyId: foreignCompanyId, missionId: foreignMissionId, title: "Cross company", status: "todo" });
    await db.update(issues).set({ originId: crossCompanySourceId }).where(eq(issues.id, seed.ownerActionIssueId));
    await expect(submit(seed)).rejects.toThrow("requires a source issue in the same company and mission");
  });
  it("persists each revised same-run human decision before materializing its request", async () => {
    const seed = await seedOwnerAction();
    const actor = { actorType: "agent" as const, actorId: seed.ownerAgentId, agentId: seed.ownerAgentId, runId: seed.runId };
    const first = await submitMissionOwnerDecision({
      db, issueId: seed.ownerActionIssueId, actor,
      data: { decision: "request_input", reason: "Need a credential." },
    });
    const revised = await submitMissionOwnerDecision({
      db, issueId: seed.ownerActionIssueId, actor,
      data: { decision: "request_input", reason: "Need the production credential." },
    });
    expect(revised.eventId).not.toBe(first.eventId);
    const [event] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, revised.eventId));
    expect(event?.payload).toMatchObject({ reason: "Need the production credential." });
    const requests = await db.select({ details: activityLog.details }).from(activityLog)
      .where(eq(activityLog.companyId, seed.companyId));
    expect(requests.some((request) => (
      (request.details as Record<string, unknown>).decisionEventId === revised.eventId
      && (request.details as Record<string, unknown>).reason === "Need the production credential."
    ))).toBe(true);
  });
});

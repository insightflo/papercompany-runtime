import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  missionAgentRuntimes,
  missions,
} from "@paperclipai/db";
import {
  assertMissionRuntimeAcceptsWork,
  buildIssueEnvelopePolicy,
  buildMissionIssueHandoffMarkdown,
  buildMissionRuntimeKey,
  ensureMissionAgentRuntime,
  MISSION_RUNTIME_WORK_BLOCKING_STATUSES,
  TERMINAL_MISSION_STATUSES,
  TERMINAL_WORKFLOW_STATUSES,
} from "../services/missions/mission-runtime-manager.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres mission runtime manager tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("mission runtime manager", () => {
  it("builds runtime keys with company, mission, agent, adapter, and workspace isolation", () => {
    const base = {
      companyId: "company-1",
      missionId: "mission-1",
      agentId: "agent-1",
      adapterType: "claude_local",
    };

    expect(buildMissionRuntimeKey({ ...base, workspaceKey: "workspace-a" })).toBe(
      "company:company-1|mission:mission-1|agent:agent-1|adapter:claude_local|workspace:workspace-a",
    );
    expect(buildMissionRuntimeKey({ ...base, workspaceKey: "workspace-a" })).not.toBe(
      buildMissionRuntimeKey({ ...base, missionId: "mission-2", workspaceKey: "workspace-a" }),
    );
    expect(buildMissionRuntimeKey({ ...base, workspaceKey: "workspace-a" })).not.toBe(
      buildMissionRuntimeKey({ ...base, workspaceKey: "workspace-b" }),
    );
  });

  it("injects full context only for bootstrap or non-persistent runtimes", () => {
    expect(buildIssueEnvelopePolicy({ bootstrapRequired: true, supportsPersistentRuntime: true })).toEqual({
      bootstrapRequired: true,
      fullContextInjection: true,
      issueEnvelopeOnly: false,
    });
    expect(buildIssueEnvelopePolicy({ bootstrapRequired: false, supportsPersistentRuntime: true })).toEqual({
      bootstrapRequired: false,
      fullContextInjection: false,
      issueEnvelopeOnly: true,
    });
    expect(buildIssueEnvelopePolicy({ bootstrapRequired: false, supportsPersistentRuntime: false })).toEqual({
      bootstrapRequired: false,
      fullContextInjection: true,
      issueEnvelopeOnly: false,
    });
  });

  it("treats mission and workflow terminal states as runtime stop states", () => {
    expect(TERMINAL_MISSION_STATUSES.has("completed")).toBe(true);
    expect(TERMINAL_MISSION_STATUSES.has("cancelled")).toBe(true);
    expect(TERMINAL_MISSION_STATUSES.has("paused")).toBe(false);
    expect(MISSION_RUNTIME_WORK_BLOCKING_STATUSES.has("completed")).toBe(true);
    expect(MISSION_RUNTIME_WORK_BLOCKING_STATUSES.has("cancelled")).toBe(true);
    expect(MISSION_RUNTIME_WORK_BLOCKING_STATUSES.has("paused")).toBe(true);
    expect(TERMINAL_WORKFLOW_STATUSES.has("completed")).toBe(true);
    expect(TERMINAL_WORKFLOW_STATUSES.has("cancelled")).toBe(true);
    expect(TERMINAL_WORKFLOW_STATUSES.has("aborted")).toBe(true);
    expect(TERMINAL_WORKFLOW_STATUSES.has("running")).toBe(false);
  });

  it("builds handoffs with evidence and self-report caveat", () => {
    const handoff = buildMissionIssueHandoffMarkdown({
      missionId: "mission-1",
      issueId: "issue-1",
      agentId: "agent-1",
      runId: "run-1",
      status: "succeeded",
      issueGoal: "Ship the issue",
      summaryText: "Implemented and verified.",
      evidenceRefs: [
        { type: "heartbeat_run", id: "run-1", description: "runtime output" },
      ],
    });

    expect(handoff).toContain("# Issue Handoff");
    expect(handoff).toContain("Mission ID: mission-1");
    expect(handoff).toContain("heartbeat_run: run-1");
    expect(handoff).toContain("Treat this handoff as agent/runtime self-report");
  });
});

describeEmbeddedPostgres("mission runtime manager db guards", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mission-runtime-manager-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(missionAgentRuntimes);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedMission(status: "planning" | "active" | "paused" | "completed" | "cancelled") {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Runtime Guard Company",
      issuePrefix: `RG${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: `${status} mission`,
      status,
    });

    return { companyId, ownerAgentId, missionId };
  }

  it("blocks runtime work for paused missions", async () => {
    const { companyId, missionId } = await seedMission("paused");

    await expect(assertMissionRuntimeAcceptsWork(db, { companyId, missionId })).rejects.toMatchObject({
      code: "mission_not_accepting_work",
      status: "paused",
    });
  });

  it("prevents ensureMissionAgentRuntime from creating runtime rows for blocked missions", async () => {
    const { companyId, ownerAgentId, missionId } = await seedMission("completed");

    await expect(ensureMissionAgentRuntime(db, {
      companyId,
      missionId,
      agentId: ownerAgentId,
      adapterType: "codex_local",
      workspaceKey: "default",
    })).rejects.toMatchObject({
      code: "mission_not_accepting_work",
      status: "completed",
    });

    const rows = await db
      .select({ id: missionAgentRuntimes.id })
      .from(missionAgentRuntimes)
      .where(eq(missionAgentRuntimes.missionId, missionId));
    expect(rows).toHaveLength(0);
  });
});

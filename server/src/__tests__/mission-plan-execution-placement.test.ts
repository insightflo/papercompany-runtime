import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentToolGrants,
  agents,
  companies,
  createDb,
  toolDefinitions,
} from "@paperclipai/db";
import { reviewMissionPlanExecutionPlacement } from "../services/missions/mission-plan-execution-placement.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres mission plan execution placement tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function unit(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "mission_plan_unit",
    selectionState: "selected",
    sourceRef: { type: "mission_plan_unit", id: overrides.id ?? randomUUID() },
    ...overrides,
  };
}

describeEmbeddedPostgres("mission plan execution placement DB checks", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plan-placement-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(agentToolGrants);
    await db.delete(toolDefinitions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(input: {
    readonly companyId: string;
    readonly name: string;
    readonly desiredSkills?: readonly string[];
  }): Promise<string> {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: input.companyId,
      name: input.name,
      role: "worker",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: input.desiredSkills
        ? { paperclipSkillSync: { desiredSkills: input.desiredSkills } }
        : {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Placement Company",
      issuePrefix: "PLC",
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedTool(companyId: string, name = "manual-onboarding-publish"): Promise<string> {
    const toolId = randomUUID();
    await db.insert(toolDefinitions).values({
      id: toolId,
      companyId,
      name,
      description: "Publish through canonical workflow tool",
      adapterType: "builtin",
      adapterConfig: {},
    });
    return toolId;
  }

  it("checks workflow tool grants against the unit assignee, not another capable agent", async () => {
    const companyId = await seedCompany();
    const scoutAgentId = await seedAgent({ companyId, name: "Research Scout" });
    const directorAgentId = await seedAgent({ companyId, name: "Research Director" });
    const toolId = await seedTool(companyId);
    await db.insert(agentToolGrants).values({ companyId, agentId: directorAgentId, toolId, grantedBy: "board" });

    const diagnostics = await reviewMissionPlanExecutionPlacement({
      db,
      companyId,
      selectedExecutionUnits: [
        unit({
          id: "publish",
          title: "[ACTION] Publish approved concept page",
          assigneeAgentId: scoutAgentId,
          toolNames: ["manual-onboarding-publish"],
        }),
      ],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "workflow_tool_not_granted_to_assignee",
        message: expect.stringContaining("Research Scout"),
      }),
    ]);
  });

  it("does not borrow a workflow tool grant from another agent with the same display name", async () => {
    const companyId = await seedCompany();
    const grantedAgentId = await seedAgent({ companyId, name: "Research Scout" });
    const ungrantedAgentId = await seedAgent({ companyId, name: "Research Scout" });
    const toolId = await seedTool(companyId);
    await db.insert(agentToolGrants).values({ companyId, agentId: grantedAgentId, toolId, grantedBy: "board" });

    const diagnostics = await reviewMissionPlanExecutionPlacement({
      db,
      companyId,
      selectedExecutionUnits: [
        unit({
          id: "publish",
          title: "[ACTION] Publish approved concept page",
          assigneeAgentId: ungrantedAgentId,
          toolNames: ["manual-onboarding-publish"],
        }),
      ],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "workflow_tool_not_granted_to_assignee",
        message: expect.stringContaining("Research Scout"),
      }),
    ]);
  });

  it("rejects workflow tool names that are not in the catalog", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId, name: "Research Scout" });

    const diagnostics = await reviewMissionPlanExecutionPlacement({
      db,
      companyId,
      selectedExecutionUnits: [
        unit({
          id: "publish",
          assigneeAgentId: agentId,
          toolNames: ["missing-publish-tool"],
        }),
      ],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "workflow_tool_unavailable" }),
    ]);
  });

  it("allows a workflow tool when the unit assignee has the grant", async () => {
    const companyId = await seedCompany();
    const directorAgentId = await seedAgent({ companyId, name: "Research Director" });
    const toolId = await seedTool(companyId);
    await db.insert(agentToolGrants).values({ companyId, agentId: directorAgentId, toolId, grantedBy: "board" });

    const diagnostics = await reviewMissionPlanExecutionPlacement({
      db,
      companyId,
      selectedExecutionUnits: [
        unit({
          id: "publish",
          title: "[ACTION] Publish approved concept page",
          assigneeAgentId: directorAgentId,
          toolNames: ["manual-onboarding-publish"],
        }),
      ],
    });

    expect(diagnostics).toEqual([]);
  });

  it("rejects explicit skillRefs that do not match the unit assignee skills", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({
      companyId,
      name: "Research Scout",
      desiredSkills: ["company/test/storm-research"],
    });

    const diagnostics = await reviewMissionPlanExecutionPlacement({
      db,
      companyId,
      selectedExecutionUnits: [
        unit({
          id: "synthesis",
          title: "[ACTION] Produce manual-onboarding page",
          assigneeAgentId: agentId,
          skillRefs: ["manual-onboarding-publisher"],
        }),
      ],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "skill_ref_not_assigned_to_assignee" }),
    ]);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { count, eq } from "drizzle-orm";
import {
  activityLog,
  agentKbGrants,
  agents,
  companies,
  createDb,
  issues,
  knowledgeBases,
  missionAgents,
  missionPlanArtifacts,
  missions,
  pluginEntities,
  plugins,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  worktreeRules,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildMissionOwnerPlanningContext } from "../services/missions/mission-owner-planning-context.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres mission owner planning context tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`);
}

describeEmbeddedPostgres("mission owner planning context", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-owner-planning-context-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(pluginEntities);
    await db.delete(plugins);
    await db.delete(workflowDefinitions);
    await db.delete(worktreeRules);
    await db.delete(agentKbGrants);
    await db.delete(knowledgeBases);
    await db.delete(missionPlanArtifacts);
    await db.delete(issues);
    await db.delete(missionAgents);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function countTable(table: Parameters<typeof db.select>[0] extends never ? never : any) {
    const [row] = await db.select({ value: count() }).from(table);
    return row?.value ?? 0;
  }

  async function mutationCounts() {
    return {
      issues: await countTable(issues),
      missionPlanArtifacts: await countTable(missionPlanArtifacts),
      activityLog: await countTable(activityLog),
      workflowRuns: await countTable(workflowRuns),
      workflowStepRuns: await countTable(workflowStepRuns),
      pluginEntities: await countTable(pluginEntities),
    };
  }

  async function seedCompany(label: string) {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const helperAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: `${label} Company`,
      issuePrefix: label.replace(/[^A-Z0-9]/gi, "").slice(0, 8).toUpperCase(),
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: `${label} Owner`,
        role: "operator",
        title: "Mission owner",
        status: "active",
        capabilities: "planning,workflow,tech news",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: helperAgentId,
        companyId,
        name: `${label} Helper`,
        role: "researcher",
        status: "active",
        capabilities: "tech scout,research",
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
      title: "오늘자 tech news, tech scout 취합",
      description: "Collect AI tech news and scout implementation signals.",
      status: "planning",
    });

    await db.insert(missionAgents).values([
      { missionId, agentId: ownerAgentId, role: "executor" },
      { missionId, agentId: helperAgentId, role: "observer" },
    ]);

    return { companyId, ownerAgentId, helperAgentId, missionId };
  }

  async function seedPlugin() {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: `workflow-engine-${pluginId}`,
      packageName: "@paperclipai/plugin-workflow-engine-test",
      version: "0.0.0-test",
      categories: [],
      manifestJson: {
        id: `workflow-engine-${pluginId}`,
        name: "Workflow Engine Test",
        version: "0.0.0-test",
        apiVersion: 1,
      } as never,
      status: "installed",
    });
    return pluginId;
  }

  it("builds a bounded read-only context with native/plugin workflow candidates, rules, KB refs, active plan compact summary, and execution snapshots", async () => {
    const first = await seedCompany("MOPONE");
    const second = await seedCompany("MOPTWO");
    const pluginId = await seedPlugin();
    const nativeTechNewsWorkflowId = randomUUID();
    const nativeTechScoutWorkflowId = randomUUID();
    const nativeOtherCompanyWorkflowId = randomUUID();
    const pluginWorkflowDefinitionId = randomUUID();
    const pluginWrongScopeId = randomUUID();
    const pluginMismatchedDataId = randomUUID();
    const planningIssueId = randomUUID();
    const nativeRunId = randomUUID();
    const pluginRunId = randomUUID();
    const kbId = randomUUID();

    await db.insert(workflowDefinitions).values([
      {
        id: nativeTechNewsWorkflowId,
        companyId: first.companyId,
        name: "Tech News Daily Workflow",
        stepsJson: [{ id: "collect" }, { id: "summarize" }],
      },
      {
        id: nativeTechScoutWorkflowId,
        companyId: first.companyId,
        name: "Tech Scout Intake Workflow",
        stepsJson: [{ id: "scout" }],
      },
      {
        id: nativeOtherCompanyWorkflowId,
        companyId: second.companyId,
        name: "Cross-company Tech News Workflow",
        stepsJson: [{ id: "leak" }],
      },
    ]);

    await db.insert(pluginEntities).values([
      {
        id: pluginWorkflowDefinitionId,
        pluginId,
        entityType: "workflow-definition",
        scopeKind: "company",
        scopeId: first.companyId,
        externalId: "plugin-tech-scout",
        title: "Plugin Tech Scout Workflow",
        status: "active",
        data: { companyId: first.companyId, name: "Plugin Tech Scout Workflow", tags: ["tech", "scout"], steps: [{ id: "plugin-scout" }] },
      },
      {
        id: pluginWrongScopeId,
        pluginId,
        entityType: "workflow-definition",
        scopeKind: "company",
        scopeId: second.companyId,
        externalId: "wrong-scope",
        title: "Wrong Scope Plugin Workflow",
        status: "active",
        data: { companyId: first.companyId, name: "Wrong Scope Plugin Workflow" },
      },
      {
        id: pluginMismatchedDataId,
        pluginId,
        entityType: "workflow-definition",
        scopeKind: "company",
        scopeId: first.companyId,
        externalId: "mismatched-data-company",
        title: "Mismatched Data Plugin Workflow",
        status: "active",
        data: { companyId: second.companyId, name: "Mismatched Data Plugin Workflow" },
      },
      {
        id: pluginRunId,
        pluginId,
        entityType: "workflow-run",
        scopeKind: "company",
        scopeId: first.companyId,
        externalId: "plugin-run-1",
        title: "Plugin run for current mission",
        status: "running",
        data: {
          companyId: first.companyId,
          missionId: first.missionId,
          workflowId: "plugin-tech-scout",
          workflowName: "Plugin Tech Scout Workflow",
          status: "running",
        },
      },
    ]);

    await db.insert(issues).values({
      id: planningIssueId,
      companyId: first.companyId,
      missionId: first.missionId,
      title: "Plan mission",
      status: "todo",
      priority: "medium",
      assigneeAgentId: first.ownerAgentId,
      originKind: "mission_main_executor_plan",
      issueNumber: 1,
    });

    await db.insert(worktreeRules).values({
      id: randomUUID(),
      companyId: first.companyId,
      name: "Approval before publish",
      severity: "MUST",
      action: "approval required",
      predicate: { tags: ["publish"] },
      decisionMap: { mode: "approval_gate" },
      message: "Publishing needs approval.",
      createdBy: "test",
    });

    await db.insert(knowledgeBases).values({
      id: kbId,
      companyId: first.companyId,
      name: "Tech News Static KB",
      type: "static",
      description: "Static tech news process notes",
      configJson: { content: "Use source links." },
    });
    await db.insert(agentKbGrants).values({
      agentId: first.ownerAgentId,
      kbId,
      grantedBy: "test",
    });

    await db.insert(missionPlanArtifacts).values({
      id: randomUUID(),
      companyId: first.companyId,
      missionId: first.missionId,
      ownerAgentId: first.ownerAgentId,
      revision: 1,
      status: "active",
      missionGoal: "Coordinate tech news and scout collection.",
      refs: {
        planningIssueId,
        selectedExecutionUnits: [
          {
            id: "selected-private-unit",
            kind: "workflow_definition_step",
            title: "Private selected unit title",
            selectionState: "selected",
            executionState: "not_materialized",
            reason: "PRIVATE_REASON_SHOULD_NOT_LEAK",
            body: "PRIVATE_BODY_SHOULD_NOT_LEAK",
            evidenceRefs: [{ type: "artifact", id: "PRIVATE_EVIDENCE_SHOULD_NOT_LEAK" }],
            sourceRef: { type: "native_workflow_run", id: nativeTechNewsWorkflowId },
          },
        ],
        ruleRefs: [{ name: "Approval before publish", mode: "approval_gate" }],
      },
      assumptions: [],
      requiredInputs: [],
      successCriteria: [],
      risks: [],
      steps: [{ id: "plan", title: "Plan collection", status: "planned" }],
    });

    await db.insert(workflowRuns).values({
      id: nativeRunId,
      companyId: first.companyId,
      workflowId: nativeTechNewsWorkflowId,
      missionId: first.missionId,
      status: "running",
      triggeredBy: "test",
    });

    const before = await mutationCounts();
    const context = await buildMissionOwnerPlanningContext(db, { companyId: first.companyId, missionId: first.missionId });
    const after = await mutationCounts();

    expect(after).toEqual(before);
    expect(context.mission).toEqual(expect.objectContaining({ id: first.missionId, companyId: first.companyId, title: "오늘자 tech news, tech scout 취합" }));
    expect(context.planningIssueId).toBe(planningIssueId);
    expect(context.activePlan).toEqual(expect.objectContaining({
      available: true,
      selectedExecutionUnitCount: 1,
      selectedExecutionUnitLabels: ["Private selected unit title"],
      ruleNames: ["Approval before publish"],
    }));
    expect(context.activePlan).not.toHaveProperty("refs");
    expect(JSON.stringify(context)).not.toContain("PRIVATE_REASON_SHOULD_NOT_LEAK");
    expect(JSON.stringify(context)).not.toContain("PRIVATE_BODY_SHOULD_NOT_LEAK");
    expect(JSON.stringify(context)).not.toContain("PRIVATE_EVIDENCE_SHOULD_NOT_LEAK");

    expect(context.workflowCandidates.map((candidate) => candidate.name)).toEqual(expect.arrayContaining([
      "Tech News Daily Workflow",
      "Tech Scout Intake Workflow",
    ]));
    expect(context.workflowCandidates.map((candidate) => candidate.id)).not.toEqual(expect.arrayContaining([
      nativeOtherCompanyWorkflowId,
      pluginWrongScopeId,
      pluginMismatchedDataId,
    ]));
    expect(context.workflowCandidates.every((candidate) => candidate.source === "native")).toBe(true);
    expect(context.workflowCandidates.find((candidate) => candidate.id === nativeTechNewsWorkflowId)).toEqual(expect.objectContaining({
      purposeMatched: true,
      matchedPurposeTokens: expect.arrayContaining(["tech"]),
    }));
    expect(context.workflowCandidates.length).toBeLessThanOrEqual(12);
    expect(context.ruleRefs).toEqual([expect.objectContaining({ name: "Approval before publish", source: "worktree_rule" })]);
    expect(context.kbRefs).toEqual([expect.objectContaining({ id: kbId, name: "Tech News Static KB", source: "agent_kb_grant" })]);
    expect(context.todoMarkers).toEqual([expect.objectContaining({ key: "plugin_workflow_definition_reader_unconfirmed" })]);
    expect(context.agentRoster).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: first.ownerAgentId, name: "MOPONE Owner", role: "executor" }),
      expect.objectContaining({ agentId: first.helperAgentId, name: "MOPONE Helper", role: "observer" }),
    ]));
    expect(context.executionSourceSnapshot.units.map((unit) => unit.sourceRef.type)).toEqual(expect.arrayContaining([
      "native_workflow_run",
      "plugin_workflow_run",
    ]));
  });

  it("returns stable empty arrays and TODO markers when optional workflow/rule/KB substrates are absent", async () => {
    const seeded = await seedCompany("MOPEMPTY");

    const context = await buildMissionOwnerPlanningContext(db, { companyId: seeded.companyId, missionId: seeded.missionId });

    expect(context.planningIssueId).toBeNull();
    expect(context.activePlan).toEqual({ available: false });
    expect(context.executionSourceSnapshot).toEqual({ missionId: seeded.missionId, companyId: seeded.companyId, units: [] });
    expect(context.workflowCandidates).toEqual([]);
    expect(context.ruleRefs).toEqual([]);
    expect(context.kbRefs).toEqual([]);
    expect(context.todoMarkers).toEqual([expect.objectContaining({ key: "kb_refs_unavailable" })]);
  });

  it("enforces company isolation for mission lookup", async () => {
    const first = await seedCompany("MOPISOA");
    const second = await seedCompany("MOPISOB");

    await expect(buildMissionOwnerPlanningContext(db, { companyId: second.companyId, missionId: first.missionId }))
      .rejects.toThrow(/Mission not found/);
  });

  it("keeps the existing execution sourceRef vocabulary unchanged", async () => {
    const seeded = await seedCompany("MOPVOCAB");

    const context = await buildMissionOwnerPlanningContext(db, { companyId: seeded.companyId, missionId: seeded.missionId });

    expect(context.sourceRefVocabulary).toEqual([
      "native_workflow_run",
      "native_workflow_step_run",
      "plugin_workflow_run",
      "plugin_workflow_step_run",
    ]);
  });
});

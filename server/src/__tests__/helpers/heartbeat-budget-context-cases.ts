import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, issues, missions } from "@paperclipai/db";
import { seedMissionOwnerTaskContextFixture } from "./heartbeat-owner-context-fixture.js";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatContextCases({ getDb, heartbeatService, executeSpy, successfulAdapterResult, waitForRunTerminal }: HeartbeatBudgetCaseContext) {
  it("attaches mission-owner-task context to mission_main_executor_oversight issues", async () => {
    const db = getDb();
    const fixture = await seedMissionOwnerTaskContextFixture(db, "mission_main_executor_oversight");
    let invocationContext: Record<string, unknown> | undefined;
    executeSpy.mockImplementation(async ({ context }) => {
      invocationContext = structuredClone(context) as Record<string, unknown>;
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      fixture.agentId,
      "on_demand",
      { taskKey: "owner-action:oversight", issueId: fixture.ownerTaskIssueId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(invocationContext?.paperclipMissionOwnerTaskContext).toEqual(
      expect.objectContaining({
        available: true,
        gating: "originKind",
        mission: expect.objectContaining({ id: fixture.missionId }),
        ownerTaskIssue: expect.objectContaining({ id: fixture.ownerTaskIssueId, originKind: "mission_main_executor_oversight" }),
        sourceIssue: null,
      }),
    );
  });

  it("does not attach mission-owner-task context to normal workflow_execution issues assigned to the same agent", async () => {
    const db = getDb();
    const fixture = await seedMissionOwnerTaskContextFixture(db, "workflow_execution");
    let invocationContext: Record<string, unknown> | undefined;
    executeSpy.mockImplementation(async ({ context }) => {
      invocationContext = structuredClone(context) as Record<string, unknown>;
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      fixture.agentId,
      "on_demand",
      { taskKey: "worker:normal", issueId: fixture.ownerTaskIssueId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(invocationContext?.paperclipMissionOwnerTaskContext).toBeUndefined();
  });

  it("attaches mission-owner-task context from a valid mission-owner-action marker", async () => {
    const db = getDb();
    const fixture = await seedMissionOwnerTaskContextFixture(db, "manual", "placeholder");
    const marker = `<!-- mission-owner-action:{"missionId":"${fixture.missionId}","sourceIssueId":"${fixture.sourceIssueId}","actionType":"unblock","status":"decision_required"} -->`;
    await db.update(issues).set({ description: marker }).where(eq(issues.id, fixture.ownerTaskIssueId));
    let invocationContext: Record<string, unknown> | undefined;
    executeSpy.mockImplementation(async ({ context }) => {
      invocationContext = structuredClone(context) as Record<string, unknown>;
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      fixture.agentId,
      "on_demand",
      { taskKey: "owner-action:marker", issueId: fixture.ownerTaskIssueId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(invocationContext?.paperclipMissionOwnerTaskContext).toEqual(
      expect.objectContaining({
        available: true,
        gating: "mission-owner-action-marker",
        mission: expect.objectContaining({ id: fixture.missionId }),
        sourceIssue: expect.objectContaining({ id: fixture.sourceIssueId }),
      }),
    );
  });

  it("injects the checked-out issue task into adapter config even when the agent uses a custom prompt template", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    let invocationConfig: Record<string, unknown> | undefined;
    let invocationAgentConfig: Record<string, unknown> | undefined;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Custom Prompt Hermes Agent",
      role: "researcher",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig: { promptTemplate: "Route research requests only." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "PAP-TASK",
      title: "Plan today Tech Scout run",
      description: "Create the concrete source plan and first research request for today.",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    executeSpy.mockImplementation(async ({ config, agent }) => {
      invocationConfig = structuredClone(config) as Record<string, unknown>;
      invocationAgentConfig = structuredClone(agent.adapterConfig) as Record<string, unknown>;
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "on_demand",
      { taskKey: `issue:${issueId}`, issueId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(invocationAgentConfig).toEqual(expect.objectContaining(invocationConfig ?? {}));
    expect(invocationConfig).toEqual(
      expect.objectContaining({
        promptTemplate: expect.stringContaining("## Assigned Task"),
        taskId: issueId,
        taskTitle: "Plan today Tech Scout run",
        taskBody: "Create the concrete source plan and first research request for today.",
      }),
    );
    const injectedPromptTemplate = String(invocationConfig?.promptTemplate);
    expect(injectedPromptTemplate).toContain(`Issue ID: ${issueId}`);
    expect(injectedPromptTemplate).toContain("Title: Plan today Tech Scout run");
    expect(injectedPromptTemplate).toContain("Create the concrete source plan and first research request for today.");
    expect(injectedPromptTemplate).not.toContain("{{taskId}}");
    expect(injectedPromptTemplate).not.toContain("{{#taskId}}");
    expect(injectedPromptTemplate).toContain("Use Paperclip API env vars for lifecycle updates or evidence/blocker comments when needed.");
    expect(injectedPromptTemplate).toContain("Mark this issue done after its scoped evidence is posted");
  });

  it("injects a direct execution contract for delegated mission child issues", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const parentIssueId = randomUUID();
    const childIssueId = randomUUID();
    let invocationConfig: Record<string, unknown> | undefined;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Domain Research Agent",
      role: "researcher",
      status: "active",
      adapterType: "hermes_local",
      adapterConfig: {
        promptTemplate: "For broad work, create bounded child issues with parentId and goalId where available.",
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Mission child prompt contract",
      status: "active",
    });
    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      missionId,
      identifier: "PAP-PLAN",
      title: "Mission plan",
      description: "Create the first execution wave.",
      status: "done",
      assigneeAgentId: agentId,
      originKind: "mission_main_executor_plan",
    });
    await db.insert(issues).values({
      id: childIssueId,
      companyId,
      missionId,
      parentId: parentIssueId,
      identifier: "PAP-SOURCE",
      title: "Source dossier",
      description: "Post a source-backed issue comment. Do not produce HTML.",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "director_plan_source",
      requestDepth: 1,
    });

    executeSpy.mockImplementation(async ({ config }) => {
      invocationConfig = structuredClone(config) as Record<string, unknown>;
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, childIssueId));
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "on_demand",
      { taskKey: `issue:${childIssueId}`, issueId: childIssueId, missionId },
      "manual",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    const injectedPromptTemplate = String(invocationConfig?.promptTemplate);
    expect(injectedPromptTemplate).toContain("## Mission Child Issue Contract");
    expect(injectedPromptTemplate).toContain("This is a bounded mission child issue.");
    expect(injectedPromptTemplate).toContain("Work only this issue's scoped deliverable.");
    expect(injectedPromptTemplate).toContain("Do not create downstream, sibling, recovery, QA, synthesis, validator, or director-gate work unless this issue explicitly asks for it.");
    expect(injectedPromptTemplate).toContain("Treat the mission final output as mission context unless this issue explicitly asks you to create it.");
  });
}

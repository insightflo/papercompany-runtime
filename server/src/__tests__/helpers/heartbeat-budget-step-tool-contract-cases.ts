import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, issueComments, issues, toolDefinitions, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatStepToolContractCases({ getDb, heartbeatService, executeSpy, waitForRunTerminal }: HeartbeatBudgetCaseContext) {
  it("attaches workflow step tool contracts to the runtime context", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepRunId = randomUUID();
    const toolId = randomUUID();
    let invocationContext: Record<string, unknown> | undefined;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PFT",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Tool Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Use the workflow tool contract.",
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Workflow step issue",
      status: "todo",
    });
    await db.insert(toolDefinitions).values({
      id: toolId,
      companyId,
      name: "search-docs",
      description: "Search project documentation",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
      },
      adapterType: "builtin",
      adapterConfig: {},
      enabled: true,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Tool Workflow",
      stepsJson: [
        {
          id: "draft",
          name: "Draft",
          agentId,
          dependencies: [],
          toolNames: ["search-docs"],
          toolArgs: { query: "mission context" },
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId: null,
      triggeredBy: "system",
      status: "running",
    });
    await db.insert(workflowStepRuns).values({
      id: stepRunId,
      workflowRunId,
      stepId: "draft",
      issueId,
      status: "running",
    });

    executeSpy.mockImplementation(async ({ context }) => {
      invocationContext = structuredClone(context) as Record<string, unknown>;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        usage: null,
        provider: "test",
        model: "test-model",
        resultJson: null,
        runtimeServices: [],
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(finalized.status).toBe("succeeded");
    expect(invocationContext?.paperclipWorkflowStepToolContract).toEqual({
      workflowRunId,
      workflowId,
      stepId: "draft",
      stepName: "Draft",
      toolNames: ["search-docs"],
      toolArgs: { query: "mission context" },
      tools: [
        {
          name: "search-docs",
          description: "Search project documentation",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
          },
          adapterType: "builtin",
          instructions: null,
        },
      ],
    });
    expect(invocationContext?.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        inputs: expect.objectContaining({
          tools: {
            available: true,
            count: 1,
            names: ["search-docs"],
          },
        }),
      }),
    );
    const persistedComments = await db
      .select({ id: issueComments.id, body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(persistedComments).toHaveLength(0);
  });
}

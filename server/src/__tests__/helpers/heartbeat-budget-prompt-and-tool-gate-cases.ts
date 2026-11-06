import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { agents, companies, issues, missions, projects, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatPromptAndToolGateCases({ getDb, heartbeatService, executeSpy, successfulAdapterResult, waitForRunTerminal }: HeartbeatBudgetCaseContext) {
  it("injects assigned issue descriptions into adapter prompts when promptTemplate is empty", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const outputDir = "/srv/papercompany/projects/research-company/produced_work/missions/mission-1/runs/run-1/steps/collect-tech-scout-evidence";
    let invocationPromptTemplate = "";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PFT",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Technology Research Agent",
      role: "researcher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Collect TrendShift Top25 evidence",
      description: [
        "Deliverable output (use exactly this directory):",
        `- ${outputDir}`,
        "- Write evidence.json into that directory. Then finish your run output with one line: [ARTIFACT]: <absolute path of the file you wrote there>.",
      ].join("\n"),
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "workflow_execution",
    });

    executeSpy.mockImplementation(async ({ config }) => {
      invocationPromptTemplate = String(config.promptTemplate ?? "");
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(invocationPromptTemplate).toContain("## Assigned Task");
    expect(invocationPromptTemplate).toContain("Deliverable output (use exactly this directory):");
    expect(invocationPromptTemplate).toContain(outputDir);
    expect(invocationPromptTemplate).toContain("[ARTIFACT]:");
    expect(invocationPromptTemplate).not.toContain(`POST /api/issues/${issueId}/work-products`);
  });

  it("fails before adapter execution when a workflow step references missing tools", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepRunId = randomUUID();

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
          toolNames: ["missing-tool"],
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

    executeSpy.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      usage: null,
      provider: "test",
      model: "test-model",
      resultJson: null,
      runtimeServices: [],
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(executeSpy).not.toHaveBeenCalled();
    expect(finalized.status).toBe("failed");
    expect(finalized.errorCode).toBe("workflow_step_tool_contract_invalid");
    expect(finalized.error).toContain("missing tools: missing-tool");
  });
}

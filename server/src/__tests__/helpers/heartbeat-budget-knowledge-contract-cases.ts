import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, documents, knowledgeBases, issueComments, issues, agentKbGrants, workflowDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatKnowledgeContractCases({ getDb, heartbeatService, executeSpy, waitForRunTerminal }: HeartbeatBudgetCaseContext) {
  it("attaches workflow step knowledge contracts to the runtime context", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepRunId = randomUUID();
    const knowledgeBaseId = randomUUID();
    let invocationContext: Record<string, unknown> | undefined;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PFK",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Knowledge Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Use the workflow knowledge contract.",
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review production deployment policy",
      description: "We need the latest deployment checklist for production changes.",
      status: "todo",
    });
    await db.insert(knowledgeBases).values({
      id: knowledgeBaseId,
      companyId,
      name: "Deployment KB",
      type: "rag",
      description: "Deployment procedures",
      maxTokenBudget: 1024,
      configJson: {
        documents: [
          {
            id: "doc-1",
            title: "Production Deployment Checklist",
            content: "Production changes require a checklist, approvals, rollback notes, and smoke tests.",
          },
        ],
      },
    });
    await db.insert(agentKbGrants).values({
      id: randomUUID(),
      agentId,
      kbId: knowledgeBaseId,
      grantedBy: "board-user",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Knowledge Workflow",
      stepsJson: [
        {
          id: "draft",
          name: "Draft",
          agentId,
          dependencies: [],
          knowledgeBaseIds: [knowledgeBaseId],
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
    const run = await heartbeat.invoke(
      agentId,
      "on_demand",
      { issueId, note: "Need the production checklist." },
      "manual",
      {
        actorType: "system",
        actorId: "test-suite",
      },
    );

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(finalized.status).toBe("succeeded");
    expect(invocationContext?.paperclipWorkflowStepKnowledgeContext).toEqual({
      workflowRunId,
      workflowId,
      stepId: "draft",
      stepName: "Draft",
      knowledgeBaseIds: [knowledgeBaseId],
      entries: [
        expect.objectContaining({
          id: knowledgeBaseId,
          name: "Deployment KB",
          type: "rag",
          source: "Deployment KB",
          content: expect.stringContaining("Production Deployment Checklist"),
        }),
      ],
    });
    expect(invocationContext?.paperclipStepInputManifest).toEqual(
      expect.objectContaining({
        inputs: expect.objectContaining({
          knowledge: {
            available: true,
            count: 1,
            names: ["Deployment KB"],
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

  it("fails before adapter execution when a workflow step references inaccessible knowledge bases", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepRunId = randomUUID();
    const knowledgeBaseId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PFK",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Knowledge Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        promptTemplate: "Use the workflow knowledge contract.",
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review deployment policy",
      status: "todo",
    });
    await db.insert(knowledgeBases).values({
      id: knowledgeBaseId,
      companyId,
      name: "Restricted KB",
      type: "static",
      description: "Restricted knowledge",
      maxTokenBudget: 1024,
      configJson: {
        content: "Restricted deployment policy",
      },
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Knowledge Workflow",
      stepsJson: [
        {
          id: "draft",
          name: "Draft",
          agentId,
          dependencies: [],
          knowledgeBaseIds: [knowledgeBaseId],
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
    expect(finalized.errorCode).toBe("workflow_step_kb_contract_invalid");
    expect(finalized.error).toContain("missing or inaccessible KBs");
  });
}

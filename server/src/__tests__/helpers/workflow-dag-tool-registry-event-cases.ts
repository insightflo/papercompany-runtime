import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { companies, workflowDefinitions, workflowRuns, workflowStepRuns, type createDb } from "@paperclipai/db";
import { createPluginEventBus } from "../../services/plugin-event-bus.js";
import { completeWorkflowToolStepFromResult, executeWorkflowRun, processQueuedWorkflowToolStepRuns, setWorkflowToolStepExecutor } from "../../services/workflow/dag-engine.js";
import { registerNativeWorkflowToolResultEventHandlers } from "../../services/workflow/tool-result-events.js";

export function registerWorkflowDagToolRegistryEventCases(
  getDb: () => ReturnType<typeof createDb>,
) {
  it("preserves structured tool data alongside stdout when an issue-less tool step completes", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const executeToolStep = vi.fn().mockResolvedValue({ accepted: true });
    const sourceData = {
      sources: [{ title: "Public program", url: "https://example.com/program" }],
    };

    setWorkflowToolStepExecutor(executeToolStep);

    await db.insert(companies).values({
      id: companyId,
      name: "Structured Tool Result Company",
      issuePrefix: `SD${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Structured Tool Result Workflow",
      stepsJson: [{
        id: "collect",
        name: "Collect public sources",
        agentId: "",
        dependencies: [],
        toolNames: ["research-search"],
      }],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "system",
      status: "pending",
    });

    await executeWorkflowRun(db, runId);
    await processQueuedWorkflowToolStepRuns(db);
    const [stepRun] = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const request = executeToolStep.mock.calls[0]?.[0] as { requestId: string };

    await completeWorkflowToolStepFromResult(db, {
      companyId,
      stepRunId: stepRun!.id,
      requestId: request.requestId,
      workflowRunId: runId,
      stepId: "collect",
      toolName: "research-search",
      success: true,
      stdout: "Research search completed.",
      data: sourceData,
    });

    const [completedStepRun] = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, stepRun!.id));

    expect(completedStepRun?.metadata).toEqual(expect.objectContaining({
      toolResult: expect.objectContaining({
        stdout: "Research search completed.",
        data: sourceData,
      }),
    }));
  });

  it("advances native workflow steps from the tool-registry plugin result event", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const executeToolStep = vi.fn().mockResolvedValue({ accepted: true });
    const eventBus = createPluginEventBus();

    setWorkflowToolStepExecutor(executeToolStep);
    registerNativeWorkflowToolResultEventHandlers(db, eventBus);

    await db.insert(companies).values({
      id: companyId,
      name: "Native Event Workflow Company",
      issuePrefix: `NE${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Native Event Tool Workflow",
      stepsJson: [
        {
          id: "fetch",
          name: "Fetch",
          agentId: "",
          dependencies: [],
          toolNames: ["fetch-context"],
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "system",
      status: "pending",
    });

    const initial = await executeWorkflowRun(db, runId);
    expect(initial.status).toBe("running");
    await processQueuedWorkflowToolStepRuns(db);
    expect(executeToolStep).toHaveBeenCalledTimes(1);

    const [stepRun] = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    const dispatched = executeToolStep.mock.calls[0]?.[0] as { requestId: string };
    const eventData = {
      sources: [{ title: "Event source", url: "https://example.com/event-source" }],
    };

    const result = await eventBus.emit({
      eventId: randomUUID(),
      eventType: "plugin.insightflo.tool-registry.tool-execution-result",
      companyId,
      occurredAt: new Date().toISOString(),
      actorType: "plugin",
      actorId: "insightflo.tool-registry",
      payload: {
        requestId: dispatched.requestId,
        stepRunId: stepRun!.id,
        workflowRunId: runId,
        stepId: "fetch",
        toolName: "fetch-context",
        success: true,
        stdout: "event ok",
        data: eventData,
        exitCode: 0,
      },
    });
    expect(result.errors).toEqual([]);

    const storedStepRun = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, stepRun!.id))
      .then((rows) => rows[0]);
    expect(storedStepRun?.status).toBe("completed");
    expect(storedStepRun?.metadata).toEqual(expect.objectContaining({
      toolResult: expect.objectContaining({
        requestId: dispatched.requestId,
        toolName: "fetch-context",
        success: true,
        stdout: "event ok",
        data: eventData,
        exitCode: 0,
      }),
    }));

    const storedRun = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .then((rows) => rows[0]);
    expect(storedRun?.status).toBe("completed");
    expect(storedRun?.completedAt).toBeTruthy();
  });
}

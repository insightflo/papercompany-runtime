import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { companies, workflowDefinitions, workflowRuns, type createDb } from "@paperclipai/db";
import { setWorkflowToolStepReadinessChecker, setWorkflowToolStepExecutor } from "../../services/workflow/dag-engine.js";
import { workflowService } from "../../services/workflow/engine.js";

export function registerWorkflowDagToolReferenceCases(
  getDb: () => ReturnType<typeof createDb>,
) {
  it("rejects new workflow tool references when the tool system is unavailable", async () => {
    const db = getDb();
    const companyId = randomUUID();
    setWorkflowToolStepReadinessChecker(vi.fn().mockResolvedValue({
      available: false,
      reason: "Tool Registry plugin is not installed.",
    }));

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Toolless Workflow",
      issuePrefix: `TL${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await expect(workflowService.createDefinition(db, {
      companyId,
      name: "Unavailable Tool Workflow",
      steps: [
        {
          id: "collect",
          title: "Collect",
          type: "tool",
          toolName: "collect-data",
          dependsOn: [],
        },
      ] as never,
    })).rejects.toThrow("Workflow tools are unavailable: Tool Registry plugin is not installed.");
  });

  it("rejects new workflow tool references that are not selectable", async () => {
    const db = getDb();
    const companyId = randomUUID();
    setWorkflowToolStepExecutor(vi.fn().mockResolvedValue({ accepted: true }));
    setWorkflowToolStepReadinessChecker(vi.fn().mockResolvedValue({ available: true }));

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Missing Tool Workflow",
      issuePrefix: `MT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await expect(workflowService.createDefinition(db, {
      companyId,
      name: "Missing Tool Workflow",
      steps: [
        {
          id: "collect",
          title: "Collect",
          type: "tool",
          toolName: "collect-data",
          dependsOn: [],
        },
      ] as never,
    })).rejects.toThrow('Workflow tool "collect-data" is unavailable.');
  });

  it("preflights existing tool workflows before creating a new run", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const workflowId = randomUUID();
    setWorkflowToolStepReadinessChecker(vi.fn().mockResolvedValue({
      available: false,
      reason: "Tool Registry plugin worker is not running.",
    }));

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Existing Tool Workflow",
      issuePrefix: `ET${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Existing Tool Workflow",
      stepsJson: [
        {
          id: "collect",
          name: "Collect",
          dependencies: [],
          toolNames: ["collect-data"],
        },
      ],
    });

    await expect(workflowService.trigger(db, {
      workflowId,
      companyId,
      triggeredBy: "board",
      triggerSource: "manual",
    })).rejects.toThrow("Workflow tools are unavailable: Tool Registry plugin worker is not running.");

    const runs = await db.select().from(workflowRuns);
    expect(runs).toEqual([]);
  });
}

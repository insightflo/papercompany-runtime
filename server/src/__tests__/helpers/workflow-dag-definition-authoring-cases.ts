import { randomUUID } from "node:crypto";
import { and } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, type createDb } from "@paperclipai/db";
import { workflowService } from "../../services/workflow/engine.js";

export function registerWorkflowDagDefinitionAuthoringCases(
  getDb: () => ReturnType<typeof createDb>,
) {
  it("creates workflow definitions from plugin UI step payloads", async () => {
    const db = getDb();
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Workflow",
      issuePrefix: `WF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: "Plugin UI Workflow",
      steps: [
        {
          id: "qa-step",
          title: "QA step",
          description: "Use this step only for QA usability verification.",
          type: "agent",
          dependsOn: [],
        },
      ] as never,
    });

    expect(definition.name).toBe("Plugin UI Workflow");
    expect(definition.steps).toEqual([
      expect.objectContaining({
        id: "qa-step",
        name: "QA step",
        dependencies: [],
      }),
    ]);
  });

  it("adds QA request-changes back-edges to reusable workflow definitions at create time", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Reusable Workflow QA Loop Company",
      issuePrefix: `QL${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: producerAgentId, companyId, name: "Producer", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);

    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: "Reusable QA Loop Workflow",
      steps: [
        { id: "produce-report", name: "Produce report", agentId: producerAgentId, dependencies: [] },
        { id: "validate-report", qaType: "semantic", name: "Validate report", agentId: qaAgentId, dependencies: ["produce-report"] },
      ],
    });

    expect(definition.steps.find((step) => step.id === "produce-report")?.conditionalDependencies).toEqual([
      { stepId: "validate-report", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
    ]);
    expect(definition.steps.find((step) => step.id === "validate-report")?.conditionalDependencies).toBeUndefined();
  });

  it("treats final inspection as QA, removes its workProduct gate, and adds a rework back-edge", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Final Inspection Workflow Company",
      issuePrefix: `FI${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: producerAgentId, companyId, name: "Producer", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "Inspector", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);

    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: "Final Inspection Workflow",
      steps: [
        { id: "materialize-report", name: "Materialize report", agentId: producerAgentId, dependencies: [], graphWorkProductRequired: true },
        { id: "qa-dashboard-html", qaType: "semantic", name: "Validate report HTML", agentId: qaAgentId, dependencies: ["materialize-report"] },
        { id: "signal-analysis", name: "Signal analysis", agentId: producerAgentId, dependencies: [] },
        { id: "strategy-summary", name: "Strategy summary", agentId: producerAgentId, dependencies: ["signal-analysis"] },
        { id: "inspection", qaType: "semantic", name: "Final inspection", agentId: qaAgentId, dependencies: ["signal-analysis", "strategy-summary", "qa-dashboard-html"], graphWorkProductRequired: true },
      ],
    });

    expect(definition.steps.find((step) => step.id === "materialize-report")?.conditionalDependencies).toEqual([
      { stepId: "qa-dashboard-html", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
      { stepId: "inspection", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
    ]);
    expect(definition.steps.find((step) => step.id === "strategy-summary")?.conditionalDependencies).toBeUndefined();
    expect(definition.steps.find((step) => step.id === "inspection")?.graphWorkProductRequired).toBe(false);
  });

  it("preserves author-defined QA back-edges instead of replacing their loop cap", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Reusable Workflow Explicit Loop Company",
      issuePrefix: `EL${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: producerAgentId, companyId, name: "Producer", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);

    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: "Explicit QA Loop Workflow",
      steps: [
        {
          id: "produce-report",
          name: "Produce report",
          agentId: producerAgentId,
          dependencies: [],
          conditionalDependencies: [{ stepId: "validate-report", when: "qa_request_changes", isBackEdge: true, maxIterations: 5 }],
        },
        { id: "validate-report", qaType: "semantic", name: "Validate report", agentId: qaAgentId, dependencies: ["produce-report"] },
      ],
    });

    expect(definition.steps.find((step) => step.id === "produce-report")?.conditionalDependencies).toEqual([
      { stepId: "validate-report", when: "qa_request_changes", isBackEdge: true, maxIterations: 5 },
    ]);
  });

  it("adds QA request-changes back-edges when reusable workflow definitions are updated", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const producerAgentId = randomUUID();
    const qaAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Reusable Workflow Update Loop Company",
      issuePrefix: `UL${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: producerAgentId, companyId, name: "Producer", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: qaAgentId, companyId, name: "QA", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);

    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: "Updated QA Loop Workflow",
      steps: [
        { id: "produce-report", name: "Produce report", agentId: producerAgentId, dependencies: [] },
      ],
    });
    const updated = await workflowService.updateDefinition(db, definition.id, {
      steps: [
        { id: "produce-report", name: "Produce report", agentId: producerAgentId, dependencies: [] },
        { id: "validate-report", qaType: "semantic", name: "Validate report", agentId: qaAgentId, dependencies: ["produce-report"] },
      ],
    });

    expect(updated?.steps.find((step) => step.id === "produce-report")?.conditionalDependencies).toEqual([
      { stepId: "validate-report", when: "qa_request_changes", isBackEdge: true, maxIterations: 2 },
    ]);
  });
}

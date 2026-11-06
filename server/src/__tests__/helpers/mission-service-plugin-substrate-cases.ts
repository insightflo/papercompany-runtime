import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, issues, missionPlanArtifacts, missions, pluginEntities, plugins, type createDb } from "@paperclipai/db";
import { missionService } from "../../services/missions.js";
import { missionPluginManifest } from "./mission-service-fixtures.js";

export function registerMissionPluginSubstrateCases(getDb: () => ReturnType<typeof createDb>) {
  it("ensures plugin-backed active mission execution substrate idempotently", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const pluginId = randomUUID();
    const runEntityId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Plugin Substrate Company",
      issuePrefix: `PS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Main Executor",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: `test-plugin-${pluginId}`,
      packageName: "@paperclip/test-plugin",
      version: "0.0.1",
      manifestJson: missionPluginManifest(`test-plugin-${pluginId}`, "Test Plugin", "0.0.1"),
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Plugin-backed mission",
      description: "Created automatically for plugin workflow run: plugin-daily",
      status: "active",
    });
    await db.insert(pluginEntities).values({
      id: runEntityId,
      pluginId,
      entityType: "workflow-run",
      scopeKind: "company",
      scopeId: companyId,
      externalId: "plugin-run-1",
      title: "Plugin daily workflow",
      status: "running",
      data: {
        companyId,
        missionId,
        workflowId: "plugin-daily",
        workflowName: "Plugin Daily",
        status: "running",
      },
    });

    const svc = missionService(db);
    const first = await svc.ensureMissionExecutionPlan({ companyId, missionId });
    const second = await svc.ensureMissionExecutionPlan({ companyId, missionId });

    expect(second).toEqual(first);
    const oversightIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.missionId, missionId));
    const planArtifacts = await db
      .select()
      .from(missionPlanArtifacts)
      .where(eq(missionPlanArtifacts.missionId, missionId));

    expect(oversightIssues).toEqual([
      expect.objectContaining({
        originKind: "mission_main_executor_oversight",
        title: "[OVERSIGHT] Plugin Daily",
      }),
    ]);
    expect(planArtifacts).toHaveLength(1);
    expect(planArtifacts[0]?.refs).toMatchObject({
      schemaVersion: 2,
      oversightIssueId: oversightIssues[0]?.id,
      workflowName: "Plugin Daily",
      executionUnits: [
        expect.objectContaining({
          kind: "plugin_workflow_run",
          status: "running",
          sourceRef: expect.objectContaining({ type: "plugin_workflow_run", id: runEntityId }),
        }),
      ],
    });
  });

  it("replaces stale workflow run execution units when a workflow mission restarts", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const staleRunId = randomUUID();
    const currentRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Restarted Workflow Company",
      issuePrefix: `RW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Main Executor",
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
      title: "2026-06-14 tech-ai-news",
      status: "active",
    });

    const svc = missionService(db);
    await svc.ensureMissionExecutionPlan({
      companyId,
      missionId,
      sourceHints: {
        workflowName: "tech-ai-news",
        sourceRunId: staleRunId,
        workflowStepIds: ["collect-ai-news-evidence", "validate-ai-news-artifact"],
      },
    });
    await svc.ensureMissionExecutionPlan({
      companyId,
      missionId,
      sourceHints: {
        workflowName: "tech-ai-news",
        sourceRunId: currentRunId,
        workflowStepIds: ["collect-ai-news-evidence", "validate-ai-news-note", "send-telegram"],
      },
    });

    const [planArtifact] = await db
      .select()
      .from(missionPlanArtifacts)
      .where(eq(missionPlanArtifacts.missionId, missionId));
    const refs = planArtifact?.refs as Record<string, unknown>;
    const executionUnits = refs.executionUnits as Array<Record<string, unknown>>;
    const sourceRefs = executionUnits.map((unit) => unit.sourceRef as Record<string, unknown>);

    expect(refs.sourceRunId).toBe(currentRunId);
    expect(sourceRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: currentRunId, type: "native_workflow_run" }),
      expect.objectContaining({ id: "validate-ai-news-note", workflowRunId: currentRunId }),
      expect.objectContaining({ id: "send-telegram", workflowRunId: currentRunId }),
    ]));
    expect(sourceRefs.some((sourceRef) => sourceRef.id === staleRunId || sourceRef.workflowRunId === staleRunId)).toBe(false);
    expect(sourceRefs.some((sourceRef) => sourceRef.id === "validate-ai-news-artifact")).toBe(false);
  });
}

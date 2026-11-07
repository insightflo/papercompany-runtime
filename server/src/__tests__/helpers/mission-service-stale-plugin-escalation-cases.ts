import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, companies, issueComments, issues, missions, pluginEntities, plugins, type createDb } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { missionService } from "../../services/missions.js";
import { missionPluginManifest } from "./mission-service-fixtures.js";

export function registerMissionStalePluginEscalationCases(getDb: () => ReturnType<typeof createDb>) {
  it("escalates stale plugin execution units into owner-action issues without retrying the source", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const pluginId = randomUUID();
    const runEntityId = randomUUID();
    const stepEntityId = randomUUID();
    const staleObservedAt = new Date("2026-05-31T00:00:00.000Z");
    const now = new Date("2026-05-31T01:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Stale Plugin Escalation Company",
      issuePrefix: `SP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Main Executor", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: workerAgentId, companyId, name: "Tech Scout", role: "researcher", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: `stale-plugin-${pluginId}`,
      packageName: "@paperclip/stale-plugin",
      version: "0.0.1",
      manifestJson: missionPluginManifest(`stale-plugin-${pluginId}`, "Stale Plugin", "0.0.1"),
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Tech scout stale mission",
      status: "active",
    });
    const sourceIssue = await issueService(db).create(companyId, {
      assigneeAgentId: workerAgentId,
      missionId,
      originKind: "workflow_execution",
      status: "todo",
      title: "Collect Tech Scout Top25",
    });
    await db.insert(pluginEntities).values([
      {
        id: runEntityId,
        pluginId,
        entityType: "workflow-run",
        scopeKind: "company",
        scopeId: companyId,
        externalId: "stale-plugin-run",
        title: "Tech scout plugin workflow",
        status: "running",
        data: { companyId, missionId, workflowId: "tech-scout", workflowName: "Tech Scout", status: "running" },
        createdAt: staleObservedAt,
        updatedAt: staleObservedAt,
      },
      {
        id: stepEntityId,
        pluginId,
        entityType: "workflow-step-run",
        scopeKind: "company",
        scopeId: companyId,
        externalId: "stale-plugin-step",
        title: "plan-ai-news",
        status: "in_progress",
        data: { companyId, missionId, workflowRunId: runEntityId, stepId: "plan-ai-news", issueId: sourceIssue.id, status: "in_progress" },
        createdAt: staleObservedAt,
        updatedAt: staleObservedAt,
      },
    ]);

    const onOwnerActionCreated = vi.fn();
    const svc = missionService(db, { onOwnerActionCreated });
    await svc.ensureMissionExecutionPlan({ companyId, missionId });

    const result = await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 30, now });

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("stale_execution_unit"),
    ]));
    expect(result.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "request_replan",
        issueId: sourceIssue.id,
        sourceRef: expect.objectContaining({ type: "plugin_workflow_step_run", id: stepEntityId }),
        safeToAutoApply: false,
      }),
    ]));

    const missionIssues = await db.select().from(issues).where(eq(issues.missionId, missionId));
    const ownerActionIssues = missionIssues.filter((issue) => issue.originKind === "mission_main_executor_unblock");
    expect(ownerActionIssues).toEqual([
      expect.objectContaining({
        assigneeAgentId: ownerAgentId,
        originId: sourceIssue.id,
        parentId: sourceIssue.id,
        status: "todo",
        title: expect.stringContaining("Collect Tech Scout Top25"),
      }),
    ]);
    await expect(db.select().from(issues).where(eq(issues.id, sourceIssue.id)).then((rows) => rows[0])).resolves.toEqual(expect.objectContaining({
      assigneeAgentId: workerAgentId,
      status: "todo",
    }));
    expect(onOwnerActionCreated).toHaveBeenCalledTimes(1);
    expect(onOwnerActionCreated).toHaveBeenCalledWith(expect.objectContaining({
      mission: expect.objectContaining({ id: missionId, ownerAgentId }),
      issue: expect.objectContaining({ id: ownerActionIssues[0]?.id, assigneeAgentId: ownerAgentId }),
      sourceIssue: expect.objectContaining({ id: sourceIssue.id, assigneeAgentId: workerAgentId, status: "todo" }),
    }));

    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 30, now: new Date("2026-05-31T01:05:00.000Z") });
    const repeatedOwnerActions = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(repeatedOwnerActions).toHaveLength(1);

    await issueService(db).update(ownerActionIssues[0]!.id, { status: "done" });
    await db.insert(issueComments).values({
      companyId,
      issueId: ownerActionIssues[0]!.id,
      authorAgentId: ownerAgentId,
      body: [
        "### Mission owner decision",
        "Decision: no_action_waiting",
        `Source issue: ${sourceIssue.identifier}`,
        "Reason: The owner believed the stale workflow step was still actively running.",
        "Next action: Wait for the current step to finish.",
        "Evidence: Workflow step status was running.",
      ].join("\n"),
    });

    await svc.runMainExecutorSupervision({ missionId, staleAfterMinutes: 30, now: new Date("2026-05-31T02:00:00.000Z") });
    const commentOnlyOwnerActions = await db.select().from(issues).where(eq(issues.originKind, "mission_main_executor_unblock"));
    expect(commentOnlyOwnerActions).toHaveLength(1);
    expect(commentOnlyOwnerActions[0]).toEqual(expect.objectContaining({
      id: ownerActionIssues[0]!.id,
      status: "done",
      originId: sourceIssue.id,
    }));
    expect(onOwnerActionCreated).toHaveBeenCalledTimes(1);
  });
}

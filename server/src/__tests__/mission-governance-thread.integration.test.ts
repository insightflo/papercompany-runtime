import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvalComments,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issues,
  missionPlanArtifacts,
  missions,
  pluginEntities,
  plugins,
  toolAuditLog,
  toolDefinitions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { listMissionGovernanceThread } from "../services/missions/governance-thread.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres governance thread integration tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`);
}

function prefix(id: string, marker: string) {
  return `${marker}${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

describeEmbeddedPostgres("mission governance thread DB projection", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-governance-thread-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(toolAuditLog);
    await db.delete(toolDefinitions);
    await db.delete(approvalComments);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueComments);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(pluginEntities);
    await db.delete(plugins);
    await db.delete(missionPlanArtifacts);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(marker: string) {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${marker} Company`,
      issuePrefix: prefix(companyId, marker),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: `${marker} Owner`,
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, ownerAgentId };
  }

  it("returns a bounded valid thread for an empty same-company mission and null for cross-company lookup", async () => {
    const { companyId, ownerAgentId } = await seedCompany("EM");
    const other = await seedCompany("OX");
    const missionId = randomUUID();
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Empty mission",
      status: "planning",
    });
    await db.insert(activityLog).values([
      { id: randomUUID(), companyId, actorType: "system", actorId: "system", action: "custom.unknown", entityType: "mission", entityId: missionId, details: {} },
      { id: randomUUID(), companyId: other.companyId, actorType: "system", actorId: "system", action: "custom.other", entityType: "mission", entityId: missionId, details: {} },
    ]);

    const thread = await listMissionGovernanceThread(db, { companyId, missionId });
    expect(thread).not.toBeNull();
    expect(thread?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "status_changed", sourceRef: { type: "mission", id: missionId, table: "missions" } }),
      expect.objectContaining({ eventType: "activity_observed", sourceRef: expect.objectContaining({ type: "activity_log" }), summary: "custom.unknown" }),
    ]));
    expect(thread?.events.some((event) => event.companyId === other.companyId)).toBe(false);
    expect(thread?.summary.totalEventCount).toBe(2);
    expect(thread?.summary.latestEvents.length).toBeLessThanOrEqual(5);

    await expect(listMissionGovernanceThread(db, { companyId: other.companyId, missionId })).resolves.toBeNull();
  });

  it("projects native/plugin execution, steps, heartbeat, activity, approvals, comments, wakeups, tools, and strict scope filters", async () => {
    const { companyId, ownerAgentId } = await seedCompany("GT");
    const other = await seedCompany("ZZ");
    const missionId = randomUUID();
    const issueId = randomUUID();
    const otherIssueId = randomUUID();
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Governed mission", status: "active" });
    await db.insert(missions).values({ id: randomUUID(), companyId: other.companyId, ownerAgentId: other.ownerAgentId, title: "Other mission", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, missionId, title: "Mission issue", status: "blocked", priority: "high", assigneeAgentId: ownerAgentId, issueNumber: 1 });
    await db.insert(issues).values({ id: otherIssueId, companyId: other.companyId, missionId: null, title: "Other issue", status: "todo", priority: "low", assigneeAgentId: other.ownerAgentId, issueNumber: 1 });

    const workflowDefinitionId = randomUUID();
    const nativeRunId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: workflowDefinitionId, companyId, name: "Native", description: "", stepsJson: [] });
    await db.insert(workflowRuns).values({ id: nativeRunId, workflowId: workflowDefinitionId, companyId, missionId, status: "running", triggeredBy: "scheduler", startedAt: new Date("2026-05-20T00:00:00Z") });
    await db.insert(workflowStepRuns).values([
      { id: randomUUID(), workflowRunId: nativeRunId, stepId: "pending-step", issueId, status: "pending", startedAt: new Date("2026-05-20T00:01:00Z") },
      { id: randomUUID(), workflowRunId: nativeRunId, stepId: "done-step", issueId, status: "completed", completedAt: new Date("2026-05-20T00:02:00Z") },
      { id: randomUUID(), workflowRunId: nativeRunId, stepId: "failed-step", issueId, status: "failed", completedAt: new Date("2026-05-20T00:03:00Z") },
    ]);

    const crossWorkflowDefinitionId = randomUUID();
    const crossRunId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: crossWorkflowDefinitionId, companyId: other.companyId, name: "Cross", description: "", stepsJson: [] });
    await db.insert(workflowRuns).values({ id: crossRunId, workflowId: crossWorkflowDefinitionId, companyId: other.companyId, missionId, status: "running", triggeredBy: "scheduler" });
    await db.insert(workflowStepRuns).values({ id: randomUUID(), workflowRunId: crossRunId, stepId: "cross", issueId: otherIssueId, status: "failed" });

    const pluginId = randomUUID();
    const pluginRunId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: `workflow-${pluginId}`,
      packageName: `workflow-${pluginId}`,
      version: "1",
      apiVersion: 1,
      categories: ["workflow"],
      manifestJson: { id: `workflow-${pluginId}`, name: "Workflow Plugin", version: "1", apiVersion: 1, capabilities: {} },
      status: "installed",
    });
    await db.insert(pluginEntities).values([
      { id: pluginRunId, pluginId, entityType: "workflow-run", scopeKind: "company", scopeId: companyId, externalId: "external-run-1", title: "Plugin run", status: "running", data: { companyId, missionId, workflowId: "wf", workflowName: "Plugin Workflow", status: "running" } },
      { id: randomUUID(), pluginId, entityType: "workflow-step-run", scopeKind: "company", scopeId: companyId, externalId: "external-step-1", title: "Plugin step", status: "failed", data: { companyId, workflowRunId: pluginRunId, issueId, stepId: "plugin-step", status: "failed" } },
      { id: randomUUID(), pluginId, entityType: "workflow-run", scopeKind: "company", scopeId: other.companyId, externalId: "wrong-scope", title: "Wrong", status: "failed", data: { companyId, missionId, status: "failed" } },
    ]);

    const wakeupId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values([
      { id: wakeupId, companyId, agentId: ownerAgentId, source: "issue", reason: "linked", payload: { missionId, issueId }, status: "queued" },
      { id: randomUUID(), companyId, agentId: ownerAgentId, source: "issue", reason: "malicious", payload: { missionId: randomUUID(), issueId: randomUUID() }, status: "queued" },
    ]);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: ownerAgentId, issueId, status: "failed", errorCode: "adapter_failed", wakeupRequestId: wakeupId, startedAt: new Date("2026-05-20T00:04:00Z"), finishedAt: new Date("2026-05-20T00:05:00Z"), logRef: "log://run" });
    await db.insert(activityLog).values([
      { id: randomUUID(), companyId, actorType: "system", actorId: "system", action: "custom.unknown", entityType: "issue", entityId: issueId, runId, details: {} },
      { id: randomUUID(), companyId, actorType: "system", actorId: "system", action: "heartbeat.invoked", entityType: "issue", entityId: issueId, runId, details: {} },
      { id: randomUUID(), companyId: other.companyId, actorType: "system", actorId: "system", action: "custom.other", entityType: "issue", entityId: issueId, details: {} },
    ]);
    await db.insert(issueComments).values({ id: randomUUID(), companyId, issueId, authorUserId: "operator", body: "Plain comment" });

    const pendingApprovalId = randomUUID();
    const revisionApprovalId = randomUUID();
    const approvedApprovalId = randomUUID();
    const rejectedApprovalId = randomUUID();
    const unknownApprovalId = randomUUID();
    await db.insert(approvals).values([
      { id: pendingApprovalId, companyId, type: "publish", status: "pending", payload: {} },
      { id: revisionApprovalId, companyId, type: "publish", status: "revision_requested", payload: {} },
      { id: approvedApprovalId, companyId, type: "publish", status: "approved", payload: {} },
      { id: rejectedApprovalId, companyId, type: "publish", status: "rejected", payload: {} },
      { id: unknownApprovalId, companyId, type: "publish", status: "mystery", payload: {} },
    ]);
    await db.insert(issueApprovals).values([pendingApprovalId, revisionApprovalId, approvedApprovalId, rejectedApprovalId, unknownApprovalId].map((approvalId) => ({ companyId, issueId, approvalId })));
    await db.insert(approvalComments).values([
      { id: randomUUID(), companyId, approvalId: pendingApprovalId, authorUserId: "approver", body: "Need answer" },
      { id: randomUUID(), companyId: other.companyId, approvalId: pendingApprovalId, authorUserId: "bad", body: "Wrong company" },
    ]);

    const toolId = randomUUID();
    const crossToolId = randomUUID();
    const crossToolAuditId = randomUUID();
    await db.insert(toolDefinitions).values([
      { id: toolId, companyId, name: `tool-${toolId}`, adapterType: "local", description: "", inputSchema: {}, adapterConfig: {} },
      { id: crossToolId, companyId: other.companyId, name: `tool-${crossToolId}`, adapterType: "local", description: "", inputSchema: {}, adapterConfig: {} },
    ]);
    await db.insert(toolAuditLog).values([
      { id: randomUUID(), toolId, companyId, issueId, agentId: ownerAgentId, argsHash: "abc", result: "blocked_should" },
      { id: crossToolAuditId, toolId: crossToolId, companyId: other.companyId, issueId, agentId: other.ownerAgentId, argsHash: "cross", result: "blocked_must" },
    ]);

    const thread = await listMissionGovernanceThread(db, { companyId, missionId });
    expect(thread).not.toBeNull();
    const events = thread!.events;
    const eventTypes = events.map((event) => event.eventType);

    expect(events.some((event) => event.sourceRef.type === "workflow_run" && event.sourceRef.id === nativeRunId)).toBe(true);
    expect(events.some((event) => event.sourceRef.type === "plugin_workflow_run" && event.sourceRef.externalId === "external-run-1")).toBe(true);
    expect(events.some((event) => event.sourceRef.externalId === "wrong-scope")).toBe(false);
    expect(eventTypes).toEqual(expect.arrayContaining(["workflow_step_started", "workflow_step_succeeded", "workflow_step_failed"]));
    expect(events.some((event) => event.sourceRef.type === "workflow_step_run" && event.summary.includes("failed"))).toBe(true);
    expect(events.some((event) => event.sourceRef.type === "heartbeat_run" && event.eventType === "heartbeat_failed")).toBe(true);
    expect(events.some((event) => event.sourceRef.type === "agent_wakeup_request" && event.summary === "linked")).toBe(true);
    expect(events.some((event) => event.sourceRef.type === "agent_wakeup_request" && event.summary === "malicious")).toBe(false);
    expect(events.some((event) => event.sourceRef.type === "activity_log" && event.eventType === "activity_observed" && event.summary === "custom.unknown")).toBe(true);
    expect(events.some((event) => event.sourceRef.type === "activity_log" && event.summary === "heartbeat.invoked")).toBe(false);
    expect(events.some((event) => event.sourceRef.type === "issue_comment" && event.eventType === "activity_observed")).toBe(true);
    expect(events.some((event) => event.sourceRef.type === "tool_audit_log" && event.eventType === "tool_result")).toBe(true);
    expect(events.some((event) => event.sourceRef.type === "tool_audit_log" && event.sourceRef.id === crossToolAuditId)).toBe(false);
    expect(events.some((event) => event.companyId === other.companyId)).toBe(false);

    const openApprovalIds = thread!.summary.openDecisions.map((event) => event.scope.approvalId);
    expect(openApprovalIds).toEqual(expect.arrayContaining([pendingApprovalId, revisionApprovalId]));
    expect(openApprovalIds).not.toEqual(expect.arrayContaining([approvedApprovalId, rejectedApprovalId, unknownApprovalId]));
    expect(events.some((event) => event.sourceRef.type === "approval" && event.sourceRef.id === unknownApprovalId && event.eventType === "activity_observed")).toBe(true);
    expect(events.filter((event) => event.sourceRef.type === "approval_comment")).toHaveLength(1);
    expect(events.some((event) => event.eventType === "evidence_missing")).toBe(true);
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
  });

  it("projects native-only workflow runs and direct steps when plugin rows are absent", async () => {
    const { companyId, ownerAgentId } = await seedCompany("NO");
    const missionId = randomUUID();
    const issueId = randomUUID();
    const workflowDefinitionId = randomUUID();
    const nativeRunId = randomUUID();
    const nativeStepId = randomUUID();

    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Native-only mission", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, missionId, title: "Native issue", status: "todo", priority: "medium", assigneeAgentId: ownerAgentId, issueNumber: 1 });
    await db.insert(workflowDefinitions).values({ id: workflowDefinitionId, companyId, name: "Native-only", description: "", stepsJson: [] });
    await db.insert(workflowRuns).values({ id: nativeRunId, workflowId: workflowDefinitionId, companyId, missionId, status: "running", triggeredBy: "manual", startedAt: new Date("2026-05-20T01:00:00Z") });
    await db.insert(workflowStepRuns).values({ id: nativeStepId, workflowRunId: nativeRunId, stepId: "native-step", issueId, status: "completed", completedAt: new Date("2026-05-20T01:01:00Z") });

    const thread = await listMissionGovernanceThread(db, { companyId, missionId });
    expect(thread).not.toBeNull();
    const events = thread!.events;
    expect(events.some((event) => event.sourceRef.type === "workflow_run" && event.sourceRef.id === nativeRunId)).toBe(true);
    expect(events.some((event) => event.sourceRef.type === "workflow_step_run" && event.sourceRef.id === nativeStepId && event.eventType === "workflow_step_succeeded")).toBe(true);
    expect(events.some((event) => event.sourceRef.type === "plugin_workflow_run" || event.sourceRef.type === "plugin_workflow_step_run")).toBe(false);
  });

  it("projects plugin-only workflow runs and steps with external ids when native rows are absent", async () => {
    const { companyId, ownerAgentId } = await seedCompany("PO");
    const missionId = randomUUID();
    const issueId = randomUUID();
    const pluginId = randomUUID();
    const pluginRunId = randomUUID();
    const pluginStepId = randomUUID();

    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Plugin-only mission", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, missionId, title: "Plugin issue", status: "todo", priority: "medium", assigneeAgentId: ownerAgentId, issueNumber: 1 });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: `workflow-${pluginId}`,
      packageName: `workflow-${pluginId}`,
      version: "1",
      apiVersion: 1,
      categories: ["workflow"],
      manifestJson: { id: `workflow-${pluginId}`, name: "Workflow Plugin", version: "1", apiVersion: 1, capabilities: {} },
      status: "installed",
    });
    await db.insert(pluginEntities).values([
      { id: pluginRunId, pluginId, entityType: "workflow-run", scopeKind: "company", scopeId: companyId, externalId: "plugin-only-run", title: "Plugin-only run", status: "running", data: { companyId, missionId, workflowId: "plugin-wf", workflowName: "Plugin-only Workflow", status: "running" } },
      { id: pluginStepId, pluginId, entityType: "workflow-step-run", scopeKind: "company", scopeId: companyId, externalId: "plugin-only-step", title: "Plugin-only step", status: "completed", data: { companyId, workflowRunId: pluginRunId, issueId, stepId: "plugin-step", status: "completed" } },
    ]);

    const thread = await listMissionGovernanceThread(db, { companyId, missionId });
    expect(thread).not.toBeNull();
    const events = thread!.events;
    expect(events.some((event) => event.sourceRef.type === "plugin_workflow_run" && event.sourceRef.id === pluginRunId && event.sourceRef.externalId === "plugin-only-run")).toBe(true);
    expect(events.some((event) => event.sourceRef.type === "plugin_workflow_step_run" && event.sourceRef.id === pluginStepId && event.sourceRef.externalId === "plugin-only-step" && event.eventType === "workflow_step_succeeded")).toBe(true);
    expect(events.some((event) => event.sourceRef.type === "workflow_run" || event.sourceRef.type === "workflow_step_run")).toBe(false);
  });

});

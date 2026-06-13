import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { issues, labels, projects, workflowStepRuns } from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  cancelWorkflowRunSchema,
  createWorkflowDefinitionSchema,
  manualCompleteWorkflowIssueSchema,
  resumeWorkflowRunSchema,
  triggerWorkflowRunSchema,
  updateWorkflowDefinitionSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { issueService } from "../services/issues.js";
import { retryIssueLessToolWorkflowStep } from "../services/workflow/dag-engine.js";
import { workflowService } from "../services/workflow/engine.js";
import type { WorkflowDefinition, WorkflowRun, WorkflowStepRun } from "../services/workflow/types.js";
import { conflict, notFound, unauthorized, unprocessable } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

function serializeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, serializeValue(entry)]),
    );
  }
  return value;
}

function serializeDefinition(definition: WorkflowDefinition) {
  return serializeValue(definition) as Record<string, unknown>;
}

function serializeRun(run: WorkflowRun) {
  return serializeValue(run) as Record<string, unknown>;
}

function serializeStepRun(stepRun: WorkflowStepRun) {
  return serializeValue(stepRun) as Record<string, unknown>;
}

function workflowStepForUi(step: WorkflowDefinition["steps"][number]): Record<string, unknown> {
  const record = step as WorkflowDefinition["steps"][number] & {
    title?: unknown;
    type?: unknown;
    toolName?: unknown;
    agentName?: unknown;
    dependsOn?: unknown;
  };
  const toolNames = Array.isArray(step.toolNames) ? step.toolNames.filter(Boolean) : [];
  const dependencies = Array.isArray(step.dependencies) ? step.dependencies : [];
  return {
    ...serializeValue(step) as Record<string, unknown>,
    id: step.id,
    title: typeof record.title === "string" ? record.title : step.name,
    description: step.description ?? "",
    type: typeof record.type === "string" ? record.type : (!step.agentId && toolNames.length > 0 ? "tool" : "agent"),
    toolName: typeof record.toolName === "string" ? record.toolName : toolNames[0] ?? "",
    agentName: typeof record.agentName === "string" ? record.agentName : step.agentId,
    dependsOn: Array.isArray(record.dependsOn) ? record.dependsOn : dependencies,
    toolNames,
  };
}

function workflowDefinitionForUi(definition: WorkflowDefinition): Record<string, unknown> {
  return {
    id: definition.id,
    companyId: definition.companyId,
    name: definition.name,
    description: definition.description ?? "",
    status: definition.status ?? "active",
    triggerLabels: definition.triggerLabels ?? [],
    labelIds: definition.labelIds ?? [],
    schedule: definition.schedule ?? undefined,
    maxDailyRuns: definition.maxDailyRuns ?? undefined,
    timezone: definition.timezone ?? undefined,
    deadlineTime: definition.deadlineTime ?? undefined,
    lastScheduledRunAt: definition.lastScheduledRunAt?.toISOString(),
    lastScheduleError: definition.lastScheduleError ?? undefined,
    lastScheduleErrorAt: definition.lastScheduleErrorAt?.toISOString(),
    projectId: definition.projectId ?? undefined,
    createParentIssuePolicy: definition.createParentIssuePolicy ?? undefined,
    executionMode: definition.executionMode ?? undefined,
    dynamicPlanBootstrapOnly: definition.dynamicPlanBootstrapOnly ?? false,
    legacyMetadata: definition.legacyMetadata ?? {},
    createdAt: definition.createdAt.toISOString(),
    updatedAt: definition.updatedAt.toISOString(),
    steps: definition.steps.map(workflowStepForUi),
  };
}

function isActiveWorkflowRunStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return !["completed", "succeeded", "done", "failed", "error", "cancelled", "canceled", "aborted"].includes(normalized);
}

function workflowRunSummaryForUi(
  run: WorkflowRun,
  definitionNameById: Map<string, string>,
  parentIssueIdentifierById: Map<string, string>,
): Record<string, unknown> {
  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowName: definitionNameById.get(run.workflowId) ?? run.workflowId,
    status: run.status,
    startedAt: (run.startedAt ?? run.createdAt).toISOString(),
    completedAt: run.completedAt?.toISOString(),
    triggerSource: run.triggerSource ?? run.triggeredBy,
    parentIssueId: run.parentIssueId ?? undefined,
    parentIssueIdentifier: run.parentIssueId ? parentIssueIdentifierById.get(run.parentIssueId) : undefined,
    runLabel: run.runLabel ?? undefined,
  };
}

function canAccessRecord(req: Request, companyId: string): boolean {
  if (req.actor.type === "none") {
    throw unauthorized();
  }
  if (req.actor.type === "agent") {
    return req.actor.companyId === companyId;
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return true;
  }
  return (req.actor.companyIds ?? []).includes(companyId);
}

function translateWorkflowDomainError(error: unknown): never {
  if (!(error instanceof Error)) {
    throw error;
  }

  if (error.message.startsWith("Invalid workflow DAG:")) {
    throw unprocessable(error.message);
  }
  if (error.message.startsWith("Workflow definition not found:") || error.message.startsWith("Workflow run not found:")) {
    throw notFound(error.message);
  }
  if (error.message.startsWith("Workflow does not belong to company:")) {
    throw notFound("Workflow definition not found");
  }
  if (error.message.startsWith("Cannot create workflow mission:")) {
    throw conflict(error.message);
  }

  throw error;
}

async function workflowDomainCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    translateWorkflowDomainError(error);
  }
}

function actorForActivity(req: Request) {
  return getActorInfo(req);
}

export function workflowRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/workflows/overview", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const [definitions, runs, projectRows, labelRows] = await Promise.all([
      workflowService.listDefinitions(db, companyId),
      workflowService.listRuns(db, { companyId }),
      db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.companyId, companyId)),
      db.select({ id: labels.id, name: labels.name, color: labels.color }).from(labels).where(eq(labels.companyId, companyId)),
    ]);

    const parentIssueIds = Array.from(new Set(runs.map((run) => run.parentIssueId).filter((id): id is string => Boolean(id))));
    const parentIssueRows = parentIssueIds.length > 0
      ? await db
        .select({ id: issues.id, identifier: issues.identifier })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, parentIssueIds)))
      : [];
    const parentIssueIdentifierById = new Map(
      parentIssueRows
        .filter((issue) => typeof issue.identifier === "string" && issue.identifier.trim())
        .map((issue) => [issue.id, issue.identifier as string]),
    );
    const definitionNameById = new Map(definitions.map((definition) => [definition.id, definition.name]));
    const runSummaries = runs.map((run) => workflowRunSummaryForUi(run, definitionNameById, parentIssueIdentifierById));

    res.json({
      projects: projectRows,
      labels: labelRows,
      workflows: definitions.map(workflowDefinitionForUi),
      activeRuns: runSummaries.filter((run) => isActiveWorkflowRunStatus(String(run.status ?? ""))),
      recentRuns: runSummaries.filter((run) => !isActiveWorkflowRunStatus(String(run.status ?? ""))).slice(0, 25),
    });
  });

  router.get("/companies/:companyId/workflows", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const definitions = await workflowService.listDefinitions(db, companyId);
    res.json(definitions.map(serializeDefinition));
  });

  router.post("/companies/:companyId/workflows", validate(createWorkflowDefinitionSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const definition = await workflowDomainCall(() => workflowService.createDefinition(db, {
      ...req.body,
      companyId,
    }));
    const actor = actorForActivity(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "workflow.created",
      entityType: "workflow",
      entityId: definition.id,
      details: { name: definition.name },
    });
    res.status(201).json(serializeDefinition(definition));
  });

  router.get("/workflows/:workflowId", async (req, res) => {
    const workflowId = req.params.workflowId as string;
    const definition = await workflowService.getDefinition(db, workflowId);
    if (!definition || !canAccessRecord(req, definition.companyId)) {
      throw notFound("Workflow definition not found");
    }
    res.json(serializeDefinition(definition));
  });

  router.patch("/workflows/:workflowId", validate(updateWorkflowDefinitionSchema), async (req, res) => {
    const workflowId = req.params.workflowId as string;
    const existing = await workflowService.getDefinition(db, workflowId);
    if (!existing || !canAccessRecord(req, existing.companyId)) {
      throw notFound("Workflow definition not found");
    }
    const definition = await workflowDomainCall(() => workflowService.updateDefinition(db, workflowId, req.body));
    if (!definition) throw notFound("Workflow definition not found");
    const actor = actorForActivity(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "workflow.updated",
      entityType: "workflow",
      entityId: workflowId,
      details: { changedFields: Object.keys(req.body) },
    });
    res.json(serializeDefinition(definition));
  });

  router.delete("/workflows/:workflowId", async (req, res) => {
    const workflowId = req.params.workflowId as string;
    const existing = await workflowService.getDefinition(db, workflowId);
    if (!existing || !canAccessRecord(req, existing.companyId)) {
      throw notFound("Workflow definition not found");
    }
    const archived = await workflowService.deleteDefinition(db, workflowId);
    const actor = actorForActivity(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "workflow.archived",
      entityType: "workflow",
      entityId: workflowId,
      details: { previousStatus: existing.status ?? null },
    });
    res.json({ id: workflowId, status: "archived", archived });
  });

  router.get("/companies/:companyId/workflow-runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const workflowId = typeof req.query.workflowId === "string" ? req.query.workflowId : undefined;
    const missionId = typeof req.query.missionId === "string" ? req.query.missionId : undefined;
    const runs = await workflowService.listRuns(db, { companyId, workflowId, missionId });
    res.json(runs.map(serializeRun));
  });

  router.get("/workflows/:workflowId/runs", async (req, res) => {
    const workflowId = req.params.workflowId as string;
    const definition = await workflowService.getDefinition(db, workflowId);
    if (!definition || !canAccessRecord(req, definition.companyId)) {
      throw notFound("Workflow definition not found");
    }
    const runs = await workflowService.listRuns(db, { companyId: definition.companyId, workflowId });
    res.json(runs.map(serializeRun));
  });

  router.post("/workflows/:workflowId/runs", validate(triggerWorkflowRunSchema), async (req, res) => {
    const workflowId = req.params.workflowId as string;
    const definition = await workflowService.getDefinition(db, workflowId);
    if (!definition || !canAccessRecord(req, definition.companyId)) {
      throw notFound("Workflow definition not found");
    }
    const triggeredBy = req.body.triggeredBy ?? (req.actor.type === "agent" ? "agent" : "board");
    const result = await workflowDomainCall(() => workflowService.trigger(db, {
      ...req.body,
      workflowId,
      companyId: definition.companyId,
      triggeredBy,
    }));
    const actor = actorForActivity(req);
    await logActivity(db, {
      companyId: definition.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "workflow_run.created",
      entityType: "workflow_run",
      entityId: result.runId,
      details: { workflowId, triggerSource: req.body.triggerSource ?? null },
    });
    res.status(201).json(serializeValue(result));
  });

  router.get("/workflow-runs/:runId", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await workflowService.getRun(db, runId);
    if (!run || !canAccessRecord(req, run.companyId)) {
      throw notFound("Workflow run not found");
    }
    const stepRuns = await workflowService.listStepRuns(db, runId);
    res.json({ run: serializeRun(run), stepRuns: stepRuns.map(serializeStepRun) });
  });

  router.get("/workflow-runs/:runId/detail", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await workflowService.getRun(db, runId);
    if (!run || !canAccessRecord(req, run.companyId)) {
      throw notFound("Workflow run not found");
    }

    const [definition, stepRuns] = await Promise.all([
      workflowService.getDefinition(db, run.workflowId),
      workflowService.listStepRuns(db, run.id),
    ]);
    const issueIds = Array.from(new Set(stepRuns.map((stepRun) => stepRun.issueId).filter((id): id is string => Boolean(id))));
    const issueRows = issueIds.length > 0
      ? await db
        .select({ id: issues.id, identifier: issues.identifier })
        .from(issues)
        .where(and(eq(issues.companyId, run.companyId), inArray(issues.id, issueIds)))
      : [];
    const issueIdentifierById = new Map(
      issueRows
        .filter((issue) => typeof issue.identifier === "string" && issue.identifier.trim())
        .map((issue) => [issue.id, issue.identifier as string]),
    );
    const stepDefinitionById = new Map((definition?.steps ?? []).map((step) => [step.id, workflowStepForUi(step)]));
    const serializedStepRuns = stepRuns.map((stepRun) => {
      const stepDefinition = stepDefinitionById.get(stepRun.stepId);
      return {
        ...serializeStepRun(stepRun),
        stepTitle: typeof stepDefinition?.title === "string" ? stepDefinition.title : stepRun.stepId,
        stepType: typeof stepDefinition?.type === "string" ? stepDefinition.type : undefined,
        issueId: stepRun.issueId ?? undefined,
        issueIdentifier: stepRun.issueId ? issueIdentifierById.get(stepRun.issueId) : undefined,
        workProducts: [],
      };
    });

    res.json({
      run: serializeRun(run),
      stepRuns: serializedStepRuns,
      workflow: definition ? workflowDefinitionForUi(definition) : null,
    });
  });

  router.post("/workflow-step-runs/:stepRunId/rerun", async (req, res) => {
    const stepRunId = req.params.stepRunId as string;
    const [stepRun] = await db
      .select()
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, stepRunId))
      .limit(1);
    if (!stepRun) {
      throw notFound("Workflow step run not found");
    }

    const run = await workflowService.getRun(db, stepRun.workflowRunId);
    if (!run || !canAccessRecord(req, run.companyId)) {
      throw notFound("Workflow step run not found");
    }

    const retryResult = await retryIssueLessToolWorkflowStep(db, {
      companyId: run.companyId,
      runId: run.id,
      stepId: stepRun.stepId,
    });
    if (!retryResult) {
      throw unprocessable("Only failed issue-less tool steps can be rerun directly from the core workflow UI");
    }

    const actor = actorForActivity(req);
    await logActivity(db, {
      companyId: run.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "workflow_step_run.rerun",
      entityType: "workflow_step_run",
      entityId: stepRunId,
      details: { workflowRunId: run.id, workflowId: run.workflowId, stepId: stepRun.stepId },
    });

    res.json({
      issueId: null,
      resumedRun: run.status !== "running",
      runId: run.id,
      stepId: stepRun.stepId,
      stepRunId: retryResult.stepRunId,
      result: serializeValue(retryResult.result),
    });
  });

  router.post("/workflow-runs/:runId/resume", validate(resumeWorkflowRunSchema), async (req, res) => {
    const runId = req.params.runId as string;
    const run = await workflowService.getRun(db, runId);
    if (!run || !canAccessRecord(req, run.companyId)) {
      throw notFound("Workflow run not found");
    }
    const result = await workflowDomainCall(() => workflowService.resumeRun(db, { runId, companyId: run.companyId }));
    const actor = actorForActivity(req);
    await logActivity(db, {
      companyId: run.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "workflow_run.resumed",
      entityType: "workflow_run",
      entityId: runId,
      details: { workflowId: run.workflowId },
    });
    res.json(serializeValue(result));
  });

  router.post("/workflow-runs/:runId/cancel", validate(cancelWorkflowRunSchema), async (req, res) => {
    const runId = req.params.runId as string;
    const run = await workflowService.getRun(db, runId);
    if (!run || !canAccessRecord(req, run.companyId)) {
      throw notFound("Workflow run not found");
    }
    const cancelled = await workflowService.cancelRun(db, { runId, companyId: run.companyId });
    const actor = actorForActivity(req);
    await logActivity(db, {
      companyId: run.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "workflow_run.cancelled",
      entityType: "workflow_run",
      entityId: runId,
      details: { workflowId: run.workflowId, reason: req.body.reason ?? null },
    });
    res.json({ id: runId, runId, status: cancelled ? "cancelled" : run.status, cancelled });
  });

  router.post("/issues/:issueId/workflow/manual-complete", validate(manualCompleteWorkflowIssueSchema), async (req, res) => {
    const issueId = req.params.issueId as string;
    const svc = issueService(db);
    const existing = await svc.getById(issueId);
    if (!existing || !canAccessRecord(req, existing.companyId)) {
      throw notFound("Issue not found");
    }
    const issue = await svc.update(issueId, { status: "done" });
    if (!issue) throw notFound("Issue not found");
    const actor = actorForActivity(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        status: "done",
        identifier: issue.identifier,
        source: "workflow.manual-complete",
        _previous: { status: existing.status },
      },
    });
    const run = await workflowService.syncRunStatusForIssue(db, issue.id);
    res.json({ issue: serializeValue(issue), run: serializeValue(run) });
  });

  return router;
}

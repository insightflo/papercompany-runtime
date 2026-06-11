import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
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

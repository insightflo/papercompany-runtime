import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  workflowArtifactRegisterSchema,
  workflowIssueCompleteSchema,
  workflowVerdictSubmitSchema,
  type WorkflowArtifactRegister,
  type WorkflowIssueComplete,
  type WorkflowVerdictSubmit,
} from "@paperclipai/shared/validators/workflow-agent-api";
import { validate } from "../middleware/validate.js";
import { hermesOpsMutationGuard } from "../middleware/hermes-ops-mutation-guard.js";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { issueService } from "../services/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { logActivity } from "../services/activity-log.js";
import {
  completeWorkflowIssue,
  registerWorkflowArtifact,
  submitWorkflowVerdict,
} from "../services/workflow/agent-api.js";

function routeParam(value: string | string[] | undefined, name: string): string {
  if (typeof value === "string" && value.trim()) return value;
  throw badRequest(`Missing route parameter: ${name}`);
}

async function loadIssue(db: Db, issueId: string) {
  const issue = await issueService(db).getById(issueId);
  if (!issue) throw notFound("Issue not found");
  return issue;
}

async function authorizeWorkflowApi(req: Request, db: Db, issue: Awaited<ReturnType<typeof loadIssue>>) {
  assertCompanyAccess(req, issue.companyId);
  if (issue.originKind !== "workflow_execution") {
    throw conflict("Workflow API can only be used for workflow execution issues");
  }
  const actor = getActorInfo(req);
  if (req.actor.type !== "agent") return actor;
  if (!actor.agentId) throw forbidden("Agent authentication required");
  if (!actor.runId) throw unauthorized("Agent run id required");
  if (issue.status !== "in_progress" || issue.assigneeAgentId !== actor.agentId) {
    throw conflict("Workflow API requires a checked-out in_progress issue assigned to this agent");
  }
  await issueService(db).assertCheckoutOwner(issue.id, actor.agentId, actor.runId);
  return actor;
}

export function workflowAgentApiRoutes(db: Db) {
  const router = Router();

  router.post("/issues/:id/workflow/artifacts", hermesOpsMutationGuard("workflow.artifacts.register"), validate(workflowArtifactRegisterSchema), async (req, res) => {
    const issue = await loadIssue(db, routeParam(req.params.id, "id"));
    const actor = await authorizeWorkflowApi(req, db, issue);
    const data: WorkflowArtifactRegister = req.body;
    const product = await registerWorkflowArtifact({ db, issue, actor, data });
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.workflow_artifact_registered",
      entityType: "issue",
      entityId: issue.id,
      details: {
        identifier: issue.identifier,
        workProductId: product.id,
        type: product.type,
        ...(product.url ? { url: product.url } : {}),
        ...(product.metadata?.path ? { path: product.metadata.path } : {}),
      },
    });
    res.status(201).json(product);
  });

  router.post("/issues/:id/workflow/verdict", hermesOpsMutationGuard("workflow.verdict.submit"), validate(workflowVerdictSubmitSchema), async (req, res) => {
    const issue = await loadIssue(db, routeParam(req.params.id, "id"));
    const actor = await authorizeWorkflowApi(req, db, issue);
    const data: WorkflowVerdictSubmit = req.body;
    const verdict = await submitWorkflowVerdict({ db, issue, actor, data });
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.workflow_verdict_submitted",
      entityType: "issue",
      entityId: issue.id,
      details: {
        identifier: issue.identifier,
        verdict: verdict.verdict,
        workflowRunId: verdict.workflowRunId,
        workflowStepRunId: verdict.workflowStepRunId,
        stepId: verdict.stepId,
      },
    });
    res.json(verdict);
  });

  router.post("/issues/:id/workflow/complete", hermesOpsMutationGuard("workflow.complete"), validate(workflowIssueCompleteSchema), async (req, res) => {
    const issue = await loadIssue(db, routeParam(req.params.id, "id"));
    const actor = await authorizeWorkflowApi(req, db, issue);
    const data: WorkflowIssueComplete = req.body;
    const updated = await completeWorkflowIssue({ db, issue, actor, data });
    await heartbeatService(db).finalizeLinkedRunsForIssueStatus({
      issueId: updated.id,
      companyId: updated.companyId,
      status: "done",
      linkedRunIds: [issue.checkoutRunId, issue.executionRunId, actor.runId],
    });
    if (actor.runId) {
      await heartbeatService(db).reportRunActivity(actor.runId)
        .catch((err) => logger.warn({ err, runId: actor.runId }, "failed to clear detached run warning after workflow API completion"));
    }
    await logActivity(db, {
      companyId: updated.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.workflow_completed",
      entityType: "issue",
      entityId: updated.id,
      details: { identifier: updated.identifier },
    });
    res.json(updated);
  });

  return router;
}

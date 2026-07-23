import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues, missions } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  missionPlanQaVerdictSubmitSchema,
  missionOwnerPlanDecisionSubmitSchema,
  workflowArtifactRegisterSchema,
  workflowIssueCompleteSchema,
  workflowVerdictSubmitSchema,
  missionOwnerDecisionSubmitSchema,
  type MissionPlanQaVerdictSubmit,
  type MissionOwnerPlanDecisionSubmit,
  type WorkflowArtifactRegister,
  type WorkflowIssueComplete,
  type WorkflowVerdictSubmit,
  type MissionOwnerDecisionSubmit,
} from "@paperclipai/shared/validators/workflow-agent-api";
import { validate } from "../middleware/validate.js";
import { hermesOpsMutationGuard } from "../middleware/hermes-ops-mutation-guard.js";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { issueService } from "../services/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { logActivity } from "../services/activity-log.js";
import { submitMissionPlanQaVerdict } from "../services/missions/mission-plan-qa-agent-api.js";
import { submitMissionOwnerPlanDecision } from "../services/missions/mission-plan-decision-agent-api.js";
import { submitMissionOwnerDecision } from "../services/missions/mission-owner-recovery-agent-api.js";
import { createPlanQaWakeupHandler, createPlanningIssueWakeupHandler } from "../services/missions/plan-qa-wakeup.js";
import {
  completeWorkflowIssue,
  submitWorkflowVerdict,
  type WorkflowApiActor,
  type WorkflowApiDelegation,
} from "../services/workflow/agent-api.js";
import { registerWorkflowArtifactWithStorage } from "../services/workflow/registered-artifact-storage.js";

function routeParam(value: string | string[] | undefined, name: string): string {
  if (typeof value === "string" && value.trim()) return value;
  throw badRequest(`Missing route parameter: ${name}`);
}

async function loadIssue(db: Db, issueId: string) {
  const issue = await issueService(db).getById(issueId);
  if (!issue) throw notFound("Issue not found");
  return issue;
}

async function resolveMissionOwnerUnblockDelegation(input: {
  readonly db: Db;
  readonly targetIssue: Awaited<ReturnType<typeof loadIssue>>;
  readonly actor: WorkflowApiActor;
}): Promise<WorkflowApiDelegation | null> {
  if (!input.actor.agentId || !input.actor.runId || !input.targetIssue.missionId) return null;
  const run = await input.db
    .select({
      issueId: heartbeatRuns.issueId,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, input.actor.runId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (
    !run?.issueId ||
    run.companyId !== input.targetIssue.companyId ||
    run.agentId !== input.actor.agentId
  ) {
    return null;
  }

  const ownerAction = await input.db
    .select({
      id: issues.id,
      identifier: issues.identifier,
    })
    .from(issues)
    .where(and(
      eq(issues.id, run.issueId),
      eq(issues.companyId, input.targetIssue.companyId),
      eq(issues.missionId, input.targetIssue.missionId),
      eq(issues.originKind, "mission_main_executor_unblock"),
      eq(issues.originId, input.targetIssue.id),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!ownerAction) return null;

  await issueService(input.db).assertCheckoutOwner(ownerAction.id, input.actor.agentId, input.actor.runId);
  return {
    kind: "mission_owner_unblock_source",
    issueId: ownerAction.id,
    identifier: ownerAction.identifier,
  };
}

async function authorizeWorkflowApi(
  req: Request,
  db: Db,
  issue: Awaited<ReturnType<typeof loadIssue>>,
  options?: { readonly allowMissionOwnerUnblockDelegation?: boolean },
) {
  assertCompanyAccess(req, issue.companyId);
  if (issue.originKind !== "workflow_execution") {
    throw conflict("Workflow API can only be used for workflow execution issues");
  }
  const actor = getActorInfo(req);
  if (req.actor.type !== "agent") return { actor, delegation: null };
  if (!actor.agentId) throw forbidden("Agent authentication required");
  if (!actor.runId) throw unauthorized("Agent run id required");
  if (issue.status === "in_progress" && issue.assigneeAgentId === actor.agentId) {
    await issueService(db).assertCheckoutOwner(issue.id, actor.agentId, actor.runId);
    return { actor, delegation: null };
  }
  if (options?.allowMissionOwnerUnblockDelegation) {
    const delegation = await resolveMissionOwnerUnblockDelegation({ db, targetIssue: issue, actor });
    if (delegation) return { actor, delegation };
  }
  throw conflict("Workflow API requires either the checked-out workflow issue run or a checked-out mission-owner unblock issue whose originId is this workflow issue");
}

async function authorizeMissionPlanQaApi(req: Request, db: Db, issue: Awaited<ReturnType<typeof loadIssue>>) {
  assertCompanyAccess(req, issue.companyId);
  if (issue.originKind !== "mission_plan_qa") {
    throw conflict("Mission PLAN-QA verdict API can only be used for mission_plan_qa issues");
  }
  const actor = getActorInfo(req);
  if (req.actor.type !== "agent") return actor;
  if (!actor.agentId) throw forbidden("Agent authentication required");
  if (!actor.runId) throw unauthorized("Agent run id required");
  await issueService(db).assertCheckoutOwner(issue.id, actor.agentId, actor.runId);
  return actor;
}

async function authorizeMissionOwnerPlanDecisionApi(req: Request, db: Db, issue: Awaited<ReturnType<typeof loadIssue>>) {
  assertCompanyAccess(req, issue.companyId);
  if (issue.originKind !== "mission_main_executor_plan") {
    throw conflict("Mission owner plan decision API can only be used for mission_main_executor_plan issues");
  }
  if (req.actor.type !== "agent") throw forbidden("Mission owner plan decision API requires an authenticated agent");
  const actor = getActorInfo(req);
  if (!actor.agentId) throw forbidden("Agent authentication required");
  if (!actor.runId) throw unauthorized("Agent run id required");
  await issueService(db).assertCheckoutOwner(issue.id, actor.agentId, actor.runId);
  // Fail closed unless the caller is the recorded mission owner. A misassigned plan issue
  // must not let a non-owner checkout holder submit a structured plan decision as authority.
  const missionId = issue.missionId;
  if (!missionId) throw forbidden("Mission owner plan decision API requires a mission-scoped issue");
  const [mission] = await db
    .select({ ownerAgentId: missions.ownerAgentId })
    .from(missions)
    .where(and(eq(missions.id, missionId), eq(missions.companyId, issue.companyId)));
  if (!mission) throw forbidden("Mission owner plan decision API could not resolve the mission");
  if (mission.ownerAgentId !== actor.agentId) {
    throw forbidden("Mission owner plan decision API may only be used by the mission owner");
  }
  return actor;
}

export function workflowAgentApiRoutes(db: Db) {
  const router = Router();
  const heartbeat = heartbeatService(db);
  const enqueuePlanQaWakeup = createPlanQaWakeupHandler(
    heartbeat,
    { requestedByActorId: "workflow-agent-api-plan-qa", contextSource: "workflow_agent_api_plan_qa" },
  );
  const enqueuePlanningIssueWakeup = createPlanningIssueWakeupHandler(
    heartbeat,
    { requestedByActorId: "workflow-agent-api-plan-qa", contextSource: "workflow_agent_api_plan_rework" },
  );

  router.post("/issues/:id/workflow/artifacts", hermesOpsMutationGuard("workflow.artifacts.register"), validate(workflowArtifactRegisterSchema), async (req, res) => {
    const issue = await loadIssue(db, routeParam(req.params.id, "id"));
    const { actor, delegation } = await authorizeWorkflowApi(req, db, issue, { allowMissionOwnerUnblockDelegation: true });
    const data: WorkflowArtifactRegister = req.body;
    const product = await registerWorkflowArtifactWithStorage({ db, issue, actor, data, delegation });
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
    const { actor } = await authorizeWorkflowApi(req, db, issue);
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

  router.post("/issues/:id/mission-plan-qa/verdict", hermesOpsMutationGuard("mission.plan_qa.verdict.submit"), validate(missionPlanQaVerdictSubmitSchema), async (req, res) => {
    const issue = await loadIssue(db, routeParam(req.params.id, "id"));
    const actor = await authorizeMissionPlanQaApi(req, db, issue);
    const data: MissionPlanQaVerdictSubmit = req.body;
    const verdict = await submitMissionPlanQaVerdict({
      db,
      issue,
      actor,
      data,
      enqueuePlanQaWakeup,
      enqueuePlanningIssueWakeup,
    });
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.mission_plan_qa_verdict_submitted",
      entityType: "issue",
      entityId: issue.id,
      details: {
        identifier: issue.identifier,
        verdict: verdict.verdict,
        decisionHash: verdict.decisionHash,
        planDecisionStatus: verdict.planDecisionStatus,
      },
    });
    res.json(verdict);
  });

  router.post("/issues/:id/mission-plan-decision", hermesOpsMutationGuard("mission.plan_decision.submit"), validate(missionOwnerPlanDecisionSubmitSchema), async (req, res) => {
    const issue = await loadIssue(db, routeParam(req.params.id, "id"));
    const actor = await authorizeMissionOwnerPlanDecisionApi(req, db, issue);
    const data: MissionOwnerPlanDecisionSubmit = req.body;
    const result = await submitMissionOwnerPlanDecision({
      db,
      issue,
      actor: { actorType: "agent", actorId: actor.agentId ?? actor.actorId, runId: actor.runId },
      decision: data.decision,
      enqueuePlanQaWakeup,
    });
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.mission_plan_decision_submitted",
      entityType: "issue",
      entityId: issue.id,
      details: {
        identifier: issue.identifier,
        planDecisionStatus: result.status,
        decisionHash: "decisionHash" in result ? result.decisionHash : null,
      },
    });
    res.json(result);
  });

  router.post("/issues/:id/workflow/complete", hermesOpsMutationGuard("workflow.complete"), validate(workflowIssueCompleteSchema), async (req, res) => {
    const issue = await loadIssue(db, routeParam(req.params.id, "id"));
    const { actor, delegation } = await authorizeWorkflowApi(req, db, issue, { allowMissionOwnerUnblockDelegation: true });
    const data: WorkflowIssueComplete = req.body;
    const updated = await completeWorkflowIssue({ db, issue, actor, data });
    await heartbeatService(db).finalizeLinkedRunsForIssueStatus({
      issueId: updated.id,
      companyId: updated.companyId,
      status: "done",
      linkedRunIds: delegation ? [issue.checkoutRunId, issue.executionRunId] : [issue.checkoutRunId, issue.executionRunId, actor.runId],
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
  router.post("/issues/:id/owner-recovery/decision", hermesOpsMutationGuard("owner_recovery.decision.submit"), validate(missionOwnerDecisionSubmitSchema), async (req, res) => {
    const issue = await loadIssue(db, routeParam(req.params.id, "id"));
    assertCompanyAccess(req, issue.companyId);
    const actor = getActorInfo(req);
    const data: MissionOwnerDecisionSubmit = req.body;
    const recorded = await submitMissionOwnerDecision({ db, issueId: issue.id, actor, data });
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.owner_recovery_decision_submitted",
      entityType: "issue",
      entityId: issue.id,
      details: {
        identifier: issue.identifier,
        decision: recorded.submission.decision,
        decisionEventId: recorded.eventId,
      },
    });
    res.status(201).json({ eventId: recorded.eventId, createdAt: recorded.createdAt, decision: recorded.submission.decision });
  });

  return router;
}

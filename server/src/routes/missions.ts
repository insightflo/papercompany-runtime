/**
 * Mission Routes
 *
 * Endpoints:
 * - GET    /companies/:companyId/missions            — List missions
 * - GET    /companies/:companyId/missions/human-operator-requests — List open human operator requests
 * - POST   /companies/:companyId/missions            — Create mission
 * - GET    /missions/:id                             — Get mission detail
 * - PATCH  /missions/:id                             — Update mission
 * - DELETE /missions/:id                             — Delete mission
 * - GET    /missions/:id/agents                      — List mission agents
 * - POST   /missions/:id/agents                      — Add agent to mission
 * - PATCH  /missions/:id/agents/:agentId             — Update agent role
 * - DELETE /missions/:id/agents/:agentId             — Remove agent from mission
 * - GET    /missions/:id/issues                      — Get mission issue tree
 * - GET    /missions/:id/workflow-runs               — List workflow runs for mission
 * - GET    /missions/:id/governance-thread           — Read mission governance thread
 * - GET    /missions/:id/runtime-snapshot            — Read structured mission runtime snapshot
 */
import { Router } from "express";
import { type Db } from "@paperclipai/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { missionService } from "../services/missions.js";
import { dispatchSourceIssueNativeResume } from "../services/workflow/source-issue-native-resume.js";
import { missionDelegationService } from "../services/mission-delegations.js";
import { heartbeatService } from "../services/heartbeat.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { notFound, badRequest } from "../errors.js";
import { logActivity } from "../services/activity-log.js";
import { listMissionGovernanceThread } from "../services/missions/governance-thread.js";
import { listCompanyHumanOperatorRequests } from "../services/missions/human-operator-requests.js";
import { loadMissionRuntimeSnapshot } from "../services/missions/mission-runtime-snapshot.js";
import { getMissionRecoveryAdvice } from "../services/missions/mission-recovery-advice.js";
import { createPlanQaWakeupHandler, createPlanningIssueWakeupHandler } from "../services/missions/plan-qa-wakeup.js";

export function missionRoutes(db: Db) {
  const router = Router();
  const heartbeat = heartbeatService(db);
  const enqueuePlanQaWakeup = createPlanQaWakeupHandler(
    heartbeat,
    { requestedByActorId: "missions-route-plan-qa", contextSource: "missions_route_plan_qa" },
  );
  const enqueuePlanningIssueWakeup = createPlanningIssueWakeupHandler(
    heartbeat,
    { requestedByActorId: "missions-route-plan-rework", contextSource: "missions_route_plan_rework" },
  );
  const delegationSvc = missionDelegationService(db);
  const svc = missionService(db, {
    onOwnerActionCreated: ({ mission, issue, sourceIssue, reason }) => {
      return heartbeat.wakeup(mission.ownerAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: reason ?? "mission_unblock_action_created",
        payload: {
          issueId: issue.id,
          mutation: "mission_main_executor_unblock",
          sourceIssueId: sourceIssue.id,
        },
        requestedByActorType: "system",
        requestedByActorId: "mission-owner-supervision",
        contextSnapshot: {
          issueId: issue.id,
          missionId: mission.id,
          source: "mission_supervision",
          sourceIssueId: sourceIssue.id,
        },
      });
    },
    onOwnerPlanningIssueCreated: ({ mission, issue, targetAgentId, idempotencyKey }) => {
      return heartbeat.wakeup(targetAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "mission_owner_planning_issue_created",
        idempotencyKey,
        payload: {
          issueId: issue.id,
          missionId: mission.id,
          mutation: "mission_main_executor_plan",
        },
        requestedByActorType: "system",
        requestedByActorId: "mission-owner-planning",
        contextSnapshot: {
          issueId: issue.id,
          missionId: mission.id,
          source: "mission_owner_planning_issue_created",
          wakeReason: "mission_owner_planning_issue_created",
          forceFreshSession: true,
        },
      });
    },
    onPlanRevisionRequested: ({ mission, planIssueId, planQaIssueId, targetAgentId, decisionHash }) => enqueuePlanningIssueWakeup({
      companyId: mission.companyId,
      agentId: targetAgentId,
      issueId: planIssueId,
      issueStatus: "todo",
      missionId: mission.id,
      planQaIssueId,
      decisionHash,
    }),
    onOwnerDecisionRetrySourceIssueApplied: async ({ mission, ownerActionIssue, sourceIssue, targetAgentId, idempotencyKey, decisionCommentId }) => {
      // [native authority] approved Oversight retry routes through the validated native DAG helper
      //   (prove workflowRun/definition/step/stepRun → wakeExistingWorkflowStepIssue). The old
      //   reason=mission_owner_retry_source_issue direct wake is removed: it bypassed official
      //   workflow retry/iteration/QA authority. report-only when no native link is provable.
      // [cap-override] ownerAction 로 failed run + completed producer(at/beyond cap) 1회 retry 승인.
      const outcome = await dispatchSourceIssueNativeResume(db, {
        companyId: mission.companyId,
        issueId: sourceIssue.id,
        allowBlockedIssue: true,
        agentId: targetAgentId,
        ownerAction: { ownerActionIssueId: ownerActionIssue.id, missionId: mission.id, decisionCommentId: decisionCommentId ?? "" },
      });
      if (outcome.kind === "dispatched" || outcome.kind === "cap_override_applied") {
        return { status: "dispatched" as const, runId: outcome.workflowRunId };
      }
      if (outcome.kind === "already_in_flight" || outcome.kind === "cap_override_already_applied") {
        return outcome.kind === "already_in_flight"
          ? { status: "workflow_already_dispatched" as const, workflowWakeupRequestId: outcome.workflowWakeupRequestId, runId: outcome.runId }
          : { status: "workflow_already_dispatched" as const, workflowWakeupRequestId: null, runId: null };
      }
      return { status: "not_requested" as const, runId: null };
    },
    onStaleSourceIssueWakeupRequested: ({ mission, sourceIssue, failedRun, idempotencyKey, wakeCommentId }) => {
      return heartbeat.wakeup(mission.ownerAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "mission_stale_source_issue_wakeup",
        idempotencyKey,
        payload: {
          issueId: sourceIssue.id,
          missionId: mission.id,
          mutation: "mission_stale_source_issue_wakeup",
          sourceIssueId: sourceIssue.id,
          failedRunId: failedRun.id,
          failedRunStatus: failedRun.status,
          wakeCommentId,
        },
        requestedByActorType: "system",
        requestedByActorId: "mission-owner-supervision",
        contextSnapshot: {
          issueId: sourceIssue.id,
          missionId: mission.id,
          source: "mission_stale_source_issue_wakeup",
          sourceIssueId: sourceIssue.id,
          failedRunId: failedRun.id,
          failedRunStatus: failedRun.status,
          wakeCommentId,
        },
      });
    },
    onPlanSubmissionMissing: ({ mission, planIssueId, targetAgentId, idempotencyKey, wakeCommentId }) => {
      return heartbeat.wakeup(targetAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "mission_owner_plan_submission_missing",
        idempotencyKey,
        payload: {
          issueId: planIssueId,
          missionId: mission.id,
          mutation: "mission_main_executor_plan",
          wakeCommentId,
        },
        requestedByActorType: "system",
        requestedByActorId: "mission-owner-supervision",
        contextSnapshot: {
          issueId: planIssueId,
          missionId: mission.id,
          source: "mission_owner_plan_submission_missing",
          wakeReason: "mission_owner_plan_submission_missing",
          wakeCommentId,
          forceFreshSession: true,
        },
      });
    },
    onPlanQaIssueCreated: enqueuePlanQaWakeup,
    cancelHeartbeatRun: (runId) => heartbeat.cancelRun(runId),
  });

  // ---------------------------------------------------------------------------
  // Mission CRUD
  // ---------------------------------------------------------------------------

  /**
   * GET /companies/:companyId/missions/human-operator-requests
   *
   * List open mission governance decisions that need human/operator input.
   */
  router.get("/companies/:companyId/missions/human-operator-requests", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    const limit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
    const requests = await listCompanyHumanOperatorRequests(db, {
      companyId,
      ...(Number.isFinite(limit) && limit && limit > 0 ? { limit: Math.min(limit, 100) } : {}),
    });

    res.json(requests);
  });

  /**
   * GET /companies/:companyId/missions
   *
   * List missions for a company.
   * Query params: ?status=active&ownerAgentId=xxx&goalId=xxx&from=2026-04-01&to=2026-04-29&sortBy=createdAt&sortOrder=desc&limit=50&offset=0
   */
  router.get("/companies/:companyId/missions", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    const { status, ownerAgentId, goalId, from, to, sortBy, sortOrder, limit, offset } = req.query;

    const result = await svc.list({
      companyId,
      status: status as "planning" | "active" | "paused" | "completed" | "cancelled" | undefined,
      ownerAgentId: ownerAgentId as string | undefined,
      goalId: goalId as string | undefined,
      from: from as string | undefined,
      to: to as string | undefined,
      sortBy: sortBy as "createdAt" | "updatedAt" | "title" | "status" | undefined,
      sortOrder: sortOrder as "asc" | "desc" | undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
      offset: offset ? parseInt(offset as string, 10) : undefined,
    });
    res.json(result);
  });

  /**
   * POST /companies/:companyId/missions
   *
   * Create a new mission.
   */
  router.post("/companies/:companyId/missions", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    const { ownerAgentId, title, description, goalId, projectId, status, agentIds, source } = req.body;

    if (!ownerAgentId || !title) {
      throw badRequest("ownerAgentId and title are required");
    }

    const mission = await svc.create({
      companyId,
      ownerAgentId,
      title,
      description,
      goalId,
      projectId,
      status,
      agentIds,
      source,
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "mission.created",
      entityType: "mission",
      entityId: mission.id,
      details: { title, ownerAgentId, status: mission.status },
    });

    res.status(201).json(mission);
  });

  /**
   * POST /companies/:companyId/missions/:missionId/supervision/run
   *
   * Manually run mission owner supervision for one mission.
   * Defaults to read-only observation mode; only safe internal sync actions run when explicitly requested.
   */
  router.post("/companies/:companyId/missions/:missionId/supervision/run", async (req, res) => {
    const { companyId, missionId } = req.params;
    const mission = await svc.getById(missionId);
    if (mission.companyId !== companyId) {
      throw notFound("Mission not found");
    }
    assertCompanyAccess(req, companyId);

    const { staleAfterMinutes, applySafeActions, applyOwnerDecisionActions, dispatchOwnerDecisionWakeups, dispatchStaleSourceIssueWakeups } = req.body ?? {};
    let parsedStaleAfterMinutes: number | undefined;
    if (staleAfterMinutes !== undefined) {
      parsedStaleAfterMinutes = typeof staleAfterMinutes === "number"
        ? staleAfterMinutes
        : Number.parseInt(String(staleAfterMinutes), 10);
      if (!Number.isFinite(parsedStaleAfterMinutes) || parsedStaleAfterMinutes <= 0) {
        throw badRequest("staleAfterMinutes must be a positive number");
      }
    }

    const result = await svc.runActiveMissionOwnerSupervision({
      companyId,
      missionIds: [missionId],
      staleAfterMinutes: parsedStaleAfterMinutes,
      applySafeActions: applySafeActions === true,
      applyOwnerDecisionActions: applyOwnerDecisionActions === true,
      dispatchOwnerDecisionWakeups: dispatchOwnerDecisionWakeups === true,
      dispatchStaleSourceIssueWakeups: dispatchStaleSourceIssueWakeups === true,
    });

    const actor = getActorInfo(req);
    const missionResults = Array.isArray(result.missions) ? result.missions : [];
    const countNestedItems = (key: "findings" | "recommendations" | "appliedActions") =>
      missionResults.reduce((total, missionResult) => {
        const value = (missionResult as Record<string, unknown>)[key];
        return total + (Array.isArray(value) ? value.length : 0);
      }, 0);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "mission.supervision.run",
      entityType: "mission",
      entityId: missionId,
      details: {
        staleAfterMinutes: parsedStaleAfterMinutes ?? null,
        applySafeActions: applySafeActions === true,
        applyOwnerDecisionActions: applyOwnerDecisionActions === true,
        dispatchOwnerDecisionWakeups: dispatchOwnerDecisionWakeups === true,
        dispatchStaleSourceIssueWakeups: dispatchStaleSourceIssueWakeups === true,
        missionCount: missionResults.length,
        findingCount: countNestedItems("findings"),
        recommendationCount: countNestedItems("recommendations"),
        appliedActionCount: countNestedItems("appliedActions"),
      },
    });

    res.json(result);
  });

  /**
   * GET /missions/:id/delegations
   *
   * List cross-company mission delegations created from this mission.
   */
  router.get("/missions/:id/delegations", async (req, res) => {
    const mission = await svc.getById(req.params.id);
    assertCompanyAccess(req, mission.companyId);

    const delegations = await delegationSvc.listForMission(req.params.id);
    res.json(delegations);
  });

  /**
   * POST /missions/:id/delegations
   *
   * Create a target-company mission from this source mission and track it with
   * a source-side blocked issue until the target mission reaches a terminal status.
   */
  router.post("/missions/:id/delegations", async (req, res) => {
    const mission = await svc.getById(req.params.id);
    assertCompanyAccess(req, mission.companyId);

    const {
      targetCompanyId,
      targetOwnerAgentId,
      title,
      description,
      sourceIssueTitle,
      priority,
      metadata,
    } = req.body ?? {};
    if (!targetCompanyId || !targetOwnerAgentId) {
      throw badRequest("targetCompanyId and targetOwnerAgentId are required");
    }
    assertCompanyAccess(req, targetCompanyId);

    const result = await delegationSvc.create({
      sourceMissionId: req.params.id,
      targetCompanyId,
      targetOwnerAgentId,
      title,
      description,
      sourceIssueTitle,
      priority,
      metadata,
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: mission.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "mission.delegation.created",
      entityType: "mission",
      entityId: mission.id,
      details: {
        delegationId: result.delegation.id,
        targetCompanyId,
        targetMissionId: result.targetMission.id,
        sourceIssueId: result.sourceIssue.id,
      },
    });

    res.status(201).json(result);
  });

  /**
   * GET /missions/:id
   *
   * Get a mission by ID with agents and metadata.
   */
  router.get("/missions/:id", async (req, res) => {
    const mission = await svc.getById(req.params.id);
    assertCompanyAccess(req, mission.companyId);
    res.json(mission);
  });

  /**
   * PATCH /missions/:id
   *
   * Update mission fields (title, description, status, goalId).
   */
  router.patch("/missions/:id", async (req, res) => {
    const existing = await svc.getById(req.params.id);
    assertCompanyAccess(req, existing.companyId);

    const { title, description, status, goalId, projectId, startedAt, completedAt } = req.body;
    if (status === "cancelled") {
      const issueTree = await svc.getIssueTree(req.params.id);
      const candidateRunIds = new Set<string>();
      for (const issue of issueTree) {
        if (issue.executionRunId) candidateRunIds.add(issue.executionRunId);
        if (issue.checkoutRunId) candidateRunIds.add(issue.checkoutRunId);
      }
      for (const runId of candidateRunIds) {
        const run = await heartbeat.getRun(runId);
        if (!run || run.companyId !== existing.companyId) continue;
        if (run.status === "queued" || run.status === "running") {
          await heartbeat.cancelRun(run.id);
        }
      }
    }

    const updated = await svc.update(req.params.id, {
      title,
      description,
      status,
      goalId,
      projectId,
      startedAt: startedAt ? new Date(startedAt) : undefined,
      completedAt: completedAt ? new Date(completedAt) : undefined,
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "mission.updated",
      entityType: "mission",
      entityId: req.params.id,
      details: req.body,
    });

    res.json(updated);
  });

  /**
   * DELETE /missions/:id
   *
   * Delete a mission.
   */
  router.delete("/missions/:id", async (req, res) => {
    const existing = await svc.getById(req.params.id);
    assertCompanyAccess(req, existing.companyId);

    await svc.delete(req.params.id);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "mission.deleted",
      entityType: "mission",
      entityId: req.params.id,
      details: { title: existing.title },
    });

    res.status(204).send();
  });

  // ---------------------------------------------------------------------------
  // Mission Agents
  // ---------------------------------------------------------------------------

  /**
   * GET /missions/:id/agents
   *
   * List agents in a mission.
   */
  router.get("/missions/:id/agents", async (req, res) => {
    const mission = await svc.getById(req.params.id);
    assertCompanyAccess(req, mission.companyId);

    const agents = await svc.listAgents(req.params.id);
    res.json(agents);
  });

  /**
   * POST /missions/:id/agents
   *
   * Add an agent to a mission.
   */
  router.post("/missions/:id/agents", async (req, res) => {
    const mission = await svc.getById(req.params.id);
    assertCompanyAccess(req, mission.companyId);

    const { agentId, role } = req.body;
    if (!agentId) {
      throw badRequest("agentId is required");
    }

    const missionAgent = await svc.addAgent({
      missionId: req.params.id,
      agentId,
      role,
    });

    res.status(201).json(missionAgent);
  });

  /**
   * PATCH /missions/:id/agents/:agentId
   *
   * Update an agent's role in a mission.
   */
  router.patch("/missions/:id/agents/:agentId", async (req, res) => {
    const mission = await svc.getById(req.params.id);
    assertCompanyAccess(req, mission.companyId);

    const { role } = req.body;
    if (!role) {
      throw badRequest("role is required");
    }

    const updated = await svc.updateAgentRole(req.params.id, req.params.agentId, role);
    res.json(updated);
  });

  /**
   * DELETE /missions/:id/agents/:agentId
   *
   * Remove an agent from a mission.
   */
  router.delete("/missions/:id/agents/:agentId", async (req, res) => {
    const mission = await svc.getById(req.params.id);
    assertCompanyAccess(req, mission.companyId);

    await svc.removeAgent(req.params.id, req.params.agentId);
    res.status(204).send();
  });

  // ---------------------------------------------------------------------------
  // Mission sub-resources
  // ---------------------------------------------------------------------------

  /**
   * GET /missions/:id/governance-thread
   *
   * Read the mission governance thread projection for this mission.
   */
  router.get("/missions/:id/governance-thread", async (req, res) => {
    const mission = await svc.getById(req.params.id);
    assertCompanyAccess(req, mission.companyId);

    const thread = await listMissionGovernanceThread(db, {
      companyId: mission.companyId,
      missionId: mission.id,
    });
    if (!thread) {
      throw notFound("Mission not found");
    }

    res.json({
      missionId: mission.id,
      companyId: mission.companyId,
      events: thread.events,
      summary: thread.summary,
    });
  });

  /**
   * GET /missions/:id/runtime-snapshot
   *
   * Read structured mission runtime state for Ops/Hermes/oversight.
   */
  router.get("/missions/:id/runtime-snapshot", async (req, res) => {
    const mission = await svc.getById(req.params.id);
    assertCompanyAccess(req, mission.companyId);

    const snapshot = await loadMissionRuntimeSnapshot(db, {
      companyId: mission.companyId,
      missionId: mission.id,
    });

    res.json({
      missionId: mission.id,
      companyId: mission.companyId,
      snapshot,
    });
  });

  /**
   * GET /companies/:companyId/missions/:missionId/recovery-advice
   *
   * Read-only structured recovery diagnosis for operators/Hermes: who to wake,
   * what action, leaf cause, and paste-ready comment. Reuses supervision's
   * REQUEST_CHANGES signals (no parallel classifier). Complex native-loop/owner
   * cases delegate to decision=supervision_run.
   */
  router.get("/companies/:companyId/missions/:missionId/recovery-advice", async (req, res) => {
    const { companyId, missionId } = req.params;
    const mission = await svc.getById(missionId);
    if (mission.companyId !== companyId) {
      throw notFound("Mission not found");
    }
    assertCompanyAccess(req, companyId);

    const issueId = typeof req.query.issueId === "string" ? req.query.issueId : null;
    const advice = await getMissionRecoveryAdvice(db, { companyId, missionId, issueId });
    res.json(advice);
  });

  /**
   * GET /missions/:id/issues
   *
   * Get the issue tree for a mission.
   */
  router.get("/missions/:id/issues", async (req, res) => {
    const mission = await svc.getById(req.params.id);
    assertCompanyAccess(req, mission.companyId);

    const issueTree = await svc.getIssueTree(req.params.id);
    res.json(issueTree);
  });

  /**
   * GET /missions/:id/workflow-runs
   *
   * List workflow runs associated with this mission.
   */
  router.get("/missions/:id/workflow-runs", async (req, res) => {
    const mission = await svc.getById(req.params.id);
    assertCompanyAccess(req, mission.companyId);

    const runs = await svc.listWorkflowRuns(req.params.id);
    res.json(runs);
  });

  /**
   * GET /missions/:id/workflow-runs/:runId/flowmap
   *
   * Export one workflow run as a single-file interactive flowmap HTML
   * (repo-flowmap fixed renderer; IF branches + rework loops as cond edges).
   * Read-only download — board/operator context, company access enforced.
   */
  router.get("/missions/:id/workflow-runs/:runId/flowmap", async (req, res) => {
    const mission = await svc.getById(req.params.id);
    assertCompanyAccess(req, mission.companyId);

    const html = await svc.buildMissionRunFlowmapHtml(req.params.id, req.params.runId);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="mission-${req.params.id}-flowmap.html"`);
    res.send(html);
  });

  return router;
}

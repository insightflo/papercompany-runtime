/**
 * Mission Routes
 *
 * Endpoints:
 * - GET    /companies/:companyId/missions            — List missions
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
 */
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { missionService } from "../services/missions.js";
import { heartbeatService } from "../services/heartbeat.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { notFound, badRequest } from "../errors.js";
import { logActivity } from "../services/activity-log.js";
import { listMissionGovernanceThread } from "../services/missions/governance-thread.js";

export function missionRoutes(db: Db) {
  const router = Router();
  const heartbeat = heartbeatService(db);
  const svc = missionService(db, {
    onOwnerActionCreated: ({ mission, issue, sourceIssue, reason }) => {
      if (!issue.assigneeAgentId) return null;
      return heartbeat.wakeup(issue.assigneeAgentId, {
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
        },
      });
    },
    onOwnerDecisionRetrySourceIssueApplied: ({ mission, ownerActionIssue, sourceIssue, targetAgentId, idempotencyKey, wakeCommentId }) => {
      return heartbeat.wakeup(targetAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "mission_owner_retry_source_issue",
        idempotencyKey,
        payload: {
          issueId: sourceIssue.id,
          missionId: mission.id,
          ownerActionIssueId: ownerActionIssue.id,
          mutation: "mission_owner_retry_source_issue",
          sourceIssueId: sourceIssue.id,
          wakeCommentId,
        },
        requestedByActorType: "system",
        requestedByActorId: "mission-owner-supervision",
        contextSnapshot: {
          issueId: sourceIssue.id,
          missionId: mission.id,
          source: "mission_owner_retry_source_issue",
          ownerActionIssueId: ownerActionIssue.id,
          sourceIssueId: sourceIssue.id,
          wakeCommentId,
        },
      });
    },
    onStaleSourceIssueWakeupRequested: ({ mission, sourceIssue, targetAgentId, failedRun, idempotencyKey, wakeCommentId }) => {
      return heartbeat.wakeup(targetAgentId, {
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
  });

  // ---------------------------------------------------------------------------
  // Mission CRUD
  // ---------------------------------------------------------------------------

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

    const { ownerAgentId, title, description, goalId, status, agentIds, source } = req.body;

    if (!ownerAgentId || !title) {
      throw badRequest("ownerAgentId and title are required");
    }

    const mission = await svc.create({
      companyId,
      ownerAgentId,
      title,
      description,
      goalId,
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

    const { title, description, status, goalId, startedAt, completedAt } = req.body;
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

  return router;
}

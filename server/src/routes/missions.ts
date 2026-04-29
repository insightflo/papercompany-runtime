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
 */

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { missionService } from "../services/missions.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { notFound, badRequest } from "../errors.js";
import { logActivity } from "../services/activity-log.js";

export function missionRoutes(db: Db) {
  const router = Router();
  const svc = missionService(db);

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

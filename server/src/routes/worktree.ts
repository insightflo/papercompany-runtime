/**
 * Worktree Routes
 *
 * Endpoints:
 * - GET    /companies/:companyId/worktree/rules           — List rules
 * - POST   /companies/:companyId/worktree/rules           — Create rule
 * - GET    /worktree/rules/:id                            — Get rule
 * - PATCH  /worktree/rules/:id                            — Update rule
 * - DELETE /worktree/rules/:id                            — Delete rule
 * - GET    /companies/:companyId/worktree/proposals       — List proposals
 * - POST   /companies/:companyId/worktree/proposals       — Create proposal
 * - GET    /worktree/proposals/:id                        — Get proposal
 * - PATCH  /worktree/proposals/:id/review                 — Review proposal (approve/reject)
 *
 * CRITICAL: /maintenance/* routes are gated by company-kind-gate at the app level.
 */

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { ruleStore } from "../services/worktree/rule-store.js";
import { proposalStore } from "../services/worktree/proposal-store.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { notFound, badRequest } from "../errors.js";
import { logActivity } from "../services/activity-log.js";

export function worktreeRoutes(db: Db) {
  const router = Router();
  const rules = ruleStore(db);
  const proposals = proposalStore(db);

  // ---------------------------------------------------------------------------
  // Rules
  // ---------------------------------------------------------------------------

  /**
   * GET /companies/:companyId/worktree/rules
   *
   * List rules for a company.
   * Query params: ?enabled=true&severity=MUST&sortBy=createdAt&sortOrder=asc&limit=50&offset=0
   */
  router.get("/companies/:companyId/worktree/rules", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    const enabled =
      req.query.enabled === "true" ? true : req.query.enabled === "false" ? false : undefined;
    const severity = req.query.severity as string | undefined;
    const sortBy = req.query.sortBy as string | undefined;
    const sortOrder = req.query.sortOrder as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;

    const result = await rules.listByCompany(companyId, {
      enabled,
      severity: severity as "MUST" | "SHOULD" | "MAY" | undefined,
      sortBy: sortBy as "createdAt" | "updatedAt" | "name" | "severity" | undefined,
      sortOrder: sortOrder as "asc" | "desc" | undefined,
      limit,
      offset,
    });
    res.json(result);
  });

  /**
   * POST /companies/:companyId/worktree/rules
   *
   * Create a new rule.
   */
  router.post("/companies/:companyId/worktree/rules", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    const { name, severity, action, predicate, decisionMap, message, enabled } = req.body;

    if (!name || !severity || !action || !predicate) {
      throw badRequest("name, severity, action, and predicate are required");
    }

    const actor = getActorInfo(req);

    const rule = await rules.create({
      companyId,
      name,
      severity,
      action,
      predicate,
      decisionMap: decisionMap ?? {},
      message,
      enabled,
      createdBy: actor.actorId,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "worktree_rule.created",
      entityType: "worktree_rule",
      entityId: rule.id,
      details: { name, severity, action },
    });

    res.status(201).json(rule);
  });

  /**
   * GET /worktree/rules/:id
   *
   * Get a single rule.
   */
  router.get("/worktree/rules/:id", async (req, res) => {
    const rule = await rules.getById(req.params.id);
    assertCompanyAccess(req, rule.companyId);
    res.json(rule);
  });

  /**
   * PATCH /worktree/rules/:id
   *
   * Update a rule.
   */
  router.patch("/worktree/rules/:id", async (req, res) => {
    const existing = await rules.getById(req.params.id);
    assertCompanyAccess(req, existing.companyId);

    const { name, severity, action, predicate, decisionMap, message, enabled } = req.body;
    const updated = await rules.update(req.params.id, {
      name,
      severity,
      action,
      predicate,
      decisionMap,
      message,
      enabled,
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "worktree_rule.updated",
      entityType: "worktree_rule",
      entityId: req.params.id,
      details: req.body,
    });

    res.json(updated);
  });

  /**
   * DELETE /worktree/rules/:id
   *
   * Delete a rule.
   */
  router.delete("/worktree/rules/:id", async (req, res) => {
    const existing = await rules.getById(req.params.id);
    assertCompanyAccess(req, existing.companyId);

    await rules.delete(req.params.id);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "worktree_rule.deleted",
      entityType: "worktree_rule",
      entityId: req.params.id,
      details: { name: existing.name },
    });

    res.status(204).send();
  });

  // ---------------------------------------------------------------------------
  // Proposals
  // ---------------------------------------------------------------------------

  /**
   * GET /companies/:companyId/worktree/proposals
   *
   * List proposals for a company.
   * Query params: ?status=proposed&proposedByAgentId=xxx&ruleId=xxx&sortBy=createdAt&sortOrder=desc&limit=50&offset=0
   */
  router.get("/companies/:companyId/worktree/proposals", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    const status = req.query.status as string | undefined;
    const proposedByAgentId = req.query.proposedByAgentId as string | undefined;
    const ruleId = req.query.ruleId as string | undefined;
    const sortBy = req.query.sortBy as string | undefined;
    const sortOrder = req.query.sortOrder as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;

    const result = await proposals.listByCompany(companyId, {
      status: status as "proposed" | "approved" | "rejected" | undefined,
      proposedByAgentId,
      ruleId,
      sortBy: sortBy as "createdAt" | "status" | undefined,
      sortOrder: sortOrder as "asc" | "desc" | undefined,
      limit,
      offset,
    });
    res.json(result);
  });

  /**
   * POST /companies/:companyId/worktree/proposals
   *
   * Create a new proposal.
   */
  router.post("/companies/:companyId/worktree/proposals", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    const { proposedByAgentId, ruleId, proposedChange, rationale } = req.body;

    if (!proposedByAgentId || !proposedChange || !rationale) {
      throw badRequest("proposedByAgentId, proposedChange, and rationale are required");
    }

    const proposal = await proposals.create({
      companyId,
      proposedByAgentId,
      ruleId,
      proposedChange,
      rationale,
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "worktree_proposal.created",
      entityType: "worktree_proposal",
      entityId: proposal.id,
      details: { proposedByAgentId, ruleId },
    });

    res.status(201).json(proposal);
  });

  /**
   * GET /worktree/proposals/:id
   *
   * Get a single proposal.
   */
  router.get("/worktree/proposals/:id", async (req, res) => {
    const proposal = await proposals.getById(req.params.id);
    assertCompanyAccess(req, proposal.companyId);
    res.json(proposal);
  });

  /**
   * PATCH /worktree/proposals/:id/review
   *
   * Approve or reject a proposal.
   */
  router.patch("/worktree/proposals/:id/review", async (req, res) => {
    const existing = await proposals.getById(req.params.id);
    assertCompanyAccess(req, existing.companyId);

    const { status, reviewedByAgentId, reviewNote } = req.body;

    if (!status || !reviewedByAgentId) {
      throw badRequest("status and reviewedByAgentId are required");
    }

    const updated = await proposals.review(req.params.id, {
      status,
      reviewedByAgentId,
      reviewNote,
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: `worktree_proposal.${status}`,
      entityType: "worktree_proposal",
      entityId: req.params.id,
      details: { status, reviewedByAgentId },
    });

    res.json(updated);
  });

  return router;
}

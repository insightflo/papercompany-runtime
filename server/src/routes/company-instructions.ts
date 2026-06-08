import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { upsertCompanyInstructionFileSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { accessService, agentService, companyInstructionsService, logActivity } from "../services/index.js";
import { forbidden } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function companyInstructionRoutes(db: Db) {
  const router = Router();
  const agents = agentService(db);
  const access = accessService(db);
  const svc = companyInstructionsService();

  function canCreateAgents(agent: { permissions: Record<string, unknown> | null | undefined }) {
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  async function assertCanMutateCompanyInstructions(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);

    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      const allowed = await access.canUser(companyId, req.actor.userId, "agents:create");
      if (!allowed) throw forbidden("Missing permission: agents:create");
      return;
    }

    if (!req.actor.agentId) throw forbidden("Agent authentication required");
    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }

    const allowedByGrant = await access.hasPermission(companyId, "agent", actorAgent.id, "agents:create");
    if (allowedByGrant || canCreateAgents(actorAgent)) return;
    throw forbidden("Missing permission: can create agents");
  }

  router.get("/companies/:companyId/instructions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId));
  });

  router.get("/companies/:companyId/instructions/file", async (req, res) => {
    const companyId = req.params.companyId as string;
    const relativePath = typeof req.query.path === "string" ? req.query.path : "";
    assertCompanyAccess(req, companyId);
    if (!relativePath.trim()) {
      res.status(422).json({ error: "Query parameter 'path' is required" });
      return;
    }
    const result = await svc.readFile(companyId, relativePath);
    if (!result) {
      res.status(404).json({ error: "Company instruction file not found" });
      return;
    }
    res.json(result);
  });

  router.put(
    "/companies/:companyId/instructions/file",
    validate(upsertCompanyInstructionFileSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanMutateCompanyInstructions(req, companyId);
      const result = await svc.writeFile(companyId, req.body.path, req.body.content);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.instructions_file_updated",
        entityType: "company",
        entityId: companyId,
        details: {
          path: result.path,
          size: result.size,
        },
      });
      res.json(result);
    },
  );

  router.delete("/companies/:companyId/instructions/file", async (req, res) => {
    const companyId = req.params.companyId as string;
    const relativePath = typeof req.query.path === "string" ? req.query.path : "";
    await assertCanMutateCompanyInstructions(req, companyId);
    if (!relativePath.trim()) {
      res.status(422).json({ error: "Query parameter 'path' is required" });
      return;
    }
    const result = await svc.deleteFile(companyId, relativePath);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.instructions_file_deleted",
      entityType: "company",
      entityId: companyId,
      details: { path: result.path },
    });
    res.json(result);
  });

  return router;
}

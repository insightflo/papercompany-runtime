import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { upsertCompanyInstructionFileSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { accessService, agentService, companyInstructionsService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { assertCanMutateCompanyInstructions } from "./company-instructions-authz.js";

export function companyInstructionRoutes(db: Db) {
  const router = Router();
  const agents = agentService(db);
  const access = accessService(db);
  const svc = companyInstructionsService();

  const assertMutation = (req: Parameters<typeof assertCanMutateCompanyInstructions>[0]["req"], companyId: string) =>
    assertCanMutateCompanyInstructions({ req, companyId, agents, access });

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
      await assertMutation(req, companyId);
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
    await assertMutation(req, companyId);
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

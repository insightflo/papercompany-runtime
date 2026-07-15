import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { companyWorkProductStorageConfigSchema } from "@paperclipai/shared/validators/company-work-product-storage";
import { badRequest } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import {
  createCompanyWorkProductStorageService,
  type CompanyWorkProductStorageService,
  type CompanyWorkProductStorageTestResult,
} from "../services/company-work-product-storage.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export interface CompanyWorkProductStorageRouteOptions {
  service?: CompanyWorkProductStorageService;
}

function hasConnectionTestBody(body: unknown) {
  if (body === undefined || body === null) return false;
  return !(
    typeof body === "object" &&
    !Array.isArray(body) &&
    Object.keys(body).length === 0
  );
}

export function companyWorkProductStorageRoutes(
  db: Db,
  options: CompanyWorkProductStorageRouteOptions = {},
) {
  const router = Router();
  const service = options.service ?? createCompanyWorkProductStorageService(db);

  router.get("/companies/:companyId/work-product-storage", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await service.get(companyId));
  });

  router.put(
    "/companies/:companyId/work-product-storage",
    validate(companyWorkProductStorageConfigSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const saved = await service.save(companyId, req.body);
      const actor = getActorInfo(req);

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "work_product_storage.updated",
        entityType: "work_product_storage",
        entityId: companyId,
        details: { provider: saved.provider },
      });

      res.json(saved);
    },
  );

  router.post("/companies/:companyId/work-product-storage/test", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (hasConnectionTestBody(req.body)) {
      throw badRequest("Connection tests do not accept a request body");
    }

    const result: CompanyWorkProductStorageTestResult = await service.testConnection(companyId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "work_product_storage.connection_tested",
      entityType: "work_product_storage",
      entityId: companyId,
      details: { provider: result.provider, ok: result.ok },
    });

    res.json(result);
  });

  return router;
}

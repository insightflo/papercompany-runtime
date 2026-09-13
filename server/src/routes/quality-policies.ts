import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { uuidSchema, type QualityHumanActor } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { activateQualityPolicy, createQualityPolicy } from "../services/quality/policy.js";
import { resolveWorkflowSchedulerOwnership, type WorkflowSchedulerOwnershipMode } from "../services/workflow/scheduler-ownership.js";

const createBody = z.object({ policy: z.unknown() }).strict();
const activateBody = z.object({ expectedActivePolicyVersionId: uuidSchema.nullable() }).strict();
function humanActor(req: Request, companyId: string): QualityHumanActor {
  assertCompanyAccess(req, companyId);
  assertBoard(req);
  const { userId, source, keyId } = req.actor;
  if (!userId || !source || !["session", "board_key", "local_implicit"].includes(source)) throw forbidden("quality_human_required");
  return { userId, source: source as QualityHumanActor["source"], keyId: keyId ?? null };
}

export function qualityPolicyRoutes(db: Db, ownershipMode: WorkflowSchedulerOwnershipMode = resolveWorkflowSchedulerOwnership().mode): Router {
  const router = Router();
  router.post("/companies/:companyId/quality/policies", async (req, res) => {
    const companyId = uuidSchema.parse(req.params.companyId);
    const actor = humanActor(req, companyId);
    const body = createBody.parse(req.body);
    res.status(201).json(await createQualityPolicy(db, actor, { companyId, policy: body.policy }));
  });
  router.post("/companies/:companyId/quality/policies/:policyVersionId/activate", async (req, res) => {
    const companyId = uuidSchema.parse(req.params.companyId);
    const actor = humanActor(req, companyId);
    const policyVersionId = uuidSchema.parse(req.params.policyVersionId);
    const body = activateBody.parse(req.body);
    res.json(await activateQualityPolicy(db, actor, { companyId, policyVersionId, ...body }, ownershipMode));
  });
  return router;
}

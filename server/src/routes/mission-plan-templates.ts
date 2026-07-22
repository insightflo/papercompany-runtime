import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createMissionPlanTemplateSchema,
  duplicateMissionPlanTemplateSchema,
  updateMissionPlanTemplateSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { accessService, agentService, logActivity, missionPlanTemplateService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { assertCanMutateCompanyInstructions } from "./company-instructions-authz.js";

export function missionPlanTemplateRoutes(db: Db) {
  const router = Router();
  const service = missionPlanTemplateService(db);
  const agents = agentService(db);
  const access = accessService(db);

  async function assertMutation(req: Parameters<typeof assertCanMutateCompanyInstructions>[0]["req"], companyId: string) {
    await assertCanMutateCompanyInstructions({ req, companyId, agents, access });
  }

  async function record(req: Parameters<typeof getActorInfo>[0], companyId: string, action: string, template: {
    id: string; key: string; origin: string; enabled: boolean;
  }) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action,
      entityType: "mission_plan_template",
      entityId: template.id,
      details: { templateId: template.id, key: template.key, origin: template.origin, enabled: template.enabled },
    });
  }

  router.get("/companies/:companyId/mission-plan-templates", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const includeDisabled = req.actor.type === "board" && req.query.includeDisabled === "true";
    res.json({ companyId, templates: await service.list(companyId, { includeDisabled }) });
  });

  router.get("/companies/:companyId/mission-plan-templates/:templateId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const template = await service.get(companyId, req.params.templateId as string, {
      includeDisabled: req.actor.type === "board",
    });
    if (!template) { res.status(404).json({ error: "Mission plan template not found" }); return; }
    res.json(template);
  });

  router.post("/companies/:companyId/mission-plan-templates", validate(createMissionPlanTemplateSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertMutation(req, companyId);
    const template = await service.createCustom(companyId, req.body);
    await record(req, companyId, "company.mission_plan_template_created", template);
    res.status(201).json(template);
  });

  router.patch("/companies/:companyId/mission-plan-templates/:templateId", validate(updateMissionPlanTemplateSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertMutation(req, companyId);
    const template = await service.update(companyId, req.params.templateId as string, req.body);
    await record(req, companyId, "company.mission_plan_template_updated", template);
    res.json(template);
  });

  router.post("/companies/:companyId/mission-plan-templates/:templateId/duplicate", validate(duplicateMissionPlanTemplateSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertMutation(req, companyId);
    const template = await service.duplicate(companyId, req.params.templateId as string, req.body);
    await record(req, companyId, "company.mission_plan_template_duplicated", template);
    res.status(201).json(template);
  });

  router.delete("/companies/:companyId/mission-plan-templates/:templateId", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertMutation(req, companyId);
    const template = await service.get(companyId, req.params.templateId as string, { includeDisabled: true });
    await service.removeCustom(companyId, req.params.templateId as string);
    if (template) await record(req, companyId, "company.mission_plan_template_deleted", template);
    res.status(204).send();
  });

  return router;
}

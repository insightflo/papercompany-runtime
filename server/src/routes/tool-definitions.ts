import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createToolDefinitionSchema,
  updateToolDefinitionSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { conflict, notFound } from "../errors.js";
import { logActivity } from "../services/activity-log.js";
import { toolService } from "../services/tools/registry.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

async function requireCompanyTool(db: Db, companyId: string, toolId: string) {
  const tool = await toolService.getDefinitionById(db, toolId);
  if (!tool || tool.companyId !== companyId) {
    throw notFound("Tool not found");
  }
  return tool;
}

function assertMutableTool(tool: Awaited<ReturnType<typeof requireCompanyTool>>) {
  if (tool.adapterConfig.source === "tool-registry") {
    throw conflict("Source-managed tools must be changed at their source.");
  }
}

function isToolNameConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === "23505"
    && (candidate.constraint === undefined || candidate.constraint === "tool_definitions_company_id_name_key");
}

function throwToolNameConflict(error: unknown, name: string): never {
  if (isToolNameConflict(error)) {
    throw conflict(`Tool "${name}" already exists.`);
  }
  throw error;
}

export function toolDefinitionRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/tools", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    res.json(await toolService.listDefinitions(db, { companyId }));
  });

  router.post("/companies/:companyId/tools", validate(createToolDefinitionSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    let tool;
    try {
      tool = await toolService.createDefinition(db, { ...req.body, companyId });
    } catch (error) {
      throwToolNameConflict(error, req.body.name);
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.tool_created",
      entityType: "tool_definition",
      entityId: tool.id,
      details: {
        name: tool.name,
        adapterType: tool.adapterType,
        enabled: tool.enabled,
      },
    });
    res.status(201).json(tool);
  });

  router.patch("/companies/:companyId/tools/:toolId", validate(updateToolDefinitionSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const toolId = req.params.toolId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const existing = await requireCompanyTool(db, companyId, toolId);
    const detachesSourceOwnership =
      existing.adapterConfig.source === "tool-registry"
      && (req.body.adapterType === "http" || req.body.adapterType === "mcp")
      && Boolean(req.body.adapterConfig)
      && req.body.adapterConfig.source === undefined;
    if (!detachesSourceOwnership) {
      assertMutableTool(existing);
    }
    let tool;
    try {
      tool = await toolService.updateDefinition(db, toolId, req.body);
    } catch (error) {
      throwToolNameConflict(error, req.body.name ?? existing.name);
    }
    if (!tool) {
      throw notFound("Tool not found");
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.tool_updated",
      entityType: "tool_definition",
      entityId: tool.id,
      details: {
        name: tool.name,
        adapterType: tool.adapterType,
        enabled: tool.enabled,
        changedKeys: Object.keys(req.body),
      },
    });
    res.json(tool);
  });

  router.delete("/companies/:companyId/tools/:toolId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const toolId = req.params.toolId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const existing = await requireCompanyTool(db, companyId, toolId);
    assertMutableTool(existing);
    const deleted = await toolService.deleteDefinition(db, toolId);
    if (!deleted) {
      throw notFound("Tool not found");
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.tool_deleted",
      entityType: "tool_definition",
      entityId: existing.id,
      details: {
        name: existing.name,
        adapterType: existing.adapterType,
      },
    });
    res.json({ ok: true });
  });

  return router;
}

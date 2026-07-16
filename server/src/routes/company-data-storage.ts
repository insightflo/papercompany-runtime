import express, { Router } from "express";
import type { Db } from "@paperclipai/db";
import { companyDataStorageConfigSchema } from "@paperclipai/shared/validators/company-data-storage";
import { z } from "zod";
import { badRequest } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { secretService } from "../services/secrets.js";
import {
  createCompanyDataStorageService,
  type CompanyDataStorageService,
  type CompanyDataStorageTestResult,
} from "../services/company-data-storage.js";
import {
  createCompanyDataObjectService,
  normalizeObjectKey,
  normalizePrefix,
  type CompanyDataObjectService,
} from "../services/company-data-objects.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export interface CompanyDataStorageRouteOptions {
  storageService?: CompanyDataStorageService;
  objectService?: CompanyDataObjectService;
}

function hasConnectionTestBody(body: unknown) {
  if (body === undefined || body === null) return false;
  return !(
    typeof body === "object" &&
    !Array.isArray(body) &&
    Object.keys(body).length === 0
  );
}

function parseLimit(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1000;
  return Math.min(Math.trunc(n), 1000);
}
const companyIdSchema = z.string().uuid();
const ACTIVE_DOWNLOAD_TYPES = new Set([
  "application/javascript",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/html",
  "text/javascript",
]);

function requireCompanyId(value: unknown): string {
  const parsed = companyIdSchema.safeParse(value);
  if (!parsed.success) throw badRequest("Invalid company ID");
  return parsed.data;
}

function safeDownloadContentType(contentType?: string): string {
  if (!contentType) return "application/octet-stream";
  const baseType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return baseType && ACTIVE_DOWNLOAD_TYPES.has(baseType)
    ? "application/octet-stream"
    : contentType;
}

export function companyDataStorageRoutes(
  db: Db,
  options: CompanyDataStorageRouteOptions = {},
) {
  const router = Router();
  const storageService = options.storageService ?? createCompanyDataStorageService(db);
  const objectService = options.objectService ?? createCompanyDataObjectService(db, {
    storageService,
    resolveSecretValue: (companyId, secretId) => secretService(db).resolveSecretValue(companyId, secretId, "latest"),
  });

  // --- Configuration (board only) ---

  router.get("/companies/:companyId/data-storage", async (req, res) => {
    assertBoard(req);
    const companyId = requireCompanyId(req.params.companyId);
    assertCompanyAccess(req, companyId);
    res.json(await storageService.get(companyId));
  });

  router.put(
    "/companies/:companyId/data-storage",
    validate(companyDataStorageConfigSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = requireCompanyId(req.params.companyId);
      assertCompanyAccess(req, companyId);
      const saved = await storageService.save(companyId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "data_storage.updated",
        entityType: "data_storage",
        entityId: companyId,
        details: { provider: saved.provider },
      });
      res.json(saved);
    },
  );

  router.post("/companies/:companyId/data-storage/test", async (req, res) => {
    assertBoard(req);
    const companyId = requireCompanyId(req.params.companyId);
    assertCompanyAccess(req, companyId);
    if (hasConnectionTestBody(req.body)) {
      throw badRequest("Connection tests do not accept a request body");
    }
    const result: CompanyDataStorageTestResult = await storageService.testConnection(companyId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "data_storage.connection_tested",
      entityType: "data_storage",
      entityId: companyId,
      details: { provider: result.provider, ok: result.ok },
    });
    res.json(result);
  });

  // --- Object API (company-authorized: board + agents of the company) ---

  router.get("/companies/:companyId/data/objects", async (req, res) => {
    const companyId = requireCompanyId(req.params.companyId);
    assertCompanyAccess(req, companyId);
    const rawKey = typeof req.query.key === "string" ? req.query.key : undefined;
    const key = rawKey ? normalizeObjectKey(rawKey) : undefined;

    if (key) {
      const result = await objectService.readObject(companyId, key);
      res.setHeader("Content-Type", safeDownloadContentType(result.contentType));
      res.setHeader("Content-Length", String(result.size));
      res.setHeader("Content-Disposition", "attachment");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Papercompany-Key", key);
      if (result.etag) res.setHeader("ETag", result.etag);
      if (result.lastModified) res.setHeader("Last-Modified", result.lastModified);
      result.stream.pipe(res);
      return;
    }

    const prefix = typeof req.query.prefix === "string" ? normalizePrefix(req.query.prefix) : undefined;
    const limit = parseLimit(req.query.limit);
    const result = await objectService.listObjects(companyId, { prefix, limit });
    res.json(result);
  });

  router.put("/companies/:companyId/data/objects", express.raw({ type: "*/*", limit: "50mb" }), async (req, res) => {
    const companyId = requireCompanyId(req.params.companyId);
    assertCompanyAccess(req, companyId);
    const rawKey = typeof req.query.key === "string" ? req.query.key : undefined;
    if (!rawKey) throw badRequest("A ?key= query parameter is required to write an object");
    const key = normalizeObjectKey(rawKey);

    const body = (req as unknown as { rawBody?: Buffer }).rawBody
      ?? (Buffer.isBuffer(req.body)
        ? req.body
        : req.body === undefined || req.body === null
          ? Buffer.alloc(0)
          : Buffer.from(JSON.stringify(req.body)));
    if (body.length === 0) throw badRequest("Object body must not be empty");

    const contentType = req.get("Content-Type");
    const result = await objectService.writeObject(companyId, key, body, contentType);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "data_object.written",
      entityType: "data_object",
      entityId: result.key,
      details: { key: result.key, size: result.size, contentType: result.contentType },
    });
    res.status(201).json(result);
  });

  return router;
}

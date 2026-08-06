/**
 * @fileoverview missionSearch — a scope-enforced discovery API.
 *
 * Agents (e.g. codex_local) invoke this API via the runtime brief's curl recipe using
 * `$PAPERCLIP_API_URL` + `$PAPERCLIP_API_KEY`. The server enforces that only the
 * run's allowed search scopes (from the issue execution card) are honored, then
 * performs discovery per scope so the agent never needs pathless rg/find.
 *
 * The per-scope discovery logic lives in `services/mission-search.ts`
 * (`searchMissionScope`); this module is a thin auth/validation wrapper.
 *
 * Auth mirrors POST /plugins/tools/execute: the caller's runContext must match
 * their actor (agent can only query their own run), assertCompanyAccess gates the
 * company, and the heartbeat run row is loaded + ownership-checked.
 *
 * @module server/routes/mission-search
 */

import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import {
  MISSION_SEARCH_SCOPES,
  type MissionSearchScope,
} from "../services/runtime-search-scopes.js";
import {
  buildRuntimeSearchPathPermissions,
  type RuntimeSearchPathPermissions,
} from "../services/runtime-search-path-permissions.js";
import { searchMissionScope } from "../services/mission-search.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface MissionSearchRunContext {
  agentId?: unknown;
  runId?: unknown;
  companyId?: unknown;
}

interface MissionSearchRequestBody {
  scope?: unknown;
  query?: unknown;
  pattern?: unknown;
  limit?: unknown;
  runContext?: unknown;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPermissionsFromContext(contextSnapshot: unknown): RuntimeSearchPathPermissions | null {
  const ctx = isRecord(contextSnapshot) ? contextSnapshot : null;
  const raw = ctx ? ctx.paperclipRuntimeSearchPaths : undefined;
  if (!isRecord(raw) || raw.version !== 1) return null;
  const workingDirectory = readString(raw.workingDirectory);
  if (!workingDirectory) return null;
  return {
    version: 1,
    workingDirectory,
    outputDirectory: readString(raw.outputDirectory) ?? null,
    dependencyFiles: Array.isArray(raw.dependencyFiles) ? raw.dependencyFiles.filter((v): v is string => typeof v === "string") : [],
    dependencyDirectories: Array.isArray(raw.dependencyDirectories) ? raw.dependencyDirectories.filter((v): v is string => typeof v === "string") : [],
    allowedSearchScopes: Array.isArray(raw.allowedSearchScopes) ? raw.allowedSearchScopes.filter((v): v is string => typeof v === "string") : [],
    broadScanRepoAllowed: typeof raw.broadScanRepoAllowed === "boolean" ? raw.broadScanRepoAllowed : false,
    qaType: readString(raw.qaType) ?? null,
    qaInputScope: readString(raw.qaInputScope) ?? null,
  };
}

function readWorkingDirectoryFromContext(contextSnapshot: unknown): string | null {
  const ctx = isRecord(contextSnapshot) ? contextSnapshot : null;
  const workspace = ctx ? ctx.paperclipWorkspace : undefined;
  return isRecord(workspace) ? (readString(workspace.cwd) ?? null) : null;
}

/** Build the missionSearch router. Mounted under /api by app.ts. */
export function missionSearchRoutes(db: Db): Router {
  const router = Router();

  /**
   * POST /api/agents/me/mission-search
   *
   * Body: { scope, query?, pattern?, limit?, runContext: { agentId, runId, companyId } }
   * Response: { scope, query, allowed: true, result: ScopeResult }
   * Errors: 400 validation, 403 scope-not-allowed / wrong agent, 404 run not found.
   */
  router.post("/agents/me/mission-search", async (req, res) => {
    const body = req.body as MissionSearchRequestBody | undefined;
    if (!body) {
      res.status(400).json({ error: "Request body is required" });
      return;
    }

    const scopeRaw = readString(body.scope);
    if (!scopeRaw || !(MISSION_SEARCH_SCOPES as readonly string[]).includes(scopeRaw)) {
      res.status(400).json({
        error: `"scope" is required and must be one of: ${MISSION_SEARCH_SCOPES.join(", ")}`,
      });
      return;
    }
    const scope = scopeRaw as MissionSearchScope;

    const runContext = isRecord(body.runContext) ? (body.runContext as MissionSearchRunContext) : null;
    if (!runContext || !runContext.agentId || !runContext.runId || !runContext.companyId) {
      res.status(400).json({ error: '"runContext" must include agentId, runId, and companyId' });
      return;
    }

    assertCompanyAccess(req, String(runContext.companyId));
    if (req.actor.type !== "agent") {
      assertBoard(req);
    } else if (req.actor.agentId !== runContext.agentId || req.actor.companyId !== runContext.companyId) {
      res.status(403).json({ error: "Agent can only missionSearch within its own run context" });
      return;
    }

    const run = await db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        companyId: heartbeatRuns.companyId,
        issueId: heartbeatRuns.issueId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, String(runContext.runId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!run || run.agentId !== String(runContext.agentId) || run.companyId !== String(runContext.companyId)) {
      res.status(404).json({ error: "Run not found for the given context" });
      return;
    }

    // Prefer the permissions already resolved for the run (authoritative); rebuild as fallback.
    let permissions = readPermissionsFromContext(run.contextSnapshot);
    if (!permissions) {
      const workingDirectory = readWorkingDirectoryFromContext(run.contextSnapshot);
      if (workingDirectory && run.issueId) {
        permissions = await buildRuntimeSearchPathPermissions({
          db,
          companyId: String(runContext.companyId),
          issueId: run.issueId,
          workingDirectory,
        });
      }
    }

    if (!permissions) {
      res.status(409).json({
        error: "No mission search permissions resolved for this run",
        guidance: "Ensure the mission has an issue execution card with a tool permission contract.",
      });
      return;
    }

    const allowedScopes = permissions.allowedSearchScopes;
    if (!allowedScopes.includes(scope)) {
      res.status(403).json({
        error: `Scope "${scope}" is not allowed for this run`,
        allowedScopes,
        guidance: `Use one of the allowed scopes: ${allowedScopes.join(", ")}. Raw pathless rg/find is blocked by the runtime guard.`,
      });
      return;
    }

    const query = readString(body.query) ?? readString(body.pattern) ?? "";
    const limit = Math.min(Math.max(readNumber(body.limit) ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    try {
      const result = await searchMissionScope(db, scope, query, limit, run.id, permissions);
      res.json({ scope, query, allowed: true, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `missionSearch failed: ${message}` });
    }
  });

  return router;
}

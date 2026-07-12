/**
 * @fileoverview missionSearch — a real, scope-enforced discovery tool.
 *
 * Agents (e.g. codex_local) invoke this via the runtime brief's curl recipe using
 * `$PAPERCLIP_API_URL` + `$PAPERCLIP_API_KEY`. The server enforces that only the
 * run's allowed search scopes (from the issue execution card) are honored, then
 * performs discovery per scope so the agent never needs pathless rg/find.
 *
 * Auth mirrors POST /plugins/tools/execute: the caller's runContext must match
 * their actor (agent can only query their own run), assertCompanyAccess gates the
 * company, and the heartbeat run row is loaded + ownership-checked.
 *
 * @module server/routes/mission-search
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { Router } from "express";
import { eq, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import {
  MISSION_SEARCH_SCOPES,
  type MissionSearchScope,
} from "../services/runtime-search-scopes.js";
import {
  buildRuntimeSearchPathPermissions,
  type RuntimeSearchPathPermissions,
} from "../services/runtime-search-path-permissions.js";

const execFileP = promisify(execFile);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const REPO_SEARCH_TIMEOUT_MS = 5_000;

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

type ScopeResult =
  | { scope: "workProduct"; files: string[]; directories: string[] }
  | { scope: "missionOutput"; directory: string | null; files: string[] }
  | { scope: "repo"; root: string; matches: Array<{ path: string; line: number; text: string }> }
  | { scope: "logs"; events: unknown[] }
  | { scope: "config"; note: string; files: string[] };

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
      const result = await runScopedDiscovery(db, scope, query, limit, run.id, permissions);
      res.json({ scope, query, allowed: true, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `missionSearch failed: ${message}` });
    }
  });

  return router;
}

/** Filename scopes (workProduct, missionOutput) OR-match whitespace-separated query tokens; empty query matches all (discovery). */
function matchesQueryTokens(query: string, haystack: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const lower = haystack.toLowerCase();
  return tokens.some((token) => lower.includes(token));
}

async function runScopedDiscovery(
  db: Db,
  scope: MissionSearchScope,
  query: string,
  limit: number,
  runId: string,
  permissions: RuntimeSearchPathPermissions,
): Promise<ScopeResult> {
  switch (scope) {
    case "workProduct": {
      const files = permissions.dependencyFiles.filter((f) => matchesQueryTokens(query, f)).slice(0, limit);
      const directories = permissions.dependencyDirectories.slice(0, limit);
      return { scope: "workProduct", files, directories };
    }
    case "missionOutput": {
      const files: string[] = [];
      if (permissions.outputDirectory) {
        const { readdirSync } = await import("node:fs");
        try {
          for (const entry of readdirSync(permissions.outputDirectory, { withFileTypes: true })) {
            if (entry.isFile()) {
              const full = path.join(permissions.outputDirectory, entry.name);
              if (matchesQueryTokens(query, full)) files.push(full);
            }
          }
        } catch {
          // directory missing/unreadable — return empty
        }
      }
      return { scope: "missionOutput", directory: permissions.outputDirectory, files: files.slice(0, limit) };
    }
    case "repo": {
      const matches = await searchRepo(permissions.workingDirectory, query, limit);
      return { scope: "repo", root: permissions.workingDirectory, matches };
    }
    case "logs": {
      const rows = await db
        .select({
          seq: heartbeatRunEvents.seq,
          eventType: heartbeatRunEvents.eventType,
          stream: heartbeatRunEvents.stream,
          level: heartbeatRunEvents.level,
          message: heartbeatRunEvents.message,
          createdAt: heartbeatRunEvents.createdAt,
        })
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, runId))
        .orderBy(desc(heartbeatRunEvents.seq))
        .limit(limit);
      const want = query.toLowerCase();
      const events = want ? rows.filter((r) => typeof r.message === "string" && r.message.toLowerCase().includes(want)) : rows;
      return { scope: "logs", events };
    }
    case "config": {
      const files = permissions.dependencyFiles.filter((f) => /\b(config|\.env|settings|manifest)\b/i.test(f)).slice(0, limit);
      return { scope: "config", note: "No dedicated config root resolved; returning config-like declared paths.", files };
    }
    default:
      throw new Error(`Unsupported scope: ${scope}`);
  }
}

/** Cap'd, argument-safe ripgrep over the repo working directory (repo scope only). */
async function searchRepo(root: string, query: string, limit: number): Promise<Array<{ path: string; line: number; text: string }>> {
  const needle = query.trim();
  if (!needle) return [];
  try {
    const { stdout } = await execFileP(
      "rg",
      ["-n", "--max-count", String(limit), "-S", "--", needle, root],
      { timeout: REPO_SEARCH_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
    );
    const matches: Array<{ path: string; line: number; text: string }> = [];
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const idx = line.indexOf(":");
      const second = line.indexOf(":", idx + 1);
      if (idx === -1 || second === -1) continue;
      matches.push({ path: line.slice(0, idx), line: Number(line.slice(idx + 1, second)), text: line.slice(second + 1) });
      if (matches.length >= limit) break;
    }
    return matches;
  } catch {
    // rg exits 1 for no matches; timeouts/unavailable also surface as empty rather than failing the tool.
    return [];
  }
}

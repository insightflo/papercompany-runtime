/**
 * @fileoverview missionSearch discovery logic, extracted as a pure service so the
 * runtime broad-scan hook can perform scoped discovery WITHOUT an HTTP round-trip.
 *
 * The route (`server/src/routes/mission-search.ts`) keeps auth/validation and
 * delegates the per-scope discovery to `searchMissionScope` below.
 *
 * @module server/services/mission-search
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { eq, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents } from "@paperclipai/db";
import type { MissionSearchScope } from "./runtime-search-scopes.js";
import type { RuntimeSearchPathPermissions } from "./runtime-search-path-permissions.js";

const execFileP = promisify(execFile);
const REPO_SEARCH_TIMEOUT_MS = 5_000;

export type ScopeResult =
  | { scope: "workProduct"; files: string[]; directories: string[] }
  | { scope: "missionOutput"; directory: string | null; files: string[] }
  | { scope: "repo"; root: string; matches: Array<{ path: string; line: number; text: string }> }
  | { scope: "logs"; events: unknown[] }
  | { scope: "config"; note: string; files: string[] };

/** Filename scopes (workProduct, missionOutput) OR-match whitespace-separated query tokens; empty query matches all (discovery). */
function matchesQueryTokens(query: string, haystack: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const lower = haystack.toLowerCase();
  return tokens.some((token) => lower.includes(token));
}

/**
 * Per-scope discovery. Pure over the resolved permissions — no auth, no HTTP.
 * Used by the missionSearch route AND the runtime broad-scan hook.
 */
export async function searchMissionScope(
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

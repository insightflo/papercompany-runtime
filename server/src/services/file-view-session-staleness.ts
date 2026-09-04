import { and, desc, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { parseObject } from "../adapters/utils.js";
import { evaluateFileViewFreshness } from "./context-safe-file-views.js";

/**
 * Rotation reason recorded on context.paperclipSessionRotationReason when a
 * resumed session is rotated because its recorded file views no longer match
 * the workspace. Machine-generated constant, never parsed from agent prose.
 */
export const FILE_VIEW_STALENESS_ROTATION_REASON = "file_view_stale";

export interface FileViewStalenessRotationPolicy {
  enabled: boolean;
}

export interface SessionFileStalenessInput {
  agentId: string;
  resumedSessionId: string | null;
  currentRunId: string;
  fallbackWorkspaceCwd: string | null;
}

export interface SessionFileStalenessResult {
  rotate: boolean;
  staleFiles: Array<{ relativePath: string; status: string }>;
  reason: string | null;
}

/**
 * Parse runtimeConfig.heartbeat.fileViewStalenessRotation. The gate defaults to
 * enabled when the config object is absent; only an explicit enabled:false
 * disables it. Never throws on malformed config.
 */
export function parseFileViewStalenessRotationPolicy(
  runtimeConfig: unknown,
): FileViewStalenessRotationPolicy {
  const runtime = parseObject(runtimeConfig);
  const heartbeat = parseObject(runtime.heartbeat);
  const raw = parseObject(heartbeat.fileViewStalenessRotation);
  if (Object.keys(raw).length === 0) return { enabled: true };
  return { enabled: raw.enabled !== false };
}

/**
 * Decide whether resuming `resumedSessionId` would execute on stale memory.
 *
 * Reads the most recent OTHER heartbeat run for this agent that recorded the
 * same session id (sessionIdAfter), extracts that run's context snapshot file
 * views (paperclipFileViews) and workspace cwd (paperclipWorkspace.cwd), and
 * re-evaluates freshness against the current workspace via
 * evaluateFileViewFreshness. Only machine-generated content fingerprints are
 * compared. Rotation is warranted only for "stale" or "missing" verdicts;
 * "created"/"unknown"/"invalid_path"/"current" never rotate.
 *
 * Read-only: never throws on malformed snapshots, never mutates state.
 */
export async function evaluateSessionFileStaleness(
  db: Db,
  input: SessionFileStalenessInput,
): Promise<SessionFileStalenessResult> {
  const noRotation: SessionFileStalenessResult = { rotate: false, staleFiles: [], reason: null };
  const resumedSessionId = input.resumedSessionId?.trim() ?? "";
  if (!resumedSessionId) return noRotation;

  const previousRun = await db
    .select({
      id: heartbeatRuns.id,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.agentId, input.agentId),
        eq(heartbeatRuns.sessionIdAfter, resumedSessionId),
        ne(heartbeatRuns.id, input.currentRunId),
      ),
    )
    .orderBy(desc(heartbeatRuns.startedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!previousRun) return noRotation;

  const snapshot = parseObject(previousRun.contextSnapshot);
  const views = Array.isArray(snapshot.paperclipFileViews) ? snapshot.paperclipFileViews : [];
  if (views.length === 0) return noRotation;

  const workspace = parseObject(snapshot.paperclipWorkspace);
  const snapshotCwd =
    typeof workspace.cwd === "string" && workspace.cwd.trim().length > 0 ? workspace.cwd : null;
  const workspaceCwd = snapshotCwd ?? input.fallbackWorkspaceCwd;

  const freshness = await evaluateFileViewFreshness({ views, workspaceCwd });
  const staleFiles = freshness
    .filter((entry) => entry.status === "stale" || entry.status === "missing")
    .map((entry) => ({ relativePath: entry.relativePath, status: entry.status as string }));
  if (staleFiles.length === 0) return noRotation;

  const summary = staleFiles.map((entry) => `${entry.relativePath} (${entry.status})`).join(", ");
  return {
    rotate: true,
    staleFiles,
    reason: `Files changed since the last run in this session: ${summary}`,
  };
}

/**
 * @fileoverview Plugin diagnostics routes: health checks and log queries.
 *
 * Extracted from routes/plugins.ts (runtime large-file refactoring, Slice 2).
 * URL paths, JSON shapes, status codes, board authorization, the query-param
 * filtering/clamping for logs, and the worker-reported health RPC (via the
 * shared `computePluginHealth` closure) are preserved exactly. The composition
 * facade `pluginRoutes(...)` calls `registerPluginDiagnosticsRoutes(router, ctx)`.
 *
 * @module server/routes/plugin-diagnostics-routes
 */

import type { Router } from "express";
import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pluginLogs } from "@paperclipai/db";
import type { pluginRegistryService } from "../services/plugin-registry.js";
import { assertBoard } from "./authz.js";

type PluginRegistryService = ReturnType<typeof pluginRegistryService>;
type PluginRecord = Awaited<ReturnType<PluginRegistryService["getById"]>>;

/** Response body for GET /api/plugins/:pluginId/health */
interface PluginHealthCheckResult {
  pluginId: string;
  status: string;
  healthy: boolean;
  checks: Array<{
    name: string;
    passed: boolean;
    message?: string;
  }>;
  lastError?: string;
}

/**
 * Dependencies injected by `pluginRoutes(...)`. `computePluginHealth` stays
 * defined in plugins.ts (the dashboard route also uses it) and is passed by
 * reference, so its worker-RPC behavior is unchanged.
 */
export interface PluginDiagnosticsRouteContext {
  registry: PluginRegistryService;
  db: Db;
  resolvePlugin: (
    registry: PluginRegistryService,
    pluginId: string,
  ) => Promise<PluginRecord | null>;
  computePluginHealth: (plugin: {
    id: string;
    status: string;
    manifestJson: { id?: string } | null;
    lastError: string | null;
  }) => Promise<PluginHealthCheckResult>;
}

/**
 * Register plugin diagnostics routes on the given router. Called by
 * `pluginRoutes(...)`. Registered in the same position these handlers occupied
 * before extraction.
 */
export function registerPluginDiagnosticsRoutes(
  router: Router,
  ctx: PluginDiagnosticsRouteContext,
): void {
  const { registry, db, resolvePlugin, computePluginHealth } = ctx;

  /**
   * GET /api/plugins/:pluginId/health
   *
   * Run health diagnostics on a plugin.
   *
   * Performs the following checks:
   * 1. Registry: Plugin is registered in the database
   * 2. Manifest: Manifest is valid and parseable
   * 3. Status: Plugin is in 'ready' state
   * 4. Error state: Plugin has no unhandled errors
   *
   * Response: PluginHealthCheckResult
   * Errors: 404 if plugin not found
   */
  router.get("/plugins/:pluginId/health", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const result = await computePluginHealth(plugin);
    res.json(result);
  });

  /**
   * GET /api/plugins/:pluginId/logs
   *
   * Query recent log entries for a plugin.
   *
   * Query params:
   * - limit: Maximum number of entries (default 25, max 500)
   * - level: Filter by log level (info, warn, error, debug)
   * - since: ISO timestamp to filter logs newer than this time
   *
   * Response: Array of log entries, newest first.
   */
  router.get("/plugins/:pluginId/logs", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 25, 1), 500);
    const level = req.query.level as string | undefined;
    const since = req.query.since as string | undefined;

    const conditions = [eq(pluginLogs.pluginId, plugin.id)];
    if (level) {
      conditions.push(eq(pluginLogs.level, level));
    }
    if (since) {
      const sinceDate = new Date(since);
      if (!isNaN(sinceDate.getTime())) {
        conditions.push(gte(pluginLogs.createdAt, sinceDate));
      }
    }

    const rows = await db
      .select()
      .from(pluginLogs)
      .where(and(...conditions))
      .orderBy(desc(pluginLogs.createdAt))
      .limit(limit);

    res.json(rows);
  });
}

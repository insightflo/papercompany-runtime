/**
 * @fileoverview Plugin lifecycle routes: get, uninstall, enable, disable, upgrade.
 *
 * Extracted from routes/plugins.ts (runtime large-file refactoring, Slice 2).
 * URL paths, JSON shapes, status codes, board authorization, activity-log writes,
 * and `plugin.ui.updated` live events are preserved exactly. The composition
 * facade `pluginRoutes(...)` calls `registerPluginLifecycleRoutes(router, ctx)`
 * so server/src/app.ts, the public mount, and all behavior stay unchanged.
 *
 * @module server/routes/plugin-lifecycle-routes
 */

import type { Router, Request } from "express";
import type { pluginRegistryService } from "../services/plugin-registry.js";
import type { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { assertBoard } from "./authz.js";
import { publishGlobalLiveEvent } from "../services/live-events.js";

type PluginRegistryService = ReturnType<typeof pluginRegistryService>;
type PluginRecord = Awaited<ReturnType<PluginRegistryService["getById"]>>;

/**
 * Dependencies injected by `pluginRoutes(...)`. The shared closures
 * (`logPluginMutationActivity`) and helpers (`resolvePlugin`) stay defined in
 * plugins.ts (other handlers still use them) and are passed by reference, so
 * nothing moves and no behavior changes.
 */
export interface PluginLifecycleRouteContext {
  registry: PluginRegistryService;
  lifecycle: ReturnType<typeof pluginLifecycleManager>;
  /** bridgeDeps.workerManager from the factory, if a bridge is wired. */
  workerManager?: PluginWorkerManager;
  resolvePlugin: (
    registry: PluginRegistryService,
    pluginId: string,
  ) => Promise<PluginRecord | null>;
  logPluginMutationActivity: (
    req: Request,
    action: string,
    entityId: string,
    details: Record<string, unknown>,
  ) => Promise<void>;
}

/**
 * Register plugin lifecycle routes on the given router. Called by
 * `pluginRoutes(...)` after the shared registry/lifecycle/closures are
 * constructed. Registered after static and bridge routes and before jobs, in
 * the same position these handlers occupied before extraction.
 */
export function registerPluginLifecycleRoutes(
  router: Router,
  ctx: PluginLifecycleRouteContext,
): void {
  const { registry, lifecycle, workerManager, resolvePlugin, logPluginMutationActivity } = ctx;

  router.get("/plugins/:pluginId", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    // Enrich with worker capabilities when available
    const worker = workerManager?.getWorker(plugin.id);
    const supportsConfigTest = worker
      ? worker.supportedMethods.includes("validateConfig")
      : false;

    res.json({ ...plugin, supportsConfigTest });
  });

  /**
   * DELETE /api/plugins/:pluginId
   *
   * Uninstall a plugin.
   *
   * Query params:
   * - purge: If "true", permanently delete all plugin data (hard delete)
   *          Otherwise, soft-delete with 30-day data retention
   *
   * Response: PluginRecord (the deleted record)
   * Errors: 404 if plugin not found, 400 for lifecycle errors
   */
  router.delete("/plugins/:pluginId", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;
    const purge = req.query.purge === "true";

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    try {
      const result = await lifecycle.unload(plugin.id, purge);
      await logPluginMutationActivity(req, "plugin.uninstalled", plugin.id, {
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        purge,
      });
      publishGlobalLiveEvent({ type: "plugin.ui.updated", payload: { pluginId: plugin.id, action: "uninstalled" } });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  /**
   * POST /api/plugins/:pluginId/enable
   *
   * Enable a plugin that is currently disabled or in error state.
   *
   * Transitions the plugin to 'ready' state after loading and validation.
   *
   * Response: PluginRecord
   * Errors: 404 if plugin not found, 400 for lifecycle errors
   */
  router.post("/plugins/:pluginId/enable", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    try {
      const result = await lifecycle.enable(plugin.id);
      await logPluginMutationActivity(req, "plugin.enabled", plugin.id, {
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        version: result?.version ?? plugin.version,
      });
      publishGlobalLiveEvent({ type: "plugin.ui.updated", payload: { pluginId: plugin.id, action: "enabled" } });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  /**
   * POST /api/plugins/:pluginId/disable
   *
   * Disable a running plugin.
   *
   * Request body (optional):
   * - reason: Human-readable reason for disabling
   *
   * The plugin transitions to 'installed' state and stops processing events.
   *
   * Response: PluginRecord
   * Errors: 404 if plugin not found, 400 for lifecycle errors
   */
  router.post("/plugins/:pluginId/disable", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;
    const body = req.body as { reason?: string } | undefined;
    const reason = body?.reason;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    try {
      const result = await lifecycle.disable(plugin.id, reason);
      await logPluginMutationActivity(req, "plugin.disabled", plugin.id, {
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        reason: reason ?? null,
      });
      publishGlobalLiveEvent({ type: "plugin.ui.updated", payload: { pluginId: plugin.id, action: "disabled" } });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  /**
   * POST /api/plugins/:pluginId/upgrade
   *
   * Upgrade a plugin to a newer version.
   *
   * Request body (optional):
   * - version: Target version (defaults to latest)
   *
   * If the upgrade adds new capabilities, the plugin transitions to
   * 'upgrade_pending' state for board approval. Otherwise, it goes
   * directly to 'ready'.
   *
   * Response: PluginRecord
   * Errors: 404 if plugin not found, 400 for lifecycle errors
   */
  router.post("/plugins/:pluginId/upgrade", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;
    const body = req.body as { version?: string } | undefined;
    const version = body?.version;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    try {
      // Upgrade the plugin - this would typically:
      // 1. Download the new version
      // 2. Compare capabilities
      // 3. If new capabilities, mark as upgrade_pending
      // 4. Otherwise, transition to ready
      const result = await lifecycle.upgrade(plugin.id, version);
      await logPluginMutationActivity(req, "plugin.upgraded", plugin.id, {
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        previousVersion: plugin.version,
        version: result?.version ?? plugin.version,
        targetVersion: version ?? null,
      });
      publishGlobalLiveEvent({ type: "plugin.ui.updated", payload: { pluginId: plugin.id, action: "upgraded" } });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });
}

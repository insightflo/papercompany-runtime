/**
 * @fileoverview Plugin configuration routes: get, save (with worker notify), and test.
 *
 * Extracted from routes/plugins.ts (Slice 2). Preserved exactly: URL paths, JSON
 * shapes, status codes (400/404/501/502), board auth, instance-config validation,
 * devUiUrl instance-admin stripping (SSRF guard), worker `configChanged` RPC with
 * METHOD_NOT_IMPLEMENTED -> restartWorker fallback, and config/test error mapping.
 * The facade `pluginRoutes(...)` calls `registerPluginConfigRoutes(router, ctx)`.
 */

import type { Router, Request } from "express";
import type { pluginRegistryService } from "../services/plugin-registry.js";
import type { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { validateInstanceConfig } from "../services/plugin-config-validator.js";
import { assertBoard } from "./authz.js";

type PluginRegistryService = ReturnType<typeof pluginRegistryService>;
type PluginRecord = Awaited<ReturnType<PluginRegistryService["getById"]>>;

/**
 * Dependencies injected by `pluginRoutes(...)`. `workerManager` is
 * `bridgeDeps.workerManager` from the factory (undefined when no bridge is
 * wired, which preserves the original `if (!bridgeDeps)` 501 semantics —
 * PluginRouteBridgeDeps.workerManager is a required field). The shared closures
 * (`logPluginMutationActivity`, `mapRpcErrorToBridgeError`) stay in plugins.ts
 * (bridge handlers still use the latter) and are passed by reference.
 */
export interface PluginConfigRouteContext {
  registry: PluginRegistryService;
  lifecycle: ReturnType<typeof pluginLifecycleManager>;
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
  mapRpcErrorToBridgeError: (err: unknown) => {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Register plugin configuration routes on the given router. Called by
 * `pluginRoutes(...)`. Registered after lifecycle/diagnostics routes and
 * before jobs, in the same position these handlers occupied before extraction.
 */
export function registerPluginConfigRoutes(
  router: Router,
  ctx: PluginConfigRouteContext,
): void {
  const {
    registry,
    lifecycle,
    workerManager,
    resolvePlugin,
    logPluginMutationActivity,
    mapRpcErrorToBridgeError,
  } = ctx;

  /**
   * GET /api/plugins/:pluginId/config
   *
   * Retrieve the current instance configuration for a plugin.
   *
   * Returns the `PluginConfig` record if one exists, or `null` if the plugin
   * has not yet been configured.
   *
   * Response: `PluginConfig | null`
   * Errors: 404 if plugin not found
   */
  router.get("/plugins/:pluginId/config", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const config = await registry.getConfig(plugin.id);
    res.json(config);
  });

  /**
   * POST /api/plugins/:pluginId/config
   *
   * Save (create or replace) the instance configuration for a plugin.
   *
   * The caller provides the full `configJson` object. The server persists it
   * via `registry.upsertConfig()`.
   *
   * Request body:
   * - `configJson`: Configuration values matching the plugin's `instanceConfigSchema`
   *
   * Response: `PluginConfig`
   * Errors:
   * - 400 if request validation fails
   * - 404 if plugin not found
   */
  router.post("/plugins/:pluginId/config", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const body = req.body as { configJson?: Record<string, unknown> } | undefined;
    if (!body?.configJson || typeof body.configJson !== "object") {
      res.status(400).json({ error: '"configJson" is required and must be an object' });
      return;
    }

    // Strip devUiUrl unless the caller is an instance admin. devUiUrl activates
    // a dev-proxy in the static file route that could be abused for SSRF if any
    // board-level user were allowed to set it.
    if (
      "devUiUrl" in body.configJson &&
      !(req.actor.type === "board" && req.actor.isInstanceAdmin)
    ) {
      delete body.configJson.devUiUrl;
    }

    // Validate configJson against the plugin's instanceConfigSchema (if declared).
    // This ensures CLI/API callers get the same validation the UI performs client-side.
    const schema = plugin.manifestJson?.instanceConfigSchema;
    if (schema && Object.keys(schema).length > 0) {
      const validation = validateInstanceConfig(body.configJson, schema);
      if (!validation.valid) {
        res.status(400).json({
          error: "Configuration does not match the plugin's instanceConfigSchema",
          fieldErrors: validation.errors,
        });
        return;
      }
    }

    try {
      const result = await registry.upsertConfig(plugin.id, {
        configJson: body.configJson,
      });
      await logPluginMutationActivity(req, "plugin.config.updated", plugin.id, {
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        configKeyCount: Object.keys(body.configJson).length,
      });

      // Notify the running worker about the config change (PLUGIN_SPEC §25.4.4).
      // If the worker implements onConfigChanged, send the new config via RPC.
      // If it doesn't (METHOD_NOT_IMPLEMENTED), restart the worker so it picks
      // up the new config on re-initialize. If no worker is running, skip.
      if (workerManager?.isRunning(plugin.id)) {
        try {
          await workerManager.call(
            plugin.id,
            "configChanged",
            { config: body.configJson },
          );
        } catch (rpcErr) {
          if (
            rpcErr instanceof JsonRpcCallError &&
            rpcErr.code === PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED
          ) {
            // Worker doesn't handle live config — restart it.
            try {
              await lifecycle.restartWorker(plugin.id);
            } catch {
              // Restart failure is non-fatal for the config save response.
            }
          }
          // Other RPC errors (timeout, unavailable) are non-fatal — config is
          // already persisted and will take effect on next worker restart.
        }
      }

      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  /**
   * POST /api/plugins/:pluginId/config/test
   *
   * Test a plugin configuration without persisting it by calling the plugin
   * worker's `validateConfig` RPC method.
   *
   * Only works when the plugin's worker implements `onValidateConfig`.
   * If the worker does not implement the method, returns
   * `{ valid: false, supported: false, message: "..." }` with HTTP 200.
   *
   * Request body:
   * - `configJson`: Configuration values to validate
   *
   * Response: `{ valid: boolean; message?: string; supported?: boolean }`
   * Errors:
   * - 400 if request validation fails
   * - 404 if plugin not found
   * - 501 if bridge deps (worker manager) are not configured
   * - 502 if the worker is unavailable
   */
  router.post("/plugins/:pluginId/config/test", async (req, res) => {
    assertBoard(req);

    if (!workerManager) {
      res.status(501).json({ error: "Plugin bridge is not enabled" });
      return;
    }

    const { pluginId } = req.params;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    if (plugin.status !== "ready") {
      res.status(400).json({
        error: `Plugin is not ready (current status: ${plugin.status})`,
      });
      return;
    }

    const body = req.body as { configJson?: Record<string, unknown> } | undefined;
    if (!body?.configJson || typeof body.configJson !== "object") {
      res.status(400).json({ error: '"configJson" is required and must be an object' });
      return;
    }

    // Fast schema-level rejection before hitting the worker RPC.
    const schema = plugin.manifestJson?.instanceConfigSchema;
    if (schema && Object.keys(schema).length > 0) {
      const validation = validateInstanceConfig(body.configJson, schema);
      if (!validation.valid) {
        res.status(400).json({
          error: "Configuration does not match the plugin's instanceConfigSchema",
          fieldErrors: validation.errors,
        });
        return;
      }
    }

    try {
      const result = await workerManager.call(
        plugin.id,
        "validateConfig",
        { config: body.configJson },
      );

      // The worker returns PluginConfigValidationResult { ok, warnings?, errors? }
      // Map to the frontend-expected shape { valid, message? }
      if (result.ok) {
        const warningText = result.warnings?.length
          ? `Warnings: ${result.warnings.join("; ")}`
          : undefined;
        res.json({ valid: true, message: warningText });
      } else {
        const errorText = result.errors?.length
          ? result.errors.join("; ")
          : "Configuration validation failed.";
        res.json({ valid: false, message: errorText });
      }
    } catch (err) {
      // If the worker does not implement validateConfig, return a structured response
      if (
        err instanceof JsonRpcCallError &&
        err.code === PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED
      ) {
        res.json({
          valid: false,
          supported: false,
          message: "This plugin does not support configuration testing.",
        });
        return;
      }

      // Worker unavailable or other RPC errors
      const bridgeError = mapRpcErrorToBridgeError(err);
      res.status(502).json(bridgeError);
    }
  });
}

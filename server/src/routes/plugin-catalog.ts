/**
 * @fileoverview Plugin catalog read-only routes: listing, examples, UI contributions.
 *
 * Extracted from routes/plugins.ts as a focused, low-risk slice (runtime large-file
 * refactoring, Slice 1). URL paths, JSON shapes, authorization (assertBoard), error
 * codes, and plugin ordering are preserved exactly. The composition facade
 * `pluginRoutes(...)` in routes/plugins.ts calls `registerPluginCatalogRoutes(router,
 * registry)` so server/src/app.ts and existing tests keep their import path and mount.
 *
 * Static routes are registered before any parameterized `:pluginId` route so Express
 * does not match "examples" or "ui-contributions" as a plugin id.
 *
 * @module server/routes/plugin-catalog
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Router } from "express";
import type { PluginStatus, PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { PLUGIN_STATUSES } from "@paperclipai/shared";
import { isCoreIntegratedPluginKey } from "../services/core-integrated-plugins.js";
import { getPluginUiContributionMetadata } from "../services/plugin-loader.js";
import type { pluginRegistryService } from "../services/plugin-registry.js";
import { assertBoard } from "./authz.js";

/** UI slot declaration extracted from plugin manifest */
type PluginUiSlotDeclaration = NonNullable<NonNullable<PaperclipPluginManifestV1["ui"]>["slots"]>[number];
/** Launcher declaration extracted from plugin manifest */
type PluginLauncherDeclaration = NonNullable<PaperclipPluginManifestV1["launchers"]>[number];

/**
 * Normalized UI contribution for frontend slot host consumption.
 * Only includes plugins in 'ready' state with non-empty slot declarations.
 */
type PluginUiContribution = {
  pluginId: string;
  pluginKey: string;
  displayName: string;
  version: string;
  updatedAt: string;
  /**
   * Relative path within the plugin's UI directory to the entry module
   * (e.g. `"index.js"`). The frontend constructs the full import URL as
   * `/_plugins/${pluginId}/ui/${uiEntryFile}`.
   */
  uiEntryFile: string;
  slots: PluginUiSlotDeclaration[];
  launchers: PluginLauncherDeclaration[];
};

interface AvailablePluginExample {
  packageName: string;
  pluginKey: string;
  displayName: string;
  description: string;
  localPath: string;
  tag: "example";
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

const BUNDLED_PLUGIN_EXAMPLES: AvailablePluginExample[] = [
  {
    packageName: "@paperclipai/plugin-hello-world-example",
    pluginKey: "paperclip.hello-world-example",
    displayName: "Hello World Widget (Example)",
    description: "Reference UI plugin that adds a simple Hello World widget to the Paperclip dashboard.",
    localPath: "packages/plugins/examples/plugin-hello-world-example",
    tag: "example",
  },
  {
    packageName: "@paperclipai/plugin-file-browser-example",
    pluginKey: "paperclip-file-browser-example",
    displayName: "File Browser (Example)",
    description: "Example plugin that adds a Files link in project navigation plus a project detail file browser.",
    localPath: "packages/plugins/examples/plugin-file-browser-example",
    tag: "example",
  },
  {
    packageName: "@paperclipai/plugin-kitchen-sink-example",
    pluginKey: "paperclip-kitchen-sink-example",
    displayName: "Kitchen Sink (Example)",
    description: "Reference plugin that demonstrates the current Paperclip plugin API surface, bridge flows, UI extension surfaces, jobs, webhooks, tools, streams, and trusted local workspace/process demos.",
    localPath: "packages/plugins/examples/plugin-kitchen-sink-example",
    tag: "example",
  },
];

function listBundledPluginExamples(): AvailablePluginExample[] {
  return BUNDLED_PLUGIN_EXAMPLES.flatMap((plugin) => {
    const absoluteLocalPath = path.resolve(REPO_ROOT, plugin.localPath);
    if (!existsSync(absoluteLocalPath)) return [];
    return [{ ...plugin, localPath: absoluteLocalPath }];
  });
}

/**
 * Register the read-only plugin catalog routes on the given router.
 *
 * Called by `pluginRoutes(...)` in routes/plugins.ts after constructing the
 * shared `registry`, so the public factory signature, the app.ts mount, and all
 * HTTP paths (`GET /api/plugins`, `GET /api/plugins/examples`,
 * `GET /api/plugins/ui-contributions`) stay byte-identical.
 *
 * @param router - the shared plugin router (mounted under /api in app.ts)
 * @param registry - the already-constructed plugin registry service instance
 */
export function registerPluginCatalogRoutes(
  router: Router,
  registry: ReturnType<typeof pluginRegistryService>,
): void {
  /**
   * GET /api/plugins
   *
   * List all installed plugins, optionally filtered by lifecycle status.
   *
   * Query params:
   * - `status` (optional): Filter by lifecycle status. Must be one of the
   *   values in `PLUGIN_STATUSES` (`installed`, `ready`, `error`,
   *   `upgrade_pending`, `uninstalled`). Returns HTTP 400 if the value is
   *   not a recognised status string.
   *
   * Response: `PluginRecord[]`
   */
  router.get("/plugins", async (req, res) => {
    assertBoard(req);
    const rawStatus = req.query.status;
    if (rawStatus !== undefined) {
      if (typeof rawStatus !== "string" || !(PLUGIN_STATUSES as readonly string[]).includes(rawStatus)) {
        res.status(400).json({
          error: `Invalid status '${String(rawStatus)}'. Must be one of: ${PLUGIN_STATUSES.join(", ")}`,
        });
        return;
      }
    }
    const status = rawStatus as PluginStatus | undefined;
    const plugins = status
      ? await registry.listByStatus(status)
      : await registry.listInstalled();
    res.json(plugins);
  });

  /**
   * GET /api/plugins/examples
   *
   * Return first-party example plugins bundled in this repo, if present.
   * These can be installed through the normal local-path install flow.
   */
  router.get("/plugins/examples", async (req, res) => {
    assertBoard(req);
    res.json(listBundledPluginExamples());
  });

  // IMPORTANT: Static routes must come before parameterized routes
  // to avoid Express matching "ui-contributions" as a :pluginId

  /**
   * GET /api/plugins/ui-contributions
   *
   * Return UI contributions from all plugins in 'ready' state.
   * Used by the frontend to discover plugin UI slots and launcher metadata.
   *
   * The response is normalized for the frontend slot host:
   * - Only includes plugins with at least one declared UI slot or launcher
   * - Excludes plugins with null/missing manifestJson (defensive)
   * - Slots are extracted from manifest.ui.slots
   * - Launchers are aggregated from legacy manifest.launchers and manifest.ui.launchers
   *
   * Response: PluginUiContribution[]
   */
  router.get("/plugins/ui-contributions", async (req, res) => {
    assertBoard(req);
    const plugins = await registry.listByStatus("ready");

    const contributions: PluginUiContribution[] = plugins
      .filter((plugin) => !isCoreIntegratedPluginKey(plugin.pluginKey))
      .map((plugin) => {
        // Safety check: manifestJson should always exist for ready plugins, but guard against null
        const manifest = plugin.manifestJson;
        if (!manifest) return null;

        const uiMetadata = getPluginUiContributionMetadata(manifest);
        if (!uiMetadata) return null;

        return {
          pluginId: plugin.id,
          pluginKey: plugin.pluginKey,
          displayName: manifest.displayName,
          version: plugin.version,
          updatedAt: plugin.updatedAt.toISOString(),
          uiEntryFile: uiMetadata.uiEntryFile,
          slots: uiMetadata.slots,
          launchers: uiMetadata.launchers,
        };
      })
      .filter((item): item is PluginUiContribution => item !== null);
    res.json(contributions);
  });
}

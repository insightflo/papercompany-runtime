import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclipai.system-garden";
const PLUGIN_VERSION = "0.1.0";
const PLUGIN_DISPLAY_NAME = "System Garden";
const PAGE_ROUTE = "system-garden";

const capabilities = [
  "issues.read",
  "issue.comments.read",
  "agents.read",
  "ui.page.register",
  "ui.sidebar.register",
] as unknown as PaperclipPluginManifestV1["capabilities"];

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: PLUGIN_DISPLAY_NAME,
  description: "Agent dependency garden with health and metacognition signals.",
  author: "Paperclip",
  categories: ["ui"],
  capabilities,
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "page",
        id: "system-garden-page",
        displayName: PLUGIN_DISPLAY_NAME,
        exportName: "SystemGardenPage",
        routePath: PAGE_ROUTE,
      },
      {
        type: "sidebar",
        id: "system-garden-sidebar-link",
        displayName: PLUGIN_DISPLAY_NAME,
        exportName: "SystemGardenSidebarLink",
      },
    ],
  },
};

export default manifest;

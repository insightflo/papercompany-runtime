import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  EXPORT_NAMES,
  PAGE_ROUTE,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Knowledge Base",
  description: "Registers company knowledge sources and grants agent-level access at run time.",
  author: "InsightFlo",
  categories: ["automation", "automation"],
  capabilities: [
    "agents.read",
    "plugin.state.read",
    "plugin.state.write",
    "agent.tools.register",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  tools: [
    {
      name: "kb-search",
      displayName: "Knowledge Base Search",
      description: "Search the company knowledge base for articles matching a query.",
      parametersSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search keyword or article name" },
          kbName: { type: "string", description: "Specific KB name (optional)" },
        },
        required: ["query"],
      },
    },
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "Knowledge Base",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
      },
      {
        type: "sidebar",
        id: SLOT_IDS.sidebar,
        displayName: "Knowledge Base",
        exportName: EXPORT_NAMES.sidebar,
      },
    ],
  },
};

export default manifest;

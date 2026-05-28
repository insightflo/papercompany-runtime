import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID, PLUGIN_VERSION, TOOL_NAMES } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Research Workbench",
  description:
    "Provides agent tools for web search and evidence gathering via Vane headless backend",
  author: "InsightFlo",
  categories: ["automation"],
  capabilities: [
    "agent.tools.register",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  tools: [
    {
      name: TOOL_NAMES.researchSearch,
      displayName: "Research Search",
      description:
        "Search the web for information and return structured evidence bundles with sources, summaries, and relevance scores.",
      parametersSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query to execute",
          },
          maxResults: {
            type: "number",
            description: "Maximum number of results to return (1-25)",
          },
        },
        required: ["query"],
      },
    },
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      backend: {
        type: "string",
        enum: ["vane-headless"],
        description: "Backend adapter to use for search",
      },
      vaneBaseUrl: {
        type: "string",
        description: "Base URL of the Vane headless instance",
      },
      defaultMaxResults: {
        type: "number",
        minimum: 1,
        maximum: 25,
        description: "Default maximum number of results per query",
      },
      timeoutMs: {
        type: "number",
        minimum: 1000,
        maximum: 60000,
        description: "Request timeout in milliseconds",
      },
    },
    required: ["backend", "vaneBaseUrl"],
  },
};

export default manifest;

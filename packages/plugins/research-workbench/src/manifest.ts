import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID, PLUGIN_VERSION, TOOL_NAMES } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Research Workbench",
  description:
    "Self-running web search and evidence gathering. Defaults to the built-in direct-web backend (no API key, no Vane); optional vane-headless and script backends for advanced setups.",
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
        enum: ["direct-web", "vane-headless", "script"],
        description: "Backend adapter to use for search. Defaults to direct-web (built-in, keyless) when unset; vane-headless and script are optional advanced backends.",
      },
      vaneBaseUrl: {
        type: "string",
        description: "Base URL of the Vane headless instance when backend is vane-headless",
      },
      scriptCommand: {
        type: "string",
        description: "Command to run when backend is script. The command receives JSON on stdin and must print JSON search results on stdout.",
      },
      scriptWorkingDirectory: {
        type: "string",
        description: "Optional working directory for scriptCommand",
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
    required: [],
  },
};

export default manifest;

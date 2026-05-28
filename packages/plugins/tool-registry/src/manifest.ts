import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  EXPORT_NAMES,
  PAGE_ROUTE,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
  TOOL_NAMES,
} from "./constants.js";

const capabilities = [
  "events.subscribe",
  "events.emit",
  "issues.read",
  "issues.create",
  "issues.update",
  "issue.comments.create",
  "agents.read",
  "agents.pause",
  "companies.read",
  "plugin.state.read",
  "plugin.state.write",
  "agent.tools.register",
  "ui.page.register",
  "ui.sidebar.register",
] as unknown as PaperclipPluginManifestV1["capabilities"];

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Tool Registry",
  description: "Wraps approved CLI commands as plugin tools and enforces per-agent allow-lists.",
  author: "InsightFlo",
  categories: ["automation", "automation"],
  capabilities,
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      auditDirectBash: {
        type: "boolean",
        title: "Audit direct shell usage",
        default: false,
      },
      createAuditIssueOnViolation: {
        type: "boolean",
        title: "Create issue on audit violation",
        default: true,
      },
      pauseAgentOnViolation: {
        type: "boolean",
        title: "Pause agent on audit violation",
        default: false,
      },
      maxLogEntries: {
        type: "number",
        title: "Max log entries returned",
        default: 50,
        minimum: 10,
        maximum: 200,
      },
    },
  },
  tools: [
    {
      name: TOOL_NAMES.genericCliExecutor,
      displayName: "Generic CLI Executor",
      description: "Execute an approved CLI tool registered in Tool Registry.",
      parametersSchema: {
        type: "object",
        properties: {
          toolName: {
            type: "string",
            description: "Registered tool name in Tool Registry",
          },
          args: {
            type: "object",
            description: "Tool argument map",
            additionalProperties: true,
            default: {},
          },
        },
        required: ["toolName"],
      },
    },
    {
      name: TOOL_NAMES.markDone,
      displayName: "Mark Issue Done",
      description: "Complete an issue with required summary. Clears assignee and adds completion comment.",
      parametersSchema: {
        type: "object",
        properties: {
          issueId: {
            type: "string",
            description: "Issue id to complete",
          },
          summary: {
            type: "string",
            description: "One-line completion summary",
          },
        },
        required: ["issueId", "summary"],
      },
    },
    {
      name: TOOL_NAMES.escalate,
      displayName: "Escalate Issue",
      description: "Escalate a blocked issue. Clears assignee, records reason and next step, marks done.",
      parametersSchema: {
        type: "object",
        properties: {
          issueId: {
            type: "string",
            description: "Issue id to close after escalation",
          },
          reason: {
            type: "string",
            description: "One-line blocked reason",
          },
          nextStep: {
            type: "string",
            description: "Next required step or owner",
          },
        },
        required: ["issueId", "reason", "nextStep"],
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "Tool Registry",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
      },
      {
        type: "sidebar",
        id: SLOT_IDS.sidebar,
        displayName: "Tool Registry",
        exportName: EXPORT_NAMES.sidebar,
      },
    ],
  },
};

export default manifest;

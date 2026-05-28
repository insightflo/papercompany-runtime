import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  EXPORT_NAMES,
  JOB_KEYS,
  PAGE_ROUTE,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Workflow Engine",
  description:
    "DAG-based workflow engine — orchestrates multi-step agent workflows with dependency resolution, reconciliation, and failure policies",
  author: "InsightFlo",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "events.emit",
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.read",
    "issue.comments.create",
    "agents.read",
    "agents.invoke",
    "agent.sessions.create",
    "agent.sessions.send",
    "agent.sessions.close",
    "goals.read",
    "activity.log.write",
    "plugin.state.read",
    "plugin.state.write",
    "jobs.schedule",
    "ui.page.register",
    "ui.dashboardWidget.register",
    "ui.sidebar.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  jobs: [
    {
      jobKey: JOB_KEYS.reconciler,
      displayName: "Workflow Reconciler",
      description:
        "Scans for stuck steps (todo but not woken up) and re-triggers agents. Also checks workflow-level timeouts.",
      schedule: "*/5 * * * *",
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "Workflows",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
      },
      {
        type: "dashboardWidget",
        id: SLOT_IDS.dashboardWidget,
        displayName: "Workflow Status",
        exportName: EXPORT_NAMES.dashboardWidget,
      },
      {
        type: "sidebar",
        id: SLOT_IDS.sidebar,
        displayName: "Workflows",
        exportName: EXPORT_NAMES.sidebar,
      },
    ],
  },
};

export default manifest;

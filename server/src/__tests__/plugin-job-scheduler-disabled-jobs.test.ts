import { describe, expect, it } from "vitest";
import { isScheduledPluginJobDisabled } from "../services/plugin-job-scheduler.js";

describe("plugin job scheduler disabled scheduled jobs", () => {
  it("matches disabled scheduled jobs by plugin key and job key", () => {
    expect(isScheduledPluginJobDisabled(
      { pluginKey: "insightflo.workflow-engine", jobKey: "workflow-reconciler" },
      [{ pluginKey: "insightflo.workflow-engine", jobKey: "workflow-reconciler" }],
    )).toBe(true);
  });

  it("does not disable unrelated plugin jobs with the same job key", () => {
    expect(isScheduledPluginJobDisabled(
      { pluginKey: "other.workflow-engine", jobKey: "workflow-reconciler" },
      [{ pluginKey: "insightflo.workflow-engine", jobKey: "workflow-reconciler" }],
    )).toBe(false);
  });
});

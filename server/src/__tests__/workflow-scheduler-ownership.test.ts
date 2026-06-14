import { describe, expect, it } from "vitest";
import { resolveWorkflowSchedulerOwnership } from "../services/workflow/scheduler-ownership.js";

describe("workflow scheduler ownership mode", () => {
  it("uses native-active-plugin-disabled as the default ownership mode", () => {
    expect(resolveWorkflowSchedulerOwnership({})).toEqual({
      nativeSchedulerEnabled: true,
      pluginReconcilerDisableRequested: true,
      pluginReconcilerEffectiveDisabled: true,
      mode: "native-active-plugin-disabled",
    });
  });

  it("uses plugin-active only when both cutover flags are explicitly disabled", () => {
    expect(resolveWorkflowSchedulerOwnership({
      WORKFLOW_NATIVE_SCHEDULER_ENABLED: "false",
      WORKFLOW_PLUGIN_RECONCILER_DISABLED: "false",
    })).toEqual({
      nativeSchedulerEnabled: false,
      pluginReconcilerDisableRequested: false,
      pluginReconcilerEffectiveDisabled: false,
      mode: "plugin-active",
    });
  });

  it("uses native-shadow when native scheduler is enabled but plugin reconciler is still active", () => {
    expect(resolveWorkflowSchedulerOwnership({
      WORKFLOW_NATIVE_SCHEDULER_ENABLED: "true",
      WORKFLOW_PLUGIN_RECONCILER_DISABLED: "false",
    })).toEqual({
      nativeSchedulerEnabled: true,
      pluginReconcilerDisableRequested: false,
      pluginReconcilerEffectiveDisabled: false,
      mode: "native-shadow",
    });
  });

  it("uses native-active-plugin-disabled only when native is enabled and plugin reconciler is disabled", () => {
    expect(resolveWorkflowSchedulerOwnership({
      WORKFLOW_NATIVE_SCHEDULER_ENABLED: "true",
      WORKFLOW_PLUGIN_RECONCILER_DISABLED: "true",
    })).toEqual({
      nativeSchedulerEnabled: true,
      pluginReconcilerDisableRequested: true,
      pluginReconcilerEffectiveDisabled: true,
      mode: "native-active-plugin-disabled",
    });
  });

  it("does not effectively disable the plugin reconciler when native scheduler is disabled", () => {
    expect(resolveWorkflowSchedulerOwnership({
      WORKFLOW_NATIVE_SCHEDULER_ENABLED: "false",
      WORKFLOW_PLUGIN_RECONCILER_DISABLED: "true",
    })).toEqual({
      nativeSchedulerEnabled: false,
      pluginReconcilerDisableRequested: true,
      pluginReconcilerEffectiveDisabled: false,
      mode: "plugin-active",
    });
  });

  it("does not expose an ambiguous pluginReconcilerDisabled flag", () => {
    expect(resolveWorkflowSchedulerOwnership({
      WORKFLOW_NATIVE_SCHEDULER_ENABLED: "false",
      WORKFLOW_PLUGIN_RECONCILER_DISABLED: "true",
    })).not.toHaveProperty("pluginReconcilerDisabled");
  });
});

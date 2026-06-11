export type WorkflowSchedulerOwnershipMode =
  | "plugin-active"
  | "native-shadow"
  | "native-active-plugin-disabled";

export interface WorkflowSchedulerOwnership {
  nativeSchedulerEnabled: boolean;
  pluginReconcilerDisableRequested: boolean;
  pluginReconcilerEffectiveDisabled: boolean;
  mode: WorkflowSchedulerOwnershipMode;
}

function isEnabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function resolveWorkflowSchedulerOwnership(
  env: Record<string, string | undefined> = process.env,
): WorkflowSchedulerOwnership {
  const nativeSchedulerEnabled = isEnabled(env.WORKFLOW_NATIVE_SCHEDULER_ENABLED);
  const pluginReconcilerDisableRequested = isEnabled(env.WORKFLOW_PLUGIN_RECONCILER_DISABLED);
  const pluginReconcilerEffectiveDisabled = nativeSchedulerEnabled && pluginReconcilerDisableRequested;

  if (nativeSchedulerEnabled && pluginReconcilerEffectiveDisabled) {
    return {
      nativeSchedulerEnabled,
      pluginReconcilerDisableRequested,
      pluginReconcilerEffectiveDisabled,
      mode: "native-active-plugin-disabled",
    };
  }

  if (nativeSchedulerEnabled) {
    return {
      nativeSchedulerEnabled,
      pluginReconcilerDisableRequested,
      pluginReconcilerEffectiveDisabled,
      mode: "native-shadow",
    };
  }

  return {
    nativeSchedulerEnabled,
    pluginReconcilerDisableRequested,
    pluginReconcilerEffectiveDisabled,
    mode: "plugin-active",
  };
}

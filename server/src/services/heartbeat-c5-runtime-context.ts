import type { Db } from "@paperclipai/db";
import { loadConfig } from "../config.js";
import { createReplacementRootNotifications, type ReplacementRootNotifications } from "./issue-assignment-wakeup.js";
import { createQaFileOwnerRuntime, type QaFileOwnerRuntime } from "./workflow/control-flow/qa-remediation-runtime.js";
import type { QaRemediationSharedAdmissionRuntime } from "./workflow/control-flow/qa-remediation-admission-root.js";

// A root Db keeps its explicitly supplied owner runtime across bare service recreation.
// The WeakMap keys by the exact Db object and does not share execution contexts or roots.
const heartbeatC5OwnerRuntimeByDb = new WeakMap<Db, QaFileOwnerRuntime>();

export function bindHeartbeatC5OwnerRuntime(db: Db, explicit: QaFileOwnerRuntime | undefined) {
  const bound = heartbeatC5OwnerRuntimeByDb.get(db);
  if (explicit) {
    if (bound && bound !== explicit) throw new Error("heartbeat_c5_owner_runtime_binding_conflict");
    if (!bound) heartbeatC5OwnerRuntimeByDb.set(db, explicit);
    return explicit;
  }
  if (bound) return bound;
  const ownerRuntime = createQaFileOwnerRuntime(loadConfig());
  heartbeatC5OwnerRuntimeByDb.set(db, ownerRuntime);
  return ownerRuntime;
}

export function createHeartbeatC5SharedAdmission(ownerRuntime: QaFileOwnerRuntime): QaRemediationSharedAdmissionRuntime {
  const outerNotifications = createReplacementRootNotifications();
  const resolutionMap = new Map<string, unknown>();
  const rootResolutionMaps = new WeakMap<ReplacementRootNotifications, Map<string, unknown>>();
  return {
    ownerRuntime,
    outerNotifications,
    resolutionMap,
    bindResolutionMap: (notifications, map) => rootResolutionMaps.set(notifications, map),
    driftBudget: { corrections: 0 },
  };
}

export function mergeHeartbeatRootNotifications(target: ReplacementRootNotifications, source: ReplacementRootNotifications) {
  for (const agentId of source.agentIds) target.agentIds.add(agentId);
  for (const wakeupRequestId of source.correctionWakeupRequestIds) target.correctionWakeupRequestIds.add(wakeupRequestId);
}

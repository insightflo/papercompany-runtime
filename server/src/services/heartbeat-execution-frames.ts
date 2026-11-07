import type { Db, heartbeatRuns } from "@paperclipai/db";
import type { HeartbeatActualDrainIdentity } from "./heartbeat-actual-drain.js";
import type { C5NotInvokedProof, QaCorrectionExecutionIdentity } from "./workflow/control-flow/qa-remediation-admission-root.js";

export type ActiveHeartbeatExecutionFrame = {
  readonly run: typeof heartbeatRuns.$inferSelect;
  readonly finalizationVersion: number | null;
  adapterInvocationAttempted: boolean;
  actualCaptured: boolean;
  identityObserved: boolean;
  actualDrainIdentity: HeartbeatActualDrainIdentity | null;
  noActualInvocationConfirmed: boolean;
  c5ExecutionOptedIn: boolean;
  c5NotInvoked: { proof: C5NotInvokedProof; identity: QaCorrectionExecutionIdentity } | null;
  c5TerminalWriterSnapshot: typeof heartbeatRuns.$inferSelect | null;
  ownerReleaseBlocked: boolean;
  conflicted: boolean;
};

// heartbeatService(db) is created by several control-plane callers. Share only live frames
// for that exact Db object so cancellation can consult the active actual without persistence.
export const activeHeartbeatExecutionFramesByDb = new WeakMap<Db, Map<string, ActiveHeartbeatExecutionFrame>>();

export function activeHeartbeatExecutionFrames(db: Db) {
  let frames = activeHeartbeatExecutionFramesByDb.get(db);
  if (!frames) {
    frames = new Map();
    activeHeartbeatExecutionFramesByDb.set(db, frames);
  }
  return frames;
}

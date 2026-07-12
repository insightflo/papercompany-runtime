import { describe, expect, it } from "vitest";
import { classifyRecoveryOwnership, isQaRecoveryLive } from "../services/missions/recovery-ownership-guard.js";

describe("classifyRecoveryOwnership", () => {
  it("a queued/running recovery heartbeat forces observe-only even with no unblock", () => {
    const verdict = classifyRecoveryOwnership({ hasLiveWakeup: false, hasLiveHeartbeat: true });
    expect(verdict).toEqual({ kind: "qa_recovery_live", signal: "live_heartbeat" });
    expect(isQaRecoveryLive(verdict)).toBe(true);
  });

  it("a queued/claimed recovery wakeup forces observe-only even with no unblock", () => {
    const verdict = classifyRecoveryOwnership({ hasLiveWakeup: true, hasLiveHeartbeat: false });
    expect(verdict).toEqual({ kind: "qa_recovery_live", signal: "live_wakeup" });
    expect(isQaRecoveryLive(verdict)).toBe(true);
  });

  it("heartbeat takes precedence over wakeup when both are live", () => {
    const verdict = classifyRecoveryOwnership({ hasLiveWakeup: true, hasLiveHeartbeat: true });
    expect(verdict).toEqual({ kind: "qa_recovery_live", signal: "live_heartbeat" });
  });

  it("no live work → oversight may act (deadlock/terminal proceed with established recovery)", () => {
    const verdict = classifyRecoveryOwnership({ hasLiveWakeup: false, hasLiveHeartbeat: false });
    expect(verdict).toEqual({ kind: "oversight_may_act", reason: "no_live_qa_recovery" });
    expect(isQaRecoveryLive(verdict)).toBe(false);
  });
});

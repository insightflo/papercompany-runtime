import { describe, expect, it } from "vitest";
import { classifyRecoveryOwnership, isQaRecoveryLive, isQaRecoveryStalled, mayOversightAct } from "../services/missions/recovery-ownership-guard.js";

describe("classifyRecoveryOwnership", () => {
  it("a queued/running recovery heartbeat forces observe-only even with no unblock", () => {
    const verdict = classifyRecoveryOwnership({
      hasUnblock: false,
      unblockTerminal: false,
      hasLiveWakeup: false,
      hasLiveHeartbeat: true,
      hasCurrentGenVerdict: false,
    });
    expect(verdict).toEqual({ kind: "qa_recovery_live", signal: "live_heartbeat" });
    expect(isQaRecoveryLive(verdict)).toBe(true);
  });

  it("a queued/claimed recovery wakeup forces observe-only even with no unblock", () => {
    const verdict = classifyRecoveryOwnership({
      hasUnblock: false,
      unblockTerminal: false,
      hasLiveWakeup: true,
      hasLiveHeartbeat: false,
      hasCurrentGenVerdict: false,
    });
    expect(verdict).toEqual({ kind: "qa_recovery_live", signal: "live_wakeup" });
  });

  it("heartbeat takes precedence over wakeup when both are live", () => {
    const verdict = classifyRecoveryOwnership({
      hasUnblock: true,
      unblockTerminal: false,
      hasLiveWakeup: true,
      hasLiveHeartbeat: true,
      hasCurrentGenVerdict: false,
    });
    expect(verdict).toEqual({ kind: "qa_recovery_live", signal: "live_heartbeat" });
  });

  it("no unblock and no live work → oversight may act (no recovery chain)", () => {
    const verdict = classifyRecoveryOwnership({
      hasUnblock: false,
      unblockTerminal: false,
      hasLiveWakeup: false,
      hasLiveHeartbeat: false,
      hasCurrentGenVerdict: false,
    });
    expect(verdict).toEqual({ kind: "oversight_may_act", reason: "no_recovery_chain" });
    expect(mayOversightAct(verdict)).toBe(true);
  });

  it("non-terminal unblock with no live work → stalled (QA recovery deadlock, producer reopen forbidden)", () => {
    const verdict = classifyRecoveryOwnership({
      hasUnblock: true,
      unblockTerminal: false,
      hasLiveWakeup: false,
      hasLiveHeartbeat: false,
      hasCurrentGenVerdict: false,
    });
    expect(verdict).toEqual({ kind: "qa_recovery_stalled", reason: "recovery_chain_active_no_live_work" });
    expect(isQaRecoveryStalled(verdict)).toBe(true);
  });

  it("terminal unblock WITH current-generation verdict → handoff complete, oversight may act", () => {
    const verdict = classifyRecoveryOwnership({
      hasUnblock: true,
      unblockTerminal: true,
      hasLiveWakeup: false,
      hasLiveHeartbeat: false,
      hasCurrentGenVerdict: true,
    });
    expect(verdict).toEqual({ kind: "oversight_may_act", reason: "terminal_handoff_complete" });
  });

  it("terminal unblock WITHOUT current-generation verdict → stalled deadlock, producer reopen forbidden", () => {
    const verdict = classifyRecoveryOwnership({
      hasUnblock: true,
      unblockTerminal: true,
      hasLiveWakeup: false,
      hasLiveHeartbeat: false,
      hasCurrentGenVerdict: false,
    });
    expect(verdict).toEqual({ kind: "qa_recovery_stalled", reason: "terminal_recovery_without_generation_verdict" });
    expect(isQaRecoveryStalled(verdict)).toBe(true);
  });

  it("a live heartbeat still wins over a terminal unblock without verdict (no premature producer reopen)", () => {
    const verdict = classifyRecoveryOwnership({
      hasUnblock: true,
      unblockTerminal: true,
      hasLiveWakeup: false,
      hasLiveHeartbeat: true,
      hasCurrentGenVerdict: false,
    });
    expect(isQaRecoveryLive(verdict)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { classifyRecoveryCloseout } from "../services/missions/recovery-closeout.js";

const ready = {
  hasActiveWorkProduct: true,
  hasFreshQaPass: true,
  hasFailedProducerStep: true,
  alreadyCompleted: false,
};

describe("classifyRecoveryCloseout", () => {
  it("all evidence present → reconcile", () => {
    expect(classifyRecoveryCloseout(ready)).toEqual({ reconcile: true });
  });

  it("no active workProduct → skip", () => {
    expect(classifyRecoveryCloseout({ ...ready, hasActiveWorkProduct: false }))
      .toEqual({ reconcile: false, reason: "no_active_workproduct" });
  });

  it("already completed (idempotent re-entry) → skip already_completed", () => {
    expect(classifyRecoveryCloseout({ ...ready, alreadyCompleted: true, hasFailedProducerStep: false }))
      .toEqual({ reconcile: false, reason: "already_completed" });
  });

  it("PASS is missing or from another QA/run → skip no_fresh_qa_pass", () => {
    expect(classifyRecoveryCloseout({ ...ready, hasFreshQaPass: false }))
      .toEqual({ reconcile: false, reason: "no_fresh_qa_pass" });
  });

  it("no failed producer step (and not already completed) → skip no_failed_step", () => {
    expect(classifyRecoveryCloseout({ ...ready, hasFailedProducerStep: false }))
      .toEqual({ reconcile: false, reason: "no_failed_step" });
  });

  it("active workProduct wins precedence over missing pass (checked first)", () => {
    // no workproduct AND no pass AND no failed step → first gate (no_active_workproduct) wins
    expect(classifyRecoveryCloseout({
      hasActiveWorkProduct: false,
      hasFreshQaPass: false,
      hasFailedProducerStep: false,
      alreadyCompleted: false,
    })).toEqual({ reconcile: false, reason: "no_active_workproduct" });
  });
});

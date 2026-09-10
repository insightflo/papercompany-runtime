import { describe, expect, it } from "vitest";
import * as shared from "@paperclipai/shared";
import { event, policy } from "./helpers/tool-progress.js";

describe("progress machine contracts", () => {
  it("exports strict versioned policy and event validation", () => {
    expect(shared).toHaveProperty("toolProgressPolicySchema");
    expect(shared).toHaveProperty("toolProgressEventSchema");
    expect(shared.toolProgressPolicySchema.safeParse(policy).success).toBe(true);
    expect(shared.toolProgressEventSchema.safeParse(event("00000000-0000-4000-8000-000000000001")).success).toBe(true);
  });
  it("rejects ambiguous stages, wrong deadlines and producer authority fields", () => {
    for (const value of [
      { ...policy, idleTimeoutMs: 999 }, { ...policy, maxDurationMs: 1000 },
      { ...policy, stages: [policy.stages[0], policy.stages[0]] }, { ...policy, completion: true },
    ]) expect(shared.toolProgressPolicySchema.safeParse(value).success).toBe(false);
    const valid = event("00000000-0000-4000-8000-000000000001");
    for (const value of [
      { ...valid, current: NaN }, { ...valid, current: 1.5 }, { ...valid, current: -1 },
      { ...valid, sequence: 0 }, { ...valid, current: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, total: 0 }, { ...valid, current: 2, total: 1 }, { ...valid, completed: true },
    ]) expect(shared.toolProgressEventSchema.safeParse(value).success).toBe(false);
  });
});

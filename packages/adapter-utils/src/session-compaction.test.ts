import { describe, expect, it } from "vitest";
import {
  ADAPTER_SESSION_MANAGEMENT,
  hasSessionCompactionThresholds,
  readSessionCompactionOverride,
  resolveSessionCompactionPolicy,
} from "./session-compaction.js";

describe("session compaction policy", () => {
  it("gives threshold-based adapters a default resumed-message cap", () => {
    const resolved = resolveSessionCompactionPolicy("pi_local", {});
    expect(resolved.policy.enabled).toBe(true);
    expect(resolved.policy.maxSessionMessages).toBeGreaterThan(0);
  });

  it("keeps adapter-managed sessions (claude/codex/hermes) free of threshold rotation", () => {
    for (const adapterType of ["claude_local", "codex_local", "hermes_local"]) {
      const resolved = resolveSessionCompactionPolicy(adapterType, {});
      expect(resolved.policy.maxSessionMessages).toBe(0);
      expect(hasSessionCompactionThresholds(resolved.policy)).toBe(false);
    }
  });

  it("reads a maxSessionMessages override from runtime config", () => {
    const override = readSessionCompactionOverride({
      heartbeat: { sessionCompaction: { maxSessionMessages: 12 } },
    });
    expect(override.maxSessionMessages).toBe(12);

    const resolved = resolveSessionCompactionPolicy("pi_local", {
      heartbeat: { sessionCompaction: { maxSessionMessages: 12 } },
    });
    expect(resolved.policy.maxSessionMessages).toBe(12);
    expect(resolved.source).toBe("agent_override");
  });

  it("treats maxSessionMessages as a compaction threshold", () => {
    expect(hasSessionCompactionThresholds({ maxSessionRuns: 0, maxRawInputTokens: 0, maxSessionAgeHours: 0, maxSessionMessages: 40 } as never)).toBe(true);
    expect(hasSessionCompactionThresholds({ maxSessionRuns: 0, maxRawInputTokens: 0, maxSessionAgeHours: 0, maxSessionMessages: 0 } as never)).toBe(false);
  });

  it("does not enable unknown adapters by default", () => {
    const resolved = resolveSessionCompactionPolicy("commandcode_local", {});
    expect(resolved.policy.enabled).toBe(false);
  });

  it("exposes the default policy used for pi_local", () => {
    expect(ADAPTER_SESSION_MANAGEMENT.pi_local?.defaultSessionCompaction.maxSessionMessages).toBeGreaterThan(0);
  });
});

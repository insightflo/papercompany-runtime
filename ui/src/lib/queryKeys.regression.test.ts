import { describe, expect, it } from "vitest";
import { queryKeys } from "./queryKeys";

/**
 * Verify prefix-match semantics: a no-variant root key must prefix-match
 * agent-scoped / variant-scoped keys so that company-level cache
 * invalidation reaches every variant.
 *
 * react-query's partialMatchKey checks only the positions present in the
 * FILTER key — a shorter filter acts as a prefix. We simulate this by
 * checking that every element of the root key equals the corresponding
 * element of the scoped key.
 */
function prefixMatches(root: readonly unknown[], scoped: readonly unknown[]): boolean {
  if (root.length > scoped.length) return false;
  for (let i = 0; i < root.length; i += 1) {
    if (root[i] !== scoped[i]) return false;
  }
  return true;
}

describe("queryKeys prefix-match regression", () => {
  describe("liveRuns", () => {
    it("root (no agentId) is a prefix of agent-scoped variant", () => {
      const root = queryKeys.liveRuns("co-1");
      const scoped = queryKeys.liveRuns("co-1", "agent-1");
      expect(root).toEqual(["live-runs", "co-1"]);
      expect(scoped).toEqual(["live-runs", "co-1", "agent-1"]);
      expect(prefixMatches(root, scoped)).toBe(true);
    });

    it("different companies do not cross-match", () => {
      const root = queryKeys.liveRuns("co-1");
      const other = queryKeys.liveRuns("co-2", "agent-1");
      expect(prefixMatches(root, other)).toBe(false);
    });
  });

  describe("heartbeatAttention", () => {
    it("root (no variant) is a prefix of badge variant", () => {
      const root = queryKeys.heartbeatAttention("co-1");
      const badge = queryKeys.heartbeatAttention("co-1", "run-a,run-b");
      expect(root).toEqual(["heartbeats", "co-1", "attention"]);
      expect(badge).toEqual(["heartbeats", "co-1", "attention", "run-a,run-b"]);
      expect(prefixMatches(root, badge)).toBe(true);
    });

    it("root equals inbox (no variant) key so invalidation reaches inbox", () => {
      const root = queryKeys.heartbeatAttention("co-1");
      const inbox = queryKeys.heartbeatAttention("co-1");
      expect(root).toEqual(inbox);
    });

    it("variant change produces a different key (triggers refetch on dismiss)", () => {
      const v1 = queryKeys.heartbeatAttention("co-1", "run-a");
      const v2 = queryKeys.heartbeatAttention("co-1", "run-a,run-b");
      expect(v1).not.toEqual(v2);
    });
  });
});

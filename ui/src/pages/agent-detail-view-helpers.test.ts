import { describe, expect, it } from "vitest";
import type { HeartbeatRunSummary } from "@paperclipai/shared";
import { createDirectLinkedRunStub } from "../lib/heartbeat-run-stub";
import { parseAgentDetailView, runMetrics, setsEqual } from "./agent-detail-view-helpers";

describe("AgentDetail view helpers", () => {
  it("preserves URL tab aliases and the default", () => {
    expect(parseAgentDetailView("prompts")).toBe("instructions");
    expect(parseAgentDetailView("configure")).toBe("configuration");
    expect(parseAgentDetailView("runs")).toBe("runs");
    expect(parseAgentDetailView("unknown")).toBe("dashboard");
    expect(parseAgentDetailView(null)).toBe("dashboard");
  });

  it("preserves usage aliases and subscription billing when displaying run metrics", () => {
    const run: HeartbeatRunSummary = { ...createDirectLinkedRunStub("run-1", "company-1", "agent-1"), usageJson: { input_tokens: 7, outputTokens: 3, cache_read_input_tokens: 2, billingType: "subscription_included", costUsd: 12 } };
    expect(runMetrics(run)).toEqual({ input: 7, output: 3, cached: 2, cost: 0, totalTokens: 10 });
    const empty: HeartbeatRunSummary = { ...run, usageJson: null };
    expect(runMetrics(empty)).toEqual({ input: 0, output: 0, cached: 0, cost: 0, totalTokens: 0 });
  });

  it("compares set membership without depending on iteration order", () => {
    expect(setsEqual(new Set([1, 2]), new Set([2, 1]))).toBe(true);
    expect(setsEqual(new Set([1, 2]), new Set([1, 3]))).toBe(false);
    expect(setsEqual(new Set([1]), new Set([1, 2]))).toBe(false);
  });
});

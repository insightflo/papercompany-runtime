import { describe, expect, it } from "vitest";
import { computePaqoDefinitionHash } from "../services/workflow/paqo-definition-identity.js";

// [Stage 4] Deterministic definition hash contract — pure function tests.
// The algorithm is FROZEN: sha256 over stable key-sorted JSON of
// { schemaVersion: 1, steps }. See services/workflow/paqo-definition-identity.ts.

describe("computePaqoDefinitionHash", () => {
  it("is deterministic across object key ordering permutations", () => {
    const stepsA = [
      { id: "s1", name: "[ACTION] A", agentId: "agent-1", dependencies: [], description: "do A" },
      { id: "s2", name: "[QA] Verify", agentId: "agent-1", dependencies: ["s1"], description: "verify" },
    ];
    const stepsB = [
      { dependencies: [], agentId: "agent-1", name: "[ACTION] A", id: "s1", description: "do A" },
      { description: "verify", dependencies: ["s1"], agentId: "agent-1", name: "[QA] Verify", id: "s2" },
    ];
    expect(computePaqoDefinitionHash(stepsB as never[])).toBe(computePaqoDefinitionHash(stepsA as never[]));
  });

  it("changes when execution-semantic content changes", () => {
    const base = [{ id: "s1", name: "[ACTION] A", agentId: "agent-1", dependencies: [] }];
    const changedAgent = [{ id: "s1", name: "[ACTION] A", agentId: "agent-2", dependencies: [] }];
    const changedDeps = [{ id: "s1", name: "[ACTION] A", agentId: "agent-1", dependencies: ["s0"] }];
    const changedTools = [{ id: "s1", name: "[ACTION] A", agentId: "agent-1", dependencies: [], toolNames: ["t"] }];
    const baseHash = computePaqoDefinitionHash(base as never[]);
    expect(computePaqoDefinitionHash(changedAgent as never[])).not.toBe(baseHash);
    expect(computePaqoDefinitionHash(changedDeps as never[])).not.toBe(baseHash);
    expect(computePaqoDefinitionHash(changedTools as never[])).not.toBe(baseHash);
  });

  it("produces a full sha256 hex digest", () => {
    const hash = computePaqoDefinitionHash([{ id: "s1", name: "x", agentId: "a", dependencies: [] }] as never[]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

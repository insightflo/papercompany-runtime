// @vitest-environment node
// Regression coverage for the stale-assignee fix (AREA-1).
// The workflow editor used to persist a stale `agentId` inside the generic
// `extra` bag when a step's agent was changed by name. The server resolves
// `agentId ?? agentName`, so the stale id won and the OLD agent executed.
// These tests lock the contract: agentId is a first-class StepDraft field,
// never hides in `extra`, and stepsToJson emits a consistent id+name pair.

import { describe, expect, it } from "vitest";
import { jsonToSteps, stepsToJson } from "./Workflows";
import type { StepDraft } from "./Workflows";

type StepsInput = Parameters<typeof jsonToSteps>[0];

function step(over: Record<string, unknown> = {}): StepsInput[number] {
  return {
    id: "s1",
    title: "Step 1",
    type: "agent",
    agentName: "Old Agent",
    ...over,
  } as unknown as StepsInput[number];
}

function roundTrip(over: Record<string, unknown>): Record<string, unknown> {
  const drafts = jsonToSteps([step(over)]);
  return stepsToJson(drafts)[0] as Record<string, unknown>;
}

describe("Workflows editor serialization — stale assignee (AREA-1)", () => {
  it("jsonToSteps hydrates agentId as a first-class field and strips it from extra", () => {
    const drafts = jsonToSteps([step({ agentId: "OLD" })]);
    expect(drafts[0].agentId).toBe("OLD");
    expect(drafts[0].agentName).toBe("Old Agent");
    // The stale id must NOT also linger in the generic extra bag.
    expect(drafts[0].extra).not.toHaveProperty("agentId");
  });

  it("changing the agent persists a consistent agentId+agentName pair with no stale id", () => {
    const drafts = jsonToSteps([step({ agentId: "OLD" })]);
    // Simulate the agent <select> onChange writing BOTH the new id and name.
    drafts[0].agentId = "NEW";
    drafts[0].agentName = "New Agent";
    const out = stepsToJson(drafts)[0] as Record<string, unknown>;
    expect(out.agentId).toBe("NEW");
    expect(out.agentName).toBe("New Agent");
    // The previous id must be gone entirely.
    expect(JSON.stringify(out)).not.toMatch(/OLD/);
    expect(Object.keys(out).filter((k) => k === "agentId")).toEqual(["agentId"]);
  });

  it("clearing the agent writes neither agentId nor agentName", () => {
    const drafts = jsonToSteps([step({ agentId: "OLD" })]);
    drafts[0].agentId = "";
    drafts[0].agentName = "";
    const out = stepsToJson(drafts)[0] as Record<string, unknown>;
    expect(out).not.toHaveProperty("agentId");
    expect(out).not.toHaveProperty("agentName");
  });

  it("legacy name-only step (no agentId) round-trips name-only so the server resolves by name", () => {
    const drafts = jsonToSteps([step({ agentName: "Solo", agentId: undefined })]);
    expect(drafts[0].agentId).toBe("");
    expect(drafts[0].agentName).toBe("Solo");
    const out = stepsToJson(drafts)[0] as Record<string, unknown>;
    expect(out.agentName).toBe("Solo");
    expect(out).not.toHaveProperty("agentId");
  });

  it("a stale agentId hiding in extra does not leak into persisted json (defense-in-depth)", () => {
    // Reproduces the pre-fix data shape: a stale id carried only in `extra`.
    const drafts: StepDraft[] = jsonToSteps([step({ agentName: "X" })]);
    (drafts[0].extra as Record<string, unknown>)["agentId"] = "STALE";
    // User changes the agent by name and the draft carries no first-class id.
    drafts[0].agentName = "Y";
    drafts[0].agentId = "";
    const out = stepsToJson(drafts)[0] as Record<string, unknown>;
    expect(out.agentName).toBe("Y");
    expect(out).not.toHaveProperty("agentId");
    expect(JSON.stringify(out)).not.toMatch(/STALE/);
  });

  it("round-trip of a freshly authored producer step keeps graphWorkProductRequired", () => {
    // Belts-and-suspenders: the workProduct flag survives the same serialization
    // path the assignee fix touched (AREA-2 UI exposure relies on this).
    const out = roundTrip({ agentName: "Producer", agentId: "P1", graphWorkProductRequired: true });
    expect(out.graphWorkProductRequired).toBe(true);
    expect(out.agentId).toBe("P1");
    expect(out.agentName).toBe("Producer");
  });
});

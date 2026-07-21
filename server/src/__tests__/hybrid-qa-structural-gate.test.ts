import { describe, expect, it } from "vitest";
import { buildMissionPlanningDescription } from "../services/missions/mission-planning-description.js";
import { isStructuralGateStep } from "../services/workflow/control-flow/structural-gate.js";
import { parseStructuralGateVerdict } from "../services/workflow/control-flow/structural-gate-ledger.js";
import { resolveProducerCap } from "../services/workflow/control-flow/structural-gate-rework.js";
import { renderStructuralGateAlreadyRunLines, STRUCTURAL_GATE_ALREADY_RUN_MARKER } from "../services/missions/mission-quality-contract.js";
import { QA_REWORK_DEFAULT_MAX_ITERATIONS } from "../services/missions/workflow-qa-rework.js";

describe("hybrid QA — structural gate classification", () => {
  it("returns true for type:tool + qaType:structural + one toolName + no agentId", () => {
    expect(isStructuralGateStep({
      id: "gate-1", type: "tool", qaType: "structural",
      toolNames: ["validate-schema"], agentId: "", dependencies: [],
    })).toBe(true);
  });

  it("returns false when agentId is non-empty (LLM heartbeat would run)", () => {
    expect(isStructuralGateStep({
      id: "gate-1", type: "tool", qaType: "structural",
      toolNames: ["validate-schema"], agentId: "agent-uuid", dependencies: [],
    })).toBe(false);
  });

  it("returns false when type is not tool", () => {
    expect(isStructuralGateStep({
      id: "gate-1", type: "agent", qaType: "structural",
      toolNames: ["validate-schema"], agentId: "", dependencies: [],
    })).toBe(false);
  });

  it("returns false when qaType is not structural", () => {
    expect(isStructuralGateStep({
      id: "gate-1", type: "tool", qaType: "semantic",
      toolNames: ["validate-schema"], agentId: "", dependencies: [],
    })).toBe(false);
  });

  it("returns false when toolNames count is not exactly 1", () => {
    expect(isStructuralGateStep({
      id: "gate-1", type: "tool", qaType: "structural",
      toolNames: ["a", "b"], agentId: "", dependencies: [],
    })).toBe(false);
  });
});

describe("hybrid QA — verdict parsing (contract hard failure on invalid)", () => {
  it("returns pass for exact match", () => {
    expect(parseStructuralGateVerdict({ verdict: "pass" })).toBe("pass");
  });

  it("returns request_changes for exact match", () => {
    expect(parseStructuralGateVerdict({ verdict: "request_changes" })).toBe("request_changes");
  });

  it("returns null for missing verdict (contract hard failure)", () => {
    expect(parseStructuralGateVerdict({})).toBeNull();
    expect(parseStructuralGateVerdict({ verdict: undefined })).toBeNull();
  });

  it("returns null for invalid verdict string", () => {
    expect(parseStructuralGateVerdict({ verdict: "approved" })).toBeNull();
    expect(parseStructuralGateVerdict({ verdict: "PASS" })).toBeNull();
  });

  it("returns null for non-object data", () => {
    expect(parseStructuralGateVerdict(null)).toBeNull();
    expect(parseStructuralGateVerdict("pass")).toBeNull();
    expect(parseStructuralGateVerdict([])).toBeNull();
  });
});

describe("hybrid QA — prompt scope", () => {
  it("does not claim all machine contracts are satisfied", () => {
    const text = renderStructuralGateAlreadyRunLines().join("\n");
    expect(text).not.toContain("assume machine contracts are satisfied");
    expect(text).not.toContain("Do not re-verify them");
  });

  it("says only delegated checks are authoritative", () => {
    const text = renderStructuralGateAlreadyRunLines().join("\n");
    expect(text).toContain("explicitly delegated to a structural gate");
    expect(text).toContain("MUST still verify");
  });

  it("prohibits generic prose/wording rules", () => {
    const text = renderStructuralGateAlreadyRunLines().join("\n");
    expect(text).toContain("Do not invent generic wording rules");
    expect(text).toContain("prose style rules");
    expect(text).toContain("generic HTML structure rules");
  });

  it("includes the marker for rubric detection", () => {
    expect(renderStructuralGateAlreadyRunLines()).toContain(STRUCTURAL_GATE_ALREADY_RUN_MARKER);
  });
});

describe("hybrid QA — unchanged cap", () => {
  it("QA_REWORK_DEFAULT_MAX_ITERATIONS is still 2", () => {
    expect(QA_REWORK_DEFAULT_MAX_ITERATIONS).toBe(2);
  });
});

describe("hybrid QA — producer cap resolution", () => {
  it("uses explicit back-edge maxIterations when present", () => {
    expect(resolveProducerCap({
      id: "p", agentId: "a", dependencies: ["qa"],
      conditionalDependencies: [
        { stepId: "qa", when: "qa_request_changes" as const, isBackEdge: true, maxIterations: 3 },
      ],
    })).toBe(3);
  });

  it("falls back to default cap (2) when no back-edge exists", () => {
    expect(resolveProducerCap({ id: "p", agentId: "a", dependencies: ["qa"] })).toBe(2);
  });

  it("finds max across multiple back-edges", () => {
    expect(resolveProducerCap({
      id: "p", agentId: "a", dependencies: [],
      conditionalDependencies: [
        { stepId: "qa-1", when: "qa_request_changes" as const, isBackEdge: true, maxIterations: 2 },
        { stepId: "qa-2", when: "qa_request_changes" as const, isBackEdge: true, maxIterations: 4 },
      ],
    })).toBe(4);
  });

  it("does not allow unbounded retries", () => {
    const cap = resolveProducerCap({ id: "p", agentId: "a", dependencies: [] });
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThan(100);
  });
});

describe("hybrid QA — no generic wording/prose validator", () => {
  it("structural gate does not carry HTML/prose validation tool names", () => {
    const gateStep = {
      id: "gate-1", type: "tool", qaType: "structural",
      toolNames: ["validate-machine-contract"], agentId: "", dependencies: ["producer"],
    };
    expect(isStructuralGateStep(gateStep)).toBe(true);
    expect(gateStep.toolNames).not.toContain("validate-html");
    expect(gateStep.toolNames).not.toContain("validate-prose");
  });
});

describe("hybrid QA — planning description includes structural gate guidance", () => {
  const desc = buildMissionPlanningDescription({
    missionId: "m1",
    title: "Test mission",
    description: "Test description",
    runnableCandidates: [],
    runnableRosterLines: ["- agent-1: engineer (tools: validate-schema)"],
  });

  it("includes a structural tool gate section", () => {
    expect(desc).toContain("## Hybrid QA: structural tool gates");
  });

  it("tells the owner to use type:tool + qaType:structural", () => {
    expect(desc).toContain('type:"tool"');
    expect(desc).toContain('qaType:"structural"');
  });

  it("says assigneeAgentId is only a grant subject, not a workflow agentId", () => {
    expect(desc).toContain("plan-time tool grant subject");
    expect(desc).toContain("no workflow agentId");
  });

  it("requires exactly one toolName", () => {
    expect(desc).toContain("exactly one toolName");
  });

  it("prohibits inventing validators or prose rules", () => {
    expect(desc).toContain("Do NOT invent a validator tool");
    expect(desc).toContain("generic HTML/prose structure rules");
  });

  it("keeps semantic QA for coherence/tone/factual/argument/audience", () => {
    expect(desc).toContain("coherence");
    expect(desc).toContain("tone and manner");
    expect(desc).toContain("factual accuracy");
    expect(desc).toContain("argument consistency");
    expect(desc).toContain("audience fitness");
  });

  it("does not ship a fake selected-template structural gate sample", () => {
    // Structural gates are opt-in. The planning prompt must NOT pre-select a
    // placeholder tool name or grant subject; guidance is prose/syntax only.
    expect(desc).not.toContain("registered-tool-name");
    expect(desc).not.toContain("unit-structural-gate-1");
    expect(desc).not.toContain("agent-id-with-tool-grant");
  });

  it("states semantic QA must depend on both producer and gate", () => {
    expect(desc).toContain("depend on BOTH the producer artifact unit AND the structural gate");
    expect(desc).toContain("Do not rely on transitive artifact discovery");
  });

  it("says invalid structural units are rejected", () => {
    expect(desc).toContain("rejected as invalid");
  });
});

describe("hybrid QA — semantic QA prompt scope (exact literals allowed)", () => {
  const text = renderStructuralGateAlreadyRunLines().join("\n");

  it("prohibits generic wording rules", () => {
    expect(text).toContain("Do not invent generic wording rules");
    expect(text).toContain("prose style rules");
    expect(text).toContain("generic HTML structure rules");
  });

  it("allows exact literal verification when user/contract requires it", () => {
    expect(text).toContain("MAY verify an exact literal string");
    expect(text).toContain("real interface contract explicitly requires");
  });

  it("does not say wording is 'not your responsibility'", () => {
    expect(text).not.toContain("not your responsibility");
  });
});

describe("hybrid QA — decision example is consistent and gate-free", () => {
  const desc = buildMissionPlanningDescription({
    missionId: "m1",
    title: "Test",
    description: null,
    runnableCandidates: [],
    runnableRosterLines: [],
  });
  // Extract the JSON block from the decision example
  const jsonMatch = desc.match(/Mission owner plan decision\n```json\n([\s\S]*?)\n```/);
  const example = JSON.parse(jsonMatch![1]);

  it("has unique unit IDs", () => {
    const ids = example.selectedExecutionUnits.map((u: { id: string }) => u.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not pre-select a structural gate sample unit", () => {
    // The example must stay free of opt-in structural gates; guidance is prose only.
    for (const unit of example.selectedExecutionUnits) {
      expect(unit.qaType).not.toBe("structural");
      expect(unit.type).not.toBe("tool");
    }
  });

  it("all dependsOn reference existing unit IDs", () => {
    const ids = new Set(example.selectedExecutionUnits.map((u: { id: string }) => u.id));
    for (const unit of example.selectedExecutionUnits) {
      for (const dep of unit.dependsOn) {
        expect(ids.has(dep)).toBe(true);
      }
    }
  });

  it("every unit carries toolArgs so the copyable canonical shape is complete", () => {
    expect(example.selectedExecutionUnits.length).toBeGreaterThan(0);
    for (const unit of example.selectedExecutionUnits) {
      expect(unit.toolArgs).toEqual({});
    }
  });
});

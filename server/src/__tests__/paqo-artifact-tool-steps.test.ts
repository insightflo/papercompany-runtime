import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildPaqoWorkflowSteps } from "../services/mission-owner-plan-decisions.js";
import { buildWorkflowExecutionSteps } from "../services/workflow/execution-steps.js";
import { classifyWorkflowStepRole } from "../services/workflow-step-role.js";
import { getStructuralTopologyErrors } from "../services/workflow/control-flow/structural-topology.js";
import { artifactTools, artifactUnits, paqoDraft, paqoMission } from "./helpers/paqo-artifact-tool-fixture.js";

const build = (units = artifactUnits(), tools = artifactTools) => buildPaqoWorkflowSteps(paqoDraft(units), paqoMission, { tools });

describe("PAQO artifact-contract tool steps", () => {
  it("materializes QA, publication and verification as issue-less tools with rewritten references", () => {
    const [producer, qa, publisher, verifier, finalQa] = build();
    for (const [step, tool, source, qaType] of [
      [qa, "neutral-review", "source-review", "action"],
      [publisher, "neutral-release", "source-release", undefined],
      [verifier, "neutral-readback", "source-readback", "delivery"],
    ] as const) {
      expect(step).toMatchObject({ agentId: "", type: "tool", toolNames: [tool], sourceStepId: source,
        assigneeAgentId: paqoMission.ownerAgentId, graphWorkProductRequired: false });
      expect(step.qaType).toBe(qaType);
      expect(step.agentName).toBeUndefined();
      expect(step.toolName).toBeUndefined(); // Engine consumes the single toolNames entry.
    }
    expect(qa.toolArgs).toEqual({ content: `{$steps.${producer.id}.workProductPath}` });
    expect(publisher.toolArgs).toEqual({ qaResultPath: `{$steps.${qa.id}.workProductPath}`, content: `{$steps.${producer.id}.workProductPath}` });
    expect(verifier.toolArgs).toEqual({ receiptInput: `{$steps.${publisher.id}.workProductPath}` });
    expect(qa.dependencies).toEqual([producer.id]);
    expect(publisher.dependencies).toEqual([qa.id]);
    expect(verifier.dependencies).toEqual([publisher.id]);
    expect(classifyWorkflowStepRole(qa)).toBe("qa");
    expect(classifyWorkflowStepRole(verifier)).toBe("qa");
    expect(producer.conditionalDependencies).toContainEqual(expect.objectContaining({ stepId: finalQa.id, isBackEdge: true }));
    for (const step of [qa, publisher, verifier]) expect(step.conditionalDependencies).toBeUndefined();
    const frozen = buildWorkflowExecutionSteps({ name: "PAQO", stepsJson: build() }, artifactTools);
    expect(frozen.find(s => s.id === verifier.id)).toMatchObject({ deliveryRole: "publication-verify", qaType: "delivery" });
    expect(frozen.find(s => s.id === publisher.id)).toMatchObject({ deliveryVerification: "required" });
    expect(frozen.some(s => s.id === "delivery-verification-gate")).toBe(false);
  });

  it.each(["toolName", "tools", "toolNames"])("resolves %s aliases and excludes non-artifact search tools", key => {
    const units = artifactUnits();
    delete units[2].toolNames;
    units[2][key] = key === "toolName" ? " neutral-release " : [" neutral-release ", "neutral-release"];
    units[2].tools = [...(Array.isArray(units[2].tools) ? units[2].tools : []), "research-workbench-search"];
    expect(build(units)[2]).toMatchObject({ type: "tool", agentId: "", toolNames: ["neutral-release"] });
  });

  it("fails closed instead of choosing between multiple artifact tools", () => {
    const units = artifactUnits();
    units[2].toolNames = ["neutral-release", "neutral-review"];
    expect(() => build(units)).toThrow("paqo_artifact_tool_ambiguous");
  });

  it("preserves explicit QA type and QA rules", () => {
    const units = artifactUnits();
    units[1].qaType = "editorial";
    units[1].qaConfig = { rules: { "required-fields": { enabled: true, params: { pointers: ["/title"] } } } };
    units[3].qaType = "readback-custom";
    const steps = build(units);
    expect(steps[1]).toMatchObject({ type: "tool", qaType: "editorial", qaConfig: units[1].qaConfig });
    expect(steps[3].qaType).toBe("readback-custom");
  });

  it("keeps declared structural and inserted machine-check gates valid and reworks the agent producer", () => {
    const units = artifactUnits();
    units[0].machineChecks = [{ kind: "file_exists", path: "{$steps.build.workProductPath}" }];
    units[1].type = "tool";
    units[1].qaType = "structural";
    const steps = build(units), producer = steps[0];
    const qa = steps.find(s => s.sourceStepId === "source-review")!;
    expect(qa).toMatchObject({ agentId: "", type: "tool", qaType: "structural" });
    expect(qa.dependencies).toEqual([producer.id, `${producer.id}-mc`]);
    expect(getStructuralTopologyErrors(steps)).toEqual([]);
    expect(steps.filter(s => s.conditionalDependencies?.some(e => e.isBackEdge)).map(s => s.id)).toEqual([producer.id]);
  });

  it("keeps non-artifact units byte-identical to origin/main, even with unrelated or disabled declarations", () => {
    const units = [
      { id: "build", title: "Build", toolNames: ["search"], toolArgs: { query: "paper" } },
      { id: "qa", title: "Review", type: "qa", qaType: "action" },
    ];
    const ordinary = build(units, []);
    const hash = createHash("sha256").update(JSON.stringify(ordinary)).digest("hex");
    // Captured before implementation at origin/main e7f0b14f.
    expect(hash).toBe("441d30b6ed8b1b979de959ec2723dea07e004dc639e42c1ea96c00f886b52880");
    expect(JSON.stringify(build(units))).toBe(JSON.stringify(ordinary));
    expect(JSON.stringify(build(units, [{ ...artifactTools[0], name: "search", enabled: false }]))).toBe(JSON.stringify(ordinary));
    expect(JSON.stringify(build(units, [{ name: "search", adapterConfig: { artifactContract: {} } }]))).toBe(JSON.stringify(ordinary));
  });
});

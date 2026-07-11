import { describe, expect, it } from "vitest";
import { workflowStepDefinitionSchema } from "@paperclipai/shared";
import { classifyWorkflowStepRole } from "../services/workflow-step-role.js";
import {
  isDeliveryReadbackStep,
  synthesizeDeliveryVerificationGateStep,
} from "../services/workflow/delivery-verification-gate.js";
import { normalizeWorkflowStepsForExecution } from "../services/workflow/dag-engine.js";
import { buildWorkflowIssueExecutionCard } from "../services/issue-execution-cards/builder.js";
import { buildStepInputManifest } from "../services/step-input-manifest.js";

describe("workflow QA type", () => {
  it("classifies a custom QA type as a QA step", () => {
    const step = {
      id: "security-review",
      name: "Check release risk",
      qaType: "security",
    };

    expect(classifyWorkflowStepRole(step)).toBe("qa");
  });

  it("uses an explicit QA type before delivery keyword inference", () => {
    const actionQa = {
      id: "content-readback",
      name: "Verify public destination readback",
      qaType: "action",
    };
    const deliveryQa = {
      id: "final-check",
      name: "Check final output",
      qaType: "delivery",
    };

    expect(isDeliveryReadbackStep(actionQa)).toBe(false);
    expect(isDeliveryReadbackStep(deliveryQa)).toBe(true);
  });

  it("validates QA type as an open string field", () => {
    const customType = workflowStepDefinitionSchema.safeParse({
      id: "security-review",
      qaType: "security",
    });
    const invalidType = workflowStepDefinitionSchema.safeParse({
      id: "security-review",
      qaType: 42,
    });

    expect(customType.success).toBe(true);
    expect(invalidType.success).toBe(false);
  });

  it("marks synthesized delivery verification with the delivery QA type", () => {
    const step = synthesizeDeliveryVerificationGateStep({
      dependencyStepIds: ["publish"],
      agentId: "qa-agent",
    });

    expect(Reflect.get(step, "qaType")).toBe("delivery");
    expect(step.description).toContain("QA type: delivery");
  });

  it("uses verdict output semantics for a custom QA type", () => {
    const [step] = normalizeWorkflowStepsForExecution([{
      id: "security-review",
      name: "Check release risk",
      qaType: " Security ",
      graphWorkProductRequired: true,
    }]);

    expect(step?.graphWorkProductRequired).toBe(false);
    expect(Reflect.get(step ?? {}, "qaType")).toBe("security");
  });

  it("records QA type in the workflow execution card", () => {
    const step = {
      id: "security-review",
      dependencies: ["release-candidate"],
      qaType: "security",
    };
    const card = buildWorkflowIssueExecutionCard({
      title: "Security review",
      description: "Review the declared release candidate.",
      companyId: "company-1",
      issueId: "issue-1",
      workflowDefinitionId: "workflow-1",
      workflowRunId: "run-1",
      step,
      isQaStep: true,
    });

    expect(Reflect.get(card.workflow ?? {}, "qaType")).toBe("security");
    expect(Reflect.get(card.workflow ?? {}, "qaInputScope")).toBe("dependency_work_products");
  });

  it("exposes the resolved QA contract in the step input manifest", () => {
    const manifest = buildStepInputManifest({
      taskKey: "workflow:run-1:security-review",
      context: {
        issueId: "issue-1",
        paperclipRuntimeSearchPaths: {
          version: 1,
          workingDirectory: "/workspace",
          outputDirectory: null,
          dependencyFiles: ["/workspace/release.json"],
          dependencyDirectories: ["/workspace"],
          qaType: "security",
          qaInputScope: "dependency_work_products",
        },
      },
    });

    expect(Reflect.get(manifest.inputs, "qualityAssurance")).toEqual({
      available: true,
      type: "security",
      inputScope: "dependency_work_products",
    });
  });
});

import { describe, expect, it } from "vitest";
import { buildPaperclipRuntimeBrief } from "@paperclipai/adapter-utils";

// [목적] runtime brief 가 issue execution card 를 hash+booleans 한 줄이 아니라
//   구조화된 bullet(workProduct/verdict/delivery/workflow/tool/evidence)로 노출하는지 검증.
//   긴 JSON dump 가 아닌 짧은 bullet, 길이 상한이 적용되는지까지 확인.
describe("buildPaperclipRuntimeBrief issue execution card", () => {
  it("summarizes structured issue execution card essentials as bullets", () => {
    const brief = buildPaperclipRuntimeBrief({
      paperclipIssueExecutionCardHash: "cardhash123",
      paperclipIssueExecutionCard: {
        requiredOutputs: {
          workProduct: {
            required: true,
            outputDir: "/runs/out/sector-rotation",
            artifactMarker: "[ARTIFACT]: <absolute path>",
          },
          verdict: {
            required: false,
            ledger: "workflow_validation_verdict",
            allowed: ["PASS", "REQUEST_CHANGES"],
          },
          deliveryReadback: { required: true, marker: null },
        },
        workflow: {
          stepId: "sector-rotation",
          runId: "run-abc",
          qaType: "security",
          qaInputScope: "dependency_work_products",
          dependencyStepIds: ["collect"],
        },
        toolPermissionContract: {
          requiredToolNames: ["manual-onboarding-publish"],
          requiredKnowledgeNames: ["sector-rotation-rubric"],
        },
        evidenceRefs: [
          { type: "output_dir", path: "/runs/out/sector-rotation", description: "step output" },
        ],
      },
      paperclipInstructionInjection: {
        mode: "compact",
        contentHash: "instructionhash123",
      },
    });

    expect(brief).toContain("Issue execution card cardhash123:");
    expect(brief).toContain("Work product: required=true; outputDir=/runs/out/sector-rotation");
    expect(brief).toContain("marker=[ARTIFACT]: <absolute path>");
    expect(brief).toContain("Verdict: required=false; ledger=workflow_validation_verdict");
    expect(brief).toContain("allowed=PASS, REQUEST_CHANGES");
    expect(brief).toContain("Delivery readback: required=true");
    expect(brief).toContain("Workflow API closeout: register artifacts with /workflow/artifacts, register public URLs with /workflow/artifacts type=preview_url, complete with /workflow/complete");
    expect(brief).toContain("use the paperclip skill for request examples");
    expect(brief).toContain("Workflow: step=sector-rotation, run=run-abc; dependsOn=collect");
    expect(brief).toContain("QA type: security; inputScope=dependency_work_products");
    expect(brief).toContain("Use only declared dependency workProduct paths; do not scan the workspace");
    expect(brief).toContain("Available tools: manual-onboarding-publish — use them only when the task needs them; they are not mandatory.");
    expect(brief).toContain("Available knowledge: sector-rotation-rubric");
    expect(brief).toContain("Evidence: step output: /runs/out/sector-rotation");
    expect(brief).toContain("Agent instructions injection: compact (instructionhash123)");
  });

  it("omits the card section when no execution card is present", () => {
    const brief = buildPaperclipRuntimeBrief({
      paperclipIssueExecutionCardHash: null,
      paperclipIssueExecutionCard: null,
    });

    expect(brief).not.toContain("Issue execution card");
  });

  it("caps long dependency and tool arrays to keep the brief bounded", () => {
    const brief = buildPaperclipRuntimeBrief({
      paperclipIssueExecutionCardHash: "cardhash-long",
      paperclipIssueExecutionCard: {
        requiredOutputs: {},
        workflow: {
          stepId: "sector-rotation",
          runId: "run-abc",
          dependencyStepIds: Array.from({ length: 20 }, (_, index) => `dep-${index}`),
        },
        toolPermissionContract: {
          requiredToolNames: Array.from({ length: 20 }, (_, index) => `tool-${index}`),
        },
      },
    });

    // ARRAY_CAP=8 — 9번째 항목은 brief 에 나오지 않는다.
    expect(brief).toContain("dep-7");
    expect(brief).not.toContain("dep-8");
    expect(brief).toContain("tool-7");
    expect(brief).not.toContain("tool-8");
  });
});

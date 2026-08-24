import { describe, expect, it } from "vitest";
import { buildPaperclipRuntimeBrief } from "@paperclipai/adapter-utils";

describe("operator decision resolution runtime brief", () => {
  it("renders the resolved card options as a priority instruction block", () => {
    const brief = buildPaperclipRuntimeBrief({
      paperclipOperatorDecisionResolution: {
        operatorDecisionId: "5d0f6f4e-1111-4111-8111-111111111111",
        options: [
          { id: "rerun_source_collection", label: "원천 수집 재실행", description: "Re-run the source collection step with the registered tool." },
        ],
      },
    });

    expect(brief).toContain("Operator decision resolution — priority instruction (read first):");
    expect(brief).toContain("- Operator decision resolved (card): 원천 수집 재실행 — Re-run the source collection step with the registered tool.");
    expect(brief).toContain("- operatorDecisionId: 5d0f6f4e-1111-4111-8111-111111111111");
    expect(brief).toContain("이 결정은 운영자가 카드에서 선택한 우선 지시다.");
  });

  it("renders every selected option line and tolerates missing descriptions", () => {
    const brief = buildPaperclipRuntimeBrief({
      paperclipOperatorDecisionResolution: {
        operatorDecisionId: "5d0f6f4e-2222-4222-8222-222222222222",
        options: [
          { id: "rerun_source_collection", label: "원천 수집 재실행", description: "Re-run collection." },
          { id: "maintenance_issue", label: "유지보수 이슈 생성", description: null },
        ],
      },
    });

    expect(brief).toContain("- Operator decision resolved (card): 원천 수집 재실행 — Re-run collection.");
    expect(brief).toContain("- Operator decision resolved (card): 유지보수 이슈 생성\n");
  });

  it("omits the block when the resolution context is absent or malformed", () => {
    expect(buildPaperclipRuntimeBrief({})).not.toContain("Operator decision resolution");
    expect(buildPaperclipRuntimeBrief({
      paperclipOperatorDecisionResolution: { options: [{ id: "x", label: "X", description: null }] },
    })).not.toContain("Operator decision resolution");
    expect(buildPaperclipRuntimeBrief({
      paperclipOperatorDecisionResolution: { operatorDecisionId: "", options: [] },
    })).not.toContain("Operator decision resolution");
  });

  it("places the block after the runaway recovery advisory and before ordinary brief lines", () => {
    const brief = buildPaperclipRuntimeBrief({
      paperclipRunawayRecoveryBrief: { kind: "runaway_recovery", logBytes: 5_000_000 },
      paperclipOperatorDecisionResolution: {
        operatorDecisionId: "5d0f6f4e-3333-4333-8333-333333333333",
        options: [{ id: "rerun_source_collection", label: "원천 수집 재실행", description: null }],
      },
      taskKey: "issue-1",
    });

    const advisoryIdx = brief.indexOf("=== RUNAWAY RECOVERY ADVISORY");
    const resolutionIdx = brief.indexOf("Operator decision resolution — priority instruction");
    const taskKeyIdx = brief.indexOf("- Task key: issue-1");
    expect(advisoryIdx).toBeGreaterThanOrEqual(0);
    expect(resolutionIdx).toBeGreaterThan(advisoryIdx);
    expect(taskKeyIdx).toBeGreaterThan(resolutionIdx);
  });
});

import { describe, expect, it } from "vitest";
import { selectTerminalWorkflowAuthoritySource } from "../services/missions/supervision.js";
import type { MissionSupervisionIssue, MissionSupervisionWorkflowStepRow } from "../services/missions/mission-supervision-context.js";

type StepDef = { id: string; dependencies?: string[]; type?: string };

function issue(overrides: Partial<MissionSupervisionIssue> & Pick<MissionSupervisionIssue, "id" | "originKind">): MissionSupervisionIssue {
  return {
    companyId: "company-1",
    missionId: "mission-1",
    status: "todo",
    title: overrides.id,
    hiddenAt: null,
    ...overrides,
  } as MissionSupervisionIssue;
}

function row(stepId: string, issueId: string | null, steps: StepDef[]): MissionSupervisionWorkflowStepRow {
  return {
    run: { id: "run-1", status: "failed" },
    stepRun: { stepId, issueId, status: "failed", metadata: null },
    definition: { stepsJson: steps },
  } as MissionSupervisionWorkflowStepRow;
}

describe("selectTerminalWorkflowAuthoritySource", () => {
  it("prefers mission oversight deterministically for issue-less workflow failures", () => {
    const oversightB = issue({ id: "oversight-b", originKind: "mission_main_executor_oversight" });
    const oversightA = issue({ id: "oversight-a", originKind: "mission_main_executor_oversight" });
    const plan = issue({ id: "plan-a", originKind: "mission_main_executor_plan" });

    const selected = selectTerminalWorkflowAuthoritySource({
      missionIssues: [oversightB, plan, oversightA],
      missionIssueById: new Map(),
      workflowStepRows: [row("tool-step", null, [{ id: "tool-step", type: "tool" }])],
    });

    expect(selected?.id).toBe("oversight-a");
  });

  it("fails closed when no scoped source, oversight, or plan authority exists", () => {
    const selected = selectTerminalWorkflowAuthoritySource({
      missionIssues: [],
      missionIssueById: new Map(),
      workflowStepRows: [row("tool-step", null, [{ id: "tool-step", type: "tool" }])],
    });

    expect(selected).toBeNull();
  });
});

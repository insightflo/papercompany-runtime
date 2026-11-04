import { describe, expect, it } from "vitest";
import { workspaceOperationPhaseLabel, workspaceOperationStatusTone } from "./agent-detail-workspace-display";

describe("workspace operation display", () => {
  it("preserves the labels and status tones", () => {
    expect(workspaceOperationPhaseLabel("worktree_prepare")).toBe("Execution context setup");
    expect(workspaceOperationPhaseLabel("workspace_teardown")).toBe("Teardown");
    expect(workspaceOperationStatusTone("failed")).toContain("red");
    expect(workspaceOperationStatusTone("succeeded")).toContain("green");
  });
});

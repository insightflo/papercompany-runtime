import { describe, expect, it } from "vitest";
import { createIssueSchema } from "@paperclipai/shared/validators/issue";

describe("issue validators", () => {
  it("preserves workflow issue origin fields for plugin-created issues", () => {
    const parsed = createIssueSchema.parse({
      title: "[Oversight] gazua-morning #2026-04-28-1",
      status: "backlog",
      priority: "medium",
      originKind: "mission_main_executor_oversight",
      originId: "workflow-run-1",
      originRunId: "run-1",
    });

    expect(parsed).toMatchObject({
      originKind: "mission_main_executor_oversight",
      originId: "workflow-run-1",
      originRunId: "run-1",
    });
  });
});

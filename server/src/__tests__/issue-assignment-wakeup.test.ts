import { describe, expect, it, vi } from "vitest";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.ts";

describe("queueIssueAssignmentWakeup", () => {
  it("does not wake non-runnable assigned issues", async () => {
    const wakeup = vi.fn();

    for (const status of ["backlog", "blocked", "done", "cancelled"]) {
      await queueIssueAssignmentWakeup({
        heartbeat: { wakeup },
        issue: { id: `issue-${status}`, assigneeAgentId: "agent-1", status },
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "test",
      });
    }

    expect(wakeup).not.toHaveBeenCalled();
  });

  it("wakes assigned todo issues", async () => {
    const wakeup = vi.fn().mockResolvedValue({ id: "run-1" });

    await queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "todo" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "test",
    });

    expect(wakeup).toHaveBeenCalledWith("agent-1", expect.objectContaining({
      source: "assignment",
      payload: { issueId: "issue-1", mutation: "create" },
    }));
  });
});

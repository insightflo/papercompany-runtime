import { expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRunEvents, heartbeatRuns, issues, type createDb } from "@paperclipai/db";
import type { IssueAssignmentWakeupDeps } from "../../services/issue-assignment-wakeup.js";

const { heartbeatWakeup, adapterExecute, admission } = vi.hoisted(() => ({
  heartbeatWakeup: vi.fn<IssueAssignmentWakeupDeps["wakeup"]>().mockResolvedValue({ id: "queued" }),
  adapterExecute: vi.fn(async () => { throw new Error("Unexpected adapter execution in retry CAS test"); }),
  admission: [] as Array<{ incomingIsTestWakeup: boolean; admittedIsTestWakeup: boolean }>,
}));

// Fail closed before DB setup: this suite tests verdict/retry state, not agent execution.
vi.mock("../../adapters/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../adapters/registry.js")>();
  return { ...actual, getServerAdapter: (type: string) => ({
    ...actual.getServerAdapter(type), execute: adapterExecute,
  }) };
});

vi.mock("../../services/issue-assignment-wakeup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/issue-assignment-wakeup.js")>();
  return { ...actual, queueIssueAssignmentWakeup: (
    input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0],
  ) => {
    const boundedInput = { ...input, heartbeat: { wakeup: heartbeatWakeup } };
    admission.push({ incomingIsTestWakeup: input.heartbeat.wakeup === heartbeatWakeup,
      admittedIsTestWakeup: boundedInput.heartbeat.wakeup === heartbeatWakeup });
    // Preserve real assignment skip rules and payload policy, never invoke incoming wakeup.
    return actual.queueIssueAssignmentWakeup(boundedInput);
  } };
});

export function resetRetryBoundary() {
  heartbeatWakeup.mockClear();
  adapterExecute.mockClear();
  admission.length = 0;
}

export async function assertRetryHeartbeatRows(db: ReturnType<typeof createDb>, fixtureIds: string[]) {
  expect(adapterExecute.mock.calls.length).toBe(0);
  expect((await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).map((row) => row.id).sort())
    .toEqual([...fixtureIds].sort());
  expect(await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents)).toEqual([]);
  expect(await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)).toEqual([]);
}

export async function assertSemanticQaAssignment(db: ReturnType<typeof createDb>, expected: {
  companyId: string; agentId: string; runId: string; stepId: string; issueId: string;
}) {
  // Scalars only: never let a failed assertion traverse DB-bearing mock arguments.
  const calls = heartbeatWakeup.mock.calls.map((args) => ({
    arity: args.length, agentId: args[0], source: args[1].source,
    triggerDetail: args[1].triggerDetail, reason: args[1].reason,
    issueId: args[1].payload?.issueId, mutation: args[1].payload?.mutation,
    runId: args[1].contextSnapshot?.workflowRunId, stepId: args[1].contextSnapshot?.workflowStepId,
    contextIssueId: args[1].contextSnapshot?.issueId, contextSource: args[1].contextSnapshot?.source,
  }));
  expect(calls).toEqual([{ arity: 2, agentId: expected.agentId, source: "assignment",
    triggerDetail: "system", reason: "issue_assigned", issueId: expected.issueId, mutation: "create",
    runId: expected.runId, stepId: expected.stepId, contextIssueId: expected.issueId,
    contextSource: "workflow.dispatch" }]);
  expect(admission.length).toBeGreaterThan(0);
  // Assert the dependency actually passed to the real helper, not incoming runtime admission.
  expect(admission.every((entry) => entry.admittedIsTestWakeup)).toBe(true);
  expect(await db.select({ id: issues.id, companyId: issues.companyId, agentId: issues.assigneeAgentId })
    .from(issues).where(eq(issues.id, expected.issueId)))
    .toEqual([{ id: expected.issueId, companyId: expected.companyId, agentId: expected.agentId }]);
}

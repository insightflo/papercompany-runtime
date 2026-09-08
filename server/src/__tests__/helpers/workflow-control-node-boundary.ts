import { expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRunEvents, heartbeatRuns, issues, type createDb } from "@paperclipai/db";
import type { IssueAssignmentWakeupDeps } from "../../services/issue-assignment-wakeup.js";

const { heartbeatWakeup, adapterExecute } = vi.hoisted(() => ({
  heartbeatWakeup: vi.fn<IssueAssignmentWakeupDeps["wakeup"]>().mockResolvedValue({ id: "queued" }),
  adapterExecute: vi.fn(async () => { throw new Error("Unexpected agent adapter execution in control-node test"); }),
}));

// Installed before the heartbeat import graph or any DB setup; never invoke an agent CLI.
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
    // Preserve the actual skip rules and payload policy; only replace external admission.
    return actual.queueIssueAssignmentWakeup({ ...input, heartbeat: { wakeup: heartbeatWakeup } });
  } };
});

export function resetControlNodeBoundary() {
  heartbeatWakeup.mockClear();
  adapterExecute.mockClear();
}

export async function assertNoHeartbeatWriters(db: ReturnType<typeof createDb>) {
  expect(adapterExecute.mock.calls.length).toBe(0);
  expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toEqual([]);
  expect(await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents)).toEqual([]);
  expect(await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)).toEqual([]);
}

export async function assertAgentAssignments(db: ReturnType<typeof createDb>, expected: {
  companyId: string;
  agentId: string;
  runId: string;
  steps: Array<{ stepId: string; issueId: string | null; mutations?: Array<"create" | "workflow_resume"> }>;
}) {
  // Regression: dropping a real producer/publish assignment or dispatching IF/Complete must fail.
  const calls = heartbeatWakeup.mock.calls.map((args) => ({
    arity: args.length, agentId: args[0], source: args[1]?.source,
    triggerDetail: args[1]?.triggerDetail, reason: args[1]?.reason,
    issueId: args[1]?.payload?.issueId, mutation: args[1]?.payload?.mutation,
    runId: args[1]?.contextSnapshot?.workflowRunId,
    stepId: args[1]?.contextSnapshot?.workflowStepId,
    contextIssueId: args[1]?.contextSnapshot?.issueId,
    contextSource: args[1]?.contextSnapshot?.source,
  }));
  expect(calls.length).toBeGreaterThan(0);
  expect([...new Set(calls.map((call) => call.stepId))].sort())
    .toEqual(expected.steps.map((step) => step.stepId).sort());
  for (const step of expected.steps) {
    expect([...new Set(calls.filter((call) => call.stepId === step.stepId).map((call) => call.mutation))].sort())
      .toEqual([...(step.mutations ?? ["create"])].sort());
  }
  for (const call of calls) {
    expect(call.arity).toBe(2);
    expect(call).toMatchObject({ agentId: expected.agentId, runId: expected.runId,
      source: "assignment", triggerDetail: "system" });
    const step = expected.steps.find((entry) => entry.stepId === call.stepId);
    expect(step?.issueId).toBeTruthy();
    expect(call.issueId).toBe(step?.issueId);
    expect(call.contextIssueId).toBe(step?.issueId);
    const policy = call.mutation === "workflow_resume"
      ? { reason: "workflow_step_runnable", contextSource: "workflow.resume" }
      : { reason: "issue_assigned", contextSource: "workflow.dispatch" };
    expect({ reason: call.reason, contextSource: call.contextSource }).toEqual(policy);
    const stored = await db.select({ id: issues.id, companyId: issues.companyId,
      agentId: issues.assigneeAgentId }).from(issues).where(eq(issues.id, step!.issueId!));
    expect(stored).toEqual([{ id: step!.issueId, companyId: expected.companyId, agentId: expected.agentId }]);
  }
}

import { and, eq, inArray } from "drizzle-orm";
import { agents, agentWakeupRequests, issues, workflowStepRuns, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { budgetService } from "../budgets.js";
import { applyIssueCreatedSideEffects } from "../issue-create-side-effects.js";
import { DEFERRED_WAKE_CONTEXT_KEY } from "../heartbeat.js";
import { asBoolean } from "../../adapters/utils.js";
import { wakeIssueBackedRetryAndMarkDispatching } from "./retry-launch-dispatch.js";
import { insertWorkflowWakeRequest } from "../heartbeat-workflow-wake.js";

// Pending first-delivery requests belong to the native queue. A DAG reentry must not
// also call the generic resume wake while the scheduler still owns this exact request.
export async function wakeReplacementAwareIssueRetry<TRun, TDefinition, TStep>(
  input: Parameters<typeof wakeIssueBackedRetryAndMarkDispatching<TRun, TDefinition, TStep>>[0],
) {
  const run = input.run as { metadata?: Record<string, unknown> | null };
  if (!run.metadata?.replacementStart) return wakeIssueBackedRetryAndMarkDispatching(input);
  const [step] = await input.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, input.stepRunId));
  if (step) {
    const [accepted] = await input.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.issueId, input.issueId),
      eq(agentWakeupRequests.workflowRunId, input.workflowRunId), eq(agentWakeupRequests.workflowStepRunId, step.id),
      eq(agentWakeupRequests.workflowExecutionGeneration, step.executionGeneration),
      eq(agentWakeupRequests.idempotencyKey, `replacement-first-agent:${input.workflowRunId}:${step.id}:${step.executionGeneration}`),
      inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"]),
    )).limit(1);
    if (accepted) return;
  }
  return wakeIssueBackedRetryAndMarkDispatching(input);
}

type CreatedInput = Parameters<typeof applyIssueCreatedSideEffects>[0];
type Scope = { runId: string; requests: Array<{ id: string; issueId: string; stepRunId: string }> };
// Only the replacement first-delivery transaction installs this scope. Ordinary DAG dispatch
// retains its existing behavior. No closures, timers or executable wakes escape this transaction.
const scopes = new WeakMap<Db, Scope>();

export async function withReplacementAgentQueue<T>(db: Db, runId: string, deliver: () => Promise<T>) {
  const scope: Scope = { runId, requests: [] };
  scopes.set(db, scope);
  try {
    const result = await deliver();
    for (const request of scope.requests) {
      const [linked] = await db.select({ id: workflowStepRuns.id }).from(workflowStepRuns).where(and(
        eq(workflowStepRuns.id, request.stepRunId), eq(workflowStepRuns.workflowRunId, runId),
        eq(workflowStepRuns.issueId, request.issueId),
      ));
      if (!linked) throw conflict("replacement_agent_delivery_unlinked");
    }
    return { result, agentWakeupRequestIds: scope.requests.map((r) => r.id) };
  } finally { scopes.delete(db); }
}

export async function applyWorkflowIssueCreatedSideEffects(input: CreatedInput) {
  const scope = scopes.get(input.db);
  if (!scope) return applyIssueCreatedSideEffects(input);
  if (!input.issue.assigneeAgentId || input.issue.status !== "todo") throw conflict("replacement_agent_delivery_target_invalid");
  return applyIssueCreatedSideEffects({ ...input, waitForWakeCompletion: true, rethrowOnWakeError: true,
    heartbeat: { wakeup: async (agentId, opts) => {
      const [step] = await input.db.select().from(workflowStepRuns).where(and(
        eq(workflowStepRuns.workflowRunId, scope.runId),
        eq(workflowStepRuns.stepId, String(opts.payload?.workflowStepId ?? "")),
      ));
      const [agent] = await input.db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, input.issue.companyId)));
      if (!step || !agent || opts.payload?.workflowRunId !== scope.runId) throw conflict("replacement_agent_delivery_target_invalid");
      const policy = (agent.runtimeConfig?.heartbeat ?? {}) as Record<string, unknown>;
      const wakeOnDemand = policy.wakeOnDemand ?? policy.wakeOnAssignment ?? policy.wakeOnOnDemand ?? policy.wakeOnAutomation;
      if (!asBoolean(wakeOnDemand, true) || agent.status === "terminated" || agent.status === "pending_approval") {
        throw conflict("replacement_agent_delivery_disabled");
      }
      const [issue] = await input.db.select({ projectId: issues.projectId }).from(issues).where(and(
        eq(issues.id, input.issue.id), eq(issues.companyId, agent.companyId),
      ));
      if (await budgetService(input.db).getInvocationBlock(agent.companyId, agentId, {
        issueId: input.issue.id, projectId: issue?.projectId,
      })) {
        throw conflict("replacement_agent_delivery_budget_blocked");
      }
      // The mission/run lock held by first delivery serializes this exact attempt, including
      // concurrent reentry. Queue + issue + linkage + receipt commit or roll back as one unit.
      const context = { ...opts.contextSnapshot, workflowRunId: scope.runId, workflowStepRunId: step.id };
      const [request] = await insertWorkflowWakeRequest(input.db, {
        companyId: agent.companyId, agentId, source: "assignment", triggerDetail: "system", reason: opts.reason,
        requestKind: "create", issueId: input.issue.id,
        missionId: typeof opts.payload?.missionId === "string" ? opts.payload.missionId : null,
        workflowRunId: scope.runId, workflowStepRunId: step.id, workflowExecutionGeneration: step.executionGeneration,
        payload: { ...opts.payload, workflowStepRunId: step.id, [DEFERRED_WAKE_CONTEXT_KEY]: context },
        status: "queued", idempotencyKey: `replacement-first-agent:${scope.runId}:${step.id}:${step.executionGeneration}`,
        requestedByActorType: opts.requestedByActorType, requestedByActorId: opts.requestedByActorId,
      });
      scope.requests.push({ id: request.id, issueId: input.issue.id, stepRunId: step.id });
      // The existing heartbeat scheduler's resumeQueuedRuns promotes committed requests only.
      // A crash after commit needs no callback/replay wake and cannot duplicate acceptance.
      return request;
    } },
  });
}

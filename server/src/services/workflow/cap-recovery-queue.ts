import { and, eq } from "drizzle-orm";
import { agents, issues, workflowStepRuns } from "@paperclipai/db";
import { insertWorkflowWakeRequest } from "../heartbeat-workflow-wake.js";
import { asBoolean } from "../../adapters/utils.js";
import { DEFERRED_WAKE_CONTEXT_KEY } from "../heartbeat.js";
import { budgetService } from "../budgets.js";
import type { wakeExistingWorkflowStepIssue } from "./dag-engine.js";
import { loadExecutionDefinition } from "./execution-definition.js";
import { evaluateSemanticStructuralReadiness } from "./control-flow/structural-semantic-readiness.js";
import { loadDownstreamQaCapAcceptanceContext } from "./control-flow/qa-cap-acceptance-context.js";
import { buildQaCapAcceptanceRuntimeContract } from "./control-flow/qa-cap-runtime-contract.js";
import { resolveEdges } from "./control-flow/edge-condition.js";

/** Cap-only native queue insertion. The heartbeat scheduler sees it only after commit. */
export const queueCapRecovery: typeof wakeExistingWorkflowStepIssue = async (input) => {
  const { db, run } = input;
  const execution = await loadExecutionDefinition(db, run.id, { requireHistorical: false });
  const step = execution.steps.find((s) => s.id === input.step.id);
  if (!step) return false;
  const readiness = await evaluateSemanticStructuralReadiness({ db, companyId: run.companyId,
    workflowRunId: run.id, step, steps: execution.steps });
  if (!readiness.ready) return false;
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, run.companyId))).for("update");
  const [stepRun] = await db.select().from(workflowStepRuns).where(and(eq(workflowStepRuns.id, input.stepRunId!), eq(workflowStepRuns.workflowRunId, run.id)));
  if (!issue?.assigneeAgentId || !stepRun || stepRun.issueId !== issue.id || issue.missionId !== run.missionId
    || !(issue.status === "todo" || (input.allowBlockedIssue && issue.status === "blocked"))) return false;
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, issue.assigneeAgentId), eq(agents.companyId, run.companyId)));
  if (!agent || ["terminated", "pending_approval", "paused"].includes(agent.status)) return false;
  const policy = (agent.runtimeConfig?.heartbeat ?? {}) as Record<string, unknown>;
  if (!asBoolean(policy.wakeOnDemand ?? policy.wakeOnAssignment ?? policy.wakeOnOnDemand ?? policy.wakeOnAutomation, true)
    || await budgetService(db).getInvocationBlock(run.companyId, agent.id, { issueId: issue.id, projectId: issue.projectId })) return false;
  const acceptance = await loadDownstreamQaCapAcceptanceContext({ db, workflowRunId: run.id,
    predecessorStepIds: resolveEdges(step).filter((e) => e.isBackEdge !== true).map((e) => e.stepId) });
  const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id));
  const contract = buildQaCapAcceptanceRuntimeContract({ qaStep: step, qaIssueId: issue.id, steps: execution.steps, stepRuns: steps });
  const context = { issueId: issue.id, taskId: issue.id, missionId: run.missionId,
    workflowRunId: run.id, workflowDefinitionId: run.workflowId, workflowStepRunId: stepRun.id,
    workflowStepId: step.id, stepId: step.id, source: "workflow.resume", wakeReason: "workflow_step_runnable",
    ...(readiness.coverage.length ? { structuralGateCoverage: readiness.coverage } : {}),
    ...(acceptance.accepted.length ? { acceptedQaLimitations: acceptance } : {}),
    ...(contract ? { paperclipQaCapAcceptanceContract: contract } : {}) };
  await insertWorkflowWakeRequest(db, { companyId: run.companyId, agentId: agent.id,
    source: "assignment", triggerDetail: "system", reason: "workflow_step_runnable", requestKind: "workflow_resume",
    issueId: issue.id, missionId: run.missionId, workflowRunId: run.id, workflowStepRunId: stepRun.id,
    workflowExecutionGeneration: stepRun.executionGeneration, status: "queued", idempotencyKey: input.idempotencyKey,
    requestedByActorType: "system", requestedByActorId: `workflow:${run.workflowId}`,
    payload: { ...context, mutation: "workflow_resume", [DEFERRED_WAKE_CONTEXT_KEY]: context },
  });
  return true;
};

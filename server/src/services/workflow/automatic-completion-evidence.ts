import { and, desc, eq, isNull, ne } from "drizzle-orm";
import {
  heartbeatRuns,
  issueWorkProducts,
  issues,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
  type Db,
} from "@paperclipai/db";
import { workProductProducerSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { loadExecutionDefinition } from "./execution-definition.js";
import { workProductProducerMismatches } from "./workproduct-producer-comparison.js";
import { producerAttempt } from "../work-products/producer-attempt.js";
import type { WorkflowValidationLedgerResult } from "./validation-verdict-ledger.js";

type IssueScope = Pick<typeof issues.$inferSelect, "id" | "companyId" | "missionId" | "originKind" | "assigneeAgentId">;
type Heartbeat = typeof heartbeatRuns.$inferSelect;

export type AutomaticCompletionEvidence =
  | { status: "eligible"; kind: "work_product" | "workflow_validation_verdict"; evidenceId: string }
  | { status: "missing_evidence"; reason: "current_completion_evidence_absent" }
  | { status: "stale_or_unknown"; reason: "workflow_link_unverified" | "workflow_attempt_unverified" };

const missingEvidence: AutomaticCompletionEvidence = {
  status: "missing_evidence",
  reason: "current_completion_evidence_absent",
};

function stale(reason: "workflow_link_unverified" | "workflow_attempt_unverified"): AutomaticCompletionEvidence {
  return { status: "stale_or_unknown", reason };
}

/** Read-only proof for automatic closeout of a current workflow execution issue. */
export async function assessAutomaticCompletionEvidence(input: {
  db: Pick<Db, "select">;
  issue: IssueScope;
  heartbeat: Heartbeat;
  validationLedger: WorkflowValidationLedgerResult | null;
}): Promise<AutomaticCompletionEvidence> {
  const { db, issue, heartbeat, validationLedger } = input;
  if (issue.originKind !== "workflow_execution"
    || !issue.assigneeAgentId
    || heartbeat.companyId !== issue.companyId
    || heartbeat.issueId !== issue.id
    || heartbeat.agentId !== issue.assigneeAgentId
    || !heartbeat.startedAt
    || !heartbeat.workflowStepRunId
    || heartbeat.workflowExecutionGeneration === null) {
    return stale("workflow_link_unverified");
  }

  const [linked] = await db.select({ step: workflowStepRuns, workflow: workflowRuns })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
    .where(and(
      eq(workflowStepRuns.id, heartbeat.workflowStepRunId),
      eq(workflowStepRuns.issueId, issue.id),
      eq(workflowRuns.companyId, issue.companyId),
      issue.missionId === null ? isNull(workflowRuns.missionId) : eq(workflowRuns.missionId, issue.missionId),
      eq(workflowStepRuns.status, "running"),
      eq(workflowRuns.status, "running"),
    )).limit(1);
  const step = linked?.step;
  const workflow = linked?.workflow;
  if (!step || !workflow || step.executionGeneration !== heartbeat.workflowExecutionGeneration) {
    return stale("workflow_link_unverified");
  }

  let definitionStep;
  try {
    const definition = await loadExecutionDefinition(db, workflow.id, { requireHistorical: false });
    definitionStep = definition.steps.find(candidate => candidate.id === step.stepId);
  } catch {
    return stale("workflow_link_unverified");
  }
  const stepType = typeof definitionStep?.type === "string" ? definitionStep.type.trim().toLowerCase() : "";
  if (!definitionStep?.agentId || ["if", "complete", "workflow", "tool", "approval"].includes(stepType)) {
    return stale("workflow_link_unverified");
  }

  let attempt: Awaited<ReturnType<typeof producerAttempt>>;
  try {
    attempt = await producerAttempt(db, heartbeat, step);
  } catch {
    return stale("workflow_attempt_unverified");
  }
  if (attempt.retryCount !== step.retryCount || attempt.iterationIndex !== step.iterationIndex) {
    return stale("workflow_attempt_unverified");
  }

  const products = await db.select().from(issueWorkProducts).where(and(
    eq(issueWorkProducts.companyId, issue.companyId),
    eq(issueWorkProducts.issueId, issue.id),
    eq(issueWorkProducts.createdByRunId, heartbeat.id),
    ne(issueWorkProducts.status, "archived"),
  ));
  for (const product of products) {
    const parsed = workProductProducerSchema.safeParse(product.metadata?.workflowProducer);
    if (!parsed.success || parsed.data.heartbeatRunId !== heartbeat.id) continue;
    if (workProductProducerMismatches(parsed.data, {
      companyId: issue.companyId,
      workflowRunId: workflow.id,
      run: workflow,
      step,
      product,
    }).length > 0) continue;
    if (parsed.data.retryCount !== attempt.retryCount || parsed.data.iterationIndex !== attempt.iterationIndex) continue;
    return { status: "eligible", kind: "work_product", evidenceId: product.id };
  }

  if (!validationLedger?.isCandidate
    || !validationLedger.satisfied
    || (validationLedger.verdict !== "pass" && validationLedger.verdict !== "request_changes")
    || validationLedger.workflowRunId !== workflow.id
    || validationLedger.workflowStepRunId !== step.id) {
    return missingEvidence;
  }

  const [verdict] = await db.select({
    id: workflowTransitionEvents.id,
    verdict: workflowTransitionEvents.verdict,
    heartbeatRunId: workflowTransitionEvents.heartbeatRunId,
  }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, issue.companyId),
    eq(workflowTransitionEvents.issueId, issue.id),
    eq(workflowTransitionEvents.workflowRunId, workflow.id),
    eq(workflowTransitionEvents.workflowStepRunId, step.id),
    eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
    eq(workflowTransitionEvents.reason, "workflow_api"),
  )).orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id)).limit(1);

  if (!verdict
    || verdict.heartbeatRunId !== heartbeat.id
    || verdict.verdict !== validationLedger.verdict) {
    return missingEvidence;
  }
  return { status: "eligible", kind: "workflow_validation_verdict", evidenceId: verdict.id };
}

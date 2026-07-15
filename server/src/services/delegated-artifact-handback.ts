import type { Db } from "@paperclipai/db";
import { activityLog, issueComments, workflowDefinitions, workflowRuns } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  queueIssueAssignmentWakeup,
  type IssueAssignmentWakeupDeps,
} from "./issue-assignment-wakeup.js";
import { findExistingWorkflowResumeWake } from "./workflow-resume-wake.js";
import { evaluateSemanticStructuralReadiness } from "./workflow/control-flow/structural-semantic-readiness.js";
import type { WorkflowStep } from "./workflow/dag-engine.js";
import {
  hasExistingHandbackDispatch,
  loadActiveChildWorkProduct,
  loadDelegatedChildIssue,
  loadDelegatedParentIssue,
  loadDelegatedParentStepRun,
  parentHasActiveWorkProduct,
  type DelegatedChildIssue,
  type DelegatedChildWorkProduct,
  type DelegatedParentIssue,
} from "./delegated-artifact-handback-records.js";

const HANDOFF_PARENT_STATUSES = new Set(["todo", "in_progress", "in_review", "blocked"]);

type ActorType = "agent" | "user" | "system";

type HandbackSkipReason =
  | "child_issue_not_found"
  | "child_has_no_parent"
  | "child_work_product_not_found"
  | "parent_issue_not_found"
  | "parent_not_workflow_execution"
  | "parent_not_runnable"
  | "parent_unassigned"
  | "parent_has_active_work_product"
  | "parent_workflow_step_run_not_found"
  | "already_dispatched";

export type DelegatedArtifactHandbackResult =
  | { status: "skipped"; reason: HandbackSkipReason }
  | {
      status: "handled";
      parentIssueId: string;
      childIssueId: string;
      childWorkProductId: string;
      workflowRunId: string;
      workflowStepRunId: string;
      commentCreated: boolean;
      wakeupRequested: boolean;
      idempotencyKey: string;
      existingWorkflowWakeupRequestId: string | null;
    };

function issueLabel(issue: Pick<DelegatedChildIssue, "id" | "identifier">) {
  return issue.identifier ? `${issue.identifier} (${issue.id})` : issue.id;
}

function buildIdempotencyKey(input: {
  parentIssueId: string;
  childIssueId: string;
  childWorkProductId: string;
}) {
  return `delegated-artifact-handback:${input.parentIssueId}:${input.childIssueId}:${input.childWorkProductId}`;
}

function buildHandbackComment(input: {
  childIssue: Pick<DelegatedChildIssue, "id" | "identifier" | "title">;
  childWorkProduct: Pick<DelegatedChildWorkProduct, "id" | "title" | "type" | "provider">;
}) {
  return [
    "Delegated artifact ready for this workflow step.",
    "",
    `Child issue: ${issueLabel(input.childIssue)} - ${input.childIssue.title}`,
    `Child workProduct: ${input.childWorkProduct.title} (${input.childWorkProduct.type}/${input.childWorkProduct.provider}, ${input.childWorkProduct.id})`,
    "",
    "Parent action: inspect the child workProduct from the wakeup payload, then register the accepted artifact on this workflow issue with the Workflow API and complete the step. If the artifact is not acceptable, reject it and regenerate in this parent step.",
  ].join("\n");
}

export async function handleDelegatedArtifactHandback(input: {
  db: Db;
  heartbeat: IssueAssignmentWakeupDeps;
  childIssueId: string;
  childWorkProductId: string;
  requestedByActorType?: ActorType;
  requestedByActorId?: string | null;
  sourceRunId?: string | null;
}): Promise<DelegatedArtifactHandbackResult> {
  const childIssue = await loadDelegatedChildIssue(input.db, input.childIssueId);
  if (!childIssue) return { status: "skipped", reason: "child_issue_not_found" };
  if (!childIssue.parentId) return { status: "skipped", reason: "child_has_no_parent" };

  const childWorkProduct = await loadActiveChildWorkProduct(input.db, {
    childIssue,
    childWorkProductId: input.childWorkProductId,
  });
  if (!childWorkProduct) return { status: "skipped", reason: "child_work_product_not_found" };

  const parentIssue = await loadDelegatedParentIssue(input.db, {
    parentIssueId: childIssue.parentId,
    companyId: childIssue.companyId,
  });
  if (!parentIssue || parentIssue.hiddenAt) return { status: "skipped", reason: "parent_issue_not_found" };
  if (parentIssue.originKind !== "workflow_execution") {
    return { status: "skipped", reason: "parent_not_workflow_execution" };
  }
  if (!HANDOFF_PARENT_STATUSES.has(parentIssue.status)) {
    return { status: "skipped", reason: "parent_not_runnable" };
  }
  if (!parentIssue.assigneeAgentId) return { status: "skipped", reason: "parent_unassigned" };

  if (await parentHasActiveWorkProduct(input.db, parentIssue)) {
    return { status: "skipped", reason: "parent_has_active_work_product" };
  }

  const parentStepRun = await loadDelegatedParentStepRun(input.db, parentIssue);
  if (!parentStepRun) return { status: "skipped", reason: "parent_workflow_step_run_not_found" };

  // Handback has its own workflow_resume queue path. Keep it behind the same
  // exact structural-PASS guard as normal/reconciler resumes.
  const workflowContext = await input.db
    .select({ run: workflowRuns, definition: workflowDefinitions })
    .from(workflowRuns)
    .innerJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
    .where(and(
      eq(workflowRuns.id, parentStepRun.workflowRunId),
      eq(workflowRuns.companyId, parentIssue.companyId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!workflowContext) return { status: "skipped", reason: "parent_workflow_step_run_not_found" };
  const workflowSteps = Array.isArray(workflowContext.definition.stepsJson)
    ? workflowContext.definition.stepsJson as WorkflowStep[]
    : [];
  const parentStep = workflowSteps.find((step) => step.id === parentStepRun.stepId);
  if (!parentStep) return { status: "skipped", reason: "parent_workflow_step_run_not_found" };
  const structuralReadiness = await evaluateSemanticStructuralReadiness({
    db: input.db,
    companyId: parentIssue.companyId,
    workflowRunId: parentStepRun.workflowRunId,
    step: parentStep,
    steps: workflowSteps,
  });
  if (!structuralReadiness.ready) return { status: "skipped", reason: "parent_not_runnable" };

  const idempotencyKey = buildIdempotencyKey({
    parentIssueId: parentIssue.id,
    childIssueId: childIssue.id,
    childWorkProductId: childWorkProduct.id,
  });

  if (await hasExistingHandbackDispatch(input.db, { parentIssue, childWorkProduct, idempotencyKey })) {
    return { status: "skipped", reason: "already_dispatched" };
  }

  await input.db.insert(issueComments).values({
    companyId: parentIssue.companyId,
    issueId: parentIssue.id,
    authorUserId: "delegated-artifact-handback",
    body: buildHandbackComment({
      childIssue,
      childWorkProduct,
    }),
  });

  await input.db.insert(activityLog).values({
    companyId: parentIssue.companyId,
    actorType: "system",
    actorId: "delegated-artifact-handback",
    action: "issue.delegated_artifact_handback_ready",
    entityType: "issue",
    entityId: parentIssue.id,
    runId: input.sourceRunId ?? null,
    details: {
      parentIssueId: parentIssue.id,
      parentIssueIdentifier: parentIssue.identifier,
      childIssueId: childIssue.id,
      childIssueIdentifier: childIssue.identifier,
      childWorkProductId: childWorkProduct.id,
      workflowRunId: parentStepRun.workflowRunId,
      workflowStepRunId: parentStepRun.id,
      stepId: parentStepRun.stepId,
      idempotencyKey,
    },
  });

  const existingWake = await findExistingWorkflowResumeWake(input.db, {
    companyId: parentIssue.companyId,
    agentId: parentIssue.assigneeAgentId,
    issueId: parentIssue.id,
  });
  if (existingWake) {
    return {
      status: "handled",
      parentIssueId: parentIssue.id,
      childIssueId: childIssue.id,
      childWorkProductId: childWorkProduct.id,
      workflowRunId: parentStepRun.workflowRunId,
      workflowStepRunId: parentStepRun.id,
      commentCreated: true,
      wakeupRequested: false,
      idempotencyKey,
      existingWorkflowWakeupRequestId: existingWake.id,
    };
  }

  await queueIssueAssignmentWakeup({
    heartbeat: input.heartbeat,
    issue: {
      id: parentIssue.id,
      assigneeAgentId: parentIssue.assigneeAgentId,
      status: parentIssue.status,
    },
    reason: "workflow_step_runnable",
    mutation: "workflow_resume",
    contextSource: "delegated_artifact_handback",
    idempotencyKey,
    payload: {
      delegatedArtifactHandback: true,
      childIssueId: childIssue.id,
      childIssueIdentifier: childIssue.identifier,
      childWorkProductId: childWorkProduct.id,
      childWorkProductTitle: childWorkProduct.title,
      childWorkProductType: childWorkProduct.type,
      childWorkProductProvider: childWorkProduct.provider,
      childWorkProductExternalId: childWorkProduct.externalId,
      childWorkProductUrl: childWorkProduct.url,
      workflowRunId: parentStepRun.workflowRunId,
      workflowStepRunId: parentStepRun.id,
      stepId: parentStepRun.stepId,
    },
    contextSnapshot: {
      issueId: parentIssue.id,
      missionId: parentIssue.missionId ?? childIssue.missionId,
      workflowRunId: parentStepRun.workflowRunId,
      workflowStepRunId: parentStepRun.id,
      stepId: parentStepRun.stepId,
      delegatedArtifactHandback: true,
      childIssueId: childIssue.id,
      childWorkProductId: childWorkProduct.id,
    },
    requestedByActorType: input.requestedByActorType ?? "system",
    requestedByActorId: input.requestedByActorId ?? "delegated-artifact-handback",
  });

  return {
    status: "handled",
    parentIssueId: parentIssue.id,
    childIssueId: childIssue.id,
    childWorkProductId: childWorkProduct.id,
    workflowRunId: parentStepRun.workflowRunId,
    workflowStepRunId: parentStepRun.id,
    commentCreated: true,
    wakeupRequested: true,
    idempotencyKey,
    existingWorkflowWakeupRequestId: null,
  };
}

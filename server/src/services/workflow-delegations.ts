import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companies,
  issueComments,
  issueWorkProducts,
  issues,
  workflowDelegations,
  workflowStepRuns,
  type workflowDefinitions,
  type workflowRuns,
} from "@paperclipai/db";
import { applyIssueCreatedSideEffects } from "./issue-create-side-effects.js";
import { issueService } from "./issues.js";
import { heartbeatService } from "./heartbeat.js";
import type { WorkflowStep } from "./workflow/dag-engine.js";
import { completeWorkflowToolStepFromResult } from "./workflow/dag-engine.js";

export const WORKFLOW_DELEGATION_TOOL_NAME = "delegate_to_company";

type DelegateArgs = Record<string, unknown>;

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readDelegateArgs(rawArgs: unknown): DelegateArgs {
  return rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
    ? rawArgs as DelegateArgs
    : {};
}

function resolveTargetCompanyId(args: DelegateArgs): string | null {
  return readString(args.targetCompanyId)
    ?? readString(args.companyId)
    ?? readString(args.remoteCompanyId);
}

function buildDelegationTitle(input: {
  definition: typeof workflowDefinitions.$inferSelect;
  step: WorkflowStep;
  args: DelegateArgs;
}): string {
  return readString(input.args.title)
    ?? readString(input.args.targetTitle)
    ?? `${input.definition.name}: ${input.step.name}`;
}

function buildSourceDescription(input: {
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
  step: WorkflowStep;
  targetCompanyId: string;
  targetTitle: string;
  targetDescription: string | null;
}): string {
  return [
    `Delegated workflow step waiting for company ${input.targetCompanyId}.`,
    "",
    "Workflow execution boundary:",
    `- workflowRunId: ${input.run.id}`,
    `- workflowDefinitionId: ${input.definition.id}`,
    `- missionId: ${input.run.missionId ?? "none"}`,
    `- stepId: ${input.step.id}`,
    `- targetCompanyId: ${input.targetCompanyId}`,
    "",
    `Delegated title: ${input.targetTitle}`,
    input.targetDescription ? `Delegated description:\n${input.targetDescription}` : null,
    "",
    "This tracker issue is closed automatically when the delegated target issue is completed.",
  ].filter((line): line is string => line !== null).join("\n");
}

function buildTargetDescription(input: {
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
  step: WorkflowStep;
  sourceIssueId: string;
  sourceIssueIdentifier: string | null;
  argsDescription: string | null;
}): string {
  return [
    input.argsDescription,
    "",
    "Cross-company delegation boundary:",
    `- sourceCompanyId: ${input.run.companyId}`,
    `- sourceWorkflowRunId: ${input.run.id}`,
    `- sourceWorkflowDefinitionId: ${input.definition.id}`,
    `- sourceWorkflowStepId: ${input.step.id}`,
    `- sourceTrackerIssueId: ${input.sourceIssueId}`,
    `- sourceTrackerIssueIdentifier: ${input.sourceIssueIdentifier ?? "none"}`,
    "",
    "Official workProduct contract:",
    "- Register generated files/reports/data on this delegated issue with POST /api/issues/{issueId}/work-products before marking done.",
    "- The source workflow will copy those registered workProducts back to the source tracker issue when this issue is done.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export async function startDelegatedWorkflowStep(input: {
  db: Db;
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
  step: WorkflowStep;
  stepRun: typeof workflowStepRuns.$inferSelect;
  args: unknown;
  now: Date;
}): Promise<boolean> {
  const args = readDelegateArgs(input.args);
  const targetCompanyId = resolveTargetCompanyId(args);
  if (!targetCompanyId || targetCompanyId === input.run.companyId) return false;

  const existingDelegation = await input.db
    .select()
    .from(workflowDelegations)
    .where(eq(workflowDelegations.sourceWorkflowStepRunId, input.stepRun.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (existingDelegation) {
    await input.db
      .update(workflowStepRuns)
      .set({
        issueId: existingDelegation.sourceIssueId,
        status: existingDelegation.status === "failed" ? "failed" : existingDelegation.status === "completed" ? "completed" : "running",
        startedAt: input.stepRun.startedAt ?? input.now,
        completedAt: existingDelegation.completedAt ?? null,
      })
      .where(eq(workflowStepRuns.id, input.stepRun.id));
    return true;
  }

  const [targetCompany] = await input.db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, targetCompanyId))
    .limit(1);
  if (!targetCompany) return false;

  const issueSvc = issueService(input.db);
  const targetTitle = buildDelegationTitle({
    definition: input.definition,
    step: input.step,
    args,
  });
  const targetDescription = readString(args.description) ?? readString(args.targetDescription);
  const priority = readString(args.priority) ?? "medium";

  const sourceIssue = await issueSvc.create(input.run.companyId, {
    title: `[DELEGATED] ${targetTitle}`,
    description: buildSourceDescription({
      run: input.run,
      definition: input.definition,
      step: input.step,
      targetCompanyId,
      targetTitle,
      targetDescription,
    }),
    status: "in_review",
    priority,
    missionId: input.run.missionId ?? null,
    originKind: "workflow_execution",
    originId: input.run.id,
    originRunId: input.run.id,
  });

  const targetIssue = await issueSvc.create(targetCompanyId, {
    title: targetTitle,
    description: buildTargetDescription({
      run: input.run,
      definition: input.definition,
      step: input.step,
      sourceIssueId: sourceIssue.id,
      sourceIssueIdentifier: sourceIssue.identifier ?? null,
      argsDescription: targetDescription,
    }),
    status: "todo",
    priority,
    projectId: readString(args.targetProjectId) ?? null,
    assigneeAgentId: readString(args.targetAssigneeAgentId) ?? readString(args.assigneeAgentId) ?? null,
    originKind: "workflow_delegation_target",
    originId: input.stepRun.id,
    originRunId: input.run.id,
  });

  await input.db.insert(workflowDelegations).values({
    sourceCompanyId: input.run.companyId,
    sourceWorkflowRunId: input.run.id,
    sourceWorkflowStepRunId: input.stepRun.id,
    sourceIssueId: sourceIssue.id,
    targetCompanyId,
    targetIssueId: targetIssue.id,
    status: "active",
    metadata: {
      workflowId: input.definition.id,
      stepId: input.step.id,
      toolName: WORKFLOW_DELEGATION_TOOL_NAME,
    },
  });

  await input.db
    .update(workflowStepRuns)
    .set({
      issueId: sourceIssue.id,
      status: "running",
      startedAt: input.stepRun.startedAt ?? input.now,
      completedAt: null,
    })
    .where(eq(workflowStepRuns.id, input.stepRun.id));

  await input.db.insert(issueComments).values({
    companyId: sourceIssue.companyId,
    issueId: sourceIssue.id,
    authorUserId: "system",
    body: `Delegated to company ${targetCompanyId} as ${targetIssue.identifier ?? targetIssue.id}.`,
  });

  await applyIssueCreatedSideEffects({
    db: input.db,
    heartbeat: heartbeatService(input.db),
    issue: targetIssue,
    actor: {
      actorType: "system",
      actorId: `workflow:${input.definition.id}`,
    },
    contextSource: "workflow.delegation.dispatch",
    waitForWakeCompletion: true,
  });

  return true;
}

async function copyTargetWorkProductsToSource(input: {
  db: Db;
  delegation: typeof workflowDelegations.$inferSelect;
}) {
  if (!input.delegation.sourceIssueId) return;

  const [sourceIssue] = await input.db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, input.delegation.sourceIssueId))
    .limit(1);
  if (!sourceIssue) return;

  const targetProducts = await input.db
    .select()
    .from(issueWorkProducts)
    .where(eq(issueWorkProducts.issueId, input.delegation.targetIssueId));
  if (targetProducts.length === 0) return;

  for (const product of targetProducts) {
    const delegatedExternalId = `delegated:${product.id}`;
    const [existing] = await input.db
      .select({ id: issueWorkProducts.id })
      .from(issueWorkProducts)
      .where(and(
        eq(issueWorkProducts.companyId, input.delegation.sourceCompanyId),
        eq(issueWorkProducts.issueId, input.delegation.sourceIssueId),
        eq(issueWorkProducts.provider, "delegated"),
        eq(issueWorkProducts.externalId, delegatedExternalId),
      ))
      .limit(1);
    if (existing) continue;

    await input.db.insert(issueWorkProducts).values({
      companyId: input.delegation.sourceCompanyId,
      projectId: sourceIssue.projectId ?? null,
      issueId: input.delegation.sourceIssueId,
      type: product.type,
      provider: "delegated",
      externalId: delegatedExternalId,
      title: product.title,
      url: product.url,
      status: product.status,
      reviewState: product.reviewState,
      isPrimary: product.isPrimary,
      healthStatus: product.healthStatus,
      summary: product.summary,
      metadata: {
        delegatedFrom: {
          companyId: input.delegation.targetCompanyId,
          issueId: input.delegation.targetIssueId,
          workProductId: product.id,
        },
        originalProvider: product.provider,
        originalExternalId: product.externalId,
        originalMetadata: product.metadata ?? null,
      },
    });
  }
}

export async function finalizeDelegatedWorkflowTargetIssue(
  db: Db,
  input: {
    targetIssueId: string;
    targetStatus: string;
  },
): Promise<{
  delegationId: string;
  sourceWorkflowRunId: string;
  sourceWorkflowStepRunId: string;
  status: "completed" | "failed";
} | null> {
  if (input.targetStatus !== "done" && input.targetStatus !== "blocked" && input.targetStatus !== "cancelled") {
    return null;
  }

  const delegation = await db
    .select()
    .from(workflowDelegations)
    .where(eq(workflowDelegations.targetIssueId, input.targetIssueId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!delegation || delegation.status !== "active") return null;

  const now = new Date();
  const success = input.targetStatus === "done";
  if (success) {
    await copyTargetWorkProductsToSource({ db, delegation });
  }

  if (delegation.sourceIssueId) {
    await db
      .update(issues)
      .set({
        status: success ? "done" : input.targetStatus === "cancelled" ? "cancelled" : "blocked",
        completedAt: success ? now : null,
        cancelledAt: input.targetStatus === "cancelled" ? now : null,
        updatedAt: now,
      })
      .where(eq(issues.id, delegation.sourceIssueId));
  }

  await db
    .update(workflowDelegations)
    .set({
      status: success ? "completed" : "failed",
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(workflowDelegations.id, delegation.id));

  await completeWorkflowToolStepFromResult(db, {
    companyId: delegation.sourceCompanyId,
    stepRunId: delegation.sourceWorkflowStepRunId,
    success,
  });

  return {
    delegationId: delegation.id,
    sourceWorkflowRunId: delegation.sourceWorkflowRunId,
    sourceWorkflowStepRunId: delegation.sourceWorkflowStepRunId,
    status: success ? "completed" : "failed",
  };
}

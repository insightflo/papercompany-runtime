import type { Db } from "@paperclipai/db";
import { logActivity } from "../activity-log.js";
import type { MaintenanceDecisionContext } from "./decision-context.js";

export type MaintenanceDecisionAuditInput = {
  db: Db;
  companyId: string;
  agentId: string;
  runId: string;
  issue: {
    id: string;
    identifier?: string | null;
    projectId?: string | null;
  };
  workflow?: {
    workflowRunId?: string | null;
    workflowId?: string | null;
    stepId?: string | null;
    stepName?: string | null;
  } | null;
  decision: MaintenanceDecisionContext;
};

export async function logMaintenanceDecisionEvaluated(input: MaintenanceDecisionAuditInput): Promise<void> {
  await logActivity(input.db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: "maintenance-decision-preflight",
    action: "maintenance_decision_evaluated",
    entityType: "issue",
    entityId: input.issue.id,
    agentId: input.agentId,
    runId: input.runId,
    details: {
      issueId: input.issue.id,
      issueIdentifier: input.issue.identifier ?? null,
      projectId: input.issue.projectId ?? null,
      runId: input.runId,
      agentId: input.agentId,
      workflowRunId: input.workflow?.workflowRunId ?? null,
      workflowId: input.workflow?.workflowId ?? null,
      workflowStepId: input.workflow?.stepId ?? null,
      workflowStepName: input.workflow?.stepName ?? null,
      recommendedNextAction: input.decision.recommendedNextAction,
      suggestedStatus: input.decision.suggestedStatus,
      requiredInputs: input.decision.requiredInputs,
      warnings: input.decision.warnings,
      handoffTarget: input.decision.handoffTarget,
      matchedRules: input.decision.matchedRules,
      kbReferences: input.decision.kbReferences.map((reference) => ({
        id: reference.id,
        name: reference.name,
        source: reference.source,
      })),
    },
  });
}

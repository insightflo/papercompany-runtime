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

type MaintenanceDecisionActor = {
  actorType: "agent" | "user" | "system";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
};

export type MaintenanceDecisionActionMismatch = {
  attemptedAction: string;
  attemptedStatus: string | null;
  mismatchReasons: string[];
};

export type MaintenanceDecisionActionMismatchInput = {
  decision: MaintenanceDecisionContext;
  attemptedAction: string;
  attemptedStatus?: string | null;
  attemptedComment?: string | null;
};

export type MaintenanceDecisionActionMismatchAuditInput = MaintenanceDecisionActionMismatchInput & {
  db: Db;
  companyId: string;
  actor: MaintenanceDecisionActor;
  issue: {
    id: string;
    identifier?: string | null;
    projectId?: string | null;
  };
};

const TERMINAL_ATTEMPTED_STATUSES = new Set(["done", "cancelled", "closed"]);

export function evaluateMaintenanceDecisionActionMismatch(
  input: MaintenanceDecisionActionMismatchInput,
): MaintenanceDecisionActionMismatch | null {
  const attemptedStatus = input.attemptedStatus?.trim().toLowerCase() || null;
  const isTerminalAttempt = attemptedStatus ? TERMINAL_ATTEMPTED_STATUSES.has(attemptedStatus) : false;
  if (!isTerminalAttempt) return null;

  const mismatchReasons: string[] = [];
  if (input.decision.recommendedNextAction === "request_missing_input" && input.decision.requiredInputs.length > 0) {
    mismatchReasons.push("required_inputs_missing_before_close");
  }
  if (input.decision.recommendedNextAction === "vendor_handoff") {
    mismatchReasons.push("vendor_handoff_required_before_close");
  }
  if (input.decision.recommendedNextAction === "escalate_incident") {
    mismatchReasons.push("incident_escalation_required_before_close");
  }
  if (
    input.decision.warnings.includes("completion_evidence_missing") &&
    !attemptedCommentProvidesEvidence(input.attemptedComment)
  ) {
    mismatchReasons.push("completion_evidence_missing_before_close");
  }

  if (mismatchReasons.length === 0) return null;
  return {
    attemptedAction: input.attemptedAction,
    attemptedStatus,
    mismatchReasons,
  };
}

export async function logMaintenanceDecisionActionMismatch(
  input: MaintenanceDecisionActionMismatchAuditInput,
): Promise<MaintenanceDecisionActionMismatch | null> {
  const mismatch = evaluateMaintenanceDecisionActionMismatch(input);
  if (!mismatch) return null;

  await logActivity(input.db, {
    companyId: input.companyId,
    actorType: input.actor.actorType,
    actorId: input.actor.actorId,
    agentId: input.actor.agentId ?? null,
    runId: input.actor.runId ?? null,
    action: "maintenance_decision_action_mismatch",
    entityType: "issue",
    entityId: input.issue.id,
    details: {
      issueId: input.issue.id,
      issueIdentifier: input.issue.identifier ?? null,
      projectId: input.issue.projectId ?? null,
      attemptedAction: mismatch.attemptedAction,
      attemptedStatus: mismatch.attemptedStatus,
      recommendedNextAction: input.decision.recommendedNextAction,
      suggestedStatus: input.decision.suggestedStatus,
      requiredInputs: input.decision.requiredInputs,
      warnings: input.decision.warnings,
      handoffTarget: input.decision.handoffTarget,
      mismatchReasons: mismatch.mismatchReasons,
      // TODO: include overrideReason when issue action routes support operator/agent override reasons.
      overrideReason: null,
      matchedRules: input.decision.matchedRules,
      kbReferences: input.decision.kbReferences.map((reference) => ({
        id: reference.id,
        name: reference.name,
        source: reference.source,
      })),
    },
  });

  return mismatch;
}

function attemptedCommentProvidesEvidence(value: string | null | undefined) {
  const text = value?.trim().toLowerCase() ?? "";
  if (!text) return false;
  return /evidence\s*[:=]|verification\s*[:=]|검증|증빙|스크린샷|로그|확인 완료|재현 확인|테스트 통과/i.test(text);
}

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

import type { Db, missions } from "@paperclipai/db";
import type { PlanRevisionDraft, RecordLatestAuthorizedMissionOwnerPlanDecisionDiagnostic } from "../mission-owner-plan-decisions.js";
import type { WorkflowStep } from "../workflow/dag-engine.js";
import { findWorkflowToolReferenceErrors } from "../workflow/step-artifact-references.js";
import { validateDeclaredStructuralPlanReadiness } from "../workflow/control-flow/structural-gate-readiness.js";
import { validateDeclaredStructuralPlan } from "./structural-materialization.js";
import { revisionPlanDiagnostics } from "./revision-plan-validation.js";
import { PaqoArtifactContractError } from "./paqo-artifact-contracts.js";

type Rejection = { reason: string; diagnostics: RecordLatestAuthorizedMissionOwnerPlanDecisionDiagnostic[] };

/** Run the actual PASS-time generator before review/registration/dispatch. The caller
 * persists rejections in the existing submission ledger; no reviewer verdict is written. */
export async function missionPlanMaterializationPreflight(input: {
  db: Db; companyId: string; missionId: string; mission: typeof missions.$inferSelect | null;
  draft: PlanRevisionDraft; buildSteps: (mission: typeof missions.$inferSelect) => WorkflowStep[];
}): Promise<Rejection | null> {
  const { db, companyId, missionId, draft, buildSteps } = input;
  const units = draft.refs.selectedExecutionUnits;
  const structuralPlanErrors = validateDeclaredStructuralPlan(units, draft.steps as Record<string, unknown>[]);
  const structuralReadinessErrors = await validateDeclaredStructuralPlanReadiness({ db, companyId, units });
  try {
    // Revision diagnostics invoke the same generator too; its known contract errors
    // must reach the same rejection boundary rather than escape before preflight.
    const revisionErrors = await revisionPlanDiagnostics(db, companyId, missionId, units, buildSteps);
    if (revisionErrors.length) return { reason: "mission_revision_invalid", diagnostics: revisionErrors };
    const structuralErrors = [...structuralPlanErrors, ...structuralReadinessErrors];
    if (structuralErrors.length) return { reason: "structural_plan_validation_failed",
      diagnostics: structuralErrors.map(message => ({ code: "structural_plan_error", message, severity: "invalid" as const })) };
    const steps = input.mission ? buildSteps(input.mission) : null;
    const toolReferenceErrors = steps ? findWorkflowToolReferenceErrors(steps) : [];
    if (toolReferenceErrors.length) return { reason: "workflow_tool_reference_invalid",
      diagnostics: toolReferenceErrors.map(details => ({ code: "workflow_tool_reference_invalid",
        message: `Step "${details.stepId}" references "${details.referencedStepId}" (${details.reason}). Only known forward ancestor steps may be referenced.`,
        severity: "invalid" as const, details })) };
    return null;
  } catch (error) {
    if (!(error instanceof PaqoArtifactContractError)) throw error;
    return { reason: "paqo_artifact_contract_invalid", diagnostics: [error.diagnostic] };
  }
}

import { toolDefinitions, type Db, type missions } from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import type { PlanRevisionDraft, RecordLatestAuthorizedMissionOwnerPlanDecisionDiagnostic } from "../mission-owner-plan-decisions.js";
import type { WorkflowStep } from "../workflow/dag-engine.js";
import { findWorkflowToolReferenceErrors } from "../workflow/step-artifact-references.js";
import { readObject } from "../workflow/core-tool-context.js";
import { validateDeclaredStructuralPlanReadiness } from "../workflow/control-flow/structural-gate-readiness.js";
import { validateDeclaredStructuralPlan } from "./structural-materialization.js";
import { revisionPlanDiagnostics } from "./revision-plan-validation.js";
import { PaqoArtifactContractError } from "./paqo-artifact-contracts.js";

type Rejection = { reason: string; diagnostics: RecordLatestAuthorizedMissionOwnerPlanDecisionDiagnostic[] };
type ToolArtifactContractDiagnostic = RecordLatestAuthorizedMissionOwnerPlanDecisionDiagnostic
  & { severity: "invalid"; details: Record<string, unknown> };

/** Mirror the dispatch-time freeze rules (freezeArtifactAttempt plus freezeCompanyArtifactAttempt's
 *  company-scoped tool lookup) at plan submission: a step's declared toolArtifactContract must match
 *  the tool registration's role/resultSchemaVersion, a declaration without any registered contract is
 *  rejected, and steps without a declaration stay untouched. [2026-10-17 manual-onboarding incident]
 *  a QA step declared schemaVersion "manual-onboarding.qa.v1" while the registration pinned
 *  "workflow.qa-result.v1"; preflight passed and the plan failed only at tool dispatch
 *  (422 artifact_contract_step_mismatch), delaying publication. Rejections must name the step id,
 *  tool, declared values, and registered values so the owner can fix and resubmit immediately. */
async function findToolArtifactContractRegistrationRejection(input: {
  db: Db; companyId: string; steps: WorkflowStep[] | null;
}): Promise<Rejection | null> {
  const { db, companyId, steps } = input;
  if (!steps) return null;
  const declaredSteps: Array<{ stepId: string; toolName: string; declared: Record<string, unknown> }> = [];
  for (const step of steps) {
    // The persisted contract field is intentionally read structurally: WorkflowStep does not
    // type it, and dispatch parses the same JSON shape at freeze time.
    const declared = (step as { toolArtifactContract?: unknown }).toolArtifactContract;
    if (declared === undefined) continue;
    const toolNames = Array.isArray(step.toolNames) ? step.toolNames.map(name => name.trim()).filter(Boolean) : [];
    // Dispatch requires exactly one toolName per tool step; a declaration on a step without a
    // single resolvable toolName never reaches a tool registration and stays outside this mirror.
    if (toolNames.length !== 1) continue;
    declaredSteps.push({ stepId: step.id, toolName: toolNames[0]!, declared: readObject(declared) });
  }
  if (declaredSteps.length === 0) return null;
  // One batched registration lookup for every referenced tool — never per-step queries.
  const rows = await db.select({ name: toolDefinitions.name, adapterConfig: toolDefinitions.adapterConfig })
    .from(toolDefinitions)
    .where(and(eq(toolDefinitions.companyId, companyId), inArray(toolDefinitions.name, declaredSteps.map(step => step.toolName))));
  const registeredContracts = new Map(rows.map(row => [row.name, readObject(row.adapterConfig).artifactContract]));
  const diagnostics: ToolArtifactContractDiagnostic[] = [];
  for (const { stepId, toolName, declared } of declaredSteps) {
    const registered = registeredContracts.get(toolName);
    // A missing tool row and a tool without artifactContract are indistinguishable at dispatch
    // (both freeze with no contract and then reject artifact_contract_required); mirror that here.
    if (registered === undefined) {
      diagnostics.push({ code: "tool_artifact_contract_required", severity: "invalid",
        message: `Step "${stepId}" declares a toolArtifactContract (role "${String(declared.role)}", schemaVersion "${String(declared.schemaVersion)}") for tool "${toolName}", but the registered tool definition declares no artifactContract. Remove the step's toolArtifactContract or register a matching artifact contract for the tool, then resubmit.`,
        details: { stepId, toolName, declaredRole: declared.role, declaredSchemaVersion: declared.schemaVersion } });
      continue;
    }
    const contract = readObject(registered);
    if (declared.role !== contract.role || declared.schemaVersion !== contract.resultSchemaVersion) {
      diagnostics.push({ code: "tool_artifact_contract_mismatch", severity: "invalid",
        message: `Step "${stepId}" declares toolArtifactContract role "${String(declared.role)}" schemaVersion "${String(declared.schemaVersion)}" for tool "${toolName}", but the registered tool contract declares role "${String(contract.role)}" resultSchemaVersion "${String(contract.resultSchemaVersion)}". Align the step's toolArtifactContract with the registered tool contract, then resubmit.`,
        details: { stepId, toolName, declaredRole: declared.role, declaredSchemaVersion: declared.schemaVersion,
          registeredRole: contract.role, registeredResultSchemaVersion: contract.resultSchemaVersion } });
    }
  }
  if (diagnostics.length === 0) return null;
  return { reason: diagnostics[0]!.code, diagnostics };
}

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
    const toolContractRejection = await findToolArtifactContractRegistrationRejection({ db, companyId, steps });
    if (toolContractRejection) return toolContractRejection;
    return null;
  } catch (error) {
    if (!(error instanceof PaqoArtifactContractError)) throw error;
    return { reason: "paqo_artifact_contract_invalid", diagnostics: [error.diagnostic] };
  }
}

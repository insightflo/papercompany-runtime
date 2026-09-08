import type {
  ResumeBlocker as PublicResumeBlocker,
  ResumePreview as PublicResumePreview,
  ResumeRequestView as PublicResumeRequestView,
} from "@paperclipai/shared/types/workflow-resume";
import { resumeRequestSchema } from "@paperclipai/shared/validators/workflow-resume";
import { HttpError } from "../../../errors.js";
import type { WorkflowStep } from "../dag-engine.js";
import type { ResumePreview } from "./preview.js";
import type { ResumeRequestView } from "./request-store.js";
import type { SnapshotState } from "./snapshot-state.js";

/** Public boundary only. Internal rows/state never escape via object spread or mutable graph lookup. */
export function projectResumePreview(input: {
  preview: ResumePreview;
  frozenSteps: readonly WorkflowStep[];
  state: SnapshotState | null;
  budget: PublicResumePreview["budget"];
}): PublicResumePreview {
  const { preview, frozenSteps, state, budget } = input;
  const frozenById = new Map(frozenSteps.map((step) => [step.id, step]));
  function frozenStep(stepId: string): WorkflowStep {
    const step = frozenById.get(stepId);
    if (!step || typeof step.name !== "string") throw new HttpError(500, "invalid_resume_preview");
    return step;
  }
  return {
    schemaVersion: 1,
    companyId: preview.scope.companyId,
    missionId: preview.scope.missionId,
    workflowRunId: preview.scope.workflowRunId,
    startStepId: preview.scope.startStepId,
    eligible: preview.eligible,
    blockers: preview.blockers.map((blocker) => {
      const result: PublicResumeBlocker = { code: blocker.code, message: blocker.message };
      const directStepId = "stepId" in blocker ? blocker.stepId : undefined;
      const stepId = typeof directStepId === "string" ? directStepId : blocker.detail?.stepId;
      if (typeof stepId === "string") result.stepId = stepId;
      return result;
    }),
    affected: preview.affectedStepIds.map((stepId) => {
      const step = frozenStep(stepId);
      return { stepId, name: step.name, action: step.type === "if" || step.type === "complete" ? "reevaluate" : "execute" };
    }),
    preserved: preview.preservedStepIds.map((stepId) => ({ stepId, name: frozenStep(stepId).name })),
    evidence: state?.evidence.map((item) => ({ id: item.id, sha256: item.sha256 })) ?? [],
    generation: preview.generationPossible ? "possible" : "none",
    budget,
    approvals: state?.approvals.map((item) => ({ stepId: item.stepId, required: true })) ?? [],
    snapshotToken: preview.token,
    expiresAt: preview.expiresAt,
  };
}

/** Validate durable machine contract and scope before exposing only the canonical request view. */
export function projectResumeRequest(view: ResumeRequestView): PublicResumeRequestView {
  const body = resumeRequestSchema.safeParse(view.requestBody);
  const state = view.state;
  if (!body.success
    || body.data.companyId !== view.companyId
    || body.data.missionId !== view.missionId
    || body.data.workflowRunId !== view.workflowRunId
    || (state !== "pending_delivery" && state !== "accepted" && state !== "blocked" && state !== "cancelled")) {
    throw new HttpError(500, "invalid_resume_record");
  }
  return {
    id: view.id,
    workflowRunId: view.workflowRunId,
    startStepId: body.data.startStepId,
    state,
    // Durable acceptance record identity, not proof that work completed.
    acceptanceId: view.execution?.id ?? null,
    code: view.code,
    createdAt: view.createdAt,
  };
}

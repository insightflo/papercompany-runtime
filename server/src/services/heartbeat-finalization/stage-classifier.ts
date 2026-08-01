import type { HeartbeatRun } from "./owner-capability.js";

/**
 * Finalization stage classes (plan section 5):
 * - Q: non-compensable. Requires POSITIVE observation; can never be compensated,
 *   timed out, or dead-lettered into done. Missing proof blocks settlement forever
 *   (blocked_noncompensable after SLA).
 * - C: compensable business side-effects (issue release/promotion, workflow
 *   evidence/sync, mission handoff). May be satisfied by a defined equivalent
 *   structured failure; can never satisfy a Q stage.
 * - O: optional live publication/notification; may dead-letter (DB events stay authoritative).
 */
export const STAGE_CLASS = {
  quiescence: "Q",
  compensable: "C",
  optional: "O",
} as const;
export type FinalizationStageClass = (typeof STAGE_CLASS)[keyof typeof STAGE_CLASS];

export interface RequiredStages {
  q: string[];
  c: string[];
  o: string[];
}

export const Q_STAGE = {
  executorQuiescence: "executor_quiescence",
  workspaceOperationsSettled: "workspace_operations_settled",
  runtimeServicesStopped: "runtime_services_stopped",
  missionRuntimeIdle: "mission_runtime_idle",
} as const;

export const C_STAGE = {
  issuePromotion: "issue_promotion",
  workflowEvidenceSync: "workflow_evidence_sync",
  missionHandoff: "mission_handoff",
} as const;

export const O_STAGE = {
  livePublication: "live_publication",
} as const;

/**
 * The mandatory finalization stages for a run, by class. Scope-dependent:
 * mission-scoped runs also require mission_runtime_idle; workflow-scoped runs
 * require workflow_evidence_sync; issue-backed runs require issue_promotion.
 * Unclassified/unknown scopes still require executor_quiescence (fail closed).
 */
export function requiredStagesForRun(run: HeartbeatRun): RequiredStages {
  const scope = run.executionScopeKind ?? "legacy";
  const q: string[] = [Q_STAGE.executorQuiescence, Q_STAGE.workspaceOperationsSettled, Q_STAGE.runtimeServicesStopped];
  const c: string[] = [];
  const o: string[] = [];

  if (scope === "workflow_step") {
    c.push(C_STAGE.workflowEvidenceSync);
  }
  if (run.issueId) {
    c.push(C_STAGE.issuePromotion);
  }
  if (scope === "mission_nonworkflow" || scope === "workflow_step") {
    // workflow_step runs are also mission-scoped in practice (issue.missionId).
    q.push(Q_STAGE.missionRuntimeIdle);
  }
  o.push(O_STAGE.livePublication);
  return { q, c, o };
}

/** Every stage the settlement gate must evaluate, with its class. */
export function allRequiredStages(run: HeartbeatRun): Array<{ kind: string; stageClass: FinalizationStageClass }> {
  const { q, c, o } = requiredStagesForRun(run);
  return [
    ...q.map((kind) => ({ kind, stageClass: STAGE_CLASS.quiescence })),
    ...c.map((kind) => ({ kind, stageClass: STAGE_CLASS.compensable })),
    ...o.map((kind) => ({ kind, stageClass: STAGE_CLASS.optional })),
  ];
}

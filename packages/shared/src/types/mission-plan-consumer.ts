/** Display/diagnostic projection of owner-plan consumption, never execution authority. */
export interface MissionPlanConsumerDiagnostic {
  code: string;
  message: string;
  commentId?: string | null;
}

/** Additive output fields shared by dedicated PLAN-QA responses and supervision appliedActions. */
export interface MissionPlanConsumerDiagnosticFields {
  planDecisionReason: string | null;
  planDecisionDiagnostics: MissionPlanConsumerDiagnostic[];
}

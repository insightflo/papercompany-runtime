/**
 * Pure helpers for the generic approval-resolution broadcast. Extracted so the
 * "plugin-only, minimal, no-payload" contract is unit-testable without the
 * HTTP route.
 */
export interface DecisionApprovalSummary {
  requestedByPluginId: string | null;
  type: string;
  status: string;
}

/** Only approvals requested by a plugin get a resolution broadcast. */
export function shouldEmitApprovalDecided(approval: DecisionApprovalSummary): boolean {
  return Boolean(approval.requestedByPluginId);
}

/**
 * Build the minimal decision details that are forwarded to plugins. The full
 * approval payload is intentionally never included; the originating plugin
 * already holds the commit identity it recorded when it created the approval.
 */
export function buildApprovalDecidedDetails(
  approval: DecisionApprovalSummary,
  decision: "approved" | "rejected",
): Record<string, unknown> {
  return {
    decision,
    status: approval.status,
    type: approval.type,
    sourcePluginId: approval.requestedByPluginId,
  };
}

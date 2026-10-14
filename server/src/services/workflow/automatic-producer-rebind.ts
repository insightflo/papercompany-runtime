import { is } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { issueProducerRebind, type AutomaticRebindSelection } from "./producer-rebind-issuance.js";
import { HttpError } from "../../errors.js";

type RebindScope = { companyId: string; workflowRunId: string; producerStepId: string; productId: string }
  & AutomaticRebindSelection;
export type ProducerRebindDiagnostic = {
  schemaVersion: "workflow.producer-rebind-diagnostic.v1";
  outcome: "skipped-in-transaction" | "issuance-failed";
  scope: Pick<RebindScope, "companyId" | "workflowRunId" | "producerStepId" | "productId">;
  conflictReason?: string;
};
function diagnostic(scope: RebindScope, outcome: ProducerRebindDiagnostic["outcome"], conflictReason?: string): ProducerRebindDiagnostic {
  return { schemaVersion: "workflow.producer-rebind-diagnostic.v1", outcome,
    scope: { companyId: scope.companyId, workflowRunId: scope.workflowRunId,
      producerStepId: scope.producerStepId, productId: scope.productId },
    ...(conflictReason ? { conflictReason } : {}) };
}

/** Machine-owned request, not an error-message parser or an execution grant. Issuer rechecks all proof. */
export class ProducerRebindRequired extends Error {
  readonly diagnostic: ProducerRebindDiagnostic;
  constructor(readonly scope: RebindScope) {
    super("workproduct_selector_stale_producer");
    this.diagnostic = diagnostic(scope, "skipped-in-transaction");
  }
}

export class ProducerRebindIssuanceFailed extends Error {
  readonly diagnostic: ProducerRebindDiagnostic;
  constructor(readonly scope: RebindScope, cause: unknown) {
    super("workproduct_selector_stale_producer");
    // Eligibility conflicts are machine-owned codes. Never persist arbitrary SQL/error payloads.
    this.diagnostic = diagnostic(scope, "issuance-failed",
      cause instanceof HttpError ? cause.message : "producer_rebind_issuer_error");
  }
}

/** Rechecks proof with no consumer transaction/locks held; preserves conflict diagnostics. */
export async function issueAutomaticProducerRebind(db: Db, request: ProducerRebindRequired): Promise<void> {
  if (is(db, PgTransaction)) throw request;
  const { scope } = request;
  try {
    await issueProducerRebind(db, { ...scope, actor: { actorType: "system", actorId: "workproduct-selector" } }, scope);
  } catch (cause) { throw new ProducerRebindIssuanceFailed(scope, cause); }
}

/** Only outside the OUTERMOST consumer transaction. Nested/savepoint callers propagate the request. */
export async function withAutomaticProducerRebind<T>(db: Db, consume: () => Promise<T>): Promise<T> {
  if (is(db, PgTransaction)) return consume();
  const attempted = new Set<string>();
  for (;;) {
    try { return await consume(); }
    catch (error) {
      if (!(error instanceof ProducerRebindRequired)) throw error;
      const { scope } = error;
      // One issuance per product per operation, with a bounded multi-input restart budget.
      if (attempted.has(scope.productId) || attempted.size >= 32) throw error;
      attempted.add(scope.productId);
      await issueAutomaticProducerRebind(db, error);
    }
  }
}

/** Error translators must not swallow the typed rollback request in seed admission/materialization. */
export function propagateProducerRebind(error: unknown): void {
  if (error instanceof ProducerRebindRequired) throw error;
}

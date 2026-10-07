import { is } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { issueProducerRebind, type AutomaticRebindSelection } from "./producer-rebind-issuance.js";

/** Machine-owned request, not an error-message parser or an execution grant. Issuer rechecks all proof. */
export class ProducerRebindRequired extends Error {
  constructor(readonly scope: { companyId: string; workflowRunId: string; producerStepId: string; productId: string }
    & AutomaticRebindSelection) {
    super("workproduct_selector_stale_producer");
  }
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
      if (attempted.has(scope.productId) || attempted.size >= 32) throw new Error("workproduct_selector_stale_producer");
      attempted.add(scope.productId);
      try {
        await issueProducerRebind(db, { ...scope, actor: { actorType: "system", actorId: "workproduct-selector" } }, scope);
      } catch { throw new Error("workproduct_selector_stale_producer"); }
    }
  }
}

/** Error translators must not swallow the typed rollback request in seed admission/materialization. */
export function propagateProducerRebind(error: unknown): void {
  if (error instanceof ProducerRebindRequired) throw error;
}

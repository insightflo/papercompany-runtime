import { is } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { workProductSelectorsSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { lockProducerSelection } from "../work-products/producer-selection-lock.js";
import { withAutomaticProducerRebind } from "./automatic-producer-rebind.js";
import { assertQaCorrectionSelectionUnchanged, lockQaCorrectionSelections,
  readSelectedQaCorrections } from "./control-flow/qa-correction-selection.js";

type SelectedInput = {
  db: Db;
  run: { id: string; companyId: string };
  step: { workProductSelectors?: unknown };
  consumerStepRunId?: string | null;
};

/** Legacy untyped/no-pin resolution is unchanged. Typed frozen inputs commit all-or-none. */
export function withSelectedInputTransaction<T extends SelectedInput, R>(resolve: (input: T) => Promise<R>) {
  return async (input: T): Promise<R> => {
    if (!input.consumerStepRunId || !input.step.workProductSelectors) return resolve(input);
    const selectors = workProductSelectorsSchema.parse(input.step.workProductSelectors);
    const nested = is(input.db, PgTransaction);
    const scope = { companyId: input.run.companyId, workflowRunId: input.run.id,
      consumerStepRunId: input.consumerStepRunId, selectors };
    return withAutomaticProducerRebind(input.db, async () => {
      const before = await readSelectedQaCorrections(input.db, scope);
      return input.db.transaction(async tx => {
        if (before.length) {
          // An already-locked caller may only read its existing B pin here.
          if (!nested) await lockQaCorrectionSelections(tx, scope, before);
        } else {
          await lockProducerSelection(tx, { ...scope,
            stepIds: Object.keys(selectors), stepRunIds: [scope.consumerStepRunId],
          }, "update");
        }
        const current = await readSelectedQaCorrections(tx, scope);
        assertQaCorrectionSelectionUnchanged(before, current);
        return resolve({ ...input, db: tx as unknown as Db });
      });
    });
  };
}

import type { Db } from "@paperclipai/db";
import { workProductSelectorsSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { lockProducerSelection } from "../work-products/producer-selection-lock.js";
import { withAutomaticProducerRebind } from "./automatic-producer-rebind.js";

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
    return withAutomaticProducerRebind(input.db, () => input.db.transaction(async tx => {
      await lockProducerSelection(tx, {
        companyId: input.run.companyId, workflowRunId: input.run.id,
        stepIds: Object.keys(selectors), stepRunIds: [input.consumerStepRunId!],
      }, "update");
      return resolve({ ...input, db: tx as unknown as Db });
    }));
  };
}

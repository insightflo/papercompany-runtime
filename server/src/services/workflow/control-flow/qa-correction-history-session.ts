import { requireQaCorrection, type QaCorrectionDb } from "./qa-correction-authority.js";
import { readIssuedQaCorrectionHistory } from "./qa-correction-reader.js";

type Scope = Parameters<typeof readIssuedQaCorrectionHistory>[1];
type History = Awaited<ReturnType<typeof readIssuedQaCorrectionHistory>>;

/** One observation's fixed DB/root. Keep the handle private; later observations need a new session. */
export function createQaCorrectionHistorySession(db: QaCorrectionDb, scope: Scope) {
  // Copy only the root identity so caller mutations cannot retarget the session.
  const root = { companyId: scope.companyId, workflowRunId: scope.workflowRunId, appliedEventId: scope.appliedEventId };
  let history: Promise<History> | undefined;
  return async (connection: QaCorrectionDb, requested: Scope): Promise<History["issued"]> => {
    requireQaCorrection(connection === db && requested.companyId === root.companyId
      && requested.workflowRunId === root.workflowRunId, "lineage");
    // Retain rejected promises too: a failed observation must not silently retry.
    const handle = await (history ??= readIssuedQaCorrectionHistory(db, root));
    // The handle enforces actual source ancestry and checks every binding on each visited issuance.
    return requested.appliedEventId === root.appliedEventId
      ? handle.issued : handle.readAncestor(requested.appliedEventId);
  };
}

/**
 * C02: protect outstanding correction work while the caller holds the run lock.
 * SELECT-only DB liveness is not byte validation, delivery, claim or execution authority.
 */
import { and, eq } from "drizzle-orm";
import { workflowTransitionEvents, type Db, type workflowRuns } from "@paperclipai/db";
import { HttpError } from "../../../errors.js";
import { assertRunNotReplaced } from "../run-replacement-guard.js";
import { isTerminalRunStatus, type TerminalDecisionValue, type TerminalFinalizeResult } from "../run-terminal-boundary-cause.js";
import {
  QaCorrectionReadError, parseQaCorrectionPreparationRow, validateQaCorrectionAuthority,
} from "./qa-correction-authority.js";
import {
  hashQaCorrectionPayload, qaCorrectionAppliedKey, qaCorrectionAppliedSchema,
  type QaCorrectionPreparation,
} from "./qa-correction-contract.js";
import {
  QaCorrectionFollowupReadError, readQaCorrectionFollowupDb, readQaCorrectionFollowupConsumption,
} from "./qa-correction-followup.js";
import { readIssuedQaCorrection } from "./qa-correction-reader.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type LockedRun = Pick<typeof workflowRuns.$inferSelect,
  "id" | "companyId" | "missionId" | "status" | "dispatchAuthorityVersion">;
export type QaCorrectionLiveness =
  | { kind: "clear" }
  | { kind: "open"; correctionId: string; requestId?: string }
  | { kind: "unknown"; error: string };

// Only these typed, known validation refusals exclude an individual candidate.
// In particular, neither a generic 409 nor an unexpected reader error proves absence.
const authorityRefusals = new Set([
  "record", "scope", "attempt", "verdict", "heartbeat", "stale", "qualification",
  "tool", "quality", "budget", "source", "binding", "lineage", "evidence",
]);
const currentRefusals = new Set([
  "request", "record", "revision", "lineage", "stale", "attempt", "binding", "quality", "budget",
]);
function candidateRefused(error: unknown): boolean {
  return (error instanceof QaCorrectionReadError && authorityRefusals.has(error.reason))
    || (error instanceof QaCorrectionFollowupReadError && currentRefusals.has(error.reason))
    || (error instanceof HttpError && error.status === 409 && error.message === "workflow_run_replaced");
}

/** No transaction, quality lock, reservation, write or file IO is acquired here. */
export async function readQaCorrectionLiveness(tx: Tx, run: LockedRun): Promise<QaCorrectionLiveness> {
  if (isTerminalRunStatus(run.status)) return { kind: "clear" };
  try {
    const rows = await tx.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, run.companyId),
      eq(workflowTransitionEvents.workflowRunId, run.id),
      eq(workflowTransitionEvents.eventType, "qa_correction_prepared"),
    ));
    for (const row of rows) {
      let p: QaCorrectionPreparation;
      try {
        p = parseQaCorrectionPreparationRow(row);
      } catch (error) {
        if (candidateRefused(error)) continue;
        throw error;
      }
      if (p.companyId !== run.companyId || p.workflowRunId !== run.id
        || p.missionId !== run.missionId || p.dispatchAuthorityVersion !== run.dispatchAuthorityVersion) continue;
      const [applied] = await tx.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, run.companyId),
        eq(workflowTransitionEvents.workflowRunId, run.id),
        eq(workflowTransitionEvents.idempotencyKey, qaCorrectionAppliedKey(p.correctionId)),
      ));
      if (!applied) {
        try {
          await assertRunNotReplaced(tx, run.id, run.companyId);
          await validateQaCorrectionAuthority(tx, p, { reservation: {
            preparationEventId: row.id, preparationHash: hashQaCorrectionPayload(row.payload),
          } });
        } catch (error) {
          if (candidateRefused(error)) continue;
          throw error;
        }
        return { kind: "open", correctionId: p.correctionId };
      }

      // Reject an explicitly malformed application candidate before invoking the chain reader.
      // Internal schema/link errors not covered by a known typed refusal remain unknown.
      if (!qaCorrectionAppliedSchema.safeParse(applied.payload).success) continue;
      let issued: Awaited<ReturnType<typeof readIssuedQaCorrection>>;
      try {
        issued = await readIssuedQaCorrection(tx, {
          companyId: run.companyId, workflowRunId: run.id, appliedEventId: applied.id,
        });
      } catch (error) {
        if (candidateRefused(error)) continue;
        throw error;
      }
      for (const followup of issued.followups) {
        const ref = { companyId: run.companyId, workflowRunId: run.id,
          appliedEventId: applied.id, requestId: followup.requestId };
        try {
          // B→C, target changes, cancellation and quality limits belong to this current reader.
          // Do not re-run preapply authority or require the original A rejection to stay latest.
          await readQaCorrectionFollowupDb(tx, ref, readIssuedQaCorrection);
        } catch (error) {
          if (candidateRefused(error)) continue;
          throw error;
        }
        // After currentness succeeds, ANY consumption read failure is unknown.
        // Only null is ordinary unconsumed work; a valid relation releases just this request.
        const consumed = await readQaCorrectionFollowupConsumption(tx, ref, readIssuedQaCorrection);
        if (consumed === null) return { kind: "open", correctionId: p.correctionId, requestId: ref.requestId };
      }
    }
    return { kind: "clear" };
  } catch (error) {
    return { kind: "unknown", error: error instanceof Error ? error.message : String(error) };
  }
}

/** Map to the existing boundary union without inventing a recovery-channel authority. */
export async function deferRunForQaCorrection(
  tx: Tx, run: typeof workflowRuns.$inferSelect, decision: TerminalDecisionValue,
): Promise<Extract<TerminalFinalizeResult, { kind: "deferred" }> | null> {
  if (decision === "cancelled") return null;
  const state = await readQaCorrectionLiveness(tx, run);
  if (state.kind === "clear") return null;
  return state.kind === "open"
    ? { kind: "deferred", gateKind: "open", run }
    : { kind: "deferred", gateKind: "unknown", gateError: state.error, run };
}

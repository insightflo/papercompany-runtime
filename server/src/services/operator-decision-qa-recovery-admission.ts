import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { missions, operatorDecisions, workflowRuns } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { loadQaRecoveryAdviceFacts, qaRecoveryCollectionChoiceAllowed, storedHashMatches } from "./operator-decision-qa-recovery-advice.js";
import { sameOperatorDecisionResult, validateOperatorDecisionResult } from "./operator-decision-result.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DecisionRow = typeof operatorDecisions.$inferSelect;
type DecisionResult = ReturnType<typeof validateOperatorDecisionResult>;
type ConflictFor = (id: string, status: string, message?: string) => Error;
type Scope = { missionId: string; workflowRunId: string };
type Admission = { kind: "admitted"; card: DecisionRow } | { kind: "replayed" };

const collectionOption = "rerun_source_collection";

function readScope(card: DecisionRow): Scope | null {
  const context = card.sourceContext;
  if (!context || typeof context !== "object" || Array.isArray(context)) return null;
  const missionId = z.string().uuid().safeParse(context.missionId);
  const workflowRunId = z.string().uuid().safeParse(context.workflowRunId);
  return missionId.success && workflowRunId.success
    ? { missionId: missionId.data, workflowRunId: workflowRunId.data }
    : null;
}

function sameBinding(before: DecisionRow, current: DecisionRow, scope: Scope): boolean {
  const currentScope = readScope(current);
  return Boolean(currentScope && currentScope.missionId === scope.missionId
    && currentScope.workflowRunId === scope.workflowRunId
    && current.id === before.id && current.companyId === before.companyId
    && current.sourceType === "workflow_qa_rejection" && current.sourceType === before.sourceType
    && current.sourceId === before.sourceId && current.requestKey === before.requestKey
    && current.requestHash === before.requestHash && current.issueId === before.issueId);
}

function denyUnproven(id: string): never {
  throw conflict("Current QA cause and source target do not support a collection direction", {
    code: "qa_recovery_collection_choice_unproven", operatorDecisionId: id,
  });
}

/** Locks the native parent prefix before rereading a pending historical collection card. */
export async function lockQaRecoveryCollectionAdmission(input: {
  tx: Tx;
  before: DecisionRow;
  result: DecisionResult;
  rawInput: unknown;
  conflictFor: ConflictFor;
}): Promise<Admission | null> {
  const { tx, before, result, rawInput, conflictFor } = input;
  if (before.status !== "pending" || before.sourceType !== "workflow_qa_rejection"
    || storedHashMatches(before, true)
    || !["approve", "submit"].includes(result.outcome)
    || !result.selectedOptionIds.includes(collectionOption)) return null;

  if (!storedHashMatches(before)) return denyUnproven(before.id);
  const scope = readScope(before);
  if (!scope) return denyUnproven(before.id);

  const [mission] = await tx.select({ id: missions.id }).from(missions).where(and(
    eq(missions.id, scope.missionId), eq(missions.companyId, before.companyId),
  )).for("update");
  if (!mission) return denyUnproven(before.id);
  const [run] = await tx.select({ id: workflowRuns.id, missionId: workflowRuns.missionId }).from(workflowRuns).where(and(
    eq(workflowRuns.id, scope.workflowRunId), eq(workflowRuns.companyId, before.companyId),
  )).for("update");
  if (!run || run.missionId !== scope.missionId) return denyUnproven(before.id);

  const [current] = await tx.select().from(operatorDecisions).where(and(
    eq(operatorDecisions.id, before.id), eq(operatorDecisions.companyId, before.companyId),
  )).for("update");
  if (!current) throw conflictFor(before.id, "missing");
  if (!sameBinding(before, current, scope) || !storedHashMatches(current)) {
    throw conflict("Operator decision changed while it was being resolved", {
      code: "operator_decision_binding_changed", operatorDecisionId: before.id,
    });
  }

  if (current.status === "resolved" && sameOperatorDecisionResult(current.result, result)) {
    return { kind: "replayed" };
  }
  if (current.status !== "pending") throw conflictFor(before.id, current.status);
  const currentResult = validateOperatorDecisionResult(current.definition, rawInput);
  if (!sameOperatorDecisionResult(currentResult, result)) {
    throw conflict("Operator decision result no longer matches the submitted selection", {
      code: "operator_decision_binding_changed", operatorDecisionId: before.id,
    });
  }

  const advice = (await loadQaRecoveryAdviceFacts(tx as unknown as Db, [current])).get(before.id);
  if (!qaRecoveryCollectionChoiceAllowed(advice ?? { disposition: "outside_default_scope" })) {
    return denyUnproven(before.id);
  }
  return { kind: "admitted", card: current };
}

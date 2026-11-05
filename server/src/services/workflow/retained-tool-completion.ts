import { randomUUID } from "node:crypto";
import { and, eq, is, isNull, sql, type SQL } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { missions, pluginToolExecutionReceipts, workflowRecoveryAuthorities, workflowRuns,
  workflowStepRuns, type Db } from "@paperclipai/db";
import { insertInternalToolReceipt, completeRetainedToolReceipt, decodeRetainedToolActual,
  decodeRetainedToolOutcome, stageRetainedToolOutcome, type OriginalWorkflowAuthority,
  type RetainedDisposition, type RetainedToolRequest } from "../plugin-tool-execution-receipt.js";
import { jsonEqual, requestForRow, validRequest } from "../plugin-tool-receipt-envelope.js";
import type { ToolOutcome } from "../plugin-job-rpc.js";
import { loadExecutionDefinition, type TransactionDb } from "./execution-definition.js";
import { isStructuralGateStep } from "./control-flow/structural-gate.js";
import { isWorkflowChildStep } from "./workflow-child-guards.js";
import type { ToolCompletionPreparationHooks } from "./tool-completion-preparation.js";
import { bindSpecializedRetainedWorkflowTool, finalizeSpecializedRetainedWorkflowTool,
  verifySpecializedPostCommit, writeRetainedWorkflowCompletionInTransaction,
  type RetainedSpecializedBridge } from "./retained-specialized-tool-completion.js";
import type { WorkflowToolResultInput } from "./workflow-tool-result-acceptance.js";
import type { WorkflowSyncOutcome } from "./dag-engine.js";

/** This unused primitive holds uncertainty; it never acknowledges or dispatches a worker job. */
export class RetainedWorkflowHeld extends Error {
  constructor(readonly reason: string) { super(`retained_workflow_held: ${reason}`); }
}
type Scope = { companyId: string; tool: string; parameters: unknown; workflow: OriginalWorkflowAuthority };
type Marker = { kind: "paperclip.retained-tool-completion"; version: 1; receiptId: string;
  tool: string; workflow: OriginalWorkflowAuthority; claim: { status: "claimed"; claimedAt: string } };
type ReceiptRow = typeof pluginToolExecutionReceipts.$inferSelect;
type Step = typeof workflowStepRuns.$inferSelect;
export type RetainedWorkflowScope = Scope;
export type RetainedWorkflowMarker = Marker;
export type RetainedWorkflowReceiptRow = ReceiptRow;
export type RetainedWorkflowStep = Step;
export type RetainedWorkflowHooks = ToolCompletionPreparationHooks & {
  syncWorkflowRunStateWithOutcome(db: Db, runId: string, source: "workflow_tool_result"): Promise<WorkflowSyncOutcome>;
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const has = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

function scopeFor(owner: RetainedToolRequest): Scope {
  if (!validRequest(owner) || owner.consumer !== "workflow" || !owner.workflow) throw new RetainedWorkflowHeld("invalid_owner");
  return { companyId: owner.companyId, tool: owner.tool, parameters: owner.parameters, workflow: owner.workflow };
}
function markerOf(value: unknown, companyId: string): Marker | null {
  const m = object(value), claim = object(m.claim);
  if (Object.keys(m).sort().join(",") !== "claim,kind,receiptId,tool,version,workflow" ||
      Object.keys(claim).sort().join(",") !== "claimedAt,status" || claim.status !== "claimed" ||
      claim.claimedAt !== object(m.workflow).acceptedAt || m.kind !== "paperclip.retained-tool-completion" || m.version !== 1) return null;
  const probe = { kind: "paperclip.retained-tool-request", version: 1, receiptId: m.receiptId,
    consumer: "workflow", companyId, tool: m.tool, parameters: {},
    identity: { runId: "probe", idempotencyKey: "probe" }, workflow: m.workflow };
  return validRequest(probe) ? m as Marker : null;
}
function markerFor(owner: RetainedToolRequest): Marker {
  return { kind: "paperclip.retained-tool-completion", version: 1, receiptId: owner.receiptId,
    tool: owner.tool, workflow: owner.workflow!, claim: { status: "claimed", claimedAt: owner.workflow!.acceptedAt } };
}
function exactCondition(step: Step, scope: Scope, marker?: Marker, additionalWhere?: SQL): SQL {
  const a = scope.workflow;
  const condition = and(eq(workflowStepRuns.workflowRunId, a.workflowRunId), eq(workflowStepRuns.stepId, a.stepId),
    eq(workflowStepRuns.status, "running"), eq(workflowStepRuns.lastDispatchRequestId, a.requestId),
    eq(workflowStepRuns.executionGeneration, a.executionGeneration), eq(workflowStepRuns.statusTransitionVersion, a.statusTransitionVersion),
    eq(workflowStepRuns.lastDispatchAcceptedAt, new Date(a.acceptedAt)), isNull(workflowStepRuns.lastDispatchErrorAt),
    eq(workflowStepRuns.metadata, step.metadata),
    ...(marker ? [sql`${workflowStepRuns.metadata}->'toolInvocation'->'retainedCompletion' = ${JSON.stringify(marker)}::jsonb`] : []),
    ...(additionalWhere ? [additionalWhere] : []));
  if (condition === undefined) throw new RetainedWorkflowHeld("exact_condition_missing");
  return condition;
}

async function withLocks<T>(db: Db, scope: Scope, work: (tx: TransactionDb, run: typeof workflowRuns.$inferSelect,
  step: Step, mission: typeof missions.$inferSelect | null) => Promise<T>): Promise<T> {
  if (is(db, PgTransaction)) throw new RetainedWorkflowHeld("root_db_required");
  const a = scope.workflow;
  return db.transaction(async tx => {
    let mission: typeof missions.$inferSelect | null = null;
    if (a.missionId) {
      [mission] = await tx.select().from(missions).where(and(eq(missions.id, a.missionId),
        eq(missions.companyId, scope.companyId))).for("update");
      if (!mission) throw new RetainedWorkflowHeld("mission_missing");
    }
    const [run] = await tx.select().from(workflowRuns).where(and(eq(workflowRuns.id, a.workflowRunId),
      eq(workflowRuns.companyId, scope.companyId))).for("update");
    if (!run || run.missionId !== a.missionId) throw new RetainedWorkflowHeld("run_scope_missing");
    const steps = await tx.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id))
      .orderBy(workflowStepRuns.stepId, workflowStepRuns.id).for("update");
    const step = steps.find(s => s.id === a.stepRunId && s.stepId === a.stepId);
    if (!step) throw new RetainedWorkflowHeld("step_scope_missing");
    return work(tx, run, step, mission);
  });
}

async function supported(tx: TransactionDb, run: typeof workflowRuns.$inferSelect, step: Step) {
  if (run.parentRunId || run.parentStepRunId || run.triggeredBy === "workflow-step") throw new RetainedWorkflowHeld("linked_child");
  const definition = await loadExecutionDefinition(tx, run.id, { requireHistorical: false });
  const spec = definition.steps.find(s => s.id === step.stepId);
  if (!spec) throw new RetainedWorkflowHeld("definition_missing");
  const artifact = object(step.metadata.artifactExecution);
  if (isStructuralGateStep(spec) || isWorkflowChildStep(spec) || object(object(spec).toolArtifactContract).role === "qa" ||
      object(artifact.contract).role === "qa" || has(step.metadata, "toolArtifactRequest")) {
    throw new RetainedWorkflowHeld("specialized_authority");
  }
  return spec;
}
async function runReplaced(tx: TransactionDb, companyId: string, workflowRunId: string) {
  const [row] = await tx.select({ id: workflowRecoveryAuthorities.id }).from(workflowRecoveryAuthorities).where(and(
    eq(workflowRecoveryAuthorities.companyId, companyId), eq(workflowRecoveryAuthorities.workflowRunId, workflowRunId),
    eq(workflowRecoveryAuthorities.recoveryKind, "replacement_from_start_v1"))).limit(1);
  return !!row;
}
async function replacementExists(tx: TransactionDb, scope: Scope) {
  return runReplaced(tx, scope.companyId, scope.workflow.workflowRunId);
}
function authorityLoss(scope: Scope, run: typeof workflowRuns.$inferSelect, step: Step,
  mission: typeof missions.$inferSelect | null, replaced: boolean): string | null {
  const a = scope.workflow;
  if (mission?.status === "cancelled") return "mission_cancelled";
  if (replaced) return "run_replaced";
  if (["completed", "failed", "cancelled", "canceled"].includes(run.status)) return "run_terminal";
  if (run.status !== "running") throw new RetainedWorkflowHeld("run_state_unknown");
  if (["completed", "failed", "skipped", "cancelled", "canceled", "pending"].includes(step.status)) return "step_not_running";
  if (step.status !== "running") throw new RetainedWorkflowHeld("step_state_unknown");
  if (step.lastDispatchRequestId && step.lastDispatchRequestId !== a.requestId) return "request_changed";
  if (step.executionGeneration !== a.executionGeneration) return "generation_changed";
  if (step.statusTransitionVersion !== a.statusTransitionVersion) return "status_version_changed";
  if (step.lastDispatchAcceptedAt && step.lastDispatchAcceptedAt.toISOString() !== a.acceptedAt) return "accepted_at_changed";
  if (!step.lastDispatchRequestId || !step.lastDispatchAcceptedAt || step.lastDispatchErrorAt) throw new RetainedWorkflowHeld("claim_missing");
  const invocation = object(step.metadata.toolInvocation), queue = object(step.metadata.toolQueue);
  if (typeof invocation.requestId === "string" && invocation.requestId !== a.requestId) return "invocation_changed";
  if (typeof invocation.toolName === "string" && invocation.toolName !== scope.tool) return "invocation_changed";
  if (!has(invocation, "args") || invocation.requestId !== a.requestId || invocation.toolName !== scope.tool ||
      !jsonEqual(invocation.args, scope.parameters) || queue.status !== "claimed" || queue.claimedAt !== a.acceptedAt) {
    throw new RetainedWorkflowHeld("claim_corrupt");
  }
  return null;
}
function invocationRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const invocation = value as Record<string, unknown>;
  return typeof invocation.requestId === "string" && !!invocation.requestId.trim() &&
    typeof invocation.toolName === "string" && !!invocation.toolName.trim() && has(invocation, "args")
    ? invocation : null;
}
function provenChangedAttempt(scope: Scope, step: Step, invocation: Record<string, unknown>): string | null {
  const requestChanged = step.lastDispatchRequestId !== scope.workflow.requestId;
  const generationChanged = step.executionGeneration !== scope.workflow.executionGeneration;
  if (!requestChanged && !generationChanged) return null;
  const acceptedAt = step.lastDispatchAcceptedAt, queue = object(step.metadata.toolQueue);
  if (typeof step.lastDispatchRequestId !== "string" || !step.lastDispatchRequestId.trim() ||
      !Number.isInteger(step.executionGeneration) || !(acceptedAt instanceof Date) ||
      !Number.isFinite(acceptedAt.getTime()) || step.lastDispatchErrorAt !== null ||
      invocation.requestId !== step.lastDispatchRequestId || queue.status !== "claimed" ||
      queue.claimedAt !== acceptedAt.toISOString()) return null;
  return requestChanged ? "request_changed" : "generation_changed";
}
function completed(row: ReceiptRow, owner: RetainedToolRequest, actual?: ToolOutcome): RetainedDisposition | null {
  const outcome = decodeRetainedToolOutcome(row.resultBody);
  if (row.status !== "completed" || row.completedAt === null || row.resultStatus !== null ||
      row.workflowRunId !== owner.workflow?.workflowRunId || row.stepId !== owner.workflow?.stepId ||
      !jsonEqual(requestForRow(row), owner) || !outcome || outcome.receiptId !== owner.receiptId || outcome.response ||
      !outcome.disposition || !jsonEqual(outcome.disposition.workflow, owner.workflow) ||
      !decodeRetainedToolActual(outcome.actual) || (actual && !jsonEqual(outcome.actual, actual))) return null;
  return outcome.disposition;
}
async function receipt(tx: Pick<TransactionDb, "select">, id: string, lock = false) {
  const query = tx.select().from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, id));
  const [row] = await (lock ? query.for("update") : query);
  return row ?? null;
}

function specializedBridge(): RetainedSpecializedBridge {
  const held = (reason: string) => new RetainedWorkflowHeld(reason);
  return { held, scopeFor, markerFor, markerOf, completed, receipt,
    exactCondition,
    authorityLoss: (scope, run, step, mission, replaced) => authorityLoss(scope, run, step, mission, replaced),
    runReplaced, writeCompletion: (scope, owner, actual, spec, hooks, where) =>
      writeRetainedWorkflowCompletionInTransaction(scope, owner, actual, spec, hooks, where,
        { markerFor, exactCondition, resultInput, held }) };
}

/** Only the fresh binder receives send permission, after receipt and marker commit together. */
export async function bindRetainedWorkflowTool(db: Db, scope: Scope): Promise<
  { kind: "claim"; owner: RetainedToolRequest } | { kind: "held" | "completed" | "conflict" }> {
  if (!validRequest({ kind: "paperclip.retained-tool-request", version: 1, receiptId: randomUUID(),
    consumer: "workflow", companyId: scope?.companyId, tool: scope?.tool, parameters: scope?.parameters,
    identity: { runId: "scope-validation", idempotencyKey: "scope-validation" }, workflow: scope?.workflow })) {
    throw new RetainedWorkflowHeld("invalid_scope");
  }
  const specialized = await bindSpecializedRetainedWorkflowTool(db, scope, specializedBridge());
  if (specialized) return specialized;
  return withLocks(db, scope, async (tx, run, step, mission) => {
    await supported(tx, run, step);
    const invocation = object(step.metadata.toolInvocation);
    if (has(invocation, "retainedCompletion") && !markerOf(invocation.retainedCompletion, scope.companyId)) {
      return { kind: "held" };
    }
    if (has(invocation, "retainedCompletion")) {
      const marker = markerOf(invocation.retainedCompletion, scope.companyId);
      if (!marker) return { kind: "held" };
      if (marker.tool !== scope.tool || !jsonEqual(marker.workflow, scope.workflow)) return { kind: "conflict" };
      const row = await receipt(tx, marker.receiptId, true);
      const owner = row && requestForRow(row);
      if (!row || !owner || owner.consumer !== "workflow" || !jsonEqual(owner.workflow, scope.workflow) ||
          owner.tool !== scope.tool || !jsonEqual(owner.parameters, scope.parameters)) return { kind: "held" };
      return { kind: completed(row, owner) ? "completed" : row.status === "executing" ? "held" : "conflict" };
    }
    const loss = authorityLoss(scope, run, step, mission, await replacementExists(tx, scope));
    if (loss) return { kind: "conflict" };
    const owner = await insertInternalToolReceipt(tx, { ...scope, consumer: "workflow" });
    const marker = markerFor(owner);
    const metadata = { ...step.metadata, toolInvocation: { ...invocation, retainedCompletion: marker } };
    const [updated] = await tx.update(workflowStepRuns).set({ metadata }).where(and(
      eq(workflowStepRuns.id, step.id), exactCondition(step, scope))).returning();
    if (!updated || !jsonEqual(updated.metadata, metadata) || authorityLoss(scope, run, updated, mission, false)) {
      throw new RetainedWorkflowHeld("bind_cas_lost");
    }
    return { kind: "claim", owner };
  });
}

function resultInput(owner: RetainedToolRequest, actual: NonNullable<ReturnType<typeof decodeRetainedToolActual>>): WorkflowToolResultInput {
  const a = owner.workflow!, result = actual.kind === "result" ? actual.result : { error: actual.error.message };
  const success = actual.kind === "result" && !result.error;
  return { companyId: owner.companyId, stepRunId: a.stepRunId, workflowRunId: a.workflowRunId,
    stepId: a.stepId, requestId: a.requestId, toolName: owner.tool, success,
    stdout: result.content ?? JSON.stringify(result.data ?? {}), data: result.data, stderr: result.error ?? "",
    exitCode: success ? 0 : 1, error: result.error };
}

/** Actual is staged on the root DB before acquiring workflow locks; retries never send or reapply. */
export async function finalizeRetainedWorkflowTool(db: Db, owner: RetainedToolRequest, actual: ToolOutcome,
  hooks: RetainedWorkflowHooks): Promise<RetainedDisposition> {
  const scope = scopeFor(owner);
  if (is(db, PgTransaction)) throw new RetainedWorkflowHeld("root_db_required");
  let stored = await receipt(db, owner.receiptId);
  if (!stored || !jsonEqual(requestForRow(stored), owner)) throw new RetainedWorkflowHeld("receipt_missing_or_wrong_owner");
  let disposition = completed(stored, owner, actual);
  if (stored.status === "completed" && !disposition) throw new RetainedWorkflowHeld("receipt_conflict");
  if (!disposition) {
    try { await stageRetainedToolOutcome(db, owner, actual); }
    catch (error) {
      stored = await receipt(db, owner.receiptId);
      disposition = stored && completed(stored, owner, actual);
      if (!disposition) throw error;
    }
  }
  if (!disposition) {
    stored = await receipt(db, owner.receiptId);
    const staged = stored && decodeRetainedToolOutcome(stored.resultBody);
    const decoded = staged && decodeRetainedToolActual(staged.actual);
    if (!stored || !staged || !decoded || !jsonEqual(staged.actual, actual)) throw new RetainedWorkflowHeld("actual_invalid");
    if (owner.workflow?.specialized !== undefined) {
      disposition = await finalizeSpecializedRetainedWorkflowTool(db, owner, decoded, hooks, specializedBridge());
    } else disposition = await withLocks(db, scope, async (tx, run, step, mission) => {
      const spec = await supported(tx, run, step);
      const locked = await receipt(tx, owner.receiptId, true);
      if (!locked || !jsonEqual(requestForRow(locked), owner)) throw new RetainedWorkflowHeld("receipt_missing_or_wrong_owner");
      const prior = completed(locked, owner, actual);
      if (prior) return prior;
      const invocation = invocationRecord(step.metadata.toolInvocation);
      if (!invocation) throw new RetainedWorkflowHeld("invocation_corrupt");
      const hasMarker = has(invocation, "retainedCompletion");
      const marker = hasMarker ? markerOf(invocation.retainedCompletion, scope.companyId) : null;
      if (hasMarker && !marker) {
        throw new RetainedWorkflowHeld("marker_corrupt");
      }
      const changed = hasMarker ? null : provenChangedAttempt(scope, step, invocation);
      const loss = authorityLoss(scope, run, step, mission, await replacementExists(tx, scope));
      let decision: RetainedDisposition;
      if (loss || changed) {
        if (!marker && !changed) throw new RetainedWorkflowHeld("attempt_loss_unproven");
        decision = { kind: "superseded", reason: marker ? loss! : changed!, workflow: scope.workflow };
      }
      else {
        if (!marker || !jsonEqual(marker, markerFor(owner))) throw new RetainedWorkflowHeld("marker_missing_or_conflicting");
        await specializedBridge().writeCompletion({ tx, run, step, mission, steps: [step], child: null },
          owner, decoded, spec, hooks);
        decision = { kind: "applied", reason: "current_owner", workflow: scope.workflow };
      }
      await completeRetainedToolReceipt(tx, owner, decoded, { disposition: decision });
      return decision;
    });
  }
  if (disposition.kind === "applied") {
    const sync = await hooks.syncWorkflowRunStateWithOutcome(db, scope.workflow.workflowRunId, "workflow_tool_result");
    if (sync.kind !== "synced") throw new RetainedWorkflowHeld(`sync_${sync.kind}`);
    if (owner.workflow?.specialized !== undefined) await verifySpecializedPostCommit(db, owner, sync, (reason) => new RetainedWorkflowHeld(reason));
  }
  return disposition;
}

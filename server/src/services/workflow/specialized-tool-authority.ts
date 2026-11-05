import { and, eq, is } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { missions, workflowRecoveryAuthorities, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { jsonEqual, validRequest, type RetainedToolRequest, type SpecializedToolAuthority } from "../plugin-tool-receipt-envelope.js";
import { isStructuralGateStep, readStructuralGateProducerToken, sameStructuralGateProducerToken } from "./control-flow/structural-gate.js";
import { loadExecutionDefinition, type TransactionDb } from "./execution-definition.js";
import { isWorkflowChildStep } from "./workflow-child-guards.js";
import { type ChildStartIdentity, type LockedChildStartRows, type WorkflowTx } from "./workflow-child-start-state.js";
import { withWorkflowToolLockScope, type ExpectedWorkflowToolScope, type RawWorkflowToolScope } from "./workflow-tool-lock-scope.js";

type Run = typeof workflowRuns.$inferSelect;
type Step = typeof workflowStepRuns.$inferSelect;
export type ToolAuthorityState =
  | { kind: "current" }
  | { kind: "lost"; reason: string }
  | { kind: "held"; reason: string };
export type LockedSpecializedToolScope = {
  tx: TransactionDb;
  mission: typeof missions.$inferSelect | null;
  run: Run | null;
  steps: readonly Step[];
  child: LockedChildStartRows | null;
  authority: ToolAuthorityState;
};
type BaseScope = Omit<LockedSpecializedToolScope, "authority">;
export type LockedSpecializedToolContext = BaseScope & {
  /** Defer live-currentness checks until after a caller has replayed a completed receipt. */
  classify(): Promise<LockedSpecializedToolScope>;
};
type ScopeWork<T> = (scope: LockedSpecializedToolContext) => Promise<T>;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const terminalRun = new Set(["completed", "failed", "cancelled", "canceled", "aborted", "timed-out"]);
const terminalStep = new Set(["completed", "failed", "skipped", "cancelled", "canceled"]);

function withState(base: BaseScope, authority: ToolAuthorityState): LockedSpecializedToolScope {
  return { ...base, authority };
}
function emptyScope(tx: TransactionDb, reason: string): LockedSpecializedToolScope {
  return withState({ tx, mission: null, run: null, steps: [], child: null }, { kind: "held", reason });
}
function held(base: BaseScope, reason: string): LockedSpecializedToolScope {
  return withState(base, { kind: "held", reason });
}
function lost(base: BaseScope, reason: string): LockedSpecializedToolScope {
  return withState(base, { kind: "lost", reason });
}
function context(base: BaseScope, resolve: () => Promise<LockedSpecializedToolScope>): LockedSpecializedToolContext {
  let result: Promise<LockedSpecializedToolScope> | undefined;
  return { ...base, classify: () => result ??= resolve() };
}

function baseFromRaw(scope: RawWorkflowToolScope): BaseScope {
  return { tx: scope.tx, mission: scope.mission, run: scope.run, steps: scope.steps, child: scope.child };
}

async function replacementExists(tx: WorkflowTx, companyId: string, runId: string): Promise<boolean> {
  const [row] = await tx.select({ id: workflowRecoveryAuthorities.id }).from(workflowRecoveryAuthorities).where(and(
    eq(workflowRecoveryAuthorities.companyId, companyId), eq(workflowRecoveryAuthorities.workflowRunId, runId),
    eq(workflowRecoveryAuthorities.recoveryKind, "replacement_from_start_v1"),
  )).limit(1);
  return !!row;
}

async function classify(
  tx: WorkflowTx,
  owner: RetainedToolRequest,
  base: BaseScope,
  capture: SpecializedToolAuthority,
  linkedParent?: LockedChildStartRows,
): Promise<LockedSpecializedToolScope> {
  const a = owner.workflow!;
  const run = base.run;
  if (!run || run.companyId !== owner.companyId || run.id !== a.workflowRunId) return held(base, "run_missing_or_scope");
  if (run.missionId !== a.missionId) return held(base, "run_mission_changed");
  const step = base.steps.find((row) => row.id === a.stepRunId && row.stepId === a.stepId);
  if (!step) return held(base, "step_missing_or_scope");
  const stepSpec = (await loadExecutionDefinition(tx as unknown as Db, run.id, { requireHistorical: false }))
    .steps.find((candidate) => candidate.id === step.stepId);
  if (!stepSpec || isWorkflowChildStep(stepSpec)) return held(base, "unsupported_step_classification");
  if (isStructuralGateStep(stepSpec) !== (capture.structural !== null)) return held(base, "structural_capture_missing_or_unexpected");
  if (capture.structural) {
    const currentToken = readStructuralGateProducerToken(record(step.metadata).structuralGateProducerToken);
    if (!currentToken) return held(base, "structural_token_missing_or_corrupt");
    if (!sameStructuralGateProducerToken(currentToken, capture.structural.producerToken) ||
        (step.iterationIndex ?? 0) !== capture.structural.iterationIndex ||
        (step.completedAt?.toISOString() ?? null) !== capture.structural.completedAt) {
      return lost(base, "structural_capture_changed");
    }
  }
  const contract = record(record(stepSpec).toolArtifactContract);
  if (contract.role === "qa" || owns(record(step.metadata), "toolArtifactRequest")) return held(base, "verified_qa_receipt_required");

  const authority = a;
  if (terminalRun.has(run.status)) return lost(base, "run_terminal");
  if (run.status !== "running") return held(base, "run_state_unknown");
  if (terminalStep.has(step.status) || step.status === "pending") return lost(base, "step_not_running");
  if (step.status !== "running") return held(base, "step_state_unknown");
  if (step.lastDispatchRequestId && step.lastDispatchRequestId !== authority.requestId) return lost(base, "request_changed");
  if (step.executionGeneration !== authority.executionGeneration) return lost(base, "generation_changed");
  if (step.statusTransitionVersion !== authority.statusTransitionVersion) return lost(base, "status_version_changed");
  if (step.lastDispatchAcceptedAt && step.lastDispatchAcceptedAt.toISOString() !== authority.acceptedAt) return lost(base, "accepted_at_changed");
  if (!step.lastDispatchRequestId || !step.lastDispatchAcceptedAt || step.lastDispatchErrorAt) return held(base, "dispatch_claim_missing_or_corrupt");
  const metadata = record(step.metadata), invocation = record(metadata.toolInvocation), queue = record(metadata.toolQueue);
  if (typeof invocation.requestId === "string" && invocation.requestId !== authority.requestId) return lost(base, "invocation_changed");
  if (typeof invocation.toolName === "string" && invocation.toolName !== owner.tool) return lost(base, "invocation_changed");
  if (!owns(invocation, "args") || invocation.requestId !== authority.requestId || invocation.toolName !== owner.tool ||
      !jsonEqual(invocation.args, owner.parameters) || queue.status !== "claimed" || queue.claimedAt !== authority.acceptedAt) {
    return held(base, "dispatch_claim_corrupt");
  }
  const marker = { kind: "paperclip.retained-tool-completion", version: 1, receiptId: owner.receiptId,
    tool: owner.tool, workflow: authority, claim: { status: "claimed", claimedAt: authority.acceptedAt } };
  if (!jsonEqual(invocation.retainedCompletion, marker)) return held(base, "retained_marker_missing_or_conflicting");
  if (base.mission?.status === "cancelled") return lost(base, "mission_cancelled");
  if (await replacementExists(tx, owner.companyId, run.id)) return lost(base, "run_replaced");

  if (!linkedParent) return withState(base, { kind: "current" });
  const { parent, invocation: childInvocation, parentStep, child } = linkedParent;
  if (!parent || !childInvocation || !parentStep || !child) return held(base, "linked_identity_missing");
  const captureChild = capture.linkedChild;
  if (!captureChild || captureChild.identity.childRunId !== run.id || a.missionId !== null || run.missionId !== null) {
    return held(base, "linked_owner_scope_invalid");
  }
  const id = captureChild.identity;
  if (parent.companyId !== owner.companyId || child.companyId !== owner.companyId ||
      parentStep.workflowRunId !== parent.id || parentStep.stepId !== id.stepId ||
      child.parentRunId !== parent.id || child.parentStepRunId !== parentStep.id) return held(base, "linked_identity_inconsistent");
  if (parent.missionId !== captureChild.parentMissionId) return held(base, "parent_mission_changed");
  if (childInvocation.companyId !== owner.companyId || childInvocation.parentStepRunId !== parentStep.id) {
    return held(base, "linked_invocation_inconsistent");
  }
  if (childInvocation.state !== "linked") return held(base, "linked_invocation_state_invalid");
  if (childInvocation.generation !== id.generation || childInvocation.childRunId !== child.id) return lost(base, "linked_invocation_changed");
  if (childInvocation.targetWorkflowId !== captureChild.targetWorkflowId) return held(base, "linked_target_capture_inconsistent");
  if (child.workflowId !== captureChild.targetWorkflowId) return lost(base, "child_target_changed");
  if (parent.status !== "running") return terminalRun.has(parent.status) ? lost(base, "parent_terminal") : held(base, "parent_state_unknown");
  if (parentStep.status !== "pending") return terminalStep.has(parentStep.status) ? lost(base, "parent_step_changed") : held(base, "parent_step_state_unknown");
  if (parentStep.retryCount !== 0 || owns(record(parentStep.metadata), "workflowRetry")) return lost(base, "parent_step_not_current");
  if (child.status !== "running") return terminalRun.has(child.status) ? lost(base, "child_terminal") : held(base, "child_state_unknown");
  if (child.childStartMaterializedAt === null) return held(base, "child_not_materialized");
  if ((base.mission?.id ?? null) !== captureChild.parentMissionId) return held(base, "parent_mission_scope_changed");
  if (await replacementExists(tx, owner.companyId, parent.id) || await replacementExists(tx, owner.companyId, child.id)) {
    return lost(base, "linked_run_replaced");
  }
  const parentDefinition = await loadExecutionDefinition(tx as unknown as Db, parent.id, { requireHistorical: false });
  const parentStepSpec = parentDefinition.steps.find((candidate) => candidate.id === parentStep.stepId);
  if (!parentStepSpec || !isWorkflowChildStep(parentStepSpec) || parentStepSpec.targetWorkflowId !== captureChild.targetWorkflowId) {
    return held(base, "parent_target_capture_inconsistent");
  }
  return withState(base, { kind: "current" });
}

/**
 * Unused locked prelude for specialized retained results. It keeps raw rows in the callback
 * even when the captured owner is lost, so a later receipt replay can precede live eligibility.
 */
export async function withSpecializedToolAuthority<T>(
  db: Db,
  owner: RetainedToolRequest,
  work: ScopeWork<T>,
): Promise<T> {
  if (is(db, PgTransaction)) throw new Error("specialized_tool_authority_requires_root_db");
  if (!validRequest(owner) || owner.consumer !== "workflow" || !owner.workflow) {
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as TransactionDb;
      const scope = emptyScope(txDb, "owner_invalid");
      return work(context({ tx: txDb, mission: null, run: null, steps: [], child: null }, async () => scope));
    });
  }
  const capture = owner.workflow.specialized;
  if (!capture || (capture.structural === null && capture.linkedChild === null)) {
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as TransactionDb;
      const scope = emptyScope(txDb, "specialization_capture_missing");
      return work(context({ tx: txDb, mission: null, run: null, steps: [], child: null }, async () => scope));
    });
  }
  const expected: ExpectedWorkflowToolScope = capture.linkedChild
    ? {
        kind: "linked", companyId: owner.companyId, workflowRunId: owner.workflow.workflowRunId,
        missionId: null, identity: capture.linkedChild.identity as ChildStartIdentity,
        parentMissionId: capture.linkedChild.parentMissionId, targetWorkflowId: capture.linkedChild.targetWorkflowId,
      }
    : { kind: "plain", companyId: owner.companyId, workflowRunId: owner.workflow.workflowRunId, missionId: owner.workflow.missionId };
  return withWorkflowToolLockScope(db, expected, async (raw) => {
    const base = baseFromRaw(raw);
    return work(context(base, () => raw.scopeIssue
      ? Promise.resolve(held(base, raw.scopeIssue))
      : classify(raw.tx as unknown as WorkflowTx, owner, base, capture, raw.child ?? undefined)));
  });
}

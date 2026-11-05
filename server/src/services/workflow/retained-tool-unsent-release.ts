import { and, eq, is, isNull, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { missions, pluginToolExecutionReceipts, workflowRecoveryAuthorities, workflowRuns,
  workflowStepRuns, type Db } from "@paperclipai/db";
import { z } from "zod";
import { TOOL_NAMESPACE_SEPARATOR } from "../plugin-tool-registry.js";
import type { ObservedToolExecution } from "../plugin-tool-observation.js";
import { encodeRetainedToolRequest, jsonEqual, requestForRow, validRequest,
  type OriginalWorkflowAuthority, type RetainedToolRequest } from "../plugin-tool-receipt-envelope.js";
import { deferredBeforeStartSchema, runtimeExecutionIdentitySchema } from "../runtime-execution-lifecycle.js";
import { isStructuralGateStep } from "./control-flow/structural-gate.js";
import { loadExecutionDefinition, type TransactionDb } from "./execution-definition.js";
import { isWorkflowChildStep } from "./workflow-child-guards.js";
import { withSpecializedToolAuthority } from "./specialized-tool-authority.js";
import { withWorkflowToolLockScope } from "./workflow-tool-lock-scope.js";

type PositiveUnsentObservation = Extract<ObservedToolExecution,
  { kind: "definitely_unsent" | "deferred_before_start" }>;
type Step = typeof workflowStepRuns.$inferSelect;
type Run = typeof workflowRuns.$inferSelect;
type Mission = typeof missions.$inferSelect;

export type RetainedWorkflowUnsentReleaseResult =
  | { kind: "released"; receiptId: string; workflow: OriginalWorkflowAuthority }
  | { kind: "held"; receiptId: string | null; workflow: OriginalWorkflowAuthority | null; reason: string };

const routeSchema = z.object({
  pluginId: z.string().min(1), toolName: z.string().min(1), identity: runtimeExecutionIdentitySchema,
}).strict();
const positiveObservationSchema = z.discriminatedUnion("kind", [
  routeSchema.extend({ kind: z.literal("definitely_unsent") }),
  routeSchema.extend({ kind: z.literal("deferred_before_start"), deferredBeforeStart: deferredBeforeStartSchema }),
]);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function without(value: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  const result = { ...value };
  for (const key of keys) delete result[key];
  return result;
}

function held(owner: unknown, reason: string): RetainedWorkflowUnsentReleaseResult {
  if (validRequest(owner) && owner.consumer === "workflow" && owner.workflow) {
    return { kind: "held", receiptId: owner.receiptId, workflow: owner.workflow, reason };
  }
  return { kind: "held", receiptId: null, workflow: null, reason };
}

function markerFor(owner: RetainedToolRequest) {
  const workflow = owner.workflow!;
  return { kind: "paperclip.retained-tool-completion", version: 1, receiptId: owner.receiptId,
    tool: owner.tool, workflow, claim: { status: "claimed", claimedAt: workflow.acceptedAt } };
}

function positiveProofMatches(owner: RetainedToolRequest, observed: unknown): boolean {
  const parsed = positiveObservationSchema.safeParse(observed);
  if (!parsed.success || !owner.workflow) return false;
  const proof = parsed.data, workflow = owner.workflow;
  const identity = { requestId: workflow.requestId, executionId: workflow.workflowRunId,
    attemptId: workflow.stepRunId, executionGeneration: workflow.executionGeneration };
  if (`${proof.pluginId}${TOOL_NAMESPACE_SEPARATOR}${proof.toolName}` !== owner.tool ||
      !jsonEqual(proof.identity, identity)) return false;
  return proof.kind !== "deferred_before_start" || jsonEqual(proof.deferredBeforeStart, {
    kind: "deferred_before_start", version: 1, reasonCode: "runtime_shutting_down", externalStarted: false, ...identity,
  });
}

function acceptedDate(value: Date | null, expected: string): boolean {
  return value instanceof Date && Number.isFinite(value.getTime()) && value.toISOString() === expected;
}

function currentClaim(owner: RetainedToolRequest, run: Run, step: Step, mission: Mission | null): string | null {
  const workflow = owner.workflow!, metadata = record(step.metadata);
  const invocation = record(metadata.toolInvocation), queue = record(metadata.toolQueue);
  if (run.companyId !== owner.companyId || run.id !== workflow.workflowRunId || run.missionId !== workflow.missionId ||
      step.workflowRunId !== workflow.workflowRunId || step.id !== workflow.stepRunId || step.stepId !== workflow.stepId) {
    return "workflow_scope_changed";
  }
  if (mission?.status === "cancelled") return "mission_cancelled";
  if (run.status !== workflow.runStatus || step.status !== workflow.stepStatus) return "workflow_not_current";
  if (step.lastDispatchRequestId !== workflow.requestId || step.executionGeneration !== workflow.executionGeneration ||
      step.statusTransitionVersion !== workflow.statusTransitionVersion || !acceptedDate(step.lastDispatchAcceptedAt, workflow.acceptedAt) ||
      step.lastDispatchErrorAt !== null) return "dispatch_owner_changed";
  if (!owns(invocation, "args") || invocation.requestId !== workflow.requestId || invocation.toolName !== owner.tool ||
      !jsonEqual(invocation.args, owner.parameters) || invocation.dispatchedAt !== workflow.acceptedAt ||
      queue.status !== "claimed" || queue.claimedAt !== workflow.acceptedAt) return "dispatch_claim_changed";
  if (!jsonEqual(invocation.retainedCompletion, markerFor(owner))) return "retained_marker_changed";
  return null;
}

async function plainAuthorityReason(tx: TransactionDb, owner: RetainedToolRequest, run: Run,
  step: Step, mission: Mission | null): Promise<string | null> {
  if (run.parentRunId || run.parentStepRunId || run.triggeredBy === "workflow-step") return "linked_capture_missing";
  if (mission?.status === "cancelled") return "mission_cancelled";
  const definition = await loadExecutionDefinition(tx as unknown as Db, run.id, { requireHistorical: false });
  const spec = definition.steps.find((candidate) => candidate.id === step.stepId);
  const metadata = record(step.metadata), artifact = record(metadata.artifactExecution);
  if (!spec || isStructuralGateStep(spec) || isWorkflowChildStep(spec) ||
      record(record(spec).toolArtifactContract).role === "qa" || record(artifact.contract).role === "qa" ||
      owns(metadata, "toolArtifactRequest")) return "specialized_authority_required";
  const [replacement] = await tx.select({ id: workflowRecoveryAuthorities.id }).from(workflowRecoveryAuthorities).where(and(
    eq(workflowRecoveryAuthorities.companyId, owner.companyId),
    eq(workflowRecoveryAuthorities.workflowRunId, run.id),
    eq(workflowRecoveryAuthorities.recoveryKind, "replacement_from_start_v1"),
  )).limit(1);
  return replacement ? "run_replaced" : null;
}

async function releaseLocked(tx: TransactionDb, owner: RetainedToolRequest, run: Run, step: Step,
  mission: Mission | null): Promise<RetainedWorkflowUnsentReleaseResult> {
  const mismatch = currentClaim(owner, run, step, mission);
  if (mismatch) return held(owner, mismatch);
  const row = (await tx.select({ receipt: pluginToolExecutionReceipts,
    resultBodyIsSqlNull: sql<boolean>`${pluginToolExecutionReceipts.resultBody} IS NULL`,
  }).from(pluginToolExecutionReceipts).where(eq(pluginToolExecutionReceipts.id, owner.receiptId)).for("update").limit(1))[0];
  const encodedOwner = encodeRetainedToolRequest(owner);
  if (!row || !jsonEqual(requestForRow(row.receipt), owner) || row.receipt.status !== "executing" ||
      row.receipt.workflowRunId !== null || row.receipt.stepId !== null || !row.resultBodyIsSqlNull ||
      row.receipt.resultStatus !== null || row.receipt.completedAt !== null) {
    return held(owner, "receipt_missing_or_changed");
  }

  const metadata = record(step.metadata), queue = record(metadata.toolQueue), invocation = record(metadata.toolInvocation);
  const nextMetadata = { ...metadata, toolQueue: { ...without(queue, "claimedAt"), status: "queued" },
    toolInvocation: without(invocation, "dispatchedAt", "retainedCompletion") };
  const workflow = owner.workflow!, marker = markerFor(owner);
  const [updated] = await tx.update(workflowStepRuns).set({ metadata: nextMetadata, lastDispatchAcceptedAt: null }).where(and(
    eq(workflowStepRuns.id, workflow.stepRunId), eq(workflowStepRuns.workflowRunId, workflow.workflowRunId),
    eq(workflowStepRuns.stepId, workflow.stepId), eq(workflowStepRuns.status, workflow.stepStatus),
    eq(workflowStepRuns.lastDispatchRequestId, workflow.requestId),
    eq(workflowStepRuns.executionGeneration, workflow.executionGeneration),
    eq(workflowStepRuns.statusTransitionVersion, workflow.statusTransitionVersion),
    eq(workflowStepRuns.lastDispatchAcceptedAt, new Date(workflow.acceptedAt)), isNull(workflowStepRuns.lastDispatchErrorAt),
    eq(workflowStepRuns.metadata, step.metadata),
    sql`${workflowStepRuns.metadata}->'toolInvocation'->'retainedCompletion' = ${JSON.stringify(marker)}::jsonb`,
    sql`${workflowStepRuns.metadata}->'toolQueue'->>'status' = 'claimed'`,
    sql`${workflowStepRuns.metadata}->'toolQueue'->>'claimedAt' = ${workflow.acceptedAt}`,
  )).returning();
  if (!updated || updated.lastDispatchAcceptedAt !== null || updated.status !== workflow.stepStatus ||
      !jsonEqual(updated.metadata, nextMetadata)) throw new Error("retained_unsent_release_step_cas_lost");

  const removed = await tx.delete(pluginToolExecutionReceipts).where(and(
    eq(pluginToolExecutionReceipts.id, owner.receiptId), eq(pluginToolExecutionReceipts.companyId, owner.companyId),
    eq(pluginToolExecutionReceipts.runId, owner.identity.runId), eq(pluginToolExecutionReceipts.tool, owner.tool),
    eq(pluginToolExecutionReceipts.idempotencyKey, owner.identity.idempotencyKey),
    eq(pluginToolExecutionReceipts.requestParameters, encodedOwner),
    eq(pluginToolExecutionReceipts.status, "executing"), isNull(pluginToolExecutionReceipts.resultBody),
    isNull(pluginToolExecutionReceipts.resultStatus), isNull(pluginToolExecutionReceipts.completedAt),
    isNull(pluginToolExecutionReceipts.workflowRunId), isNull(pluginToolExecutionReceipts.stepId),
  )).returning({ id: pluginToolExecutionReceipts.id });
  if (removed.length !== 1 || removed[0]?.id !== owner.receiptId) throw new Error("retained_unsent_release_receipt_cas_lost");
  return { kind: "released", receiptId: owner.receiptId, workflow };
}

/**
 * Release only the exact bound workflow attempt after one routed positive no-send observation.
 * The caller must pass the direct, unmodified observation from the owner.parameters dispatch.
 */
export async function releaseRetainedWorkflowToolUnsent(
  db: Db,
  owner: RetainedToolRequest,
  observed: PositiveUnsentObservation,
): Promise<RetainedWorkflowUnsentReleaseResult> {
  if (is(db, PgTransaction)) throw new Error("retained_unsent_release_requires_root_db");
  if (!validRequest(owner) || owner.consumer !== "workflow" || !owner.workflow) return held(owner, "owner_invalid");
  if (!positiveProofMatches(owner, observed)) return held(owner, "positive_unsent_proof_invalid");

  const capture = owner.workflow.specialized;
  if (capture !== undefined) {
    return withSpecializedToolAuthority(db, owner, async (context) => {
      const classification = await context.classify();
      if (classification.authority.kind !== "current") {
        return held(owner, classification.authority.reason);
      }
      const run = classification.run, step = classification.steps.find((row) =>
        row.id === owner.workflow!.stepRunId && row.stepId === owner.workflow!.stepId);
      if (!run || !step) return held(owner, "specialized_scope_incomplete");
      const metadata = record(step.metadata), artifact = record(metadata.artifactExecution);
      if (record(record(artifact).contract).role === "qa" || owns(metadata, "toolArtifactRequest")) {
        return held(owner, "specialized_artifact_authority_required");
      }
      const mismatch = currentClaim(owner, run, step, classification.mission);
      return mismatch ? held(owner, mismatch) : releaseLocked(context.tx, owner, run, step, classification.mission);
    });
  }

  return withWorkflowToolLockScope(db, { kind: "plain", companyId: owner.companyId,
    workflowRunId: owner.workflow.workflowRunId, missionId: owner.workflow.missionId }, async (scope) => {
    if (scope.scopeIssue || !scope.run) return held(owner, scope.scopeIssue ?? "run_missing_or_scope");
    const step = scope.steps.find((row) => row.id === owner.workflow!.stepRunId && row.stepId === owner.workflow!.stepId);
    if (!step) return held(owner, "step_missing_or_scope");
    const authorityIssue = await plainAuthorityReason(scope.tx, owner, scope.run, step, scope.mission);
    if (authorityIssue) return held(owner, authorityIssue);
    const mismatch = currentClaim(owner, scope.run, step, scope.mission);
    return mismatch ? held(owner, mismatch) : releaseLocked(scope.tx, owner, scope.run, step, scope.mission);
  });
}

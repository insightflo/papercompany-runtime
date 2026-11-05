import { and, eq, sql, type SQL } from "drizzle-orm";
import { missions, workflowRuns, workflowStepInvocations, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { completeRetainedToolReceipt, decodeRetainedToolActual, decodeRetainedToolOutcome, insertInternalToolReceipt } from "../plugin-tool-execution-receipt.js";
import { jsonEqual, requestForRow, validRequest, type RetainedDisposition, type RetainedToolRequest, type SpecializedToolAuthority } from "../plugin-tool-receipt-envelope.js";
import type { ToolOutcome } from "../plugin-job-rpc.js";
import { writePreparedToolCompletion, withMachineToolTruth, prepareToolCompletion } from "./tool-completion-preparation.js";
import { writeStructuralCompletionInTransaction } from "./control-flow/structural-completion-write.js";
import { isStructuralGateStep, readStructuralGateProducerToken } from "./control-flow/structural-gate.js";
import { isWorkflowChildStep } from "./workflow-child-guards.js";
import { findChildStartIdentityForRun, parentPermitsStart, type ChildStartIdentity, type LockedChildStartRows } from "./workflow-child-start-state.js";
import { withSpecializedToolAuthority, type LockedSpecializedToolContext } from "./specialized-tool-authority.js";
import { withWorkflowToolLockScope, type ExpectedWorkflowToolScope, type RawWorkflowToolScope } from "./workflow-tool-lock-scope.js";
import { loadExecutionDefinition, type TransactionDb } from "./execution-definition.js";
import type { RetainedWorkflowHooks, RetainedWorkflowMarker, RetainedWorkflowReceiptRow,
  RetainedWorkflowScope, RetainedWorkflowStep } from "./retained-tool-completion.js";
import type { WorkflowStep } from "./dag-engine.js";
import type { WorkflowToolResultInput } from "./workflow-tool-result-acceptance.js";
import type { WorkflowSyncOutcome } from "./dag-engine.js";

type Run = typeof workflowRuns.$inferSelect;
type Mission = typeof missions.$inferSelect;
type Scope = RetainedWorkflowScope;
type Marker = RetainedWorkflowMarker;
type Receipt = RetainedWorkflowReceiptRow;
type Step = RetainedWorkflowStep;
type WriteScope = { tx: TransactionDb; run: Run; step: Step; mission: Mission | null; steps: readonly Step[]; child: LockedChildStartRows | null };
type CompletionHelpers = {
  markerFor(owner: RetainedToolRequest): Marker;
  resultInput(owner: RetainedToolRequest, actual: NonNullable<ReturnType<typeof decodeRetainedToolActual>>): WorkflowToolResultInput;
  exactCondition(step: Step, scope: Scope, marker?: Marker, additionalWhere?: SQL): SQL;
  held(reason: string): Error;
};
export type RetainedSpecializedBridge = {
  held(reason: string): Error;
  scopeFor(owner: RetainedToolRequest): Scope;
  markerFor(owner: RetainedToolRequest): Marker;
  markerOf(value: unknown, companyId: string): Marker | null;
  completed(row: Receipt, owner: RetainedToolRequest, actual?: ToolOutcome): RetainedDisposition | null;
  receipt(tx: Pick<TransactionDb, "select">, id: string, lock?: boolean): Promise<Receipt | null>;
  exactCondition: CompletionHelpers["exactCondition"];
  authorityLoss(scope: Scope, run: Run, step: Step, mission: Mission | null, replaced: boolean): string | null;
  runReplaced(tx: TransactionDb, companyId: string, runId: string): Promise<boolean>;
  writeCompletion(scope: WriteScope, owner: RetainedToolRequest, actual: NonNullable<ReturnType<typeof decodeRetainedToolActual>>,
    spec: WorkflowStep | undefined, hooks: RetainedWorkflowHooks, additionalWhere?: SQL): Promise<void>;
};
type Discovery = { kind: "ordinary" } | { kind: "held" } | {
  kind: "specialized"; expected: ExpectedWorkflowToolScope; structural: boolean;
};

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function qaStep(spec: WorkflowStep | undefined, step: Step): boolean {
  return record(record(spec).toolArtifactContract).role === "qa" ||
    record(record(record(step.metadata).artifactExecution).contract).role === "qa" || owns(record(step.metadata), "toolArtifactRequest");
}

function childFence(capture: NonNullable<SpecializedToolAuthority["linkedChild"]>): SQL {
  const p = sql.raw("retained_child_parent"), i = sql.raw("retained_child_invocation");
  const s = sql.raw("retained_child_parent_step"), c = sql.raw("retained_child_run");
  const b = capture.identity as ChildStartIdentity;
  const identity = sql`${p}.id = ${b.parentRunId}::uuid and ${p}.company_id = ${b.companyId}::uuid
    and ${s}.id = ${b.parentStepRunId}::uuid and ${s}.workflow_run_id = ${p}.id and ${s}.step_id = ${b.stepId}
    and ${i}.id = ${b.invocationId}::uuid and ${i}.parent_step_run_id = ${s}.id and ${i}.company_id = ${b.companyId}::uuid
    and ${i}.state = 'linked' and ${i}.generation = 1 and ${i}.child_run_id = ${c}.id
    and ${i}.target_workflow_id = ${capture.targetWorkflowId}::uuid and ${c}.id = ${b.childRunId}::uuid
    and ${c}.company_id = ${b.companyId}::uuid and ${c}.parent_run_id = ${p}.id and ${c}.parent_step_run_id = ${s}.id`;
  return sql`exists (select 1 from ${workflowRuns} as ${p}, ${workflowStepInvocations} as ${i},
    ${workflowStepRuns} as ${s}, ${workflowRuns} as ${c} where ${identity}
    and ${p}.mission_id is not distinct from ${capture.parentMissionId}::uuid
    and ${s}.status = 'pending' and ${s}.retry_count = 0
    and not (coalesce(${s}.metadata, '{}'::jsonb) ? 'workflowRetry')
    and ${p}.status = 'running' and ${c}.workflow_id = ${capture.targetWorkflowId}::uuid
    and ${c}.mission_id is null and ${c}.status = 'running' and ${c}.child_start_materialized_at is not null)`;
}

export async function writeRetainedWorkflowCompletionInTransaction(
  scope: WriteScope, owner: RetainedToolRequest, actual: NonNullable<ReturnType<typeof decodeRetainedToolActual>>,
  spec: WorkflowStep | undefined, hooks: RetainedWorkflowHooks, additionalWhere: SQL | undefined, helpers: CompletionHelpers,
): Promise<void> {
  const input = withMachineToolTruth(helpers.resultInput(owner, actual), spec);
  const row = { run: scope.run, stepRun: scope.step }, prepared = await prepareToolCompletion(row, spec, input, hooks);
  if (prepared.toolArtifactReceipt) throw helpers.held("specialized_artifact");
  const condition = helpers.exactCondition(scope.step, { companyId: owner.companyId, tool: owner.tool,
    parameters: owner.parameters, workflow: owner.workflow! }, helpers.markerFor(owner), additionalWhere);
  if (isStructuralGateStep(spec)) {
    const capture = owner.workflow?.specialized?.structural;
    if (!capture) throw helpers.held("structural_capture_missing");
    const result = await writeStructuralCompletionInTransaction(scope, {
      mode: "retained", companyId: scope.run.companyId, workflowRunId: scope.run.id,
      workflowStepRunId: scope.step.id, missionId: scope.run.missionId, issueId: scope.step.issueId,
      step: spec, success: input.success, data: input.data, requestId: owner.workflow!.requestId,
      observedStatus: scope.step.status, observedIterationIndex: capture.iterationIndex,
      observedRequestId: owner.workflow!.requestId,
      observedCompletedAt: capture.completedAt ? new Date(capture.completedAt) : null,
      observedExecutionGeneration: owner.workflow!.executionGeneration, producerToken: capture.producerToken,
      attemptWhere: condition, source: "workflow_tool_result",
      patch: { startedAt: scope.step.startedAt ?? prepared.now, completedAt: prepared.now,
        metadata: prepared.resultMetadata, fallbackFailureSummary: input.error ?? input.stderr ?? null },
    });
    const [updated] = await scope.tx.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, scope.step.id));
    if (!result.casWon || !updated || updated.statusTransitionVersion !== scope.step.statusTransitionVersion + 1 ||
        updated.status !== (result.effectiveSuccess ? "completed" : "failed") ||
        updated.lastDispatchRequestId !== owner.workflow!.requestId || updated.executionGeneration !== owner.workflow!.executionGeneration ||
        updated.lastDispatchAcceptedAt?.toISOString() !== owner.workflow!.acceptedAt || !jsonEqual(updated.metadata, prepared.resultMetadata)) {
      throw helpers.held("completion_postcondition_failed");
    }
    return;
  }
  const updated = await writePreparedToolCompletion(scope.tx as unknown as Db, row, spec, input, prepared,
    condition, { requireFailureObservation: true });
  const next = prepared.completionPlan.effectiveSuccess ? "completed" : "failed";
  if (!updated || updated.transitionVersion !== scope.step.statusTransitionVersion + 1 || updated.status !== next ||
      updated.requestId !== owner.workflow!.requestId || updated.generation !== owner.workflow!.executionGeneration ||
      updated.acceptedAt?.toISOString() !== owner.workflow!.acceptedAt || !jsonEqual(updated.metadata, prepared.resultMetadata)) {
    throw helpers.held("completion_cas_lost");
  }
  await scope.tx.insert(workflowTransitionEvents).values({ companyId: scope.run.companyId,
    missionId: scope.run.missionId, workflowRunId: scope.run.id, workflowStepRunId: scope.step.id, issueId: scope.step.issueId,
    eventType: "workflow_step_status_transition", layer: "workflow_sync", fromStatus: scope.step.status, toStatus: next,
    reasonCode: "workflow_tool_result", idempotencyKey: `wf-step-status:${scope.step.id}:${next}:${updated.transitionVersion}`,
    payload: { source: "workflow_tool_result", priorStatus: scope.step.status, transitionVersion: updated.transitionVersion } });
}

async function discover(db: Db, scope: Scope): Promise<Discovery> {
  if (scope.workflow.specialized !== undefined) return { kind: "held" };
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, scope.workflow.workflowRunId)).limit(1);
  if (!run || run.companyId !== scope.companyId) return { kind: "ordinary" };
  const found = await findChildStartIdentityForRun(db, run.id);
  let expected: ExpectedWorkflowToolScope;
  if (found) {
    if (found.identity.generation !== 1) return { kind: "held" };
    const [parent] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, found.identity.parentRunId)).limit(1);
    if (!parent || parent.companyId !== scope.companyId) return { kind: "held" };
    const definition = await loadExecutionDefinition(db, parent.id, { requireHistorical: false });
    const parentStep = definition.steps.find((step) => step.id === found.identity.stepId);
    if (!parentStep || !isWorkflowChildStep(parentStep) || typeof parentStep.targetWorkflowId !== "string") return { kind: "held" };
    expected = { kind: "linked", companyId: scope.companyId, workflowRunId: run.id, missionId: null,
      identity: found.identity, parentMissionId: parent.missionId, targetWorkflowId: parentStep.targetWorkflowId };
  } else {
    if (run.parentRunId || run.parentStepRunId || run.triggeredBy === "workflow-step") return { kind: "held" };
    expected = { kind: "plain", companyId: scope.companyId, workflowRunId: run.id, missionId: scope.workflow.missionId };
  }
  const steps = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, run.id));
  const step = steps.find((row) => row.id === scope.workflow.stepRunId && row.stepId === scope.workflow.stepId);
  if (!step) return { kind: "ordinary" };
  const definition = await loadExecutionDefinition(db, run.id, { requireHistorical: false });
  const spec = definition.steps.find((candidate) => candidate.id === step.stepId);
  if (!spec || isWorkflowChildStep(spec) || qaStep(spec, step)) return { kind: "held" };
  const structural = isStructuralGateStep(spec);
  return structural || found ? { kind: "specialized", expected, structural } : { kind: "ordinary" };
}

async function lockedCapture(tx: TransactionDb, raw: RawWorkflowToolScope,
  scope: Scope, expectedStructural: boolean): Promise<SpecializedToolAuthority | null> {
  if (raw.scopeIssue || !raw.run) return null;
  const step = raw.steps.find((row) => row.id === scope.workflow.stepRunId && row.stepId === scope.workflow.stepId);
  if (!step) return null;
  const definition = await loadExecutionDefinition(tx as unknown as Db, raw.run.id, { requireHistorical: false });
  const spec = definition.steps.find((candidate) => candidate.id === step.stepId);
  if (!spec || isWorkflowChildStep(spec) || qaStep(spec, step) || isStructuralGateStep(spec) !== expectedStructural) return null;
  let linkedChild: SpecializedToolAuthority["linkedChild"] = null;
  if (raw.expected.kind === "linked") {
    const rows = raw.child, id = raw.expected.identity;
    if (!rows?.parent || !rows.invocation || !rows.parentStep || !rows.child) return null;
    const { parent, invocation, parentStep, child } = rows;
    const parentDefinition = await loadExecutionDefinition(tx as unknown as Db, parent.id, { requireHistorical: false });
    const parentSpec = parentDefinition.steps.find((candidate) => candidate.id === parentStep.stepId);
    if (id.generation !== 1 || !parentSpec || !isWorkflowChildStep(parentSpec) || parentSpec.targetWorkflowId !== raw.expected.targetWorkflowId ||
        invocation.targetWorkflowId !== raw.expected.targetWorkflowId || child.workflowId !== raw.expected.targetWorkflowId ||
        parent.missionId !== raw.expected.parentMissionId || child.missionId !== null ||
        child.parentRunId !== parent.id || child.parentStepRunId !== parentStep.id ||
        !parentPermitsStart(parent, parentStep, invocation) || child.status !== "running" || child.childStartMaterializedAt === null) return null;
    linkedChild = { identity: { ...id, generation: id.generation }, targetWorkflowId: raw.expected.targetWorkflowId, parentMissionId: parent.missionId };
  }
  let structural: SpecializedToolAuthority["structural"] = null;
  if (expectedStructural) {
    const producerToken = readStructuralGateProducerToken(record(step.metadata).structuralGateProducerToken);
    if (!producerToken) return null;
    structural = { producerToken, iterationIndex: step.iterationIndex ?? 0, completedAt: step.completedAt?.toISOString() ?? null };
  }
  return structural || linkedChild ? { structural, linkedChild } : null;
}

export async function bindSpecializedRetainedWorkflowTool(db: Db, scope: Scope, bridge: RetainedSpecializedBridge) {
  const discovery = await discover(db, scope);
  if (discovery.kind === "ordinary") return null;
  if (discovery.kind === "held") return { kind: "held" as const };
  return withWorkflowToolLockScope(db, discovery.expected, async (raw) => {
    const capture = await lockedCapture(raw.tx, raw, scope, discovery.structural);
    if (!capture || !raw.run || raw.scopeIssue) return { kind: "held" as const };
    const step = raw.steps.find((row) => row.id === scope.workflow.stepRunId && row.stepId === scope.workflow.stepId)!;
    const invocation = record(record(step.metadata).toolInvocation), existing = invocation.retainedCompletion;
    if (owns(invocation, "retainedCompletion")) {
      const marker = bridge.markerOf(existing, scope.companyId);
      if (!marker || marker.tool !== scope.tool || !jsonEqual(marker.workflow.specialized, capture) ||
          !sameOriginalScope(marker.workflow, scope.workflow)) return { kind: "conflict" as const };
      const row = await bridge.receipt(raw.tx, marker.receiptId, true), owner = row && requestForRow(row);
      if (!row || !owner || !validRequest(owner) || owner.consumer !== "workflow" || owner.tool !== scope.tool ||
          !jsonEqual(owner.parameters, scope.parameters) || !jsonEqual(owner.workflow, marker.workflow)) return { kind: "held" as const };
      return bridge.completed(row, owner) ? { kind: "completed" as const } : row.status === "executing" ? { kind: "held" as const } : { kind: "conflict" as const };
    }
    const retainedScope = { ...scope, workflow: { ...scope.workflow, specialized: capture } };
    const loss = bridge.authorityLoss(scope, raw.run, step, raw.mission, await bridge.runReplaced(raw.tx, scope.companyId, raw.run.id));
    const linked = capture.linkedChild;
    if (loss || linked && await bridge.runReplaced(raw.tx, scope.companyId, linked.identity.parentRunId)) return { kind: "conflict" as const };
    const where = linked ? childFence(linked) : undefined;
    const owner = await insertInternalToolReceipt(raw.tx, { ...scope, consumer: "workflow", workflow: retainedScope.workflow });
    const marker = bridge.markerFor(owner), metadata = { ...step.metadata,
      toolInvocation: { ...invocation, retainedCompletion: marker } };
    const [updated] = await raw.tx.update(workflowStepRuns).set({ metadata }).where(and(
      eq(workflowStepRuns.id, step.id), bridge.exactCondition(step, scope, undefined, where))).returning();
    if (!updated || !jsonEqual(updated.metadata, metadata)) throw bridge.held("bind_cas_lost");
    return { kind: "claim" as const, owner };
  });
}

function sameOriginalScope(left: RetainedWorkflowScope["workflow"], right: RetainedWorkflowScope["workflow"]): boolean {
  const { specialized: _left, ...leftBase } = left, { specialized: _right, ...rightBase } = right;
  return jsonEqual(leftBase, rightBase);
}

function originalMarkerMatches(context: LockedSpecializedToolContext, owner: RetainedToolRequest, bridge: RetainedSpecializedBridge): boolean {
  const step = context.steps.find((row) => row.id === owner.workflow!.stepRunId && row.stepId === owner.workflow!.stepId);
  return !!step && jsonEqual(bridge.markerOf(record(record(step.metadata).toolInvocation).retainedCompletion, owner.companyId), bridge.markerFor(owner));
}

export async function finalizeSpecializedRetainedWorkflowTool(db: Db, owner: RetainedToolRequest,
  actual: NonNullable<ReturnType<typeof decodeRetainedToolActual>>, hooks: RetainedWorkflowHooks,
  bridge: RetainedSpecializedBridge): Promise<RetainedDisposition> {
  return withSpecializedToolAuthority(db, owner, async (context) => {
    const row = await bridge.receipt(context.tx, owner.receiptId, true);
    if (!row || !validRequest(requestForRow(row)) || !jsonEqual(requestForRow(row), owner)) throw bridge.held("receipt_missing_or_wrong_owner");
    const prior = bridge.completed(row, owner, actual);
    if (prior) return prior;
    if (row.status === "completed") throw bridge.held("receipt_conflict");
    const staged = decodeRetainedToolOutcome(row.resultBody), savedActual = staged && decodeRetainedToolActual(staged.actual);
    if (row.status !== "executing" || row.completedAt !== null || row.resultStatus !== null || !staged || staged.response ||
        staged.disposition || staged.receiptId !== owner.receiptId || !savedActual || !jsonEqual(staged.actual, actual)) {
      throw bridge.held("staged_actual_conflict");
    }
    const classified = await context.classify(), workflow = owner.workflow!;
    if (classified.authority.kind === "held") throw bridge.held(classified.authority.reason);
    let disposition: RetainedDisposition;
    if (classified.authority.kind === "lost") {
      if (!originalMarkerMatches(context, owner, bridge)) throw bridge.held("loss_without_exact_marker");
      disposition = { kind: "superseded", reason: classified.authority.reason, workflow };
    } else {
      const run = classified.run, step = classified.steps.find((candidate) => candidate.id === workflow.stepRunId && candidate.stepId === workflow.stepId);
      if (!run || !step) throw bridge.held("locked_scope_missing");
      const spec = (await loadExecutionDefinition(context.tx as unknown as Db, run.id, { requireHistorical: false })).steps
        .find((candidate) => candidate.id === step.stepId);
      const capture = workflow.specialized!, linked = capture.linkedChild;
      const writeScope: WriteScope = { tx: context.tx, run, step, mission: classified.mission,
        steps: classified.steps, child: classified.child };
      await bridge.writeCompletion(writeScope, owner, savedActual, spec, hooks, linked ? childFence(linked) : undefined);
      disposition = { kind: "applied", reason: "current_owner", workflow };
    }
    await completeRetainedToolReceipt(context.tx as unknown as Db, owner, savedActual, { disposition });
    return disposition;
  });
}

/** A swallowed child-hook failure leaves a terminal child's retained consumer unacknowledged. */
export async function verifySpecializedPostCommit(db: Db, owner: RetainedToolRequest, sync: WorkflowSyncOutcome,
  held: (reason: string) => Error): Promise<void> {
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, owner.workflow!.workflowRunId)).limit(1);
  if (!run || sync.kind !== "synced" || sync.result.status !== run.status) throw held("post_commit_sync_unverified");
  const capture = owner.workflow!.specialized?.linkedChild;
  if (!capture || !["completed", "failed", "cancelled", "canceled", "aborted", "timed-out"].includes(run.status)) return;
  const { identity, targetWorkflowId } = capture;
  const [parent] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, identity.parentRunId)).limit(1);
  const [invocation] = await db.select().from(workflowStepInvocations).where(eq(workflowStepInvocations.id, identity.invocationId)).limit(1);
  const [parentStep] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, identity.parentStepRunId)).limit(1);
  const parentResult = record(record(parentStep?.metadata).toolResult), proof = record(parentResult.data);
  const successfulChild = run.status === "completed";
  if (!parent || !invocation || !parentStep || run.companyId !== owner.companyId || run.workflowId !== targetWorkflowId ||
      run.parentRunId !== parent.id || run.parentStepRunId !== parentStep.id || run.missionId !== null ||
      invocation.companyId !== owner.companyId || invocation.parentStepRunId !== parentStep.id ||
      invocation.childRunId !== run.id || invocation.state !== "linked" || invocation.generation !== 1 ||
      invocation.targetWorkflowId !== targetWorkflowId || parentStep.workflowRunId !== parent.id ||
      parentStep.stepId !== identity.stepId || parentStep.status !== (successfulChild ? "completed" : "failed") ||
      parentStep.completedAt === null || parentResult.toolName !== "workflow" || parentResult.success !== successfulChild ||
      proof.childRunId !== run.id || proof.childStatus !== run.status) throw held("parent_child_settlement_unverified");
}

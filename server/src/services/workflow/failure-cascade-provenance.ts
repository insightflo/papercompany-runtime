// C04: capture causes under the cascade's existing locks, before any skip or terminal write.
// Metadata is part of the skip UPDATE: persistence errors must abort the outer transaction.
import { and, eq } from "drizzle-orm";
import { workflowRecoveryAuthorities, workflowRunDefinitions, workflowRuns, workflowStepRuns,
  workflowTransitionEvents } from "@paperclipai/db";
import { stableStringify } from "../issue-execution-cards/hash.js";
import { loadExecutionDefinition } from "./execution-definition.js";
import { resolveEdges } from "./control-flow/edge-condition.js";
import { WORKFLOW_SYNC_SOURCES } from "./workflow-sync-source.js";
import type { WorkflowStep } from "./dag-engine.js";
import type { CascadeTx, FailureCascadeRun, FailureCascadeStep } from "./failure-cascade-writes.js";

type Step = typeof workflowStepRuns.$inferSelect;
type Event = typeof workflowTransitionEvents.$inferSelect;
type Source = "workflow_reconciler" | "workflow_deadlock_reconciler";
type Identity = ReturnType<typeof identity>;
type Trace = { causes: Step[]; complete: boolean };
interface Provenance {
  schemaVersion: 1;
  companyId: string;
  missionId: string | null;
  workflowRunId: string;
  authorityVersion: number;
  definitionHash: string | null;
  source: Source;
  target: Identity;
  causes: Identity[];
  complete: boolean;
}

export function unlaunched(row: Step): boolean {
  return row.startedAt === null && row.lastDispatchAttemptAt === null
    && row.lastDispatchAcceptedAt === null && row.lastDispatchRequestId === null
    && row.dispatchOwnerWakeupRequestId === null && row.dispatchOwnerHeartbeatRunId === null
    && row.evidenceReadyAt === null && row.metadata?.toolResult == null;
}

/** Missing/ambiguous history is deliberately not upgraded into a failure cause. */
export function currentTransition(
  events: Event[], run: FailureCascadeRun, row: Step, generationDelta = 1,
): Event | undefined {
  if (row.statusTransitionVersion < 1) return undefined;
  const matches = events.filter(event => event.eventType === "workflow_step_status_transition"
    && event.layer === "workflow_sync" && event.missionId === run.missionId
    && WORKFLOW_SYNC_SOURCES.some(source => source === event.reasonCode)
    && event.workflowStepRunId === row.id && event.issueId === row.issueId
    && event.toStatus === row.status && typeof event.fromStatus === "string" && event.fromStatus !== row.status
    && event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload)
    && event.payload.priorStatus === event.fromStatus && event.payload.source === event.reasonCode
    && event.payload.transitionVersion === row.statusTransitionVersion
    && event.idempotencyKey === `wf-step-status:${row.id}:${row.status}:${row.statusTransitionVersion}`
    && (event.executionGeneration === null || event.executionGeneration === row.executionGeneration - generationDelta));
  const event = matches.length === 1 ? matches[0] : undefined;
  if (!event || events.some(later => later.eventType === "workflow_authority_transition"
    && later.workflowStepRunId === row.id && later.createdAt >= event.createdAt
    && (later.payload?.transition === "generation_advanced" || later.reasonCode === "workflow_resume_reset"
      || (later.executionGeneration !== null && later.executionGeneration !== row.executionGeneration - generationDelta)))) return undefined;
  return event;
}

/** Historical skips need the same current transition/source checks as official recovery. */
function historicalSkipTransition(events: Event[], run: FailureCascadeRun, row: Step): Event | undefined {
  const event = currentTransition(events, run, row, 0);
  const source = row.metadata?.failureCascadeSkipped === true && row.metadata?.controlFlowSkipped !== true
    ? "workflow_reconciler" : row.metadata?.controlFlowSkipped === true && row.metadata?.failureCascadeSkipped !== true
      ? "workflow_deadlock_reconciler" : null;
  return unlaunched(row) && event?.fromStatus === "pending" && event.reasonCode === source ? event : undefined;
}

export function orderedGraph(steps: WorkflowStep[], rows: Step[]): WorkflowStep[] | null {
  const definitions = new Map(steps.map(step => [step.id, step]));
  if (definitions.size !== steps.length || rows.length !== steps.length
    || new Set(rows.map(row => row.stepId)).size !== rows.length
    || rows.some(row => !definitions.has(row.stepId))) return null;
  const visiting = new Set<string>(), visited = new Set<string>(), ordered: WorkflowStep[] = [];
  function visit(id: string): boolean {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    const step = definitions.get(id);
    if (!step) return false;
    visiting.add(id);
    for (const edge of resolveEdges(step)) if (!visit(edge.stepId)) return false;
    visiting.delete(id);
    visited.add(id);
    ordered.push(step);
    return true;
  }
  return steps.every(step => visit(step.id)) ? ordered : null;
}

function identity(row: Step, generationDelta = 0, transitionDelta = 0) {
  return {
    stepRunId: row.id, stepId: row.stepId, issueId: row.issueId,
    executionGeneration: row.executionGeneration - generationDelta,
    statusTransitionVersion: row.statusTransitionVersion - transitionDelta,
    dispatchRequestId: row.lastDispatchRequestId,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function matchesContext(value: unknown, run: FailureCascadeRun, hash: string, source: string | null) {
  const proof = record(value);
  return proof !== null && proof.schemaVersion === 1 && proof.complete === true
    && proof.companyId === run.companyId && proof.missionId === run.missionId
    && proof.workflowRunId === run.id && proof.authorityVersion === run.dispatchAuthorityVersion
    && proof.definitionHash === hash && proof.source === source
    && (source === "workflow_reconciler" || source === "workflow_deadlock_reconciler");
}

/** The target identity records the pending row, immediately before its ONE skip transition. */
function matchesTarget(proof: Record<string, unknown>, row: Step, generationDelta: number) {
  return row.executionGeneration >= generationDelta && row.statusTransitionVersion >= 1
    && stableStringify(proof.target) === stableStringify(identity(row, generationDelta, 1));
}

/** Absence retains the accepted historical proof path; malformed/new evidence never falls back. */
export function permitsRecordedCascadeRecovery(
  row: Step, failedStep: Step, observedRun: FailureCascadeRun, definitionHash: string, source: string | null,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(row.metadata ?? {}, "failureCascadeProvenance")) return true;
  const proof = record(row.metadata?.failureCascadeProvenance);
  // finalizeRunTerminal advanced every generation once; official recovery advanced it once more.
  // Compare the captured failed row to the pre-recovery target (one increment), never any older attempt.
  return proof !== null && failedStep.executionGeneration >= 1
    && matchesContext(proof, observedRun, definitionHash, source) && matchesTarget(proof, row, 2)
    && stableStringify(proof.causes) === stableStringify([identity(failedStep, 1)]);
}

/** SELECT-only; callers persist the returned evidence with their existing skip writes. */
export async function captureFailureCascadeProvenance(
  tx: CascadeTx, observedRun: FailureCascadeRun, selected: readonly FailureCascadeStep[], source: Source,
): Promise<Map<string, Provenance>> {
  if (!selected.length) return new Map();
  const [run] = await tx.select().from(workflowRuns).where(and(
    eq(workflowRuns.id, observedRun.id), eq(workflowRuns.companyId, observedRun.companyId),
  )).for("update");
  const rows = await tx.select().from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, observedRun.id))
    .orderBy(workflowStepRuns.stepId, workflowStepRuns.id).for("update");
  const byId = new Map(rows.map(row => [row.id, row]));
  const selectedIds = new Set(selected.map(row => row.id));
  if (!run || run.status !== "running" || run.missionId !== observedRun.missionId
    || run.dispatchAuthorityVersion !== observedRun.dispatchAuthorityVersion
    || selectedIds.size !== selected.length || selected.some(observed => {
      const row = byId.get(observed.id);
      return !row || row.status !== "pending" || observed.status !== "pending"
        || row.stepId !== observed.stepId || row.issueId !== observed.issueId
        || row.statusTransitionVersion !== observed.statusTransitionVersion
        || stableStringify(row.metadata) !== stableStringify(observed.metadata);
    })) throw new Error("failure_cascade_provenance_observation_lost");
  const [snapshot] = await tx.select().from(workflowRunDefinitions).where(and(
    eq(workflowRunDefinitions.workflowRunId, run.id), eq(workflowRunDefinitions.companyId, run.companyId),
  ));
  // Missing history stays explicitly unproven; never substitute a current-definition hash.
  const definition = snapshot ? await loadExecutionDefinition(tx, run.id, { requireHistorical: true }) : null;
  const ordered = definition?.executionMode === "static_dag" ? orderedGraph(definition.steps, rows) : null;
  const hash = definition?.definitionHash ?? null;
  // Only a missing field can adopt historical proof. An explicit invalid/new record cannot.
  const needsHistory = ordered !== null && rows.some(row => row.status === "skipped"
    && !Object.prototype.hasOwnProperty.call(row.metadata ?? {}, "failureCascadeProvenance"));
  const events = needsHistory ? await tx.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, run.companyId), eq(workflowTransitionEvents.workflowRunId, run.id),
  )) : [];
  const recoveries = needsHistory ? await tx.select().from(workflowRecoveryAuthorities).where(and(
    eq(workflowRecoveryAuthorities.companyId, run.companyId), eq(workflowRecoveryAuthorities.workflowRunId, run.id),
  )) : [];
  const byStep = new Map(rows.map(row => [row.stepId, row]));
  const traces = new Map<string, Trace>();
  for (const step of ordered ?? []) {
    const row = byStep.get(step.id)!;
    if (row.status === "failed" || row.status === "completed") {
      traces.set(step.id, { causes: row.status === "failed" ? [row] : [], complete: true });
      continue;
    }
    const edges = resolveEdges(step), causes = new Map<string, Step>();
    let complete = ((row.status === "pending" && selectedIds.has(row.id)) || row.status === "skipped")
      && (!step.type || ["agent", "tool"].includes(step.type))
      && (!step.triggerOn || step.triggerOn === "normal") && edges.length > 0;
    for (const edge of edges) {
      if (edge.isBackEdge || (edge.when && edge.when !== "success")) { complete = false; continue; }
      const upstream = traces.get(edge.stepId);
      if (!upstream?.complete) complete = false;
      for (const cause of upstream?.causes ?? []) causes.set(cause.id, cause);
    }
    const allCauses = [...causes.values()].sort((a, b) => a.id.localeCompare(b.id));
    if (!allCauses.length) complete = false;
    if (row.status === "skipped") {
      const prior = record(row.metadata?.failureCascadeProvenance);
      const priorSource = row.metadata?.failureCascadeSkipped === true && row.metadata?.controlFlowSkipped !== true
        ? "workflow_reconciler" : row.metadata?.controlFlowSkipped === true && row.metadata?.failureCascadeSkipped !== true
          ? "workflow_deadlock_reconciler" : null;
      if (Object.prototype.hasOwnProperty.call(row.metadata ?? {}, "failureCascadeProvenance")) {
        complete = complete && prior !== null && hash !== null
          && matchesContext(prior, run, hash, priorSource) && matchesTarget(prior, row, 0)
          && stableStringify(prior.causes) === stableStringify(allCauses.map(cause => identity(cause)));
      } else {
        const event = historicalSkipTransition(events, run, row);
        complete = complete && event !== undefined && snapshot !== undefined
          && allCauses.every(cause => {
            const failure = currentTransition(events, run, cause, 0);
            return failure !== undefined && snapshot.capturedAt <= failure.createdAt
              && failure.createdAt <= event.createdAt && !recoveries.some(recovery => recovery.status === "consumed"
                && (!recovery.consumedAt || recovery.consumedAt >= failure.createdAt));
          }) && edges.every(edge => {
            const predecessor = byStep.get(edge.stepId)!;
            const priorEvent = predecessor.status === "skipped"
              ? historicalSkipTransition(events, run, predecessor) : currentTransition(events, run, predecessor, 0);
            return priorEvent !== undefined && (predecessor.status === "completed"
              ? priorEvent.createdAt < event.createdAt : priorEvent.createdAt <= event.createdAt);
          });
      }
    }
    traces.set(step.id, { causes: allCauses, complete });
  }
  return new Map(selected.map(observed => {
    const row = byId.get(observed.id)!, trace = traces.get(row.stepId);
    const proof: Provenance = {
      schemaVersion: 1, companyId: run.companyId, missionId: run.missionId, workflowRunId: run.id,
      authorityVersion: run.dispatchAuthorityVersion, definitionHash: hash, source, target: identity(row),
      causes: (trace?.causes ?? []).map(cause => identity(cause)), complete: trace?.complete === true,
    };
    return [row.id, proof];
  }));
}

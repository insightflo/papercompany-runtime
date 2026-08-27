// Exact structural PASS evidence required before semantic QA can launch.

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowStepRuns } from "@paperclipai/db";
import { isQaLikeStep } from "../../missions/supervision-helpers.js";
import { resolveEdges } from "./edge-condition.js";
import type { ConditionalEdge } from "./types.js";
import {
  isStructuralGateStep,
  readStructuralGateProducerToken,
  sameStructuralGateProducerToken,
  type StructuralGateProducerToken,
} from "./structural-gate.js";
import { loadStructuralGateVerdictByRequest } from "./structural-gate-ledger.js";
import type { WorkflowStep } from "../dag-engine.js";

type StepRun = typeof workflowStepRuns.$inferSelect;

/** Minimal structural shape shared by dag-engine WorkflowStep and the
 * structural-gate-rework pass input. Keep assignable-from WorkflowStep. */
export interface StructuralReadinessStep {
  id: string;
  name?: string;
  title?: string;
  agentId?: string;
  type?: string;
  qaType?: string;
  toolNames?: string[];
  dependencies?: string[];
  conditionalDependencies?: ConditionalEdge[];
}

function buildStepIndex(steps: readonly StructuralReadinessStep[]): Map<string, StructuralReadinessStep> {
  return new Map(steps.map((step) => [step.id, step] as const));
}

export interface StructuralGateCoverage {
  gateStepId: string;
  toolName: string;
  producerStepId: string;
  producerIterationIndex: number;
  producerCompletedAt: string;
}

export interface SemanticStructuralReadiness {
  ready: boolean;
  coverage: StructuralGateCoverage[];
}

function forwardDependencies(step: StructuralReadinessStep): string[] {
  return resolveEdges(step)
    .filter((edge) => edge.isBackEdge !== true)
    .map((edge) => edge.stepId);
}

function producerForGate(
  gate: StructuralReadinessStep,
  stepsById: Map<string, StructuralReadinessStep>,
): StructuralReadinessStep | null {
  const producers = forwardDependencies(gate)
    .map((id) => stepsById.get(id))
    .filter((step): step is StructuralReadinessStep => Boolean(step) && !isStructuralGateStep(step));
  return producers.length === 1 ? producers[0] : null;
}

function tokenForProducer(producer: StructuralReadinessStep, stepRun: StepRun | undefined): StructuralGateProducerToken | null {
  if (!stepRun || stepRun.status !== "completed" || !stepRun.completedAt) return null;
  return {
    producerStepId: producer.id,
    iterationIndex: stepRun.iterationIndex ?? 0,
    completedAt: stepRun.completedAt.toISOString(),
  };
}

function requiredGates(step: StructuralReadinessStep, stepsById: Map<string, StructuralReadinessStep>): StructuralReadinessStep[] {
  if (!isQaLikeStep(step) || isStructuralGateStep(step)) return [];
  return forwardDependencies(step)
    .map((id) => stepsById.get(id))
    .filter((candidate): candidate is StructuralReadinessStep => Boolean(candidate) && isStructuralGateStep(candidate));
}

/** Capture the producer generation at structural-gate dispatch. A missing token
 * fails closed later; this prevents status-only PASS from unlocking QA. */
export async function captureStructuralGateProducerToken(input: {
  db: Db;
  workflowRunId: string;
  gate: WorkflowStep;
  steps: WorkflowStep[];
}): Promise<StructuralGateProducerToken | null> {
  if (!isStructuralGateStep(input.gate)) return null;
  const stepsById = buildStepIndex(input.steps);
  const producer = producerForGate(input.gate, stepsById);
  if (!producer) return null;
  const [producerRun] = await input.db.select().from(workflowStepRuns).where(and(
    eq(workflowStepRuns.workflowRunId, input.workflowRunId),
    eq(workflowStepRuns.stepId, producer.id),
  )).limit(1);
  return tokenForProducer(producer, producerRun);
}

/** Checks every direct structural dependency for the exact current-request PASS
 * and the exact producer token captured when that gate was dispatched. */
export async function evaluateSemanticStructuralReadiness(input: {
  db: Db;
  companyId: string;
  workflowRunId: string;
  step: WorkflowStep;
  steps: WorkflowStep[];
  stepRuns?: StepRun[];
}): Promise<SemanticStructuralReadiness> {
  const stepsById = buildStepIndex(input.steps);
  const gates = requiredGates(input.step, stepsById);
  if (gates.length === 0) return { ready: true, coverage: [] };
  const stepRuns = input.stepRuns ?? await input.db.select().from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, input.workflowRunId));
  const runsByStepId = new Map(stepRuns.map((run) => [run.stepId, run]));
  const coverage: StructuralGateCoverage[] = [];

  for (const gate of gates) {
    const gateRun = runsByStepId.get(gate.id);
    const requestId = gateRun?.lastDispatchRequestId;
    const producer = producerForGate(gate, stepsById);
    const expectedToken = producer ? tokenForProducer(producer, runsByStepId.get(producer.id)) : null;
    const capturedToken = readStructuralGateProducerToken(
      gateRun?.metadata && typeof gateRun.metadata === "object"
        ? (gateRun.metadata as Record<string, unknown>).structuralGateProducerToken
        : null,
    );
    if (!gateRun || gateRun.status !== "completed" || !requestId || !producer || !expectedToken
      || !sameStructuralGateProducerToken(capturedToken, expectedToken)) return { ready: false, coverage: [] };

    const verdict = await loadStructuralGateVerdictByRequest(input.db, input.companyId, gateRun.id, requestId);
    if (verdict?.verdict !== "pass" || !sameStructuralGateProducerToken(verdict.producerToken, expectedToken)
      || verdict.observedAt.getTime() < new Date(expectedToken.completedAt).getTime()) {
      return { ready: false, coverage: [] };
    }
    const toolName = Array.isArray(gate.toolNames) ? gate.toolNames.find((name) => name.trim()) ?? "unknown" : "unknown";
    coverage.push({
      gateStepId: gate.id,
      toolName,
      producerStepId: expectedToken.producerStepId,
      producerIterationIndex: expectedToken.iterationIndex,
      producerCompletedAt: expectedToken.completedAt,
    });
  }
  return { ready: true, coverage: coverage.slice(0, 8) };
}

/** Bounded, structured evidence passed to an LLM QA rubric. No tool prose,
 * comments, or generic wording rules are treated as a machine contract. */
export function renderStructuralGateCoverageLines(coverage: StructuralGateCoverage[]): string[] {
  if (coverage.length === 0) return [];
  return [
    "## Structural validation evidence",
    "",
    "The following exact current-generation machine checks passed. Do not repeat their declared machine checks; continue with semantic review and any other required completion proof.",
    ...coverage.slice(0, 8).map((item) =>
      `- gate=${item.gateStepId}; tool=${item.toolName}; producer=${item.producerStepId}; generation=${item.producerIterationIndex}; producerCompletedAt=${item.producerCompletedAt}; verdict=pass`,
    ),
    "",
  ];
}

/** [GAZ 4f8cfacb] A completed structural gate whose PASS evidence is bound to
 * an OLDER completion of the SAME producer iteration. The producer re-completed
 * within the same iteration (double-completion re-stamp), so the gate's
 * dispatch-time token and its verdict ledger row no longer match the producer's
 * current generation — every later semantic-QA launch fails closed forever. */
export interface StaleStructuralGateRequeueFinding {
  qaStepId: string;
  gateStepId: string;
  gateStepRunId: string;
  requestId: string;
  producerStepId: string;
  producerIterationIndex: number;
  producerCompletedAt: string;
  gateEvidenceCompletedAt: string | null;
  verdictObservedAt: string | null;
}

function sameGenerationButOlder(evidence: StructuralGateProducerToken, current: StructuralGateProducerToken): boolean {
  return evidence.producerStepId === current.producerStepId
    && evidence.iterationIndex === current.iterationIndex
    && new Date(evidence.completedAt).getTime() < new Date(current.completedAt).getTime();
}

/** Finds pending (never-launched) QA-like steps whose required structural gate
 * is completed against a stale same-iteration producer completion. Read-only;
 * the caller (structural-gate-rework) owns the CAS reset and the structured
 * finding event. Rework generations (iteration bump) are out of scope — the
 * existing applyStructuralGatePass owns those. */
export async function findStaleStructuralGateRequeues(input: {
  db: Db;
  companyId: string;
  workflowRunId: string;
  steps: readonly StructuralReadinessStep[];
  stepRuns: readonly StepRun[];
}): Promise<StaleStructuralGateRequeueFinding[]> {
  const stepsById = buildStepIndex(input.steps);
  const runsByStepId = new Map(input.stepRuns.map((run) => [run.stepId, run] as const));
  const findings: StaleStructuralGateRequeueFinding[] = [];
  const seenGateRunIds = new Set<string>();

  for (const step of input.steps) {
    if (isStructuralGateStep(step) || !isQaLikeStep(step)) continue;
    const qaRun = runsByStepId.get(step.id);
    // Only the diagnosed deadlock shape: QA is waiting, never launched, and its
    // createWorkflowStepIssue keeps failing closed on readiness.
    if (!qaRun || qaRun.status !== "pending" || qaRun.issueId != null) continue;

    for (const gate of requiredGates(step, stepsById)) {
      const gateRun = runsByStepId.get(gate.id);
      if (!gateRun || gateRun.status !== "completed" || !gateRun.lastDispatchRequestId) continue;
      if (seenGateRunIds.has(gateRun.id)) continue;
      const producer = producerForGate(gate, stepsById);
      if (!producer) continue;
      const expectedToken = tokenForProducer(producer, runsByStepId.get(producer.id));
      if (!expectedToken) continue;

      const capturedToken = readStructuralGateProducerToken(
        gateRun.metadata && typeof gateRun.metadata === "object"
          ? (gateRun.metadata as Record<string, unknown>).structuralGateProducerToken
          : null,
      );
      const verdict = await loadStructuralGateVerdictByRequest(
        input.db, input.companyId, gateRun.id, gateRun.lastDispatchRequestId,
      );

      // Evidence identity: when any producer token is readable it must bind the
      // SAME producer and iteration as the current generation — only the
      // completion timestamp may differ (older). Different iterations are
      // rework territory owned by applyStructuralGatePass.
      const identity = capturedToken ?? verdict?.producerToken ?? null;
      const currentCompletedAtMs = new Date(expectedToken.completedAt).getTime();
      let stale = false;
      if (identity) {
        stale = identity.producerStepId === expectedToken.producerStepId
          && identity.iterationIndex === expectedToken.iterationIndex
          && (new Date(identity.completedAt).getTime() < currentCompletedAtMs
            || (verdict != null && verdict.observedAt.getTime() < currentCompletedAtMs));
      } else {
        // Legacy gate without any producer token: the exact-request verdict
        // predates the producer's current completion of the pre-rework
        // generation. Fail-closed requeue, mirroring readiness semantics.
        stale = verdict != null
          && verdict.observedAt.getTime() < currentCompletedAtMs
          && expectedToken.iterationIndex === 0;
      }
      if (!stale) continue;

      seenGateRunIds.add(gateRun.id);
      findings.push({
        qaStepId: step.id,
        gateStepId: gate.id,
        gateStepRunId: gateRun.id,
        requestId: gateRun.lastDispatchRequestId,
        producerStepId: expectedToken.producerStepId,
        producerIterationIndex: expectedToken.iterationIndex,
        producerCompletedAt: expectedToken.completedAt,
        gateEvidenceCompletedAt: identity?.completedAt ?? null,
        verdictObservedAt: verdict ? verdict.observedAt.toISOString() : null,
      });
    }
  }
  return findings;
}

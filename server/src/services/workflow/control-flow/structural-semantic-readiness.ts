// Exact structural PASS evidence required before semantic QA can launch.

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowStepRuns } from "@paperclipai/db";
import { isQaLikeStep } from "../../missions/supervision-helpers.js";
import { resolveEdges } from "./edge-condition.js";
import {
  isStructuralGateStep,
  readStructuralGateProducerToken,
  sameStructuralGateProducerToken,
  type StructuralGateProducerToken,
} from "./structural-gate.js";
import { loadStructuralGateVerdictByRequest } from "./structural-gate-ledger.js";
import type { WorkflowStep } from "../dag-engine.js";

type StepRun = typeof workflowStepRuns.$inferSelect;

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

function forwardDependencies(step: WorkflowStep): string[] {
  return resolveEdges(step)
    .filter((edge) => edge.isBackEdge !== true)
    .map((edge) => edge.stepId);
}

function producerForGate(gate: WorkflowStep, stepsById: Map<string, WorkflowStep>): WorkflowStep | null {
  const producers = forwardDependencies(gate)
    .map((id) => stepsById.get(id))
    .filter((step): step is WorkflowStep => Boolean(step) && !isStructuralGateStep(step));
  return producers.length === 1 ? producers[0] : null;
}

function tokenForProducer(producer: WorkflowStep, stepRun: StepRun | undefined): StructuralGateProducerToken | null {
  if (!stepRun || stepRun.status !== "completed" || !stepRun.completedAt) return null;
  return {
    producerStepId: producer.id,
    iterationIndex: stepRun.iterationIndex ?? 0,
    completedAt: stepRun.completedAt.toISOString(),
  };
}

function requiredGates(step: WorkflowStep, stepsById: Map<string, WorkflowStep>): WorkflowStep[] {
  if (!isQaLikeStep(step) || isStructuralGateStep(step)) return [];
  return forwardDependencies(step)
    .map((id) => stepsById.get(id))
    .filter((candidate): candidate is WorkflowStep => Boolean(candidate) && isStructuralGateStep(candidate));
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
  const stepsById = new Map(input.steps.map((step) => [step.id, step]));
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
  const stepsById = new Map(input.steps.map((candidate) => [candidate.id, candidate]));
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

// server/src/services/missions/terminal-mission-workflow-continuation.ts
//
// [파일 목적] terminal-mission 판정을 위한 "authoritative workflow continuation" 분류기.
//   DAG engine 의 edge-condition 분류기(classifyStepActivation/resolveEdges/conditionalEdgeHolds)와
//   동일한 QA-gate 분류(isQaLikeStep) + persisted validation-verdict facts 를 재사용해 failure/always edge,
//   IF control-node outcome, qa_request_changes back-edge, control-node contract 실패까지 정확히 평가한다.
//   engine semantics 를 변경하지 않는 읽기 전용 관측자. 불확실하면 fail-closed(continuation 으로 suppress).
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, workflowTransitionEvents } from "@paperclipai/db";
import { classifyStepActivation, resolveEdges, type EdgeBearingStep, type PredFacts, type PredStatus } from "../workflow/control-flow/edge-condition.js";
import { workflowControlNodeResultSchema } from "@paperclipai/shared";
import { isQaLikeStep } from "../workflow-step-role.js";
import { isStepRunAwaitingRetry } from "../workflow/retry-policy.js";

const KNOWN_STEP_RUN_STATUSES = new Set(["completed", "failed", "skipped", "cancelled", "canceled", "pending", "running"]);
const TERMINAL_STEP_RUN_STATUSES = new Set(["completed", "failed", "skipped", "cancelled", "canceled"]);

export type WorkflowContinuationStepRun = {
  stepId: string;
  status: string;
  issueId?: string | null;
  metadata?: unknown;
};

export type WorkflowContinuationStepRow = {
  stepRun: WorkflowContinuationStepRun;
  run: { id: string };
  definition: { stepsJson: unknown };
};

export type WorkflowContinuationVerdict =
  | { remains: true; reason: string }
  | { remains: false };

type StepLike = EdgeBearingStep & { type?: string };

export type ValidationVerdictObservation = {
  verdict: "pass" | "request_changes" | null;
  observedAt: Date | null;
};

// dag-engine loadLatestValidationVerdicts 의 읽기 전용 복제(동일 쿼리/의미). qa_request_changes edge 의
//   권위 verdict 원천. structured workflow_validation_verdict(pass/request_changes) 만 최신 관측값으로 사용.
export async function loadTerminalValidationVerdicts(
  db: Db,
  issueIds: string[],
): Promise<Map<string, ValidationVerdictObservation>> {
  const verdicts = new Map<string, ValidationVerdictObservation>();
  if (issueIds.length === 0) return verdicts;

  const issueRows = await db.select({ id: issues.id, startedAt: issues.startedAt }).from(issues).where(inArray(issues.id, issueIds));
  const minObservedAtByIssueId = new Map(issueRows.map((row) => [row.id, row.startedAt ?? null]));
  const withinWindow = (issueId: string | null, observedAt: Date | null): boolean => {
    if (!issueId || !observedAt) return true;
    const minObservedAt = minObservedAtByIssueId.get(issueId);
    return !minObservedAt || observedAt.getTime() >= minObservedAt.getTime();
  };

  const eventRows = await db
    .select({ issueId: workflowTransitionEvents.issueId, verdict: workflowTransitionEvents.verdict, createdAt: workflowTransitionEvents.createdAt })
    .from(workflowTransitionEvents)
    .where(and(
      inArray(workflowTransitionEvents.issueId, issueIds),
      eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
    ))
    .orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id));
  for (const event of eventRows) {
    const observedAt = event.createdAt ?? null;
    if (!withinWindow(event.issueId, observedAt)) continue;
    if (event.verdict !== "pass" && event.verdict !== "request_changes") continue;
    if (!event.issueId || verdicts.has(event.issueId)) continue;
    verdicts.set(event.issueId, { verdict: event.verdict, observedAt });
  }
  return verdicts;
}

function readSteps(stepsJson: unknown): { steps: StepLike[]; malformed: boolean } {
  if (!Array.isArray(stepsJson)) return { steps: [], malformed: true };
  const steps: StepLike[] = [];
  for (const raw of stepsJson) {
    if (!raw || typeof raw !== "object" || typeof (raw as { id?: unknown }).id !== "string") {
      return { steps: [], malformed: true };
    }
    steps.push(raw as StepLike);
  }
  return { steps, malformed: false };
}

// dag-engine deriveIfControlOutcome 의 읽기 전용 복제. completed IF step 의 검증된 outcome 만 신뢰.
function deriveIfControlOutcome(step: StepLike, run: WorkflowContinuationStepRun | undefined): { controlOutcome?: "condition_true" | "condition_false" } {
  if (!run || run.status !== "completed") return {};
  if (step.type !== "if") return {};
  const metadata = (run.metadata ?? null) as Record<string, unknown> | null;
  const raw = metadata?.controlNodeResult;
  if (!raw || typeof raw !== "object") return {};
  const parsed = workflowControlNodeResultSchema.safeParse(raw);
  if (!parsed.success || parsed.data.nodeType !== "if") return {};
  return { controlOutcome: parsed.data.outcome };
}

function buildPredsByStepId(
  steps: StepLike[],
  runByStepId: Map<string, WorkflowContinuationStepRun>,
  validationVerdictsByIssueId: Map<string, ValidationVerdictObservation> | undefined,
): Map<string, PredFacts> {
  const facts = new Map<string, PredFacts>();
  for (const step of steps) {
    const run = runByStepId.get(step.id);
    const liveVerdict = run?.issueId ? validationVerdictsByIssueId?.get(run.issueId)?.verdict ?? null : null;
    facts.set(step.id, {
      status: (run?.status ?? "pending") as PredStatus,
      isQaGate: isQaLikeStep(step),
      verdict: liveVerdict,
      // map 이 제공되면 verdictChecked=true → edge-condition 이 verdict=null 을 "조사했으나 판정 없음"으로 해석.
      verdictChecked: validationVerdictsByIssueId !== undefined,
      ...deriveIfControlOutcome(step, run),
    });
  }
  return facts;
}

function continuation(reason: string): WorkflowContinuationVerdict {
  return { remains: true, reason };
}

// [목적] mission 의 workflow DAG 에 "지금/곧 실행 가능한 step"이 권위 있게 남았는지 판정(fail-closed).
//   불확실(malformed definition / missing stepRun / unknown status / dangling predecessor)하면 continuation(suppress).
export function missionWorkflowContinuationRemains(
  stepRows: readonly WorkflowContinuationStepRow[],
  options: { validationVerdictsByIssueId?: Map<string, ValidationVerdictObservation> } = {},
): WorkflowContinuationVerdict {
  const byRun = new Map<string, { steps: StepLike[]; runByStepId: Map<string, WorkflowContinuationStepRun> }>();
  for (const row of stepRows) {
    const parsed = readSteps(row.definition.stepsJson);
    if (parsed.malformed) return continuation(`uncertain:malformed-steps-json:run:${row.run.id}`);
    let entry = byRun.get(row.run.id);
    if (!entry) {
      entry = { steps: [], runByStepId: new Map() };
      byRun.set(row.run.id, entry);
    }
    entry.runByStepId.set(row.stepRun.stepId, row.stepRun);
    for (const step of parsed.steps) {
      if (!entry.steps.some((existing) => existing.id === step.id)) entry.steps.push(step);
    }
  }

  for (const [runId, entry] of byRun) {
    // [finding 2] definition step 마다 stepRun coverage 가 있어야 권위 판정 가능. missing → fail-closed.
    for (const step of entry.steps) {
      if (!entry.runByStepId.has(step.id)) return continuation(`uncertain:missing-step-run:run:${runId}:step:${step.id}`);
    }
    const preds = buildPredsByStepId(entry.steps, entry.runByStepId, options.validationVerdictsByIssueId);
    for (const step of entry.steps) {
      const run = entry.runByStepId.get(step.id)!;
      if (!KNOWN_STEP_RUN_STATUSES.has(run.status)) return continuation(`uncertain:unknown-step-status:run:${runId}:step:${step.id}:${run.status}`);
      // dangling predecessor reference → cannot classify authoritatively → fail-closed.
      for (const edge of resolveEdges(step)) {
        if (!entry.runByStepId.has(edge.stepId)) return continuation(`uncertain:dangling-predecessor:run:${runId}:step:${step.id}:pred:${edge.stepId}`);
      }
      if (run.status === "running") return continuation(`running-step:run:${runId}:step:${step.id}`);
      if (TERMINAL_STEP_RUN_STATUSES.has(run.status)) continue; // this step is itself terminal
      // [Workflow Retry] pending step carrying workflowRetry metadata:
      // - VALID (waiting future/due or dispatching) → live automatic continuation
      //   → suppress terminal Human Operator reporting.
      // - MALFORMED → the retry cannot launch; this is not live work. Do not
      //   treat it as continuation so terminal evaluation can proceed.
      const stepMeta = (run.metadata ?? null) as Record<string, unknown> | null;
      if (stepMeta && stepMeta.workflowRetry !== undefined && stepMeta.workflowRetry !== null) {
        if (isStepRunAwaitingRetry(stepMeta)) {
          return continuation(`workflow-retry:run:${runId}:step:${step.id}`);
        }
        continue; // malformed retry metadata → not live; eligible for terminal evaluation
      }
      // pending: evaluate authority(failure/always/IF/qa edges). runnable or waiting → continuation.
      const activation = classifyStepActivation(step, preds);
      if (activation.runnable) return continuation(`runnable-step:run:${runId}:step:${step.id}`);
      if (activation.waiting) return continuation(`waiting-step:run:${runId}:step:${step.id}`);
      // pending but skippable(unreachable) → not continuation from this step
    }
  }
  return { remains: false };
}

// 회귀 테스트/디버그용 edge 전개 노출(export). engine export 를 그대로 re-export 해 중복 구현을 피한다.
export { resolveEdges as resolveWorkflowEdges };

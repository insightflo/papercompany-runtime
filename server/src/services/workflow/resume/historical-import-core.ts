import { z } from "zod";
import { badRequest, unprocessable } from "../../../errors.js";
import { hashStructuredValue } from "../../issue-execution-cards/hash.js";
import { buildWorkflowExecutionSteps } from "../execution-steps.js";
import {
  buildExecutionDefinitionPayload,
  hashExecutionDefinitionPayload,
  reviewedHistoricalProvenanceSchema,
  validateExecutionDefinitionPayload,
  type ExecutionDefinitionPayload,
  type ReviewedHistoricalProvenance,
} from "../execution-definition-codec.js";
import type { WorkflowExecutionMode, WorkflowStep } from "../dag-engine.js";
import { forwardReachable } from "./graph.js";

/**
 * [파일 목적] Task5d reviewed historical import 의 순수(비 DB) 경계.
 *   운영자가 검토한 recovered steps + exact HistoricalProvenance 를 검증하고, frozen
 *   audited 정의 사실(name/mode/dynamic/source/sourceKind/updatedAt)과 대조한 뒤,
 *   기존 capture 와 동일한 normalize→roundtrip→validate→hash 파이프로 canonical
 *   snapshot payload 를 만든다. DB/시계/env 접근 없음.
 * [불변식]
 *   - frozen 사실과 provenance 가 한 필드라도 어긋나면 lineage 조작으로 보고 거부(422).
 *     자연어/파일 내용/현재 정의 행에서 lineage 를 만들어내지 않는다.
 *   - sourceStepsHash 는 정규화 전 원본 recovered steps 의 hashStructuredValue 와 대조한다.
 *   - 정규화는 run creation capture 와 동일 함수(buildWorkflowExecutionSteps)로 1회만.
 *   - back-edge/동적 마커/사이클/중복 id/미상 의존은 forwardReachable + 마커 검사로 거부.
 * [수정시 주의] 이 모듈은 임의 JSON 번들을 승격하는 범용 importer 가 아니다. audited 사실은
 *   상수로 고정이며, 스코프 UUID 는 호출자(운영자 스크립트)가 책임진다.
 */

/** Parent-reviewed audited 정의 사실(이 슬라이스가 임포트할 수 있는 유일한 historical 정의). */
export const REVIEWED_HISTORICAL_DEFINITION_FACTS = Object.freeze({
  workflowName: "shorts-pipeline",
  executionMode: "static_dag" as const,
  dynamicPlanBootstrapOnly: false,
  source: "native",
  sourceKind: "workflow",
  definitionUpdatedAt: "2026-09-05T16:29:42.067Z",
});

const uuidSchema = z.string().uuid();

export const reviewedHistoricalImportInputSchema = z
  .object({
    companyId: uuidSchema,
    missionId: uuidSchema,
    workflowId: uuidSchema,
    workflowRunId: uuidSchema,
    steps: z.array(z.unknown()),
    provenance: reviewedHistoricalProvenanceSchema,
    now: z.instanceof(Date).refine((value) => !Number.isNaN(value.getTime()), "now must be a valid Date"),
  })
  .strict();

export type ReviewedHistoricalImportInput = z.infer<typeof reviewedHistoricalImportInputSchema>;

/** 입력 증명이 하나라도 빠지거나 형식이 틀리면 400 — 신뢰 입력이라도 fail-closed. */
export function parseReviewedHistoricalImportInput(input: unknown): ReviewedHistoricalImportInput {
  const result = reviewedHistoricalImportInputSchema.safeParse(input);
  if (!result.success) {
    throw badRequest("historical_import_input_invalid", {
      issues: result.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
    });
  }
  return result.data;
}

/** provenance 가 frozen audited 사실/스코프와 정확히 일치하는지 — 아니면 lineage 조작(422). */
export function assertProvenanceLineage(
  input: ReviewedHistoricalImportInput,
): void {
  const facts = REVIEWED_HISTORICAL_DEFINITION_FACTS;
  const mismatches: string[] = [];
  if (input.provenance.workflowId !== input.workflowId) mismatches.push("workflowId_scope");
  if (input.provenance.missionId !== input.missionId) mismatches.push("missionId_scope");
  if (input.provenance.workflowName !== facts.workflowName) mismatches.push("workflowName");
  if (input.provenance.source !== facts.source) mismatches.push("source");
  if (input.provenance.sourceKind !== facts.sourceKind) mismatches.push("sourceKind");
  if (input.provenance.definitionUpdatedAt !== facts.definitionUpdatedAt) mismatches.push("definitionUpdatedAt");
  if (mismatches.length > 0) {
    throw unprocessable("historical_lineage_mismatch", { reasons: mismatches });
  }
}

/** 정규화 전에 원본 recovered steps 의 해시를 검증한다. */
export function assertSourceStepsHash(input: ReviewedHistoricalImportInput): string {
  const computed = hashStructuredValue(input.steps);
  if (computed !== input.provenance.review.sourceStepsHash) {
    throw unprocessable("source_steps_hash_mismatch", {
      expected: input.provenance.review.sourceStepsHash,
      computed,
    });
  }
  return computed;
}

function isTruthyMarker(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

function isDynamicOwnerPlanMarker(step: Record<string, unknown>): boolean {
  return isTruthyMarker(step.dynamicChildren)
    || isTruthyMarker(step.ownerPlanBootstrapOnly)
    || isTruthyMarker(step.bootstrapOnly)
    || step.executionMode === "dynamic_owner_plan"
    || step.workflowMode === "dynamic_owner_plan";
}

function normalizedStepRecords(steps: WorkflowStep[]): Record<string, unknown>[] {
  return steps.map((step, index) => {
    if (!step || typeof step !== "object") {
      throw unprocessable("historical_steps_rejected", { reason: "non_object_step", index });
    }
    return step as unknown as Record<string, unknown>;
  });
}

/** back-edge/dynamic 마커와 전역 사이클을 거부한다(정규화된 step 대상). */
export function assertStaticForwardDag(steps: WorkflowStep[]): void {
  const records = normalizedStepRecords(steps);
  for (const [index, step] of records.entries()) {
    const edges = Array.isArray(step.conditionalDependencies) ? step.conditionalDependencies : [];
    if (edges.some((edge) => isTruthyMarker((edge as Record<string, unknown>)?.isBackEdge))) {
      throw unprocessable("historical_steps_rejected", { reason: "back_edge", index });
    }
    if (isDynamicOwnerPlanMarker(step)) {
      throw unprocessable("historical_steps_rejected", { reason: "dynamic_marker", index });
    }
  }
  const nodes = steps.map((step) => ({
    id: step.id,
    dependencies: step.dependencies,
    conditionalDependencies: (step.conditionalDependencies ?? [])
      .map((edge) => ({ stepId: String(edge.stepId) })),
  }));
  try {
    forwardReachable(nodes, nodes[0].id);
  } catch {
    throw unprocessable("historical_steps_rejected", { reason: "unsupported_graph" });
  }
}

export interface HistoricalExecutionSnapshot {
  payload: ExecutionDefinitionPayload;
  definitionHash: string;
  stepCount: number;
  stepIds: string[];
}

/**
 * run creation capture 와 동일 파이프로 canonical snapshot payload 를 만든다.
 * 정규화는 frozen audited 사실(name/static_dag/dynamic=false)로만 수행하며, recovered
 * steps 이외의 어떤 소스(현재 정의 행 포함)도 쓰지 않는다.
 */
export function buildHistoricalExecutionSnapshot(
  input: ReviewedHistoricalImportInput,
): HistoricalExecutionSnapshot {
  assertProvenanceLineage(input);
  assertSourceStepsHash(input);
  const facts = REVIEWED_HISTORICAL_DEFINITION_FACTS;
  const normalized = buildWorkflowExecutionSteps({
    name: facts.workflowName,
    stepsJson: input.steps,
    executionMode: facts.executionMode,
    dynamicPlanBootstrapOnly: facts.dynamicPlanBootstrapOnly,
  });
  assertStaticForwardDag(normalized);
  // JSONB 직렬화와 동일하게 undefined 필드를 제거한 뒤 검증/해시한다(capture 와 같은 1회 roundtrip).
  const roundtripped = JSON.parse(JSON.stringify(normalized)) as unknown[];
  const executionMode: WorkflowExecutionMode = facts.executionMode;
  const payload = buildExecutionDefinitionPayload({
    companyId: input.companyId,
    workflowRunId: input.workflowRunId,
    executionMode,
    steps: roundtripped,
    provenance: input.provenance,
  });
  validateExecutionDefinitionPayload(payload);
  const stepIds = normalized.map((step) => step.id);
  return {
    payload,
    definitionHash: hashExecutionDefinitionPayload(payload),
    stepCount: stepIds.length,
    stepIds,
  };
}

export type { ReviewedHistoricalProvenance };

import { z } from "zod";
import { hashStructuredValue } from "../issue-execution-cards/hash.js";
import type { WorkflowExecutionMode } from "./dag-engine.js";

/**
 * [파일 목적] Task5a1 실행정보 스냅샷의 machine-produced core codec.
 *   canonical payload 를 조립(build)하고, 검증(validate)하며, 안정 해시를 계산한다.
 *   해시는 issue-execution-cards/hash.ts 의 hashStructuredValue(recursive key sort)를 재사용한다.
 * [계약] 검증은 원본 데이터를 그대로 반환한다(passthrough strip/reorder 금지). raw alias
 *   (dependsOn 문자열, 빈 agentId, unknown toolArgs/conditionGroup/contract 등)은 보존되며,
 *   shared workflowStepDefinitionSchema 의 preprocessing/strict alias 를 쓰지 않는다(보존 계약).
 * [외부 연결] dag-engine 은 타입만 import(type-only, runtime dag import 없음).
 * [provenance union] provenance 는 strict union 이다 — 기존 run_creation 스키마(필드/검증/
 *   해시 바이트 등가 유지) + reviewed_historical_import 스키마(명시적 운영자 검토 증명 전용).
 *   기존 creation payload 에 default/transform 은 없다. loader/importer 가 같은 validate/hash
 *   소스를 공유한다. historical provenance 는 review 블록(sourceStepsHash/sourceRecord/
 *   reviewedBy/reviewedAt)을 강제하며, 임의 키는 거부된다.
 */

export const EXECUTION_DEFINITION_SCHEMA_VERSION = 1;
export const EXECUTION_DEFINITION_NORMALIZER_VERSION = 1;

const CONDITIONAL_EDGE_WHEN_VALUES = [
  "success",
  "failure",
  "qa_request_changes",
  "always",
  "condition_true",
  "condition_false",
] as const;

const uuidSchema = z.string().uuid();

const executionDefinitionProvenanceBaseShape = {
  schemaVersion: z.literal(EXECUTION_DEFINITION_SCHEMA_VERSION),
  workflowId: uuidSchema,
  missionId: uuidSchema.nullable(),
  workflowName: z.string(),
  source: z.string().nullable(),
  sourceKind: z.string().nullable(),
  definitionUpdatedAt: z.string().datetime({ offset: true }),
} as const;

/** 기존 run_creation provenance — 필드/검증/해시 시맨틱 불변(바이트 등가). */
export const runCreationProvenanceSchema = z
  .object({
    ...executionDefinitionProvenanceBaseShape,
    origin: z.literal("run_creation"),
  })
  .strict();

export type RunCreationProvenance = z.infer<typeof runCreationProvenanceSchema>;

const lowercaseHex64Schema = z.string().regex(/^[0-9a-f]{64}$/, "must be lowercase 64-hex sha256");

/** 명시적 운영자 검토 증거가 붙은 historical provenance — 리뷰 블록 필수, 임의 키 거부. */
export const reviewedHistoricalProvenanceSchema = z
  .object({
    ...executionDefinitionProvenanceBaseShape,
    origin: z.literal("reviewed_historical_import"),
    review: z
      .object({
        schemaVersion: z.literal(1),
        sourceStepsHash: lowercaseHex64Schema,
        sourceRecord: z.string().min(1).max(1000),
        reviewedBy: z.string().min(1).max(200),
        reviewedAt: z.string().datetime({ offset: true }),
      })
      .strict(),
  })
  .strict();

export type ReviewedHistoricalProvenance = z.infer<typeof reviewedHistoricalProvenanceSchema>;

export const executionDefinitionProvenanceSchema = z.union([
  runCreationProvenanceSchema,
  reviewedHistoricalProvenanceSchema,
]);

export type ExecutionDefinitionProvenance = RunCreationProvenance | ReviewedHistoricalProvenance;

const executionDefinitionConditionalEdgeSchema = z
  .object({
    stepId: z.string().min(1),
    when: z.enum(CONDITIONAL_EDGE_WHEN_VALUES).optional(),
    isBackEdge: z.literal(true).optional(),
    maxIterations: z.number().int().positive().optional(),
    allowCapAcceptance: z.literal(true).optional(),
  })
  .strict()
  .superRefine((edge, ctx) => {
    if (edge.isBackEdge === true && typeof edge.maxIterations !== "number") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxIterations"],
        message: "back-edge requires maxIterations",
      });
    }
    if (edge.allowCapAcceptance === true && edge.isBackEdge !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowCapAcceptance"],
        message: "allowCapAcceptance is only allowed on a back-edge",
      });
    }
  });

const executionDefinitionStepCoreSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    agentId: z.string(),
    dependencies: z.array(z.string()),
    graphWorkProductRequired: z.boolean(),
    autoApproveTools: z.literal(true).optional(),
    conditionalDependencies: z.array(executionDefinitionConditionalEdgeSchema).optional(),
  })
  .passthrough();

const executionDefinitionPayloadSchema = z
  .object({
    schemaVersion: z.literal(EXECUTION_DEFINITION_SCHEMA_VERSION),
    normalizerVersion: z.literal(EXECUTION_DEFINITION_NORMALIZER_VERSION),
    companyId: uuidSchema,
    workflowRunId: uuidSchema,
    executionMode: z.enum(["static_dag", "dynamic_owner_plan"]),
    steps: z.array(executionDefinitionStepCoreSchema),
    provenance: executionDefinitionProvenanceSchema,
  })
  .strict();

export type ExecutionDefinitionPayload = {
  schemaVersion: typeof EXECUTION_DEFINITION_SCHEMA_VERSION;
  normalizerVersion: typeof EXECUTION_DEFINITION_NORMALIZER_VERSION;
  companyId: string;
  workflowRunId: string;
  executionMode: WorkflowExecutionMode;
  steps: unknown[];
  provenance: ExecutionDefinitionProvenance;
};

export class ExecutionDefinitionValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Execution definition validation failed: ${issues.join("; ")}`);
    this.name = "ExecutionDefinitionValidationError";
    this.issues = issues;
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`);
}

export function buildExecutionDefinitionPayload(input: {
  companyId: string;
  workflowRunId: string;
  executionMode: WorkflowExecutionMode;
  steps: unknown[];
  provenance: ExecutionDefinitionProvenance;
}): ExecutionDefinitionPayload {
  return {
    schemaVersion: EXECUTION_DEFINITION_SCHEMA_VERSION,
    normalizerVersion: EXECUTION_DEFINITION_NORMALIZER_VERSION,
    companyId: input.companyId,
    workflowRunId: input.workflowRunId,
    executionMode: input.executionMode,
    steps: input.steps,
    provenance: input.provenance,
  };
}

/** 검증 성공 시 원본 값을 그대로 반환한다(strip/reorder/mutate 없음). */
export function validateExecutionDefinitionPayload(value: unknown): ExecutionDefinitionPayload {
  const result = executionDefinitionPayloadSchema.safeParse(value);
  if (!result.success) throw new ExecutionDefinitionValidationError(formatIssues(result.error));
  return value as ExecutionDefinitionPayload;
}

export function validateExecutionDefinitionProvenance(value: unknown): ExecutionDefinitionProvenance {
  const result = executionDefinitionProvenanceSchema.safeParse(value);
  if (!result.success) throw new ExecutionDefinitionValidationError(formatIssues(result.error));
  return value as ExecutionDefinitionProvenance;
}

/** capturedAt 을 제외한 canonical payload 전체의 안정 해시(recursive key sort). */
export function hashExecutionDefinitionPayload(payload: ExecutionDefinitionPayload): string {
  return hashStructuredValue(payload);
}

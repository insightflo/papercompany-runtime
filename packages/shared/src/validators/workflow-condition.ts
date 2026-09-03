/**
 * [purpose] Strict typed n8n-like IF condition contract + Complete control-node result
 *   shape shared across the server engine, the UI editor, and persisted step-run metadata.
 *   This module is intentionally free of DB/filesystem concerns: it only declares Zod
 *   schemas, operator families, the restricted JSON-path grammar, and inferred types.
 * [links] Consumed by validators/workflow.ts (workflowStepDefinitionSchema refine rules),
 *   server condition-evaluator + source-resolver + executor, and the UI condition builder.
 * [care] Keep operator/data-type compatibility and unary rightValue rules here as the single
 *   source of truth — the UI imports WORKFLOW_CONDITION_OPERATORS instead of a second list.
 *   No implicit cross-type coercion. Prototype-poisoning path segments are rejected.
 */
import { z } from "zod";

/** Maximum number of conditions allowed in a single IF condition group. */
export const WORKFLOW_IF_MAX_CONDITIONS = 20;

/** IF condition source kinds. `tool_json` measures live machine truth via a server-executed workflow tool. */
export const WORKFLOW_IF_SOURCE_KINDS = ["work_product_json", "tool_json"] as const;

export type WorkflowConditionSourceKind = (typeof WORKFLOW_IF_SOURCE_KINDS)[number];

/**
 * Restricted JSON-path grammar for IF sources. Rooted at `$`, then a chain of
 * `.identifier` (object key) or `[index]` (non-negative integer) segments. No wildcards,
 * no recursive descent, no filters. Prototype-key segments are rejected separately.
 */
export const WORKFLOW_IF_JSON_PATH_PATTERN =
  /^\$(?:\.[A-Za-z_][A-Za-z0-9_]*|\[(?:0|[1-9][0-9]*)\])*$/u;

/** Operator families indexed by data type. The single source of truth for UI + engine. */
export const WORKFLOW_CONDITION_OPERATORS = {
  string: ["equals", "not_equals", "contains", "not_contains", "starts_with", "ends_with", "is_empty", "is_not_empty"],
  number: ["equals", "not_equals", "greater_than", "greater_than_or_equal", "less_than", "less_than_or_equal"],
  boolean: ["is_true", "is_false"],
  date_time: ["equals", "not_equals", "after", "after_or_equal", "before", "before_or_equal"],
  array: ["is_empty", "is_not_empty", "contains"],
  object: ["is_empty", "is_not_empty", "has_key"],
} as const;

const WORKFLOW_CONDITION_DATA_TYPES = [
  "string",
  "number",
  "boolean",
  "date_time",
  "array",
  "object",
] as const;

export type WorkflowConditionDataType = (typeof WORKFLOW_CONDITION_DATA_TYPES)[number];
export type WorkflowConditionCombinator = "all" | "any";

/** Operators that take no right operand. Supplying rightValue for them is invalid. */
const UNARY_OPERATORS: ReadonlySet<string> = new Set([
  "is_empty",
  "is_not_empty",
  "is_true",
  "is_false",
]);

/** Literal union of every supported operator name across all data types. */
export type WorkflowConditionOperator = {
  [K in keyof typeof WORKFLOW_CONDITION_OPERATORS]: (typeof WORKFLOW_CONDITION_OPERATORS)[K][number];
}[keyof typeof WORKFLOW_CONDITION_OPERATORS];

/** All operator names (union across data types) for the base operator enum. */
const ALL_OPERATORS: readonly WorkflowConditionOperator[] = Array.from(
  new Set(Object.values(WORKFLOW_CONDITION_OPERATORS).flat()),
);

const FORBIDDEN_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

/** True when a restricted JSON path references a prototype-poisoning key segment. */
function pathReferencesPrototypeKey(path: string): boolean {
  return path
    .split(/[.[\]]/)
    .some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment));
}

const workflowConditionSourceBase = {
  stepId: z.string().trim().min(1).max(120),
  path: z
    .string()
    .min(1)
    .max(1024)
    .regex(WORKFLOW_IF_JSON_PATH_PATTERN, "Workflow IF source path must match the restricted JSON-path grammar"),
};

/** Agent/runner-registered local work-product JSON, parsed from the server-local file. */
const workflowWorkProductJsonSourceSchema = z
  .object({
    kind: z.literal("work_product_json"),
    ...workflowConditionSourceBase,
    title: z.string().trim().min(1).max(255),
  })
  .strict();

/**
 * Live measurement through a registered workflow tool executed by the server itself
 * (server-held secrets; agent-authored JSON cannot fabricate the outcome). `parameters`
 * supports the same templating tokens as tool-step args (ancestor work-product refs,
 * run metadata, runDate).
 */
const workflowToolJsonSourceSchema = z
  .object({
    kind: z.literal("tool_json"),
    ...workflowConditionSourceBase,
    toolName: z.string().trim().min(1).max(120),
    parameters: z.record(z.unknown()).default({}),
  })
  .strict();

export const workflowConditionSourceSchema = z
  .discriminatedUnion("kind", [
    workflowWorkProductJsonSourceSchema,
    workflowToolJsonSourceSchema,
  ])
  .superRefine((source, ctx) => {
    if (pathReferencesPrototypeKey(source.path)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["path"],
        message: "Workflow IF source path must not reference prototype or constructor segments",
      });
    }
  });

export type WorkflowWorkProductJsonSource = z.infer<typeof workflowWorkProductJsonSourceSchema>;
export type WorkflowToolJsonSource = z.infer<typeof workflowToolJsonSourceSchema>;
export type WorkflowConditionSource = z.infer<typeof workflowConditionSourceSchema>;

/**
 * Schema-level guard shared by both source kinds: the JSON path must not reference
 * prototype/constructor segments (the evaluator re-checks at evaluation time).
 */
export function conditionSourcePathReferencesPrototypeKey(source: WorkflowConditionSource): boolean {
  return pathReferencesPrototypeKey(source.path);
}

const dateTimeStringSchema = z.string().datetime({ offset: true });

/** Validates the right operand shape for a binary operator against its declared data type. */
function validateRightValue(
  dataType: WorkflowConditionDataType,
  operator: string,
  value: unknown,
): string | null {
  switch (dataType) {
    case "string":
      return typeof value === "string" ? null : "string operator requires a string right value";
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : "number operator requires a finite numeric right value";
    case "date_time":
      return typeof value === "string" && dateTimeStringSchema.safeParse(value).success
        ? null
        : "date_time operator requires a valid ISO-8601 right value";
    case "array":
      // array contains checks membership; operand must be a finite JSON primitive (NaN/Infinity
      // are not valid JSON primitives and must not sneak in as a numeric right value).
      if (typeof value === "number") {
        return Number.isFinite(value) ? null : "array contains operator requires a finite numeric right value";
      }
      return typeof value === "string" || typeof value === "boolean"
        ? null
        : "array contains operator requires a primitive right value";
    case "object":
      return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 120
        ? null
        : "object has_key operator requires a non-empty string right value";
    default:
      return "unsupported data type for right value";
  }
}

export const workflowConditionSchema = z
  .object({
    source: workflowConditionSourceSchema,
    dataType: z.enum(WORKFLOW_CONDITION_DATA_TYPES),
    operator: z.enum(ALL_OPERATORS as [WorkflowConditionOperator, ...WorkflowConditionOperator[]]),
    rightValue: z.unknown().optional(),
  })
  .strict()
  .superRefine((condition, ctx) => {
    if (conditionSourcePathReferencesPrototypeKey(condition.source)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source", "path"],
        message: "Workflow IF source path must not reference prototype or constructor segments",
      });
    }
    const allowed = WORKFLOW_CONDITION_OPERATORS[condition.dataType];
    if (!(allowed as readonly string[]).includes(condition.operator)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operator"],
        message: `operator "${condition.operator}" is not valid for dataType "${condition.dataType}"`,
      });
      return;
    }
    const isUnary = UNARY_OPERATORS.has(condition.operator);
    const hasRight = condition.rightValue !== undefined;
    if (isUnary) {
      if (hasRight) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rightValue"],
          message: `operator "${condition.operator}" must not include a right value`,
        });
      }
      return;
    }
    if (!hasRight || condition.rightValue === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rightValue"],
        message: `operator "${condition.operator}" requires a right value`,
      });
      return;
    }
    const valueError = validateRightValue(condition.dataType, condition.operator, condition.rightValue);
    if (valueError) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rightValue"], message: valueError });
    }
  });

export type WorkflowCondition = z.infer<typeof workflowConditionSchema>;

export const workflowConditionGroupSchema = z
  .object({
    combinator: z.enum(["all", "any"]),
    conditions: z.array(workflowConditionSchema).min(1).max(WORKFLOW_IF_MAX_CONDITIONS),
  })
  .strict();

export type WorkflowConditionGroup = z.infer<typeof workflowConditionGroupSchema>;

/**
 * Persisted per-condition source summary in IF control-node results. Backward
 * compatible: legacy records carry `title` only (work_product_json); tool sources
 * carry `toolName`. Exactly one of the two must be present.
 */
const workflowConditionSourceSummarySchema = z
  .object({
    kind: z.enum(WORKFLOW_IF_SOURCE_KINDS).optional(),
    stepId: z.string().min(1),
    path: z.string().min(1),
    title: z.string().min(1).optional(),
    toolName: z.string().min(1).optional(),
  })
  .strict()
  .refine((summary) => Boolean(summary.title) !== Boolean(summary.toolName), {
    message: "exactly one of title or toolName is required",
  });

export const workflowIfControlResultSchema = z
  .object({
    nodeType: z.literal("if"),
    outcome: z.enum(["condition_true", "condition_false"]),
    evaluatedAt: z.string().datetime(),
    conditionCount: z.number().int().min(1).max(WORKFLOW_IF_MAX_CONDITIONS),
    combinator: z.enum(["all", "any"]),
    sourceSummary: z.array(workflowConditionSourceSummarySchema).min(1).max(WORKFLOW_IF_MAX_CONDITIONS),
  })
  .strict();

export type WorkflowIfControlResult = z.infer<typeof workflowIfControlResultSchema>;

export const workflowCompleteControlResultSchema = z
  .object({
    nodeType: z.literal("complete"),
    outcome: z.literal("completed"),
    completedAt: z.string().datetime(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type WorkflowCompleteControlResult = z.infer<typeof workflowCompleteControlResultSchema>;

/** Persisted at workflow_step_runs.metadata.controlNodeResult for both IF and Complete. */
export const workflowControlNodeResultSchema = z.discriminatedUnion("nodeType", [
  workflowIfControlResultSchema,
  workflowCompleteControlResultSchema,
]);

export type WorkflowControlNodeResult = z.infer<typeof workflowControlNodeResultSchema>;

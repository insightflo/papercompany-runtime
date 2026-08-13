import { z } from "zod";
import { humanReviewPacketSchema } from "./human-review.js";
import type {
  OperatorDecisionDefinition,
  OperatorDecisionResult,
} from "../types/operator-decision.js";

const stableIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const normalized = (min: number, max: number, pattern?: RegExp) =>
  z.string().transform((value) => value.normalize("NFC").trim()).pipe(
    pattern ? z.string().min(min).max(max).regex(pattern) : z.string().min(min).max(max),
  );
const nullableNormalized = (min: number, max: number) => normalized(min, max).nullable();
const boundedInteger = (min: number, max: number) => z.number().int().finite().min(min).max(max);
const strictEmptyObject = z.object({}).strict();

function hasProtocol(value: string, protocols: string[]) {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function unique(values: string[]) {
  return new Set(values).size === values.length;
}

const factSchema = z.object({
  label: normalized(1, 80),
  value: normalized(1, 200),
  status: z.enum(["known", "unknown"]),
}).strict();

const evidenceRefSchema = z.object({
  label: normalized(1, 120),
  href: normalized(1, 2_000).refine((value) => value.startsWith("/") || hasProtocol(value, ["http:", "https:"]), "Expected an application path or HTTP(S) URL"),
}).strict();

const optionSchema = z.object({
  id: normalized(1, 80, stableIdPattern),
  label: normalized(1, 160),
  description: nullableNormalized(1, 1_000),
  facts: z.array(factSchema).max(12),
  evidenceRefs: z.array(evidenceRefSchema).max(10),
}).strict();

const actionSchema = z.object({
  id: normalized(1, 80, stableIdPattern),
  label: normalized(1, 80),
  outcome: z.enum(["submit", "approve", "reject", "hold"]),
  tone: z.enum(["primary", "neutral", "danger"]),
  requiresSelection: z.boolean(),
}).strict();

const selectionSchema = z.object({
  min: boundedInteger(1, 50),
  max: boundedInteger(1, 50),
}).strict();

const commentSchema = z.object({
  mode: z.enum(["disabled", "optional", "required"]),
  label: nullableNormalized(1, 120),
  placeholder: nullableNormalized(1, 300),
  maxLength: boundedInteger(0, 2_000),
}).strict().superRefine((comment, ctx) => {
  if (comment.mode === "disabled") {
    if (comment.label !== null || comment.placeholder !== null || comment.maxLength !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Disabled comment must have null text and zero length" });
    }
    return;
  }
  if (comment.label === null || comment.maxLength < 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enabled comment requires a label and positive length" });
  }
});

const scopeSchema = z.array(normalized(1, 300)).max(20).superRefine((values, ctx) => {
  if (!unique(values)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Scope values must be unique" });
});

export const operatorDecisionDefinitionSchema = z.object({
  options: z.array(optionSchema).max(50),
  actions: z.array(actionSchema).min(1).max(8),
  selection: selectionSchema.nullable(),
  comment: commentSchema,
  approvedScope: scopeSchema,
  forbiddenScope: scopeSchema,
  humanReview: humanReviewPacketSchema.nullable().optional(),
}).strict().superRefine((definition, ctx) => {
  if (!unique(definition.options.map((item) => item.id))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Option IDs must be unique", path: ["options"] });
  }
  if (!unique(definition.actions.map((item) => item.id))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Action IDs must be unique", path: ["actions"] });
  }
  if (definition.options.length === 0) {
    if (definition.selection !== null || definition.actions.some((action) => action.requiresSelection)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Action definitions cannot require selection" });
    }
    return;
  }
  if (definition.selection === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Option definitions require selection bounds" });
    return;
  }
  if (definition.selection.min > definition.selection.max || definition.selection.max > definition.options.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid selection bounds", path: ["selection"] });
  }
});

export const operatorDecisionSourceContextSchema = z.object({
  missionId: nullableNormalized(1, 128),
  workflowId: nullableNormalized(1, 128),
  workflowRunId: nullableNormalized(1, 128),
  artifactRefs: z.array(z.object({
    label: normalized(1, 120),
    uri: normalized(1, 1_000).refine(
      (value) => value.startsWith("/") || hasProtocol(value, ["http:", "https:", "artifact:"]),
      "Expected an application path, HTTP(S), or artifact URI",
    ),
  }).strict()).max(20),
}).strict();

const createShape = z.object({
  schemaVersion: z.literal(1),
  requestKey: normalized(1, 160, stableIdPattern),
  priority: z.enum(["critical", "high", "medium", "low"]),
  interactionType: z.enum(["single_select", "multi_select", "action"]),
  title: normalized(1, 200),
  description: normalized(0, 4_000),
  sourceType: normalized(1, 80, stableIdPattern),
  sourceId: normalized(1, 200),
  sourceContext: operatorDecisionSourceContextSchema,
  definition: operatorDecisionDefinitionSchema,
  issueId: z.string().uuid().nullable(),
  continuationMode: z.enum(["none", "issue_current_assignee"]),
}).strict();

export const createOperatorDecisionSchema = createShape.superRefine((input, ctx) => {
  const { definition, interactionType } = input;
  if (interactionType === "single_select" && (
    definition.options.length < 1 || definition.selection?.min !== 1 || definition.selection.max !== 1
  )) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid single-select definition", path: ["definition"] });
  if (interactionType === "multi_select" && (definition.options.length < 1 || definition.selection === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid multi-select definition", path: ["definition"] });
  }
  if (interactionType === "action" && (definition.options.length !== 0 || definition.selection !== null ||
    definition.actions.some((action) => action.requiresSelection))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid action definition", path: ["definition"] });
  }
  if (input.continuationMode === "issue_current_assignee" && input.issueId === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Issue continuation requires issueId", path: ["issueId"] });
  }
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 65_536) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Create contract exceeds 65536 UTF-8 bytes" });
  }
});

export const operatorDecisionResolveInputSchema = z.object({
  actionId: normalized(1, 80, stableIdPattern),
  selectedOptionIds: z.array(normalized(1, 80, stableIdPattern)).max(50),
  comment: z.union([
    z.null(),
    z.string().transform((value) => value.normalize("NFC").replace(/^\s+|\s+$/g, "")).pipe(z.string().max(2_000)),
  ]),
}).strict();
export const cancelOperatorDecisionSchema = strictEmptyObject;
export const retryOperatorDecisionContinuationSchema = strictEmptyObject;

export const operatorDecisionListQuerySchema = z.object({
  view: z.enum(["pending", "attention", "history"]).default("pending"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();

function resolutionError(message: string, path: (string | number)[] = []) {
  throw new z.ZodError([{ code: z.ZodIssueCode.custom, message, path }]);
}

export function deriveOperatorDecisionResult(
  definitionInput: OperatorDecisionDefinition,
  inputValue: unknown,
): OperatorDecisionResult {
  const definition = operatorDecisionDefinitionSchema.parse(definitionInput);
  const input = operatorDecisionResolveInputSchema.parse(inputValue);
  const action = definition.actions.find((candidate) => candidate.id === input.actionId);
  if (!action) resolutionError("Unknown actionId", ["actionId"]);
  if (!unique(input.selectedOptionIds)) resolutionError("Selected option IDs must be unique", ["selectedOptionIds"]);
  const selected = new Set(input.selectedOptionIds);
  if (input.selectedOptionIds.some((id) => !definition.options.some((option) => option.id === id))) {
    resolutionError("Unknown selected option", ["selectedOptionIds"]);
  }
  if (action!.requiresSelection) {
    const bounds = definition.selection;
    if (!bounds || selected.size < bounds.min || selected.size > bounds.max) {
      resolutionError("Selection cardinality is invalid", ["selectedOptionIds"]);
    }
  } else if (selected.size !== 0) {
    resolutionError("This action does not accept selection", ["selectedOptionIds"]);
  }
  const trimmedComment = input.comment?.normalize("NFC").trim() || null;
  if (definition.comment.mode === "disabled" && trimmedComment !== null) resolutionError("Comment is disabled", ["comment"]);
  if (definition.comment.mode === "required" && trimmedComment === null) resolutionError("Comment is required", ["comment"]);
  if (trimmedComment !== null && trimmedComment.length > definition.comment.maxLength) {
    resolutionError("Comment exceeds maxLength", ["comment"]);
  }
  return {
    actionId: action!.id,
    outcome: action!.outcome,
    selectedOptionIds: definition.options.filter((option) => selected.has(option.id)).map((option) => option.id),
    comment: trimmedComment,
  };
}

export type CreateOperatorDecision = z.infer<typeof createOperatorDecisionSchema>;
export type ResolveOperatorDecisionInput = z.infer<typeof operatorDecisionResolveInputSchema>;
export type OperatorDecisionListQuery = z.infer<typeof operatorDecisionListQuerySchema>;

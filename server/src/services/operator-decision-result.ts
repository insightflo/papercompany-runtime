import { createHash } from "node:crypto";
import { createOperatorDecisionSchema, deriveOperatorDecisionResult } from "@paperclipai/shared/validators/operator-decision";
import type {
  CreateOperatorDecisionInput,
  OperatorDecisionDefinition,
  OperatorDecisionResult,
} from "@paperclipai/shared/types/operator-decision";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function validateAndHashOperatorDecisionCreate(input: unknown): {
  input: CreateOperatorDecisionInput;
  requestHash: string;
} {
  const validated = createOperatorDecisionSchema.parse(input) as CreateOperatorDecisionInput;
  const canonicalJson = JSON.stringify(canonicalize(validated));
  return {
    input: validated,
    requestHash: createHash("sha256").update(canonicalJson, "utf8").digest("hex"),
  };
}

export function validateOperatorDecisionResult(
  definition: OperatorDecisionDefinition,
  input: unknown,
): OperatorDecisionResult {
  return deriveOperatorDecisionResult(definition, input);
}

export function sameOperatorDecisionResult(
  left: OperatorDecisionResult | null,
  right: OperatorDecisionResult,
): boolean {
  if (!left) return false;
  return left.actionId === right.actionId &&
    left.outcome === right.outcome &&
    left.comment === right.comment &&
    left.selectedOptionIds.length === right.selectedOptionIds.length &&
    left.selectedOptionIds.every((id, index) => id === right.selectedOptionIds[index]);
}

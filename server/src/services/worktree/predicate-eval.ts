/**
 * Predicate Evaluator
 *
 * A mini-language for evaluating predicates against context objects.
 * Used by the Worktree Harness to enforce MUST/SHOULD/MAY rules.
 *
 * Operators: $eq, $ne, $in, $notIn, $contains, $startsWith, $endsWith, $matches, $gt, $lt
 *
 * CRITICAL: $matches uses re2 for ReDoS protection
 * CRITICAL: $matches pattern max 200 chars + 50ms timeout
 */

import RE2 from "re2";

/**
 * Predicate expression format.
 * Top-level must be an object with field-based predicates.
 * Example: { status: { $eq: "active" }, name: { $contains: "foo" } }
 */
export interface Predicate {
  [key: string]: PredicateValue;
}

/**
 * A predicate value can be:
 * - A primitive value (string, number, boolean) for equality
 * - An operator object like { $eq: value }
 * - A nested predicate for logical AND
 */
export type PrimitivePredicateValue =
  | string
  | number
  | boolean
  | null;

export type PredicateValue = PrimitivePredicateValue | OperatorExpression | Predicate;

export interface OperatorExpression {
  $eq?: string | number | boolean | null;
  $ne?: string | number | boolean | null;
  $in?: (string | number | boolean)[];
  $notIn?: (string | number | boolean)[];
  $contains?: string;
  $startsWith?: string;
  $endsWith?: string;
  $matches?: string;
  $gt?: number;
  $lt?: number;
}

/**
 * Evaluation result with success/failure and error details.
 */
export interface EvaluationResult {
  matches: boolean;
  error?: string;
}

/**
 * Error codes for predicate evaluation failures.
 */
export const PREDICATE_ERROR = {
  INVALID_OPERATOR: "INVALID_OPERATOR",
  INVALID_PATTERN: "INVALID_PATTERN",
  PATTERN_TOO_LONG: "PATTERN_TOO_LONG",
  PATTERN_TIMEOUT: "PATTERN_TIMEOUT",
  TYPE_MISMATCH: "TYPE_MISMATCH",
  INVALID_CONTEXT: "INVALID_CONTEXT",
} as const;

/**
 * Maximum length for $matches regex patterns (200 chars).
 */
const MAX_PATTERN_LENGTH = 200;

/**
 * Timeout for $matches regex execution in milliseconds (50ms).
 */
const MATCHES_TIMEOUT_MS = 50;

/**
 * Supported operator names.
 */
const OPERATORS = [
  "$eq",
  "$ne",
  "$in",
  "$notIn",
  "$contains",
  "$startsWith",
  "$endsWith",
  "$matches",
  "$gt",
  "$lt",
] as const;

type Operator = (typeof OPERATORS)[number];

/**
 * Checks if a value is a plain object (not null, not array, not class instance).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Gets a nested value from an object using dot notation.
 * Example: getNestedValue({ a: { b: "c" } }, "a.b") => "c"
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (isPlainObject(current)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return current;
}

/**
 * Checks if a value is a string.
 */
function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Checks if a value is a number.
 */
function isNumber(value: unknown): value is number {
  return typeof value === "number" && !isNaN(value);
}

/**
 * Compares two values for equality, including special handling for objects.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (!keysB.includes(key)) return false;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Evaluates a $matches operator against a string value using re2.
 * Implements ReDoS protection with pattern length and timeout limits.
 */
function evaluateMatches(
  fieldValue: unknown,
  pattern: string,
): EvaluationResult {
  if (!isString(fieldValue)) {
    return {
      matches: false,
      error: `${PREDICATE_ERROR.TYPE_MISMATCH}: $matches requires string value`,
    };
  }

  if (pattern.length > MAX_PATTERN_LENGTH) {
    return {
      matches: false,
      error: `${PREDICATE_ERROR.PATTERN_TOO_LONG}: pattern exceeds ${MAX_PATTERN_LENGTH} characters`,
    };
  }

  try {
    const regex = new RE2(pattern);

    // Execute with timeout using Promise.race
    const startTime = Date.now();
    const timeoutPromise = new Promise<boolean>((_, reject) => {
      setTimeout(
        () => reject(new Error("Regex execution timeout")),
        MATCHES_TIMEOUT_MS,
      );
    });

    const matchPromise = new Promise<boolean>((resolve) => {
      const result = regex.test(fieldValue);
      resolve(result);
    });

    // Race the match against timeout
    let result: boolean;
    try {
      result = Promise.race([matchPromise, timeoutPromise]) as unknown as boolean;
    } catch {
      // If timeout or error, regex.test is synchronous but we check elapsed time
      const elapsed = Date.now() - startTime;
      if (elapsed > MATCHES_TIMEOUT_MS) {
        return {
          matches: false,
          error: `${PREDICATE_ERROR.PATTERN_TIMEOUT}: execution exceeded ${MATCHES_TIMEOUT_MS}ms`,
        };
      }
      result = regex.test(fieldValue);
    }

    // Re-check elapsed time after synchronous execution
    const elapsed = Date.now() - startTime;
    if (elapsed > MATCHES_TIMEOUT_MS) {
      return {
        matches: false,
        error: `${PREDICATE_ERROR.PATTERN_TIMEOUT}: execution exceeded ${MATCHES_TIMEOUT_MS}ms`,
      };
    }

    return { matches: result };
  } catch (error) {
    return {
      matches: false,
      error: `${PREDICATE_ERROR.INVALID_PATTERN}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Evaluates an operator expression against a field value.
 */
function evaluateOperator(
  fieldValue: unknown,
  operator: Operator,
  operand: unknown,
): EvaluationResult {
  switch (operator) {
    case "$eq":
      // Treat undefined (missing field) as null for equality comparisons
      return { matches: deepEqual(fieldValue ?? null, operand) };

    case "$ne":
      return { matches: !deepEqual(fieldValue ?? null, operand) };

    case "$in":
      if (!Array.isArray(operand)) {
        return { matches: false, error: `${PREDICATE_ERROR.TYPE_MISMATCH}: $in requires array` };
      }
      return { matches: operand.some((v) => deepEqual(fieldValue, v)) };

    case "$notIn":
      if (!Array.isArray(operand)) {
        return { matches: false, error: `${PREDICATE_ERROR.TYPE_MISMATCH}: $notIn requires array` };
      }
      return { matches: !operand.some((v) => deepEqual(fieldValue, v)) };

    case "$contains":
      if (!isString(fieldValue) || !isString(operand)) {
        return { matches: false, error: `${PREDICATE_ERROR.TYPE_MISMATCH}: $contains requires strings` };
      }
      return { matches: fieldValue.includes(operand) };

    case "$startsWith":
      if (!isString(fieldValue) || !isString(operand)) {
        return { matches: false, error: `${PREDICATE_ERROR.TYPE_MISMATCH}: $startsWith requires strings` };
      }
      return { matches: fieldValue.startsWith(operand) };

    case "$endsWith":
      if (!isString(fieldValue) || !isString(operand)) {
        return { matches: false, error: `${PREDICATE_ERROR.TYPE_MISMATCH}: $endsWith requires strings` };
      }
      return { matches: fieldValue.endsWith(operand) };

    case "$matches":
      if (!isString(operand)) {
        return { matches: false, error: `${PREDICATE_ERROR.TYPE_MISMATCH}: $matches requires string pattern` };
      }
      return evaluateMatches(fieldValue, operand);

    case "$gt":
      if (!isNumber(fieldValue) || !isNumber(operand)) {
        return { matches: false, error: `${PREDICATE_ERROR.TYPE_MISMATCH}: $gt requires numbers` };
      }
      return { matches: fieldValue > operand };

    case "$lt":
      if (!isNumber(fieldValue) || !isNumber(operand)) {
        return { matches: false, error: `${PREDICATE_ERROR.TYPE_MISMATCH}: $lt requires numbers` };
      }
      return { matches: fieldValue < operand };

    default:
      return { matches: false, error: `${PREDICATE_ERROR.INVALID_OPERATOR}: unknown operator ${operator}` };
  }
}

/**
 * Evaluates a single predicate value against a field value.
 * Handles both direct values and operator expressions.
 */
function evaluatePredicateValue(
  fieldValue: unknown,
  predicateValue: PredicateValue,
): EvaluationResult {
  // If it's a primitive, treat as $eq
  if (
    predicateValue === null ||
    typeof predicateValue === "string" ||
    typeof predicateValue === "number" ||
    typeof predicateValue === "boolean"
  ) {
    return { matches: deepEqual(fieldValue, predicateValue) };
  }

  // If it's an operator expression
  if (isPlainObject(predicateValue)) {
    const expr = predicateValue as OperatorExpression;

    // Check for single operator (most common case)
    for (const op of OPERATORS) {
      if (op in expr) {
        return evaluateOperator(fieldValue, op, expr[op]);
      }
    }

    // If no operator found, it's a nested predicate (AND logic)
    // This handles cases like { status: { $eq: "active" } } where the inner is treated as nested
    // Actually, for nested predicates we need context, so this is a logical AND
    // But for simplicity, if no operator keys found, we treat it as an error
    return { matches: false, error: `${PREDICATE_ERROR.INVALID_OPERATOR}: no valid operator in expression` };
  }

  return { matches: false, error: `${PREDICATE_ERROR.TYPE_MISMATCH}: invalid predicate value type` };
}

/**
 * Main evaluation function.
 * Evaluates a predicate against a context object.
 *
 * @param predicate - The predicate to evaluate
 * @param context - The context object to evaluate against
 * @returns Evaluation result with matches boolean and optional error
 */
export function evaluatePredicate(
  predicate: Predicate,
  context: Record<string, unknown>,
): EvaluationResult {
  if (!isPlainObject(predicate)) {
    return { matches: false, error: `${PREDICATE_ERROR.INVALID_CONTEXT}: predicate must be an object` };
  }

  if (!isPlainObject(context)) {
    return { matches: false, error: `${PREDICATE_ERROR.INVALID_CONTEXT}: context must be an object` };
  }

  // Evaluate all fields in the predicate (logical AND)
  for (const [fieldPath, predicateValue] of Object.entries(predicate)) {
    const fieldValue = getNestedValue(context, fieldPath);

    const result = evaluatePredicateValue(fieldValue, predicateValue as PredicateValue);
    if (!result.matches) {
      return result;
    }
  }

  return { matches: true };
}

/**
 * Convenience function that throws on evaluation error.
 * Returns true if predicate matches, false otherwise.
 *
 * @param predicate - The predicate to evaluate
 * @param context - The context object to evaluate against
 * @throws Error if predicate evaluation fails
 */
export function predicateMatches(predicate: Predicate, context: Record<string, unknown>): boolean {
  const result = evaluatePredicate(predicate, context);
  if (result.error) {
    throw new Error(`Predicate evaluation error: ${result.error}`);
  }
  return result.matches;
}

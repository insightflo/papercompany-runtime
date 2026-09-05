/**
 * [purpose] Pure typed IF condition evaluator. No DB, no filesystem, no Date parsing
 *   of arbitrary input at import time. The engine source-resolver feeds the parsed
 *   JSON root for each condition source; this module reads the restricted JSON path,
 *   strictly type-checks the resolved value against the declared dataType, evaluates
 *   the typed operator, and combines results with AND/OR.
 * [safety] Fail-closed: a missing path, type mismatch, invalid date/time, NaN/infinity,
 *   or unsupported shape throws instead of returning false — missing data must never
 *   silently route a run to successful completion. Error messages name the step, title,
 *   and JSON path but never embed raw work-product content.
 * [combinator] All conditions are resolved and validated BEFORE the final AND/OR is
 *   computed, so a malformed later condition throws even when an earlier one already
 *   determines the boolean result.
 * [links] Consumed by control-node-executor.ts. Depends only on the shared contract.
 */
import {
  WORKFLOW_IF_JSON_PATH_PATTERN,
  type WorkflowCondition,
  type WorkflowConditionGroup,
  type WorkflowConditionSource,
} from "@paperclipai/shared";
import { WorkProductConditionWaitableError } from "./waitable-condition-error.js";

const ERROR_PREFIX = "Workflow IF condition failed:";
/**
 * Strict ISO-8601 calendar date/time grammar (the same shape z.string().datetime()
 * accepts). Used to reject parseable-but-non-ISO values such as "07/20/2026" that
 * Date.parse would otherwise accept, before epoch comparison.
 */
const STRICT_ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const FORBIDDEN_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

function pathReferencesPrototypeKey(path: string): boolean {
  return path.split(/[.[\]]/).some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`${ERROR_PREFIX} ${message}`);
}

function describeSource(source: WorkflowConditionSource): string {
  const ref = source.kind === "tool_json" ? `tool "${source.toolName}"` : `work product "${source.title}"`;
  return `path "${source.path}" (source step "${source.stepId}", ${ref})`;
}

/**
 * Reads a value from parsed JSON using the restricted grammar. Throws on invalid grammar,
 * prototype/constructor segments, or traversal through an unsupported shape. A key absent
 * from a plain object resolves to `undefined`; the caller (evaluateCondition) treats that
 * as a fail-closed type mismatch.
 */
export function readRestrictedJsonPath(root: unknown, path: string): unknown {
  if (typeof path !== "string" || !WORKFLOW_IF_JSON_PATH_PATTERN.test(path)) {
    fail(`invalid JSON path "${path}"`);
  }
  if (pathReferencesPrototypeKey(path)) {
    fail(`JSON path "${path}" references a prototype or constructor segment`);
  }
  if (path === "$") return root;

  const body = path.slice(1);
  let current: unknown = root;
  let i = 0;
  while (i < body.length) {
    const marker = body[i];
    if (marker === ".") {
      i += 1;
      let name = "";
      while (i < body.length && body[i] !== "." && body[i] !== "[") {
        name += body[i];
        i += 1;
      }
      if (!isPlainObject(current)) {
        fail(`cannot read property "${name}" from a non-object at ${path}`);
      }
      current = current[name];
    } else if (marker === "[") {
      const end = body.indexOf("]", i);
      if (end === -1) {
        fail(`malformed array index in JSON path "${path}"`);
      }
      const indexText = body.slice(i + 1, end);
      const index = Number(indexText);
      if (!Array.isArray(current)) {
        fail(`cannot index into a non-array at ${path}`);
      }
      current = current[index];
      i = end + 1;
    } else {
      fail(`malformed JSON path "${path}"`);
    }
  }
  return current;
}

function toEpochMillis(value: unknown, source: WorkflowConditionSource): number {
  if (typeof value !== "string" || !STRICT_ISO_8601_PATTERN.test(value)) {
    fail(`value at ${describeSource(source)} is not an ISO-8601 date/time string`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    fail(`value at ${describeSource(source)} is not a valid ISO-8601 date/time string`);
  }
  return ms;
}

function failTypeMismatch(condition: WorkflowCondition, message: string): never {
  // Type mismatches on work-product sources can be a closeout race (registered
  // placeholder / partially written artifact). They stay fail-closed errors but
  // carry a typed marker so the executor can apply the bounded grace wait.
  if (condition.source.kind === "work_product_json") {
    throw new WorkProductConditionWaitableError(
      `Workflow IF condition failed: ${message}`,
      {
      stepId: condition.source.stepId,
      title: condition.source.title,
    });
  }
  fail(message);
}

function assertLeftType(condition: WorkflowCondition, left: unknown): void {
  const { dataType, source } = condition;
  switch (dataType) {
    case "string":
      if (typeof left !== "string") failTypeMismatch(condition, `value at ${describeSource(source)} is not a string`);
      return;
    case "number":
      if (typeof left !== "number" || !Number.isFinite(left)) {
        failTypeMismatch(condition, `value at ${describeSource(source)} is not a finite number`);
      }
      return;
    case "boolean":
      if (typeof left !== "boolean") failTypeMismatch(condition, `value at ${describeSource(source)} is not a boolean`);
      return;
    case "date_time":
      toEpochMillis(left, source); // throws on non-datetime
      return;
    case "array":
      if (!Array.isArray(left)) fail(`value at ${describeSource(source)} is not an array`);
      return;
    case "object":
      if (!isPlainObject(left)) fail(`value at ${describeSource(source)} is not an object`);
      return;
    default:
      fail(`unsupported dataType "${dataType}"`);
  }
}

/** Evaluates a single already-validated condition against a resolved left value. */
function evaluateCondition(condition: WorkflowCondition, left: unknown): boolean {
  assertLeftType(condition, left);
  const { dataType, operator, source } = condition;

  if (dataType === "string") {
    const l = left as string;
    switch (operator) {
      case "equals": return l === condition.rightValue;
      case "not_equals": return l !== condition.rightValue;
      case "contains": return l.includes(condition.rightValue as string);
      case "not_contains": return !l.includes(condition.rightValue as string);
      case "starts_with": return l.startsWith(condition.rightValue as string);
      case "ends_with": return l.endsWith(condition.rightValue as string);
      case "is_empty": return l.length === 0;
      case "is_not_empty": return l.length > 0;
      default: fail(`unsupported string operator "${operator}" at ${describeSource(source)}`);
    }
  }
  if (dataType === "number") {
    const l = left as number;
    const r = condition.rightValue as number;
    switch (operator) {
      case "equals": return l === r;
      case "not_equals": return l !== r;
      case "greater_than": return l > r;
      case "greater_than_or_equal": return l >= r;
      case "less_than": return l < r;
      case "less_than_or_equal": return l <= r;
      default: fail(`unsupported number operator "${operator}" at ${describeSource(source)}`);
    }
  }
  if (dataType === "boolean") {
    if (operator === "is_true") return left === true;
    if (operator === "is_false") return left === false;
    fail(`unsupported boolean operator "${operator}" at ${describeSource(source)}`);
  }
  if (dataType === "date_time") {
    const l = toEpochMillis(left, source);
    const r = toEpochMillis(condition.rightValue, source);
    switch (operator) {
      case "equals": return l === r;
      case "not_equals": return l !== r;
      case "after": return l > r;
      case "after_or_equal": return l >= r;
      case "before": return l < r;
      case "before_or_equal": return l <= r;
      default: fail(`unsupported date_time operator "${operator}" at ${describeSource(source)}`);
    }
  }
  if (dataType === "array") {
    const l = left as unknown[];
    switch (operator) {
      case "is_empty": return l.length === 0;
      case "is_not_empty": return l.length > 0;
      case "contains": return l.includes(condition.rightValue);
      default: fail(`unsupported array operator "${operator}" at ${describeSource(source)}`);
    }
  }
  if (dataType === "object") {
    const l = left as Record<string, unknown>;
    switch (operator) {
      case "is_empty": return Object.keys(l).length === 0;
      case "is_not_empty": return Object.keys(l).length > 0;
      case "has_key": return Object.prototype.hasOwnProperty.call(l, condition.rightValue as string);
      default: fail(`unsupported object operator "${operator}" at ${describeSource(source)}`);
    }
  }
  fail(`unsupported dataType "${dataType}"`);
}

/**
 * Resolves every condition source, reads its path, strictly type-checks, evaluates the
 * operator, then combines with AND (all) or OR (any). Throws on any fail-closed error.
 */
export function evaluateWorkflowConditionGroup(input: {
  group: WorkflowConditionGroup;
  resolveSource: (source: WorkflowConditionSource) => unknown;
}): { outcome: boolean; results: boolean[] } {
  const results: boolean[] = [];
  for (const condition of input.group.conditions) {
    const root = input.resolveSource(condition.source);
    const left = readRestrictedJsonPath(root, condition.source.path);
    results.push(evaluateCondition(condition, left));
  }
  const outcome = input.group.combinator === "all"
    ? results.every(Boolean)
    : results.some(Boolean);
  return { outcome, results };
}

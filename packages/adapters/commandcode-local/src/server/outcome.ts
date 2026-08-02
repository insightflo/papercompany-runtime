import type { ParsedCommandCodeOutput } from "./parse.js";

const MAX_TURNS_CAP_EXIT_CODE = 8;

export type OutcomeKind =
  | "success"
  | "error"
  | "max_turns"
  | "missing_result"
  | "permission_denied";

export interface Outcome {
  kind: OutcomeKind;
  isFailure: boolean;
  errorCode: string | null;
}

/**
 * The always-last result line is the only execution-outcome authority.
 * - stopReason "permission_denied" fails even when the result subtype is
 *   "success" and the OS exit code is 0 (Command Code reports a success frame
 *   but never actually completed the requested work).
 * - subtype "error" fails even when the OS exit code is 0.
 * - subtype "max_turns" (or documented exit 8) is represented via errorCode.
 * - a process that exits 0 with NO result line is a fail-closed failure.
 */
export function classifyOutcome(
  parsed: ParsedCommandCodeOutput,
  exitCode: number | null,
): Outcome {
  const nonzeroExit = exitCode === null || exitCode !== 0;
  if (parsed.stopReason === "permission_denied") {
    return {
      kind: "permission_denied",
      isFailure: true,
      errorCode: "commandcode_permission_denied",
    };
  }
  if (parsed.subtype === "error") {
    return { kind: "error", isFailure: true, errorCode: null };
  }
  if (parsed.subtype === "max_turns" || exitCode === MAX_TURNS_CAP_EXIT_CODE) {
    return { kind: "max_turns", isFailure: false, errorCode: "commandcode_max_turns" };
  }
  if (parsed.subtype === "success") {
    // A success frame with a non-max-turns nonzero/null exit (auth, permission,
    // rate limit, ...) must NOT succeed.
    return { kind: "success", isFailure: nonzeroExit || parsed.errors.length > 0, errorCode: null };
  }
  // No result line: fail closed regardless of exit code.
  return { kind: "missing_result", isFailure: true, errorCode: "commandcode_missing_result" };
}

export interface ResolveErrorMessageParams {
  parsedError: string | null;
  stderrLine: string;
  rawExitCode: number | null;
}

/**
 * Synthesize the human-readable error message for an outcome. A logical failure
 * (error subtype, missing result, permission denial) with OS exit 0 must still
 * surface a clear message; see execute.ts for the matching exit-code synthesis.
 */
export function resolveErrorMessage(
  outcome: Outcome,
  params: ResolveErrorMessageParams,
): string | null {
  const { parsedError, stderrLine, rawExitCode } = params;
  switch (outcome.kind) {
    case "error":
      return parsedError || stderrLine || `Command Code run failed (exit ${rawExitCode ?? -1})`;
    case "max_turns":
      return "Command Code reached the --max-turns cap before completing; partial response returned.";
    case "missing_result":
      return `Command Code exited (code ${rawExitCode ?? -1}) without a final result line; treating the run as failed.`;
    case "permission_denied":
      return (
        parsedError ||
        "Command Code stopped because a required tool action was not permitted (permission denied)."
      );
    default:
      return outcome.isFailure
        ? (parsedError ||
            stderrLine ||
            `Command Code reported success but the process exited abnormally (code ${rawExitCode ?? -1}).`)
        : null;
  }
}

import type { Db } from "@paperclipai/db";
import {
  setWorkflowToolStepExecutor,
  setWorkflowToolStepReadinessChecker,
} from "../../services/workflow/dag-engine.js";
import { checkCoreWorkflowToolsAvailable } from "../../services/workflow/core-tool-executor.js";

/**
 * Parent-process workflow admission wiring for the real-process shutdown tests.
 *
 * Why this exists: the runtime-shutdown process matrix seeds workflow definitions
 * and triggers runs from the vitest parent process (`workflowService.createDefinition`
 * and `.trigger`) before any server child starts. Admission shares one implementation
 * with the server (admission-tool-readiness.ts) and asserts that a workflow tool step
 * executor is configured in the current process. The real server installs that
 * executor in app.ts; a bare parent process has none, so definition creation fails
 * with "Workflow tool step executor is not configured"
 * (/tmp/readiness-process-matrix-first-1850.log).
 *
 * Honest wiring using production code only:
 * - Readiness checker: the real `checkCoreWorkflowToolsAvailable` against the same
 *   embedded database. The parent loads no plugin workers, so every tool referenced
 *   by these scenarios is a core `tool_definitions` row — the same check app.ts
 *   applies to non-plugin tool names.
 * - Executor: a test isolation guard — explicitly NOT a real parent executor. It
 *   exists only so admission's "executor configured" gate sees a configured hook;
 *   it never dispatches, accepts, defers, or fakes any success result. Dispatch
 *   authority belongs to the child server process: `processQueuedWorkflowToolStepRuns`
 *   is invoked only by the server-side native scheduler (its own process installs the
 *   real tracked executor via app.ts), and these tests prove the child server owns
 *   process execution through their recorder/server/backend-PID evidence gates. If
 *   any parent path ever claims a queued tool step, the guard throws instead of
 *   silently executing the tool in the parent.
 *
 * Restore semantics: dag-engine exposes setters but no getters, so prior hook values
 * cannot be read back; restore() resets both hooks to their pristine null value.
 * In this matrix no other parent-process hooks exist (app.ts installs hooks only
 * inside child server processes), so null is the faithful original state.
 *
 * Scope: installation is opt-in. Only the P6 runtime-shutdown process matrix passes
 * the fixture option that installs this wiring; the http-handler (H4) and
 * owned-postgres shutdown tests keep the shared fixture's default behavior unchanged
 * (they never perform parent-side tool-step admission), and vitest isolates module
 * state per test file.
 */
export function installRuntimeShutdownParentWorkflowAdmission(db: Db): { restore(): void } {
  setWorkflowToolStepReadinessChecker(async ({ companyId, toolNames }) =>
    checkCoreWorkflowToolsAvailable(db, { companyId, toolNames }));
  setWorkflowToolStepExecutor(async (request) => {
    throw new Error(
      "runtime-shutdown admission guard: workflow tool dispatch belongs to the child server process "
      + `(step ${request.stepId}, stepRun ${request.stepRunId}, request ${request.requestId}); `
      + "the parent test process must not dispatch",
    );
  });
  return {
    restore() {
      setWorkflowToolStepExecutor(null);
      setWorkflowToolStepReadinessChecker(null);
    },
  };
}

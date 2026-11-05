import { workflowStepRuns, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  runtimeExecutionIdentitySchema,
  runtimeExecutionLifecycle,
  type DeferredBeforeStart,
  type RuntimeExecutionIdentity,
  type RuntimeExecutionLifecycle,
  type RuntimeExecutionScope,
} from "../runtime-execution-lifecycle.js";

type CoreToolStartInput = {
  db: Db;
  requestId: string;
  workflowRunId?: string | null;
  stepRunId?: string | null;
  stepId?: string | null;
  httpRequestIdentity?: RuntimeExecutionIdentity;
  runtimeLifecycle?: RuntimeExecutionLifecycle;
};
type StartDispatch = { launch<T>(start: () => T): Promise<{ result: T }> };

/** Native attempt authority wins; HTTP identity is only a fallback for incomplete tuples. */
export async function resolveCoreToolRuntimeScope(input: CoreToolStartInput): Promise<RuntimeExecutionScope | null> {
  const workflowRunId = input.workflowRunId?.trim();
  const stepRunId = input.stepRunId?.trim();
  const stepId = input.stepId?.trim();
  const lifecycle = input.runtimeLifecycle ?? runtimeExecutionLifecycle;
  if (workflowRunId && stepRunId && stepId) {
    const [attempt] = await input.db.select({ executionGeneration: workflowStepRuns.executionGeneration })
      .from(workflowStepRuns).where(and(eq(workflowStepRuns.id, stepRunId),
        eq(workflowStepRuns.workflowRunId, workflowRunId), eq(workflowStepRuns.stepId, stepId),
        eq(workflowStepRuns.lastDispatchRequestId, input.requestId))).limit(1);
    if (!attempt) throw new Error("workflow_tool_attempt_stale");
    return lifecycle.createScope({ requestId: input.requestId, executionId: workflowRunId,
      attemptId: stepRunId, executionGeneration: attempt.executionGeneration });
  }
  const httpIdentity = runtimeExecutionIdentitySchema.safeParse(input.httpRequestIdentity);
  if (!httpIdentity.success || httpIdentity.data.requestId !== input.requestId) return null;
  return lifecycle.createScope(httpIdentity.data);
}

/** Retains the synchronous final check at the actual child initiation callback. */
export async function createCoreToolRuntimeStart(input: CoreToolStartInput, dispatch?: StartDispatch) {
  const scope = await resolveCoreToolRuntimeScope(input);
  return async <T>(start: () => T): Promise<Awaited<T> | { deferredBeforeStart: DeferredBeforeStart }> => {
    const initiate = () => scope?.start(start) ?? { kind: "started" as const, value: start(), externalStarted: true as const };
    const decision = dispatch ? (await dispatch.launch(initiate)).result : initiate();
    if (decision.kind === "deferred_before_start") return { deferredBeforeStart: decision.deferred };
    if (decision.kind === "additional_start_blocked") throw new Error("runtime_additional_start_blocked");
    return await decision.value;
  };
}

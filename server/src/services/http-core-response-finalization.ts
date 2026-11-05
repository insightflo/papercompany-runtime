import type { Request, Response } from "express";
import type { Db } from "@paperclipai/db";
import { condenseDuplicateToolErrorBody } from "./tool-result-hygiene.js";
import { completeToolExecutionReceipt, releaseToolExecutionReceipt } from "./plugin-tool-execution-receipt.js";
import { deferredBeforeStartSchema, type RuntimeExecutionIdentity } from "./runtime-execution-lifecycle.js";
import type { createHttpHandlerLifetime } from "./http-handler-lifetime.js";

type HttpHandlerLifetime = ReturnType<typeof createHttpHandlerLifetime>;

export function isPositiveHttpDeferral(value: unknown, expected?: RuntimeExecutionIdentity): boolean {
  const parsed = deferredBeforeStartSchema.safeParse(value);
  if (!parsed.success) return false;
  return !expected || (
    parsed.data.requestId === expected.requestId &&
    parsed.data.executionId === expected.executionId &&
    parsed.data.attemptId === expected.attemptId &&
    parsed.data.executionGeneration === expected.executionGeneration
  );
}

export async function finalizeHttpCoreResponse(input: {
  db: Db;
  req: Request;
  res: Response;
  lifetime?: HttpHandlerLifetime;
  receipt: { id: string; companyId: string; runId: string; tool: string };
  requestIdentity?: RuntimeExecutionIdentity;
  originalResult: unknown;
  response: { status: number; body: Record<string, unknown> };
  workflowAuditScope: { workflowRunId: string | null; stepId: string | null };
  disposition: "complete" | "release";
  condense?: boolean;
  errorPath?: "error" | "result.error";
}) {
  const response = {
    status: input.response.status,
    body: input.condense === false
      ? input.response.body
      : condenseDuplicateToolErrorBody({
          runId: input.receipt.runId,
          tool: input.receipt.tool,
          status: input.response.status,
          body: input.response.body,
          errorPath: input.errorPath,
        }).body,
  };
  const snapshot = {
    receipt: input.receipt,
    requestIdentity: input.requestIdentity ?? null,
    originalResult: input.originalResult,
    response,
    workflowAuditScope: input.workflowAuditScope,
  };

  try {
    if (input.disposition === "complete") {
      await completeToolExecutionReceipt(input.db, input.receipt.id, {
        status: response.status,
        body: response.body,
        workflowRunId: input.workflowAuditScope.workflowRunId,
        stepId: input.workflowAuditScope.stepId,
      });
    } else {
      await releaseToolExecutionReceipt(input.db, input.receipt.id);
    }
  } catch (error) {
    input.lifetime?.holdFinalization(input.req, { ...snapshot, disposition: input.disposition, error });
    throw error;
  }

  // The durable response is fixed before transport writes begin.
  input.res.status(response.status).json(response.body);
  return snapshot;
}

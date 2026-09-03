/**
 * [purpose] Execute a `tool_json` IF condition source: the server itself invokes a
 *   registered company workflow tool (HTTP adapter) and returns the tool's machine
 *   result body as the source root. Server-held secrets perform the call, so an
 *   agent-authored JSON work product can never fabricate the measured outcome —
 *   this is the anti-fabrication counterpart to `work_product_json` sources.
 * [safety] Fail-closed: unknown/disabled tool, non-HTTP adapter, templating failure,
 *   non-200 result, or a missing machine result body throws with the workflow IF
 *   condition error prefix so the control node fails instead of silently routing the
 *   run. Remote diagnostics are bounded and already secret-redacted by the adapter.
 * [links] Consumed by control-node-executor.ts (injected into condition-source-resolver).
 *   Depends on tool-step-args.ts (parameter templating with ancestor scoping) and
 *   http-tool-adapter.ts (data-only response contract).
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { toolDefinitions } from "@paperclipai/db";
import type { WorkflowToolJsonSource } from "@paperclipai/shared";
import { executeHttpWorkflowTool } from "../http-tool-adapter.js";
import { secretService } from "../../secrets.js";
import { resolveWorkflowToolStepArgs } from "../tool-step-args.js";
import { workflowConditionFailure, type ConditionResolverStep } from "./condition-source-resolver.js";

/** Condition source tool calls must answer promptly; gate evaluation is synchronous. */
const CONDITION_SOURCE_TOOL_TIMEOUT_MS = 30_000;

export type ConditionToolSourceDeps = {
  fetchImpl?: typeof fetch;
  resolveSecretValue?: (
    companyId: string,
    secretId: string,
    version: number | "latest",
  ) => Promise<string>;
};

export async function executeWorkflowConditionToolSource(input: {
  db: Db;
  companyId: string;
  runId: string;
  ifStepId: string;
  workflowSteps: ReadonlyArray<ConditionResolverStep>;
  source: WorkflowToolJsonSource;
  runDate?: string | null;
  runMetadata?: Record<string, unknown> | null;
  deps?: ConditionToolSourceDeps;
}): Promise<unknown> {
  try {
    const [tool] = await input.db
      .select({ adapterType: toolDefinitions.adapterType, adapterConfig: toolDefinitions.adapterConfig })
      .from(toolDefinitions)
      .where(and(
        eq(toolDefinitions.companyId, input.companyId),
        eq(toolDefinitions.name, input.source.toolName),
      ))
      .limit(1);
    if (!tool || tool.adapterType !== "http") {
      workflowConditionFailure(
        `condition source tool "${input.source.toolName}" was not found for this company (or does not use the http adapter)`,
      );
    }

    // Same parameter templating as tool steps: ancestor work-product refs are scoped
    // to the IF step's forward ancestors and fail closed when unresolvable.
    const parameters = await resolveWorkflowToolStepArgs({
      db: input.db,
      run: { id: input.runId, companyId: input.companyId, runDate: input.runDate ?? null, metadata: input.runMetadata ?? null },
      step: { id: input.ifStepId, toolArgs: input.source.parameters },
      workflowSteps: input.workflowSteps as ConditionResolverStep[],
    });

    const result = await executeHttpWorkflowTool(
      {
        companyId: input.companyId,
        toolName: input.source.toolName,
        parameters,
        requestId: `wf-if-src-${input.runId}-${input.ifStepId}-${randomUUID()}`,
        stepOutputDir: null,
        adapterConfig: {
          ...(tool && typeof tool.adapterConfig === "object" && tool.adapterConfig !== null
            ? tool.adapterConfig as Record<string, unknown>
            : {}),
          timeoutMs: CONDITION_SOURCE_TOOL_TIMEOUT_MS,
        },
      },
      {
        fetchImpl: input.deps?.fetchImpl,
        resolveSecretValue: input.deps?.resolveSecretValue ?? secretService(input.db).resolveSecretValue,
      },
    );
    if (result.status !== 200) {
      const detail = typeof result.body.error === "string" && result.body.error.trim()
        ? `: ${result.body.error.trim().slice(0, 300)}`
        : "";
      workflowConditionFailure(`condition source tool "${input.source.toolName}" call failed (status ${result.status})${detail}`);
    }
    const data = (result.body as { data?: unknown }).data;
    if (data === undefined || data === null || typeof data !== "object" || Array.isArray(data)) {
      workflowConditionFailure(`condition source tool "${input.source.toolName}" returned no machine result object`);
    }
    return data;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Workflow IF condition failed:")) throw err;
    workflowConditionFailure(
      `condition source tool "${input.source.toolName}" could not be executed: ${err instanceof Error ? err.message.slice(0, 200) : "unknown error"}`,
    );
  }
}

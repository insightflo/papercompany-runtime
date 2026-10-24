import { randomUUID } from "node:crypto";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import { executeCoreWorkflowTool } from "./core-tool-executor.js";

/** Assemble the authorized route's core call without changing its execution scope. */
export function executePluginCoreToolCall(input: {
  db: Db;
  actor: Request["actor"];
  runContext: ToolRunContext;
  workflowRunIssueId: string | null;
  tool: string;
  parameters: unknown;
  stepEnv: Record<string, string>;
}) {
  const { db, actor, runContext, workflowRunIssueId, tool, parameters, stepEnv } = input;
  return executeCoreWorkflowTool({
    db,
    companyId: runContext.companyId,
    agentId: runContext.agentId,
    issueId: workflowRunIssueId,
    heartbeatRunId: actor.type === "agent" ? String(runContext.runId) : undefined,
    toolName: tool,
    parameters: parameters ?? {},
    requestId: randomUUID(),
    workflowRunId: stepEnv.PAPERCLIP_WORKFLOW_RUN_ID ?? null,
    stepId: stepEnv.PAPERCLIP_WORKFLOW_STEP_ID ?? null,
    stepEnv,
    // Authentication supplies only this snapshot; body parameters and env never fill gaps.
    progressEvidenceContext: {
      actor: {
        type: actor.type,
        source: actor.source,
        companyId: actor.companyId,
        agentId: actor.agentId,
        runId: actor.runId,
      },
      targetRunId: String(runContext.runId),
    },
  });
}

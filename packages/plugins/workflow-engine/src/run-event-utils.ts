import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";

import { TERMINAL_STEP_STATUSES, toWorkflowStepRunRecord } from "./workflow-utils.js";
import { findStepRunByIssueId } from "./workflow-store.js";

export interface RunEventRefs {
  agentId: string;
  agentName: string;
  issueId: string;
  log: string;
  projectId: string;
  runId: string;
  stderr: string;
  stdout: string;
}

export type WorkflowStepIssueTerminalStatus = "done" | "blocked" | "cancelled";

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function getNestedString(payload: Record<string, unknown>, ...path: string[]): string {
  let current: unknown = payload;

  for (const token of path) {
    if (!current || typeof current !== "object") {
      return "";
    }

    current = (current as Record<string, unknown>)[token];
  }

  return asString(current);
}

function eventPayload(event: PluginEvent): Record<string, unknown> {
  return (event.payload && typeof event.payload === "object" ? event.payload : {}) as Record<string, unknown>;
}

export function extractRunEventRefs(event: PluginEvent): RunEventRefs {
  const payload = eventPayload(event);

  const agentId = asString(payload.agentId)
    || asString(payload.agent_id)
    || getNestedString(payload, "agent", "id");

  const issueId = asString(payload.issueId)
    || asString(payload.issue_id)
    || getNestedString(payload, "issue", "id")
    || getNestedString(payload, "context", "issueId");

  const runId = asString(payload.runId)
    || asString(payload.run_id)
    || (event.entityType === "run" ? asString(event.entityId) : "");

  const projectId = asString(payload.projectId)
    || asString(payload.project_id)
    || getNestedString(payload, "project", "id")
    || getNestedString(payload, "context", "projectId");

  const agentName = asString(payload.agentName)
    || asString(payload.agent_name)
    || getNestedString(payload, "agent", "name");

  const stdout = asString(payload.stdout) || asString(payload.stdoutExcerpt);
  const stderr = asString(payload.stderr) || asString(payload.stderrExcerpt);
  const log = asString(payload.log) || asString(payload.output);

  return {
    agentId,
    agentName,
    issueId,
    log,
    projectId,
    runId,
    stderr,
    stdout,
  };
}

export async function autoCompleteWorkflowStepIssue(
  ctx: PluginContext,
  event: PluginEvent,
): Promise<{ completed: boolean; issueId?: string; reason?: string; stepId?: string }> {
  const refs = extractRunEventRefs(event);
  if (!refs.issueId) {
    return { completed: false, reason: "missing issueId" };
  }

  const stepRunRecord = await findStepRunByIssueId(ctx, refs.issueId, event.companyId);
  if (!stepRunRecord) {
    return { completed: false, issueId: refs.issueId, reason: "not a workflow step issue" };
  }

  const stepRun = toWorkflowStepRunRecord(stepRunRecord);
  const issue = await ctx.issues.get(refs.issueId, event.companyId);
  if (!issue) {
    return { completed: false, issueId: refs.issueId, reason: "issue not found", stepId: stepRun.data.stepId };
  }

  const status = typeof issue.status === "string" ? issue.status : "";
  if (status !== "done" && status !== "in_review") {
    return {
      completed: false,
      issueId: refs.issueId,
      reason: `issue not terminal (${status || "unknown"})`,
      stepId: stepRun.data.stepId,
    };
  }

  return {
    completed: true,
    issueId: refs.issueId,
    stepId: stepRun.data.stepId,
  };
}

export async function syncWorkflowStepIssueStatus(
  ctx: PluginContext,
  event: PluginEvent,
  nextIssueStatus: WorkflowStepIssueTerminalStatus,
  options?: { comment?: string },
): Promise<{ completed: boolean; issueId?: string; reason?: string; stepId?: string }> {
  const refs = extractRunEventRefs(event);
  if (!refs.issueId) {
    return { completed: false, reason: "missing issueId" };
  }

  return await syncWorkflowStepIssueStatusByIssueId(ctx, refs.issueId, event.companyId, nextIssueStatus, options);
}

export async function syncWorkflowStepIssueStatusFromStepRun(
  ctx: PluginContext,
  stepRunRecord: { data: { issueId?: string; stepId: string } },
  companyId: string,
  nextIssueStatus: WorkflowStepIssueTerminalStatus,
  options?: { comment?: string },
): Promise<{ completed: boolean; issueId?: string; reason?: string; stepId?: string }> {
  const issueId = asString(stepRunRecord.data.issueId);
  if (!issueId) {
    return { completed: false, reason: "missing issueId", stepId: stepRunRecord.data.stepId };
  }

  return await syncWorkflowStepIssueStatusByIssueId(ctx, issueId, companyId, nextIssueStatus, options);
}

async function syncWorkflowStepIssueStatusByIssueId(
  ctx: PluginContext,
  issueId: string,
  companyId: string,
  nextIssueStatus: WorkflowStepIssueTerminalStatus,
  options?: { comment?: string },
): Promise<{ completed: boolean; issueId?: string; reason?: string; stepId?: string }> {
  const stepRunRecord = await findStepRunByIssueId(ctx, issueId, companyId);
  if (!stepRunRecord) {
    return { completed: false, issueId, reason: "not a workflow step issue" };
  }

  const stepRun = toWorkflowStepRunRecord(stepRunRecord);
  if (TERMINAL_STEP_STATUSES.has(stepRun.data.status)) {
    if (nextIssueStatus === "done") {
      const issue = await ctx.issues.get(issueId, companyId);
      if (!issue) {
        return { completed: false, issueId, reason: "issue not found" };
      }

      const status = typeof issue.status === "string" ? issue.status : "";
      if (status === "todo" || status === "in_progress" || status === "in_review") {
        await ctx.issues.update(issueId, { status: nextIssueStatus }, companyId);
        return {
          completed: true,
          issueId,
          stepId: stepRun.data.stepId,
        };
      }
    }

    return { completed: false, issueId, reason: `step already terminal (${stepRun.data.status})`, stepId: stepRun.data.stepId };
  }

  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue) {
    return { completed: false, issueId, reason: "issue not found" };
  }

  const status = typeof issue.status === "string" ? issue.status : "";
  if (nextIssueStatus === "done" && status === "done") {
    return {
      completed: true,
      issueId,
      reason: "issue already done",
      stepId: stepRun.data.stepId,
    };
  }

  if (status !== "todo" && status !== "in_progress" && status !== "in_review") {
    return { completed: false, issueId, reason: `issue status not eligible (${status || "unknown"})`, stepId: stepRun.data.stepId };
  }

  await ctx.issues.update(issueId, { status: nextIssueStatus }, companyId);

  if (nextIssueStatus !== "done") {
    const comment = options?.comment?.trim();
    if (comment) {
      await ctx.issues.createComment(issueId, comment, companyId);
    }
  }

  return {
    completed: true,
    issueId,
    stepId: stepRun.data.stepId,
  };
}

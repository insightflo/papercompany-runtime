import type { PluginContext, PluginEntityRecord } from "@paperclipai/plugin-sdk";

import {
  ENTITY_TYPES, RUN_STATUSES, STEP_STATUSES
} from "./constants.js";
import { normalizeStepDeps } from "./dag-engine.js";
import { ensureIssueLabels } from "./issue-labels.js";
import {
  formatDateKeyInTimezone,
  getWorkflowDefinition,
  getWorkflowRun,
  listActiveRuns,
  listStepRuns,
  listWorkflowDefinitions,
  listWorkflowRunsByWorkflowId,
  updateStepRun,
  updateWorkflowDefinition,
  updateWorkflowRun,
  type WorkflowDefinition,
  type WorkflowRun,
} from "./workflow-store.js";
import { checkDailyRunGuard } from "./run-guards.js";
import { validateRequiredStepArtifacts } from "./artifact-guards.js";
import {
  TERMINAL_STEP_STATUSES,
  findStepDefinition,
  getStepAgentName,
  toWorkflowDefinitionRecord,
  type WorkflowDefinitionRecord,
  toWorkflowRunRecord,
  toWorkflowStepRunRecord,
  type WorkflowRunRecord,
  type WorkflowStepRunRecord,
} from "./workflow-utils.js";
import type { WorkflowStep } from "./dag-engine.js";

const DEFAULT_STEP_TIMEOUT_MS = 300_000;
const TOOL_REGISTRY_ACTION_MAX_ATTEMPTS = 3;
const TOOL_REGISTRY_ACTION_RETRY_DELAYS_MS = [1000, 3000];
const RETRIABLE_TOOL_REGISTRY_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
type ToolDispatchFailureDisposition = "accepted_unknown" | "retryable_pending" | "fatal_pending";
type IssueUpdatePatch = Parameters<PluginContext["issues"]["update"]>[1];
type IssueCreateInput = Parameters<PluginContext["issues"]["create"]>[0];

function resolveTemplateVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\$(\w+)\}/g, (_, key) => vars[key] ?? `{$${key}}`);
}

function isStale(record: PluginEntityRecord, thresholdMs: number): boolean {
  const updatedAt = new Date(record.updatedAt).getTime();
  return Date.now() - updatedAt > thresholdMs;
}

function getPaperclipApiUrl(): string {
  return process.env.PAPERCLIP_API_URL || "http://localhost:3200";
}

async function getCompanyTimezone(companyId: string): Promise<string | null> {
  try {
    const apiUrl = getPaperclipApiUrl();
    const res = await fetch(`${apiUrl}/api/companies/${companyId}`);
    if (!res.ok) return null;
    const company = await res.json() as Record<string, unknown>;
    return typeof company.timezone === "string" ? company.timezone : null;
  } catch { return null; }
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseToolRegistryActionStatus(error: unknown): number | null {
  const match = /\((\d{3})\)/.exec(summarizeError(error));
  if (!match) {
    return null;
  }

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseToolRegistryActionCode(error: unknown): string | null {
  const match = /"code"\s*:\s*"([A-Z_]+)"/.exec(summarizeError(error));
  return match?.[1] ?? null;
}

function classifyToolRegistryActionError(error: unknown): ToolDispatchFailureDisposition {
  const status = parseToolRegistryActionStatus(error);
  const code = parseToolRegistryActionCode(error);
  const message = summarizeError(error).toLowerCase();

  if (
    code === "TIMEOUT"
    || message.includes('rpc call "performaction" timed out')
    || message.includes("socket hang up")
    || message.includes("econnreset")
    || message.includes("timed out")
    || message.includes("timeout")
    || message.includes("terminated")
    || message.includes("aborted")
  ) {
    return "accepted_unknown";
  }

  if (
    code === "WORKER_UNAVAILABLE"
    || status === 404
    || status === 501
    || message.includes("tool-registry plugin not found")
    || message.includes("plugin is not ready")
    || message.includes("worker unavailable")
    || message.includes("fetch failed")
    || message.includes("networkerror")
    || message.includes("econnrefused")
  ) {
    return "retryable_pending";
  }

  if (status !== null && RETRIABLE_TOOL_REGISTRY_STATUS_CODES.has(status)) {
    return "retryable_pending";
  }

  return "fatal_pending";
}

function isRetriableToolRegistryActionError(error: unknown): boolean {
  return classifyToolRegistryActionError(error) === "retryable_pending";
}

function shouldRetryToolRegistryActionAttempt(error: unknown, attempt: number): boolean {
  if (attempt >= TOOL_REGISTRY_ACTION_MAX_ATTEMPTS) {
    return false;
  }

  const status = parseToolRegistryActionStatus(error);
  if (status === 502 || status === 504) {
    const code = parseToolRegistryActionCode(error);
    if (code === "TIMEOUT") {
      return false;
    }
  }

  return isRetriableToolRegistryActionError(error);
}

function shouldForceFreshSessionForAgentStep(
  stepTitle: string,
  agentMetadata: Record<string, unknown> | null | undefined,
): boolean {
  if (agentMetadata?.issueCompletionAuthority === true) {
    return true;
  }

  return /검수|review/i.test(stepTitle);
}

async function invokeAgentByName(
  ctx: PluginContext,
  agentName: string,
  stepRun: WorkflowStepRunRecord,
  stepTitle: string,
  workflowName: string,
  companyId: string,
): Promise<void> {
  const agents = await ctx.agents.list({ companyId });
  const agent = agents.find(
    (candidate: Awaited<ReturnType<PluginContext["agents"]["list"]>>[number]) => candidate.name === agentName,
  );

  if (!agent) {
    ctx.logger.warn("Reconciler: agent not found", { agentName, companyId });
    return;
  }

  const apiUrl = getPaperclipApiUrl();
  const forceFreshSession = shouldForceFreshSessionForAgentStep(
    stepTitle,
    (agent.metadata as Record<string, unknown> | null | undefined) ?? null,
  );
  const wakeupRes = await fetch(`${apiUrl}/api/agents/${agent.id}/wakeup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "automation",
      triggerDetail: "system",
      reason: `reconciler:${workflowName}`,
      payload: {
        issueId: stepRun.data.issueId,
        taskKey: `wf:${stepRun.data.runId}:${agent.id}`,
      },
      forceFreshSession,
    }),
  });

  if (!wakeupRes.ok) {
    throw new Error(`agent wakeup failed (${wakeupRes.status})`);
  }
}

function matchesCronField(field: string, value: number): boolean {
  if (field === "*") return true;
  for (const part of field.split(",")) {
    const trimmed = part.trim();
    if (trimmed.includes("/")) {
      const [, stepStr] = trimmed.split("/");
      const step = Number(stepStr);
      if (Number.isFinite(step) && step > 0 && value % step === 0) return true;
    } else if (trimmed.includes("-")) {
      const [lowStr, highStr] = trimmed.split("-");
      const low = Number(lowStr);
      const high = Number(highStr);
      if (value >= low && value <= high) return true;
    } else {
      if (Number(trimmed) === value) return true;
    }
  }
  return false;
}

function cronMatchesExactly(cron: string, at: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return false;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  return (
    matchesCronField(minute, at.getMinutes()) &&
    matchesCronField(hour, at.getHours()) &&
    matchesCronField(dayOfMonth, at.getDate()) &&
    matchesCronField(month, at.getMonth() + 1) &&
    matchesCronField(dayOfWeek, at.getDay())
  );
}

export function findRecentScheduledSlot(cron: string, now: Date, lookbackMinutes = 15): Date | null {
  const normalized = new Date(now);
  normalized.setSeconds(0, 0);

  for (let delta = 0; delta <= lookbackMinutes; delta += 1) {
    const candidate = new Date(normalized.getTime() - delta * 60_000);
    if (cronMatchesExactly(cron, candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Check if a cron expression matches `now`, with a tolerance window for the
 * minute field so that a reconciler running every N minutes doesn't miss a
 * cron that specifies an exact minute (e.g. `0 7 * * *`).
 *
 * `toleranceMinutes` defaults to 4 (just under the 5-min reconciler interval).
 */
function cronMatchesNow(cron: string, now: Date, toleranceMinutes = 4): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return false;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // For the minute field, check if `now` is within [cronMinute, cronMinute + tolerance]
  let minuteMatch = false;
  if (minute === "*" || minute.includes("/") || minute.includes("-") || minute.includes(",")) {
    minuteMatch = matchesCronField(minute, now.getMinutes());
  } else {
    const cronMinute = Number(minute);
    if (Number.isFinite(cronMinute)) {
      const nowMinute = now.getMinutes();
      const diff = (nowMinute - cronMinute + 60) % 60;
      minuteMatch = diff >= 0 && diff <= toleranceMinutes;
    }
  }

  return (
    minuteMatch &&
    matchesCronField(hour, now.getHours()) &&
    matchesCronField(dayOfMonth, now.getDate()) &&
    matchesCronField(month, now.getMonth() + 1) &&
    matchesCronField(dayOfWeek, now.getDay())
  );
}

function parseMaxDailyRuns(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.trunc(value);
  if (normalized < 0) {
    return undefined;
  }

  return normalized;
}

function toDayKey(value: string, timezone?: string): string | null {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return formatDateKeyInTimezone(new Date(parsed), timezone);
}

function readDateTimePart(
  parts: Intl.DateTimeFormatPart[],
  type: "year" | "month" | "day" | "hour" | "minute" | "second",
): number | null {
  const part = parts.find((candidate) => candidate.type === type);
  if (!part) {
    return null;
  }

  const parsed = Number(part.value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

function getDateInTimezone(date: Date, timezone: string): Date | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const year = readDateTimePart(parts, "year");
    const month = readDateTimePart(parts, "month");
    const day = readDateTimePart(parts, "day");
    const hour = readDateTimePart(parts, "hour");
    const minute = readDateTimePart(parts, "minute");
    const second = readDateTimePart(parts, "second");

    if (
      year === null ||
      month === null ||
      day === null ||
      hour === null ||
      minute === null ||
      second === null
    ) {
      return null;
    }

    return new Date(year, month - 1, day, hour, minute, second);
  } catch {
    return null;
  }
}

async function callToolRegistryWorkflowAction(ctx: PluginContext, params: {
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
  companyId: string;
  workflowRunId: string;
  stepId: string;
  stepRunId: string;
  issueId?: string;
}): Promise<void> {
  const apiUrl = getPaperclipApiUrl();
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= TOOL_REGISTRY_ACTION_MAX_ATTEMPTS; attempt += 1) {
    try {
      const pluginsResponse = await fetch(`${apiUrl}/api/plugins`);
      if (!pluginsResponse.ok) {
        const body = await pluginsResponse.text().catch(() => "");
        throw new Error(`plugin list failed (${pluginsResponse.status}): ${body}`.trim());
      }

      const plugins = await pluginsResponse.json() as Array<Record<string, unknown>>;
      const toolRegistry = plugins.find((plugin) => plugin.pluginKey === "insightflo.tool-registry");
      const pluginId = typeof toolRegistry?.id === "string" ? toolRegistry.id : "";
      if (!pluginId) {
        throw new Error("tool-registry plugin not found");
      }

      const response = await fetch(`${apiUrl}/api/plugins/${pluginId}/bridge/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "tool-registry.execute-workflow-tool",
          params,
          companyId: params.companyId,
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`tool-registry workflow action failed (${response.status}): ${body}`.trim());
      }

      return;
    } catch (error) {
      lastError = error;
      const disposition = classifyToolRegistryActionError(error);
      const shouldRetry = shouldRetryToolRegistryActionAttempt(error, attempt);
      ctx.logger.warn("Reconciler: workflow tool dispatch attempt failed", {
        attempt,
        companyId: params.companyId,
        disposition,
        error: summarizeError(error),
        requestId: params.requestId,
        shouldRetry,
        stepId: params.stepId,
        stepRunId: params.stepRunId,
        toolName: params.toolName,
        workflowRunId: params.workflowRunId,
      });

      if (!shouldRetry) {
        throw error;
      }

      const delayMs = TOOL_REGISTRY_ACTION_RETRY_DELAYS_MS[attempt - 1]
        ?? TOOL_REGISTRY_ACTION_RETRY_DELAYS_MS[TOOL_REGISTRY_ACTION_RETRY_DELAYS_MS.length - 1]
        ?? 1000;
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(summarizeError(lastError));
}

function parseDeadlineTime(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    return null;
  }

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  return { hour, minute };
}

function hasExceededDeadline(now: Date, deadlineTime: string): boolean {
  const parsedDeadline = parseDeadlineTime(deadlineTime);
  if (!parsedDeadline) {
    return false;
  }

  const nowSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  const deadlineSeconds = parsedDeadline.hour * 3600 + parsedDeadline.minute * 60;
  return nowSeconds > deadlineSeconds;
}

function getStepTimeoutMs(stepDef: WorkflowStep): number {
  const raw = stepDef.timeoutSeconds;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw * 1000;
  }

  return DEFAULT_STEP_TIMEOUT_MS;
}

function areDependenciesSatisfied(
  workflowDefinition: WorkflowDefinitionRecord,
  stepId: string,
  stepRunsById: Map<string, WorkflowStepRunRecord>,
): boolean {
  const stepDef = findStepDefinition(workflowDefinition, stepId);
  if (!stepDef) {
    return false;
  }

  return normalizeStepDeps(stepDef).every((depId) => {
    const depRun = stepRunsById.get(depId);
    if (!depRun) {
      return false;
    }
    return depRun.data.status === STEP_STATUSES.done || depRun.data.status === STEP_STATUSES.skipped;
  });
}

function isWorkflowSuccessfullyComplete(
  workflowDefinition: WorkflowDefinitionRecord,
  stepRunsById: Map<string, WorkflowStepRunRecord>,
): boolean {
  const steps = Array.isArray(workflowDefinition.data.steps)
    ? (workflowDefinition.data.steps as WorkflowStep[])
    : [];

  const normalSteps = steps.filter((step) => step.triggerOn !== "escalation");
  if (normalSteps.length === 0) {
    return false;
  }

  return normalSteps.every((step) => {
    const stepRun = stepRunsById.get(step.id);
    if (!stepRun) {
      return false;
    }

    return stepRun.data.status === STEP_STATUSES.done || stepRun.data.status === STEP_STATUSES.skipped;
  });
}

async function completeWorkflowRunIfResolved(
  ctx: PluginContext,
  workflowRun: WorkflowRunRecord,
  workflowDefinition: WorkflowDefinitionRecord,
  companyId: string,
  stepRunsById: Map<string, WorkflowStepRunRecord>,
): Promise<boolean> {
  if ((workflowRun.data.status as string) !== RUN_STATUSES.running) {
    return false;
  }

  if (!isWorkflowSuccessfullyComplete(workflowDefinition, stepRunsById)) {
    return false;
  }

  const completedAt = workflowRun.data.completedAt ?? new Date().toISOString();
  await updateWorkflowRun(ctx, workflowRun.id, {
    completedAt,
    status: RUN_STATUSES.completed,
  });

  const parentIssueId = typeof workflowRun.data.parentIssueId === "string"
    ? workflowRun.data.parentIssueId.trim()
    : "";
  if (parentIssueId) {
    try {
      const parentIssue = await ctx.issues.get(parentIssueId, companyId);
      if (parentIssue && parentIssue.status !== "done" && parentIssue.status !== "cancelled") {
        await ctx.issues.update(parentIssueId, { status: "done" } as IssueUpdatePatch, companyId);
        await ctx.issues.createComment(
          parentIssueId,
          [
            "### Workflow run completed",
            "",
            `Workflow \`${workflowRun.data.workflowName}\` finished successfully.`,
            `Run: \`${workflowRun.data.runLabel ?? workflowRun.id}\``,
          ].join("\n"),
          companyId,
        );
      }
    } catch (error) {
      ctx.logger.warn("Reconciler: failed to mark workflow parent issue done during completion", {
        companyId,
        error: summarizeError(error),
        parentIssueId,
        runId: workflowRun.id,
      });
    }
  }

  ctx.logger.info("Reconciler: completed workflow run after terminal step sync", {
    companyId,
    runId: workflowRun.id,
    workflowId: workflowRun.data.workflowId,
    workflowName: workflowRun.data.workflowName,
  });
  return true;
}

async function resolveAgentIdByName(
  ctx: PluginContext,
  companyId: string,
  agentName: string,
): Promise<string | null> {
  const trimmed = agentName.trim();
  if (!trimmed) {
    return null;
  }

  const agents = await ctx.agents.list({ companyId });
  const agent = agents.find((candidate) => candidate.name === trimmed) ?? null;
  return agent?.id ?? null;
}

async function activateAgentStep(
  ctx: PluginContext,
  stepRun: WorkflowStepRunRecord,
  stepDef: WorkflowStep,
  workflowRun: WorkflowRunRecord,
  workflowDefinition: WorkflowDefinitionRecord,
  companyId: string,
): Promise<WorkflowStepRunRecord> {
  const agentName = getStepAgentName(stepRun, stepDef);
  if (!agentName) {
    ctx.logger.warn("Reconciler: stale step has no resolvable agent", {
      companyId,
      runId: workflowRun.id,
      stepId: stepRun.data.stepId,
      workflowId: workflowRun.data.workflowId,
    });
    return stepRun;
  }

  const templateVars: Record<string, string> = {
    date: workflowRun.data.runDate || "",
    runNumber: String(workflowRun.data.runNumber),
    runLabel: workflowRun.data.runLabel || "",
    workflowName: workflowRun.data.workflowName,
  };
  const issueTitle = `[${workflowRun.data.workflowName}] ${resolveTemplateVars(stepDef.title, templateVars)}`;
  const stepMetadata = stepDef as WorkflowStep & { description?: string };
  const stepDescription = typeof stepMetadata.description === "string" && stepMetadata.description.trim()
    ? stepMetadata.description.trim()
    : `Workflow step: ${stepDef.id}`;

  let issueId = typeof stepRun.data.issueId === "string" ? stepRun.data.issueId.trim() : "";
  const agentId = await resolveAgentIdByName(ctx, companyId, agentName);
  if (!issueId) {
    const issueInput: IssueCreateInput = {
      assigneeAgentId: agentId ?? undefined,
      companyId,
      description: stepDescription,
      parentId: workflowRun.data.parentIssueId || undefined,
      goalId: workflowDefinition.data.goalId || undefined,
      projectId: workflowDefinition.data.projectId || undefined,
      title: issueTitle,
    };
    const issue = await ctx.issues.create(issueInput);
    issueId = issue.id;
    await ensureIssueLabels(
      ctx,
      issue.id,
      companyId,
      workflowDefinition.data.labelIds as string[] | undefined,
    );
    try {
      await ctx.issues.update(issue.id, { status: "todo" } as IssueUpdatePatch, companyId);
    } catch {
      // best-effort only
    }
  } else {
    await ensureIssueLabels(
      ctx,
      issueId,
      companyId,
      workflowDefinition.data.labelIds as string[] | undefined,
    );
  }

  const startedAt = stepRun.data.startedAt ?? new Date().toISOString();
  let updatedStepRun = toWorkflowStepRunRecord(await updateStepRun(ctx, stepRun.id, {
    agentName,
    issueId,
    startedAt,
    status: STEP_STATUSES.todo,
  }));

  try {
    await invokeAgentByName(
      ctx,
      agentName,
      updatedStepRun,
      stepDef.title,
      workflowRun.data.workflowName,
      companyId,
    );
  } catch (error) {
    ctx.logger.warn("Reconciler: failed to invoke agent for workflow step", {
      agentName,
      companyId,
      error: summarizeError(error),
      issueId,
      runId: workflowRun.id,
      stepId: stepDef.id,
      workflowName: workflowRun.data.workflowName,
    });
    return updatedStepRun;
  }

  updatedStepRun = toWorkflowStepRunRecord(await updateStepRun(ctx, updatedStepRun.id, {
    startedAt: updatedStepRun.data.startedAt ?? startedAt,
    status: STEP_STATUSES.inProgress,
  }));

  ctx.logger.info("Reconciler: activated agent workflow step", {
    agentName,
    companyId,
    issueId,
    runId: workflowRun.id,
    stepId: updatedStepRun.data.stepId,
    workflowName: workflowRun.data.workflowName,
  });

  return updatedStepRun;
}

function isStepTimedOut(stepRun: PluginEntityRecord, thresholdMs: number): boolean {
  const runData = stepRun.data as {
    startedAt?: unknown;
    lastDispatchAcceptedAt?: unknown;
    lastDispatchAttemptAt?: unknown;
  };
  const candidateTimes = [
    typeof runData.startedAt === "string" ? Date.parse(runData.startedAt) : Number.NaN,
    typeof runData.lastDispatchAcceptedAt === "string" ? Date.parse(runData.lastDispatchAcceptedAt) : Number.NaN,
    typeof runData.lastDispatchAttemptAt === "string" ? Date.parse(runData.lastDispatchAttemptAt) : Number.NaN,
    Date.parse(stepRun.updatedAt),
  ].filter((value) => Number.isFinite(value));
  const referenceMs = candidateTimes.length > 0 ? Math.max(...candidateTimes) : Number.NaN;
  if (!Number.isFinite(referenceMs)) {
    return false;
  }

  return Date.now() - referenceMs > thresholdMs;
}

async function retryToolStep(
  ctx: PluginContext,
  stepRun: WorkflowStepRunRecord,
  stepDef: WorkflowStep,
  workflowRun: WorkflowRunRecord,
  workflowDefinition: WorkflowDefinitionRecord,
  companyId: string,
): Promise<WorkflowStepRunRecord> {
  const toolName = typeof stepDef.toolName === "string" ? stepDef.toolName.trim() : "";
  if (!toolName) {
    ctx.logger.warn("Reconciler: stale tool step missing toolName", {
      companyId,
      runId: workflowRun.id,
      stepId: stepRun.data.stepId,
      workflowId: workflowRun.data.workflowId,
    });
    return stepRun;
  }

  const templateVars: Record<string, string> = {
    date: workflowRun.data.runDate || "",
    runNumber: String(workflowRun.data.runNumber),
    runLabel: workflowRun.data.runLabel || "",
    workflowName: workflowRun.data.workflowName,
  };
  const issueTitle = `[${workflowRun.data.workflowName}] ${resolveTemplateVars(stepDef.title, templateVars)}`;
  const stepMetadata = stepDef as WorkflowStep & { description?: string };
  const stepDescription = typeof stepMetadata.description === "string" && stepMetadata.description.trim()
    ? stepMetadata.description.trim()
    : `Workflow step: ${stepDef.id}`;

  let issueId = typeof stepRun.data.issueId === "string" ? stepRun.data.issueId.trim() : "";
  if (!issueId) {
    const issueInput: IssueCreateInput = {
      companyId,
      description: stepDescription,
      parentId: workflowRun.data.parentIssueId || undefined,
      goalId: workflowDefinition.data.goalId || undefined,
      projectId: workflowDefinition.data.projectId || undefined,
      title: issueTitle,
    };
    const issue = await ctx.issues.create(issueInput);
    issueId = issue.id;
    await ensureIssueLabels(
      ctx,
      issue.id,
      companyId,
      workflowDefinition.data.labelIds as string[] | undefined,
    );
    try {
      await ctx.issues.update(issue.id, { status: "todo" } as IssueUpdatePatch, companyId);
    } catch {
      // best-effort only
    }
  } else {
    await ensureIssueLabels(
      ctx,
      issueId,
      companyId,
      workflowDefinition.data.labelIds as string[] | undefined,
    );
  }

  const startedAt = stepRun.data.startedAt ?? new Date().toISOString();
  const dispatchAttemptAt = new Date().toISOString();
  const updatedStepRun = toWorkflowStepRunRecord(await updateStepRun(ctx, stepRun.id, {
    issueId,
    startedAt,
    lastDispatchAttemptAt: dispatchAttemptAt,
    lastDispatchErrorAt: undefined,
    lastDispatchErrorSummary: undefined,
    status: STEP_STATUSES.inProgress,
  }));

  try {
    await ctx.issues.update(issueId, { status: "in_progress" } as IssueUpdatePatch, companyId);
  } catch (error) {
    ctx.logger.warn("Reconciler: failed to mark tool step issue in progress", {
      companyId,
      error: error instanceof Error ? error.message : String(error),
      issueId,
      runId: workflowRun.id,
      stepId: stepDef.id,
      workflowName: workflowRun.data.workflowName,
    });
  }

  try {
    await ctx.issues.createComment(
      issueId,
      [
        `### Tool started: ${toolName}`,
        `- Step: ${stepDef.id}`,
        `- Started at: ${startedAt}`,
        `- Workflow: ${workflowRun.data.workflowName}`,
      ].join("\n"),
      companyId,
    );
  } catch (error) {
    ctx.logger.warn("Reconciler: failed to create tool step start comment", {
      companyId,
      error: error instanceof Error ? error.message : String(error),
      issueId,
      runId: workflowRun.id,
      stepId: stepDef.id,
      workflowName: workflowRun.data.workflowName,
    });
  }

  const requestId = `${workflowRun.id}:${stepDef.id}:reconciler:${Date.now()}`;
  const dispatchPreparedStepRun = toWorkflowStepRunRecord(await updateStepRun(ctx, updatedStepRun.id, {
    lastDispatchAttemptAt: dispatchAttemptAt,
    lastDispatchRequestId: requestId,
    status: STEP_STATUSES.inProgress,
  }));
  try {
    await callToolRegistryWorkflowAction(ctx, {
      requestId,
      toolName,
      args: stepDef.toolArgs ?? {},
      companyId,
      workflowRunId: workflowRun.id,
      stepId: stepDef.id,
      stepRunId: dispatchPreparedStepRun.id,
      issueId,
    });
  } catch (error) {
    const disposition = classifyToolRegistryActionError(error);
    if (disposition === "accepted_unknown") {
      const observedAt = new Date().toISOString();
      const preservedStepRun = toWorkflowStepRunRecord(await updateStepRun(ctx, dispatchPreparedStepRun.id, {
        completedAt: undefined,
        startedAt: dispatchPreparedStepRun.data.startedAt ?? observedAt,
        lastDispatchAttemptAt: observedAt,
        lastDispatchErrorAt: observedAt,
        lastDispatchErrorSummary: summarizeError(error),
        lastDispatchRequestId: requestId,
        status: STEP_STATUSES.inProgress,
      }));

      try {
        await ctx.issues.update(issueId, { status: "in_progress" } as IssueUpdatePatch, companyId);
      } catch (issueError) {
        ctx.logger.warn("Reconciler: failed to preserve tool step issue after ambiguous dispatch", {
          companyId,
          error: summarizeError(issueError),
          issueId,
          runId: workflowRun.id,
          stepId: stepDef.id,
          workflowName: workflowRun.data.workflowName,
        });
      }

      try {
        await ctx.issues.createComment(
          issueId,
          [
            `### Tool dispatch uncertain: ${toolName}`,
            `- Step: ${stepDef.id}`,
            `- Observed at: ${observedAt}`,
            `- Error: ${summarizeError(error)}`,
            "- Reconciler kept this step in `in_progress` to avoid duplicate execution. It will wait for the tool result before retrying.",
          ].join("\n"),
          companyId,
        );
      } catch (commentError) {
        ctx.logger.warn("Reconciler: failed to post ambiguous tool dispatch comment", {
          companyId,
          error: summarizeError(commentError),
          issueId,
          runId: workflowRun.id,
          stepId: stepDef.id,
          workflowName: workflowRun.data.workflowName,
        });
      }

      ctx.logger.warn("Reconciler: tool dispatch became uncertain; step remains in progress", {
        companyId,
        disposition,
        error: summarizeError(error),
        issueId,
        runId: workflowRun.id,
        stepId: stepDef.id,
        stepRunId: dispatchPreparedStepRun.id,
        toolName,
        workflowName: workflowRun.data.workflowName,
      });

      return preservedStepRun;
    }

    const resetAt = new Date().toISOString();
    const resetStepRun = toWorkflowStepRunRecord(await updateStepRun(ctx, dispatchPreparedStepRun.id, {
      completedAt: undefined,
      startedAt: undefined,
      lastDispatchAcceptedAt: undefined,
      lastDispatchAttemptAt: resetAt,
      lastDispatchErrorAt: resetAt,
      lastDispatchErrorSummary: summarizeError(error),
      lastDispatchRequestId: requestId,
      status: STEP_STATUSES.todo,
    }));

    try {
      await ctx.issues.update(issueId, { status: "todo" } as IssueUpdatePatch, companyId);
    } catch (issueError) {
      ctx.logger.warn("Reconciler: failed to reset tool step issue after dispatch failure", {
        companyId,
        error: summarizeError(issueError),
        issueId,
        runId: workflowRun.id,
        stepId: stepDef.id,
        workflowName: workflowRun.data.workflowName,
      });
    }

    try {
      await ctx.issues.createComment(
        issueId,
        [
          `### Tool dispatch failed: ${toolName}`,
          `- Step: ${stepDef.id}`,
          `- Failed at: ${resetAt}`,
          `- Error: ${summarizeError(error)}`,
          "- Reconciler reset this step to `todo` so it can retry on the next pass.",
        ].join("\n"),
        companyId,
      );
    } catch (commentError) {
      ctx.logger.warn("Reconciler: failed to post tool dispatch failure comment", {
        companyId,
        error: summarizeError(commentError),
        issueId,
        runId: workflowRun.id,
        stepId: stepDef.id,
        workflowName: workflowRun.data.workflowName,
      });
    }

    ctx.logger.warn("Reconciler: tool dispatch failed; step reset to todo", {
      companyId,
      error: summarizeError(error),
      issueId,
      runId: workflowRun.id,
      stepId: stepDef.id,
      stepRunId: dispatchPreparedStepRun.id,
      toolName,
      workflowName: workflowRun.data.workflowName,
    });

    return resetStepRun;
  }

  const acceptedAt = new Date().toISOString();
  const acceptedStepRun = toWorkflowStepRunRecord(await updateStepRun(ctx, dispatchPreparedStepRun.id, {
    lastDispatchAcceptedAt: acceptedAt,
    lastDispatchAttemptAt: dispatchAttemptAt,
    lastDispatchErrorAt: undefined,
    lastDispatchErrorSummary: undefined,
    lastDispatchRequestId: requestId,
    status: STEP_STATUSES.inProgress,
  }));

  ctx.logger.info("Reconciler: triggered tool execution via Tool Registry action", {
    companyId,
    issueId,
    runId: workflowRun.id,
    stepId: stepDef.id,
    requestId,
    stepRunId: acceptedStepRun.id,
    toolName,
    workflowName: workflowRun.data.workflowName,
  });

  return acceptedStepRun;
}

async function countWorkflowRunsForDay(
  ctx: PluginContext,
  companyId: string,
  workflowId: string,
  dayKey: string,
  timezone?: string,
  onlyScheduled = true,
): Promise<number> {
  const runs = await listWorkflowRunsByWorkflowId(ctx, companyId, workflowId);
  let count = 0;

  for (const runRecord of runs) {
    const run = toWorkflowRunRecord(runRecord);
    if (toDayKey(run.data.startedAt, timezone) !== dayKey) continue;
    if (onlyScheduled && run.data.triggerSource && run.data.triggerSource !== "schedule") continue;
    count += 1;
  }

  return count;
}

type StartWorkflowFn = (
  ctx: PluginContext,
  workflowId: string,
  companyId: string,
  options?: { createParentIssue?: boolean; createParentIssuePolicy?: unknown; parentIssueId?: string },
) => Promise<unknown>;

let _startWorkflowFn: StartWorkflowFn | null = null;

export function setStartWorkflowFn(fn: StartWorkflowFn): void {
  _startWorkflowFn = fn;
}

export async function runScheduledWorkflows(ctx: PluginContext): Promise<void> {
  if (!_startWorkflowFn) return;

  const now = new Date();
  const definitions = await ctx.entities.list({
    entityType: ENTITY_TYPES.workflowDefinition,
  });

  const companyIds = new Set<string>();
  for (const def of definitions) {
    if (typeof def.scopeId === "string" && def.scopeId.trim()) {
      companyIds.add(def.scopeId.trim());
    }
  }

  for (const companyId of companyIds) {
    const defs = await listWorkflowDefinitions(ctx, companyId);
    let companyTz: string | null | undefined;

    for (const defRecord of defs) {
      const def = toWorkflowDefinitionRecord(defRecord);

      // Defensive: skip entities that leaked from a different company scope
      const defCompanyId = typeof def.data.companyId === "string" ? def.data.companyId.trim() : "";
      if (defCompanyId && defCompanyId !== companyId) continue;

      if (def.data.status !== "active") continue;

      const schedule = def.data.schedule;
      if (!schedule || typeof schedule !== "string" || !schedule.trim()) continue;

      const wfTimezone = typeof def.data.timezone === "string" ? def.data.timezone.trim() : "";
      if (companyTz === undefined && !wfTimezone) {
        companyTz = await getCompanyTimezone(companyId);
      }
      const timezone = wfTimezone || companyTz || "";
      const nowForSchedule = timezone ? getDateInTimezone(now, timezone) : null;
      const effectiveScheduleNow = nowForSchedule ?? now;
      if (timezone && !nowForSchedule) {
        ctx.logger.warn("Invalid workflow timezone. Falling back to system local time for cron matching.", {
          companyId,
          timezone,
          workflowId: def.id,
          workflowName: def.data.name,
        });
      }

      const matchedSlot = findRecentScheduledSlot(schedule, effectiveScheduleNow);
      if (!matchedSlot) continue;

      // Prevent duplicate runs for the same scheduled slot, including late catch-up.
      const lastRun = (def.data as WorkflowDefinition).lastScheduledRunAt;
      if (lastRun) {
        const lastRunTime = new Date(lastRun).getTime();
        if (Number.isFinite(lastRunTime) && lastRunTime >= matchedSlot.getTime()) {
          continue;
        }
      }

      const maxDailyRuns = parseMaxDailyRuns((def.data as WorkflowDefinition).maxDailyRuns);
      if (maxDailyRuns !== 0) {
        if (typeof maxDailyRuns === "number" && maxDailyRuns > 0) {
          const dayKey = formatDateKeyInTimezone(matchedSlot, timezone) ?? now.toISOString().slice(0, 10);
          const runCountToday = await countWorkflowRunsForDay(ctx, companyId, def.id, dayKey, timezone);
          if (runCountToday >= maxDailyRuns) {
            ctx.logger.info("Skipped scheduled workflow start because maxDailyRuns was reached", {
              companyId,
              dayKey,
              maxDailyRuns,
              runCountToday,
              workflowId: def.id,
              workflowName: def.data.name,
            });
            continue;
          }
        } else {
          const dailyGuard = await checkDailyRunGuard(ctx, companyId, def.id, matchedSlot, timezone || undefined);
          if (dailyGuard.blocked) {
            ctx.logger.info("Skipped scheduled workflow start because a same-day run already exists", {
              companyId,
              dayKey: dailyGuard.dayKey,
              existingRunId: dailyGuard.existingRunId,
              existingStatus: dailyGuard.existingStatus,
              workflowId: def.id,
              workflowName: def.data.name,
            });
            continue;
          }
        }
      }

      try {
        // Claim the exact scheduled slot before starting workflow work.
        // This prevents a second reconciler tick/process from starting the same
        // slot again while _startWorkflowFn is still creating issues/steps.
        await updateWorkflowDefinition(ctx, def.id, {
          lastScheduledRunAt: matchedSlot.toISOString(),
          lastScheduleError: undefined,
          lastScheduleErrorAt: undefined,
        });

        const runResult = await _startWorkflowFn(ctx, def.id, companyId, {
          createParentIssuePolicy: def.data.createParentIssuePolicy,
        }) as { runId?: string } | undefined;
        if (runResult?.runId) {
          try {
            await updateWorkflowRun(ctx, runResult.runId, { triggerSource: "schedule" } as Partial<WorkflowRun>);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.startsWith("Workflow run not found:")) throw error;
            ctx.logger.info("Skipped legacy plugin run update for native scheduled workflow run", {
              companyId,
              workflowId: def.id,
              workflowName: def.data.name,
              runId: runResult.runId,
            });
          }
        }
        ctx.logger.info("Scheduled workflow started", {
          companyId,
          workflowId: def.id,
          workflowName: def.data.name,
          scheduledSlot: matchedSlot.toISOString(),
          schedule,
          timezone: timezone || undefined,
        });
      } catch (error) {
        const scheduleError = error instanceof Error ? error.message : String(error);
        await updateWorkflowDefinition(ctx, def.id, {
          lastScheduleError: scheduleError,
          lastScheduleErrorAt: now.toISOString(),
        });
        ctx.logger.warn("Failed to start scheduled workflow", {
          companyId,
          workflowId: def.id,
          workflowName: def.data.name,
          error: scheduleError,
        });
      }
    }
  }
}

export async function reconcileStuckSteps(ctx: PluginContext): Promise<void> {
  let runsChecked = 0;
  let stepsRetriggered = 0;
  let stepsTimedOut = 0;

  try {
    const definitions = await ctx.entities.list({
      entityType: ENTITY_TYPES.workflowDefinition,
    });
    const companyIds = new Set<string>();

    for (const definition of definitions) {
      if (typeof definition.scopeId === "string" && definition.scopeId.trim()) {
        companyIds.add(definition.scopeId.trim());
      }
    }

    for (const companyId of companyIds) {
      let activeRuns: PluginEntityRecord[] = [];
      let companyTz: string | null | undefined;

      try {
        activeRuns = await listActiveRuns(ctx, companyId);
      } catch (error) {
        ctx.logger.warn("Reconciler: failed to list active runs", {
          companyId,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      for (const runRecord of activeRuns) {
        runsChecked += 1;

        try {
          const workflowRun = await getWorkflowRun(ctx, runRecord.id);
          if (!workflowRun) {
            ctx.logger.warn("Reconciler: workflow run not found", {
              companyId,
              runId: runRecord.id,
            });
            continue;
          }

          const typedWorkflowRun = toWorkflowRunRecord(workflowRun);
          if (typedWorkflowRun.data.status !== RUN_STATUSES.running) {
            continue;
          }

          const workflowDefinition = await getWorkflowDefinition(ctx, typedWorkflowRun.data.workflowId);
          if (!workflowDefinition) {
            ctx.logger.warn("Reconciler: workflow definition not found", {
              companyId,
              runId: typedWorkflowRun.id,
              workflowId: typedWorkflowRun.data.workflowId,
            });
            continue;
          }

          const typedWorkflowDefinition = toWorkflowDefinitionRecord(workflowDefinition);
          const stepRuns = (await listStepRuns(ctx, typedWorkflowRun.id, companyId)).map(
            toWorkflowStepRunRecord,
          );
          const stepRunsById = new Map(stepRuns.map((stepRun) => [stepRun.data.stepId, stepRun]));
          const now = new Date();
          const nowIso = now.toISOString();
          const wfTimezone = typeof typedWorkflowDefinition.data.timezone === "string"
            ? typedWorkflowDefinition.data.timezone.trim()
            : "";
          if (companyTz === undefined && !wfTimezone) {
            companyTz = await getCompanyTimezone(companyId);
          }
          const timezone = wfTimezone || companyTz || "";
          const nowForDeadline = timezone ? getDateInTimezone(now, timezone) : null;
          const effectiveNowForDeadline = nowForDeadline ?? now;
          if (timezone && !nowForDeadline) {
            ctx.logger.warn("Invalid workflow timezone. Falling back to system local time for deadline checks.", {
              companyId,
              runId: typedWorkflowRun.id,
              timezone,
              workflowId: typedWorkflowRun.data.workflowId,
              workflowName: typedWorkflowRun.data.workflowName,
            });
          }

          const deadlineTime = typeof typedWorkflowDefinition.data.deadlineTime === "string"
            ? typedWorkflowDefinition.data.deadlineTime.trim()
            : "";
          if (deadlineTime) {
            if (parseDeadlineTime(deadlineTime) === null) {
              ctx.logger.warn("Invalid workflow deadlineTime. Expected HH:MM format.", {
                companyId,
                deadlineTime,
                runId: typedWorkflowRun.id,
                workflowId: typedWorkflowRun.data.workflowId,
                workflowName: typedWorkflowRun.data.workflowName,
              });
            } else if (hasExceededDeadline(effectiveNowForDeadline, deadlineTime)) {
              for (const stepRun of stepRuns) {
                if (TERMINAL_STEP_STATUSES.has(stepRun.data.status)) {
                  continue;
                }

                await updateStepRun(ctx, stepRun.id, {
                  completedAt: stepRun.data.completedAt ?? nowIso,
                  status: STEP_STATUSES.failed,
                });
              }

              await updateWorkflowRun(ctx, typedWorkflowRun.id, {
                completedAt: typedWorkflowRun.data.completedAt ?? nowIso,
                status: RUN_STATUSES.timedOut,
              });

              ctx.logger.warn("Reconciler: workflow timed out due to deadlineTime", {
                companyId,
                deadlineTime,
                runId: typedWorkflowRun.id,
                timezone: timezone || undefined,
                workflowId: typedWorkflowRun.data.workflowId,
                workflowName: typedWorkflowRun.data.workflowName,
              });
              continue;
            }
          }

          if (typeof typedWorkflowDefinition.data.timeoutMinutes === "number") {
            const startedAtMs = new Date(typedWorkflowRun.data.startedAt).getTime();
            const elapsedMs = Date.now() - startedAtMs;
            const timeoutMs = typedWorkflowDefinition.data.timeoutMinutes * 60_000;

            if (Number.isFinite(startedAtMs) && elapsedMs > timeoutMs) {
              for (const stepRun of stepRuns) {
                if (TERMINAL_STEP_STATUSES.has(stepRun.data.status)) {
                  continue;
                }

                await updateStepRun(ctx, stepRun.id, {
                  completedAt: stepRun.data.completedAt ?? nowIso,
                  status: STEP_STATUSES.failed,
                });
              }

              await updateWorkflowRun(ctx, typedWorkflowRun.id, {
                completedAt: typedWorkflowRun.data.completedAt ?? nowIso,
                status: RUN_STATUSES.timedOut,
              });

              ctx.logger.warn("Reconciler: workflow timed out", {
                companyId,
                runId: typedWorkflowRun.id,
                timeoutMinutes: typedWorkflowDefinition.data.timeoutMinutes,
                workflowId: typedWorkflowRun.data.workflowId,
                workflowName: typedWorkflowRun.data.workflowName,
              });
              continue;
            }
          }

          let workflowFailedByStepTimeout = false;
          const staleTodoSteps = stepRuns.filter((stepRun) => stepRun.data.status === STEP_STATUSES.todo);
          for (const stepRun of staleTodoSteps) {
            const stepDef = findStepDefinition(typedWorkflowDefinition, stepRun.data.stepId);
            if (!stepDef) {
              ctx.logger.warn("Reconciler: step definition not found for stale step", {
                companyId,
                runId: typedWorkflowRun.id,
                stepId: stepRun.data.stepId,
                workflowId: typedWorkflowRun.data.workflowId,
              });
              continue;
            }

            const timeoutMs = getStepTimeoutMs(stepDef);
            if (!isStepTimedOut(stepRun, timeoutMs)) {
              continue;
            }

            const hasStepTimeout =
              typeof stepDef.timeoutSeconds === "number" &&
              Number.isFinite(stepDef.timeoutSeconds) &&
              stepDef.timeoutSeconds > 0;
            if (hasStepTimeout) {
              await updateStepRun(ctx, stepRun.id, {
                completedAt: stepRun.data.completedAt ?? nowIso,
                status: STEP_STATUSES.failed,
              });
              await updateWorkflowRun(ctx, typedWorkflowRun.id, {
                completedAt: typedWorkflowRun.data.completedAt ?? nowIso,
                status: RUN_STATUSES.failed,
              });
              stepsTimedOut += 1;
              workflowFailedByStepTimeout = true;
              ctx.logger.warn("Reconciler: workflow step timed out", {
                companyId,
                runId: typedWorkflowRun.id,
                stepId: stepRun.data.stepId,
                timeoutSeconds: stepDef.timeoutSeconds,
                workflowId: typedWorkflowRun.data.workflowId,
                workflowName: typedWorkflowRun.data.workflowName,
              });
              break;
            }

            if ((stepDef.type ?? "agent") === "tool") {
              const retriggeredToolStep = await retryToolStep(
                ctx,
                stepRun,
                stepDef,
                typedWorkflowRun,
                typedWorkflowDefinition,
                companyId,
              );
              stepRunsById.set(retriggeredToolStep.data.stepId, retriggeredToolStep);
              if (retriggeredToolStep.data.status === STEP_STATUSES.inProgress) {
                stepsRetriggered += 1;
                ctx.logger.info("Reconciler: re-triggered stuck tool step", {
                  companyId,
                  runId: typedWorkflowRun.id,
                  stepId: stepRun.data.stepId,
                  toolName: stepDef.toolName,
                  workflowName: typedWorkflowRun.data.workflowName,
                });
              } else {
                ctx.logger.warn("Reconciler: tool step dispatch failed; left step pending", {
                  companyId,
                  runId: typedWorkflowRun.id,
                  stepId: stepRun.data.stepId,
                  toolName: stepDef.toolName,
                  workflowName: typedWorkflowRun.data.workflowName,
                });
              }
              continue;
            }

            const activatedAgentStep = await activateAgentStep(
              ctx,
              stepRun,
              stepDef,
              typedWorkflowRun,
              typedWorkflowDefinition,
              companyId,
            );
            stepRunsById.set(activatedAgentStep.data.stepId, activatedAgentStep);

            stepsRetriggered += 1;
            ctx.logger.info("Reconciler: re-triggered stuck step", {
              agentName: activatedAgentStep.data.agentName,
              companyId,
              runId: typedWorkflowRun.id,
              stepId: stepRun.data.stepId,
              workflowName: typedWorkflowRun.data.workflowName,
            });
          }

          if (workflowFailedByStepTimeout) {
            continue;
          }

          for (const stepRun of stepRuns) {
            if (stepRun.data.status !== STEP_STATUSES.inProgress) {
              continue;
            }

            const stepDef = findStepDefinition(typedWorkflowDefinition, stepRun.data.stepId);
            if (!stepDef) {
              continue;
            }

            const isToolStep = (stepDef.type ?? "agent") === "tool";
            const issue = stepRun.data.issueId
              ? await ctx.issues.get(stepRun.data.issueId, companyId)
              : null;

            if (issue && (issue.status === "done" || issue.status === "in_review")) {
              const artifactValidation = await validateRequiredStepArtifacts(
                typedWorkflowRun,
                typedWorkflowDefinition,
                stepDef,
              );
              if (!artifactValidation.ok) {
                await ctx.issues.update(issue.id, { status: "blocked" } as IssueUpdatePatch, companyId);
                await ctx.issues.createComment(
                  issue.id,
                  [
                    "### Required workflow artifact missing",
                    `- Step: ${stepRun.data.stepId}`,
                    `- Workflow: ${typedWorkflowRun.data.workflowName}`,
                    `- Required artifact: ${artifactValidation.requiredPath}`,
                    "- Result: reconciler refused terminal issue sync; downstream steps remain blocked until the artifact is recovered.",
                  ].join("\n"),
                  companyId,
                );
                ctx.logger.warn("Reconciler: terminal issue is missing required workflow artifact", {
                  companyId,
                  issueId: stepRun.data.issueId,
                  requiredPath: artifactValidation.requiredPath,
                  runId: typedWorkflowRun.id,
                  stepId: stepRun.data.stepId,
                  workflowName: typedWorkflowRun.data.workflowName,
                });
                continue;
              }

              const completedStepRun = toWorkflowStepRunRecord(await updateStepRun(ctx, stepRun.id, {
                completedAt: stepRun.data.completedAt ?? nowIso,
                status: STEP_STATUSES.done,
              }));
              stepRunsById.set(completedStepRun.data.stepId, completedStepRun);

              ctx.logger.info("Reconciler: finalized workflow step from terminal issue state", {
                companyId,
                issueId: stepRun.data.issueId,
                runId: typedWorkflowRun.id,
                stepId: completedStepRun.data.stepId,
                issueStatus: issue.status,
              });

              for (const candidate of stepRuns) {
                if (candidate.data.status !== STEP_STATUSES.backlog) {
                  continue;
                }

                if (!areDependenciesSatisfied(typedWorkflowDefinition, candidate.data.stepId, stepRunsById)) {
                  continue;
                }

                const candidateStepDef = findStepDefinition(typedWorkflowDefinition, candidate.data.stepId);
                if (!candidateStepDef) {
                  continue;
                }

                if ((candidateStepDef.type ?? "agent") === "tool") {
                  const activatedToolStep = await retryToolStep(
                    ctx,
                    candidate,
                    candidateStepDef,
                    typedWorkflowRun,
                    typedWorkflowDefinition,
                    companyId,
                  );
                  stepRunsById.set(activatedToolStep.data.stepId, activatedToolStep);
                  if (activatedToolStep.data.status === STEP_STATUSES.inProgress) {
                    stepsRetriggered += 1;
                    ctx.logger.info("Reconciler: activated dependent tool step after terminal issue sync", {
                      companyId,
                      runId: typedWorkflowRun.id,
                      stepId: activatedToolStep.data.stepId,
                      workflowName: typedWorkflowRun.data.workflowName,
                    });
                  } else {
                    ctx.logger.warn("Reconciler: dependent tool step dispatch failed; left step pending", {
                      companyId,
                      runId: typedWorkflowRun.id,
                      stepId: candidate.data.stepId,
                      workflowName: typedWorkflowRun.data.workflowName,
                    });
                  }
                  continue;
                }

                const activatedAgentStep = await activateAgentStep(
                  ctx,
                  candidate,
                  candidateStepDef,
                  typedWorkflowRun,
                  typedWorkflowDefinition,
                  companyId,
                );
                stepRunsById.set(activatedAgentStep.data.stepId, activatedAgentStep);
                stepsRetriggered += 1;
                ctx.logger.info("Reconciler: activated dependent agent step after terminal issue sync", {
                  agentName: activatedAgentStep.data.agentName,
                  companyId,
                  runId: typedWorkflowRun.id,
                  stepId: activatedAgentStep.data.stepId,
                  workflowName: typedWorkflowRun.data.workflowName,
                });
              }

              continue;
            }

            if (!isToolStep) {
              continue;
            }

            const timeoutMs = getStepTimeoutMs(stepDef);
            if (!isStepTimedOut(stepRun, timeoutMs)) {
              continue;
            }

            const retriggeredToolStep = await retryToolStep(
              ctx,
              stepRun,
              stepDef,
              typedWorkflowRun,
              typedWorkflowDefinition,
              companyId,
            );
            stepRunsById.set(retriggeredToolStep.data.stepId, retriggeredToolStep);
            if (retriggeredToolStep.data.status === STEP_STATUSES.inProgress) {
              stepsRetriggered += 1;
              ctx.logger.info("Reconciler: re-triggered stale in-progress tool step", {
                companyId,
                runId: typedWorkflowRun.id,
                stepId: stepRun.data.stepId,
                toolName: stepDef.toolName,
                workflowName: typedWorkflowRun.data.workflowName,
              });
            } else {
              ctx.logger.warn("Reconciler: stale in-progress tool step reset to pending after dispatch failure", {
                companyId,
                runId: typedWorkflowRun.id,
                stepId: stepRun.data.stepId,
                toolName: stepDef.toolName,
                workflowName: typedWorkflowRun.data.workflowName,
              });
            }
          }

          await completeWorkflowRunIfResolved(
            ctx,
            typedWorkflowRun,
            typedWorkflowDefinition,
            companyId,
            stepRunsById,
          );
        } catch (error) {
          ctx.logger.warn("Reconciler: failed while processing workflow run", {
            companyId,
            error: error instanceof Error ? error.message : String(error),
            runId: runRecord.id,
          });
        }
      }
    }
  } catch (error) {
    ctx.logger.warn("Reconciler: unexpected failure", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    ctx.logger.info(
      `Reconciler completed: ${runsChecked} runs checked, ${stepsRetriggered} steps re-triggered, ${stepsTimedOut} steps timed out`,
    );
  }
}

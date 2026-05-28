import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEntityRecord,
  type PluginEvent,
  type PluginJobContext,
} from "@paperclipai/plugin-sdk";
import { JOB_KEYS, RUN_STATUSES, STEP_STATUSES } from "./constants.js";
import {
  getEscalationTarget,
  getNextSteps,
  getRetryInfo,
  type WorkflowStep,
} from "./dag-engine.js";
import {
  formatDateKeyInTimezone,
  checkIdempotency,
  createWorkflowDefinition,
  createWorkflowRun,
  listWorkflowRunsByWorkflowId,
  updateWorkflowDefinition,
  createStepRun,
  findStepRunByIssueId,
  getStepRun,
  getWorkflowDefinition,
  getWorkflowRun,
  listActiveRuns,
  listRecentRuns,
  listStepRuns,
  listWorkflowDefinitions,
  markIdempotency,
  updateStepRun,
  updateWorkflowRun,
  type WorkflowRun,
  type WorkflowStepRun,
} from "./workflow-store.js";
import {
  TERMINAL_STEP_STATUSES,
  findStepDefinition,
  getStepAgentName,
  getStepAgentNameHint,
  toWorkflowDefinitionRecord,
  toWorkflowRunRecord,
  toWorkflowStepRunRecord,
  type WorkflowDefinitionRecord,
  type WorkflowRunRecord,
  type WorkflowStepRunRecord,
} from "./workflow-utils.js";
import { checkDailyRunGuard } from "./run-guards.js";
import { ensureIssueLabels } from "./issue-labels.js";
import { normalizeCreateParentIssuePolicy, shouldCreateParentIssueForRun } from "./workflow-parent-policy.js";
import {
  autoCompleteWorkflowStepIssue,
  syncWorkflowStepIssueStatus,
  syncWorkflowStepIssueStatusFromStepRun,
} from "./run-event-utils.js";
import { validateRequiredStepArtifacts } from "./artifact-guards.js";

type WorkflowStepMetadata = WorkflowStep & {
  description?: string;
  assigneeAgentId?: string;
  sessionMode?: "fresh" | "reuse";
};
type AgentRecord = Awaited<ReturnType<PluginContext["agents"]["list"]>>[number];
type IssueRecord = Awaited<ReturnType<PluginContext["issues"]["list"]>>[number];
type IssueListStatus = Parameters<PluginContext["issues"]["list"]>[0]["status"];
type IssueUpdatePatch = Parameters<PluginContext["issues"]["update"]>[1];
type IssueCreateInput = Parameters<PluginContext["issues"]["create"]>[0];
type ReconcilerModule = {
  reconcileStuckSteps?: (ctx: PluginContext) => Promise<void>;
  runScheduledWorkflows?: (ctx: PluginContext) => Promise<void>;
  setStartWorkflowFn?: (fn: (
    ctx: PluginContext,
    workflowId: string,
    companyId: string,
    options?: {
      createParentIssue?: boolean;
      missionId?: string;
      parentIssueId?: string;
      createParentIssuePolicy?: unknown;
      triggerSource?: WorkflowRun["triggerSource"];
    },
  ) => Promise<unknown>) => void;
};
const OPEN_ISSUE_STATUSES = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);
const inflightToolResultKeys = new Set<string>();
const inflightAdvanceWorkflowKeys = new Set<string>();
const inflightStepActivationKeys = new Set<string>();
const TOOL_REGISTRY_ACTION_MAX_ATTEMPTS = 3;
const TOOL_REGISTRY_ACTION_RETRY_DELAYS_MS = [1000, 3000];
const RETRIABLE_TOOL_REGISTRY_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
type ToolDispatchFailureDisposition = "accepted_unknown" | "retryable_pending" | "fatal_pending";

function resolveTemplateVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\$(\w+)\}/g, (_, key) => vars[key] ?? `{$${key}}`);
}

function parseRunLabelParts(runLabel: string | null | undefined): { date?: string; runNumber?: string } {
  const value = typeof runLabel === "string" ? runLabel.trim() : "";
  const match = /^#(\d{4}-\d{2}-\d{2})-(\d+)$/.exec(value);
  if (!match) {
    return {};
  }

  return {
    date: match[1],
    runNumber: match[2],
  };
}

function resolveWorkflowRunDate(
  workflowRun: WorkflowRunRecord,
  workflowDefinition: WorkflowDefinitionRecord,
): string {
  const explicit = typeof workflowRun.data.runDate === "string" ? workflowRun.data.runDate.trim() : "";
  if (explicit) {
    return explicit;
  }

  const parsed = parseRunLabelParts(workflowRun.data.runLabel);
  if (parsed.date) {
    return parsed.date;
  }

  const startedAt = typeof workflowRun.data.startedAt === "string" ? workflowRun.data.startedAt.trim() : "";
  const startedMs = Date.parse(startedAt);
  if (Number.isFinite(startedMs)) {
    const timezone = typeof workflowDefinition.data.timezone === "string"
      ? workflowDefinition.data.timezone.trim()
      : "";
    return formatDateKeyInTimezone(new Date(startedMs), timezone || undefined)
      ?? new Date(startedMs).toISOString().slice(0, 10);
  }

  return new Date().toISOString().slice(0, 10);
}

function resolveWorkflowRunNumber(workflowRun: WorkflowRunRecord): string {
  if (typeof workflowRun.data.runNumber === "number" && Number.isFinite(workflowRun.data.runNumber)) {
    return String(workflowRun.data.runNumber);
  }

  const parsed = parseRunLabelParts(workflowRun.data.runLabel);
  if (parsed.runNumber) {
    return parsed.runNumber;
  }

  return "";
}

function extractLabelNames(payload: Record<string, unknown>): string[] {
  const names: string[] = [];
  const candidates = [
    payload.labels,
    (payload.issue as Record<string, unknown> | undefined)?.labels,
  ];
  for (const raw of candidates) {
    if (!Array.isArray(raw)) continue;
    for (const item of raw) {
      const name = typeof item === "string" ? item.trim()
        : typeof item === "object" && item !== null ? String((item as Record<string, unknown>).name ?? "").trim()
        : "";
      if (name) names.push(name);
    }
  }
  return names;
}

function getPaperclipApiUrl(): string {
  return process.env.PAPERCLIP_API_URL || "http://localhost:3200";
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

function buildToolResultIdempotencyKey(
  stepRunId: string,
  success: boolean,
  requestId?: string,
): string {
  const request = typeof requestId === "string" ? requestId.trim() : "";
  if (request) {
    return `tool-result:${stepRunId}:${request}:${success ? "success" : "failure"}`;
  }

  return `tool-result:${stepRunId}:${success ? "success" : "failure"}`;
}

function buildAdvanceWorkflowIdempotencyKey(workflowRunId: string, stepRunId: string): string {
  return `advance-workflow:${workflowRunId}:${stepRunId}`;
}

function buildStepActivationKey(runId: string, stepId: string): string {
  return `step-activation:${runId}:${stepId}`;
}

function formatDuration(startedAt: string | null | undefined, completedAt: string | null | undefined): string {
  const startedMs = Date.parse(typeof startedAt === "string" ? startedAt : "");
  const completedMs = Date.parse(typeof completedAt === "string" ? completedAt : "");
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs) || completedMs < startedMs) {
    return "unknown";
  }

  const totalSeconds = Math.round((completedMs - startedMs) / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function buildWorkflowTemplateVars(
  workflowRun: WorkflowRunRecord,
  workflowDefinition: WorkflowDefinitionRecord,
): Record<string, string> {
  return {
    date: resolveWorkflowRunDate(workflowRun, workflowDefinition),
    runNumber: resolveWorkflowRunNumber(workflowRun),
    runLabel: workflowRun.data.runLabel ?? "",
    workflowName: workflowRun.data.workflowName,
  };
}

function getWorkflowMissionTitle(workflowName: string, dateStr: string): string {
  return `${dateStr} ${workflowName}`;
}

function getPaperclipApiBaseUrls(): string[] {
  const configured = typeof process.env.PAPERCLIP_API_URL === "string" ? process.env.PAPERCLIP_API_URL.trim() : "";
  const urls = configured ? [configured] : [];
  for (const fallback of ["http://localhost:3200", "http://localhost:3100"]) {
    if (!urls.includes(fallback)) urls.push(fallback);
  }
  return urls;
}

function resolveWorkflowMissionOwnerAgentId(
  workflowDefinition: WorkflowDefinitionRecord,
  agents: AgentRecord[],
): string {
  const explicitStepAgentId = workflowDefinition.data.steps.find((step) => {
    const rawAgentId = (step as unknown as Record<string, unknown>).agentId;
    const agentId = typeof rawAgentId === "string" ? rawAgentId.trim() : "";
    return agentId && agents.some((agent) => agent.id === agentId);
  });
  if (explicitStepAgentId) {
    const rawAgentId = (explicitStepAgentId as unknown as Record<string, unknown>).agentId;
    if (typeof rawAgentId === "string" && rawAgentId.trim()) return rawAgentId.trim();
  }

  for (const step of workflowDefinition.data.steps) {
    const agentNameHint = getStepAgentNameHint(step);
    if (!agentNameHint) continue;
    const matchedAgent = agents.find((agent) => agent.name === agentNameHint);
    if (matchedAgent) return matchedAgent.id;
  }

  const firstAgent = agents[0];
  if (!firstAgent) {
    throw new Error("Cannot create workflow mission: no agent exists for company");
  }
  return firstAgent.id;
}

async function createWorkflowMissionViaApi(
  companyId: string,
  ownerAgentId: string,
  workflowName: string,
  dateStr: string,
): Promise<string> {
  const body = JSON.stringify({
    ownerAgentId,
    title: getWorkflowMissionTitle(workflowName, dateStr),
    description: `Created automatically for workflow run: ${workflowName}`,
    status: "active",
    source: "workflow",
  });
  const errors: string[] = [];

  for (const apiUrl of getPaperclipApiBaseUrls()) {
    try {
      const res = await fetch(`${apiUrl}/api/companies/${companyId}/missions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (res.ok) {
        const mission = await res.json() as { id?: unknown };
        const missionId = typeof mission.id === "string" ? mission.id.trim() : "";
        if (missionId) return missionId;
        errors.push(`${apiUrl}: response did not include mission id`);
        continue;
      }
      errors.push(`${apiUrl}: ${res.status} ${await res.text()}`);
    } catch (error) {
      errors.push(`${apiUrl}: ${summarizeError(error)}`);
    }
  }

  throw new Error(`Cannot create workflow mission via API: ${errors.join("; ")}`);
}

function areStepDependenciesSatisfied(
  workflowDefinition: WorkflowDefinitionRecord,
  stepId: string,
  stepRunsById: Map<string, WorkflowStepRunRecord>,
): boolean {
  const stepDef = findStepDefinition(workflowDefinition, stepId);
  if (!stepDef) {
    return false;
  }

  return stepDef.dependsOn.every((depId) => {
    const depRun = stepRunsById.get(depId);
    if (!depRun) {
      return false;
    }

    return depRun.data.status === STEP_STATUSES.done || depRun.data.status === STEP_STATUSES.skipped;
  });
}

async function resetWorkflowStepIssueForRerun(
  ctx: PluginContext,
  issueId: string,
  companyId: string,
  stepId: string,
  workflowName: string,
): Promise<void> {
  try {
    await ctx.issues.update(issueId, { status: "todo" } as IssueUpdatePatch, companyId);
    await ctx.issues.createComment(
      issueId,
      [
        "### Workflow step rerun requested",
        `- Step: ${stepId}`,
        `- Workflow: ${workflowName}`,
        `- Requested at: ${new Date().toISOString()}`,
      ].join("\n"),
      companyId,
    );
  } catch (error) {
    ctx.logger.warn("Failed to reset workflow step issue for rerun", {
      companyId,
      error: summarizeError(error),
      issueId,
      stepId,
      workflowName,
    });
  }
}

async function cancelActiveIssueRun(
  ctx: PluginContext,
  issueId: string,
  companyId: string,
): Promise<{ activeRunId?: string; cancelledRunId?: string; error?: string }> {
  const apiUrl = getPaperclipApiUrl();

  try {
    const activeRunRes = await fetch(`${apiUrl}/api/issues/${issueId}/active-run`);
    if (!activeRunRes.ok) {
      return { error: `active-run lookup failed (${activeRunRes.status})` };
    }

    const activeRun = await activeRunRes.json() as { id?: string; status?: string } | null;
    const activeRunId = typeof activeRun?.id === "string" ? activeRun.id : "";
    if (!activeRunId || activeRun?.status !== "running") {
      return {};
    }

    const cancelRes = await fetch(`${apiUrl}/api/heartbeat-runs/${activeRunId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!cancelRes.ok) {
      return { activeRunId, error: `cancel failed (${cancelRes.status})` };
    }

    const cancelled = await cancelRes.json() as { id?: string } | null;
    const cancelledRunId = typeof cancelled?.id === "string" ? cancelled.id : activeRunId;
    ctx.logger.info("Cancelled active heartbeat run for workflow step issue", {
      activeRunId,
      cancelledRunId,
      companyId,
      issueId,
    });
    return { activeRunId, cancelledRunId };
  } catch (error) {
    return { error: summarizeError(error) };
  }
}

function buildWorkflowParentIssueTerminalComment(input: {
  workflowRun: WorkflowRunRecord;
  status: "cancelled" | "blocked";
  reason: string;
  stepId?: string;
  failedBy?: "manual_abort" | "agent_failure" | "tool_failure";
}): string {
  const stepId = input.stepId?.trim();
  const markerStep = stepId || input.failedBy || "terminal";
  return [
    "### Workflow run aborted by workflow engine",
    `<!-- workflow-failure:${input.workflowRun.id}:${markerStep} -->`,
    "",
    input.reason,
    "",
    "Main executor diagnosis required:",
    "- Identify the failed step/output and decide whether retry is safe.",
    "- Try `rerun-step` for the failed step or `resume-run` for the workflow run when retry is safe.",
    "- If retry is unsafe, write the recovery/replan path before restarting the workflow.",
    "- Keep this parent oversight issue open as the operator-facing recovery record until retry, replan, or escalation is complete.",
  ].join("\n");
}

async function markWorkflowParentIssueTerminal(
  ctx: PluginContext,
  workflowRun: WorkflowRunRecord,
  companyId: string,
  status: "cancelled" | "blocked",
  comment: string,
): Promise<boolean> {
  const parentIssueId = typeof workflowRun.data.parentIssueId === "string"
    ? workflowRun.data.parentIssueId.trim()
    : "";
  if (!parentIssueId) return false;

  try {
    const parentIssue = await ctx.issues.get(parentIssueId, companyId);
    if (!parentIssue || parentIssue.status === "done") {
      return false;
    }
    const shouldUpdateStatus = parentIssue.status !== status && parentIssue.status !== "cancelled";
    if (shouldUpdateStatus) {
      await ctx.issues.update(parentIssueId, { status } as IssueUpdatePatch, companyId);
    }
    await ctx.issues.createComment(parentIssueId, comment, companyId);
    return shouldUpdateStatus;
  } catch (error) {
    ctx.logger.warn("Failed to mark workflow parent issue terminal", {
      companyId,
      error: summarizeError(error),
      parentIssueId,
      runId: workflowRun.id,
      status,
    });
    return false;
  }
}

async function abortWorkflowRunState(
  ctx: PluginContext,
  workflowRunId: string,
  companyId: string,
): Promise<void> {
  const workflowRunRecord = await getWorkflowRun(ctx, workflowRunId);
  if (!workflowRunRecord) {
    throw new Error(`Workflow run not found: ${workflowRunId}`);
  }

  const workflowRun = toWorkflowRunRecord(workflowRunRecord);
  const stepRuns = (await listStepRuns(ctx, workflowRunId, companyId)).map(toWorkflowStepRunRecord);
  const completedAt = new Date().toISOString();
  let cancelledIssues = 0;
  let cancelledHeartbeats = 0;
  let cancelledParentIssue = false;

  for (const stepRun of stepRuns) {
    if (TERMINAL_STEP_STATUSES.has(stepRun.data.status)) {
      continue;
    }

    const issueId = typeof stepRun.data.issueId === "string" ? stepRun.data.issueId.trim() : "";
    if (issueId) {
      const cancelResult = await cancelActiveIssueRun(ctx, issueId, companyId);
      if (cancelResult.cancelledRunId) {
        cancelledHeartbeats += 1;
      } else if (cancelResult.error) {
        ctx.logger.warn("Failed to cancel active heartbeat run for workflow step issue", {
          companyId,
          error: cancelResult.error,
          issueId,
          runId: workflowRunId,
          stepId: stepRun.data.stepId,
        });
      }

      try {
        const issueSyncResult = await syncWorkflowStepIssueStatusFromStepRun(
          ctx,
          stepRun,
          companyId,
          "cancelled",
          {
            comment: [
              "### Workflow run aborted by workflow engine",
              "",
              "This workflow run was aborted from the Workflow Engine UI.",
              "The step issue was marked cancelled so the workflow does not stay open.",
            ].join("\n"),
          },
        );
        if (issueSyncResult.completed) {
          cancelledIssues += 1;
        }
      } catch (error) {
        ctx.logger.warn("Failed to mark workflow step issue cancelled during abort", {
          companyId,
          error: summarizeError(error),
          issueId,
          runId: workflowRunId,
          stepId: stepRun.data.stepId,
        });
      }
    }

    try {
      if (stepRun.data.sessionId?.trim()) {
        await ctx.agents.sessions.close(stepRun.data.sessionId.trim(), companyId);
      }
    } catch (error) {
      ctx.logger.warn("Failed to close workflow step session during abort", {
        companyId,
        error: summarizeError(error),
        runId: workflowRunId,
        sessionId: stepRun.data.sessionId,
        stepId: stepRun.data.stepId,
      });
    }

    await updateStepRun(ctx, stepRun.id, {
      completedAt,
      status: STEP_STATUSES.skipped,
    });
  }

  await updateWorkflowRun(ctx, workflowRunId, {
    completedAt,
    status: RUN_STATUSES.aborted,
  });

  if (await markWorkflowParentIssueTerminal(
    ctx,
    workflowRun,
    companyId,
    "cancelled",
    buildWorkflowParentIssueTerminalComment({
      workflowRun,
      status: "cancelled",
      failedBy: "manual_abort",
      reason: "This parent oversight issue was marked cancelled because the workflow run was aborted from the Workflow Engine UI.",
    }),
  )) {
    cancelledParentIssue = true;
  }

  ctx.logger.info("Workflow run aborted from Workflow Engine UI", {
    cancelledHeartbeats,
    cancelledIssues,
    cancelledParentIssue,
    companyId,
    runId: workflowRunId,
    stepCount: stepRuns.length,
  });
}

async function matchWorkflowTrigger(
  ctx: PluginContext,
  companyId: string,
  labels: string[],
): Promise<WorkflowDefinitionRecord[]> {
  const definitions = await listWorkflowDefinitions(ctx, companyId);
  const lowerLabels = labels.map((l) => l.toLowerCase());
  return definitions
    .map(toWorkflowDefinitionRecord)
    .filter((def) => def.data.status === "active")
    .filter((def) => {
      const triggerLabels = def.data.triggerLabels ?? [];
      return triggerLabels.length > 0 &&
        triggerLabels.some((tl) => lowerLabels.includes(tl.toLowerCase()));
    });
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
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

function buildTextExcerpt(value: unknown, maxLength = 2000): string {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}\n...(truncated)` : trimmed;
}

function parseOptionalNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.trunc(value);
  if (normalized < 0) {
    return undefined;
  }

  return normalized;
}

function parseOptionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

type WorkflowIssueCreateInput = IssueCreateInput & Record<string, unknown> & {
  missionId?: string | null;
  originKind?: string | null;
  originId?: string | null;
  originRunId?: string | null;
};

async function createIssueWithLabels(
  ctx: PluginContext,
  input: WorkflowIssueCreateInput,
  labelIds?: string[],
): Promise<ReturnType<typeof ctx.issues.create>> {
  const issue = await ctx.issues.create(input as IssueCreateInput);
  await ensureIssueLabels(ctx, issue.id, input.companyId, labelIds);
  return issue;
}

function sortIssuesByCreatedAt(issues: IssueRecord[]): IssueRecord[] {
  return [...issues].sort((left, right) => {
    const leftMs = Date.parse(String(left.createdAt ?? ""));
    const rightMs = Date.parse(String(right.createdAt ?? ""));
    if (!Number.isFinite(leftMs) && !Number.isFinite(rightMs)) return 0;
    if (!Number.isFinite(leftMs)) return 1;
    if (!Number.isFinite(rightMs)) return -1;
    return leftMs - rightMs;
  });
}

async function listCompanyIssues(
  ctx: PluginContext,
  companyId: string,
  status?: IssueListStatus,
): Promise<IssueRecord[]> {
  const pageSize = 200;
  let offset = 0;
  const issues: IssueRecord[] = [];

  while (true) {
    const page = await ctx.issues.list({
      companyId,
      limit: pageSize,
      offset,
      status,
    });
    issues.push(...page);
    if (page.length < pageSize) {
      break;
    }
    offset += page.length;
  }

  return issues;
}

async function findDuplicateStepIssues(
  ctx: PluginContext,
  companyId: string,
  title: string,
  parentIssueId?: string,
): Promise<IssueRecord[]> {
  if (!parentIssueId) {
    return [];
  }

  const issues = await listCompanyIssues(ctx, companyId);
  return sortIssuesByCreatedAt(
    issues.filter((issue) =>
      issue.parentId === parentIssueId &&
      issue.title === title &&
      OPEN_ISSUE_STATUSES.has(String(issue.status ?? ""))
    ),
  );
}

async function reconcileDuplicateStepIssues(
  ctx: PluginContext,
  companyId: string,
  title: string,
  parentIssueId?: string,
): Promise<IssueRecord | null> {
  const duplicates = await findDuplicateStepIssues(ctx, companyId, title, parentIssueId);
  if (duplicates.length === 0) {
    return null;
  }

  const canonical = duplicates[0] ?? null;
  for (const duplicate of duplicates.slice(1)) {
    try {
      await ctx.issues.update(duplicate.id, { status: "cancelled" } as IssueUpdatePatch, companyId);
      await ctx.issues.createComment(
        duplicate.id,
        `Cancelled as duplicate of issue ${canonical?.id ?? ""} for workflow step "${title}".`,
        companyId,
      );
    } catch (error) {
      ctx.logger.warn("Failed to cancel duplicate workflow step issue", {
        companyId,
        duplicateIssueId: duplicate.id,
        error: summarizeError(error),
        parentIssueId,
        title,
      });
    }
  }

  return canonical;
}

function buildIdempotencyKey(event: PluginEvent): string {
  return `${event.eventType}:${event.eventId}`;
}

function getStepMetadata(stepDef: WorkflowStep): WorkflowStepMetadata {
  return stepDef as WorkflowStepMetadata;
}

function getStepDescription(stepDef: WorkflowStep): string | undefined {
  const description = getStepMetadata(stepDef).description;
  return typeof description === "string" && description.trim() ? description.trim() : undefined;
}

function getStepAgentIdHint(stepDef: WorkflowStep): string | null {
  const assigneeAgentId = getStepMetadata(stepDef).assigneeAgentId;
  if (typeof assigneeAgentId !== "string" || !assigneeAgentId.trim()) {
    return null;
  }

  return assigneeAgentId.trim();
}

async function resolveStepAgent(
  ctx: PluginContext,
  companyId: string,
  stepDef: WorkflowStep,
  fallbackAgentName?: string,
): Promise<{ agentId: string | null; agentName: string | null }> {
  const preferredName = typeof fallbackAgentName === "string" && fallbackAgentName.trim()
    ? fallbackAgentName.trim()
    : getStepAgentNameHint(stepDef);

  if (preferredName) {
    const agents = await ctx.agents.list({ companyId });
    const agent = agents.find((candidate: AgentRecord) => candidate.name === preferredName) ?? null;
    return {
      agentId: agent?.id ?? null,
      agentName: agent?.name ?? preferredName,
    };
  }

  const agentIdHint = getStepAgentIdHint(stepDef);
  if (!agentIdHint) {
    return {
      agentId: null,
      agentName: null,
    };
  }

  const agent = await ctx.agents.get(agentIdHint, companyId);
  return {
    agentId: agent?.id ?? null,
    agentName: agent?.name ?? null,
  };
}

async function resetToolStepAfterDispatchFailure(
  ctx: PluginContext,
  stepRunRecord: WorkflowStepRunRecord,
  stepDef: WorkflowStep,
  workflowName: string,
  companyId: string,
  requestId: string,
  error: unknown,
): Promise<WorkflowStepRunRecord> {
  const resetAt = new Date().toISOString();
  const resetStepRun = toWorkflowStepRunRecord(await updateStepRun(ctx, stepRunRecord.id, {
    completedAt: undefined,
    startedAt: undefined,
    lastDispatchAcceptedAt: undefined,
    lastDispatchAttemptAt: resetAt,
    lastDispatchErrorAt: resetAt,
    lastDispatchErrorSummary: summarizeError(error),
    lastDispatchRequestId: requestId,
    status: STEP_STATUSES.todo,
  }));

  if (resetStepRun.data.issueId) {
    try {
      await ctx.issues.update(
        resetStepRun.data.issueId,
        { status: "todo" } as IssueUpdatePatch,
        companyId,
      );
    } catch (issueError) {
      ctx.logger.warn("Failed to reset tool step issue after dispatch failure", {
        companyId,
        error: summarizeError(issueError),
        issueId: resetStepRun.data.issueId,
        stepId: stepDef.id,
        toolName: stepDef.toolName,
        workflowName,
      });
    }

    try {
      await ctx.issues.createComment(
        resetStepRun.data.issueId,
        [
          `### Tool dispatch failed: ${stepDef.toolName ?? "unknown-tool"}`,
          `- Step: ${stepDef.id}`,
          `- Failed at: ${resetAt}`,
          `- Error: ${summarizeError(error)}`,
          "- Workflow engine reset this step to `todo` so the reconciler can retry it automatically.",
        ].join("\n"),
        companyId,
      );
    } catch (commentError) {
      ctx.logger.warn("Failed to post tool dispatch failure comment", {
        companyId,
        error: summarizeError(commentError),
        issueId: resetStepRun.data.issueId,
        stepId: stepDef.id,
        toolName: stepDef.toolName,
        workflowName,
      });
    }
  }

  ctx.logger.warn("Tool dispatch failed; workflow step reset to todo", {
    companyId,
    error: summarizeError(error),
    issueId: resetStepRun.data.issueId,
    runId: resetStepRun.data.runId,
    stepId: stepDef.id,
    stepRunId: resetStepRun.id,
    toolName: stepDef.toolName,
    workflowName,
  });

  return resetStepRun;
}

async function keepToolStepInProgressAfterAmbiguousDispatch(
  ctx: PluginContext,
  stepRunRecord: WorkflowStepRunRecord,
  stepDef: WorkflowStep,
  workflowName: string,
  companyId: string,
  requestId: string,
  error: unknown,
): Promise<WorkflowStepRunRecord> {
  const observedAt = new Date().toISOString();
  const updatedStepRun = toWorkflowStepRunRecord(await updateStepRun(ctx, stepRunRecord.id, {
    completedAt: undefined,
    startedAt: stepRunRecord.data.startedAt ?? observedAt,
    lastDispatchAttemptAt: observedAt,
    lastDispatchErrorAt: observedAt,
    lastDispatchErrorSummary: summarizeError(error),
    lastDispatchRequestId: requestId,
    status: STEP_STATUSES.inProgress,
  }));

  if (updatedStepRun.data.issueId) {
    try {
      await ctx.issues.update(
        updatedStepRun.data.issueId,
        { status: "in_progress" } as IssueUpdatePatch,
        companyId,
      );
    } catch (issueError) {
      ctx.logger.warn("Failed to preserve tool step issue after ambiguous dispatch", {
        companyId,
        error: summarizeError(issueError),
        issueId: updatedStepRun.data.issueId,
        stepId: stepDef.id,
        toolName: stepDef.toolName,
        workflowName,
      });
    }

    try {
      await ctx.issues.createComment(
        updatedStepRun.data.issueId,
        [
          `### Tool dispatch uncertain: ${stepDef.toolName ?? "unknown-tool"}`,
          `- Step: ${stepDef.id}`,
          `- Observed at: ${observedAt}`,
          `- Error: ${summarizeError(error)}`,
          "- Workflow engine kept this step in `in_progress` to avoid duplicate execution. It will wait for the tool result before retrying.",
        ].join("\n"),
        companyId,
      );
    } catch (commentError) {
      ctx.logger.warn("Failed to post ambiguous tool dispatch comment", {
        companyId,
        error: summarizeError(commentError),
        issueId: updatedStepRun.data.issueId,
        stepId: stepDef.id,
        toolName: stepDef.toolName,
        workflowName,
      });
    }
  }

  ctx.logger.warn("Tool dispatch became uncertain; workflow step remains in progress", {
    companyId,
    disposition: "accepted_unknown",
    error: summarizeError(error),
    issueId: updatedStepRun.data.issueId,
    runId: updatedStepRun.data.runId,
    stepId: stepDef.id,
    stepRunId: updatedStepRun.id,
    toolName: stepDef.toolName,
    workflowName,
  });

  return updatedStepRun;
}

async function executeToolStep(
  ctx: PluginContext,
  stepRunRecord: WorkflowStepRunRecord,
  stepDef: WorkflowStep,
  workflowName: string,
  companyId: string,
): Promise<WorkflowStepRunRecord> {
  const toolName = stepDef.toolName;
  if (!toolName) {
    ctx.logger.warn("Tool step missing toolName", { stepId: stepDef.id, workflowName });
    return stepRunRecord;
  }

  ctx.logger.info("Executing workflow tool step", {
    companyId,
    issueId: stepRunRecord.data.issueId,
    runId: stepRunRecord.data.runId,
    stepId: stepDef.id,
    stepRunId: stepRunRecord.id,
    toolName,
    workflowName,
  });

  if (stepRunRecord.data.issueId) {
    const startedAt = stepRunRecord.data.startedAt ?? new Date().toISOString();
    try {
      const stepIssue = await ctx.issues.get(stepRunRecord.data.issueId, companyId);
      const hasAssignee = Boolean(stepIssue?.assigneeAgentId || stepIssue?.assigneeUserId);
      if (hasAssignee) {
        await ctx.issues.update(
          stepRunRecord.data.issueId,
          { status: "in_progress" } as IssueUpdatePatch,
          companyId,
        );
      } else {
        ctx.logger.info("Leaving unassigned tool step issue in todo while step run executes", {
          companyId,
          issueId: stepRunRecord.data.issueId,
          stepId: stepDef.id,
          toolName,
          workflowName,
        });
      }
    } catch (error) {
      ctx.logger.warn("Failed to inspect or mark tool step issue in progress", {
        companyId,
        error: summarizeError(error),
        issueId: stepRunRecord.data.issueId,
        stepId: stepDef.id,
        toolName,
        workflowName,
      });
    }

    try {
      await ctx.issues.createComment(
        stepRunRecord.data.issueId,
        [
          `### Tool started: ${toolName}`,
          `- Step: ${stepDef.id}`,
          `- Started at: ${startedAt}`,
          `- Workflow: ${workflowName}`,
        ].join("\n"),
        companyId,
      );
    } catch (error) {
      ctx.logger.warn("Failed to create tool step start comment", {
        companyId,
        error: summarizeError(error),
        issueId: stepRunRecord.data.issueId,
        stepId: stepDef.id,
        toolName,
        workflowName,
      });
    }
  }

  const requestId = `${stepRunRecord.data.runId}:${stepDef.id}:${Date.now()}`;
  const dispatchAttemptAt = new Date().toISOString();
  const dispatchStepRun = toWorkflowStepRunRecord(await updateStepRun(ctx, stepRunRecord.id, {
    startedAt: stepRunRecord.data.startedAt ?? dispatchAttemptAt,
    lastDispatchAttemptAt: dispatchAttemptAt,
    lastDispatchErrorAt: undefined,
    lastDispatchErrorSummary: undefined,
    lastDispatchRequestId: requestId,
    status: STEP_STATUSES.inProgress,
  }));
  try {
    await callToolRegistryWorkflowAction(ctx, {
      requestId,
      toolName,
      args: stepDef.toolArgs ?? {},
      companyId,
      workflowRunId: dispatchStepRun.data.runId,
      stepId: stepDef.id,
      stepRunId: dispatchStepRun.id,
      issueId: dispatchStepRun.data.issueId,
    });
  } catch (error) {
    const disposition = classifyToolRegistryActionError(error);
    if (disposition === "accepted_unknown") {
      return await keepToolStepInProgressAfterAmbiguousDispatch(
        ctx,
        dispatchStepRun,
        stepDef,
        workflowName,
        companyId,
        requestId,
        error,
      );
    }

    return await resetToolStepAfterDispatchFailure(
      ctx,
      dispatchStepRun,
      stepDef,
      workflowName,
      companyId,
      requestId,
      error,
    );
  }

  const acceptedAt = new Date().toISOString();
  const acceptedStepRun = toWorkflowStepRunRecord(await updateStepRun(ctx, dispatchStepRun.id, {
    lastDispatchAcceptedAt: acceptedAt,
    lastDispatchAttemptAt: dispatchAttemptAt,
    lastDispatchErrorAt: undefined,
    lastDispatchErrorSummary: undefined,
    lastDispatchRequestId: requestId,
    status: STEP_STATUSES.inProgress,
  }));

  ctx.logger.info("Triggered tool execution for workflow step via Tool Registry action", {
    toolName, companyId, workflowName,
    requestId,
    stepId: stepDef.id, runId: acceptedStepRun.data.runId,
  });

  return acceptedStepRun;
}

async function rerunToolStep(
  ctx: PluginContext,
  stepRunRecord: WorkflowStepRunRecord,
  stepDef: WorkflowStep,
  workflowName: string,
  companyId: string,
): Promise<WorkflowStepRunRecord> {
  const startedAt = new Date().toISOString();
  const updated = toWorkflowStepRunRecord(await updateStepRun(ctx, stepRunRecord.id, {
    completedAt: undefined,
    startedAt,
    status: STEP_STATUSES.inProgress,
    retryCount: stepRunRecord.data.retryCount + 1,
  }));

  ctx.logger.info("Reactivating workflow tool step via rerun", {
    companyId,
    issueId: updated.data.issueId,
    runId: updated.data.runId,
    stepId: updated.data.stepId,
    stepRunId: updated.id,
    toolName: stepDef.toolName,
    workflowName,
  });

  return await executeToolStep(ctx, updated, stepDef, workflowName, companyId);
}

async function invokeAgentForStep(
  ctx: PluginContext,
  stepRunRecord: WorkflowStepRunRecord,
  stepDef: WorkflowStep,
  workflowName: string,
  companyId: string,
): Promise<WorkflowStepRunRecord> {
  const agentName = getStepAgentName(stepRunRecord, stepDef);
  if (!agentName) {
    ctx.logger.warn("Agent name is missing for workflow step", {
      companyId,
      runId: stepRunRecord.data.runId,
      stepId: stepDef.id,
      workflowName,
    });
    return stepRunRecord;
  }

  const agents = await ctx.agents.list({ companyId });
  const agent = agents.find((candidate: AgentRecord) => candidate.name === agentName) ?? null;

  if (!agent) {
    ctx.logger.warn("Agent not found for step", {
      agentName,
      companyId,
      runId: stepRunRecord.data.runId,
      stepId: stepDef.id,
      workflowName,
    });
    return stepRunRecord;
  }

  const prompt = `workflow:${workflowName}/step:${stepDef.id} — "${stepDef.title}" is ready. Please proceed with the assigned task.`;
  const reason = `workflow:${workflowName}/step:${stepDef.id}`;
  const sessionMode = getStepMetadata(stepDef).sessionMode === "reuse" ? "reuse" : "fresh";

  if (sessionMode === "reuse") {
    let sessionId = typeof stepRunRecord.data.sessionId === "string" && stepRunRecord.data.sessionId.trim()
      ? stepRunRecord.data.sessionId.trim()
      : "";

    if (!sessionId) {
      const session = await ctx.agents.sessions.create(agent.id, companyId, {
        reason,
      });
      sessionId = session.sessionId;
      stepRunRecord = toWorkflowStepRunRecord(await updateStepRun(ctx, stepRunRecord.id, {
        sessionId,
      }));
    }

    await ctx.agents.sessions.sendMessage(sessionId, companyId, {
      prompt,
      reason,
    });

    ctx.logger.info("Sent workflow step prompt via agent session", {
      agentId: agent.id,
      agentName,
      companyId,
      runId: stepRunRecord.data.runId,
      sessionId,
      stepId: stepDef.id,
      workflowName,
    });
    return stepRunRecord;
  }

  // Use wakeup API directly with issueId, because ctx.agents.invoke
  // does not pass issueId to the wakeup context, causing the agent
  // to not check out the specific issue.
  const apiUrl = getPaperclipApiUrl();
  const wakeupRes = await fetch(`${apiUrl}/api/agents/${agent.id}/wakeup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "assignment",
      payload: {
        issueId: stepRunRecord.data.issueId,
        taskKey: `wf:${stepRunRecord.data.runId}:${agent.id}`,
      },
      forceFreshSession: shouldForceFreshSessionForAgentStep(
        stepDef.title,
        (agent.metadata as Record<string, unknown> | null | undefined) ?? null,
      ),
    }),
  });
  if (!wakeupRes.ok) {
    let errorDetail = "";
    try {
      const body = await wakeupRes.json() as Record<string, unknown>;
      errorDetail = String(body.error ?? "");
      const details = body.details as Record<string, unknown> | undefined;
      if (details?.status === "paused") {
        ctx.logger.error("Agent is paused — cannot execute workflow step. Unpause the agent in the UI.", {
          agentId: agent.id,
          agentName,
          companyId,
          issueId: stepRunRecord.data.issueId,
          stepId: stepDef.id,
          workflowName,
        });
        return stepRunRecord;
      }
    } catch { /* ignore parse error */ }
    ctx.logger.warn("Agent wakeup API failed, falling back to ctx.agents.invoke", {
      agentId: agent.id,
      agentName,
      error: errorDetail,
      status: wakeupRes.status,
      stepId: stepDef.id,
      workflowName,
    });
    await ctx.agents.invoke(agent.id, companyId, { prompt, reason });
  }

  ctx.logger.info("Invoked agent for workflow step", {
    agentId: agent.id,
    agentName,
    companyId,
    runId: stepRunRecord.data.runId,
    stepId: stepDef.id,
    workflowName,
  });

  return stepRunRecord;
}

async function fetchToolInstructions(
  ctx: PluginContext,
  toolNames: string[],
  companyId: string,
): Promise<string> {
  if (toolNames.length === 0) return "";

  try {
    const apiUrl = getPaperclipApiUrl();
    const trPlugins = await fetch(`${apiUrl}/api/plugins`).then((r) => r.json()) as Array<Record<string, unknown>>;
    const trPlugin = trPlugins.find((p) => p.pluginKey === "insightflo.tool-registry");
    if (!trPlugin) return "";

    const res = await fetch(`${apiUrl}/api/plugins/${trPlugin.id}/bridge/data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "tool-registry.page-data", params: { companyId } }),
    });
    if (!res.ok) return "";

    const data = (await res.json() as Record<string, unknown>).data as Record<string, unknown>;
    const tools = (data?.tools ?? []) as Array<{ data: { name: string; command: string; description?: string; instructions?: string } }>;

    const parts: string[] = [];
    for (const name of toolNames) {
      const tool = tools.find((t) => t.data.name === name);
      if (!tool) continue;
      const lines = [`### Tool: ${tool.data.name}`];
      if (tool.data.description) lines.push(tool.data.description);
      if (tool.data.instructions) lines.push(tool.data.instructions);
      lines.push(`Command: \`${tool.data.command}\``);
      parts.push(lines.join("\n"));
    }

    return parts.length > 0 ? `\n\n--- Available Tools ---\n${parts.join("\n\n")}` : "";
  } catch {
    return "";
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

      ctx.logger.warn("Workflow tool dispatch attempt failed", {
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

async function collectDependencyOutputs(
  ctx: PluginContext,
  stepDef: WorkflowStep,
  runId: string,
  companyId: string,
): Promise<string> {
  if (stepDef.dependsOn.length === 0) return "";

  const stepRuns = (await listStepRuns(ctx, runId, companyId)).map(toWorkflowStepRunRecord);
  const parts: string[] = [];

  for (const depId of stepDef.dependsOn) {
    const depRun = stepRuns.find((sr) => sr.data.stepId === depId);
    if (!depRun?.data.issueId) continue;

    try {
      const comments = await ctx.issues.listComments(depRun.data.issueId, companyId);
      const toolComments = comments.filter((c: { body?: string }) =>
        typeof c.body === "string" && c.body.includes("### Tool Execution:"),
      );
      for (const comment of toolComments) {
        parts.push(`--- Output from step "${depId}" ---\n${(comment as { body: string }).body}`);
      }
    } catch {
      // comments not available, skip
    }
  }

  return parts.join("\n\n");
}

async function activateBacklogStep(
  ctx: PluginContext,
  stepRunRecord: WorkflowStepRunRecord,
  stepDef: WorkflowStep,
  workflowName: string,
  companyId: string,
  options?: {
    missionId?: string;
    parentIssueId?: string;
    runLabel?: string;
    templateVars?: Record<string, string>;
    projectId?: string;
    goalId?: string;
    labelIds?: string[];
  },
): Promise<WorkflowStepRunRecord> {
  const activationKey = buildStepActivationKey(stepRunRecord.data.runId, stepRunRecord.data.stepId);
  if (inflightStepActivationKeys.has(activationKey)) {
    const currentStepRun = await getStepRun(ctx, stepRunRecord.id);
    return currentStepRun ? toWorkflowStepRunRecord(currentStepRun) : stepRunRecord;
  }

  inflightStepActivationKeys.add(activationKey);

  try {
    const currentStepRun = await getStepRun(ctx, stepRunRecord.id);
    const liveStepRun = currentStepRun ? toWorkflowStepRunRecord(currentStepRun) : stepRunRecord;
    if (liveStepRun.data.status !== STEP_STATUSES.backlog) {
      return liveStepRun;
    }

  const isToolStep = (stepDef.type ?? "agent") === "tool";
  const resolvedAgent = isToolStep
    ? { agentId: null, agentName: "system" }
    : await resolveStepAgent(ctx, companyId, stepDef, liveStepRun.data.agentName);
  const issueTitle = `[${workflowName}] ${resolveTemplateVars(stepDef.title, options?.templateVars ?? {})}`;

  let issueId = typeof liveStepRun.data.issueId === "string" && liveStepRun.data.issueId.trim()
    ? liveStepRun.data.issueId.trim()
    : "";
  const stepDescription = getStepDescription(stepDef) ?? `Workflow step: ${stepDef.id}`;
  const depOutputs = !isToolStep
    ? await collectDependencyOutputs(ctx, stepDef, liveStepRun.data.runId, companyId)
    : "";
  const toolInstructions = !isToolStep && (stepDef.tools ?? []).length > 0
    ? await fetchToolInstructions(ctx, stepDef.tools!, companyId)
    : "";
  const fullDescription = [stepDescription, depOutputs, toolInstructions].filter(Boolean).join("\n\n");
  let stepIssue: IssueRecord | null = null;

  if (!issueId) {
    stepIssue = await reconcileDuplicateStepIssues(
      ctx,
      companyId,
      issueTitle,
      options?.parentIssueId,
    );

    if (!stepIssue) {
      stepIssue = await createIssueWithLabels(ctx, {
        assigneeAgentId: resolvedAgent.agentId ?? undefined,
        companyId,
        description: fullDescription,
        missionId: options?.missionId,
        originId: liveStepRun.id,
        originKind: "workflow_step",
        originRunId: liveStepRun.data.runId,
        parentId: options?.parentIssueId,
        goalId: options?.goalId || undefined,
        projectId: options?.projectId || undefined,
        title: issueTitle,
      }, options?.labelIds);
      await ctx.issues.update(stepIssue.id, { status: "todo" } as IssueUpdatePatch, companyId);
    }

    const canonicalIssue = await reconcileDuplicateStepIssues(
      ctx,
      companyId,
      issueTitle,
      options?.parentIssueId,
    );
    if (canonicalIssue) {
      stepIssue = canonicalIssue;
    }
    issueId = stepIssue.id;
  } else {
    try {
      stepIssue = await ctx.issues.get(issueId, companyId);
    } catch {
      stepIssue = null;
    }
  }

  if (!stepIssue) {
    const issue = await createIssueWithLabels(ctx, {
      assigneeAgentId: resolvedAgent.agentId ?? undefined,
      companyId,
      description: fullDescription,
      missionId: options?.missionId,
      originId: liveStepRun.id,
      originKind: "workflow_step",
      originRunId: liveStepRun.data.runId,
      parentId: options?.parentIssueId,
      goalId: options?.goalId || undefined,
      projectId: options?.projectId || undefined,
      title: issueTitle,
    }, options?.labelIds);
    await ctx.issues.update(issue.id, { status: "todo" } as IssueUpdatePatch, companyId);
    stepIssue = issue;
    issueId = issue.id;
  }
  await ensureIssueLabels(ctx, issueId, companyId, options?.labelIds);

  const nextStartedAt = liveStepRun.data.startedAt ?? new Date().toISOString();
  let updatedStepRun = toWorkflowStepRunRecord(await updateStepRun(ctx, liveStepRun.id, {
    agentName: resolvedAgent.agentName ?? liveStepRun.data.agentName,
    issueId,
    startedAt: nextStartedAt,
    status: isToolStep ? STEP_STATUSES.inProgress : STEP_STATUSES.todo,
  }));

  const stepType = stepDef.type ?? "agent";
  if (stepType === "tool") {
    updatedStepRun = await executeToolStep(ctx, updatedStepRun, stepDef, workflowName, companyId);
  } else {
    updatedStepRun = await invokeAgentForStep(
      ctx,
      updatedStepRun,
      stepDef,
      workflowName,
      companyId,
    );
    // wakeup 직후 즉시 in_progress로 변경 — todo 상태로 5분 지나면 Reconciler가 stuck으로 오판
    const inProgressRecord = await updateStepRun(ctx, updatedStepRun.id, {
      status: STEP_STATUSES.inProgress,
      startedAt: updatedStepRun.data.startedAt ?? new Date().toISOString(),
    });
    updatedStepRun = toWorkflowStepRunRecord(inProgressRecord);
  }

  return updatedStepRun;
  } finally {
    inflightStepActivationKeys.delete(activationKey);
  }
}

async function rerunWorkflowStep(
  ctx: PluginContext,
  params: {
    companyId: string;
    issueId?: string;
    stepRunId?: string;
  },
): Promise<{
    issueId: string | null;
    resumedRun: boolean;
    runId: string;
    stepId: string;
    stepRunId: string;
  }> {
  const companyId = params.companyId;
  const issueId = typeof params.issueId === "string" ? params.issueId.trim() : "";
  const stepRunId = typeof params.stepRunId === "string" ? params.stepRunId.trim() : "";

  let stepRunRecord: PluginEntityRecord | null = null;
  if (stepRunId) {
    stepRunRecord = await getStepRun(ctx, stepRunId);
  } else if (issueId) {
    stepRunRecord = await findStepRunByIssueId(ctx, issueId, companyId);
  }

  if (!stepRunRecord) {
    throw new Error("Workflow step run not found");
  }

  const typedStepRun = toWorkflowStepRunRecord(stepRunRecord);
  const workflowRunRecord = await getWorkflowRun(ctx, typedStepRun.data.runId);
  if (!workflowRunRecord) {
    throw new Error(`Workflow run not found: ${typedStepRun.data.runId}`);
  }

  const typedWorkflowRun = toWorkflowRunRecord(workflowRunRecord);
  const resolvedCompanyId = typedWorkflowRun.data.companyId;
  if (companyId && companyId !== resolvedCompanyId) {
    ctx.logger.warn("Rerun step requested with mismatched company id; using workflow run company", {
      requestedCompanyId: companyId,
      resolvedCompanyId,
      runId: typedWorkflowRun.id,
      stepRunId: typedStepRun.id,
    });
  }
  const workflowDefinition = await getWorkflowDefinition(ctx, typedWorkflowRun.data.workflowId);
  if (!workflowDefinition) {
    throw new Error(`Workflow definition not found: ${typedWorkflowRun.data.workflowId}`);
  }

  const typedWorkflowDefinition = toWorkflowDefinitionRecord(workflowDefinition);
  const stepDef = findStepDefinition(typedWorkflowDefinition, typedStepRun.data.stepId);
  if (!stepDef) {
    throw new Error(`Workflow step definition not found: ${typedStepRun.data.stepId}`);
  }

  const stepRuns = (await listStepRuns(ctx, typedWorkflowRun.id, companyId)).map(toWorkflowStepRunRecord);
  const stepRunsById = new Map(stepRuns.map((candidate) => [candidate.data.stepId, candidate]));
  if (!areStepDependenciesSatisfied(typedWorkflowDefinition, typedStepRun.data.stepId, stepRunsById)) {
    throw new Error(`Dependencies not satisfied for step: ${typedStepRun.data.stepId}`);
  }

  let resumedRun = false;
  if (typedWorkflowRun.data.status !== RUN_STATUSES.running) {
    await updateWorkflowRun(ctx, typedWorkflowRun.id, {
      completedAt: undefined,
      status: RUN_STATUSES.running,
    });
    resumedRun = true;
  }

  if (typedStepRun.data.issueId) {
    await resetWorkflowStepIssueForRerun(
      ctx,
      typedStepRun.data.issueId,
      resolvedCompanyId,
      typedStepRun.data.stepId,
      typedWorkflowRun.data.workflowName,
    );
  }

  const resetStepRun = toWorkflowStepRunRecord(await updateStepRun(ctx, typedStepRun.id, {
    completedAt: undefined,
    startedAt: undefined,
    status: STEP_STATUSES.backlog,
  }));

  if ((stepDef.type ?? "agent") === "tool" && resetStepRun.data.issueId) {
    const reactivatedToolStepRun = await rerunToolStep(
      ctx,
      resetStepRun,
      stepDef,
      typedWorkflowRun.data.workflowName,
      resolvedCompanyId,
    );

    return {
      issueId: reactivatedToolStepRun.data.issueId ?? null,
      resumedRun,
      runId: typedWorkflowRun.id,
      stepId: reactivatedToolStepRun.data.stepId,
      stepRunId: reactivatedToolStepRun.id,
    };
  }

  const reactivatedStepRun = await activateBacklogStep(
    ctx,
    resetStepRun,
    stepDef,
    typedWorkflowRun.data.workflowName,
    resolvedCompanyId,
    {
      parentIssueId: typedWorkflowRun.data.parentIssueId,
      projectId: typedWorkflowDefinition.data.projectId,
      goalId: typedWorkflowDefinition.data.goalId,
      labelIds: typedWorkflowDefinition.data.labelIds as string[] | undefined,
      runLabel: typedWorkflowRun.data.runLabel,
      templateVars: buildWorkflowTemplateVars(typedWorkflowRun, typedWorkflowDefinition),
    },
  );

  return {
    issueId: reactivatedStepRun.data.issueId ?? null,
    resumedRun,
    runId: typedWorkflowRun.id,
    stepId: reactivatedStepRun.data.stepId,
    stepRunId: reactivatedStepRun.id,
  };
}

async function resumeWorkflowRunState(
  ctx: PluginContext,
  runId: string,
  companyId: string,
): Promise<{
    activatedStepIds: string[];
    resumed: boolean;
    runId: string;
  }> {
  const workflowRunRecord = await getWorkflowRun(ctx, runId);
  if (!workflowRunRecord) {
    throw new Error(`Workflow run not found: ${runId}`);
  }

  const typedWorkflowRun = toWorkflowRunRecord(workflowRunRecord);
  const workflowDefinition = await getWorkflowDefinition(ctx, typedWorkflowRun.data.workflowId);
  if (!workflowDefinition) {
    throw new Error(`Workflow definition not found: ${typedWorkflowRun.data.workflowId}`);
  }

  const typedWorkflowDefinition = toWorkflowDefinitionRecord(workflowDefinition);
  const stepRuns = (await listStepRuns(ctx, typedWorkflowRun.id, companyId)).map(toWorkflowStepRunRecord);
  const stepRunsById = new Map(stepRuns.map((candidate) => [candidate.data.stepId, candidate]));

  let resumed = false;
  if (typedWorkflowRun.data.status !== RUN_STATUSES.running) {
    await updateWorkflowRun(ctx, typedWorkflowRun.id, {
      completedAt: undefined,
      status: RUN_STATUSES.running,
    });
    resumed = true;
  }

  const candidateStatuses = new Set<WorkflowStepRun["status"]>([
    STEP_STATUSES.failed,
    STEP_STATUSES.backlog,
    STEP_STATUSES.todo,
    STEP_STATUSES.inProgress,
    STEP_STATUSES.escalated,
  ]);

  const failedCandidates = stepRuns.filter(
    (candidate) =>
      candidate.data.status === STEP_STATUSES.failed
      && areStepDependenciesSatisfied(typedWorkflowDefinition, candidate.data.stepId, stepRunsById),
  );

  const activationCandidates = (failedCandidates.length > 0
    ? failedCandidates
    : stepRuns.filter(
      (candidate) =>
        candidateStatuses.has(candidate.data.status)
        && areStepDependenciesSatisfied(typedWorkflowDefinition, candidate.data.stepId, stepRunsById),
    ))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  const activatedStepIds: string[] = [];
  for (const candidate of activationCandidates) {
    const rerunResult = await rerunWorkflowStep(ctx, {
      companyId,
      stepRunId: candidate.id,
    });
    activatedStepIds.push(rerunResult.stepId);
  }

  if (activatedStepIds.length === 0) {
    throw new Error("No resumable steps found for workflow run");
  }

  return {
    activatedStepIds,
    resumed,
    runId: typedWorkflowRun.id,
  };
}

async function startWorkflow(
  ctx: PluginContext,
  workflowId: string,
  companyId: string,
  options?: {
    createParentIssue?: boolean;
    missionId?: string;
    parentIssueId?: string;
    createParentIssuePolicy?: unknown;
    triggerSource?: WorkflowRun["triggerSource"];
  },
): Promise<{
  activatedStepIds: string[];
  parentIssueId: string | null;
  runId: string;
  workflowId: string;
}> {
  const workflowDefinition = await getWorkflowDefinition(ctx, workflowId);
  if (!workflowDefinition) {
    throw new Error(`Workflow definition not found: ${workflowId}`);
  }

  const typedWorkflowDefinition = toWorkflowDefinitionRecord(workflowDefinition);
  if (typedWorkflowDefinition.data.companyId !== companyId) {
    throw new Error(`Workflow does not belong to company: ${workflowId}`);
  }

  // Build run label with date + daily run number
  const now = new Date();
  const timezone = typeof typedWorkflowDefinition.data.timezone === "string"
    ? typedWorkflowDefinition.data.timezone.trim()
    : "";
  const dateStr = formatDateKeyInTimezone(now, timezone || undefined) ?? now.toISOString().slice(0, 10);
  const existingRuns = await listWorkflowRunsByWorkflowId(ctx, companyId, workflowId);
  const todayRuns = existingRuns.filter((r: PluginEntityRecord) => {
    const started = (r.data as Record<string, unknown>).startedAt;
    if (typeof started !== "string") {
      return false;
    }
    const startedAt = Date.parse(started);
    if (!Number.isFinite(startedAt)) {
      return false;
    }
    return formatDateKeyInTimezone(new Date(startedAt), timezone || undefined) === dateStr;
  });
  const runNumber = todayRuns.length + 1;
  const runLabel = `#${dateStr}-${runNumber}`;
  const templateVars: Record<string, string> = {
    date: dateStr,
    runNumber: String(runNumber),
    runLabel,
    workflowName: typedWorkflowDefinition.data.name,
  };

  const agents = await ctx.agents.list({ companyId });
  const missionOwnerAgentId = resolveWorkflowMissionOwnerAgentId(typedWorkflowDefinition, agents);
  const missionId = typeof options?.missionId === "string" && options.missionId.trim()
    ? options.missionId.trim()
    : await createWorkflowMissionViaApi(
      companyId,
      missionOwnerAgentId,
      typedWorkflowDefinition.data.name,
      dateStr,
    );

  let parentIssueId = typeof options?.parentIssueId === "string" && options.parentIssueId.trim()
    ? options.parentIssueId.trim()
    : "";
  const shouldCreateParentIssue = shouldCreateParentIssueForRun({
    explicitCreateParentIssue: options && "createParentIssue" in options ? options.createParentIssue : undefined,
    policy: options?.createParentIssuePolicy ?? typedWorkflowDefinition.data.createParentIssuePolicy,
    stepCount: typedWorkflowDefinition.data.steps.length,
  });
  if (!parentIssueId && shouldCreateParentIssue) {
    const parentIssue = await createIssueWithLabels(ctx, {
      assigneeAgentId: missionOwnerAgentId,
      companyId,
      description: typedWorkflowDefinition.data.description || `Workflow run: ${typedWorkflowDefinition.data.name}`,
      goalId: typedWorkflowDefinition.data.goalId || undefined,
      originKind: "mission_main_executor_oversight",
      projectId: typedWorkflowDefinition.data.projectId || undefined,
      status: "backlog",
      title: `[Oversight] ${typedWorkflowDefinition.data.name} ${runLabel}`,
      missionId,
    }, typedWorkflowDefinition.data.labelIds as string[] | undefined);
    parentIssueId = parentIssue.id;
  }
  if (parentIssueId) {
    await ensureIssueLabels(
      ctx,
      parentIssueId,
      companyId,
      typedWorkflowDefinition.data.labelIds as string[] | undefined,
    );
  }

  const workflowRun = toWorkflowRunRecord(await createWorkflowRun(ctx, {
    companyId,
    missionId,
    parentIssueId: parentIssueId || undefined,
    runLabel,
    runDate: dateStr,
    runNumber,
    startedAt: new Date().toISOString(),
    status: RUN_STATUSES.running,
    triggerSource: options?.triggerSource,
    workflowId: typedWorkflowDefinition.id,
    workflowName: typedWorkflowDefinition.data.name,
  }));

  const agentsByName = new Map<string, AgentRecord>();
  for (const agent of agents) {
    agentsByName.set(agent.name, agent);
  }

  const pendingRootSteps: Array<{ stepDef: WorkflowStep; stepRun: WorkflowStepRunRecord }> = [];
  for (const stepDef of typedWorkflowDefinition.data.steps) {
    const agentNameHint = getStepAgentNameHint(stepDef);
    const matchedAgent = agentNameHint ? agentsByName.get(agentNameHint) ?? null : null;
    const resolvedAgent = matchedAgent
      ? { agentId: matchedAgent.id, agentName: matchedAgent.name }
      : await resolveStepAgent(ctx, companyId, stepDef, agentNameHint ?? undefined);

    if (!resolvedAgent.agentName && (stepDef.type ?? "agent") === "agent") {
      throw new Error(`Unable to resolve step assignee for "${stepDef.id}"`);
    }

    const stepRun = toWorkflowStepRunRecord(await createStepRun(ctx, companyId, {
      agentName: resolvedAgent.agentName ?? "system",
      retryCount: 0,
      runId: workflowRun.id,
      status: STEP_STATUSES.backlog,
      stepId: stepDef.id,
    }));

    if (stepDef.dependsOn.length === 0 && stepDef.triggerOn !== "escalation") {
      pendingRootSteps.push({ stepDef, stepRun });
    }
  }

  const activatedStepIds: string[] = [];
  for (const pending of pendingRootSteps) {
    await activateBacklogStep(
      ctx,
      pending.stepRun,
      pending.stepDef,
      typedWorkflowDefinition.data.name,
      companyId,
      {
        parentIssueId: parentIssueId || undefined,
        missionId,
        runLabel,
        templateVars,
        projectId: typedWorkflowDefinition.data.projectId,
        goalId: typedWorkflowDefinition.data.goalId,
        labelIds: typedWorkflowDefinition.data.labelIds as string[] | undefined,
      },
    );
    activatedStepIds.push(pending.stepDef.id);
  }

  ctx.logger.info("Started workflow run", {
    activatedStepIds,
    companyId,
    parentIssueId: parentIssueId || null,
    runLabel,
    runId: workflowRun.id,
    workflowId: typedWorkflowDefinition.id,
    workflowName: typedWorkflowDefinition.data.name,
  });

  return {
    activatedStepIds,
    parentIssueId: parentIssueId || null,
    runId: workflowRun.id,
    workflowId: typedWorkflowDefinition.id,
  };
}

async function advanceWorkflow(
  ctx: PluginContext,
  stepRunRecord: PluginEntityRecord,
  companyId: string,
): Promise<void> {
  const completedStepRun = toWorkflowStepRunRecord(stepRunRecord);
  const advanceKey = buildAdvanceWorkflowIdempotencyKey(completedStepRun.data.runId, completedStepRun.id);

  if (inflightAdvanceWorkflowKeys.has(advanceKey)) {
    ctx.logger.info("Skipped duplicate in-flight advanceWorkflow", {
      companyId,
      runId: completedStepRun.data.runId,
      stepId: completedStepRun.data.stepId,
      stepRunId: completedStepRun.id,
    });
    return;
  }

  if (await checkIdempotency(ctx, advanceKey, companyId)) {
    ctx.logger.info("Skipped already-processed advanceWorkflow", {
      companyId,
      runId: completedStepRun.data.runId,
      stepId: completedStepRun.data.stepId,
      stepRunId: completedStepRun.id,
    });
    return;
  }

  inflightAdvanceWorkflowKeys.add(advanceKey);

  try {
  const workflowRun = await getWorkflowRun(ctx, completedStepRun.data.runId);

  if (!workflowRun) {
    ctx.logger.warn("Workflow run not found while advancing workflow", {
      companyId,
      runId: completedStepRun.data.runId,
      stepId: completedStepRun.data.stepId,
    });
    return;
  }

  const typedWorkflowRun = toWorkflowRunRecord(workflowRun);
  if (typedWorkflowRun.data.status !== RUN_STATUSES.running) {
    return;
  }

  const workflowDefinition = await getWorkflowDefinition(ctx, typedWorkflowRun.data.workflowId);
  if (!workflowDefinition) {
    ctx.logger.warn("Workflow definition not found while advancing workflow", {
      companyId,
      runId: typedWorkflowRun.id,
      stepId: completedStepRun.data.stepId,
      workflowId: typedWorkflowRun.data.workflowId,
    });
    return;
  }

  const typedWorkflowDefinition = toWorkflowDefinitionRecord(workflowDefinition);
  const stepRuns = (await listStepRuns(ctx, typedWorkflowRun.id, companyId)).map(toWorkflowStepRunRecord);
  const completed = new Set<string>();
  const failed = new Set<string>();
  const skipped = new Set<string>();

  for (const candidate of stepRuns) {
    if (candidate.data.status === STEP_STATUSES.done) {
      completed.add(candidate.data.stepId);
      continue;
    }

    if (candidate.data.status === STEP_STATUSES.failed) {
      failed.add(candidate.data.stepId);
      continue;
    }

    if (candidate.data.status === STEP_STATUSES.skipped) {
      skipped.add(candidate.data.stepId);
    }
  }

  const nextSteps = getNextSteps(
    typedWorkflowDefinition.data.steps,
    completed,
    failed,
    skipped,
  );
  const stepRunsById = new Map(stepRuns.map((candidate) => [candidate.data.stepId, candidate]));

  for (const stepId of nextSteps.readyStepIds) {
    const stepDef = findStepDefinition(typedWorkflowDefinition, stepId);
    if (!stepDef) {
      ctx.logger.warn("Ready workflow step definition not found", {
        companyId,
        runId: typedWorkflowRun.id,
        stepId,
      });
      continue;
    }

    let stepRun = stepRunsById.get(stepId) ?? null;
    if (!stepRun) {
      const resolvedAgent = await resolveStepAgent(ctx, companyId, stepDef);
      if (!resolvedAgent.agentName) {
        ctx.logger.warn("Unable to create missing step run without agent assignment", {
          companyId,
          runId: typedWorkflowRun.id,
          stepId,
        });
        continue;
      }

      stepRun = toWorkflowStepRunRecord(await createStepRun(ctx, companyId, {
        agentName: resolvedAgent.agentName,
        retryCount: 0,
        runId: typedWorkflowRun.id,
        status: STEP_STATUSES.backlog,
        stepId,
      }));
      stepRunsById.set(stepId, stepRun);
    }

    await activateBacklogStep(
      ctx,
      stepRun,
      stepDef,
      typedWorkflowRun.data.workflowName,
      companyId,
      {
        parentIssueId: typedWorkflowRun.data.parentIssueId,
        projectId: typedWorkflowDefinition.data.projectId,
        goalId: typedWorkflowDefinition.data.goalId,
        labelIds: typedWorkflowDefinition.data.labelIds as string[] | undefined,
        runLabel: typedWorkflowRun.data.runLabel,
        templateVars: {
          date: resolveWorkflowRunDate(typedWorkflowRun, typedWorkflowDefinition),
          runNumber: resolveWorkflowRunNumber(typedWorkflowRun),
          runLabel: typedWorkflowRun.data.runLabel ?? "",
          workflowName: typedWorkflowRun.data.workflowName,
        },
      },
    );
  }

  if (!nextSteps.isWorkflowComplete || (typedWorkflowRun.data.status as string) === RUN_STATUSES.completed) {
    await markIdempotency(ctx, advanceKey, companyId);
    return;
  }

  await updateWorkflowRun(ctx, typedWorkflowRun.id, {
    completedAt: typedWorkflowRun.data.completedAt ?? new Date().toISOString(),
    status: RUN_STATUSES.completed,
  });

  const parentIssueId = typeof typedWorkflowRun.data.parentIssueId === "string"
    ? typedWorkflowRun.data.parentIssueId.trim()
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
            `Workflow \`${typedWorkflowRun.data.workflowName}\` finished successfully.`,
            `Run: \`${typedWorkflowRun.data.runLabel ?? typedWorkflowRun.id}\``,
          ].join("\n"),
          companyId,
        );
      }
    } catch (error) {
      ctx.logger.warn("Failed to mark workflow parent issue done during completion", {
        companyId,
        error: summarizeError(error),
        parentIssueId,
        runId: typedWorkflowRun.id,
      });
    }
  }

  ctx.logger.info("Workflow completed", {
    companyId,
    runId: typedWorkflowRun.id,
    workflowId: typedWorkflowRun.data.workflowId,
    workflowName: typedWorkflowRun.data.workflowName,
  });
  await markIdempotency(ctx, advanceKey, companyId);
  } finally {
    inflightAdvanceWorkflowKeys.delete(advanceKey);
  }
}

async function activateEscalationStep(
  ctx: PluginContext,
  workflowRun: WorkflowRunRecord,
  workflowDefinition: WorkflowDefinitionRecord,
  sourceStepRun: WorkflowStepRunRecord,
  escalationTargetId: string,
  companyId: string,
): Promise<void> {
  const escalationStep = findStepDefinition(workflowDefinition, escalationTargetId);
  if (!escalationStep) {
    throw new Error(`Escalation target step not found: ${escalationTargetId}`);
  }

  const stepRuns = (await listStepRuns(ctx, workflowRun.id, companyId)).map(toWorkflowStepRunRecord);
  let escalationStepRun = stepRuns.find((candidate) => candidate.data.stepId === escalationTargetId) ?? null;
  const resolvedAgent = await resolveStepAgent(
    ctx,
    companyId,
    escalationStep,
    escalationStepRun?.data.agentName,
  );

  if (!resolvedAgent.agentName) {
    throw new Error(`Escalation target step "${escalationTargetId}" has no resolvable agent`);
  }

  if (!escalationStepRun) {
    escalationStepRun = toWorkflowStepRunRecord(await createStepRun(ctx, companyId, {
      agentName: resolvedAgent.agentName,
      retryCount: 0,
      runId: workflowRun.id,
      status: STEP_STATUSES.backlog,
      stepId: escalationTargetId,
    }));
  }

  if (!escalationStepRun.data.issueId) {
    const issue = await createIssueWithLabels(ctx, {
      assigneeAgentId: resolvedAgent.agentId ?? undefined,
      companyId,
      description: [
        getStepDescription(escalationStep),
        `Escalated from workflow "${workflowRun.data.workflowName}" step "${sourceStepRun.data.stepId}".`,
        sourceStepRun.data.issueId ? `Origin issue: ${sourceStepRun.data.issueId}.` : undefined,
      ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join("\n\n"),
      parentId: workflowRun.data.parentIssueId ?? sourceStepRun.data.issueId,
      title: `${workflowRun.data.workflowName}: ${escalationStep.title}`,
    }, workflowDefinition.data.labelIds as string[] | undefined);

    escalationStepRun = toWorkflowStepRunRecord(await updateStepRun(ctx, escalationStepRun.id, {
      issueId: issue.id,
    }));
  }
  if (escalationStepRun.data.issueId) {
    await ensureIssueLabels(
      ctx,
      escalationStepRun.data.issueId,
      companyId,
      workflowDefinition.data.labelIds as string[] | undefined,
    );
  }

  const shouldActivate = escalationStepRun.data.status === STEP_STATUSES.backlog;
  if (shouldActivate) {
    escalationStepRun = toWorkflowStepRunRecord(await updateStepRun(ctx, escalationStepRun.id, {
      status: STEP_STATUSES.todo,
    }));
  }

  if (shouldActivate) {
    await invokeAgentForStep(
      ctx,
      escalationStepRun,
      escalationStep,
      workflowRun.data.workflowName,
      companyId,
    );
  }
}

async function handleStepFailureEvent(
  ctx: PluginContext,
  event: PluginEvent,
  options: { allowRetry: boolean },
): Promise<void> {
  const idempotencyKey = buildIdempotencyKey(event);
  if (await checkIdempotency(ctx, idempotencyKey, event.companyId)) {
    return;
  }

  const payload = event.payload as { issueId?: string };
  const issueId = typeof payload.issueId === "string" && payload.issueId.trim()
    ? payload.issueId.trim()
    : "";

  if (!issueId) {
    return;
  }

  const stepRunRecord = await findStepRunByIssueId(ctx, issueId, event.companyId);
  if (!stepRunRecord) {
    return;
  }

  const typedStepRun = toWorkflowStepRunRecord(stepRunRecord);
  if (TERMINAL_STEP_STATUSES.has(typedStepRun.data.status)) {
    return;
  }

  const workflowRun = await getWorkflowRun(ctx, typedStepRun.data.runId);
  if (!workflowRun) {
    ctx.logger.warn("Workflow run not found for failed step", {
      companyId: event.companyId,
      issueId,
      runId: typedStepRun.data.runId,
      stepId: typedStepRun.data.stepId,
    });
    return;
  }

  const typedWorkflowRun = toWorkflowRunRecord(workflowRun);
  if (typedWorkflowRun.data.status !== RUN_STATUSES.running) {
    return;
  }

  const workflowDefinition = await getWorkflowDefinition(ctx, typedWorkflowRun.data.workflowId);
  if (!workflowDefinition) {
    ctx.logger.warn("Workflow definition not found for failed step", {
      companyId: event.companyId,
      issueId,
      runId: typedWorkflowRun.id,
      stepId: typedStepRun.data.stepId,
      workflowId: typedWorkflowRun.data.workflowId,
    });
    return;
  }

  const typedWorkflowDefinition = toWorkflowDefinitionRecord(workflowDefinition);
  const stepDef = findStepDefinition(typedWorkflowDefinition, typedStepRun.data.stepId);
  if (!stepDef) {
    ctx.logger.warn("Workflow step definition not found for failed step", {
      companyId: event.companyId,
      issueId,
      runId: typedWorkflowRun.id,
      stepId: typedStepRun.data.stepId,
    });
    return;
  }

  if (options.allowRetry) {
    const retryInfo = getRetryInfo(typedWorkflowDefinition.data.steps, typedStepRun.data.stepId);
    if (retryInfo.shouldRetry && typedStepRun.data.retryCount < retryInfo.maxRetries) {
      const retriedStepRun = toWorkflowStepRunRecord(await updateStepRun(ctx, typedStepRun.id, {
        completedAt: undefined,
        retryCount: typedStepRun.data.retryCount + 1,
        status: STEP_STATUSES.todo,
      }));

      await invokeAgentForStep(
        ctx,
        retriedStepRun,
        stepDef,
        typedWorkflowRun.data.workflowName,
        event.companyId,
      );

      await markIdempotency(ctx, idempotencyKey, event.companyId);
      ctx.logger.info("Retried workflow step after agent run failure", {
        companyId: event.companyId,
        issueId,
        retryCount: retriedStepRun.data.retryCount,
        runId: typedWorkflowRun.id,
        stepId: typedStepRun.data.stepId,
      });
      return;
    }
  }

  if (stepDef.onFailure === "skip") {
    const skippedStepRun = toWorkflowStepRunRecord(await updateStepRun(ctx, typedStepRun.id, {
      completedAt: new Date().toISOString(),
      status: STEP_STATUSES.skipped,
    }));

    await syncWorkflowStepIssueStatus(ctx, event, "done");
    await advanceWorkflow(ctx, skippedStepRun, event.companyId);
    await markIdempotency(ctx, idempotencyKey, event.companyId);
    ctx.logger.info("Skipped workflow step after agent run failure", {
      companyId: event.companyId,
      issueId,
      runId: typedWorkflowRun.id,
      stepId: typedStepRun.data.stepId,
    });
    return;
  }

  if (stepDef.onFailure === "abort_workflow") {
    await updateStepRun(ctx, typedStepRun.id, {
      completedAt: new Date().toISOString(),
      status: STEP_STATUSES.failed,
    });
    await updateWorkflowRun(ctx, typedWorkflowRun.id, {
      completedAt: typedWorkflowRun.data.completedAt ?? new Date().toISOString(),
      status: RUN_STATUSES.aborted,
    });
    await markWorkflowParentIssueTerminal(
      ctx,
      typedWorkflowRun,
      event.companyId,
      "cancelled",
      buildWorkflowParentIssueTerminalComment({
        workflowRun: typedWorkflowRun,
        status: "cancelled",
        failedBy: "agent_failure",
        stepId: typedStepRun.data.stepId,
        reason: `The workflow parent oversight issue was marked cancelled because step ${typedStepRun.data.stepId} failed and the workflow policy is abort_workflow.`,
      }),
    );
    await syncWorkflowStepIssueStatus(
      ctx,
      event,
      event.eventType === "agent.run.cancelled" ? "cancelled" : "blocked",
      {
        comment: [
          "### Workflow step status updated by workflow engine",
          "",
          `The agent run ${event.eventType === "agent.run.cancelled" ? "was cancelled" : "failed"} for this step.`,
          "The workflow engine marked this issue terminal so the workflow does not hang on an open task.",
        ].join("\n"),
      },
    );
    await markIdempotency(ctx, idempotencyKey, event.companyId);
    ctx.logger.warn("Aborted workflow after agent run failure", {
      companyId: event.companyId,
      issueId,
      runId: typedWorkflowRun.id,
      stepId: typedStepRun.data.stepId,
    });
    return;
  }

  if (stepDef.onFailure === "escalate") {
    const escalationTargetId = getEscalationTarget(
      typedWorkflowDefinition.data.steps,
      typedStepRun.data.stepId,
    );

    if (!escalationTargetId) {
      await updateStepRun(ctx, typedStepRun.id, {
        completedAt: new Date().toISOString(),
        status: STEP_STATUSES.failed,
      });
      await updateWorkflowRun(ctx, typedWorkflowRun.id, {
        completedAt: typedWorkflowRun.data.completedAt ?? new Date().toISOString(),
        status: RUN_STATUSES.failed,
      });
      await markIdempotency(ctx, idempotencyKey, event.companyId);
      ctx.logger.warn("Escalation target missing; workflow marked failed", {
        companyId: event.companyId,
        issueId,
        runId: typedWorkflowRun.id,
        stepId: typedStepRun.data.stepId,
      });
      return;
    }

    const escalatedStepRun = toWorkflowStepRunRecord(await updateStepRun(ctx, typedStepRun.id, {
      completedAt: new Date().toISOString(),
      status: STEP_STATUSES.escalated,
    }));

    await activateEscalationStep(
      ctx,
      typedWorkflowRun,
      typedWorkflowDefinition,
      escalatedStepRun,
      escalationTargetId,
      event.companyId,
    );

    await syncWorkflowStepIssueStatus(ctx, event, "blocked", {
      comment: [
        "### Workflow step status updated by workflow engine",
        "",
        "This step was escalated to a downstream workflow step.",
        "The original issue is now blocked to reflect the handoff.",
      ].join("\n"),
    });

    await markIdempotency(ctx, idempotencyKey, event.companyId);
    ctx.logger.warn("Escalated workflow step after agent run failure", {
      companyId: event.companyId,
      escalationTargetId,
      issueId,
      runId: typedWorkflowRun.id,
      stepId: typedStepRun.data.stepId,
    });
    return;
  }

  await updateStepRun(ctx, typedStepRun.id, {
    completedAt: new Date().toISOString(),
    status: STEP_STATUSES.failed,
  });
  await updateWorkflowRun(ctx, typedWorkflowRun.id, {
    completedAt: typedWorkflowRun.data.completedAt ?? new Date().toISOString(),
    status: RUN_STATUSES.failed,
  });
  await syncWorkflowStepIssueStatus(ctx, event, event.eventType === "agent.run.cancelled" ? "cancelled" : "blocked", {
    comment: [
      "### Workflow step status updated by workflow engine",
      "",
      `The agent run ${event.eventType === "agent.run.cancelled" ? "was cancelled" : "failed"} and the step has no recovery policy.`,
      "The issue was marked terminal so the workflow can surface the blocker explicitly.",
    ].join("\n"),
  });
  await markIdempotency(ctx, idempotencyKey, event.companyId);

  ctx.logger.warn("Workflow step failed without recovery policy", {
    companyId: event.companyId,
    issueId,
    runId: typedWorkflowRun.id,
    stepId: typedStepRun.data.stepId,
  });
}

async function handleToolExecutionResultPayload(
  ctx: PluginContext,
  payload: Record<string, unknown>,
  companyId: string,
): Promise<void> {
  let toolResultKey = "";
  try {
    const stepRunId = typeof payload.stepRunId === "string" ? payload.stepRunId.trim() : "";
    const success = payload.success === true;
    const requestId = typeof payload.requestId === "string" ? payload.requestId.trim() : "";
    const toolName = typeof payload.toolName === "string" ? payload.toolName : "";

    if (!stepRunId) {
      ctx.logger.warn("tool-execution-result missing stepRunId", { payload });
      return;
    }

    toolResultKey = buildToolResultIdempotencyKey(stepRunId, success, requestId);
    if (inflightToolResultKeys.has(toolResultKey)) {
      ctx.logger.info("Skipped duplicate in-flight tool result event", {
        companyId,
        stepRunId,
        success,
        toolName,
      });
      return;
    }
    inflightToolResultKeys.add(toolResultKey);

    if (await checkIdempotency(ctx, toolResultKey, companyId)) {
      ctx.logger.info("Skipped already-processed tool result event", {
        companyId,
        stepRunId,
        success,
        toolName,
      });
      return;
    }

    const stepRunRecord = await getStepRun(ctx, stepRunId);
    if (!stepRunRecord) {
      ctx.logger.warn("Step run not found for tool result", { stepRunId });
      return;
    }

    const typedStepRun = toWorkflowStepRunRecord(stepRunRecord);
    if (TERMINAL_STEP_STATUSES.has(typedStepRun.data.status)) {
      await markIdempotency(ctx, toolResultKey, companyId);
      return;
    }

    const nextStatus = success ? STEP_STATUSES.done : STEP_STATUSES.failed;
    const completedAt = new Date().toISOString();
    const updatedStepRun = toWorkflowStepRunRecord(await updateStepRun(ctx, stepRunId, {
      completedAt,
      status: nextStatus as WorkflowStepRun["status"],
    }));

    ctx.logger.info("Tool step completed from execution result", {
      companyId,
      stepId: updatedStepRun.data.stepId,
      stepRunId,
      success,
      toolName,
    });

    if (updatedStepRun.data.issueId) {
      const duration = formatDuration(updatedStepRun.data.startedAt, completedAt);
      const statusLabel = success ? "completed" : "failed";
      const errorSummary = typeof payload.error === "string" && payload.error.trim()
        ? payload.error.trim().split("\n")[0]
        : "";
      const stdoutExcerpt = buildTextExcerpt(payload.stdout);
      const stderrExcerpt = buildTextExcerpt(payload.stderr);

      // Safely extract retryable metadata from payload.data if present
      const payloadData = (typeof payload.data === "object" && payload.data !== null && !Array.isArray(payload.data))
        ? payload.data as Record<string, unknown>
        : null;
      const retryable = typeof (payloadData?.retryable) === "boolean" ? payloadData.retryable : null;
      const retryAfterSeconds = (typeof (payloadData?.retryAfterSeconds) === "number" && Number.isFinite(payloadData.retryAfterSeconds))
        ? payloadData.retryAfterSeconds as number
        : null;

      try {
        await ctx.issues.createComment(
          updatedStepRun.data.issueId,
          [
            `### Tool ${statusLabel}: ${toolName}`,
            `- Step: ${updatedStepRun.data.stepId}`,
            `- Completed at: ${completedAt}`,
            `- Duration: ${duration}`,
            `- Exit code: ${payload.exitCode ?? "N/A"}`,
            ...(errorSummary ? [`- Error: ${errorSummary}`] : []),
            ...(retryable !== null ? [`- Retryable: ${retryable}`] : []),
            ...(retryAfterSeconds !== null ? [`- Retry after: ${retryAfterSeconds}s`] : []),
            ...(stdoutExcerpt ? ["", "#### stdout", "```", stdoutExcerpt, "```"] : []),
            ...(stderrExcerpt ? ["", "#### stderr", "```", stderrExcerpt, "```"] : []),
          ].join("\n"),
          companyId,
        );
      } catch (commentError) {
        ctx.logger.warn("Failed to post workflow tool completion comment", {
          companyId,
          error: summarizeError(commentError),
          issueId: updatedStepRun.data.issueId,
          stepId: updatedStepRun.data.stepId,
          toolName,
        });
      }
    }

    if (success) {
      const issueSyncResult = await syncWorkflowStepIssueStatusFromStepRun(
        ctx,
        updatedStepRun,
        companyId,
        "done",
      );
      if (issueSyncResult.completed) {
        ctx.logger.info("Auto-completed workflow step issue from tool execution result", {
          companyId,
          issueId: issueSyncResult.issueId,
          stepId: issueSyncResult.stepId,
        });
      }

      await advanceWorkflow(ctx, updatedStepRun, companyId);
    } else {
      const workflowRun = await getWorkflowRun(ctx, typedStepRun.data.runId);
      if (workflowRun) {
        const typedRun = toWorkflowRunRecord(workflowRun);
        const workflowDef = await getWorkflowDefinition(ctx, typedRun.data.workflowId);
        if (workflowDef) {
          const typedDef = toWorkflowDefinitionRecord(workflowDef);
          const stepDef = findStepDefinition(typedDef, updatedStepRun.data.stepId);
          const policy = stepDef?.onFailure ?? "abort_workflow";
          if (policy === "skip") {
            await updateStepRun(ctx, stepRunId, { status: STEP_STATUSES.skipped as WorkflowStepRun["status"] });
            await advanceWorkflow(ctx, updatedStepRun, companyId);
          } else {
            await updateWorkflowRun(ctx, typedRun.id, {
              completedAt: new Date().toISOString(),
              status: policy === "abort_workflow" ? RUN_STATUSES.aborted : RUN_STATUSES.failed,
            });
            if (policy === "abort_workflow") {
              await markWorkflowParentIssueTerminal(
                ctx,
                typedRun,
                companyId,
                "blocked",
                buildWorkflowParentIssueTerminalComment({
                  workflowRun: typedRun,
                  status: "blocked",
                  failedBy: "tool_failure",
                  stepId: updatedStepRun.data.stepId,
                  reason: `The workflow parent oversight issue was left blocked because tool step ${updatedStepRun.data.stepId} failed and needs owner recovery before the mission can close.`,
                }),
              );
            }
            ctx.logger.warn("Workflow failed due to tool step failure", {
              companyId,
              runId: typedRun.id,
              stepId: updatedStepRun.data.stepId,
              policy,
            });
          }
        }
      }
    }

    await markIdempotency(ctx, toolResultKey, companyId);
  } catch (error) {
    ctx.logger.warn("Failed to handle tool-execution-result", {
      companyId,
      error: summarizeError(error),
    });
  } finally {
    if (toolResultKey) {
      inflightToolResultKeys.delete(toolResultKey);
    }
  }
}

async function runReconciler(ctx: PluginContext): Promise<void> {
  const modulePath = "./reconciler.js";

  try {
    const module = await import(modulePath) as ReconcilerModule;
    if (typeof module.setStartWorkflowFn === "function") {
      module.setStartWorkflowFn(startWorkflow);
    }
    if (typeof module.reconcileStuckSteps !== "function") {
      ctx.logger.warn("Reconciler module does not export reconcileStuckSteps");
      return;
    }

    await module.reconcileStuckSteps(ctx);

    if (typeof module.runScheduledWorkflows === "function") {
      await module.runScheduledWorkflows(ctx);
    }
  } catch (error) {
    ctx.logger.warn("Failed to run workflow reconciler", {
      error: summarizeError(error),
    });
  }
}

async function finalizeWorkflowStepFromIssueId(
  ctx: PluginContext,
  issueId: string,
  companyId: string,
): Promise<{ advanced: boolean; reason?: string; stepId?: string }> {
  const stepRunRecord = await findStepRunByIssueId(ctx, issueId, companyId);
  if (!stepRunRecord) {
    return { advanced: false, reason: "step run not found" };
  }

  const stepRun = toWorkflowStepRunRecord(stepRunRecord);
  if (TERMINAL_STEP_STATUSES.has(stepRun.data.status)) {
    return {
      advanced: false,
      reason: `step already terminal (${stepRun.data.status})`,
      stepId: stepRun.data.stepId,
    };
  }

  const workflowRunRecord = await getWorkflowRun(ctx, stepRun.data.runId);
  if (!workflowRunRecord) {
    return { advanced: false, reason: "workflow run not found", stepId: stepRun.data.stepId };
  }
  const workflowRun = toWorkflowRunRecord(workflowRunRecord);
  const workflowDefinitionRecord = await getWorkflowDefinition(ctx, workflowRun.data.workflowId);
  if (!workflowDefinitionRecord) {
    return { advanced: false, reason: "workflow definition not found", stepId: stepRun.data.stepId };
  }
  const workflowDefinition = toWorkflowDefinitionRecord(workflowDefinitionRecord);
  const stepDef = findStepDefinition(workflowDefinition, stepRun.data.stepId);
  if (!stepDef) {
    return { advanced: false, reason: "workflow step definition not found", stepId: stepRun.data.stepId };
  }
  const artifactValidation = await validateRequiredStepArtifacts(workflowRun, workflowDefinition, stepDef);
  if (!artifactValidation.ok) {
    await ctx.issues.update(issueId, { status: "blocked" } as IssueUpdatePatch, companyId);
    await ctx.issues.createComment(
      issueId,
      [
        "### Required workflow artifact missing",
        `- Step: ${stepRun.data.stepId}`,
        `- Workflow: ${workflowRun.data.workflowName}`,
        `- Required artifact: ${artifactValidation.requiredPath}`,
        "- Result: completion rejected; issue returned to blocked so the main executor can replan/recover.",
      ].join("\n"),
      companyId,
    );
    return { advanced: false, reason: artifactValidation.reason, stepId: stepRun.data.stepId };
  }

  const updatedStepRun = toWorkflowStepRunRecord(await updateStepRun(ctx, stepRun.id, {
    completedAt: new Date().toISOString(),
    status: STEP_STATUSES.done,
  }));

  await advanceWorkflow(ctx, updatedStepRun, companyId);

  return {
    advanced: true,
    stepId: updatedStepRun.data.stepId,
  };
}

function registerDataHandler(
  ctx: PluginContext,
  key: string,
  handler: (params: Record<string, unknown>) => Promise<unknown>,
): void {
  const dataClient = ctx.data as {
    handle?: (handlerKey: string, handlerFn: (params: Record<string, unknown>) => Promise<unknown>) => void;
    register?: (handlerKey: string, handlerFn: (params: Record<string, unknown>) => Promise<unknown>) => void;
  };

  if (typeof dataClient.handle === "function") {
    dataClient.handle(key, handler);
    return;
  }

  if (typeof dataClient.register === "function") {
    dataClient.register(key, handler);
    return;
  }

  throw new Error("Plugin data client does not support handler registration");
}

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      try {
        const idempotencyKey = buildIdempotencyKey(event);
        if (await checkIdempotency(ctx, idempotencyKey, event.companyId)) {
          return;
        }

        const issueId = typeof event.entityId === "string" && event.entityId.trim()
          ? event.entityId.trim()
          : "";
        if (!issueId) {
          return;
        }

        const stepRunRecord = await findStepRunByIssueId(ctx, issueId, event.companyId);
        if (!stepRunRecord) {
          return;
        }

        const stepRun = toWorkflowStepRunRecord(stepRunRecord);
        const payload = event.payload as { status?: string };
        const issueStatus = typeof payload.status === "string" ? payload.status : undefined;

        let nextStepStatus: string | null = null;
        if (issueStatus === "done" || issueStatus === "in_review") {
          nextStepStatus = STEP_STATUSES.done;
        } else if (issueStatus === "in_progress") {
          nextStepStatus = STEP_STATUSES.inProgress;
        }

        if (!nextStepStatus || stepRun.data.status === nextStepStatus) {
          return;
        }

        if (TERMINAL_STEP_STATUSES.has(stepRun.data.status)) {
          return;
        }

        if (nextStepStatus === STEP_STATUSES.done) {
          const workflowRunRecord = await getWorkflowRun(ctx, stepRun.data.runId);
          const workflowRun = workflowRunRecord ? toWorkflowRunRecord(workflowRunRecord) : null;
          const workflowDefinitionRecord = workflowRun
            ? await getWorkflowDefinition(ctx, workflowRun.data.workflowId)
            : null;
          const workflowDefinition = workflowDefinitionRecord ? toWorkflowDefinitionRecord(workflowDefinitionRecord) : null;
          const stepDef = workflowDefinition ? findStepDefinition(workflowDefinition, stepRun.data.stepId) : null;
          if (workflowRun && workflowDefinition && stepDef) {
            const artifactValidation = await validateRequiredStepArtifacts(workflowRun, workflowDefinition, stepDef);
            if (!artifactValidation.ok) {
              await ctx.issues.update(issueId, { status: "blocked" } as IssueUpdatePatch, event.companyId);
              await ctx.issues.createComment(
                issueId,
                [
                  "### Required workflow artifact missing",
                  `- Step: ${stepRun.data.stepId}`,
                  `- Workflow: ${workflowRun.data.workflowName}`,
                  `- Required artifact: ${artifactValidation.requiredPath}`,
                  "- Result: completion rejected; issue returned to blocked so the main executor can replan/recover.",
                ].join("\n"),
                event.companyId,
              );
              await markIdempotency(ctx, idempotencyKey, event.companyId);
              ctx.logger.warn("Required workflow artifact missing; rejected issue completion", {
                companyId: event.companyId,
                issueId,
                requiredPath: artifactValidation.requiredPath,
                runId: stepRun.data.runId,
                stepId: stepRun.data.stepId,
              });
              return;
            }
          }
        }

        const updatedStepRun = toWorkflowStepRunRecord(await updateStepRun(ctx, stepRun.id, {
          completedAt: nextStepStatus === STEP_STATUSES.done ? new Date().toISOString() : undefined,
          startedAt: nextStepStatus === STEP_STATUSES.inProgress
            ? stepRun.data.startedAt ?? new Date().toISOString()
            : stepRun.data.startedAt,
          status: nextStepStatus as WorkflowStepRun["status"],
        }));

        if (updatedStepRun.data.status === STEP_STATUSES.done) {
          await advanceWorkflow(ctx, updatedStepRun, event.companyId);
        }

        await markIdempotency(ctx, idempotencyKey, event.companyId);
        ctx.logger.info("Workflow step run updated from issue event", {
          companyId: event.companyId,
          issueId,
          status: updatedStepRun.data.status,
          stepId: updatedStepRun.data.stepId,
        });
      } catch (error) {
        ctx.logger.warn("Failed to handle issue.updated event", {
          companyId: event.companyId,
          error: summarizeError(error),
          eventId: event.eventId,
        });
      }
    });

    ctx.events.on("issue.created", async (event: PluginEvent) => {
      try {
        const idempotencyKey = buildIdempotencyKey(event);
        if (await checkIdempotency(ctx, idempotencyKey, event.companyId)) {
          return;
        }

        const payload = event.payload as {
          id?: string;
          parentId?: string;
          assigneeAgentId?: string;
        };
        const issueId = typeof event.entityId === "string" && event.entityId.trim()
          ? event.entityId.trim()
          : typeof payload.id === "string" && payload.id.trim()
            ? payload.id.trim()
            : "";

        const parentId = typeof payload.parentId === "string" && payload.parentId.trim()
          ? payload.parentId.trim()
          : "";
        const assigneeAgentId = typeof payload.assigneeAgentId === "string" && payload.assigneeAgentId.trim()
          ? payload.assigneeAgentId.trim()
          : "";

        if (!issueId || parentId || !assigneeAgentId) {
          await markIdempotency(ctx, idempotencyKey, event.companyId);
          return;
        }

        const agent = await ctx.agents.get(assigneeAgentId, event.companyId);
        const metadata = agent?.metadata as Record<string, unknown> | undefined;
        const defaultParentIssueId = typeof metadata?.defaultParentIssueId === "string" && metadata.defaultParentIssueId.trim()
          ? metadata.defaultParentIssueId.trim()
          : "";

        if (!defaultParentIssueId) {
          await markIdempotency(ctx, idempotencyKey, event.companyId);
          return;
        }

        await ctx.issues.update(
          issueId,
          { parentId: defaultParentIssueId } as IssueUpdatePatch,
          event.companyId,
        );
        await markIdempotency(ctx, idempotencyKey, event.companyId);

        ctx.logger.info("parentId filler: populated issue parentId from agent metadata", {
          assigneeAgentId,
          companyId: event.companyId,
          issueId,
          parentId: defaultParentIssueId,
        });
      } catch (error) {
        ctx.logger.warn("Failed to handle issue.created event (parentId filler)", {
          companyId: event.companyId,
          error: summarizeError(error),
          eventId: event.eventId,
        });
      }

      try {
        const fullPayload = event.payload as Record<string, unknown>;
        let labels = extractLabelNames(fullPayload);

        // If no labels in event payload, fetch issue to check labels
        if (labels.length === 0) {
          const triggerIssueId = typeof event.entityId === "string" && event.entityId.trim()
            ? event.entityId.trim()
            : "";
          if (triggerIssueId) {
            try {
              const issue = await ctx.issues.get(triggerIssueId, event.companyId);
              if (issue) {
                labels = extractLabelNames({ labels: (issue as unknown as Record<string, unknown>).labels });
              }
            } catch { /* issue fetch failed, skip */ }
          }
        }

        if (labels.length > 0) {
          const matched = await matchWorkflowTrigger(ctx, event.companyId, labels);
          const triggerIssueId = typeof event.entityId === "string" && event.entityId.trim()
            ? event.entityId.trim()
            : "";
          for (const def of matched) {
            const timezone = typeof def.data.timezone === "string" ? def.data.timezone.trim() : "";
            const dailyGuard = await checkDailyRunGuard(ctx, event.companyId, def.id, new Date(), timezone || undefined);
            if (dailyGuard.blocked) {
              ctx.logger.info("Skipped workflow auto-start from issue label trigger because a same-day run already exists", {
                companyId: event.companyId,
                dayKey: dailyGuard.dayKey,
                existingRunId: dailyGuard.existingRunId,
                existingStatus: dailyGuard.existingStatus,
                issueId: triggerIssueId,
                matchedLabels: labels,
                workflowId: def.id,
                workflowName: def.data.name,
              });
              continue;
            }

            await startWorkflow(ctx, def.id, event.companyId, {
              parentIssueId: triggerIssueId || undefined,
              triggerSource: "label",
            });
            ctx.logger.info("Auto-started workflow from issue label trigger", {
              companyId: event.companyId,
              issueId: triggerIssueId,
              workflowId: def.id,
              workflowName: def.data.name,
              matchedLabels: labels,
            });
          }
        }
      } catch (error) {
        ctx.logger.warn("Failed to handle issue.created event (workflow trigger)", {
          companyId: event.companyId,
          error: summarizeError(error),
          eventId: event.eventId,
        });
      }
    });

    ctx.events.on("agent.run.failed", async (event: PluginEvent) => {
      try {
        await handleStepFailureEvent(ctx, event, { allowRetry: true });
      } catch (error) {
        ctx.logger.warn("Failed to handle agent.run.failed event", {
          companyId: event.companyId,
          error: summarizeError(error),
          eventId: event.eventId,
        });
      }
    });

    ctx.events.on("agent.run.cancelled", async (event: PluginEvent) => {
      try {
        await handleStepFailureEvent(ctx, event, { allowRetry: false });
      } catch (error) {
        ctx.logger.warn("Failed to handle agent.run.cancelled event", {
          companyId: event.companyId,
          error: summarizeError(error),
          eventId: event.eventId,
        });
      }
    });

    ctx.events.on("agent.run.finished", async (event: PluginEvent) => {
      try {
        const idempotencyKey = buildIdempotencyKey(event);
        if (await checkIdempotency(ctx, idempotencyKey, event.companyId)) {
          return;
        }

        const result = await autoCompleteWorkflowStepIssue(ctx, event);
        if (result.completed) {
          ctx.logger.info("Auto-completed workflow step issue from finished agent run", {
            companyId: event.companyId,
            issueId: result.issueId,
            stepId: result.stepId,
          });

          if (result.issueId) {
            const finalizeResult = await finalizeWorkflowStepFromIssueId(ctx, result.issueId, event.companyId);
            if (finalizeResult.advanced) {
              ctx.logger.info("Advanced workflow step directly from finished agent run", {
                companyId: event.companyId,
                issueId: result.issueId,
                stepId: finalizeResult.stepId ?? result.stepId,
              });
            } else {
              ctx.logger.info("Skipped direct workflow advancement from finished agent run", {
                companyId: event.companyId,
                issueId: result.issueId,
                reason: finalizeResult.reason,
                stepId: finalizeResult.stepId ?? result.stepId,
              });
            }
          }
        }

        if (result.completed || (result.reason !== "issue not found" && result.reason !== "missing issueId")) {
          await markIdempotency(ctx, idempotencyKey, event.companyId);
        }
      } catch (error) {
        ctx.logger.warn("Failed to handle agent.run.finished event", {
          companyId: event.companyId,
          error: summarizeError(error),
          eventId: event.eventId,
        });
      }
    });

    const handleToolExecutionResultEvent = async (event: PluginEvent) => {
      const payload = event.payload as Record<string, unknown>;
      await handleToolExecutionResultPayload(ctx, payload, event.companyId);
    };

    ctx.events.on("tool-execution-result" as Parameters<typeof ctx.events.on>[0], handleToolExecutionResultEvent);
    ctx.events.on(
      "plugin.insightflo.tool-registry.tool-execution-result" as Parameters<typeof ctx.events.on>[0],
      handleToolExecutionResultEvent,
    );

    ctx.actions.register("start-workflow", async (rawParams: unknown) => {
      const params = (rawParams && typeof rawParams === "object" ? rawParams : {}) as Record<string, unknown>;
      const workflowId = typeof params.workflowId === "string" ? params.workflowId.trim() : "";
      const companyId = typeof params.companyId === "string" ? params.companyId.trim() : "";
      const createParentIssue = typeof params.createParentIssue === "boolean" ? params.createParentIssue : undefined;
      const createParentIssuePolicy = params.createParentIssuePolicy;
      const missionId = typeof params.missionId === "string" ? params.missionId.trim() : "";
      const parentIssueId = typeof params.parentIssueId === "string" ? params.parentIssueId.trim() : "";
      if (!workflowId || !companyId) {
        throw new Error("start-workflow requires workflowId and companyId");
      }
      return await startWorkflow(ctx, workflowId, companyId, {
        createParentIssue,
        createParentIssuePolicy,
        missionId: missionId || undefined,
        parentIssueId: parentIssueId || undefined,
        triggerSource: "manual",
      });
    });

    ctx.actions.register("update-workflow", async (rawParams: unknown) => {
      const params = (rawParams && typeof rawParams === "object" ? rawParams : {}) as Record<string, unknown>;
      const workflowId = typeof params.workflowId === "string" ? params.workflowId.trim()
        : typeof params.id === "string" ? params.id.trim() : "";
      if (!workflowId) {
        throw new Error("update-workflow requires workflowId");
      }
      const patch: Record<string, unknown> = {};
      const p = params.patch as Record<string, unknown> | undefined;
      const source = p ?? params;
      if (typeof source.name === "string") patch.name = source.name;
      if (typeof source.description === "string") patch.description = source.description;
      if (typeof source.status === "string") patch.status = source.status;
      if (Array.isArray(source.triggerLabels)) patch.triggerLabels = source.triggerLabels.map(String);
      if (Array.isArray(source.labelIds)) patch.labelIds = source.labelIds.map(String);
      if (Array.isArray(source.steps)) patch.steps = source.steps;
      if ("schedule" in source) patch.schedule = typeof source.schedule === "string" ? source.schedule.trim() || undefined : undefined;
      if ("projectId" in source) patch.projectId = typeof source.projectId === "string" ? source.projectId.trim() || undefined : undefined;
      if ("goalId" in source) patch.goalId = typeof source.goalId === "string" ? source.goalId.trim() || undefined : undefined;
      if ("maxDailyRuns" in source) {
        patch.maxDailyRuns = parseOptionalNonNegativeInteger(source.maxDailyRuns);
      }
      if ("timezone" in source) {
        patch.timezone = parseOptionalTrimmedString(source.timezone);
      }
      if ("deadlineTime" in source) {
        patch.deadlineTime = parseOptionalTrimmedString(source.deadlineTime);
      }
      if ("createParentIssuePolicy" in source) {
        patch.createParentIssuePolicy = normalizeCreateParentIssuePolicy(source.createParentIssuePolicy);
      }
      const updated = await updateWorkflowDefinition(ctx, workflowId, patch);
      return { id: updated.id, ...updated.data };
    });

    ctx.actions.register("abort-run", async (rawParams: unknown) => {
      const params = (rawParams && typeof rawParams === "object" ? rawParams : {}) as Record<string, unknown>;
      const runId = typeof params.runId === "string" ? params.runId.trim() : "";
      const companyId = typeof params.companyId === "string" ? params.companyId.trim() : "";
      if (!runId) throw new Error("abort-run requires runId");
      const run = await getWorkflowRun(ctx, runId);
      if (!run) throw new Error(`Run not found: ${runId}`);
      const typedRun = toWorkflowRunRecord(run);
      if (typedRun.data.status !== RUN_STATUSES.running) {
        return { id: runId, status: typedRun.data.status, message: "already terminal" };
      }
      const resolvedCompanyId = companyId || typedRun.data.companyId;
      await abortWorkflowRunState(ctx, runId, resolvedCompanyId);
      return { id: runId, status: "aborted" };
    });

    ctx.actions.register("rerun-step", async (rawParams: unknown) => {
      const params = (rawParams && typeof rawParams === "object" ? rawParams : {}) as Record<string, unknown>;
      const companyId = typeof params.companyId === "string" ? params.companyId.trim() : "";
      const issueId = typeof params.issueId === "string" ? params.issueId.trim() : "";
      const stepRunId = typeof params.stepRunId === "string" ? params.stepRunId.trim() : "";
      if (!companyId || (!issueId && !stepRunId)) {
        throw new Error("rerun-step requires companyId and either issueId or stepRunId");
      }
      return await rerunWorkflowStep(ctx, { companyId, issueId, stepRunId });
    });

    ctx.actions.register("handle-tool-execution-result", async (rawParams: unknown) => {
      const params = (rawParams && typeof rawParams === "object" ? rawParams : {}) as Record<string, unknown>;
      const companyId = typeof params.companyId === "string" ? params.companyId.trim() : "";
      if (!companyId) {
        throw new Error("handle-tool-execution-result requires companyId");
      }

      await handleToolExecutionResultPayload(ctx, params, companyId);
      return { ok: true };
    });

    ctx.actions.register("resume-run", async (rawParams: unknown) => {
      const params = (rawParams && typeof rawParams === "object" ? rawParams : {}) as Record<string, unknown>;
      const runId = typeof params.runId === "string" ? params.runId.trim() : "";
      const companyId = typeof params.companyId === "string" ? params.companyId.trim() : "";
      if (!runId || !companyId) {
        throw new Error("resume-run requires runId and companyId");
      }
      return await resumeWorkflowRunState(ctx, runId, companyId);
    });

    ctx.actions.register("delete-workflow", async (rawParams: unknown) => {
      const params = (rawParams && typeof rawParams === "object" ? rawParams : {}) as Record<string, unknown>;
      const workflowId = typeof params.workflowId === "string" ? params.workflowId.trim()
        : typeof params.id === "string" ? params.id.trim() : "";
      if (!workflowId) {
        throw new Error("delete-workflow requires workflowId");
      }
      const updated = await updateWorkflowDefinition(ctx, workflowId, { status: "archived" });
      return { id: updated.id, status: "archived" };
    });

    ctx.jobs.register(JOB_KEYS.reconciler, async (_job: PluginJobContext) => {
      await runReconciler(ctx);
    });

    registerDataHandler(ctx, "run-reconciler", async (_params: Record<string, unknown>) => {
      await runReconciler(ctx);
      return { ok: true };
    });

    registerDataHandler(ctx, "start-workflow", async (params: Record<string, unknown>) => {
      const workflowId = typeof params.workflowId === "string" ? params.workflowId.trim() : "";
      const companyId = typeof params.companyId === "string" ? params.companyId.trim() : "";
      const missionId = typeof params.missionId === "string" ? params.missionId.trim() : "";
      const parentIssueId = typeof params.parentIssueId === "string" ? params.parentIssueId.trim() : "";
      const createParentIssue = typeof params.createParentIssue === "boolean" ? params.createParentIssue : undefined;
      const createParentIssuePolicy = params.createParentIssuePolicy;

      if (!workflowId || !companyId) {
        throw new Error("start-workflow requires workflowId and companyId");
      }

      return await startWorkflow(ctx, workflowId, companyId, {
        createParentIssue,
        createParentIssuePolicy,
        missionId: missionId || undefined,
        parentIssueId: parentIssueId || undefined,
        triggerSource: "api",
      });
    });

    registerDataHandler(ctx, "rerun-step", async (params: Record<string, unknown>) => {
      const companyId = typeof params.companyId === "string" ? params.companyId.trim() : "";
      const issueId = typeof params.issueId === "string" ? params.issueId.trim() : "";
      const stepRunId = typeof params.stepRunId === "string" ? params.stepRunId.trim() : "";
      if (!companyId || (!issueId && !stepRunId)) {
        throw new Error("rerun-step requires companyId and either issueId or stepRunId");
      }
      return await rerunWorkflowStep(ctx, { companyId, issueId, stepRunId });
    });

    registerDataHandler(ctx, "resume-run", async (params: Record<string, unknown>) => {
      const runId = typeof params.runId === "string" ? params.runId.trim() : "";
      const companyId = typeof params.companyId === "string" ? params.companyId.trim() : "";
      if (!runId || !companyId) {
        throw new Error("resume-run requires runId and companyId");
      }
      return await resumeWorkflowRunState(ctx, runId, companyId);
    });

    registerDataHandler(ctx, "create-workflow", async (params: Record<string, unknown>) => {
      const companyId = typeof params.companyId === "string" ? params.companyId.trim() : "";
      const workflow = params.workflow as Record<string, unknown> | undefined;
      if (!companyId || !workflow) {
        throw new Error("create-workflow requires companyId and workflow");
      }
      const def = {
        name: String(workflow.name ?? ""),
        description: String(workflow.description ?? ""),
        companyId,
        status: (String(workflow.status ?? "active")) as "active" | "paused" | "archived",
        steps: (workflow.steps ?? []) as WorkflowStep[],
        timeoutMinutes: typeof workflow.timeoutMinutes === "number" ? workflow.timeoutMinutes : undefined,
        maxDailyRuns: parseOptionalNonNegativeInteger(workflow.maxDailyRuns),
        maxConcurrentRuns: typeof workflow.maxConcurrentRuns === "number" ? workflow.maxConcurrentRuns : undefined,
        triggerLabels: Array.isArray(workflow.triggerLabels) ? workflow.triggerLabels.map(String) : undefined,
        labelIds: Array.isArray(workflow.labelIds) ? workflow.labelIds.map(String) : undefined,
        schedule: typeof workflow.schedule === "string" ? workflow.schedule.trim() || undefined : undefined,
        timezone: parseOptionalTrimmedString(workflow.timezone),
        deadlineTime: parseOptionalTrimmedString(workflow.deadlineTime),
        projectId: typeof workflow.projectId === "string" ? workflow.projectId.trim() || undefined : undefined,
        goalId: typeof workflow.goalId === "string" ? workflow.goalId.trim() || undefined : undefined,
        createParentIssuePolicy: normalizeCreateParentIssuePolicy(workflow.createParentIssuePolicy),
      };
      const created = await createWorkflowDefinition(ctx, def);
      return { id: created.id, ...def };
    });

    registerDataHandler(ctx, "update-workflow", async (params: Record<string, unknown>) => {
      const workflowId = typeof params.workflowId === "string" ? params.workflowId.trim()
        : typeof params.id === "string" ? params.id.trim() : "";
      const companyId = typeof params.companyId === "string" ? params.companyId.trim() : "";
      if (!workflowId) {
        throw new Error("update-workflow requires workflowId");
      }
      const patch: Record<string, unknown> = {};
      const p = params.patch as Record<string, unknown> | undefined;
      const source = p ?? params;
      if (typeof source.name === "string") patch.name = source.name.trim();
      if (typeof source.description === "string") patch.description = source.description.trim();
      if (typeof source.status === "string") patch.status = source.status.trim();
      if (Array.isArray(source.triggerLabels)) patch.triggerLabels = source.triggerLabels.map(String);
      if (Array.isArray(source.labelIds)) patch.labelIds = source.labelIds.map(String);
      if (Array.isArray(source.steps)) patch.steps = source.steps;
      if ("schedule" in source) patch.schedule = typeof source.schedule === "string" ? source.schedule.trim() || undefined : undefined;
      if ("projectId" in source) patch.projectId = typeof source.projectId === "string" ? source.projectId.trim() || undefined : undefined;
      if ("goalId" in source) patch.goalId = typeof source.goalId === "string" ? source.goalId.trim() || undefined : undefined;
      if ("maxDailyRuns" in source) {
        patch.maxDailyRuns = parseOptionalNonNegativeInteger(source.maxDailyRuns);
      }
      if ("timezone" in source) {
        patch.timezone = parseOptionalTrimmedString(source.timezone);
      }
      if ("deadlineTime" in source) {
        patch.deadlineTime = parseOptionalTrimmedString(source.deadlineTime);
      }
      if ("createParentIssuePolicy" in source) {
        patch.createParentIssuePolicy = normalizeCreateParentIssuePolicy(source.createParentIssuePolicy);
      }
      const updated = await updateWorkflowDefinition(ctx, workflowId, patch);
      return { id: updated.id, ...updated.data };
    });

    registerDataHandler(ctx, "delete-workflow", async (params: Record<string, unknown>) => {
      const workflowId = typeof params.workflowId === "string" ? params.workflowId.trim()
        : typeof params.id === "string" ? params.id.trim() : "";
      if (!workflowId) {
        throw new Error("delete-workflow requires workflowId");
      }
      const updated = await updateWorkflowDefinition(ctx, workflowId, { status: "archived" });
      return { id: updated.id, status: "archived" };
    });

    registerDataHandler(ctx, "workflow-overview", async (params: Record<string, unknown>) => {
      try {
        const companyId = typeof params.companyId === "string" ? params.companyId.trim() : "";
        if (!companyId) {
          return { workflows: [], activeRuns: [], recentRuns: [], projects: [], labels: [] };
        }

        let projectsList: Array<{ id: string; name: string }> = [];
        let labelsList: Array<{ id: string; name: string; color: string }> = [];
        try {
          const apiUrl = getPaperclipApiUrl();
          const res = await fetch(`${apiUrl}/api/companies/${companyId}/projects?limit=200`);
          if (res.ok) {
            const raw = await res.json() as Array<Record<string, unknown>>;
            projectsList = raw.map((p) => ({ id: String(p.id), name: String(p.name ?? p.title ?? p.id) }));
          }
        } catch { /* projects not available */ }
        try {
          const apiUrl = getPaperclipApiUrl();
          const res = await fetch(`${apiUrl}/api/companies/${companyId}/labels`);
          if (res.ok) {
            const raw = await res.json() as Array<Record<string, unknown>>;
            labelsList = raw.map((label) => ({
              id: String(label.id),
              name: String(label.name ?? label.id),
              color: typeof label.color === "string" && label.color.trim() ? label.color : "#6366f1",
            }));
          }
        } catch { /* labels not available */ }

        const [workflowDefinitions, activeRuns, recentRuns] = await Promise.all([
          listWorkflowDefinitions(ctx, companyId),
          listActiveRuns(ctx, companyId),
          listRecentRuns(ctx, companyId, 25),
        ]);

        const serializeRun = async (record: PluginEntityRecord) => {
          const run = toWorkflowRunRecord(record);
          const parentIssueId = typeof run.data.parentIssueId === "string" ? run.data.parentIssueId : "";
          let parentIssueIdentifier: string | undefined;
          if (parentIssueId) {
            try {
              const issue = await ctx.issues.get(parentIssueId, companyId);
              parentIssueIdentifier = (issue as unknown as Record<string, unknown>).identifier as string | undefined;
            } catch { /* issue not found */ }
          }
          return {
            id: run.id,
            ...run.data,
            status: (run.data as Record<string, unknown>).status as string ?? run.status,
            parentIssueIdentifier,
          };
        };

        return {
          projects: projectsList,
          labels: labelsList,
          activeRuns: await Promise.all(activeRuns.map(serializeRun)),
          recentRuns: await Promise.all(recentRuns.map(serializeRun)),
          workflows: workflowDefinitions
            .filter((record) => {
              const data = record.data as Record<string, unknown>;
              const defCompanyId = typeof data.companyId === "string" ? data.companyId.trim() : "";
              return !defCompanyId || defCompanyId === companyId;
            })
            .map((record) => {
              const workflow = toWorkflowDefinitionRecord(record);
              return {
                id: workflow.id,

                ...workflow.data,
                status: (workflow.data as Record<string, unknown>).status as string ?? workflow.status,
              };
            }),
        };
      } catch (error) {
        ctx.logger.warn("Failed to load workflow overview data", {
          error: summarizeError(error),
        });
        return { workflows: [], activeRuns: [], recentRuns: [], projects: [], labels: [] };
      }
    });

    registerDataHandler(ctx, "workflow-run-detail", async (params: Record<string, unknown>) => {
      try {
        const runId = typeof params.runId === "string" ? params.runId.trim() : "";
        if (!runId) {
          return null;
        }

        const workflowRun = await getWorkflowRun(ctx, runId);
        if (!workflowRun) {
          return null;
        }

        const typedWorkflowRun = toWorkflowRunRecord(workflowRun);
        const [workflowDefinition, stepRuns] = await Promise.all([
          getWorkflowDefinition(ctx, typedWorkflowRun.data.workflowId),
          listStepRuns(ctx, typedWorkflowRun.id, typedWorkflowRun.data.companyId),
        ]);
        const typedWorkflowDefinition = workflowDefinition
          ? toWorkflowDefinitionRecord(workflowDefinition)
          : null;
        const stepDefinitionById = new Map(
          (typedWorkflowDefinition?.data.steps ?? []).map((step) => [step.id, step]),
        );
        const serializedStepRuns = await Promise.all(stepRuns.map(async (record: PluginEntityRecord) => {
          const stepRun = toWorkflowStepRunRecord(record);
          const stepDefinition = stepDefinitionById.get(stepRun.data.stepId);
          const issueId = typeof stepRun.data.issueId === "string" ? stepRun.data.issueId.trim() : "";
          let issueIdentifier: string | undefined;
          if (issueId) {
            try {
              const issue = await ctx.issues.get(issueId, typedWorkflowRun.data.companyId);
              issueIdentifier = issue && typeof issue.identifier === "string" ? issue.identifier : undefined;
            } catch {
              issueIdentifier = undefined;
            }
          }

          return {
            ...stepRun.data,
            id: stepRun.id,
            status: stepRun.status,
            stepTitle: stepDefinition?.title ?? stepRun.data.stepId,
            stepType: stepDefinition?.type ?? undefined,
            issueIdentifier,
          };
        }));

        return {
          run: {
            ...typedWorkflowRun.data,
            id: typedWorkflowRun.id,
            status: typedWorkflowRun.status,
          },
          stepRuns: serializedStepRuns,
          workflow: typedWorkflowDefinition
            ? {
              ...typedWorkflowDefinition.data,
              id: typedWorkflowDefinition.id,
              status: typedWorkflowDefinition.status,
            }
            : null,
        };
      } catch (error) {
        ctx.logger.warn("Failed to load workflow run detail data", {
          error: summarizeError(error),
        });
        return null;
      }
    });
  },
});

runWorker(plugin, import.meta.url);

export default plugin;

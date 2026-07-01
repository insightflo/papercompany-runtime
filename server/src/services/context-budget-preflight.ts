import fs from "node:fs/promises";
import path from "node:path";
import { buildPaperclipRuntimeBrief, joinPromptSections, renderTemplate } from "@paperclipai/adapter-utils";
import { buildPaperclipEnv } from "@paperclipai/adapter-utils/server-utils";
import { asBoolean, asNumber, parseObject } from "../adapters/utils.js";

export interface ContextBudgetPreflightPolicy {
  enabled: boolean;
  maxEstimatedChars: number;
  maxEstimatedTokens: number;
}

export interface ContextBudgetEstimate {
  promptTemplateChars: number;
  bootstrapPromptChars: number;
  renderedPromptChars: number;
  renderedBootstrapPromptChars: number;
  instructionsChars: number;
  sessionHandoffChars: number;
  runtimeNoteChars: number;
  estimatedChars: number;
  estimatedTokens: number;
}

export interface ContextBudgetPreflightResult {
  blocked: boolean;
  policy: ContextBudgetPreflightPolicy | null;
  estimate: ContextBudgetEstimate;
  reason: string | null;
}

const DEFAULT_HEARTBEAT_PROMPT =
  "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work. Follow the Paperclip heartbeat procedure exactly. For assignments, use GET /api/agents/me/inbox-lite first. Fall back only to the company issues endpoint filtered by assigneeAgentId with statuses todo,in_progress,blocked. Do not improvise alternate issue query parameters such as status=open, assigneeId, or agentId. Never claim work by PATCHing an issue to in_progress; only POST /api/issues/{issueId}/checkout may move work into in_progress. Do not invent alternate completion routes; use PATCH /api/issues/{issueId} for done/blocked updates and POST /api/issues/{issueId}/release only to give work back. If no assignments are returned, exit the heartbeat.";

export function parseContextBudgetPreflightPolicy(runtimeConfig: unknown): ContextBudgetPreflightPolicy | null {
  const runtime = parseObject(runtimeConfig);
  const heartbeat = parseObject(runtime.heartbeat);
  const raw = parseObject(heartbeat.contextBudgetPreflight);
  if (Object.keys(raw).length === 0) return null;

  const enabled = asBoolean(raw.enabled, true);
  const maxEstimatedChars = Math.max(0, Math.floor(asNumber(raw.maxEstimatedChars, 0)));
  const maxEstimatedTokens = Math.max(0, Math.floor(asNumber(raw.maxEstimatedTokens, 0)));

  if (!enabled) {
    return {
      enabled: false,
      maxEstimatedChars,
      maxEstimatedTokens,
    };
  }

  if (maxEstimatedChars <= 0 && maxEstimatedTokens <= 0) {
    return null;
  }

  return {
    enabled,
    maxEstimatedChars,
    maxEstimatedTokens,
  };
}

function estimateTokensFromChars(chars: number) {
  return Math.ceil(chars / 4);
}

export async function evaluateContextBudgetPreflight(input: {
  runtimeConfig: unknown;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  agent: Record<string, unknown> & { id: string; companyId: string; name?: string | null };
  runId: string;
  context: Record<string, unknown>;
  hasResumableSession: boolean;
  cwd: string;
  authTokenPresent?: boolean;
}): Promise<ContextBudgetPreflightResult> {
  const policy = parseContextBudgetPreflightPolicy(input.runtimeConfig);
  const promptTemplate = String(input.adapterConfig.promptTemplate ?? DEFAULT_HEARTBEAT_PROMPT).trim() || DEFAULT_HEARTBEAT_PROMPT;
  const bootstrapPromptTemplate = String(input.adapterConfig.bootstrapPromptTemplate ?? "").trim();
  const templateData = {
    agentId: input.agent.id,
    companyId: input.agent.companyId,
    runId: input.runId,
    company: { id: input.agent.companyId },
    agent: input.agent,
    run: {
      id: input.runId,
      source: "on_demand",
    },
    context: input.context,
  } satisfies Record<string, unknown>;
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const renderedPiDefaultPrompt = renderTemplate(DEFAULT_HEARTBEAT_PROMPT, templateData);
  const renderedBootstrapPrompt = input.hasResumableSession
    ? ""
    : bootstrapPromptTemplate.length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const instructions = await readInstructionsPayload({
    adapterType: input.adapterType,
    instructionsFilePath:
      typeof input.adapterConfig.instructionsFilePath === "string"
        ? input.adapterConfig.instructionsFilePath
        : null,
    cwd: input.cwd,
    piSystemPromptChars: renderedPiDefaultPrompt.length,
  });
  const runtimeBrief = buildPaperclipRuntimeBrief(input.context);
  const sessionHandoffChars = runtimeBrief.length;
  const promptTemplateChars = promptTemplate.length;
  const bootstrapPromptChars = input.hasResumableSession ? 0 : bootstrapPromptTemplate.length;
  const runtimeNoteChars = estimateRuntimeNoteChars({
    adapterType: input.adapterType,
    agent: input.agent,
    runId: input.runId,
    adapterConfig: input.adapterConfig,
    context: input.context,
    authTokenPresent: input.authTokenPresent ?? false,
  });
  const estimatedChars = estimatePromptChars({
    adapterType: input.adapterType,
    renderedPrompt,
    renderedBootstrapPrompt,
    sessionHandoffChars,
    instructionsChars: instructions.estimatedChars,
    instructionsSystemPromptChars: instructions.systemPromptChars,
    runtimeNoteChars,
  });
  const estimatedTokens = estimateTokensFromChars(estimatedChars);
  const estimate: ContextBudgetEstimate = {
    promptTemplateChars,
    bootstrapPromptChars,
    renderedPromptChars: renderedPrompt.length,
    renderedBootstrapPromptChars: renderedBootstrapPrompt.length,
    instructionsChars: instructions.estimatedChars,
    sessionHandoffChars,
    runtimeNoteChars,
    estimatedChars,
    estimatedTokens,
  };

  if (!policy || !policy.enabled) {
    return {
      blocked: false,
      policy,
      estimate,
      reason: null,
    };
  }

  if (policy.maxEstimatedChars > 0 && estimatedChars > policy.maxEstimatedChars) {
    return {
      blocked: true,
      policy,
      estimate,
      reason: `Estimated prompt context ${estimatedChars} chars exceeds budget ${policy.maxEstimatedChars} chars`,
    };
  }

  if (policy.maxEstimatedTokens > 0 && estimatedTokens > policy.maxEstimatedTokens) {
    return {
      blocked: true,
      policy,
      estimate,
      reason: `Estimated prompt context ${estimatedTokens} tokens exceeds budget ${policy.maxEstimatedTokens} tokens`,
    };
  }

  return {
    blocked: false,
    policy,
    estimate,
    reason: null,
  };
}

async function readInstructionsPayload(input: {
  adapterType: string;
  instructionsFilePath: string | null;
  cwd: string;
  piSystemPromptChars: number;
}) {
  const trimmed = input.instructionsFilePath?.trim() ?? "";
  if (!trimmed) return { estimatedChars: 0, systemPromptChars: 0 };
  const resolvedPath = path.isAbsolute(trimmed) ? trimmed : path.resolve(input.cwd, trimmed);
  try {
    const content = await fs.readFile(resolvedPath, "utf8");
    const dir = `${path.dirname(resolvedPath)}/`;
    const wrapped =
      `${content}\n\n` +
      `The above agent instructions were loaded from ${resolvedPath}. ` +
      `Resolve any relative file references from ${dir}.\n\n`;

    if (input.adapterType === "claude_local") {
      return { estimatedChars: wrapped.length, systemPromptChars: wrapped.length };
    }

    if (input.adapterType === "pi_local") {
      return {
        estimatedChars: wrapped.length,
        systemPromptChars: wrapped.length + input.piSystemPromptChars,
      };
    }

    return { estimatedChars: wrapped.length, systemPromptChars: 0 };
  } catch {
    return { estimatedChars: 0, systemPromptChars: 0 };
  }
}

function estimateRuntimeNoteChars(input: {
  adapterType: string;
  agent: { id: string; companyId: string };
  runId: string;
  adapterConfig: Record<string, unknown>;
  context: Record<string, unknown>;
  authTokenPresent: boolean;
}) {
  const env = buildEstimatedPaperclipEnv(input);
  if (input.adapterType !== "cursor") {
    return 0;
  }

  const paperclipKeys = Object.keys(env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort();
  const runtimeNote = paperclipKeys.length === 0
    ? ""
    : [
        "Paperclip runtime note:",
        `The following PAPERCLIP_* environment variables are available in this run: ${paperclipKeys.join(", ")}`,
        "Do not assume these variables are missing without checking your shell environment.",
        "",
        "",
      ].join("\n");

  return runtimeNote.length;
}

function estimatePromptChars(input: {
  adapterType: string;
  renderedPrompt: string;
  renderedBootstrapPrompt: string;
  sessionHandoffChars: number;
  instructionsChars: number;
  instructionsSystemPromptChars: number;
  runtimeNoteChars: number;
}) {
  if (input.adapterType === "pi_local") {
    return (
      (input.instructionsSystemPromptChars || input.renderedPrompt.length) +
      joinPromptSections([
        input.renderedBootstrapPrompt,
        input.sessionHandoffChars > 0 ? "x".repeat(input.sessionHandoffChars) : "",
        input.renderedPrompt,
      ]).length
    );
  }

  return joinPromptSections([
    input.instructionsChars > 0 ? "x".repeat(input.instructionsChars) : "",
    input.renderedBootstrapPrompt,
    input.sessionHandoffChars > 0 ? "x".repeat(input.sessionHandoffChars) : "",
    input.runtimeNoteChars > 0 ? "x".repeat(input.runtimeNoteChars) : "",
    input.renderedPrompt,
  ]).length;
}

function buildEstimatedPaperclipEnv(input: {
  adapterType: string;
  agent: { id: string; companyId: string };
  runId: string;
  adapterConfig: Record<string, unknown>;
  context: Record<string, unknown>;
  authTokenPresent: boolean;
}) {
  const env: Record<string, string> = {
    ...buildPaperclipEnv(input.agent, { context: input.context }),
    PAPERCLIP_RUN_ID: input.runId,
  };
  const envConfig = parseObject(input.adapterConfig.env);
  const maybe = (key: string, value: unknown) => {
    if (typeof value === "string" && value.trim().length > 0) env[key] = value.trim();
  };
  maybe("PAPERCLIP_TASK_ID", input.context.taskId ?? input.context.issueId);
  maybe("PAPERCLIP_WAKE_REASON", input.context.wakeReason);
  maybe("PAPERCLIP_WAKE_COMMENT_ID", input.context.wakeCommentId ?? input.context.commentId);
  maybe("PAPERCLIP_APPROVAL_ID", input.context.approvalId);
  maybe("PAPERCLIP_APPROVAL_STATUS", input.context.approvalStatus);
  if (Array.isArray(input.context.issueIds) && input.context.issueIds.length > 0) {
    env.PAPERCLIP_LINKED_ISSUE_IDS = input.context.issueIds.filter((v): v is string => typeof v === "string").join(",");
  }
  const workspace = parseObject(input.context.paperclipWorkspace);
  const configuredCwd = typeof input.adapterConfig.cwd === "string" ? input.adapterConfig.cwd.trim() : "";
  const workspaceSource = typeof workspace.source === "string" ? workspace.source.trim() : "";
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  if (!useConfiguredInsteadOfAgentHome) {
    maybe("PAPERCLIP_WORKSPACE_CWD", workspace.cwd);
  }
  maybe("PAPERCLIP_WORKSPACE_SOURCE", workspace.source);
  maybe("PAPERCLIP_WORKSPACE_ID", workspace.workspaceId);
  maybe("PAPERCLIP_WORKSPACE_REPO_URL", workspace.repoUrl);
  maybe("PAPERCLIP_WORKSPACE_REPO_REF", workspace.repoRef);
  maybe("AGENT_HOME", workspace.agentHome);
  if (Array.isArray(input.context.paperclipWorkspaces) && input.context.paperclipWorkspaces.length > 0) {
    env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(input.context.paperclipWorkspaces);
  }
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  if (input.authTokenPresent) {
    env.PAPERCLIP_API_KEY = "token";
  }
  return env;
}

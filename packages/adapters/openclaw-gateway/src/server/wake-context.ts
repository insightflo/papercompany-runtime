import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { buildPaperclipEnv, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { splitOpenClawAgentParams } from "./agent-params.js";

export type OpenClawWakePayload = {
  runId: string;
  agentId: string;
  companyId: string;
  taskId: string | null;
  issueId: string | null;
  wakeReason: string | null;
  wakeCommentId: string | null;
  approvalId: string | null;
  approvalStatus: string | null;
  issueIds: string[];
};

export type OpenClawWakeContext = {
  wakePayload: OpenClawWakePayload;
  wakeText: string;
  paperclipEnv: Record<string, string>;
  payloadTemplate: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function buildWakePayload(ctx: AdapterExecutionContext): OpenClawWakePayload {
  const { runId, agent, context } = ctx;
  return {
    runId,
    agentId: agent.id,
    companyId: agent.companyId,
    taskId: nonEmpty(context.taskId) ?? nonEmpty(context.issueId),
    issueId: nonEmpty(context.issueId),
    wakeReason: nonEmpty(context.wakeReason),
    wakeCommentId: nonEmpty(context.wakeCommentId) ?? nonEmpty(context.commentId),
    approvalId: nonEmpty(context.approvalId),
    approvalStatus: nonEmpty(context.approvalStatus),
    issueIds: Array.isArray(context.issueIds)
      ? context.issueIds.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        )
      : [],
  };
}

function resolvePaperclipApiUrlOverride(value: unknown): string | null {
  const raw = nonEmpty(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function buildPaperclipEnvForWake(
  ctx: AdapterExecutionContext,
  wakePayload: OpenClawWakePayload,
): Record<string, string> {
  const paperclipApiUrlOverride = resolvePaperclipApiUrlOverride(ctx.config.paperclipApiUrl);
  const paperclipEnv: Record<string, string> = {
    ...buildPaperclipEnv(ctx.agent, { context: ctx.context }),
    PAPERCLIP_RUN_ID: ctx.runId,
  };

  if (paperclipApiUrlOverride) {
    paperclipEnv.PAPERCLIP_API_URL = paperclipApiUrlOverride;
  }
  if (wakePayload.taskId) paperclipEnv.PAPERCLIP_TASK_ID = wakePayload.taskId;
  if (wakePayload.wakeReason) paperclipEnv.PAPERCLIP_WAKE_REASON = wakePayload.wakeReason;
  if (wakePayload.wakeCommentId) paperclipEnv.PAPERCLIP_WAKE_COMMENT_ID = wakePayload.wakeCommentId;
  if (wakePayload.approvalId) paperclipEnv.PAPERCLIP_APPROVAL_ID = wakePayload.approvalId;
  if (wakePayload.approvalStatus) paperclipEnv.PAPERCLIP_APPROVAL_STATUS = wakePayload.approvalStatus;
  if (wakePayload.issueIds.length > 0) {
    paperclipEnv.PAPERCLIP_LINKED_ISSUE_IDS = wakePayload.issueIds.join(",");
  }

  return paperclipEnv;
}

const DEFAULT_CLAIMED_API_KEY_PATH = "~/.openclaw/workspace/paperclip-claimed-api-key.json";

export function resolveClaimedApiKeyPath(value: unknown): string {
  return nonEmpty(value) ?? DEFAULT_CLAIMED_API_KEY_PATH;
}

function buildWakeText(
  payload: OpenClawWakePayload,
  paperclipEnv: Record<string, string>,
  claimedApiKeyPath: string,
  paperclipPayload?: Record<string, unknown>,
): string {
  const orderedKeys = [
    "PAPERCLIP_RUN_ID",
    "PAPERCLIP_AGENT_ID",
    "PAPERCLIP_COMPANY_ID",
    "PAPERCLIP_API_URL",
    "PAPERCLIP_TASK_ID",
    "PAPERCLIP_WAKE_REASON",
    "PAPERCLIP_WAKE_COMMENT_ID",
    "PAPERCLIP_APPROVAL_ID",
    "PAPERCLIP_APPROVAL_STATUS",
    "PAPERCLIP_LINKED_ISSUE_IDS",
  ];

  const envLines: string[] = [];
  for (const key of orderedKeys) {
    const value = paperclipEnv[key];
    if (!value) continue;
    envLines.push(`${key}=${value}`);
  }

  const issueIdHint = payload.taskId ?? payload.issueId ?? "";
  const apiBaseHint = paperclipEnv.PAPERCLIP_API_URL ?? "<set PAPERCLIP_API_URL>";

  const lines = [
    "Paperclip wake event for a cloud adapter.",
    "",
    "Run this procedure now. Do not guess undocumented endpoints and do not ask for additional heartbeat docs.",
    "",
    "Set these values in your run context:",
    ...envLines,
    `PAPERCLIP_API_KEY=<token from ${claimedApiKeyPath}>`,
    "",
    `Load PAPERCLIP_API_KEY from ${claimedApiKeyPath} (the token you saved after claim-api-key).`,
    "",
    `api_base=${apiBaseHint}`,
    `task_id=${payload.taskId ?? ""}`,
    `issue_id=${payload.issueId ?? ""}`,
    `wake_reason=${payload.wakeReason ?? ""}`,
    `wake_comment_id=${payload.wakeCommentId ?? ""}`,
    `approval_id=${payload.approvalId ?? ""}`,
    `approval_status=${payload.approvalStatus ?? ""}`,
    `linked_issue_ids=${payload.issueIds.join(",")}`,
    "",
    "HTTP rules:",
    "- Use Authorization: Bearer $PAPERCLIP_API_KEY on every API call.",
    "- Use X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID on every mutating API call.",
    "- Use only /api endpoints listed below.",
    "- Do NOT call guessed endpoints like /api/cloud-adapter/*, /api/cloud-adapters/*, /api/adapters/cloud/*, or /api/heartbeat.",
    "",
    "Workflow:",
    "1) GET /api/agents/me",
    `2) Determine issueId: PAPERCLIP_TASK_ID if present, otherwise issue_id (${issueIdHint}).`,
    "3) If issueId exists:",
    "   - POST /api/issues/{issueId}/checkout with {\"agentId\":\"$PAPERCLIP_AGENT_ID\",\"expectedStatuses\":[\"todo\",\"backlog\",\"blocked\"]}",
    "   - GET /api/issues/{issueId}",
    "   - GET /api/issues/{issueId}/comments",
    "   - Execute the issue instructions exactly.",
    "   - If instructions require a comment, POST /api/issues/{issueId}/comments with {\"body\":\"...\"}.",
    "   - PATCH /api/issues/{issueId} with {\"status\":\"done\",\"comment\":\"what changed and why\"}.",
    "4) If issueId does not exist:",
    "   - GET /api/companies/$PAPERCLIP_COMPANY_ID/issues?assigneeAgentId=$PAPERCLIP_AGENT_ID&status=todo,in_progress,blocked",
    "   - Pick in_progress first, then todo, then blocked, then execute step 3.",
    "",
    "Useful endpoints for issue work:",
    "- POST /api/issues/{issueId}/comments",
    "- PATCH /api/issues/{issueId}",
    "- POST /api/companies/{companyId}/issues (when asked to create a new issue)",
    "",
    ...(paperclipPayload
      ? [
          "",
          "Paperclip runtime context JSON (context only; execution status comes from structured gateway results):",
          "```json",
          JSON.stringify(paperclipPayload),
          "```",
        ]
      : []),
    "Complete the workflow in this run.",
  ];
  return lines.join("\n");
}

export function appendWakeText(baseText: string, wakeText: string): string {
  const trimmedBase = baseText.trim();
  return trimmedBase.length > 0 ? `${trimmedBase}\n\n${wakeText}` : wakeText;
}

export function buildStandardPaperclipPayload(
  ctx: AdapterExecutionContext,
  wakePayload: OpenClawWakePayload,
  paperclipEnv: Record<string, string>,
  payloadTemplate: Record<string, unknown>,
): Record<string, unknown> {
  const templatePaperclip = parseObject(payloadTemplate.paperclip);
  const workspace = asRecord(ctx.context.paperclipWorkspace);
  const workspaces = Array.isArray(ctx.context.paperclipWorkspaces)
    ? ctx.context.paperclipWorkspaces.filter((entry): entry is Record<string, unknown> => Boolean(asRecord(entry)))
    : [];
  const configuredWorkspaceRuntime = parseObject(ctx.config.workspaceRuntime);
  const runtimeServiceIntents = Array.isArray(ctx.context.paperclipRuntimeServiceIntents)
    ? ctx.context.paperclipRuntimeServiceIntents.filter(
        (entry): entry is Record<string, unknown> => Boolean(asRecord(entry)),
      )
    : [];

  const standardPaperclip: Record<string, unknown> = {
    runId: ctx.runId,
    companyId: ctx.agent.companyId,
    agentId: ctx.agent.id,
    agentName: ctx.agent.name,
    taskId: wakePayload.taskId,
    issueId: wakePayload.issueId,
    issueIds: wakePayload.issueIds,
    wakeReason: wakePayload.wakeReason,
    wakeCommentId: wakePayload.wakeCommentId,
    approvalId: wakePayload.approvalId,
    approvalStatus: wakePayload.approvalStatus,
    apiUrl: paperclipEnv.PAPERCLIP_API_URL ?? null,
  };

  if (workspace) {
    standardPaperclip.workspace = workspace;
  }
  if (workspaces.length > 0) {
    standardPaperclip.workspaces = workspaces;
  }
  if (runtimeServiceIntents.length > 0 || Object.keys(configuredWorkspaceRuntime).length > 0) {
    standardPaperclip.workspaceRuntime = {
      ...configuredWorkspaceRuntime,
      ...(runtimeServiceIntents.length > 0 ? { services: runtimeServiceIntents } : {}),
    };
  }

  return {
    ...templatePaperclip,
    ...standardPaperclip,
  };
}

export function buildOpenClawWakeContext(
  ctx: AdapterExecutionContext,
  payloadTemplate: Record<string, unknown>,
): OpenClawWakeContext {
  const wakePayload = buildWakePayload(ctx);
  const paperclipEnv = buildPaperclipEnvForWake(ctx, wakePayload);
  const paperclipPayload = buildStandardPaperclipPayload(ctx, wakePayload, paperclipEnv, payloadTemplate);
  const { unsupported: unsupportedPayloadTemplate } = splitOpenClawAgentParams(payloadTemplate);
  const wakeContext =
    Object.keys(unsupportedPayloadTemplate).length > 0
      ? { ...paperclipPayload, unsupportedPayloadTemplate }
      : paperclipPayload;
  const wakeText = buildWakeText(
    wakePayload,
    paperclipEnv,
    resolveClaimedApiKeyPath(ctx.config.claimedApiKeyPath),
    wakeContext,
  );
  return { wakePayload, wakeText, paperclipEnv, payloadTemplate };
}

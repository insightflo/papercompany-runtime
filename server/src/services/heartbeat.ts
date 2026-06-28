import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { and, asc, desc, eq, gt, inArray, not, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { BillingType } from "@paperclipai/shared";
import {
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  activityLog,
  heartbeatRunEvents,
  heartbeatRuns,
  workflowTransitionEvents,
  documents,
  issueComments,
  issueDocuments,
  issueWorkProducts,
  issues,
  missionSessions,
  missions,
  projects,
  projectWorkspaces,
  workflowStepRuns,
  worktreeRules,
} from "@paperclipai/db";
import { HttpError, conflict, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "./live-events.js";
import { getRunLogStore, type RunLogHandle } from "./run-log-store.js";
import { getServerAdapter, runningProcesses } from "../adapters/index.js";
import type { AdapterExecutionResult, AdapterInvocationMeta, AdapterSessionCodec, AdapterSessionUpdate, UsageSummary } from "../adapters/index.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { parseObject, asBoolean, asNumber, appendWithCap, MAX_EXCERPT_BYTES } from "../adapters/utils.js";
import { costService } from "./costs.js";
import { readExplicitValidationVerdict } from "./validation-verdict.js";
import { companySkillService } from "./company-skills.js";
import { budgetService, type BudgetEnforcementScope } from "./budgets.js";
import { secretService } from "./secrets.js";
import { toolService } from "./tools/registry.js";
import { knowledgeService } from "./knowledge/base.js";
import { finalizeHermesChatRun, hermesChatService } from "./hermes-chat.js";
import { parseHermesProgressText } from "../adapters/hermes-local-execute.js";
import { missionSessionStore } from "./sessions/mission-session-store.js";
import { resolveDefaultAgentWorkspaceDir, resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { summarizeHeartbeatRunResultJson } from "./heartbeat-run-summary.js";
import { extractCodexTaskCompleteMessages } from "./workflow/codex-task-output.js";
import { createWorktreeHarness, WorktreeViolation } from "./worktree/harness.js";
import {
  buildWorkspaceReadyComment,
  cleanupExecutionWorkspaceArtifacts,
  ensureRuntimeServicesForRun,
  persistAdapterManagedRuntimeServices,
  realizeExecutionWorkspace,
  releaseRuntimeServicesForRun,
  sanitizeRuntimeServiceBaseEnv,
} from "./workspace-runtime.js";
import { issueService } from "./issues.js";
import { writeQualityFinding } from "./quality-finding-writer.js";
import { agentWikiService, formatWikiLessons, type RecordFailureInput } from "./agent-wiki.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import { workspaceOperationService } from "./workspace-operations.js";
import { evaluateContextBudgetPreflight } from "./context-budget-preflight.js";
import { buildStepInputManifest } from "./step-input-manifest.js";
import { evaluateStepInputManifestGuard } from "./step-input-manifest-guard.js";
import { buildSessionHandoffArtifact, type SessionHandoffArtifact } from "./session-handoff-artifact.js";
import { buildContextSafeFileViews } from "./context-safe-file-views.js";
import { evaluateRuntimeBroadScanToolGuard } from "./runtime-broad-scan-tool-guard.js";
import { isPathInsideOrEqual, resolveMissionWorkProductPaths } from "./work-products/output-paths.js";
import { buildMaintenanceDecisionContext } from "./maintenance/decision-context.js";
import { logMaintenanceDecisionEvaluated } from "./maintenance/decision-audit.js";
import { missionPlanArtifactService } from "./mission-plan-artifacts.js";
import { missionService } from "./missions.js";
import { recordLatestAuthorizedMissionOwnerPlanDecision, type PlanQaWakeupHandler } from "./mission-owner-plan-decisions.js";
import { buildMissionOwnerPlanningContext } from "./missions/mission-owner-planning-context.js";
import { createPlanQaWakeupHandler } from "./missions/plan-qa-wakeup.js";
import { buildMissionExecutionDigest } from "./missions/mission-execution-digest.js";
import { buildMainExecutorBrief } from "./missions/mission-owner-recovery-comments.js";
import {
  extractMissionOwnerDecisionFromText,
  MISSION_OWNER_DECISION_OPTIONS,
  parseMissionOwnerActionMarker,
} from "./missions/mission-owner-recovery-events.js";
import { syncSrbSourceIssueStatus } from "./srb/source-status-sync.js";
import {
  assertMissionRuntimeAcceptsWork,
  buildMissionIssueHandoffMarkdown,
  completeMissionAgentRuntimeRun,
  markMissionRuntimeBootstrapInjected,
  persistMissionIssueHandoff,
  updateMissionRollingStateFromHandoff,
} from "./missions/mission-runtime-manager.js";
import { compileMissionRunContext } from "./missions/mission-context-compiler.js";
import { buildAssignedIssuePromptSection } from "./missions/mission-issue-envelope.js";
import {
  buildExecutionWorkspaceAdapterConfig,
  gateProjectExecutionWorkspacePolicy,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveExecutionWorkspaceMode,
} from "./execution-workspace-policy.js";
import { instanceSettingsService } from "./instance-settings.js";
import { redactCurrentUserText, redactCurrentUserValue } from "../log-redaction.js";
import {
  hasSessionCompactionThresholds,
  resolveSessionCompactionPolicy,
  type SessionCompactionPolicy,
} from "@paperclipai/adapter-utils";

type IssueCreateInput = Parameters<ReturnType<typeof issueService>["create"]>[1];

const MAX_LIVE_LOG_CHUNK_BYTES = 8 * 1024;
const RUN_ACTIVITY_TOUCH_INTERVAL_MS = 15 * 1000;
const MISSION_CHILD_RUN_OUTPUT_COMMENT_MAX_CHARS = 12 * 1024;
const HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = 1;
const HEARTBEAT_MAX_CONCURRENT_RUNS_MAX = 10;
const TERMINAL_MISSION_STATUSES = new Set(["completed", "cancelled"]);
const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";
// [목적] queued wakeup promote 시 "이 issue 는 이미 끝났으니 재실행 거절" 판정할 terminal 상태.
//   done/completed/cancelled(canceled)/closed 는 재시도 무의미 → request failed 로 종료.
const PROMOTED_REJECT_ISSUE_STATUSES = new Set(["done", "completed", "cancelled", "canceled", "closed", "wontfix"]);
const DETACHED_PROCESS_ERROR_CODE = "process_detached";
// orphaned-but-alive child 강제 회수 시한. handle 상실 후에도 child pid 가 살아 reaper 가 process_detached
// 로 매 tick defer 만 하던 무한 대기(CMPA-5519 ~72분 hang)를 상한으로 끊고 process_lost+retry 로 회수.
const DETACHED_REAP_AFTER_MS = 30 * 60 * 1000;
const DETACHED_GRACE_SEC = 5;
export const CODEX_REAUTH_REQUIRED_PAUSE_REASON = "reauth_required";
const DEFAULT_ADAPTER_FALLBACK_MAX_ATTEMPTS = 1;
const startLocksByAgent = new Map<string, Promise<void>>();
const REPO_ONLY_CWD_SENTINEL = "/__paperclip_repo_only__";
const MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const execFile = promisify(execFileCallback);
const SESSIONED_LOCAL_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "opencode_local",
  "pi_local",
]);

function deriveRepoNameFromRepoUrl(repoUrl: string | null): string | null {
  const trimmed = repoUrl?.trim() ?? "";
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const cleanedPath = parsed.pathname.replace(/\/+$/, "");
    const repoName = cleanedPath.split("/").filter(Boolean).pop()?.replace(/\.git$/i, "") ?? "";
    return repoName || null;
  } catch {
    return null;
  }
}

async function ensureManagedProjectWorkspace(input: {
  companyId: string;
  agentId: string;
  projectId: string;
  repoUrl: string | null;
  worktreeCheck?: (opts: { tool: string; args: Record<string, unknown>; cwd?: string; filePath?: string; command?: string }) => Promise<void>;
}): Promise<{ cwd: string; warning: string | null }> {
  const cwd = resolveManagedProjectWorkspaceDir({
    companyId: input.companyId,
    projectId: input.projectId,
    repoName: deriveRepoNameFromRepoUrl(input.repoUrl),
  });
  await fs.mkdir(path.dirname(cwd), { recursive: true });
  const stats = await fs.stat(cwd).catch(() => null);

  if (!input.repoUrl) {
    if (!stats) {
      await fs.mkdir(cwd, { recursive: true });
    }
    return { cwd, warning: null };
  }

  const gitDirExists = await fs
    .stat(path.resolve(cwd, ".git"))
    .then((entry) => entry.isDirectory())
    .catch(() => false);
  if (gitDirExists) {
    return { cwd, warning: null };
  }

  if (stats) {
    const entries = await fs.readdir(cwd).catch(() => []);
    if (entries.length > 0) {
      return {
        cwd,
        warning: `Managed workspace path "${cwd}" already exists but is not a git checkout. Using it as-is.`,
      };
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }

  try {
    // worktree: check command-execute before git clone
    if (input.worktreeCheck) {
      await input.worktreeCheck({
        tool: "command-execute",
        args: { command: "git clone", repoUrl: input.repoUrl ?? "" },
        cwd,
        command: `git clone ${input.repoUrl} ${cwd}`,
      });
    }
    await execFile("git", ["clone", input.repoUrl, cwd], {
      env: sanitizeRuntimeServiceBaseEnv(process.env),
      timeout: MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS,
    });
    return { cwd, warning: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to prepare managed checkout for "${input.repoUrl}" at "${cwd}": ${reason}`);
  }
}

const heartbeatRunListColumns = {
  id: heartbeatRuns.id,
  companyId: heartbeatRuns.companyId,
  agentId: heartbeatRuns.agentId,
  invocationSource: heartbeatRuns.invocationSource,
  triggerDetail: heartbeatRuns.triggerDetail,
  status: heartbeatRuns.status,
  startedAt: heartbeatRuns.startedAt,
  finishedAt: heartbeatRuns.finishedAt,
  error: heartbeatRuns.error,
  wakeupRequestId: heartbeatRuns.wakeupRequestId,
  exitCode: heartbeatRuns.exitCode,
  signal: heartbeatRuns.signal,
  usageJson: heartbeatRuns.usageJson,
  resultJson: heartbeatRuns.resultJson,
  sessionIdBefore: heartbeatRuns.sessionIdBefore,
  sessionIdAfter: heartbeatRuns.sessionIdAfter,
  logStore: heartbeatRuns.logStore,
  logRef: heartbeatRuns.logRef,
  logBytes: heartbeatRuns.logBytes,
  logSha256: heartbeatRuns.logSha256,
  logCompressed: heartbeatRuns.logCompressed,
  stdoutExcerpt: sql<string | null>`NULL`.as("stdoutExcerpt"),
  stderrExcerpt: sql<string | null>`NULL`.as("stderrExcerpt"),
  errorCode: heartbeatRuns.errorCode,
  externalRunId: heartbeatRuns.externalRunId,
  processPid: heartbeatRuns.processPid,
  processStartedAt: heartbeatRuns.processStartedAt,
  retryOfRunId: heartbeatRuns.retryOfRunId,
  processLossRetryCount: heartbeatRuns.processLossRetryCount,
  contextSnapshot: heartbeatRuns.contextSnapshot,
  createdAt: heartbeatRuns.createdAt,
  updatedAt: heartbeatRuns.updatedAt,
} as const;

function appendExcerpt(prev: string, chunk: string) {
  return appendWithCap(prev, chunk, MAX_EXCERPT_BYTES);
}

function normalizeMaxConcurrentRuns(value: unknown) {
  const parsed = Math.floor(asNumber(value, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT));
  if (!Number.isFinite(parsed)) return HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT;
  return Math.max(HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT, Math.min(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, parsed));
}

async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>) {
  const previous = startLocksByAgent.get(agentId) ?? Promise.resolve();
  const run = previous.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  startLocksByAgent.set(agentId, marker);
  try {
    return await run;
  } finally {
    if (startLocksByAgent.get(agentId) === marker) {
      startLocksByAgent.delete(agentId);
    }
  }
}

function resolveHeartbeatFailureCode(error: unknown, fallback: string) {
  if (typeof (error as { code?: unknown } | null)?.code === "string") {
    return (error as { code: string }).code;
  }
  return fallback;
}

const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const ISSUE_RUN_START_STATUSES = ["backlog", "todo", "blocked", "in_review", "in_progress"];

function isTerminalHeartbeatRunStatus(status: string | null | undefined) {
  return TERMINAL_HEARTBEAT_RUN_STATUSES.has(status ?? "");
}

export async function recordHeartbeatQueueTransitionEvent(db: Db, input: {
  companyId: string;
  missionId?: string | null;
  issueId?: string | null;
  wakeupRequestId?: string | null;
  heartbeatRunId?: string | null;
  workflowRunId?: string | null;
  workflowStepRunId?: string | null;
  eventType: string;
  layer: string;
  decision?: string | null;
  reason?: string | null;
  reasonCode?: string | null;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
}) {
  try {
    await db.insert(workflowTransitionEvents).values({
      companyId: input.companyId,
      missionId: input.missionId ?? null,
      issueId: input.issueId ?? null,
      wakeupRequestId: input.wakeupRequestId ?? null,
      heartbeatRunId: input.heartbeatRunId ?? null,
      workflowRunId: input.workflowRunId ?? null,
      workflowStepRunId: input.workflowStepRunId ?? null,
      eventType: input.eventType,
      layer: input.layer,
      decision: input.decision ?? null,
      reason: input.reason ?? null,
      reasonCode: input.reasonCode ?? null,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload ?? {},
    });
  } catch {
    // unique index on (company_id, idempotency_key) WHERE not null - duplicate, ignore
  }
}

export async function recordHeartbeatRunTerminalTransitionEvent(
  db: Db,
  run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "wakeupRequestId" | "issueId" | "status" | "errorCode" | "error">,
) {
  if (!isTerminalHeartbeatRunStatus(run.status)) return;
  await recordHeartbeatQueueTransitionEvent(db, {
    companyId: run.companyId,
    heartbeatRunId: run.id,
    wakeupRequestId: run.wakeupRequestId,
    issueId: run.issueId,
    eventType: "queue_run_completed",
    layer: "heartbeat",
    decision: run.status,
    reason: run.errorCode ?? run.error ?? "run_terminal",
    reasonCode: run.errorCode ?? "run_terminal",
    idempotencyKey: `queue-run-completed:${run.id}:${run.status}`,
  });
}

function refreshStepInputManifest(context: Record<string, unknown>, taskKey: string | null) {
  context.paperclipStepInputManifest = buildStepInputManifest({
    taskKey,
    context,
  });
}

type WorkflowStepToolContext = {
  workflowRunId: string;
  workflowId: string;
  stepId: string;
  stepName: string;
  toolNames: string[];
  toolArgs: unknown;
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    adapterType: string;
    instructions?: string | null;
  }>;
};

type WorkflowStepKnowledgeContext = {
  workflowRunId: string;
  workflowId: string;
  stepId: string;
  stepName: string;
  knowledgeBaseIds: string[];
  entries: Array<{
    id: string;
    name: string;
    type: string;
    source: string;
    tokenCount: number;
    content: string;
    error?: string;
  }>;
};

type MaintenanceGuidanceContext = {
  version: 1;
  rules: Array<{
    id: string;
    name: string;
    severity: string;
    action: string;
    message: string;
    excerpt: string;
  }>;
  knowledge: Array<{
    id: string;
    name: string;
    type: string;
    source: string;
    tokenCount: number;
    content: string;
    error?: string;
  }>;
};

/**
 * toolDefinitions.adapterConfig.instructions를 안전하게 string으로 꺼낸다.
 * adapterConfig는 jsonb object 또는 string-encoded JSON일 수 있고(codex가 daily-tech-scout
 * 수정 중 string→object 변환 이력 있음), instructions는 tool 사용 지시문(예: rawPath 파일을
 * 읽고 evidence.json을 써라). string이면 그대로, 아니면 null.
 */
function readToolInstructions(adapterConfig: unknown): string | null {
  const cfg = typeof adapterConfig === "string"
    ? (() => { try { return JSON.parse(adapterConfig); } catch { return null; } })()
    : adapterConfig;
  if (!cfg || typeof cfg !== "object") return null;
  const value = (cfg as Record<string, unknown>).instructions;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function resolveWorkflowStepToolContext(input: {
  db: Db;
  companyId: string;
  issueId: string | null;
}): Promise<WorkflowStepToolContext | null> {
  if (!input.issueId) return null;

  const { workflowService } = await import("./workflow/engine.js");
  const contract = await workflowService.getStepExecutionContractForIssue(input.db, input.issueId);
  if (!contract || contract.toolNames.length === 0) return null;

  const definitions = await toolService.listDefinitions(input.db, {
    companyId: input.companyId,
  });
  const definitionByName = new Map(definitions.map((definition) => [definition.name, definition]));
  const missingToolNames = contract.toolNames.filter((toolName) => !definitionByName.has(toolName));
  const disabledToolNames = contract.toolNames.filter((toolName) => definitionByName.get(toolName)?.enabled === false);

  if (missingToolNames.length > 0 || disabledToolNames.length > 0) {
    const details = [
      missingToolNames.length > 0 ? `missing tools: ${missingToolNames.join(", ")}` : null,
      disabledToolNames.length > 0 ? `disabled tools: ${disabledToolNames.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("; ");
    throw Object.assign(
      new Error(`Workflow step "${contract.stepName}" has an invalid tool contract (${details})`),
      {
        code: "workflow_step_tool_contract_invalid",
      },
    );
  }

  return {
    workflowRunId: contract.workflowRunId,
    workflowId: contract.workflowId,
    stepId: contract.stepId,
    stepName: contract.stepName,
    toolNames: contract.toolNames,
    toolArgs: contract.toolArgs,
    tools: contract.toolNames
      .map((toolName) => definitionByName.get(toolName))
      .filter((definition): definition is NonNullable<typeof definition> => Boolean(definition))
      .map((definition) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
        adapterType: definition.adapterType,
        instructions: readToolInstructions(definition.adapterConfig),
      })),
  };
}

function buildWorkflowKnowledgeQuery(input: {
  issueTitle: string | null;
  issueDescription: string | null;
  note: string | null;
  taskKey: string | null;
  stepName: string;
}) {
  return [
    input.stepName ? `Workflow step: ${input.stepName}` : null,
    input.issueTitle ? `Issue title: ${input.issueTitle}` : null,
    input.issueDescription ? `Issue description: ${input.issueDescription}` : null,
    input.note ? `Operator note: ${input.note}` : null,
    input.taskKey ? `Task key: ${input.taskKey}` : null,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
}

async function resolveWorkflowStepKnowledgeContext(input: {
  db: Db;
  companyId: string;
  agentId: string;
  issueId: string | null;
  taskKey: string | null;
  issueTitle: string | null;
  issueDescription: string | null;
  note: string | null;
}): Promise<WorkflowStepKnowledgeContext | null> {
  if (!input.issueId) return null;

  const { workflowService } = await import("./workflow/engine.js");
  const contract = await workflowService.getStepExecutionContractForIssue(input.db, input.issueId);
  if (!contract || contract.knowledgeBaseIds.length === 0) return null;

  const accessibleKnowledgeBases = await knowledgeService.listAccessible(
    input.db,
    input.agentId,
    input.companyId,
  );
  const knowledgeBaseById = new Map(accessibleKnowledgeBases.map((knowledgeBase) => [knowledgeBase.id, knowledgeBase]));
  const missingKnowledgeBaseIds = contract.knowledgeBaseIds.filter((knowledgeBaseId) => !knowledgeBaseById.has(knowledgeBaseId));

  if (missingKnowledgeBaseIds.length > 0) {
    throw Object.assign(
      new Error(
        `Workflow step "${contract.stepName}" has an invalid knowledge contract (missing or inaccessible KBs: ${missingKnowledgeBaseIds.join(", ")})`,
      ),
      {
        code: "workflow_step_kb_contract_invalid",
      },
    );
  }

  const query = buildWorkflowKnowledgeQuery({
    issueTitle: input.issueTitle,
    issueDescription: input.issueDescription,
    note: input.note,
    taskKey: input.taskKey,
    stepName: contract.stepName,
  });

  const entries = await Promise.all(
    contract.knowledgeBaseIds.map(async (knowledgeBaseId) => {
      const knowledgeBase = knowledgeBaseById.get(knowledgeBaseId)!;
      const retrieval = await knowledgeService.retrieve(input.db, {
        kbId: knowledgeBaseId,
        agentId: input.agentId,
        query,
        maxTokens: knowledgeBase.maxTokenBudget,
      });

      return {
        id: knowledgeBase.id,
        name: knowledgeBase.name,
        type: knowledgeBase.type,
        source: retrieval.source,
        tokenCount: retrieval.tokenCount,
        content: retrieval.content,
        ...(retrieval.error ? { error: retrieval.error } : {}),
      };
    }),
  );

  return {
    workflowRunId: contract.workflowRunId,
    workflowId: contract.workflowId,
    stepId: contract.stepId,
    stepName: contract.stepName,
    knowledgeBaseIds: contract.knowledgeBaseIds,
    entries,
  };
}

async function resolveMaintenanceGuidanceContext(input: {
  db: Db;
  companyId: string;
  agentId: string;
  workflowStepKnowledgeContext: WorkflowStepKnowledgeContext | null;
  issueTitle: string | null;
  issueDescription: string | null;
  note: string | null;
  taskKey: string | null;
}): Promise<MaintenanceGuidanceContext | null> {
  const rows = await input.db
    .select()
    .from(worktreeRules)
    .where(and(eq(worktreeRules.companyId, input.companyId), eq(worktreeRules.enabled, true)));

  const severityRank: Record<string, number> = { MUST: 0, SHOULD: 1, MAY: 2 };
  const rules = rows
    .slice()
    .sort((a, b) => (severityRank[a.severity] ?? 99) - (severityRank[b.severity] ?? 99) || a.name.localeCompare(b.name))
    .slice(0, 10)
    .map((row) => ({
      id: row.id,
      name: row.name,
      severity: row.severity,
      action: row.action,
      message: row.message,
      excerpt: row.message || `${row.severity} ${row.action}`,
    }));

  const workflowStepKnowledge = input.workflowStepKnowledgeContext?.entries ?? [];
  const workflowStepKnowledgeIds = new Set(workflowStepKnowledge.map((entry) => entry.id));
  const accessibleKnowledgeBases = await knowledgeService.listAccessible(input.db, input.agentId, input.companyId);
  const query = buildWorkflowKnowledgeQuery({
    issueTitle: input.issueTitle,
    issueDescription: input.issueDescription,
    note: input.note,
    taskKey: input.taskKey,
    stepName: "Maintenance guidance",
  });
  const fallbackKnowledge = await Promise.all(
    accessibleKnowledgeBases
      .filter((knowledgeBase) => !workflowStepKnowledgeIds.has(knowledgeBase.id))
      .slice(0, 3)
      .map(async (knowledgeBase) => {
        const retrieval = await knowledgeService.retrieve(input.db, {
          kbId: knowledgeBase.id,
          agentId: input.agentId,
          query,
          maxTokens: Math.min(knowledgeBase.maxTokenBudget, 500),
        });

        return {
          id: knowledgeBase.id,
          name: knowledgeBase.name,
          type: knowledgeBase.type,
          source: retrieval.source,
          tokenCount: retrieval.tokenCount,
          content: retrieval.content,
          ...(retrieval.error ? { error: retrieval.error } : {}),
        };
      }),
  );
  const knowledge = [...workflowStepKnowledge, ...fallbackKnowledge];
  if (rules.length === 0 && knowledge.length === 0) return null;

  return {
    version: 1,
    rules,
    knowledge,
  };
}

function hasResumableSessionForRun(
  runtime: {
    sessionId: string | null;
    sessionParams: Record<string, unknown> | null;
  },
  cwd: string,
) {
  return (
    typeof runtime.sessionId === "string" &&
    runtime.sessionId.length > 0 &&
    (() => {
      const runtimeSessionCwd = readNonEmptyString(parseObject(runtime.sessionParams).cwd) ?? "";
      return runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd);
    })()
  );
}

interface WakeupOptions {
  source?: "timer" | "assignment" | "on_demand" | "automation" | "scheduler";
  triggerDetail?: string | null;
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
}

type UsageTotals = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

type SessionCompactionDecision = {
  rotate: boolean;
  reason: string | null;
  handoffMarkdown: string | null;
  handoffArtifact: SessionHandoffArtifact | null;
  previousRunId: string | null;
};

interface ParsedIssueAssigneeAdapterOverrides {
  adapterConfig: Record<string, unknown> | null;
  useProjectWorkspace: boolean | null;
}

export type ResolvedWorkspaceForRun = {
  cwd: string;
  source: "project_primary" | "task_session" | "agent_home";
  projectId: string | null;
  workspaceId: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  workspaceHints: Array<{
    workspaceId: string;
    cwd: string | null;
    repoUrl: string | null;
    repoRef: string | null;
  }>;
  warnings: string[];
};

type ProjectWorkspaceCandidate = {
  id: string;
  cwd?: string | null;
  repoUrl?: string | null;
  repoRef?: string | null;
  projectId?: string | null;
};

export function prioritizeProjectWorkspaceCandidatesForRun<T extends ProjectWorkspaceCandidate>(
  rows: T[],
  preferredWorkspaceId: string | null | undefined,
): T[] {
  if (!preferredWorkspaceId) return rows;
  const preferredIndex = rows.findIndex((row) => row.id === preferredWorkspaceId);
  if (preferredIndex <= 0) return rows;
  return [rows[preferredIndex]!, ...rows.slice(0, preferredIndex), ...rows.slice(preferredIndex + 1)];
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isHermesOperationsLiaisonAgent(agent: Pick<typeof agents.$inferSelect, "name" | "adapterType" | "runtimeConfig" | "metadata">) {
  if (agent.adapterType !== "hermes_local") return false;
  const runtimeConfig = parseObject(agent.runtimeConfig);
  const metadata = parseObject(agent.metadata);
  const domain = readNonEmptyString(runtimeConfig.domain);
  const operatingMode = readNonEmptyString(runtimeConfig.operatingMode);
  const purpose = readNonEmptyString(metadata.purpose);
  return (
    agent.name === "Hermes Operations Manager" ||
    agent.name === "Hermes Ops Manager" ||
    domain === "operations" ||
    purpose === "research-company-hermes-management" ||
    purpose === "gazua-hermes-management" ||
    operatingMode === "chief_of_staff_liaison" ||
    operatingMode === "independent_management_operator"
  );
}

function isMissionOwnerControlIssue(issue: Pick<typeof issues.$inferSelect, "originKind" | "description">) {
  return isMissionOwnerTaskIssue(issue);
}

function truncateContextText(value: string | null | undefined, max = 220) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 3)}...` : trimmed;
}

function isMissionOwnerTaskIssue(issue: {
  originKind: string | null;
  description: string | null;
}) {
  return (
    issue.originKind === "mission_main_executor_oversight" ||
    issue.originKind === "mission_main_executor_unblock" ||
    parseMissionOwnerActionMarker(issue.description) !== null
  );
}

function canApplyRequestChangesValidationGate(issue: {
  originKind: string | null;
  title?: string | null;
}) {
  if (issue.originKind === "mission_main_executor_plan") return false;
  if (issue.originKind === "mission_main_executor_oversight") return false;
  if (issue.originKind === "mission_main_executor_unblock") return false;

  const title = issue.title?.trim() ?? "";
  return (
    /^\s*\[QA\]/iu.test(title) ||
    /\b(QA|audit|auditor|validator|validation|validate|verify|review|check)\b/iu.test(title) ||
    title.includes("검증")
  );
}

function canApplyMissingWorkProductRegistrationGate(issue: {
  originKind: string | null;
  title?: string | null;
  description?: string | null;
}, stepRunRequiresWorkProduct?: boolean) {
  if (issue.originKind === "mission_main_executor_plan") return false;
  if (issue.originKind === "mission_main_executor_oversight") return false;
  if (issue.originKind === "mission_main_executor_unblock") return false;

  // workflow step의 명시 graphWorkProductRequired 플래그(workflow_step_runs.metadata에 stamp)가
  // 권위 source. present면 title/contract 휴리스틱을 무시한다.
  if (stepRunRequiresWorkProduct === true) return true;
  if (stepRunRequiresWorkProduct === false) return false;

  // Legacy fallback: 플래그 미스탬프 step-run(pre-deploy / 미동기화)용 종래 휴리스틱.
  const title = issue.title?.trim() ?? "";
  if (/\b(lead|approval|approve|audit|auditor|validator|validation|validate|verify|QA|review|check)\b/iu.test(title)) return false;
  if (hasDeliverableOutputContract(issue.description)) return true;
  return (
    /\b(synthesi[sz]e|synthesis|generate|produce|create|draft|artifact|document|note|infographic|export|deliver|html|pdf|report)\b/iu.test(title) ||
    /(작성|생성|제작|산출물|문서|자료|보고서|리포트|HTML|PDF)/u.test(title)
  );
}

function hasDeliverableOutputContract(description: string | null | undefined) {
  const text = description?.trim() ?? "";
  return text.includes("Deliverable output (use exactly this directory)") && /`?\[?ARTIFACT\]?`?\s*:/iu.test(text);
}

/**
 * workflow_step_runs.metadata 에서 graphWorkProductRequired 플래그를 3상으로 판정.
 * - true  → 명시 산출물 step (gate 발동)
 * - false → 명시 비산출물 step (gate 스킵, 휴리스틱도 무시)
 * - undefined → 필드 미스탬프(legacy row / metadata={} / non-boolean) → 종래 휴리스틱 fallback
 * buildWorkflowStepRunMetadata 가 항상 boolean 으로 stamp 하므로 non-boolean은 undefined 취급(legacy 호환).
 */
export function resolveStepRunRequiresWorkProduct(metadata: unknown): boolean | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, unknown>).graphWorkProductRequired;
  if (value === true) return true;
  if (value === false) return false;
  return undefined;
}

export function workProductReferencesClaimedArtifact(
  product: {
    url: string | null;
    externalId: string | null;
    metadata: Record<string, unknown> | null;
    status?: string | null;
    isPrimary?: boolean | null;
  },
  claimedArtifactPaths: string[],
) {
  if (product.status && product.status !== "active") return false;

  // Some successful retry/heartbeat runs only report that the work is already complete
  // (or echo setup files from the agent prompt) rather than re-printing the actual
  // artifact path. In that case an existing active primary workProduct is already the
  // control-plane contract and should not be auto-blocked as missing registration.
  if (claimedArtifactPaths.length === 0) return product.isPrimary !== false;

  const haystack = [
    product.url,
    product.externalId,
    product.metadata ? JSON.stringify(product.metadata) : null,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
  if (!haystack.trim()) return false;

  return claimedArtifactPaths.some((artifactPath) => haystack.includes(artifactPath));
}

function workProductArtifactPaths(product: {
  url: string | null;
  externalId: string | null;
  metadata: Record<string, unknown> | null;
}) {
  const paths: string[] = [];
  for (const value of [product.url, product.externalId]) {
    if (typeof value === "string" && path.isAbsolute(value)) paths.push(value);
  }
  const metadataPath = product.metadata?.path;
  if (typeof metadataPath === "string" && path.isAbsolute(metadataPath)) paths.push(metadataPath);
  return paths;
}

function workProductWithinAllowedRoot(
  product: {
    url: string | null;
    externalId: string | null;
    metadata: Record<string, unknown> | null;
  },
  allowedArtifactRoot: string | null | undefined,
) {
  if (!allowedArtifactRoot) return true;
  const paths = workProductArtifactPaths(product);
  return paths.length > 0 && paths.some((artifactPath) => isPathInsideOrEqual(artifactPath, allowedArtifactRoot));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripArtifactTokenPunctuation(value: string) {
  return value
    .trim()
    .replace(/^[`'"]+/u, "")
    .replace(/[`'",;.)\\\]]+$/u, "");
}

function extractIssueDeclaredArtifactTokens(text: string | null | undefined) {
  if (!text?.trim()) return [];
  const matches = text.match(
    /(?:~?\/|\.{1,2}\/|[A-Za-z0-9_{}.-]+[\\/])?[A-Za-z0-9_{}./\\@()-]+\.(?:md|markdown|html?|json|csv|pdf|txt|xlsx?|docx?|png|jpe?g|webp|ya?ml)\b/giu,
  ) ?? [];
  return Array.from(new Set(matches.map(stripArtifactTokenPunctuation).filter(Boolean)));
}

/**
 * [목적] producer 가 run output / issue description / comment 에 명시적으로 남긴
 * `ARTIFACT: <absolute path>` / `[ARTIFACT]: <absolute path>` 선언만 추출한다.
 * [입력] 가변 인자로 텍스트 소스(run stdout/resultJson 직렬화, issue description, comment body 등).
 * [출력] dedup 된 절대경로(leading `/`) 배열. 절대경로만 허용 → 상대경로 FS scan 차단.
 * [왜 다른 extractor 와 분리되는가] extractIssueDeclaredArtifactTokens / extractClaimedArtifactPaths
 *   는 deliverable 확장자를 가진 "아무 경로"나 매칭하지만, 본 함수는 리터럴 artifact 접두사를
 *   요구한다. downstream step 이 본의 아니게 언급된 경로를 upstream 산출물로 착각 섭취하지 않도록.
 * [수정시 영향] dag-engine createWorkflowStepIssue 의 dependency 보조 evidence 주입 경로와
 *   producer 자동 등록의 claimed artifact 추출 경로에서 호출한다.
 */
const EXPLICIT_ARTIFACT_DECLARATION_RE = /`?\[?ARTIFACT\]?`?\s*:\s*[`'"]?(\/[^\s`'")\]\n]+)/giu;

export function extractExplicitArtifactPaths(...sources: Array<string | null | undefined>): string[] {
  const paths = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    for (const match of source.matchAll(EXPLICIT_ARTIFACT_DECLARATION_RE)) {
      const candidate = stripArtifactTokenPunctuation(match[1]!);
      if (candidate.startsWith("/")) paths.add(candidate);
    }
  }
  return Array.from(paths);
}

function artifactTokenRegexSource(token: string) {
  return escapeRegExp(token)
    .replace(/YYYY-MM-DD/gu, "\\d{4}-\\d{2}-\\d{2}")
    .replace(/YYYYMMDD/gu, "\\d{8}")
    .replace(/YYYYMM/gu, "\\d{6}")
    .replace(/\\\{date\\\}/giu, "\\d{4}-\\d{2}-\\d{2}")
    .replace(/\\\{runDate\\\}/gu, "\\d{4}-\\d{2}-\\d{2}");
}

function workProductSatisfiesIssueDeclaredArtifact(
  product: {
    url: string | null;
    externalId: string | null;
    metadata: Record<string, unknown> | null;
    status?: string | null;
    isPrimary?: boolean | null;
  },
  issue: { description?: string | null },
  allowedArtifactRoot?: string | null,
) {
  if (product.status && product.status !== "active") return false;
  if (product.isPrimary === false) return false;
  if (!workProductWithinAllowedRoot(product, allowedArtifactRoot)) return false;

  const declaredArtifactTokens = extractIssueDeclaredArtifactTokens(issue.description);
  if (declaredArtifactTokens.length === 0) return false;

  const haystack = [
    product.url,
    product.externalId,
    product.metadata ? JSON.stringify(product.metadata) : null,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .replace(/\\/gu, "/");
  if (!haystack.trim()) return false;

  return declaredArtifactTokens.some((token) => {
    const normalizedToken = token.replace(/\\/gu, "/");
    const basename = path.posix.basename(normalizedToken);
    const candidates = Array.from(new Set([normalizedToken, basename].filter(Boolean)));
    return candidates.some((candidate) => new RegExp(artifactTokenRegexSource(candidate), "u").test(haystack));
  });
}

export function hasSatisfiedWorkProductRegistration(input: {
  existingWorkProducts: Array<{
    url: string | null;
    externalId: string | null;
    metadata: Record<string, unknown> | null;
    status?: string | null;
    isPrimary?: boolean | null;
  }>;
  claimedArtifactPaths: string[];
  issue: { description?: string | null };
  autoRegisteredWorkProduct?: unknown | null;
  allowedArtifactRoot?: string | null;
}) {
  const effectiveClaimedArtifactPaths = input.claimedArtifactPaths
    .filter(isActionableClaimedArtifactPath)
    .filter((artifactPath) =>
      input.allowedArtifactRoot ? isPathInsideOrEqual(artifactPath, input.allowedArtifactRoot) : true,
    );
  // An active primary workProduct is the authoritative control-plane contract for the issue’s artifact. When a heartbeat/retry run succeeds and echoes input/setup/data-source paths in its stdout that do not literally match the registered deliverable URL, the existing registration must not be treated as missing. This removes the false-positive loop reported in CMPAA-163 without disabling the gate for the genuine “agent forgot to register WP” case.
  const hasActivePrimaryWorkProduct = input.existingWorkProducts.some((product) =>
    effectiveClaimedArtifactPaths.length === 0 &&
    product.status === "active" &&
    product.isPrimary === true &&
    workProductWithinAllowedRoot({
      url: product.url,
      externalId: product.externalId,
      metadata: product.metadata ?? null,
    }, input.allowedArtifactRoot)
  );
  const hasMatchingWorkProduct = input.existingWorkProducts.some((product) => workProductReferencesClaimedArtifact(
    {
      url: product.url,
      externalId: product.externalId,
      metadata: product.metadata ?? null,
      status: product.status,
      isPrimary: product.isPrimary,
    },
    effectiveClaimedArtifactPaths,
  ) && workProductWithinAllowedRoot({
    url: product.url,
    externalId: product.externalId,
    metadata: product.metadata ?? null,
  }, input.allowedArtifactRoot));
  const hasIssueDeclaredWorkProduct = input.existingWorkProducts.some((product) =>
    workProductSatisfiesIssueDeclaredArtifact({
      url: product.url,
      externalId: product.externalId,
      status: product.status,
      isPrimary: product.isPrimary,
      metadata: product.metadata ?? null,
    }, input.issue, input.allowedArtifactRoot),
  );

  return (
    hasActivePrimaryWorkProduct ||
    hasMatchingWorkProduct ||
    hasIssueDeclaredWorkProduct ||
    Boolean(input.autoRegisteredWorkProduct)
  );
}

async function autoRegisterWorkProductFromIssueDocument(input: {
  tx: Pick<Db, "select" | "insert">;
  issue: {
    id: string;
    companyId: string;
    projectId?: string | null;
  };
  run: typeof heartbeatRuns.$inferSelect;
  claimedArtifactPaths: string[];
  allowedArtifactRoot?: string | null;
}) {
  const issueDocs = await input.tx
    .select({
      id: documents.id,
      key: issueDocuments.key,
      title: documents.title,
      latestBody: documents.latestBody,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(eq(issueDocuments.issueId, input.issue.id))
    .limit(25);

  const matchingDocument = issueDocs.find((doc) => {
    if (doc.key !== "work-product" && doc.key !== "workproduct") return false;
    const haystack = [doc.title, doc.latestBody].filter(Boolean).join("\n");
    return input.claimedArtifactPaths
      .filter((artifactPath) => !input.allowedArtifactRoot || isPathInsideOrEqual(artifactPath, input.allowedArtifactRoot))
      .some((artifactPath) => haystack.includes(artifactPath));
  });
  if (!matchingDocument) return null;

  const artifactPath = input.claimedArtifactPaths.find((candidate) => {
    if (input.allowedArtifactRoot && !isPathInsideOrEqual(candidate, input.allowedArtifactRoot)) return false;
    const haystack = [matchingDocument.title, matchingDocument.latestBody].filter(Boolean).join("\n");
    return haystack.includes(candidate);
  });
  if (!artifactPath) return null;

  const isPrimary = !(await input.tx
    .select({ id: issueWorkProducts.id })
    .from(issueWorkProducts)
    .where(eq(issueWorkProducts.issueId, input.issue.id))
    .limit(1)
    .then((rows) => rows[0] ?? null));

  const [created] = await input.tx
    .insert(issueWorkProducts)
    .values({
      companyId: input.issue.companyId,
      projectId: input.issue.projectId ?? null,
      issueId: input.issue.id,
      type: "document",
      provider: "local",
      externalId: artifactPath,
      title: matchingDocument.title ?? path.basename(artifactPath),
      status: "active",
      reviewState: "none",
      isPrimary,
      healthStatus: "unknown",
      summary: "Auto-registered from issue document key `work-product` after a successful run reported this artifact path.",
      metadata: {
        path: artifactPath,
        autoRegisteredFrom: "issue_document_work_product",
        issueDocumentId: matchingDocument.id,
        issueDocumentKey: matchingDocument.key,
        claimedArtifactPaths: input.claimedArtifactPaths,
      },
      createdByRunId: input.run.id,
    })
    .returning({ id: issueWorkProducts.id });

  await input.tx.insert(activityLog).values({
    companyId: input.issue.companyId,
    actorType: "system",
    actorId: "heartbeat",
    action: "issue.work_product_auto_registered_from_document",
    entityType: "issue",
    entityId: input.issue.id,
    agentId: input.run.agentId,
    runId: input.run.id,
    details: {
      workProductId: created?.id ?? null,
      issueDocumentId: matchingDocument.id,
      issueDocumentKey: matchingDocument.key,
      path: artifactPath,
    },
  });

  return created ?? null;
}

async function autoRegisterWorkProductFromClaimedFile(input: {
  tx: Pick<Db, "select" | "insert">;
  issue: {
    id: string;
    companyId: string;
    projectId?: string | null;
  };
  run: typeof heartbeatRuns.$inferSelect;
  claimedArtifactPaths: string[];
  allowedArtifactRoot?: string | null;
  preferClaimedArtifactPath?: boolean;
}) {
  // [목적] producer 가 산출물 파일은 만들고 경로까지 출력(claimed)했으나 POST /work-products 등록 절차를
  //   안 지킨 케이스의 회복. 문서 기반 자동등록(autoRegisterWorkProductFromIssueDocument)이 "work-product"
  //   문서가 없어 못 잡을 때, claimed 절대경로가 실제 파일이면 그 파일을 workProduct 로 등록한다.
  // [주의] 절대경로 + fs.isFile() 확인으로만 등록(오등록/과등록 위험 최소화). CMPAA-163(existing WP 를
  //   missing 으로 오탐하는 false-positive)과는 다른 경로 — 여기는 진짜 등록 안 된 실제 파일을 보강 등록.
  // [수정시 영향] 모든 producer(workflow/수동)에 적용. 조건 완화 시 오등록 위험.
  // producer 가 명시한 claimed 경로(artifact-path regex 추출)를 권위로 그대로 등록한다. 파일 존재 검사/
  //   workspace resolve 는 의도적으로 생략 — (a) producer 가 project-relative("/tech-scout/...") 등 다양한
  //   형태로 경로를 보고해 단일 resolve base 를 정하기 어렵고, (b) downstream validator 가 같은 workspace
  //   맥락에서 같은 경로를 resolve 하므로 producer 가 쓴 형태를 보존하는 쪽이 일관된다. 파일이 진짜 없으면
  //   downstream REQUEST_CHANGES 로 자교정(현재 gate block 보다 낫다). CMPAA-163(existing WP missing 오탐)
  //   과는 다른, 진짜 미등록 claimed 산출물의 보강 등록 경로.
  // producer 가 여러 경로를 claimed 할 때 deliverable-like(report/draft/.md/.html/.pdf 등) 경로를 선호하고
  //   misc(favicon/.svg/.ico/.json 등)는 배제. 잘못된 artifact 를 등록해 downstream 가 엉뚱한 파일을 쓰는 것을
  //   막는다(이전 run: synthesize 가 favicon.svg 를 대신 등록해 build 가 report.md 를 못 찾음).
  const DELIVERABLE_NAME_RE = /(report|draft|outline|article|document|deliverable|artifact|manual|guide|summary|brief|synthesi[sz]e)/i;
  const DELIVERABLE_EXT_RE = /\.(md|html?|pdf|txt)$/i;
  const MISC_ARTIFACT_RE = /(favicon|\.svg$|\.ico$|\.json$|\.lock$|\.log$|\.map$|node_modules|package\.json|\/config\.)/i;
  const runDateStr = input.run.startedAt instanceof Date
    ? input.run.startedAt.toISOString().slice(0, 10).replace(/-/g, "")
    : "";
  const eligibleClaimedArtifactPaths = input.claimedArtifactPaths
    .filter((c): c is string => typeof c === "string" && c.trim().length > 0 && !c.includes("{"))
    .filter((p) => !input.allowedArtifactRoot || isPathInsideOrEqual(p, input.allowedArtifactRoot));
  // explicit `[ARTIFACT]: <abs path>` 마커로 선언된 경로를 권위로 우선한다. generic scraping noise
  // (raw-tech-scout.json, /design.md 등)가 eligible 을 여러 개로 만들어도, explicit 선언 1개면
  // 그것을 등록(.json 이라도). extractExplicitArtifactPaths 가 Set dedup + backslash strip 하므로
  // `evidence.json\`(command escaping)과 `evidence.json`(final line)은 하나로 정규화된다.
  const explicitRunText = [stringifyRunResultJson(input.run.resultJson), input.run.stdoutExcerpt, input.run.stderrExcerpt]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
  const explicitEligiblePaths = extractExplicitArtifactPaths(explicitRunText)
    .filter((p) => isActionableClaimedArtifactPath(p))
    .filter((p) => !input.allowedArtifactRoot || isPathInsideOrEqual(p, input.allowedArtifactRoot));
  const declaredArtifactPath = input.preferClaimedArtifactPath && explicitEligiblePaths.length >= 1
    ? explicitEligiblePaths[0]
    : null;
  const scored = eligibleClaimedArtifactPaths
    .map((p) => {
      let score = (DELIVERABLE_NAME_RE.test(p) ? 2 : 0) + (DELIVERABLE_EXT_RE.test(p) ? 2 : 0) - (MISC_ARTIFACT_RE.test(p) ? 3 : 0);
      // run-date awareness: current-run 날짜 경로 선호(+5), stale 날짜 패널티(-5)
      if (runDateStr && p.includes(runDateStr)) score += 5;
      else if (/\d{8}/.test(p)) score -= 5;
      return { p, score };
    })
    .sort((a, b) => b.score - a.score);
  // deliverable-like(점수>0)인 것만 등록. 전부 misc 면 등록 안 함(gate block — 잘못된 artifact 등록 방지).
  const resolvedArtifactPath = declaredArtifactPath ?? (scored.length > 0 && scored[0].score > 0 ? scored[0].p : null);
  if (!resolvedArtifactPath) return null;

  const isPrimary = !(await input.tx
    .select({ id: issueWorkProducts.id })
    .from(issueWorkProducts)
    .where(eq(issueWorkProducts.issueId, input.issue.id))
    .limit(1)
    .then((rows) => rows[0] ?? null));

  const [created] = await input.tx
    .insert(issueWorkProducts)
    .values({
      companyId: input.issue.companyId,
      projectId: input.issue.projectId ?? null,
      issueId: input.issue.id,
      type: "file",
      provider: "local",
      externalId: resolvedArtifactPath,
      title: path.basename(resolvedArtifactPath),
      status: "active",
      reviewState: "none",
      isPrimary,
      healthStatus: "unknown",
      summary: "Auto-registered from a claimed artifact path that resolves to a real file (producer reported the path but did not register a workProduct).",
      metadata: {
        path: resolvedArtifactPath,
        autoRegisteredFrom: "claimed_artifact_file",
        claimedArtifactPaths: input.claimedArtifactPaths,
      },
      createdByRunId: input.run.id,
    })
    .returning({ id: issueWorkProducts.id });

  await input.tx.insert(activityLog).values({
    companyId: input.issue.companyId,
    actorType: "system",
    actorId: "heartbeat",
    action: "issue.work_product_auto_registered_from_file",
    entityType: "issue",
    entityId: input.issue.id,
    agentId: input.run.agentId,
    runId: input.run.id,
    details: {
      workProductId: created?.id ?? null,
      path: resolvedArtifactPath,
    },
  });

  return created ?? null;
}

function canCreateMissionOwnerUnblockForRequestChanges(issue: {
  originKind: string | null;
  title?: string | null;
}) {
  return canApplyRequestChangesValidationGate(issue);
}

export type MissionOwnerTaskContext = {
  available: true;
  gating: "originKind" | "mission-owner-action-marker";
  mission: {
    id: string;
    title: string;
    status: string;
  };
  ownerTaskIssue: {
    id: string;
    identifier: string | null;
    title: string;
    originKind: string | null;
    status: string;
  };
  sourceIssue: {
    id: string;
    identifier: string | null;
    title: string;
    status: string;
    assigneeAgentId: string | null;
  } | null;
  latestOwnerActionDecision: ReturnType<typeof extractMissionOwnerDecisionFromText>;
  governanceEvidence: string;
  allowedDecisionOptions: string[];
  requiredDecisionFormat: string[];
};

async function resolveMissionOwnerTaskContext(input: {
  db: Db;
  companyId: string;
  issue: {
    id: string;
    identifier: string | null;
    title: string;
    description: string | null;
    status: string;
    missionId: string | null;
    originKind: string | null;
    originId: string | null;
  } | null;
}): Promise<MissionOwnerTaskContext | null> {
  const { db, companyId, issue } = input;
  if (!issue || !isMissionOwnerTaskIssue(issue)) return null;

  const marker = parseMissionOwnerActionMarker(issue.description);
  const missionId = issue.missionId ?? marker?.missionId ?? null;
  if (!missionId) return null;

  const mission = await db
    .select({ id: missions.id, title: missions.title, status: missions.status })
    .from(missions)
    .where(and(eq(missions.id, missionId), eq(missions.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!mission) return null;

  const sourceIssueId = issue.originKind === "mission_main_executor_unblock"
    ? issue.originId
    : marker?.sourceIssueId ?? null;
  const sourceIssue = sourceIssueId
    ? await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
        })
        .from(issues)
        .where(and(eq(issues.id, sourceIssueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0] ?? null)
    : null;

  const latestDecisionComment = await db
    .select({ body: issueComments.body })
    .from(issueComments)
    .where(and(eq(issueComments.issueId, issue.id), eq(issueComments.companyId, companyId)))
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
    .limit(5);
  const latestOwnerActionDecision = latestDecisionComment
    .map((comment) => extractMissionOwnerDecisionFromText(comment.body))
    .find((decision) => decision !== null) ?? extractMissionOwnerDecisionFromText(issue.description ?? "");

  return {
    available: true,
    gating: issue.originKind === "mission_main_executor_oversight" || issue.originKind === "mission_main_executor_unblock"
      ? "originKind"
      : "mission-owner-action-marker",
    mission: {
      id: mission.id,
      title: truncateContextText(mission.title, 160) ?? "Untitled mission",
      status: mission.status,
    },
    ownerTaskIssue: {
      id: issue.id,
      identifier: issue.identifier,
      title: truncateContextText(issue.title, 160) ?? "Untitled issue",
      originKind: issue.originKind,
      status: issue.status,
    },
    sourceIssue: sourceIssue
      ? {
          id: sourceIssue.id,
          identifier: sourceIssue.identifier,
          title: truncateContextText(sourceIssue.title, 160) ?? "Untitled source issue",
          status: sourceIssue.status,
          assigneeAgentId: sourceIssue.assigneeAgentId,
        }
      : null,
    latestOwnerActionDecision,
    governanceEvidence: "Governance evidence: unavailable in this context builder",
    allowedDecisionOptions: [...MISSION_OWNER_DECISION_OPTIONS],
    requiredDecisionFormat: [
      "### Mission owner decision",
      "Decision:",
      "Source issue:",
      "Reason:",
      "Next action:",
      "Evidence:",
    ],
  };
}

function normalizeLedgerBillingType(value: unknown): BillingType {
  const raw = readNonEmptyString(value);
  switch (raw) {
    case "api":
    case "metered_api":
      return "metered_api";
    case "subscription":
    case "subscription_included":
      return "subscription_included";
    case "subscription_overage":
      return "subscription_overage";
    case "credits":
      return "credits";
    case "fixed":
      return "fixed";
    default:
      return "unknown";
  }
}

function resolveLedgerBiller(result: AdapterExecutionResult): string {
  return readNonEmptyString(result.biller) ?? readNonEmptyString(result.provider) ?? "unknown";
}

function normalizeBilledCostCents(costUsd: number | null | undefined, billingType: BillingType): number {
  if (billingType === "subscription_included") return 0;
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return 0;
  return Math.max(0, Math.round(costUsd * 100));
}

async function resolveLedgerScopeForRun(
  db: Db,
  companyId: string,
  run: typeof heartbeatRuns.$inferSelect,
) {
  const context = parseObject(run.contextSnapshot);
  const contextIssueId = run.issueId ?? readNonEmptyString(context.issueId);
  const contextProjectId = readNonEmptyString(context.projectId);

  if (!contextIssueId) {
    return {
      issueId: null,
      projectId: contextProjectId,
    };
  }

  const issue = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
    })
    .from(issues)
    .where(and(eq(issues.id, contextIssueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);

  return {
    issueId: issue?.id ?? null,
    projectId: issue?.projectId ?? contextProjectId,
  };
}

function normalizeUsageTotals(usage: UsageSummary | null | undefined): UsageTotals | null {
  if (!usage) return null;
  return {
    inputTokens: Math.max(0, Math.floor(asNumber(usage.inputTokens, 0))),
    cachedInputTokens: Math.max(0, Math.floor(asNumber(usage.cachedInputTokens, 0))),
    outputTokens: Math.max(0, Math.floor(asNumber(usage.outputTokens, 0))),
  };
}

function readRawUsageTotals(usageJson: unknown): UsageTotals | null {
  const parsed = parseObject(usageJson);
  if (Object.keys(parsed).length === 0) return null;

  const inputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawInputTokens, asNumber(parsed.inputTokens, 0))),
  );
  const cachedInputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawCachedInputTokens, asNumber(parsed.cachedInputTokens, 0))),
  );
  const outputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawOutputTokens, asNumber(parsed.outputTokens, 0))),
  );

  if (inputTokens <= 0 && cachedInputTokens <= 0 && outputTokens <= 0) {
    return null;
  }

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
  };
}

function deriveNormalizedUsageDelta(current: UsageTotals | null, previous: UsageTotals | null): UsageTotals | null {
  if (!current) return null;
  if (!previous) return { ...current };

  const inputTokens = current.inputTokens >= previous.inputTokens
    ? current.inputTokens - previous.inputTokens
    : current.inputTokens;
  const cachedInputTokens = current.cachedInputTokens >= previous.cachedInputTokens
    ? current.cachedInputTokens - previous.cachedInputTokens
    : current.cachedInputTokens;
  const outputTokens = current.outputTokens >= previous.outputTokens
    ? current.outputTokens - previous.outputTokens
    : current.outputTokens;

  return {
    inputTokens: Math.max(0, inputTokens),
    cachedInputTokens: Math.max(0, cachedInputTokens),
    outputTokens: Math.max(0, outputTokens),
  };
}

function formatCount(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0";
  return value.toLocaleString("en-US");
}

export function parseSessionCompactionPolicy(agent: typeof agents.$inferSelect): SessionCompactionPolicy {
  return resolveSessionCompactionPolicy(agent.adapterType, agent.runtimeConfig).policy;
}

export function resolveRuntimeSessionParamsForWorkspace(input: {
  agentId: string;
  previousSessionParams: Record<string, unknown> | null;
  resolvedWorkspace: ResolvedWorkspaceForRun;
}) {
  const { agentId, previousSessionParams, resolvedWorkspace } = input;
  const previousSessionId = readNonEmptyString(previousSessionParams?.sessionId);
  const previousCwd = readNonEmptyString(previousSessionParams?.cwd);
  if (!previousSessionId || !previousCwd) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  if (resolvedWorkspace.source !== "project_primary") {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const projectCwd = readNonEmptyString(resolvedWorkspace.cwd);
  if (!projectCwd) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const fallbackAgentHomeCwd = resolveDefaultAgentWorkspaceDir(agentId);
  if (path.resolve(previousCwd) !== path.resolve(fallbackAgentHomeCwd)) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  if (path.resolve(projectCwd) === path.resolve(previousCwd)) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const previousWorkspaceId = readNonEmptyString(previousSessionParams?.workspaceId);
  if (
    previousWorkspaceId &&
    resolvedWorkspace.workspaceId &&
    previousWorkspaceId !== resolvedWorkspace.workspaceId
  ) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }

  const migratedSessionParams: Record<string, unknown> = {
    ...(previousSessionParams ?? {}),
    cwd: projectCwd,
  };
  if (resolvedWorkspace.workspaceId) migratedSessionParams.workspaceId = resolvedWorkspace.workspaceId;
  if (resolvedWorkspace.repoUrl) migratedSessionParams.repoUrl = resolvedWorkspace.repoUrl;
  if (resolvedWorkspace.repoRef) migratedSessionParams.repoRef = resolvedWorkspace.repoRef;

  return {
    sessionParams: migratedSessionParams,
    warning:
      `Project workspace "${projectCwd}" is now available. ` +
      `Attempting to resume session "${previousSessionId}" that was previously saved in fallback workspace "${previousCwd}".`,
  };
}

function parseIssueAssigneeAdapterOverrides(
  raw: unknown,
): ParsedIssueAssigneeAdapterOverrides | null {
  const parsed = parseObject(raw);
  const parsedAdapterConfig = parseObject(parsed.adapterConfig);
  const adapterConfig =
    Object.keys(parsedAdapterConfig).length > 0 ? parsedAdapterConfig : null;
  const useProjectWorkspace =
    typeof parsed.useProjectWorkspace === "boolean"
      ? parsed.useProjectWorkspace
      : null;
  if (!adapterConfig && useProjectWorkspace === null) return null;
  return {
    adapterConfig,
    useProjectWorkspace,
  };
}

function deriveTaskKey(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  return (
    readNonEmptyString(contextSnapshot?.taskKey) ??
    readNonEmptyString(contextSnapshot?.taskId) ??
    readNonEmptyString(contextSnapshot?.issueId) ??
    readNonEmptyString(payload?.taskKey) ??
    readNonEmptyString(payload?.taskId) ??
    readNonEmptyString(payload?.issueId) ??
    null
  );
}

export function shouldResetTaskSessionForWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.forceFreshSession === true) return true;

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (
    wakeReason === "issue_assigned" ||
    wakeReason === "mission_owner_planning_issue_created" ||
    wakeReason === "mission_unblock_action_created" ||
    wakeReason === "mission_unblock_action_stalled"
  ) return true;
  return false;
}

export function formatRuntimeWorkspaceWarningLog(warning: string) {
  return {
    stream: "stdout" as const,
    chunk: `[paperclip] ${warning}\n`,
  };
}

export type CodexAuthAutoBlockInfo = {
  reasonCode: string;
  authErrorCode: string | null;
};

const CODEX_AUTH_401_ERROR_CODE_PREFIX = "codex_auth_401";

function normalizeReasonCodeSegment(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function detectCodexAuthFailureForAutoBlock(input: {
  adapterType: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
}): CodexAuthAutoBlockInfo | null {
  if (input.adapterType !== "codex_local") return null;

  const normalizedErrorCode = (input.errorCode ?? "").trim().toLowerCase();
  if (normalizedErrorCode.startsWith(CODEX_AUTH_401_ERROR_CODE_PREFIX)) {
    const suffix = normalizedErrorCode.slice(CODEX_AUTH_401_ERROR_CODE_PREFIX.length).replace(/^_+/, "");
    const authErrorCode = suffix.length > 0 ? suffix : null;
    return {
      reasonCode: authErrorCode ? `CODEX_AUTH_401_${normalizeReasonCodeSegment(authErrorCode)}` : "CODEX_AUTH_401",
      authErrorCode,
    };
  }

  const haystack = [
    input.errorMessage ?? "",
    input.stdoutExcerpt ?? "",
    input.stderrExcerpt ?? "",
  ]
    .join("\n")
    .trim();

  const explicitAuthErrorCode = haystack.match(/\bauth error code:\s*([a-z0-9_]+)/i)?.[1]?.toLowerCase() ?? null;
  const detectedAuthErrorCode =
    explicitAuthErrorCode ??
    (haystack.match(/\b(refresh_token_reused|token_expired|invalid_grant|session_expired)\b/i)?.[1]?.toLowerCase() ?? null);

  if (/\b401\s+unauthorized\b|\bauth error:\s*401\b/i.test(haystack)) {
    return {
      reasonCode: detectedAuthErrorCode
        ? `CODEX_AUTH_401_${normalizeReasonCodeSegment(detectedAuthErrorCode)}`
        : "CODEX_AUTH_401",
      authErrorCode: detectedAuthErrorCode,
    };
  }

  if (
    detectedAuthErrorCode ||
    /provided authentication token is expired|access token could not be refreshed|please log out and sign in again|no codex credentials stored/i.test(
      haystack,
    )
  ) {
    const authErrorCode = detectedAuthErrorCode ?? "reauth_required";
    return {
      reasonCode: `CODEX_AUTH_${normalizeReasonCodeSegment(authErrorCode)}`,
      authErrorCode,
    };
  }

  return null;
}

export function buildCodexAuthAutoBlockedComment(input: CodexAuthAutoBlockInfo & { runId: string }): string {
  const detected = input.authErrorCode
    ? `codex_local 실행 중 401 Unauthorized (auth error code: \`${input.authErrorCode}\`)`
    : "codex_local 실행 중 401 Unauthorized";
  return [
    "## 자동 차단: codex_local 인증 오류",
    `- 원인코드: \`${input.reasonCode}\``,
    `- 감지: ${detected}`,
    `- 실행 runId: \`${input.runId}\``,
    "- 조치 1: `codex login`으로 Codex CLI를 재인증",
    "- 조치 2: Hermes `openai-codex`도 같은 계정 세션을 쓰면 `hermes auth`로 별도 재인증 상태 확인",
    "- 조치 3: OPENAI API 키 사용 모드면 `OPENAI_API_KEY` 유효성 재확인",
    "- 재개: 인증 복구 후 에이전트 일시정지를 해제하고 heartbeat 재실행",
  ].join("\n");
}

function describeSessionResetReason(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.forceFreshSession === true) return "forceFreshSession was requested";

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (wakeReason === "issue_assigned") return "wake reason is issue_assigned";
  if (wakeReason === "mission_unblock_action_created") return "wake reason is mission_unblock_action_created";
  if (wakeReason === "mission_unblock_action_stalled") return "wake reason is mission_unblock_action_stalled";
  return null;
}

function deriveCommentId(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  return (
    readNonEmptyString(contextSnapshot?.wakeCommentId) ??
    readNonEmptyString(contextSnapshot?.commentId) ??
    readNonEmptyString(payload?.commentId) ??
    null
  );
}

function enrichWakeContextSnapshot(input: {
  contextSnapshot: Record<string, unknown>;
  reason: string | null;
  source: WakeupOptions["source"];
  triggerDetail: WakeupOptions["triggerDetail"] | null;
  payload: Record<string, unknown> | null;
}) {
  const { contextSnapshot, reason, source, triggerDetail, payload } = input;
  const issueIdFromPayload = readNonEmptyString(payload?.["issueId"]);
  const commentIdFromPayload = readNonEmptyString(payload?.["commentId"]);
  const missionIdFromPayload = readNonEmptyString(payload?.["missionId"]);
  const taskKey = deriveTaskKey(contextSnapshot, payload);
  const wakeCommentId = deriveCommentId(contextSnapshot, payload);

  if (!readNonEmptyString(contextSnapshot["wakeReason"]) && reason) {
    contextSnapshot.wakeReason = reason;
  }
  if (!readNonEmptyString(contextSnapshot["issueId"]) && issueIdFromPayload) {
    contextSnapshot.issueId = issueIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["missionId"]) && missionIdFromPayload) {
    contextSnapshot.missionId = missionIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["taskId"]) && issueIdFromPayload) {
    contextSnapshot.taskId = issueIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["taskKey"]) && taskKey) {
    contextSnapshot.taskKey = taskKey;
  }
  if (!readNonEmptyString(contextSnapshot["commentId"]) && commentIdFromPayload) {
    contextSnapshot.commentId = commentIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["wakeCommentId"]) && wakeCommentId) {
    contextSnapshot.wakeCommentId = wakeCommentId;
  }
  if (!readNonEmptyString(contextSnapshot["wakeSource"]) && source) {
    contextSnapshot.wakeSource = source;
  }
  if (!readNonEmptyString(contextSnapshot["wakeTriggerDetail"]) && triggerDetail) {
    contextSnapshot.wakeTriggerDetail = triggerDetail;
  }

  return {
    contextSnapshot,
    issueIdFromPayload,
    commentIdFromPayload,
    taskKey,
    wakeCommentId,
  };
}

function mergeCoalescedContextSnapshot(
  existingRaw: unknown,
  incoming: Record<string, unknown>,
) {
  const existing = parseObject(existingRaw);
  const merged: Record<string, unknown> = {
    ...existing,
    ...incoming,
  };
  const commentId = deriveCommentId(incoming, null);
  if (commentId) {
    merged.commentId = commentId;
    merged.wakeCommentId = commentId;
  }
  return merged;
}

function runTaskKey(run: typeof heartbeatRuns.$inferSelect) {
  return deriveTaskKey(run.contextSnapshot as Record<string, unknown> | null, null);
}

function isSameTaskScope(left: string | null, right: string | null) {
  return (left ?? null) === (right ?? null);
}

function isTrackedLocalChildProcessAdapter(adapterType: string) {
  return SESSIONED_LOCAL_ADAPTERS.has(adapterType);
}

type AdapterFallbackConfig = {
  command: string;
  provider?: string;
  model?: string;
  triggers: Set<string>;
  maxAttempts: number;
};

function resolveAdapterFallbackConfig(adapterConfigRaw: unknown): AdapterFallbackConfig | null {
  const adapterConfig = parseObject(adapterConfigRaw);
  const fallback = parseObject(adapterConfig.fallback);
  const command =
    readNonEmptyString(adapterConfig.fallbackCommand) ??
    readNonEmptyString(fallback.command);
  if (!command) return null;
  const provider = readNonEmptyString(fallback.provider) ?? undefined;
  const model = readNonEmptyString(fallback.model) ?? undefined;

  const rawTriggers = Array.isArray(fallback.triggers) ? fallback.triggers : [];
  const triggers = rawTriggers
    .map((value) => readNonEmptyString(value))
    .filter((value): value is string => Boolean(value));
  const maxAttempts = Math.max(
    1,
    Math.floor(asNumber(fallback.maxAttempts ?? adapterConfig.fallbackMaxAttempts, DEFAULT_ADAPTER_FALLBACK_MAX_ATTEMPTS)),
  );

  return {
    command,
    provider,
    model,
    triggers: triggers.length > 0 ? new Set(triggers) : new Set(["process_lost"]),
    maxAttempts,
  };
}

function resolveAdapterFallbackAttempt(contextRaw: unknown) {
  const context = parseObject(contextRaw);
  const parsed = Math.floor(asNumber(context.fallbackAttempt, 0));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function shouldApplyAdapterFallbackConfig(input: {
  run: typeof heartbeatRuns.$inferSelect;
  context: Record<string, unknown>;
}) {
  return (
    Boolean(input.run.retryOfRunId) &&
    readNonEmptyString(input.context.wakeReason) === "adapter_fallback" &&
    readNonEmptyString(input.context.fallbackOfRunId) === input.run.retryOfRunId &&
    Boolean(readNonEmptyString(input.context.fallbackCommand))
  );
}

function applyAdapterFallbackRuntimeConfig(input: {
  run: typeof heartbeatRuns.$inferSelect;
  context: Record<string, unknown>;
  config: Record<string, unknown>;
}) {
  if (!shouldApplyAdapterFallbackConfig(input)) return input.config;
  const command = readNonEmptyString(input.context.fallbackCommand);
  if (!command) return input.config;
  const provider = readNonEmptyString(input.context.fallbackProvider);
  const model = readNonEmptyString(input.context.fallbackModel);
  return {
    ...input.config,
    command,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  };
}

function isTerminalAdapterFallbackConfigurationFailure(run: typeof heartbeatRuns.$inferSelect) {
  const text = [
    heartbeatRunFailureText({
      errorCode: run.errorCode,
      errorMessage: run.error,
      stdoutExcerpt: run.stdoutExcerpt,
      stderrExcerpt: run.stderrExcerpt,
    }),
    stringifyRunResultJson(run.resultJson),
    stringifyRunResultJson(run.usageJson),
  ].join("\n").toLowerCase();

  return (
    /api error:\s*400\b[\s\S]*param incorrect/.test(text) ||
    /\bparam incorrect\b/.test(text) ||
    /\bnot supported model\b/.test(text) ||
    /\bunsupported model\b/.test(text) ||
    /\binvalid model\b/.test(text) ||
    /\bunknown model\b/.test(text) ||
    /\bmodel\b[\s\S]{0,80}\bnot (?:found|supported)\b/.test(text)
  );
}

function shouldQueueRunFailureAdapterFallback(input: {
  run: typeof heartbeatRuns.$inferSelect;
  fallback: Pick<AdapterFallbackConfig, "command" | "provider" | "model" | "maxAttempts">;
}) {
  const context = parseObject(input.run.contextSnapshot);
  const fallbackAttempt = resolveAdapterFallbackAttempt(context);
  if (fallbackAttempt >= input.fallback.maxAttempts) return false;

  const activeFallbackCommand = readNonEmptyString(context.fallbackCommand);
  const activeFallbackProvider = readNonEmptyString(context.fallbackProvider);
  const activeFallbackModel = readNonEmptyString(context.fallbackModel);
  const fallbackProvider = input.fallback.provider ?? null;
  const fallbackModel = input.fallback.model ?? null;
  const isSameFallbackCommand = activeFallbackCommand === input.fallback.command;
  const isSameFallbackRoute =
    isSameFallbackCommand &&
    activeFallbackProvider === fallbackProvider &&
    activeFallbackModel === fallbackModel;
  const isFallbackRun = readNonEmptyString(context.wakeReason) === "adapter_fallback";
  if (isFallbackRun && isSameFallbackRoute && isTerminalAdapterFallbackConfigurationFailure(input.run)) {
    return false;
  }

  return true;
}

// A positive liveness check means some process currently owns the PID.
// On Linux, PIDs can be recycled, so this is a best-effort signal rather
// than proof that the original child is still alive.
function isProcessAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return false;
  }
}

function terminateRecordedProcess(pid: number | null | undefined, signal: NodeJS.Signals = "SIGTERM") {
  if (!isProcessAlive(pid)) return false;
  try {
    process.kill(pid as number, signal);
    return true;
  } catch {
    return false;
  }
}

function truncateDisplayId(value: string | null | undefined, max = 128) {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function normalizeAgentNameKey(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

const defaultSessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    const asObj = parseObject(raw);
    if (Object.keys(asObj).length > 0) return asObj;
    const sessionId = readNonEmptyString((raw as Record<string, unknown> | null)?.sessionId);
    if (sessionId) return { sessionId };
    return null;
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params || Object.keys(params).length === 0) return null;
    return params;
  },
  getDisplayId(params: Record<string, unknown> | null) {
    return readNonEmptyString(params?.sessionId);
  },
};

function getAdapterSessionCodec(adapterType: string) {
  const adapter = getServerAdapter(adapterType);
  return adapter.sessionCodec ?? defaultSessionCodec;
}

function buildMissionSessionSecretName(input: {
  missionId: string;
  agentId: string;
  adapterType: string;
}) {
  return `mission-session:${input.missionId}:${input.agentId}:${input.adapterType}`;
}

function normalizeSessionParams(params: Record<string, unknown> | null | undefined) {
  if (!params) return null;
  return Object.keys(params).length > 0 ? params : null;
}

export type MissionSessionAuthorityDecision = {
  missionKnown: boolean;
  defaultAuthority: "mission_session" | "task_session" | "runtime_state" | "none";
  compatibilitySeedSessionId: string | null;
  preferredSessionId: string | null;
};

export function resolveMissionSessionAuthorityDecision(input: {
  missionId?: string | null;
  missionSessionId?: string | null;
  taskSessionDisplayId?: string | null;
  taskSessionLegacySessionId?: string | null;
  runtimeSessionId?: string | null;
  resetTaskSession?: boolean;
}): MissionSessionAuthorityDecision {
  const missionId = readNonEmptyString(input.missionId);
  const resetTaskSession = input.resetTaskSession === true;
  const taskSessionDisplayId = truncateDisplayId(readNonEmptyString(input.taskSessionDisplayId));
  const taskSessionLegacySessionId = readNonEmptyString(input.taskSessionLegacySessionId);
  const runtimeSessionId = readNonEmptyString(input.runtimeSessionId);

  if (missionId) {
    return {
      missionKnown: true,
      defaultAuthority: "mission_session",
      compatibilitySeedSessionId:
        resetTaskSession ? null : (taskSessionDisplayId ?? taskSessionLegacySessionId ?? null),
      preferredSessionId: readNonEmptyString(input.missionSessionId),
    };
  }

  if (resetTaskSession) {
    return {
      missionKnown: false,
      defaultAuthority: "none",
      compatibilitySeedSessionId: null,
      preferredSessionId: null,
    };
  }

  const taskSessionId = taskSessionDisplayId ?? taskSessionLegacySessionId ?? null;
  if (taskSessionId) {
    return {
      missionKnown: false,
      defaultAuthority: "task_session",
      compatibilitySeedSessionId: null,
      preferredSessionId: taskSessionId,
    };
  }

  if (runtimeSessionId) {
    return {
      missionKnown: false,
      defaultAuthority: "runtime_state",
      compatibilitySeedSessionId: null,
      preferredSessionId: runtimeSessionId,
    };
  }

  return {
    missionKnown: false,
    defaultAuthority: "none",
    compatibilitySeedSessionId: null,
    preferredSessionId: null,
  };
}

function resolveNextSessionState(input: {
  codec: AdapterSessionCodec;
  adapterResult: AdapterExecutionResult;
  previousParams: Record<string, unknown> | null;
  previousDisplayId: string | null;
  previousLegacySessionId: string | null;
}) {
  const { codec, adapterResult, previousParams, previousDisplayId, previousLegacySessionId } = input;

  if (adapterResult.clearSession) {
    return {
      params: null as Record<string, unknown> | null,
      displayId: null as string | null,
      legacySessionId: null as string | null,
    };
  }

  const explicitParams = adapterResult.sessionParams;
  const hasExplicitParams = adapterResult.sessionParams !== undefined;
  const hasExplicitSessionId = adapterResult.sessionId !== undefined;
  const explicitSessionId = readNonEmptyString(adapterResult.sessionId);
  const hasExplicitDisplay = adapterResult.sessionDisplayId !== undefined;
  const explicitDisplayId = readNonEmptyString(adapterResult.sessionDisplayId);
  const shouldUsePrevious = !hasExplicitParams && !hasExplicitSessionId && !hasExplicitDisplay;

  const candidateParams =
    hasExplicitParams
      ? explicitParams
      : hasExplicitSessionId
        ? (explicitSessionId ? { sessionId: explicitSessionId } : null)
        : previousParams;

  const serialized = normalizeSessionParams(codec.serialize(normalizeSessionParams(candidateParams) ?? null));
  const deserialized = normalizeSessionParams(codec.deserialize(serialized));

  const displayId = truncateDisplayId(
    explicitDisplayId ??
      (codec.getDisplayId ? codec.getDisplayId(deserialized) : null) ??
      readNonEmptyString(deserialized?.sessionId) ??
      (shouldUsePrevious ? previousDisplayId : null) ??
      explicitSessionId ??
      (shouldUsePrevious ? previousLegacySessionId : null),
  );

  const legacySessionId =
    explicitSessionId ??
    readNonEmptyString(deserialized?.sessionId) ??
    displayId ??
    (shouldUsePrevious ? previousLegacySessionId : null);

  return {
    params: serialized,
    displayId,
    legacySessionId,
  };
}

function containsToolLimitLifecycleFailure(run: typeof heartbeatRuns.$inferSelect) {
  const text = [run.stdoutExcerpt, run.stderrExcerpt, run.error].filter(Boolean).join("\n");
  return /reached maximum iterations|tool[-\s]?call limit|tool capacity|could not post|couldn't post|not able to post|before i could post|could not .*mark|couldn't .*mark/iu.test(text);
}

function buildMissionChildRunOutputComment(run: typeof heartbeatRuns.$inferSelect) {
  const stdout = (run.stdoutExcerpt ?? "").trim();
  const stderr = (run.stderrExcerpt ?? "").trim();
  const output = [stdout, stderr ? `stderr:\n${stderr}` : ""]
    .filter((value) => value.length > 0)
    .join("\n\n")
    .trim();
  const excerpt =
    output.length > MISSION_CHILD_RUN_OUTPUT_COMMENT_MAX_CHARS
      ? `${output.slice(output.length - MISSION_CHILD_RUN_OUTPUT_COMMENT_MAX_CHARS)}`
      : output;
  return [
    "## 자동 캡처: delegated run output",
    `- 실행 runId: \`${run.id}\``,
    "- 감지: delegated mission issue run이 succeeded로 종료됐지만 issue lifecycle/comment가 명시적으로 마감되지 않았습니다.",
    "- 조치: run transcript 산출물을 이 comment로 캡처하고 issue를 done으로 전이합니다.",
    "",
    "### Captured output",
    "```text",
    excerpt || "(no stdout/stderr excerpt captured)",
    "```",
  ].join("\n");
}

type RequestChangesVerdict = {
  excerpt: string;
};

function stringifyRunResultJson(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractRequestChangesVerdict(run: typeof heartbeatRuns.$inferSelect): RequestChangesVerdict | null {
  const result = parseObject(run.resultJson);
  const candidates = [
    readNonEmptyString(result.verdict),
    readNonEmptyString(result.decision),
    readNonEmptyString(result.outcome),
    readNonEmptyString(result.status),
    readNonEmptyString(result.result),
    ...extractCodexTaskCompleteMessages(readNonEmptyString(result.stdout)),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  let requestChangesCandidate: string | null = null;
  for (const candidate of candidates) {
    const verdict = readExplicitValidationVerdict(candidate, { allowLeadingVerdict: true });
    if (verdict === "pass") return null;
    if (verdict === "request_changes") {
      requestChangesCandidate = candidate;
      break;
    }
  }

  if (!requestChangesCandidate) return null;

  return {
    excerpt:
      requestChangesCandidate.length > MISSION_CHILD_RUN_OUTPUT_COMMENT_MAX_CHARS
        ? requestChangesCandidate.slice(requestChangesCandidate.length - MISSION_CHILD_RUN_OUTPUT_COMMENT_MAX_CHARS)
        : requestChangesCandidate,
  };
}

function buildRequestChangesValidationGateComment(input: {
  run: typeof heartbeatRuns.$inferSelect;
  verdict: RequestChangesVerdict;
}) {
  return [
    "## Mission validation gate: REQUEST_CHANGES",
    `- 실행 runId: \`${input.run.id}\``,
    "- 감지: validator/QA run은 succeeded로 종료됐지만 산출물 verdict가 `REQUEST_CHANGES`입니다.",
    "- 조치: delivery를 통과시키지 않고 source issue를 `blocked`로 전이합니다.",
    "- follow-up: mission owner unblock issue를 생성/재사용하고 owner agent를 wakeup합니다.",
    "",
    "### Verdict excerpt",
    "```text",
    input.verdict.excerpt || "REQUEST_CHANGES",
    "```",
  ].join("\n");
}

function buildRequestChangesOwnerActionDescription(input: {
  mission: Pick<typeof missions.$inferSelect, "title">;
  sourceIssue: Pick<typeof issues.$inferSelect, "id" | "identifier" | "title">;
  run: typeof heartbeatRuns.$inferSelect;
  verdict: RequestChangesVerdict;
  missionExecutionDigest?: string[];
}) {
  const sourceLabel = input.sourceIssue.identifier ?? input.sourceIssue.id;
  const missionExecutionDigest = (input.missionExecutionDigest ?? [])
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return [
    "Mission-owner signal from validation gate. Automation has not selected a recovery action.",
    "",
    `Source issue: ${sourceLabel} — ${input.sourceIssue.title}`,
    `Source runId: ${input.run.id}`,
    "",
    "Signal:",
    "- kind: validation_request_changes",
    "- local hint only; the raw validation excerpt is preserved below",
    "",
    missionExecutionDigest.length > 0
      ? ["Mission execution digest:", ...missionExecutionDigest.map((line) => `- ${line}`)].join("\n")
      : "Mission execution digest: unavailable for this owner action template.",
    "",
    buildMainExecutorBrief({
      missionGoal: input.mission.title,
      currentSituation: `Source issue ${sourceLabel} produced REQUEST_CHANGES after run ${input.run.id}; downstream delivery remains gated until owner judgement.`,
    }),
    "",
    "### Validation excerpt",
    "```text",
    input.verdict.excerpt || "REQUEST_CHANGES",
    "```",
  ].join("\n");
}

const CLAIMED_ARTIFACT_EXTENSION_PATTERN = "md|markdown|json|html|htm|pdf|png|jpg|jpeg|webp|svg|csv|txt|docx|pptx|xlsx";
const CLAIMED_ARTIFACT_JSON_PATH_RE = new RegExp(
  `"(?:outputPath|artifactPath|documentPath|filePath|path|url)"\\s*:\\s*"([^"]+\\.(?:${CLAIMED_ARTIFACT_EXTENSION_PATTERN}))"`,
  "giu",
);
const CLAIMED_ARTIFACT_ABSOLUTE_PATH_RE = new RegExp(
  `(/[^\\r\\n\`'"]+?\\.(?:${CLAIMED_ARTIFACT_EXTENSION_PATTERN}))(?=$|[\\s\`'"\\\\,}\\]])`,
  "giu",
);

function normalizeClaimedArtifactPath(value: string): string {
  return value
    .trim()
    .replace(/^[-*•]\s*/, "")
    .replace(/^`+|`+$/g, "")
    .replace(/[),.;:]+$/g, "")
    .trim();
}

export function isActionableClaimedArtifactPath(value: string): boolean {
  if (!value.startsWith("/")) return false;
  if (value.includes("\\n") || value.includes("\\r") || /[\r\n]/u.test(value)) return false;
  if (/[<>]/u.test(value)) return false;
  if (/\{\$date\}|YYYY(?:MM|-MM-DD)?|MMDD/u.test(value)) return false;

  const nonDeliverablePathMarkers = [
    "/papercompany-runtime/skills/",
    "/papercompany-operations/scripts/paperclip-addon/agents/",
    "/instructions/",
    "/node_modules/",
    "/.git/",
    "/data/",
    "/input/",
    "/source/",
    "/sources/",
  ];
  if (nonDeliverablePathMarkers.some((marker) => value.includes(marker))) return false;
  if (/(?:^|\/)(?:AGENTS|CLAUDE|SKILL)\.md$/u.test(value)) return false;
  if (/(?:^|\/)\.cursorrules$/u.test(value)) return false;

  return true;
}

export function extractClaimedArtifactPaths(run: Pick<typeof heartbeatRuns.$inferSelect, "resultJson" | "stdoutExcerpt" | "stderrExcerpt">): string[] {
  const text = [stringifyRunResultJson(run.resultJson), run.stdoutExcerpt, run.stderrExcerpt]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
  if (!text.trim()) return [];

  const paths = new Set<string>();
  for (const artifactPath of extractExplicitArtifactPaths(text)) {
    if (isActionableClaimedArtifactPath(artifactPath)) paths.add(artifactPath);
  }
  for (const match of text.matchAll(CLAIMED_ARTIFACT_JSON_PATH_RE)) {
    const value = normalizeClaimedArtifactPath(match[1] ?? "");
    if (value && isActionableClaimedArtifactPath(value)) paths.add(value);
  }
  for (const match of text.matchAll(CLAIMED_ARTIFACT_ABSOLUTE_PATH_RE)) {
    const value = normalizeClaimedArtifactPath(match[1] ?? "");
    if (value && isActionableClaimedArtifactPath(value)) paths.add(value);
  }
  return [...paths].slice(0, 10);
}

function buildMissingWorkProductRegistrationGateComment(input: {
  run: typeof heartbeatRuns.$inferSelect;
  claimedArtifactPaths: string[];
  allowedArtifactRoot?: string | null;
}) {
  const paths = input.claimedArtifactPaths.length > 0
    ? input.claimedArtifactPaths.map((artifactPath) => `- ${artifactPath}`).join("\n")
    : "- (artifact path not captured)";
  return [
    "## Mission artifact gate: workProduct registration missing",
    `- 실행 runId: \`${input.run.id}\``,
    "- 감지: run은 succeeded로 종료됐고 산출물 파일 경로를 보고했지만, issue에 공식 `workProduct`가 등록되어 있지 않습니다.",
    "- 조치: downstream workflow가 비공식 comment 경로만 보고 진행하지 않도록 source issue를 `blocked`로 전이합니다.",
    "- 복구: 아래 파일을 이 issue의 `workProduct`로 등록한 뒤 workflow를 resume하세요.",
    input.allowedArtifactRoot
      ? `- 허용 경로: 이 mission의 local workProduct는 \`${input.allowedArtifactRoot}\` 아래에 있어야 합니다.`
      : null,
    "",
    "### Claimed artifact paths",
    paths,
  ].filter((line) => line !== null).join("\n");
}

export type HeartbeatFailureClassification = {
  category: "timeout" | "cancelled" | "overload" | "quota" | "auth" | "command" | "adapter";
  reasonCode: string;
  summary: string;
  fallbackCandidates: string[];
};

function heartbeatRunFailureText(input: {
  errorCode?: string | null;
  errorMessage?: string | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
}) {
  return [input.errorCode, input.errorMessage, input.stdoutExcerpt, input.stderrExcerpt]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();
}

export function classifyHeartbeatRunFailure(input: {
  status: string;
  adapterType?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
  provider?: string | null;
  model?: string | null;
  command?: string | null;
}): HeartbeatFailureClassification {
  const haystack = heartbeatRunFailureText(input);
  const normalized = haystack.toLowerCase();
  const providerModelCommand = [input.provider, input.model, input.command, input.adapterType]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
  const fallbackCandidates: string[] = [];
  const pushFallback = (candidate: string) => {
    if (!fallbackCandidates.includes(candidate)) fallbackCandidates.push(candidate);
  };
  const looksKimiOrMimo = /\b(kimi|moonshot|mimo)\b/i.test(`${providerModelCommand}\n${haystack}`);
  if (looksKimiOrMimo) {
    pushFallback("mimo26pro command/model if configured with available quota");
    pushFallback("same-role alternate agent on a non-Kimi provider");
  }

  if (input.status === "timed_out") {
    return { category: "timeout", reasonCode: "RUN_TIMED_OUT", summary: "Heartbeat run timed out.", fallbackCandidates };
  }
  if (input.status === "cancelled") {
    return { category: "cancelled", reasonCode: "RUN_CANCELLED", summary: "Heartbeat run was cancelled.", fallbackCandidates };
  }
  // API overload(500/503/529): errorCode 를 우선 매칭한다. stderr 의 무해한
  // "ENOENT: no such"(참조 instructions 파일 누락 워닝) 가 haystack 에 섞여 아래 command
  // 분기로 오판되는 것(gazua 코난 529 run 사례) 을 막기 위해 errorCode 기반으로 먼저 잡는다.
  // 일시 overload 는 adapter 의 backoff 재시도로 극복 가능(transient) 하므로 command 가 아님.
  // 429 는 아래 quota 분기가 처리하도록 둔다.
  const overloadApiStatus = /claude_api_error_(\d+)/i.exec(input.errorCode ?? "")?.[1];
  const isOverloadApiStatus = overloadApiStatus === "500" || overloadApiStatus === "503" || overloadApiStatus === "529";
  const isOverloadMessage = /overloaded|temporarily overloaded|service is currently/i.test(input.errorMessage ?? "");
  if (isOverloadApiStatus || isOverloadMessage) {
    return {
      category: "overload",
      reasonCode: overloadApiStatus ? `PROVIDER_OVERLOADED_${overloadApiStatus}` : "PROVIDER_OVERLOADED",
      summary: "Provider temporarily overloaded (transient). Retry/backoff applicable; not a command/path/permission issue.",
      fallbackCandidates,
    };
  }
  if (/\b(403|429)\b/.test(normalized) && /quota|rate.?limit|rate limit|insufficient|billing|capacity|exceeded/.test(normalized)) {
    return {
      category: "quota",
      reasonCode: /\b403\b/.test(normalized) ? "PROVIDER_QUOTA_OR_AUTH_403" : "PROVIDER_QUOTA_OR_RATE_LIMIT",
      summary: "Provider quota/rate-limit/auth-capacity failure detected from run output.",
      fallbackCandidates,
    };
  }
  if (/quota|insufficient_quota|rate.?limit|rate limit|billing hard limit|credits? exhausted|capacity exceeded/.test(normalized)) {
    return {
      category: "quota",
      reasonCode: "PROVIDER_QUOTA_OR_RATE_LIMIT",
      summary: "Provider quota or rate-limit failure detected from run output.",
      fallbackCandidates,
    };
  }
  if (/\b401\b|unauthorized|invalid api key|invalid token|authentication failed|reauth|required|login required|forbidden/.test(normalized)) {
    return {
      category: "auth",
      reasonCode: /\b403\b/.test(normalized) ? "PROVIDER_AUTH_OR_FORBIDDEN_403" : "PROVIDER_AUTH_FAILURE",
      summary: "Provider authentication/authorization failure detected from run output.",
      fallbackCandidates,
    };
  }
  if (/enoent|command not found|spawn .* enoent|no such file or directory|eacces|permission denied|not executable/.test(normalized)) {
    return {
      category: "command",
      reasonCode: "COMMAND_EXECUTION_FAILURE",
      summary: "Adapter command/path/permission failure detected from run output.",
      fallbackCandidates,
    };
  }
  return {
    category: "adapter",
    reasonCode: input.errorCode?.trim() || "ADAPTER_RUN_FAILED",
    summary: "Adapter run failed without a more specific local classification.",
    fallbackCandidates,
  };
}

function buildSuccessfulIssueRunAutoCompletedComment(run: typeof heartbeatRuns.$inferSelect) {
  const output = [run.stdoutExcerpt, run.stderrExcerpt ? `stderr:\n${run.stderrExcerpt}` : ""]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n\n")
    .trim();
  const planDecisionOutput = extractMissionOwnerPlanDecisionOutput(output);
  return [
    "## 자동 완료: checked-out run succeeded",
    `- 실행 runId: \`${run.id}\``,
    "- 감지: 이 issue에 연결된 heartbeat run이 succeeded로 종료되었습니다.",
    "- 정책: 일반 issue lifecycle은 successful checked-out run 종료 시 done으로 closeout합니다.",
    "- 참고: coordination hub로 계속 열어둘 작업은 별도 issue type/status로 분리해야 합니다.",
    planDecisionOutput
      ? [
          "",
          "### Captured PLAN decision output",
          planDecisionOutput,
        ].join("\n")
      : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function extractMissionOwnerPlanDecisionOutput(output: string): string | null {
  const candidates: string[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== "object") continue;
      const record = parsed as Record<string, unknown>;
      if (typeof record.result === "string") {
        candidates.push(record.result);
      }
      const message = record.message;
      if (message && typeof message === "object") {
        const content = (message as Record<string, unknown>).content;
        if (Array.isArray(content)) {
          for (const entry of content) {
            if (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).text === "string") {
              candidates.push((entry as Record<string, string>).text);
            }
          }
        }
      }
    } catch {
      // Non-JSON log lines are expected in adapter output.
    }
  }
  candidates.push(output);

  for (const candidate of candidates.reverse()) {
    const extracted = extractMissionOwnerPlanDecisionBlock(candidate);
    if (extracted) return extracted;
  }
  return null;
}

function extractMissionOwnerPlanDecisionBlock(text: string): string | null {
  const normalizedText = normalizeEscapedMissionOwnerPlanDecisionMarkdown(text);
  const headingIndex = normalizedText.lastIndexOf("### Mission owner plan decision");
  if (headingIndex < 0) return null;
  const block = normalizedText.slice(headingIndex).trim();
  const fenceIndex = block.search(/```json\s*/iu);
  if (fenceIndex < 0) return block;
  const openingFenceEnd = block.indexOf("\n", fenceIndex);
  if (openingFenceEnd < 0) return block;
  const closingFenceIndex = block.indexOf("```", openingFenceEnd + 1);
  if (closingFenceIndex < 0) return block;
  return block.slice(0, closingFenceIndex + 3).trim();
}

function normalizeEscapedMissionOwnerPlanDecisionMarkdown(text: string): string {
  if (!text.includes("### Mission owner plan decision") || !text.includes("\\n")) return text;
  return text
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\");
}

async function recordMissionOwnerPlanDecisionAfterComment(
  db: Db,
  issue: Pick<typeof issues.$inferSelect, "id" | "companyId" | "missionId" | "originKind">,
  actorAgentId: string | null,
  enqueuePlanQaWakeup?: PlanQaWakeupHandler,
) {
  if (
    issue.originKind !== "mission_main_executor_plan" &&
    issue.originKind !== "mission_plan_qa"
  ) return;
  if (!issue.missionId) return;
  try {
    await recordLatestAuthorizedMissionOwnerPlanDecision({
      db,
      companyId: issue.companyId,
      missionId: issue.missionId,
      requestedBy: actorAgentId ? { actorType: "agent", actorId: actorAgentId } : undefined,
      enqueuePlanQaWakeup,
    });
  } catch (err) {
    logger.warn(
      { err, issueId: issue.id, companyId: issue.companyId, missionId: issue.missionId },
      "failed to record mission owner plan decision after heartbeat issue comment",
    );
  }
}

function buildFailedIssueRunAutoBlockedComment(input: {
  run: typeof heartbeatRuns.$inferSelect;
  classification: HeartbeatFailureClassification;
}) {
  const { run, classification } = input;
  const rawReason = (run.error ?? run.stderrExcerpt ?? run.stdoutExcerpt ?? "").trim();
  const reasonExcerpt = rawReason.length > 1200 ? rawReason.slice(0, 1200) : rawReason;
  const recoveryLines = buildRunRecoveryLines(run);
  return [
    "## 자동 차단: linked run ended with failure",
    `- 실행 runId: \`${run.id}\``,
    `- run status: \`${run.status}\``,
    `- 분류: \`${classification.reasonCode}\` (${classification.category})`,
    `- 요약: ${classification.summary}`,
    ...recoveryLines,
    classification.fallbackCandidates.length > 0
      ? `- fallback/대체 후보: ${classification.fallbackCandidates.map((candidate) => `\`${candidate}\``).join(", ")}`
      : "- fallback/대체 후보: 자동 선택 안 함 — owner/oversight 재검토 필요",
    reasonExcerpt ? ["", "### Failure excerpt", "```text", reasonExcerpt, "```"].join("\n") : "",
  ].filter((line) => line.length > 0).join("\n");
}

function buildRunRecoveryLines(run: typeof heartbeatRuns.$inferSelect) {
  const context = parseObject(run.contextSnapshot);
  const lines: string[] = [];
  if (run.errorCode === "process_lost") {
    const retryCount = run.processLossRetryCount ?? 0;
    const fallbackAttempt = resolveAdapterFallbackAttempt(context);
    lines.push(`- 복구 상태: process_lost retry ${retryCount}/1, adapter fallback ${fallbackAttempt}회 시도됨`);
    if (run.retryOfRunId) lines.push(`- 이전 run: \`${run.retryOfRunId}\``);
    const fallbackOfRunId = readNonEmptyString(context.fallbackOfRunId);
    if (fallbackOfRunId) lines.push(`- fallback 기준 run: \`${fallbackOfRunId}\``);
    if (retryCount >= 1 && fallbackAttempt > 0) {
      lines.push("- 판정: 자동 retry/fallback 한도를 소진하여 동일 issue를 계속 반복 실행하지 않고 차단함");
    } else if (retryCount >= 1) {
      lines.push("- 판정: 자동 retry 한도를 소진하여 동일 issue를 계속 반복 실행하지 않고 차단함");
    }
  }
  return lines;
}

function buildMissionWorkerFailureOversightComment(input: {
  run: typeof heartbeatRuns.$inferSelect;
  sourceIssue: { id: string; identifier: string | null; title: string };
  classification: HeartbeatFailureClassification;
}) {
  const issueLabel = input.sourceIssue.identifier ?? input.sourceIssue.id;
  return [
    "## Mission oversight: worker run failure observed",
    `- source issue: \`${issueLabel}\` — ${input.sourceIssue.title}`,
    `- failed runId: \`${input.run.id}\``,
    `- run status: \`${input.run.status}\``,
    `- classification: \`${input.classification.reasonCode}\` (${input.classification.category})`,
    `- summary: ${input.classification.summary}`,
    ...buildRunRecoveryLines(input.run),
    input.classification.fallbackCandidates.length > 0
      ? `- fallback candidates: ${input.classification.fallbackCandidates.map((candidate) => `\`${candidate}\``).join(", ")}`
      : "- fallback candidates: none auto-selected; owner should decide retry/reassign/escalate.",
    "- policy: issue was moved out of in_progress so the mission owner can inspect and decide next action.",
  ].join("\n");
}

function buildMissionOversightRunFailureComment(input: {
  run: typeof heartbeatRuns.$inferSelect;
  classification: HeartbeatFailureClassification;
}) {
  return [
    "## Mission oversight run failed but the supervisor issue remains open",
    `- failed runId: \`${input.run.id}\``,
    `- run status: \`${input.run.status}\``,
    `- classification: \`${input.classification.reasonCode}\` (${input.classification.category})`,
    `- summary: ${input.classification.summary}`,
    input.classification.fallbackCandidates.length > 0
      ? `- fallback candidates: ${input.classification.fallbackCandidates.map((candidate) => `\`${candidate}\``).join(", ")}`
      : "- fallback candidates: none auto-selected; owner should decide retry/reassign/escalate.",
    "- policy: mission oversight is the supervisor for this mission, so a failed oversight run releases the issue back to todo instead of blocking the supervisor itself.",
  ].join("\n");
}

function buildMissionOversightRunSucceededReleaseComment(run: typeof heartbeatRuns.$inferSelect, missionStatus: string) {
  return [
    "## Mission oversight run succeeded and the supervisor issue remains open",
    `- succeeded runId: \`${run.id}\``,
    `- mission status: \`${missionStatus}\``,
    "- policy: mission oversight stays alive until the mission is completed or cancelled, so this successful cycle releases the issue back to todo instead of closing it.",
  ].join("\n");
}

/**
 * [목적] fireWikiRecord — agent 자가학습 wiki에 실패 패턴을 기록한다. fire-and-forget(non-blocking):
 *   recordFailure를 await하지 않고 .catch로 에러를 삼켜, wiki 로깅이 절대 main flow를
 *   깨뜨리지 않도록 한다(activity-log.ts의 plugin event fanout .catch 선례와 동일 패턴).
 * [입력] wiki: agentWikiService(db) 인스턴스. input: RecordFailureInput. runIdForLog: 로깅용 run id.
 * [수정시 영향] 호출부는 모두 heartbeatService 클로저 내부. 에러는 logger.warn으로만 남는다.
 */
function fireWikiRecord(
  wiki: ReturnType<typeof agentWikiService>,
  input: RecordFailureInput,
  runIdForLog?: string,
): void {
  void wiki
    .recordFailure(input)
    .catch((err: unknown) =>
      logger.warn(
        { err, runId: runIdForLog, pattern: input.pattern },
        "agent-wiki.recordFailure non-blocking failure",
      ),
    );
}

export function heartbeatService(db: Db) {
  const instanceSettings = instanceSettingsService(db);
  const getCurrentUserRedactionOptions = async () => ({
    enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
  });

  const runLogStore = getRunLogStore();
  const secretsSvc = secretService(db);
  const companySkills = companySkillService(db);
  const issuesSvc = issueService(db);
  const wikiSvc = agentWikiService(db);
  const executionWorkspacesSvc = executionWorkspaceService(db);
  const workspaceOperationsSvc = workspaceOperationService(db);
  const enqueuePlanQaWakeup = createPlanQaWakeupHandler(
    { wakeup: (agentId, opts) => enqueueWakeup(agentId, opts) },
    { requestedByActorId: "heartbeat-plan-qa", contextSource: "heartbeat_plan_qa" },
  );
  const activeRunExecutions = new Set<string>();
  const budgetHooks = {
    cancelWorkForScope: cancelBudgetScopeWork,
  };
  const budgets = budgetService(db, budgetHooks);
  const worktreeHarness = createWorktreeHarness(db);

  /**
   * worktreeCheck — call worktreeHarness.checkAction, re-throwing MUST violations.
   * SHOULD violations are logged by the harness internally; MAY violations are audit-logged.
   */
  async function worktreeCheck(opts: {
    agent: { id: string; companyId: string };
    tool: string;
    args: Record<string, unknown>;
    cwd?: string;
    filePath?: string;
    command?: string;
  }): Promise<void> {
    try {
      await worktreeHarness.checkAction({
        companyId: opts.agent.companyId,
        agentId: opts.agent.id,
        tool: opts.tool,
        args: opts.args,
        cwd: opts.cwd,
        filePath: opts.filePath,
        command: opts.command,
      });
    } catch (err) {
      // WorktreeViolation bubbles up as MUST violation → fail the operation
      if (err instanceof WorktreeViolation) {
        throw err;
      }
      // Unexpected error — re-throw
      throw err;
    }
  }

  function isMissionOwnerActionParentPlacementRejected(error: unknown) {
    return error instanceof HttpError &&
      error.status === 422 &&
      (
        error.message.includes("Mission downstream issue creation is not allowed") ||
        error.message.includes("Mission nested child issue creation is not allowed") ||
        error.message.includes("Mission child issue burst limit exceeded")
      );
  }

  async function createMissionOwnerActionIssue(companyId: string, data: IssueCreateInput) {
    if (!data.parentId) return issuesSvc.create(companyId, data);
    try {
      return await issuesSvc.create(companyId, data);
    } catch (error) {
      if (!isMissionOwnerActionParentPlacementRejected(error)) throw error;
      const { parentId: _parentId, ...flatData } = data;
      logger.warn({
        err: error,
        companyId,
        missionId: data.missionId,
        originKind: data.originKind,
        originId: data.originId,
        rejectedParentId: data.parentId,
      }, "mission owner action parent placement rejected; creating flat owner action with origin link");
      return issuesSvc.create(companyId, flatData);
    }
  }

  async function getAgent(agentId: string) {
    return db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function getRun(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function ensureMissionOwnerActionForRequestChanges(input: {
    sourceIssue: Pick<typeof issues.$inferSelect, "id" | "companyId" | "missionId" | "identifier" | "title" | "originKind" | "status" | "assigneeAgentId" | "parentId">;
    run: typeof heartbeatRuns.$inferSelect;
    verdict: RequestChangesVerdict;
  }) {
    if (!input.sourceIssue.missionId) return null;
    if (!canCreateMissionOwnerUnblockForRequestChanges(input.sourceIssue)) return null;
    const mission = await db
      .select()
      .from(missions)
      .where(and(eq(missions.id, input.sourceIssue.missionId), eq(missions.companyId, input.sourceIssue.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!mission?.ownerAgentId) return null;
    let missionExecutionDigest: string[] = [];
    try {
      missionExecutionDigest = await buildMissionExecutionDigest(db, {
        mission,
        blockedIssue: input.sourceIssue,
      });
    } catch (err) {
      logger.warn(
        { err, missionId: input.sourceIssue.missionId, issueId: input.sourceIssue.id },
        "failed to build mission execution digest for REQUEST_CHANGES owner action",
      );
      missionExecutionDigest = ["Mission execution digest could not be built; inspect workflow runs, step runs, work products, and source issue comments manually."];
    }

    const existing = await db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, input.sourceIssue.companyId),
        eq(issues.missionId, input.sourceIssue.missionId),
        eq(issues.originKind, "mission_main_executor_unblock"),
        eq(issues.originId, input.sourceIssue.id),
        sql`${issues.hiddenAt} is null`,
        not(inArray(issues.status, ["done", "cancelled"])),
      ))
      .orderBy(asc(issues.createdAt), asc(issues.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    const sourceLabel = input.sourceIssue.identifier ?? input.sourceIssue.id;
    const nextDescription = buildRequestChangesOwnerActionDescription({
      ...input,
      mission,
      missionExecutionDigest,
    });
    if (existing && !(existing.description ?? "").includes("Mission execution digest:")) {
      await db
        .update(issues)
        .set({ description: nextDescription, updatedAt: new Date() })
        .where(eq(issues.id, existing.id));
      existing.description = nextDescription;
    }
    const ownerActionParentId = input.sourceIssue.parentId ? undefined : input.sourceIssue.id;
    const ownerAction = existing ?? await createMissionOwnerActionIssue(input.sourceIssue.companyId, {
      assigneeAgentId: mission.ownerAgentId,
      description: nextDescription,
      missionId: input.sourceIssue.missionId,
      originKind: "mission_main_executor_unblock",
      originId: input.sourceIssue.id,
      parentId: ownerActionParentId,
      priority: "high",
      status: "todo",
      title: `[Unblock] ${sourceLabel}: ${input.sourceIssue.title}`,
    });

    try {
      await enqueueWakeup(mission.ownerAgentId, {
        source: "automation",
        triggerDetail: "mission_validation_request_changes",
        reason: "mission_validation_request_changes",
        idempotencyKey: `mission-validation-request-changes:${input.run.id}:${ownerAction.id}`,
        requestedByActorType: "system",
        requestedByActorId: "heartbeat",
        payload: {
          issueId: ownerAction.id,
          sourceIssueId: input.sourceIssue.id,
          sourceRunId: input.run.id,
          verdict: "REQUEST_CHANGES",
        },
        contextSnapshot: {
          taskKey: `issue:${ownerAction.id}`,
          issueId: ownerAction.id,
          missionId: input.sourceIssue.missionId,
          sourceIssueId: input.sourceIssue.id,
          sourceRunId: input.run.id,
          wakeReason: "mission_validation_request_changes",
        },
      });
    } catch (err) {
      logger.warn(
        { err, missionId: input.sourceIssue.missionId, issueId: ownerAction.id, sourceIssueId: input.sourceIssue.id },
        "failed to wake mission owner after REQUEST_CHANGES validation gate",
      );
    }

    return ownerAction;
  }

  async function deferOperationsMissionIssueToMainExecutor(input: {
    agent: typeof agents.$inferSelect;
    issueId: string;
    missionId: string;
  }) {
    if (!isHermesOperationsLiaisonAgent(input.agent)) return null;

    const issue = await db
      .select()
      .from(issues)
      .where(and(
        eq(issues.id, input.issueId),
        eq(issues.companyId, input.agent.companyId),
        eq(issues.missionId, input.missionId),
      ))
      .then((rows) => rows[0] ?? null);
    if (!issue) return null;

    const mission = await db
      .select()
      .from(missions)
      .where(and(eq(missions.id, input.missionId), eq(missions.companyId, input.agent.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!mission?.ownerAgentId) return null;

    const now = new Date();
    const sourceLabel = issue.identifier ?? issue.id;
    const roleEvidence = [
      `Hermes Ops boundary: ${input.agent.name} is chief_of_staff_liaison; it may monitor and report, but must not directly execute mission issue ${sourceLabel}.`,
      "Required routing: signal the mission main executor. The main executor decides recovery, re-dispatch, replan, escalation, or no action.",
    ];

    let ownerAction = issue;
    if (isMissionOwnerControlIssue(issue)) {
      if (issue.assigneeAgentId !== mission.ownerAgentId) {
        ownerAction = await db
          .update(issues)
          .set({
            assigneeAgentId: mission.ownerAgentId,
            updatedAt: now,
          })
          .where(eq(issues.id, issue.id))
          .returning()
          .then((rows) => rows[0] ?? issue);
      }
    } else {
      ownerAction = await missionService(db).ensureMainExecutorUnblockIssue(mission, issue, {
        renewAfterNoActionWaiting: true,
        governanceEvidence: roleEvidence,
      });
    }

    await db.insert(activityLog).values({
      companyId: input.agent.companyId,
      actorType: "system",
      actorId: "heartbeat",
      action: "mission.ops_issue_deferred_to_main_executor",
      entityType: "issue",
      entityId: issue.id,
      agentId: input.agent.id,
      details: {
        missionId: mission.id,
        sourceIssueId: issue.id,
        sourceIssueIdentifier: sourceLabel,
        ownerAgentId: mission.ownerAgentId,
        ownerActionIssueId: ownerAction.id,
        operationsAgentRole: "chief_of_staff_liaison",
      },
    });

    return { mission, issue, ownerAction };
  }

  async function getRuntimeState(agentId: string) {
    return db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function getTaskSession(
    companyId: string,
    agentId: string,
    adapterType: string,
    taskKey: string,
  ) {
    return db
      .select()
      .from(agentTaskSessions)
      .where(
        and(
          eq(agentTaskSessions.companyId, companyId),
          eq(agentTaskSessions.agentId, agentId),
          eq(agentTaskSessions.adapterType, adapterType),
          eq(agentTaskSessions.taskKey, taskKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function ensureMissionSessionBinding(input: {
    agent: typeof agents.$inferSelect;
    missionId: string;
    adapterType: string;
    seedSessionId?: string | null;
  }) {
    const seedSessionId = readNonEmptyString(input.seedSessionId);
    const secretName = buildMissionSessionSecretName({
      missionId: input.missionId,
      agentId: input.agent.id,
      adapterType: input.adapterType,
    });
    let secret = await secretsSvc.getByName(input.agent.companyId, secretName);

    if (!secret) {
      secret = await secretsSvc.create(
        input.agent.companyId,
        {
          name: secretName,
          provider: "local_encrypted",
          value: seedSessionId ?? "",
          description: `Mission session binding for mission ${input.missionId}`,
        },
        { agentId: input.agent.id },
      );
    }

    const store = missionSessionStore(db);
    const { session } = await store.getOrCreate({
      missionId: input.missionId,
      agentId: input.agent.id,
      companyId: input.agent.companyId,
      sessionSecretId: secret.id,
      adapterType: input.adapterType,
    });

    let sessionId = readNonEmptyString(
      await secretsSvc.resolveSecretValue(input.agent.companyId, session.sessionSecretId, "latest"),
    );

    if (!sessionId && seedSessionId) {
      await secretsSvc.rotate(
        session.sessionSecretId,
        { value: seedSessionId },
        { agentId: input.agent.id },
      );
      sessionId = seedSessionId;
    }

    return { session, sessionId };
  }

  async function resolveMissionSessionAuthority(input: {
    agent: typeof agents.$inferSelect;
    missionId: string | null;
    adapterType: string;
    taskSessionDisplayId?: string | null;
    taskSessionLegacySessionId?: string | null;
    runtimeSessionId?: string | null;
    resetTaskSession?: boolean;
  }): Promise<{
    decision: MissionSessionAuthorityDecision;
    missionSessionBinding: Awaited<ReturnType<typeof ensureMissionSessionBinding>> | null;
  }> {
    const baseDecision = resolveMissionSessionAuthorityDecision({
      missionId: input.missionId,
      taskSessionDisplayId: input.taskSessionDisplayId,
      taskSessionLegacySessionId: input.taskSessionLegacySessionId,
      runtimeSessionId: input.runtimeSessionId,
      resetTaskSession: input.resetTaskSession,
    });

    if (!baseDecision.missionKnown || !input.missionId) {
      return {
        decision: baseDecision,
        missionSessionBinding: null,
      };
    }

    const missionSessionBinding = await ensureMissionSessionBinding({
      agent: input.agent,
      missionId: input.missionId,
      adapterType: input.adapterType,
      seedSessionId: baseDecision.compatibilitySeedSessionId,
    });

    return {
      decision: {
        ...baseDecision,
        preferredSessionId: missionSessionBinding.sessionId,
      },
      missionSessionBinding,
    };
  }

  async function persistMissionSessionBinding(input: {
    agent: typeof agents.$inferSelect;
    sessionSecretId: string;
    sessionId: string | null;
  }) {
    const nextValue = input.sessionId ?? "";
    const currentValue = await secretsSvc.resolveSecretValue(
      input.agent.companyId,
      input.sessionSecretId,
      "latest",
    );
    if (currentValue === nextValue) return;
    await secretsSvc.rotate(
      input.sessionSecretId,
      { value: nextValue },
      { agentId: input.agent.id },
    );
  }

  async function getLatestRunForSession(
    agentId: string,
    sessionId: string,
    opts?: { excludeRunId?: string | null },
  ) {
    const conditions = [
      eq(heartbeatRuns.agentId, agentId),
      eq(heartbeatRuns.sessionIdAfter, sessionId),
    ];
    if (opts?.excludeRunId) {
      conditions.push(sql`${heartbeatRuns.id} <> ${opts.excludeRunId}`);
    }
    return db
      .select()
      .from(heartbeatRuns)
      .where(and(...conditions))
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function getOldestRunForSession(agentId: string, sessionId: string) {
    return db
      .select({
        id: heartbeatRuns.id,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.sessionIdAfter, sessionId)))
      .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function resolveNormalizedUsageForSession(input: {
    agentId: string;
    runId: string;
    sessionId: string | null;
    rawUsage: UsageTotals | null;
  }) {
    const { agentId, runId, sessionId, rawUsage } = input;
    if (!sessionId || !rawUsage) {
      return {
        normalizedUsage: rawUsage,
        previousRawUsage: null as UsageTotals | null,
        derivedFromSessionTotals: false,
      };
    }

    const previousRun = await getLatestRunForSession(agentId, sessionId, { excludeRunId: runId });
    const previousRawUsage = readRawUsageTotals(previousRun?.usageJson);
    return {
      normalizedUsage: deriveNormalizedUsageDelta(rawUsage, previousRawUsage),
      previousRawUsage,
      derivedFromSessionTotals: previousRawUsage !== null,
    };
  }

  async function evaluateSessionCompaction(input: {
    agent: typeof agents.$inferSelect;
    sessionId: string | null;
    issueId: string | null;
  }): Promise<SessionCompactionDecision> {
    const { agent, sessionId, issueId } = input;
    if (!sessionId) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        handoffArtifact: null,
        previousRunId: null,
      };
    }

    const policy = parseSessionCompactionPolicy(agent);
    if (!policy.enabled || !hasSessionCompactionThresholds(policy)) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        handoffArtifact: null,
        previousRunId: null,
      };
    }

    const fetchLimit = Math.max(policy.maxSessionRuns > 0 ? policy.maxSessionRuns + 1 : 0, 4);
    const runs = await db
      .select({
        id: heartbeatRuns.id,
        createdAt: heartbeatRuns.createdAt,
        usageJson: heartbeatRuns.usageJson,
        resultJson: heartbeatRuns.resultJson,
        error: heartbeatRuns.error,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.sessionIdAfter, sessionId)))
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(fetchLimit);

    if (runs.length === 0) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        handoffArtifact: null,
        previousRunId: null,
      };
    }

    const latestRun = runs[0] ?? null;
    const oldestRun =
      policy.maxSessionAgeHours > 0
        ? await getOldestRunForSession(agent.id, sessionId)
        : runs[runs.length - 1] ?? latestRun;
    const latestRawUsage = readRawUsageTotals(latestRun?.usageJson);
    const sessionAgeHours =
      latestRun && oldestRun
        ? Math.max(
            0,
            (new Date(latestRun.createdAt).getTime() - new Date(oldestRun.createdAt).getTime()) / (1000 * 60 * 60),
          )
        : 0;

    let reason: string | null = null;
    if (policy.maxSessionRuns > 0 && runs.length > policy.maxSessionRuns) {
      reason = `session exceeded ${policy.maxSessionRuns} runs`;
    } else if (
      policy.maxRawInputTokens > 0 &&
      latestRawUsage &&
      latestRawUsage.inputTokens >= policy.maxRawInputTokens
    ) {
      reason =
        `session raw input reached ${formatCount(latestRawUsage.inputTokens)} tokens ` +
        `(threshold ${formatCount(policy.maxRawInputTokens)})`;
    } else if (policy.maxSessionAgeHours > 0 && sessionAgeHours >= policy.maxSessionAgeHours) {
      reason = `session age reached ${Math.floor(sessionAgeHours)} hours`;
    }

    if (!reason || !latestRun) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        handoffArtifact: null,
        previousRunId: latestRun?.id ?? null,
      };
    }

    const latestSummary = summarizeHeartbeatRunResultJson(latestRun.resultJson);
    const latestTextSummary =
      readNonEmptyString(latestSummary?.summary) ??
      readNonEmptyString(latestSummary?.result) ??
      readNonEmptyString(latestSummary?.message) ??
      readNonEmptyString(latestRun.error);

    const handoffMarkdown = [
      "Paperclip session handoff:",
      `- Previous session: ${sessionId}`,
      issueId ? `- Issue: ${issueId}` : "",
      `- Rotation reason: ${reason}`,
      latestTextSummary ? `- Last run summary: ${latestTextSummary}` : "",
      "Continue from the current task state. Rebuild only the minimum context you need.",
    ]
      .filter(Boolean)
      .join("\n");
    const handoffArtifact = buildSessionHandoffArtifact({
      previousSessionId: sessionId,
      previousRunId: latestRun.id,
      issueId,
      rotationReason: reason,
      lastRunSummaryText: latestTextSummary ?? null,
    });

    return {
      rotate: true,
      reason,
      handoffMarkdown,
      handoffArtifact,
      previousRunId: latestRun.id,
    };
  }

  async function resolveSessionBeforeForWakeup(
    agent: typeof agents.$inferSelect,
    taskKey: string | null,
    opts?: { missionId?: string | null },
  ) {
    const codec = getAdapterSessionCodec(agent.adapterType);
    if (taskKey) {
      const existingTaskSession = await getTaskSession(
        agent.companyId,
        agent.id,
        agent.adapterType,
        taskKey,
      );
      const parsedParams = normalizeSessionParams(
        codec.deserialize(existingTaskSession?.sessionParamsJson ?? null),
      );
      const taskSessionId = truncateDisplayId(
        existingTaskSession?.sessionDisplayId ??
          (codec.getDisplayId ? codec.getDisplayId(parsedParams) : null) ??
          readNonEmptyString(parsedParams?.sessionId),
      );

      if (opts?.missionId) {
        const authority = await resolveMissionSessionAuthority({
          agent,
          missionId: opts.missionId,
          adapterType: agent.adapterType,
          taskSessionDisplayId: taskSessionId,
          taskSessionLegacySessionId: readNonEmptyString(parsedParams?.sessionId),
        });
        return truncateDisplayId(authority.decision.preferredSessionId);
      }

      return taskSessionId;
    }

    if (opts?.missionId) {
      const authority = await resolveMissionSessionAuthority({
        agent,
        missionId: opts.missionId,
        adapterType: agent.adapterType,
      });
      return truncateDisplayId(authority.decision.preferredSessionId);
    }

    const runtimeForRun = await getRuntimeState(agent.id);
    return runtimeForRun?.sessionId ?? null;
  }

  async function resolveWorkspaceForRun(
    agent: typeof agents.$inferSelect,
    context: Record<string, unknown>,
    previousSessionParams: Record<string, unknown> | null,
    opts?: { useProjectWorkspace?: boolean | null },
  ): Promise<ResolvedWorkspaceForRun> {
    const issueId = readNonEmptyString(context.issueId);
    const contextProjectId = readNonEmptyString(context.projectId);
    const contextProjectWorkspaceId = readNonEmptyString(context.projectWorkspaceId);
    const issueProjectRef = issueId
      ? await db
          .select({
            projectId: issues.projectId,
            projectWorkspaceId: issues.projectWorkspaceId,
            missionId: issues.missionId,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const issueProjectId = issueProjectRef?.projectId ?? null;
    const preferredProjectWorkspaceId =
      issueProjectRef?.projectWorkspaceId ?? contextProjectWorkspaceId ?? null;
    // [목적] issue/context 어디에도 project가 없으면, issue가 속한 mission의 projectId로 폴백.
    //   mission에 project를 물리면 그 project의 primary workspace에서 run이 돌아간다
    //   -> source='project_primary' + workspaceId -> broadScan 허용 + durable cwd.
    //   RES-1363 류(Step Input Manifest 의 find. 광역스캔 차단)와 outputs/ 소실을 함께 방지.
    // [주의] mission.projectId가 없거나 mission 자체가 없으면 null 로 둬 기존 fallback 경로 유지.
    let resolvedProjectId = issueProjectId ?? contextProjectId;
    if (!resolvedProjectId && issueProjectRef?.missionId) {
      const [missionProjectRow] = await db
        .select({ projectId: missions.projectId })
        .from(missions)
        .where(and(eq(missions.id, issueProjectRef.missionId), eq(missions.companyId, agent.companyId)))
        .limit(1);
      resolvedProjectId = missionProjectRow?.projectId ?? null;
    }
    const useProjectWorkspace = opts?.useProjectWorkspace !== false;
    const workspaceProjectId = useProjectWorkspace ? resolvedProjectId : null;

    const unorderedProjectWorkspaceRows = workspaceProjectId
      ? await db
          .select()
          .from(projectWorkspaces)
          .where(
            and(
              eq(projectWorkspaces.companyId, agent.companyId),
              eq(projectWorkspaces.projectId, workspaceProjectId),
            ),
          )
          .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
      : [];
    const projectWorkspaceRows = prioritizeProjectWorkspaceCandidatesForRun(
      unorderedProjectWorkspaceRows,
      preferredProjectWorkspaceId,
    );

    const workspaceHints = projectWorkspaceRows.map((workspace) => ({
      workspaceId: workspace.id,
      cwd: readNonEmptyString(workspace.cwd),
      repoUrl: readNonEmptyString(workspace.repoUrl),
      repoRef: readNonEmptyString(workspace.repoRef),
    }));

    if (projectWorkspaceRows.length > 0) {
      const preferredWorkspace = preferredProjectWorkspaceId
        ? projectWorkspaceRows.find((workspace) => workspace.id === preferredProjectWorkspaceId) ?? null
        : null;
      const missingProjectCwds: string[] = [];
      let hasConfiguredProjectCwd = false;
      let preferredWorkspaceWarning: string | null = null;
      if (preferredProjectWorkspaceId && !preferredWorkspace) {
        preferredWorkspaceWarning =
          `Selected project workspace "${preferredProjectWorkspaceId}" is not available on this project.`;
      }
      for (const workspace of projectWorkspaceRows) {
        let projectCwd = readNonEmptyString(workspace.cwd);
        let managedWorkspaceWarning: string | null = null;
        if (!projectCwd || projectCwd === REPO_ONLY_CWD_SENTINEL) {
          try {
            // worktree: check file-write before managed workspace operations
            await worktreeCheck({
              agent,
              tool: "file-write",
              args: { operation: "managed_workspace_setup" },
            });
            const managedWorkspace = await ensureManagedProjectWorkspace({
              companyId: agent.companyId,
              agentId: agent.id,
              projectId: workspaceProjectId ?? resolvedProjectId ?? workspace.projectId,
              repoUrl: readNonEmptyString(workspace.repoUrl),
              worktreeCheck: async (opts) =>
                worktreeCheck({ agent, tool: opts.tool, args: opts.args, cwd: opts.cwd, filePath: opts.filePath, command: opts.command }),
            });
            projectCwd = managedWorkspace.cwd;
            managedWorkspaceWarning = managedWorkspace.warning;
          } catch (error) {
            if (preferredWorkspace?.id === workspace.id) {
              preferredWorkspaceWarning = error instanceof Error ? error.message : String(error);
            }
            continue;
          }
        }
        hasConfiguredProjectCwd = true;
        const projectCwdExists = await fs
          .stat(projectCwd)
          .then((stats) => stats.isDirectory())
          .catch(() => false);
        if (projectCwdExists) {
          return {
            cwd: projectCwd,
            source: "project_primary" as const,
            projectId: resolvedProjectId,
            workspaceId: workspace.id,
            repoUrl: workspace.repoUrl,
            repoRef: workspace.repoRef,
            workspaceHints,
            warnings: [preferredWorkspaceWarning, managedWorkspaceWarning].filter(
              (value): value is string => Boolean(value),
            ),
          };
        }
        if (preferredWorkspace?.id === workspace.id) {
          preferredWorkspaceWarning =
            `Selected project workspace path "${projectCwd}" is not available yet.`;
        }
        missingProjectCwds.push(projectCwd);
      }

      const fallbackCwd = resolveDefaultAgentWorkspaceDir(agent.id);
      // worktree: check file-write before fallback workspace mkdir
      await worktreeCheck({
        agent,
        tool: "file-write",
        args: { operation: "fallback_workspace_mkdir" },
        cwd: fallbackCwd,
        filePath: fallbackCwd,
      });
      await fs.mkdir(fallbackCwd, { recursive: true });
      const warnings: string[] = [];
      if (preferredWorkspaceWarning) {
        warnings.push(preferredWorkspaceWarning);
      }
      if (missingProjectCwds.length > 0) {
        const firstMissing = missingProjectCwds[0];
        const extraMissingCount = Math.max(0, missingProjectCwds.length - 1);
        warnings.push(
          extraMissingCount > 0
            ? `Project workspace path "${firstMissing}" and ${extraMissingCount} other configured path(s) are not available yet. Using fallback workspace "${fallbackCwd}" for this run.`
            : `Project workspace path "${firstMissing}" is not available yet. Using fallback workspace "${fallbackCwd}" for this run.`,
        );
      } else if (!hasConfiguredProjectCwd) {
        warnings.push(
          `Project workspace has no local cwd configured. Using fallback workspace "${fallbackCwd}" for this run.`,
        );
      }
      return {
        cwd: fallbackCwd,
        source: "project_primary" as const,
        projectId: resolvedProjectId,
        workspaceId: projectWorkspaceRows[0]?.id ?? null,
        repoUrl: projectWorkspaceRows[0]?.repoUrl ?? null,
        repoRef: projectWorkspaceRows[0]?.repoRef ?? null,
        workspaceHints,
        warnings,
      };
    }

    if (workspaceProjectId) {
      // worktree: check file-write before managed workspace operations
      await worktreeCheck({
        agent,
        tool: "file-write",
        args: { operation: "managed_workspace_setup" },
      });
      const managedWorkspace = await ensureManagedProjectWorkspace({
        companyId: agent.companyId,
        agentId: agent.id,
        projectId: workspaceProjectId,
        repoUrl: null,
        worktreeCheck: async (opts) =>
          worktreeCheck({ agent, tool: opts.tool, args: opts.args, cwd: opts.cwd, filePath: opts.filePath, command: opts.command }),
      });
      return {
        cwd: managedWorkspace.cwd,
        source: "project_primary" as const,
        projectId: resolvedProjectId,
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
        workspaceHints,
        warnings: managedWorkspace.warning ? [managedWorkspace.warning] : [],
      };
    }

    const sessionCwd = readNonEmptyString(previousSessionParams?.cwd);
    if (sessionCwd) {
      const sessionCwdExists = await fs
        .stat(sessionCwd)
        .then((stats) => stats.isDirectory())
        .catch(() => false);
      if (sessionCwdExists) {
        return {
          cwd: sessionCwd,
          source: "task_session" as const,
          projectId: resolvedProjectId,
          workspaceId: readNonEmptyString(previousSessionParams?.workspaceId),
          repoUrl: readNonEmptyString(previousSessionParams?.repoUrl),
          repoRef: readNonEmptyString(previousSessionParams?.repoRef),
          workspaceHints,
          warnings: [],
        };
      }
    }

    const cwd = resolveDefaultAgentWorkspaceDir(agent.id);
    // worktree: check file-write before default workspace mkdir
    await worktreeCheck({
      agent,
      tool: "file-write",
      args: { operation: "default_workspace_mkdir" },
      cwd,
      filePath: cwd,
    });
    await fs.mkdir(cwd, { recursive: true });
    const warnings: string[] = [];
    if (sessionCwd) {
      warnings.push(
        `Saved session workspace "${sessionCwd}" is not available. Using fallback workspace "${cwd}" for this run.`,
      );
    } else if (resolvedProjectId) {
      warnings.push(
        `No project workspace directory is currently available for this issue. Using fallback workspace "${cwd}" for this run.`,
      );
    } else {
      warnings.push(
        `No project or prior session workspace was available. Using fallback workspace "${cwd}" for this run.`,
      );
    }
    return {
      cwd,
      source: "agent_home" as const,
      projectId: resolvedProjectId,
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      workspaceHints,
      warnings,
    };
  }

  async function upsertTaskSession(input: {
    companyId: string;
    agentId: string;
    adapterType: string;
    taskKey: string;
    sessionParamsJson: Record<string, unknown> | null;
    sessionDisplayId: string | null;
    lastRunId: string | null;
    lastError: string | null;
  }) {
    const existing = await getTaskSession(
      input.companyId,
      input.agentId,
      input.adapterType,
      input.taskKey,
    );
    if (existing) {
      return db
        .update(agentTaskSessions)
        .set({
          sessionParamsJson: input.sessionParamsJson,
          sessionDisplayId: input.sessionDisplayId,
          lastRunId: input.lastRunId,
          lastError: input.lastError,
          updatedAt: new Date(),
        })
        .where(eq(agentTaskSessions.id, existing.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    }

    return db
      .insert(agentTaskSessions)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        adapterType: input.adapterType,
        taskKey: input.taskKey,
        sessionParamsJson: input.sessionParamsJson,
        sessionDisplayId: input.sessionDisplayId,
        lastRunId: input.lastRunId,
        lastError: input.lastError,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function clearTaskSessions(
    companyId: string,
    agentId: string,
    opts?: { taskKey?: string | null; adapterType?: string | null },
  ) {
    const conditions = [
      eq(agentTaskSessions.companyId, companyId),
      eq(agentTaskSessions.agentId, agentId),
    ];
    if (opts?.taskKey) {
      conditions.push(eq(agentTaskSessions.taskKey, opts.taskKey));
    }
    if (opts?.adapterType) {
      conditions.push(eq(agentTaskSessions.adapterType, opts.adapterType));
    }

    return db
      .delete(agentTaskSessions)
      .where(and(...conditions))
      .returning()
      .then((rows) => rows.length);
  }

  async function ensureRuntimeState(agent: typeof agents.$inferSelect) {
    const existing = await getRuntimeState(agent.id);
    if (existing) return existing;

    return db
      .insert(agentRuntimeState)
      .values({
        agentId: agent.id,
        companyId: agent.companyId,
        adapterType: agent.adapterType,
        stateJson: {},
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function setRunStatus(
    runId: string,
    status: string,
    patch?: Partial<typeof heartbeatRuns.$inferInsert>,
  ) {
    const updated = await db
      .update(heartbeatRuns)
      .set({ status, ...patch, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      publishLiveEvent({
        companyId: updated.companyId,
        type: "heartbeat.run.status",
        payload: {
          runId: updated.id,
          agentId: updated.agentId,
          status: updated.status,
          invocationSource: updated.invocationSource,
          triggerDetail: updated.triggerDetail,
          error: updated.error ?? null,
          errorCode: updated.errorCode ?? null,
          startedAt: updated.startedAt ? new Date(updated.startedAt).toISOString() : null,
          finishedAt: updated.finishedAt ? new Date(updated.finishedAt).toISOString() : null,
        },
      });
    }

    // [Task 6C] queue_run_completed event for terminal status
    if (updated) await recordHeartbeatRunTerminalTransitionEvent(db, updated);

    return updated;
  }

  async function setWakeupStatus(
    wakeupRequestId: string | null | undefined,
    status: string,
    patch?: Partial<typeof agentWakeupRequests.$inferInsert>,
  ) {
    if (!wakeupRequestId) return;
    await db
      .update(agentWakeupRequests)
      .set({ status, ...patch, updatedAt: new Date() })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
  }

  // [Task 6C] queue/run 상태전이를 workflow_transition_events 에 mirror (append-only).
  // 기존 경로 제거/교체 없이 event 만 추가. unique index (company_id, idempotency_key) 로 중복 방지.
  async function recordQueueTransitionEvent(input: {
    companyId: string;
    missionId?: string | null;
    issueId?: string | null;
    wakeupRequestId?: string | null;
    heartbeatRunId?: string | null;
    workflowRunId?: string | null;
    workflowStepRunId?: string | null;
    eventType: string;
    layer: string;
    decision?: string | null;
    reason?: string | null;
    reasonCode?: string | null;
    idempotencyKey: string;
    payload?: Record<string, unknown>;
  }) {
    await recordHeartbeatQueueTransitionEvent(db, input);
  }

  async function appendRunEvent(
    run: typeof heartbeatRuns.$inferSelect,
    seq: number,
    event: {
      eventType: string;
      stream?: "system" | "stdout" | "stderr";
      level?: "info" | "warn" | "error";
      color?: string;
      message?: string;
      payload?: Record<string, unknown>;
    },
  ) {
    const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
    const sanitizedMessage = event.message
      ? redactCurrentUserText(event.message, currentUserRedactionOptions)
      : event.message;
    const sanitizedPayload = event.payload
      ? redactCurrentUserValue(event.payload, currentUserRedactionOptions)
      : event.payload;

    await db.insert(heartbeatRunEvents).values({
      companyId: run.companyId,
      runId: run.id,
      agentId: run.agentId,
      seq,
      eventType: event.eventType,
      stream: event.stream,
      level: event.level,
      color: event.color,
      message: sanitizedMessage,
      payload: sanitizedPayload,
    });

    publishLiveEvent({
      companyId: run.companyId,
      type: "heartbeat.run.event",
      payload: {
        runId: run.id,
        agentId: run.agentId,
        seq,
        eventType: event.eventType,
        stream: event.stream ?? null,
        level: event.level ?? null,
        color: event.color ?? null,
        message: sanitizedMessage ?? null,
        payload: sanitizedPayload ?? null,
      },
    });
  }

  async function nextRunEventSeq(runId: string) {
    const [row] = await db
      .select({ maxSeq: sql<number | null>`max(${heartbeatRunEvents.seq})` })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    return Number(row?.maxSeq ?? 0) + 1;
  }

  async function persistRunProcessMetadata(
    runId: string,
    meta: { pid: number; startedAt: string },
  ) {
    const startedAt = new Date(meta.startedAt);
    return db
      .update(heartbeatRuns)
      .set({
        processPid: meta.pid,
        processStartedAt: Number.isNaN(startedAt.getTime()) ? new Date() : startedAt,
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function clearDetachedRunWarning(runId: string) {
    const updated = await db
      .update(heartbeatRuns)
      .set({
        error: null,
        errorCode: null,
        updatedAt: new Date(),
      })
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.errorCode, DETACHED_PROCESS_ERROR_CODE)))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) return null;

    await appendRunEvent(updated, await nextRunEventSeq(updated.id), {
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: "Detached child process reported activity; cleared detached warning",
    });
    return updated;
  }

  async function enqueueProcessLossRetry(
    run: typeof heartbeatRuns.$inferSelect,
    agent: typeof agents.$inferSelect,
    now: Date,
  ) {
    const contextSnapshot = parseObject(run.contextSnapshot);
    const issueId = run.issueId ?? readNonEmptyString(contextSnapshot.issueId);
    let retryMissionId = readNonEmptyString(contextSnapshot.missionId);
    let retryWorkflowRunId = readNonEmptyString(contextSnapshot.workflowRunId);
    let retryStepId = readNonEmptyString(contextSnapshot.workflowStepId) ?? readNonEmptyString(contextSnapshot.stepId);
    if (issueId && (!retryMissionId || !retryWorkflowRunId || !retryStepId)) {
      const issueContext = await db
        .select({
          missionId: issues.missionId,
          workflowRunId: workflowStepRuns.workflowRunId,
          stepId: workflowStepRuns.stepId,
        })
        .from(issues)
        .leftJoin(workflowStepRuns, eq(workflowStepRuns.issueId, issues.id))
        .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
        .orderBy(desc(workflowStepRuns.startedAt), desc(workflowStepRuns.completedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      retryMissionId = retryMissionId ?? issueContext?.missionId ?? null;
      retryWorkflowRunId = retryWorkflowRunId ?? issueContext?.workflowRunId ?? null;
      retryStepId = retryStepId ?? issueContext?.stepId ?? null;
    }
    const taskKey = deriveTaskKey(contextSnapshot, null);
    const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey, {
      missionId: retryMissionId,
    });
    const retryContextSnapshot = {
      ...contextSnapshot,
      ...(issueId ? { issueId } : {}),
      ...(retryMissionId ? { missionId: retryMissionId } : {}),
      ...(retryWorkflowRunId ? { workflowRunId: retryWorkflowRunId } : {}),
      ...(retryStepId ? { workflowStepId: retryStepId, stepId: retryStepId } : {}),
      retryOfRunId: run.id,
      wakeReason: "process_lost_retry",
      retryReason: "process_lost",
    };

    const queued = await db.transaction(async (tx) => {
      const wakeupRequest = await tx
        .insert(agentWakeupRequests)
        .values({
          companyId: run.companyId,
          agentId: run.agentId,
          source: "automation",
          triggerDetail: "system",
          reason: "process_lost_retry",
          payload: {
            ...(issueId ? { issueId } : {}),
            retryOfRunId: run.id,
          },
          status: "queued",
          requestedByActorType: "system",
          requestedByActorId: null,
          requestKind: "process_lost_retry",
          issueId: issueId ?? null,
          missionId: retryMissionId ?? null,
          workflowRunId: retryWorkflowRunId ?? null,
          // retryStepId 는 stepId(text) 이지 workflow_step_runs.id(UUID)가 아님 → null.
          workflowStepRunId: null,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);

        const retryRun = await tx
          .insert(heartbeatRuns)
          .values({
            companyId: run.companyId,
            agentId: run.agentId,
            issueId,
            invocationSource: "automation",
            triggerDetail: "system",
            status: "queued",
          wakeupRequestId: wakeupRequest.id,
          contextSnapshot: retryContextSnapshot,
          sessionIdBefore: sessionBefore,
          retryOfRunId: run.id,
          processLossRetryCount: (run.processLossRetryCount ?? 0) + 1,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);

      await tx
        .update(agentWakeupRequests)
        .set({
          runId: retryRun.id,
          updatedAt: now,
        })
        .where(eq(agentWakeupRequests.id, wakeupRequest.id));

      if (issueId) {
        await tx
          .update(issues)
          .set({
            executionRunId: retryRun.id,
            executionAgentNameKey: normalizeAgentNameKey(agent.name),
            executionLockedAt: now,
            updatedAt: now,
          })
          .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId), eq(issues.executionRunId, run.id)));
      }

      return retryRun;
    });

    publishLiveEvent({
      companyId: queued.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: queued.id,
        agentId: queued.agentId,
        invocationSource: queued.invocationSource,
        triggerDetail: queued.triggerDetail,
        wakeupRequestId: queued.wakeupRequestId,
      },
    });

    await appendRunEvent(queued, 1, {
      eventType: "lifecycle",
      stream: "system",
      level: "warn",
      message: "Queued automatic retry after orphaned child process was confirmed dead",
      payload: {
        retryOfRunId: run.id,
      },
    });

    return queued;
  }

  async function enqueueAdapterFallbackRun(
    run: typeof heartbeatRuns.$inferSelect,
    agent: typeof agents.$inferSelect,
    now: Date,
    input: {
      fallbackCommand: string;
      fallbackProvider?: string;
      fallbackModel?: string;
      fallbackReason: string;
    },
  ) {
    const contextSnapshot = parseObject(run.contextSnapshot);
    const issueId = run.issueId ?? readNonEmptyString(contextSnapshot.issueId);
    let fallbackMissionId = readNonEmptyString(contextSnapshot.missionId);
    let fallbackWorkflowRunId = readNonEmptyString(contextSnapshot.workflowRunId);
    let fallbackStepId = readNonEmptyString(contextSnapshot.workflowStepId) ?? readNonEmptyString(contextSnapshot.stepId);
    if (issueId && (!fallbackMissionId || !fallbackWorkflowRunId || !fallbackStepId)) {
      const issueContext = await db
        .select({
          missionId: issues.missionId,
          workflowRunId: workflowStepRuns.workflowRunId,
          stepId: workflowStepRuns.stepId,
        })
        .from(issues)
        .leftJoin(workflowStepRuns, eq(workflowStepRuns.issueId, issues.id))
        .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
        .orderBy(desc(workflowStepRuns.startedAt), desc(workflowStepRuns.completedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      fallbackMissionId = fallbackMissionId ?? issueContext?.missionId ?? null;
      fallbackWorkflowRunId = fallbackWorkflowRunId ?? issueContext?.workflowRunId ?? null;
      fallbackStepId = fallbackStepId ?? issueContext?.stepId ?? null;
    }

    const fallbackAttempt = resolveAdapterFallbackAttempt(contextSnapshot) + 1;
    const fallbackContextSnapshot = {
      ...contextSnapshot,
      ...(issueId ? { issueId } : {}),
      ...(fallbackMissionId ? { missionId: fallbackMissionId } : {}),
      ...(fallbackWorkflowRunId ? { workflowRunId: fallbackWorkflowRunId } : {}),
      ...(fallbackStepId ? { workflowStepId: fallbackStepId, stepId: fallbackStepId } : {}),
      retryOfRunId: run.id,
      fallbackOfRunId: run.id,
      fallbackReason: input.fallbackReason,
      fallbackAttempt,
      fallbackCommand: input.fallbackCommand,
      ...(input.fallbackProvider ? { fallbackProvider: input.fallbackProvider } : {}),
      ...(input.fallbackModel ? { fallbackModel: input.fallbackModel } : {}),
      wakeReason: "adapter_fallback",
    };
    const taskKey = deriveTaskKey(fallbackContextSnapshot, null);
    const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey, {
      missionId: fallbackMissionId,
    });

    const queued = await db.transaction(async (tx) => {
      const wakeupRequest = await tx
        .insert(agentWakeupRequests)
        .values({
          companyId: run.companyId,
          agentId: run.agentId,
          source: "automation",
          triggerDetail: "system",
          reason: "adapter_fallback",
          payload: {
            ...(issueId ? { issueId } : {}),
            fallbackOfRunId: run.id,
            fallbackReason: input.fallbackReason,
          },
          status: "queued",
          requestedByActorType: "system",
          requestedByActorId: null,
          requestKind: "adapter_fallback",
          issueId: issueId ?? null,
          missionId: fallbackMissionId ?? null,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);

      const fallbackRun = await tx
        .insert(heartbeatRuns)
        .values({
          companyId: run.companyId,
          agentId: run.agentId,
          issueId,
          invocationSource: "automation",
          triggerDetail: "system",
          status: "queued",
          wakeupRequestId: wakeupRequest.id,
          contextSnapshot: fallbackContextSnapshot,
          sessionIdBefore: sessionBefore,
          retryOfRunId: run.id,
          processLossRetryCount: run.processLossRetryCount ?? 0,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);

      await tx
        .update(agentWakeupRequests)
        .set({
          runId: fallbackRun.id,
          updatedAt: now,
        })
        .where(eq(agentWakeupRequests.id, wakeupRequest.id));

      if (issueId) {
        await tx
          .update(issues)
          .set({
            executionRunId: fallbackRun.id,
            executionAgentNameKey: normalizeAgentNameKey(agent.name),
            executionLockedAt: now,
            updatedAt: now,
          })
          .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId), eq(issues.executionRunId, run.id)));
      }

      return fallbackRun;
    });

    publishLiveEvent({
      companyId: queued.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: queued.id,
        agentId: queued.agentId,
        invocationSource: queued.invocationSource,
        triggerDetail: queued.triggerDetail,
        wakeupRequestId: queued.wakeupRequestId,
      },
    });

    await appendRunEvent(queued, 1, {
      eventType: "lifecycle",
      stream: "system",
      level: "warn",
      message: "Queued adapter fallback after primary adapter retry was exhausted",
      payload: {
        fallbackOfRunId: run.id,
        fallbackReason: input.fallbackReason,
        fallbackAttempt,
      },
    });

    return queued;
  }

  function parseHeartbeatPolicy(agent: typeof agents.$inferSelect) {
    const runtimeConfig = parseObject(agent.runtimeConfig);
    const heartbeat = parseObject(runtimeConfig.heartbeat);

    return {
      enabled: asBoolean(heartbeat.enabled, true),
      intervalSec: Math.max(0, asNumber(heartbeat.intervalSec, 0)),
      wakeOnDemand: asBoolean(heartbeat.wakeOnDemand ?? heartbeat.wakeOnAssignment ?? heartbeat.wakeOnOnDemand ?? heartbeat.wakeOnAutomation, true),
      maxConcurrentRuns: normalizeMaxConcurrentRuns(heartbeat.maxConcurrentRuns),
    };
  }

  async function countRunningRunsForAgent(agentId: string) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")));
    return Number(count ?? 0);
  }

  async function claimQueuedRun(run: typeof heartbeatRuns.$inferSelect) {
    if (run.status !== "queued") return run;
    const agent = await getAgent(run.agentId);
    if (!agent) {
      await cancelRunInternal(run.id, "Cancelled because the agent no longer exists");
      return null;
    }
    if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") {
      await cancelRunInternal(run.id, "Cancelled because the agent is not invokable");
      return null;
    }

    const context = parseObject(run.contextSnapshot);
    const budgetBlock = await budgets.getInvocationBlock(run.companyId, run.agentId, {
      issueId: readNonEmptyString(context.issueId),
      projectId: readNonEmptyString(context.projectId),
    });
    if (budgetBlock) {
      await cancelRunInternal(run.id, budgetBlock.reason);
      return null;
    }

    const missionIdForRun = readNonEmptyString(context.missionId);
    if (missionIdForRun) {
      try {
        await assertMissionRuntimeAcceptsWork(db, {
          companyId: run.companyId,
          missionId: missionIdForRun,
        });
      } catch (err) {
        await cancelRunInternal(
          run.id,
          err instanceof Error ? err.message : "Cancelled because mission is terminal",
        );
        return null;
      }
    }

    const claimedAt = new Date();
    const claimed = await db
      .update(heartbeatRuns)
      .set({
        status: "running",
        startedAt: run.startedAt ?? claimedAt,
        updatedAt: claimedAt,
      })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "queued")))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!claimed) return null;

    // [Task 6C] queue_run_started event (queued→running transition)
    await recordQueueTransitionEvent({
      companyId: claimed.companyId,
      heartbeatRunId: claimed.id,
      wakeupRequestId: claimed.wakeupRequestId,
      issueId: claimed.issueId,
      eventType: "queue_run_started",
      layer: "heartbeat",
      decision: "running",
      reason: "claim_succeeded",
      reasonCode: "claim_succeeded",
      idempotencyKey: `queue-run-started:${claimed.id}`,
    });

    publishLiveEvent({
      companyId: claimed.companyId,
      type: "heartbeat.run.status",
      payload: {
        runId: claimed.id,
        agentId: claimed.agentId,
        status: claimed.status,
        invocationSource: claimed.invocationSource,
        triggerDetail: claimed.triggerDetail,
        error: claimed.error ?? null,
        errorCode: claimed.errorCode ?? null,
        startedAt: claimed.startedAt ? new Date(claimed.startedAt).toISOString() : null,
        finishedAt: claimed.finishedAt ? new Date(claimed.finishedAt).toISOString() : null,
      },
    });

    await setWakeupStatus(claimed.wakeupRequestId, "claimed", { claimedAt });
    return claimed;
  }

  async function pauseAgentForReauthRequired(
    agentId: string,
    authInfo: CodexAuthAutoBlockInfo,
  ) {
    const paused = await db
      .update(agents)
      .set({
        status: "paused",
        pauseReason: CODEX_REAUTH_REQUIRED_PAUSE_REASON,
        pausedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(agents.id, agentId), not(inArray(agents.status, ["paused", "terminated", "pending_approval"]))))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (paused) {
      publishLiveEvent({
        companyId: paused.companyId,
        type: "agent.status",
        payload: {
          agentId: paused.id,
          status: paused.status,
          pauseReason: paused.pauseReason,
          pausedAt: paused.pausedAt ? new Date(paused.pausedAt).toISOString() : null,
          outcome: "reauth_required",
          reasonCode: authInfo.reasonCode,
        },
      });
    }

    return paused;
  }

  async function finalizeAgentStatus(
    agentId: string,
    outcome: "succeeded" | "failed" | "cancelled" | "timed_out",
  ) {
    const existing = await getAgent(agentId);
    if (!existing) return;

    if (existing.status === "paused" || existing.status === "terminated") {
      return;
    }

    const runningCount = await countRunningRunsForAgent(agentId);
    const nextStatus =
      runningCount > 0
        ? "running"
        : outcome === "succeeded" || outcome === "cancelled"
          ? "idle"
          : "error";

    const updated = await db
      .update(agents)
      .set({
        status: nextStatus,
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      publishLiveEvent({
        companyId: updated.companyId,
        type: "agent.status",
        payload: {
          agentId: updated.id,
          status: updated.status,
          lastHeartbeatAt: updated.lastHeartbeatAt
            ? new Date(updated.lastHeartbeatAt).toISOString()
            : null,
          outcome,
        },
      });
    }
  }

  async function reapOrphanedRuns(opts?: {
    staleThresholdMs?: number;
    activeExecutionTimeoutMs?: number;
    queuedStaleThresholdMs?: number;
  }) {
    const staleThresholdMs = opts?.staleThresholdMs ?? 0;
    const activeExecutionTimeoutMs = opts?.activeExecutionTimeoutMs ?? 0;
    const queuedStaleThresholdMs = opts?.queuedStaleThresholdMs ?? 0;
    const now = new Date();

    // Find all runs stuck in "running" state. Queued runs are handled below only
    // when they have exceeded an explicit queued staleness threshold.
    const activeRuns = await db
      .select({
        run: heartbeatRuns,
        adapterType: agents.adapterType,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(eq(heartbeatRuns.status, "running"));

    const reaped: string[] = [];

    for (const { run, adapterType } of activeRuns) {
      const trackedProcess = runningProcesses.get(run.id) ?? null;
      const hasActiveExecution = activeRunExecutions.has(run.id);
      if (trackedProcess || hasActiveExecution) {
        // [issue done → 자식 즉시 kill] 에이전트가 issue 를 done/cancelled 처리했는데도
        // 어댑터 자식(opencode 등)이 exit 안 하고 살아있으면 maxConcurrentRuns 블록이
        // execution_stale(15min)까지 지속된다. issue 상태가 done/cancelled 면 자식을
        // 즉시 종료해 블록을 푼다.
        if (trackedProcess && run.issueId) {
          const [issueRow] = await db.select({ status: issues.status }).from(issues)
            .where(eq(issues.id, run.issueId)).limit(1);
          if (issueRow && (issueRow.status === "done" || issueRow.status === "cancelled")) {
            trackedProcess.child.kill("SIGTERM");
            setTimeout(() => {
              if (!trackedProcess.child.killed) {
                trackedProcess.child.kill("SIGKILL");
              }
            }, Math.max(1, trackedProcess.graceSec) * 1000);
            runningProcesses.delete(run.id);
            await setRunStatus(run.id, issueRow.status === "done" ? "succeeded" : "cancelled", {
              error: `Issue ${issueRow.status} but adapter child did not exit; terminated`,
              errorCode: "issue_done_child_not_exited",
              finishedAt: now,
            });
            // Agent self-learning wiki (Phase 1): adapter 자식 미종료 패턴 기록 (non-blocking).
            fireWikiRecord(wikiSvc, {
              companyId: run.companyId,
              agentId: run.agentId,
              missionId: null,
              pattern: "adapter 자식 미종료 (issue done/cancelled)",
              cause: "이슈가 done/cancelled로 종료됐는데도 어댑터 자식(opencode 등)이 exit하지 않아 maxConcurrentRuns 블록이 execution_stale까지 지속됨.",
              solution: "이슈 done/cancelled 처리 후 어댑터 자식이 확실히 exit하도록 종료 시그널/플래그 점검. 작업 완료 시 프로세스를 즉시 종료할 것.",
              errorCode: "issue_done_child_not_exited",
            }, run.id);
            continue;
          }
        }
        if (activeExecutionTimeoutMs <= 0) continue;
        const refTime = run.startedAt ? new Date(run.startedAt).getTime() : new Date(run.updatedAt).getTime();
        if (now.getTime() - refTime < activeExecutionTimeoutMs) continue;

        if (trackedProcess) {
          trackedProcess.child.kill("SIGTERM");
          setTimeout(() => {
            if (!trackedProcess.child.killed) {
              trackedProcess.child.kill("SIGKILL");
            }
          }, Math.max(1, trackedProcess.graceSec) * 1000);
          runningProcesses.delete(run.id);
        }

        const timeoutMessage = `Heartbeat execution exceeded ${Math.round(activeExecutionTimeoutMs / 1000)}s without reaching a terminal state`;
        const timedOutRun = await setRunStatus(run.id, "timed_out", {
          error: timeoutMessage,
          errorCode: "execution_stale_timeout",
          finishedAt: now,
        });
        await setWakeupStatus(run.wakeupRequestId, "timed_out", {
          finishedAt: now,
          error: timeoutMessage,
        });
        if (timedOutRun) {
          await appendRunEvent(timedOutRun, await nextRunEventSeq(timedOutRun.id), {
            eventType: "lifecycle",
            stream: "system",
            level: "error",
            message: timeoutMessage,
            payload: {
              activeExecution: hasActiveExecution,
              trackedProcess: Boolean(trackedProcess),
              activeExecutionTimeoutMs,
            },
          });
          await releaseIssueExecutionAndPromote(timedOutRun);
        }
        // Agent self-learning wiki (Phase 1): execution stale(hang) 패턴 기록 (non-blocking).
        fireWikiRecord(wikiSvc, {
          companyId: run.companyId,
          agentId: run.agentId,
          missionId: null,
          pattern: "execution stale (hang)",
          cause: "어댑터 실행이 타임아웃(activeExecutionTimeout) 전에 종단 상태에 도달하지 못해 hang으로 판정됨.",
          solution: "API_TIMEOUT(10분)과 idle 점검. 장기 실행 명령은 타임아웃/백그라운드 분리. 자식이 stdout을 닫지 않고 누수하는지 확인.",
          errorCode: "execution_stale_timeout",
        }, run.id);
        await finalizeAgentStatus(run.agentId, "timed_out");
        await startNextQueuedRunForAgent(run.agentId);
        reaped.push(run.id);
        continue;
      }

      // Apply staleness threshold to avoid false positives
      if (staleThresholdMs > 0) {
        const refTime = run.updatedAt ? new Date(run.updatedAt).getTime() : 0;
        if (now.getTime() - refTime < staleThresholdMs) continue;
      }

      const tracksLocalChild = isTrackedLocalChildProcessAdapter(adapterType);
      if (tracksLocalChild && run.processPid && isProcessAlive(run.processPid)) {
        if (run.errorCode !== DETACHED_PROCESS_ERROR_CODE) {
          const detachedMessage = `Lost in-memory process handle, but child pid ${run.processPid} is still alive`;
          const detachedRun = await setRunStatus(run.id, "running", {
            error: detachedMessage,
            errorCode: DETACHED_PROCESS_ERROR_CODE,
          });
          if (detachedRun) {
            await appendRunEvent(detachedRun, await nextRunEventSeq(detachedRun.id), {
              eventType: "lifecycle",
              stream: "system",
              level: "warn",
              message: detachedMessage,
              payload: {
                processPid: run.processPid,
              },
            });
          }
        }
        // FIX 2b: orphaned-but-alive child longevity cap. child 가 DETACHED_REAP_AFTER_MS 초과 실행 중이면
        // 강제 kill 후 아래 기존 process_lost/retry 경로로 fall-through(무한 defer 방지 — CMPA-5519 대응).
        const detachedChildStartedMs = run.processStartedAt
          ? new Date(run.processStartedAt).getTime()
          : run.startedAt
            ? new Date(run.startedAt).getTime()
            : 0;
        if (
          DETACHED_REAP_AFTER_MS > 0 &&
          detachedChildStartedMs > 0 &&
          now.getTime() - detachedChildStartedMs > DETACHED_REAP_AFTER_MS
        ) {
          terminateRecordedProcess(run.processPid, "SIGTERM");
          setTimeout(
            () => terminateRecordedProcess(run.processPid, "SIGKILL"),
            Math.max(1, DETACHED_GRACE_SEC) * 1000,
          );
          // fall through to process_lost/retry below (의도적 continue 생략).
        } else {
          continue;
        }
      }

      const shouldRetry = tracksLocalChild && !!run.processPid && (run.processLossRetryCount ?? 0) < 1;
      const baseMessage = run.processPid
        ? `Process lost -- child pid ${run.processPid} is no longer running`
        : "Process lost -- server may have restarted";

      let finalizedRun = await setRunStatus(run.id, "failed", {
        error: shouldRetry ? `${baseMessage}; retrying once` : baseMessage,
        errorCode: "process_lost",
        finishedAt: now,
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: now,
        error: shouldRetry ? `${baseMessage}; retrying once` : baseMessage,
      });
      if (!finalizedRun) finalizedRun = await getRun(run.id);
      if (!finalizedRun) continue;

      // Agent wiki hook (process_lost): adapter 자식 프로세스 상실 교훈 축적 (non-blocking).
      // detached 30min cap fall-through 도 이 process_lost 경로를 타므로 이 hook 하나로 커버.
      fireWikiRecord(wikiSvc, {
        companyId: run.companyId,
        agentId: run.agentId,
        pattern: "process_lost (adapter 자식 프로세스 상실)",
        cause: "어댑터 자식 프로세스가 예기치 않게 종료/상실돼 run 실패. in-memory handle 상실(→orphan), 서버 재시작, 자식 crash 등. CMPA-5519 hang의 주요 원인.",
        solution: "detached 30min cap + graceful shutdown 자식 회수로 handle-loss 회수 지연을 보강. 반복 시 adapter command·리소스·안정성 점검.",
        errorCode: "process_lost",
      }, run.id);

      let retriedRun: typeof heartbeatRuns.$inferSelect | null = null;
      let fallbackRun: typeof heartbeatRuns.$inferSelect | null = null;
      if (shouldRetry) {
        const agent = await getAgent(run.agentId);
        if (agent) {
          retriedRun = await enqueueProcessLossRetry(finalizedRun, agent, now);
        }
      } else {
        const agent = await getAgent(run.agentId);
        const fallback = agent ? resolveAdapterFallbackConfig(agent.adapterConfig) : null;
        const fallbackAttempt = resolveAdapterFallbackAttempt(run.contextSnapshot);
        const shouldFallback =
          Boolean(agent) &&
          Boolean(fallback) &&
          fallbackAttempt < fallback!.maxAttempts;
        if (agent && fallback && shouldFallback) {
          fallbackRun = await enqueueAdapterFallbackRun(finalizedRun, agent, now, {
            fallbackCommand: fallback.command,
            fallbackProvider: fallback.provider,
            fallbackModel: fallback.model,
            fallbackReason: "process_lost",
          });
        } else {
          await releaseIssueExecutionAndPromote(finalizedRun);
        }
      }

      await appendRunEvent(finalizedRun, await nextRunEventSeq(finalizedRun.id), {
        eventType: "lifecycle",
        stream: "system",
        level: "error",
        message: shouldRetry
          ? `${baseMessage}; queued retry ${retriedRun?.id ?? ""}`.trim()
          : fallbackRun
            ? `${baseMessage}; queued adapter fallback ${fallbackRun.id}`
          : baseMessage,
        payload: {
          ...(run.processPid ? { processPid: run.processPid } : {}),
          ...(retriedRun ? { retryRunId: retriedRun.id } : {}),
          ...(fallbackRun ? { fallbackRunId: fallbackRun.id } : {}),
        },
      });

      await finalizeAgentStatus(run.agentId, "failed");
      await startNextQueuedRunForAgent(run.agentId);
      runningProcesses.delete(run.id);
      reaped.push(run.id);
    }

    if (queuedStaleThresholdMs > 0) {
      const queuedRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.status, "queued"));

      for (const run of queuedRuns) {
        if (runningProcesses.has(run.id) || activeRunExecutions.has(run.id)) continue;

        const hasRunningRunForAgent = await db
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.agentId, run.agentId), eq(heartbeatRuns.status, "running")))
          .limit(1)
          .then((rows) => rows.length > 0);
        if (hasRunningRunForAgent) continue;

        const refTime = run.createdAt ? new Date(run.createdAt).getTime() : new Date(run.updatedAt).getTime();
        if (now.getTime() - refTime < queuedStaleThresholdMs) continue;

        const staleQueuedMessage = `Queued heartbeat run exceeded ${Math.round(queuedStaleThresholdMs / 1000)}s without starting`;
        const failedRun = await setRunStatus(run.id, "failed", {
          error: staleQueuedMessage,
          errorCode: "stale_queued",
          finishedAt: now,
        });
        await setWakeupStatus(run.wakeupRequestId, "failed", {
          finishedAt: now,
          error: staleQueuedMessage,
        });
        if (failedRun) {
          await appendRunEvent(failedRun, await nextRunEventSeq(failedRun.id), {
            eventType: "lifecycle",
            stream: "system",
            level: "error",
            message: staleQueuedMessage,
            payload: { queuedStaleThresholdMs },
          });
          await releaseIssueExecutionAndPromote(failedRun);
        }
        await finalizeAgentStatus(run.agentId, "failed");
        reaped.push(run.id);
      }
    }

    if (reaped.length > 0) {
      logger.warn({ reapedCount: reaped.length, runIds: reaped }, "reaped orphaned heartbeat runs");
    }
    return { reaped: reaped.length, runIds: reaped };
  }

  async function resumeQueuedRuns() {
    const queuedRuns = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "queued"));
    const queuedWakeups = await db
      .select({ agentId: agentWakeupRequests.agentId })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.status, "queued"),
        sql`${agentWakeupRequests.runId} is null`,
      ));

    const agentIds = [...new Set([...queuedRuns, ...queuedWakeups].map((r) => r.agentId))];
    for (const agentId of agentIds) {
      await startNextQueuedRunForAgent(agentId);
    }
  }

  async function updateRuntimeState(
    agent: typeof agents.$inferSelect,
    run: typeof heartbeatRuns.$inferSelect,
    result: AdapterExecutionResult,
    session: { legacySessionId: string | null },
    normalizedUsage?: UsageTotals | null,
  ) {
    await ensureRuntimeState(agent);
    const usage = normalizedUsage ?? normalizeUsageTotals(result.usage);
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const cachedInputTokens = usage?.cachedInputTokens ?? 0;
    const billingType = normalizeLedgerBillingType(result.billingType);
    const additionalCostCents = normalizeBilledCostCents(result.costUsd, billingType);
    const hasTokenUsage = inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0;
    const provider = result.provider ?? "unknown";
    const biller = resolveLedgerBiller(result);
    const ledgerScope = await resolveLedgerScopeForRun(db, agent.companyId, run);

    await db
      .update(agentRuntimeState)
      .set({
        adapterType: agent.adapterType,
        sessionId: session.legacySessionId,
        lastRunId: run.id,
        lastRunStatus: run.status,
        lastError: result.errorMessage ?? null,
        totalInputTokens: sql`${agentRuntimeState.totalInputTokens} + ${inputTokens}`,
        totalOutputTokens: sql`${agentRuntimeState.totalOutputTokens} + ${outputTokens}`,
        totalCachedInputTokens: sql`${agentRuntimeState.totalCachedInputTokens} + ${cachedInputTokens}`,
        totalCostCents: sql`${agentRuntimeState.totalCostCents} + ${additionalCostCents}`,
        updatedAt: new Date(),
      })
      .where(eq(agentRuntimeState.agentId, agent.id));

    if (additionalCostCents > 0 || hasTokenUsage) {
      const costs = costService(db, budgetHooks);
      await costs.createEvent(agent.companyId, {
        heartbeatRunId: run.id,
        agentId: agent.id,
        issueId: ledgerScope.issueId,
        projectId: ledgerScope.projectId,
        provider,
        biller,
        billingType,
        model: result.model ?? "unknown",
        inputTokens,
        cachedInputTokens,
        outputTokens,
        costCents: additionalCostCents,
        occurredAt: new Date(),
      });
    }
  }

  async function startNextQueuedRunForAgent(agentId: string) {
    return withAgentStartLock(agentId, async () => {
      const agent = await getAgent(agentId);
      if (!agent) return [];
      if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") {
        return [];
      }
      const policy = parseHeartbeatPolicy(agent);
      const runningCount = await countRunningRunsForAgent(agentId);
      const availableSlots = Math.max(0, policy.maxConcurrentRuns - runningCount);
      if (availableSlots <= 0) return [];

      const queuedRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued")))
        .orderBy(asc(heartbeatRuns.createdAt))
        .limit(availableSlots);

      const claimedRuns: Array<typeof heartbeatRuns.$inferSelect> = [];
      for (const queuedRun of queuedRuns) {
        const claimed = await claimQueuedRun(queuedRun);
        if (claimed) claimedRuns.push(claimed);
      }

      const remainingSlots = availableSlots - claimedRuns.length;
      if (remainingSlots > 0) {
        const promotedRuns = await promoteQueuedWakeupRequestsForAgent(agent, remainingSlots);
        for (const promotedRun of promotedRuns) {
          publishLiveEvent({
            companyId: promotedRun.companyId,
            type: "heartbeat.run.queued",
            payload: {
              runId: promotedRun.id,
              agentId: promotedRun.agentId,
              invocationSource: promotedRun.invocationSource,
              triggerDetail: promotedRun.triggerDetail,
              wakeupRequestId: promotedRun.wakeupRequestId,
            },
          });
          const claimed = await claimQueuedRun(promotedRun);
          if (claimed) claimedRuns.push(claimed);
        }
      }

      if (claimedRuns.length === 0) return [];

      for (const claimedRun of claimedRuns) {
        void executeRun(claimedRun.id).catch((err) => {
          logger.error({ err, runId: claimedRun.id }, "queued heartbeat execution failed");
        });
      }
      return claimedRuns;
    });
  }

  async function promoteQueuedWakeupRequestsForAgent(
    agent: typeof agents.$inferSelect,
    limit: number,
  ) {
    if (limit <= 0) return [];
    const pendingRequests = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, agent.companyId),
        eq(agentWakeupRequests.agentId, agent.id),
        eq(agentWakeupRequests.status, "queued"),
        sql`${agentWakeupRequests.runId} is null`,
      ))
      .orderBy(asc(agentWakeupRequests.requestedAt))
      .limit(Math.max(limit * 4, limit));

    const promotedRuns: Array<typeof heartbeatRuns.$inferSelect> = [];
    for (const pendingRequest of pendingRequests) {
      if (promotedRuns.length >= limit) break;
      const promoted = await promoteQueuedWakeupRequest(agent, pendingRequest.id);
      if (promoted) promotedRuns.push(promoted);
    }
    return promotedRuns;
  }

  async function promoteQueuedWakeupRequest(
    agent: typeof agents.$inferSelect,
    wakeupRequestId: string,
  ) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select id from agent_wakeup_requests where id = ${wakeupRequestId} for update`);
      const request = await tx
        .select()
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.id, wakeupRequestId),
          eq(agentWakeupRequests.companyId, agent.companyId),
          eq(agentWakeupRequests.agentId, agent.id),
          eq(agentWakeupRequests.status, "queued"),
          sql`${agentWakeupRequests.runId} is null`,
        ))
        .then((rows) => rows[0] ?? null);
      if (!request) return null;

      // [거절] agent 가 실행 불가 상태면 run 도 만들지 않고 request 를 terminal-fail.
      if (agent.status === "terminated" || agent.status === "paused" || agent.status === "pending_approval") {
        await tx
          .update(agentWakeupRequests)
          .set({ status: "failed", finishedAt: new Date(), error: `Queued wakeup rejected: agent not runnable (status=${agent.status})`, updatedAt: new Date() })
          .where(eq(agentWakeupRequests.id, request.id));
        return null;
      }

      const requestPayload = parseObject(request.payload);
      const queuedContext = parseObject(requestPayload[DEFERRED_WAKE_CONTEXT_KEY]);
      const promotedPayload = { ...requestPayload };
      delete promotedPayload[DEFERRED_WAKE_CONTEXT_KEY];

      const promotedReason = readNonEmptyString(request.reason);
      const promotedSource =
        (readNonEmptyString(request.source) as WakeupOptions["source"]) ?? "automation";
      const promotedTriggerDetail =
        (readNonEmptyString(request.triggerDetail) as WakeupOptions["triggerDetail"]) ?? null;

      const {
        contextSnapshot: promotedContextSnapshot,
        issueIdFromPayload,
        taskKey: promotedTaskKey,
      } = enrichWakeContextSnapshot({
        contextSnapshot: queuedContext,
        reason: promotedReason,
        source: promotedSource,
        triggerDetail: promotedTriggerDetail,
        payload: promotedPayload,
      });
      const promotedIssueId = readNonEmptyString(promotedContextSnapshot.issueId) ?? issueIdFromPayload;

      const promotedIssue = promotedIssueId
        ? await tx
          .select({
            id: issues.id,
            companyId: issues.companyId,
            projectId: issues.projectId,
            missionId: issues.missionId,
            status: issues.status,
          })
          .from(issues)
          .where(and(eq(issues.id, promotedIssueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null)
        : null;

      if (promotedIssueId && !promotedIssue) {
        await tx
          .update(agentWakeupRequests)
          .set({
            status: "failed",
            finishedAt: new Date(),
            error: "Queued wakeup could not be promoted: issue not found",
            updatedAt: new Date(),
          })
          .where(eq(agentWakeupRequests.id, request.id));
        return null;
      }

      // [거절] issue 가 이미 terminal 이면 재실행 무의미 → request terminal-fail.
      if (promotedIssue && PROMOTED_REJECT_ISSUE_STATUSES.has(promotedIssue.status)) {
        await tx
          .update(agentWakeupRequests)
          .set({ status: "failed", finishedAt: new Date(), error: `Queued wakeup rejected: issue terminal (status=${promotedIssue.status})`, updatedAt: new Date() })
          .where(eq(agentWakeupRequests.id, request.id));
        return null;
      }

      const missionIdForWake =
        readNonEmptyString(promotedContextSnapshot.missionId) ??
        readNonEmptyString(promotedPayload.missionId) ??
        promotedIssue?.missionId ??
        null;
      if (missionIdForWake) {
        const existingMissionRun = await tx
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.agentId, agent.id),
            sql`heartbeat_runs.status in ('queued','running')`,
            sql`heartbeat_runs.context_snapshot ->> 'missionId' = ${missionIdForWake}`,
          ))
          .limit(1);
        if (existingMissionRun.length > 0) return null;

        try {
          await assertMissionRuntimeAcceptsWork(tx as unknown as Db, {
            companyId: agent.companyId,
            missionId: missionIdForWake,
          });
        } catch (err) {
          await tx
            .update(agentWakeupRequests)
            .set({
              status: "failed",
              finishedAt: new Date(),
              error: err instanceof Error ? err.message : "Queued wakeup could not be promoted: mission is terminal",
              updatedAt: new Date(),
            })
            .where(eq(agentWakeupRequests.id, request.id));
          return null;
        }
      }

      const budgetBlock = await budgets.getInvocationBlock(agent.companyId, agent.id, {
        issueId: promotedIssue?.id ?? promotedIssueId,
        projectId: promotedIssue?.projectId ?? readNonEmptyString(promotedContextSnapshot.projectId),
      });
      if (budgetBlock) {
        await tx
          .update(agentWakeupRequests)
          .set({
            status: "failed",
            finishedAt: new Date(),
            error: budgetBlock.reason,
            updatedAt: new Date(),
          })
          .where(eq(agentWakeupRequests.id, request.id));
        return null;
      }

      const sessionBefore = await resolveSessionBeforeForWakeup(agent, promotedTaskKey, {
        missionId: missionIdForWake,
      });
      const now = new Date();
      const newRun = await tx
        .insert(heartbeatRuns)
        .values({
          companyId: agent.companyId,
          agentId: agent.id,
          issueId: promotedIssueId,
          invocationSource: promotedSource,
          triggerDetail: promotedTriggerDetail,
          status: "queued",
          wakeupRequestId: request.id,
          contextSnapshot: promotedContextSnapshot,
          sessionIdBefore: sessionBefore,
        })
        .returning()
        .then((rows) => rows[0]);

      await tx
        .update(agentWakeupRequests)
        .set({
          runId: newRun.id,
          claimedAt: null,
          finishedAt: null,
          error: null,
          updatedAt: now,
        })
        .where(eq(agentWakeupRequests.id, request.id));

      if (promotedIssue) {
        const startedIssue = await tx
          .update(issues)
          .set({
            executionRunId: newRun.id,
            checkoutRunId: newRun.id,
            status: "in_progress",
            startedAt: now,
            executionAgentNameKey: normalizeAgentNameKey(agent.name),
            executionLockedAt: now,
            updatedAt: now,
          })
          .where(and(eq(issues.id, promotedIssue.id), inArray(issues.status, ISSUE_RUN_START_STATUSES)))
          .returning({ id: issues.id })
          .then((rows) => rows[0] ?? null);

        if (startedIssue) {
          await tx.insert(activityLog).values({
            companyId: promotedIssue.companyId,
            actorType: "system",
            actorId: "heartbeat",
            action: "issue.execution_started",
            entityType: "issue",
            entityId: promotedIssue.id,
            agentId: agent.id,
            runId: newRun.id,
            details: {
              previousStatus: promotedIssue.status,
              nextStatus: "in_progress",
              reason: "queued_wakeup_promoted",
            },
          });
        }
      }

      return newRun;
    });
  }

  async function executeRun(runId: string) {
    let run = await getRun(runId);
    if (!run) return;
    if (run.status !== "queued" && run.status !== "running") return;

    if (run.status === "queued") {
      const claimed = await claimQueuedRun(run);
      if (!claimed) {
        // Another worker has already claimed or finalized this run.
        return;
      }
      run = claimed;
    }

    activeRunExecutions.add(run.id);

    try {
    const agent = await getAgent(run.agentId);
    if (!agent) {
      await setRunStatus(runId, "failed", {
        error: "Agent not found",
        errorCode: "agent_not_found",
        finishedAt: new Date(),
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: new Date(),
        error: "Agent not found",
      });
      const failedRun = await getRun(runId);
      if (failedRun) await releaseIssueExecutionAndPromote(failedRun);
      return;
    }

    const runtime = await ensureRuntimeState(agent);
    const context = parseObject(run.contextSnapshot);
    const taskKey = deriveTaskKey(context, null);
    // Mission session branch: when missionId is present, session is keyed by
    // "mission:{missionId}" to ensure reuse across runs within the same mission.
    const missionId = readNonEmptyString(context.missionId);
    const effectiveTaskKey = missionId ? `mission:${missionId}` : taskKey;
    const sessionCodec = getAdapterSessionCodec(agent.adapterType);
    const issueId = readNonEmptyString(context.issueId);
    const issueContext = issueId
      ? await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            description: issues.description,
            status: issues.status,
            priority: issues.priority,
            parentId: issues.parentId,
            projectId: issues.projectId,
            projectWorkspaceId: issues.projectWorkspaceId,
            executionWorkspaceId: issues.executionWorkspaceId,
            executionWorkspacePreference: issues.executionWorkspacePreference,
            missionId: issues.missionId,
            originKind: issues.originKind,
            originId: issues.originId,
            requestDepth: issues.requestDepth,
            assigneeAgentId: issues.assigneeAgentId,
            assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
            executionWorkspaceSettings: issues.executionWorkspaceSettings,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const issueAssigneeOverrides =
      issueContext && issueContext.assigneeAgentId === agent.id
        ? parseIssueAssigneeAdapterOverrides(
            issueContext.assigneeAdapterOverrides,
          )
        : null;
    const isolatedWorkspacesEnabled = (await instanceSettings.getExperimental()).enableIsolatedWorkspaces;
    const issueExecutionWorkspaceSettings = isolatedWorkspacesEnabled
      ? parseIssueExecutionWorkspaceSettings(issueContext?.executionWorkspaceSettings)
      : null;
    const contextProjectId = readNonEmptyString(context.projectId);
    const executionProjectId = issueContext?.projectId ?? contextProjectId;
    const projectExecutionWorkspacePolicy = executionProjectId
      ? await db
          .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
          .from(projects)
          .where(and(eq(projects.id, executionProjectId), eq(projects.companyId, agent.companyId)))
          .then((rows) =>
            gateProjectExecutionWorkspacePolicy(
              parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy),
              isolatedWorkspacesEnabled,
            ))
      : null;
    const taskSession = effectiveTaskKey
      ? await getTaskSession(agent.companyId, agent.id, agent.adapterType, effectiveTaskKey)
      : null;
    const resetTaskSession = shouldResetTaskSessionForWake(context);
    const sessionResetReason = describeSessionResetReason(context);
    const taskSessionForRun = resetTaskSession ? null : taskSession;
    const previousSessionParams = normalizeSessionParams(
      sessionCodec.deserialize(taskSessionForRun?.sessionParamsJson ?? null),
    );
    const missionSessionAuthority = missionId
      ? await resolveMissionSessionAuthority({
          agent,
          missionId,
          adapterType: agent.adapterType,
          taskSessionDisplayId: taskSessionForRun?.sessionDisplayId ?? null,
          taskSessionLegacySessionId: readNonEmptyString(previousSessionParams?.sessionId),
          runtimeSessionId: runtime.sessionId,
          resetTaskSession,
        })
      : null;
    const missionSessionBinding = missionSessionAuthority?.missionSessionBinding ?? null;
    const missionSessionId = missionSessionAuthority?.decision.preferredSessionId ?? null;
    const config = parseObject(agent.adapterConfig);
    const executionWorkspaceMode = resolveExecutionWorkspaceMode({
      projectPolicy: projectExecutionWorkspacePolicy,
      issueSettings: issueExecutionWorkspaceSettings,
      legacyUseProjectWorkspace: issueAssigneeOverrides?.useProjectWorkspace ?? null,
    });
    const resolvedWorkspace = await resolveWorkspaceForRun(
      agent,
      context,
      previousSessionParams,
      { useProjectWorkspace: executionWorkspaceMode !== "agent_default" },
    );
    const workspaceManagedConfig = buildExecutionWorkspaceAdapterConfig({
      agentConfig: config,
      projectPolicy: projectExecutionWorkspacePolicy,
      issueSettings: issueExecutionWorkspaceSettings,
      mode: executionWorkspaceMode,
      legacyUseProjectWorkspace: issueAssigneeOverrides?.useProjectWorkspace ?? null,
    });
    const mergedConfig = issueAssigneeOverrides?.adapterConfig
      ? { ...workspaceManagedConfig, ...issueAssigneeOverrides.adapterConfig }
      : workspaceManagedConfig;
    const { config: resolvedConfig, secretKeys } = await secretsSvc.resolveAdapterConfigForRuntime(
      agent.companyId,
      mergedConfig,
    );
    const runtimeSkillEntries = await companySkills.listRuntimeSkillEntries(agent.companyId);
    const {
      missionAgentRuntimeForRun,
      missionIssueEnvelopePolicy,
      paperclipMissionRuntime,
      paperclipMissionWorkingNote,
    } = await compileMissionRunContext(db, {
      companyId: agent.companyId,
      missionId,
      agentId: agent.id,
      adapterType: agent.adapterType,
      resolvedConfig,
      workspaceId: resolvedWorkspace.workspaceId ?? null,
      workspaceKey: resolvedWorkspace.workspaceId ?? resolvedWorkspace.cwd ?? "default",
      currentIssueId: issueContext?.id ?? issueId ?? null,
      runId: run.id,
      missionSessionId,
    });
    if (paperclipMissionRuntime) {
      context.paperclipMissionRuntime = paperclipMissionRuntime;
    } else {
      delete context.paperclipMissionRuntime;
    }
    if (paperclipMissionWorkingNote) {
      context.paperclipMissionWorkingNote = paperclipMissionWorkingNote;
    } else {
      delete context.paperclipMissionWorkingNote;
    }
    const assignedTaskPromptSection = buildAssignedIssuePromptSection(issueContext);
    const resolvedPromptTemplate = readNonEmptyString(resolvedConfig.promptTemplate);
    const promptTemplateWithIssueTask =
      issueContext
        ? resolvedPromptTemplate
          ? !resolvedPromptTemplate.includes("{{taskBody}}") && !resolvedPromptTemplate.includes("{{#taskId}}")
            ? `${resolvedPromptTemplate}${assignedTaskPromptSection}`
            : resolvedPromptTemplate
          : assignedTaskPromptSection.trim()
        : resolvedPromptTemplate;
    const issueTaskAdapterConfig = issueContext
      ? {
          taskId: issueContext.id,
          taskTitle: issueContext.title,
          taskBody: issueContext.description ?? issueContext.title,
          ...(promptTemplateWithIssueTask ? { promptTemplate: promptTemplateWithIssueTask } : {}),
        }
      : {};
    let runtimeConfig: Record<string, unknown> = {
      ...resolvedConfig,
      ...issueTaskAdapterConfig,
      ...(missionIssueEnvelopePolicy.fullContextInjection ? { paperclipRuntimeSkills: runtimeSkillEntries } : {}),
    };
    runtimeConfig = applyAdapterFallbackRuntimeConfig({ run, context, config: runtimeConfig });

    // Agent self-learning wiki (Phase 2): 해당 agent의 가장 빈번한 과거 실패 교훈을
    // adapter prompt에 주입해 같은 실수가 반복되지 않도록 한다. non-blocking (실패 시 skip).
    try {
      const wikiEntries = await wikiSvc.searchRelevant({
        companyId: agent.companyId,
        agentId: agent.id,
        limit: 3,
      });
      const wikiSection = formatWikiLessons(wikiEntries);
      if (wikiSection) {
        const basePrompt = readNonEmptyString(runtimeConfig.promptTemplate);
        runtimeConfig.promptTemplate = basePrompt ? `${basePrompt}\n\n${wikiSection}` : wikiSection;
      }
    } catch (err) {
      logger.warn({ err, runId: run.id }, "agent-wiki.searchRelevant non-blocking failure");
    }

    const issueRef = issueContext
      ? {
          id: issueContext.id,
          identifier: issueContext.identifier,
          title: issueContext.title,
          projectId: issueContext.projectId,
          projectWorkspaceId: issueContext.projectWorkspaceId,
          executionWorkspaceId: issueContext.executionWorkspaceId,
          executionWorkspacePreference: issueContext.executionWorkspacePreference,
        }
      : null;
    const workflowStepToolContext = await resolveWorkflowStepToolContext({
      db,
      companyId: agent.companyId,
      issueId: issueRef?.id ?? null,
    });
    const workflowStepKnowledgeContext = await resolveWorkflowStepKnowledgeContext({
      db,
      companyId: agent.companyId,
      agentId: agent.id,
      issueId: issueRef?.id ?? null,
      taskKey,
      issueTitle: issueContext?.title ?? null,
      issueDescription: issueContext?.description ?? null,
      note: readNonEmptyString(context.note),
    });
    if (workflowStepToolContext) {
      context.paperclipWorkflowStepToolContract = workflowStepToolContext;
    } else {
      delete context.paperclipWorkflowStepToolContract;
    }
    if (workflowStepKnowledgeContext) {
      context.paperclipWorkflowStepKnowledgeContext = workflowStepKnowledgeContext;
    } else {
      delete context.paperclipWorkflowStepKnowledgeContext;
    }
    const maintenanceGuidanceContext = await resolveMaintenanceGuidanceContext({
      db,
      companyId: agent.companyId,
      agentId: agent.id,
      workflowStepKnowledgeContext,
      issueTitle: issueContext?.title ?? null,
      issueDescription: issueContext?.description ?? null,
      note: readNonEmptyString(context.note),
      taskKey,
    });
    if (maintenanceGuidanceContext) {
      context.paperclipMaintenanceGuidance = maintenanceGuidanceContext;
    } else {
      delete context.paperclipMaintenanceGuidance;
    }
    const maintenanceDecisionContext = issueContext?.missionId && !maintenanceGuidanceContext
      ? null
      : buildMaintenanceDecisionContext({
          issue: issueContext
            ? {
                id: issueContext.id,
                identifier: issueContext.identifier,
                title: issueContext.title,
                description: issueContext.description,
                status: issueContext.status,
                priority: issueContext.priority,
              }
            : null,
          requestedStatus: readNonEmptyString(context.requestedStatus),
          guidance: maintenanceGuidanceContext,
        });
    if (maintenanceDecisionContext) {
      context.paperclipMaintenanceDecision = maintenanceDecisionContext;
      if (issueContext?.id) {
        await logMaintenanceDecisionEvaluated({
          db,
          companyId: agent.companyId,
          agentId: agent.id,
          runId: run.id,
          issue: {
            id: issueContext.id,
            identifier: issueContext.identifier,
            projectId: issueContext.projectId,
          },
          workflow: workflowStepToolContext
            ? {
                workflowRunId: workflowStepToolContext.workflowRunId,
                workflowId: workflowStepToolContext.workflowId,
                stepId: workflowStepToolContext.stepId,
                stepName: workflowStepToolContext.stepName,
              }
            : workflowStepKnowledgeContext
              ? {
                  workflowRunId: workflowStepKnowledgeContext.workflowRunId,
                  workflowId: workflowStepKnowledgeContext.workflowId,
                  stepId: workflowStepKnowledgeContext.stepId,
                  stepName: workflowStepKnowledgeContext.stepName,
                }
              : null,
          decision: maintenanceDecisionContext,
        });
      }
    } else {
      delete context.paperclipMaintenanceDecision;
    }
    const effectiveMissionIdForPlan = issueContext?.missionId ?? missionId;
    if (effectiveMissionIdForPlan) {
      const activePlan = await missionPlanArtifactService(db).getActiveMissionPlan({
        companyId: agent.companyId,
        missionId: effectiveMissionIdForPlan,
      });
      context.paperclipMissionPlan = missionPlanArtifactService(db).summarizeMissionPlanForRuntime(activePlan);
    } else {
      delete context.paperclipMissionPlan;
    }
    const missionOwnerTaskContext = await resolveMissionOwnerTaskContext({
      db,
      companyId: agent.companyId,
      issue: issueContext,
    });
    if (missionOwnerTaskContext) {
      context.paperclipMissionOwnerTaskContext = missionOwnerTaskContext;
    } else {
      delete context.paperclipMissionOwnerTaskContext;
    }
    const missionOwnerPlanningMissionId = issueContext?.originKind === "mission_main_executor_plan"
      ? issueContext.missionId ?? missionId
      : null;
    if (missionOwnerPlanningMissionId) {
      context.paperclipMissionOwnerPlanningContext = await buildMissionOwnerPlanningContext(db, {
        companyId: agent.companyId,
        missionId: missionOwnerPlanningMissionId,
      });
    } else {
      delete context.paperclipMissionOwnerPlanningContext;
    }
    const existingExecutionWorkspace =
      issueRef?.executionWorkspaceId ? await executionWorkspacesSvc.getById(issueRef.executionWorkspaceId) : null;
    const workspaceOperationRecorder = workspaceOperationsSvc.createRecorder({
      companyId: agent.companyId,
      heartbeatRunId: run.id,
      executionWorkspaceId: existingExecutionWorkspace?.id ?? null,
    });
    const executionWorkspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: resolvedWorkspace.cwd,
        source: resolvedWorkspace.source,
        projectId: resolvedWorkspace.projectId,
        workspaceId: resolvedWorkspace.workspaceId,
        repoUrl: resolvedWorkspace.repoUrl,
        repoRef: resolvedWorkspace.repoRef,
      },
      config: runtimeConfig,
      issue: issueRef,
      agent: {
        id: agent.id,
        name: agent.name,
        companyId: agent.companyId,
      },
      recorder: workspaceOperationRecorder,
    });
    const resolvedProjectId = executionWorkspace.projectId ?? issueRef?.projectId ?? executionProjectId ?? null;
    const resolvedProjectWorkspaceId = issueRef?.projectWorkspaceId ?? resolvedWorkspace.workspaceId ?? null;
    const shouldReuseExisting =
      issueRef?.executionWorkspacePreference === "reuse_existing" &&
      existingExecutionWorkspace &&
      existingExecutionWorkspace.status !== "archived";
    let persistedExecutionWorkspace = null;
    try {
      persistedExecutionWorkspace = shouldReuseExisting && existingExecutionWorkspace
        ? await executionWorkspacesSvc.update(existingExecutionWorkspace.id, {
            cwd: executionWorkspace.cwd,
            repoUrl: executionWorkspace.repoUrl,
            baseRef: executionWorkspace.repoRef,
            branchName: executionWorkspace.branchName,
            providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
            providerRef: executionWorkspace.worktreePath,
            status: "active",
            lastUsedAt: new Date(),
            metadata: {
              ...(existingExecutionWorkspace.metadata ?? {}),
              source: executionWorkspace.source,
              createdByRuntime: executionWorkspace.created,
            },
          })
        : resolvedProjectId
          ? await executionWorkspacesSvc.create({
              companyId: agent.companyId,
              projectId: resolvedProjectId,
              projectWorkspaceId: resolvedProjectWorkspaceId,
              sourceIssueId: issueRef?.id ?? null,
              mode:
                executionWorkspaceMode === "isolated_workspace"
                  ? "isolated_workspace"
                  : executionWorkspaceMode === "operator_branch"
                    ? "operator_branch"
                    : executionWorkspaceMode === "agent_default"
                      ? "adapter_managed"
                      : "shared_workspace",
              strategyType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "project_primary",
              name: executionWorkspace.branchName ?? issueRef?.identifier ?? `workspace-${agent.id.slice(0, 8)}`,
              status: "active",
              cwd: executionWorkspace.cwd,
              repoUrl: executionWorkspace.repoUrl,
              baseRef: executionWorkspace.repoRef,
              branchName: executionWorkspace.branchName,
              providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
              providerRef: executionWorkspace.worktreePath,
              lastUsedAt: new Date(),
              openedAt: new Date(),
              metadata: {
                source: executionWorkspace.source,
                createdByRuntime: executionWorkspace.created,
              },
            })
          : null;
    } catch (error) {
      if (executionWorkspace.created) {
        try {
          await cleanupExecutionWorkspaceArtifacts({
            workspace: {
              id: existingExecutionWorkspace?.id ?? `transient-${run.id}`,
              cwd: executionWorkspace.cwd,
              providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
              providerRef: executionWorkspace.worktreePath,
              branchName: executionWorkspace.branchName,
              repoUrl: executionWorkspace.repoUrl,
              baseRef: executionWorkspace.repoRef,
              projectId: resolvedProjectId,
              projectWorkspaceId: resolvedProjectWorkspaceId,
              sourceIssueId: issueRef?.id ?? null,
              metadata: {
                createdByRuntime: true,
                source: executionWorkspace.source,
              },
            },
            projectWorkspace: {
              cwd: resolvedWorkspace.cwd,
              cleanupCommand: null,
            },
            teardownCommand: projectExecutionWorkspacePolicy?.workspaceStrategy?.teardownCommand ?? null,
            recorder: workspaceOperationRecorder,
          });
        } catch (cleanupError) {
          logger.warn(
            {
              runId: run.id,
              issueId,
              executionWorkspaceCwd: executionWorkspace.cwd,
              cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            },
            "Failed to cleanup realized execution workspace after persistence failure",
          );
        }
      }
      throw error;
    }
    await workspaceOperationRecorder.attachExecutionWorkspaceId(persistedExecutionWorkspace?.id ?? null);
    if (
      existingExecutionWorkspace &&
      persistedExecutionWorkspace &&
      existingExecutionWorkspace.id !== persistedExecutionWorkspace.id &&
      existingExecutionWorkspace.status === "active"
    ) {
      await executionWorkspacesSvc.update(existingExecutionWorkspace.id, {
        status: "idle",
        cleanupReason: null,
      });
    }
    if (issueId && persistedExecutionWorkspace && issueRef?.executionWorkspaceId !== persistedExecutionWorkspace.id) {
      await issuesSvc.update(issueId, {
        executionWorkspaceId: persistedExecutionWorkspace.id,
        ...(resolvedProjectWorkspaceId ? { projectWorkspaceId: resolvedProjectWorkspaceId } : {}),
      });
    }
    if (persistedExecutionWorkspace) {
      context.executionWorkspaceId = persistedExecutionWorkspace.id;
      refreshStepInputManifest(context, deriveTaskKey(context, null));
      await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: context,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id));
    }
    const runtimeSessionResolution = resolveRuntimeSessionParamsForWorkspace({
      agentId: agent.id,
      previousSessionParams,
      resolvedWorkspace: {
        ...resolvedWorkspace,
        cwd: executionWorkspace.cwd,
      },
    });
    const runtimeSessionParams = runtimeSessionResolution.sessionParams;
    const runtimeWorkspaceWarnings = [
      ...resolvedWorkspace.warnings,
      ...executionWorkspace.warnings,
      ...(runtimeSessionResolution.warning ? [runtimeSessionResolution.warning] : []),
      ...(resetTaskSession && sessionResetReason
        ? [
            taskKey
              ? `Skipping saved session resume for task "${taskKey}" because ${sessionResetReason}.`
              : `Skipping saved session resume because ${sessionResetReason}.`,
          ]
        : []),
    ];
    context.paperclipWorkspace = {
      cwd: executionWorkspace.cwd,
      source: executionWorkspace.source,
      mode: executionWorkspaceMode,
      strategy: executionWorkspace.strategy,
      projectId: executionWorkspace.projectId,
      workspaceId: executionWorkspace.workspaceId,
      repoUrl: executionWorkspace.repoUrl,
      repoRef: executionWorkspace.repoRef,
      branchName: executionWorkspace.branchName,
      worktreePath: executionWorkspace.worktreePath,
      agentHome: await (async () => {
        const home = resolveDefaultAgentWorkspaceDir(agent.id);
        // worktree: check file-write before agent home mkdir
        await worktreeCheck({
          agent,
          tool: "file-write",
          args: { operation: "agent_home_mkdir" },
          cwd: home,
          filePath: home,
        });
        await fs.mkdir(home, { recursive: true });
        return home;
      })(),
    };
    context.paperclipWorkspaces = resolvedWorkspace.workspaceHints;
    if (issueId) {
      const recentIssueComments = await db
        .select({
          id: issueComments.id,
          authorAgentId: issueComments.authorAgentId,
          authorUserId: issueComments.authorUserId,
          body: issueComments.body,
          createdAt: issueComments.createdAt,
        })
        .from(issueComments)
        .where(and(eq(issueComments.issueId, issueId), eq(issueComments.companyId, agent.companyId)))
        .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
        .limit(5);
      if (recentIssueComments.length > 0) {
        context.paperclipIssueRecentComments = recentIssueComments.map((comment) => ({
          id: comment.id,
          authorType: comment.authorUserId ? "controller" : comment.authorAgentId ? "agent" : "unknown",
          authorAgentId: comment.authorAgentId,
          authorUserId: comment.authorUserId,
          body: comment.body,
          createdAt: comment.createdAt.toISOString(),
        }));
      } else {
        delete context.paperclipIssueRecentComments;
      }
    } else {
      delete context.paperclipIssueRecentComments;
    }
    const wakeCommentId = readNonEmptyString(context.wakeCommentId);
    const wakeComment = wakeCommentId ? await issuesSvc.getComment(wakeCommentId) : null;
    const fileViews = await buildContextSafeFileViews({
      text:
        wakeComment && wakeComment.issueId === issueId
          ? wakeComment.body
          : null,
      workspaceCwd: executionWorkspace.cwd,
      workspaceId: executionWorkspace.workspaceId,
    });
    if (fileViews.length > 0) {
      context.paperclipFileViews = fileViews;
    } else {
      delete context.paperclipFileViews;
    }
    const runtimeServiceIntents = (() => {
      const runtimeConfig = parseObject(resolvedConfig.workspaceRuntime);
      return Array.isArray(runtimeConfig.services)
        ? runtimeConfig.services.filter(
            (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
          )
        : [];
    })();
    if (runtimeServiceIntents.length > 0) {
      context.paperclipRuntimeServiceIntents = runtimeServiceIntents;
    } else {
      delete context.paperclipRuntimeServiceIntents;
    }
    if (executionWorkspace.projectId && !readNonEmptyString(context.projectId)) {
      context.projectId = executionWorkspace.projectId;
    }
    const runtimeSessionFallback = resetTaskSession
      ? null
      : missionSessionId ?? (taskKey ? null : runtime.sessionId);
    let previousSessionDisplayId = truncateDisplayId(
      missionSessionId ??
        taskSessionForRun?.sessionDisplayId ??
        (sessionCodec.getDisplayId ? sessionCodec.getDisplayId(runtimeSessionParams) : null) ??
        readNonEmptyString(runtimeSessionParams?.sessionId) ??
        runtimeSessionFallback,
    );
    let runtimeSessionIdForAdapter =
      readNonEmptyString(runtimeSessionParams?.sessionId) ?? runtimeSessionFallback;
    let runtimeSessionParamsForAdapter = runtimeSessionParams;

    const sessionCompaction = await evaluateSessionCompaction({
      agent,
      sessionId: previousSessionDisplayId ?? runtimeSessionIdForAdapter,
      issueId,
    });
    if (sessionCompaction.rotate) {
      context.paperclipSessionHandoffMarkdown = sessionCompaction.handoffMarkdown;
      context.paperclipSessionHandoff = sessionCompaction.handoffArtifact;
      context.paperclipSessionRotationReason = sessionCompaction.reason;
      context.paperclipPreviousSessionId = previousSessionDisplayId ?? runtimeSessionIdForAdapter;
      runtimeSessionIdForAdapter = null;
      runtimeSessionParamsForAdapter = null;
      previousSessionDisplayId = null;
      if (sessionCompaction.reason) {
        runtimeWorkspaceWarnings.push(
          `Starting a fresh session because ${sessionCompaction.reason}.`,
        );
      }
    } else {
      delete context.paperclipSessionHandoffMarkdown;
      delete context.paperclipSessionHandoff;
      delete context.paperclipSessionRotationReason;
      delete context.paperclipPreviousSessionId;
    }

    const runtimeForAdapter = {
      sessionId: runtimeSessionIdForAdapter,
      sessionParams: runtimeSessionParamsForAdapter,
      sessionDisplayId: previousSessionDisplayId,
      taskKey,
    };
    refreshStepInputManifest(context, taskKey);

    let seq = 1;
      let handle: RunLogHandle | null = null;
      let stdoutExcerpt = "";
      let stderrExcerpt = "";
      let stdoutGuardBuffer = "";
      let stderrGuardBuffer = "";
    try {
      const startedAt = run.startedAt ?? new Date();
      const runningWithSession = await db
        .update(heartbeatRuns)
        .set({
          startedAt,
          sessionIdBefore: runtimeForAdapter.sessionDisplayId ?? runtimeForAdapter.sessionId,
          contextSnapshot: context,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (runningWithSession) run = runningWithSession;

      const runningAgent = await db
        .update(agents)
        .set({ status: "running", updatedAt: new Date() })
        .where(eq(agents.id, agent.id))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (runningAgent) {
        publishLiveEvent({
          companyId: runningAgent.companyId,
          type: "agent.status",
          payload: {
            agentId: runningAgent.id,
            status: runningAgent.status,
            outcome: "running",
          },
        });
      }

      const currentRun = run;
      await appendRunEvent(currentRun, seq++, {
        eventType: "lifecycle",
        stream: "system",
        level: "info",
        message: "run started",
      });

      handle = await runLogStore.begin({
        companyId: run.companyId,
        agentId: run.agentId,
        runId,
      });

      await db
        .update(heartbeatRuns)
        .set({
          logStore: handle.store,
          logRef: handle.logRef,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, runId));

      const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
      const evaluateRuntimeGuardLines = (stream: "stdout" | "stderr", text: string, flush = false) => {
        const currentBuffer = stream === "stdout" ? stdoutGuardBuffer : stderrGuardBuffer;
        const nextBuffer = currentBuffer + text;
        const lines = nextBuffer.split(/\r?\n/);
        const remaining = flush ? "" : (lines.pop() ?? "");
        if (stream === "stdout") stdoutGuardBuffer = remaining;
        else stderrGuardBuffer = remaining;
        return lines.filter((line) => line.trim().length > 0);
      };
      const hermesChatContext = parseObject(context.paperclipHermesChat);
      const hermesChatAssistantMessageId = readNonEmptyString(hermesChatContext.assistantMessageId);
      const hermesChat = hermesChatAssistantMessageId ? hermesChatService(db) : null;
      let lastHermesChatProgressText = "";
      let lastHermesChatProgressUpdateMs = 0;
      const maybeUpdateHermesChatProgress = async (now: Date) => {
        if (!hermesChat || !hermesChatAssistantMessageId || agent.adapterType !== "hermes_local") return;
        const progressText = parseHermesProgressText(stdoutExcerpt);
        if (!progressText || progressText === lastHermesChatProgressText) return;
        if (now.getTime() - lastHermesChatProgressUpdateMs < 2_000) return;
        lastHermesChatProgressText = progressText;
        lastHermesChatProgressUpdateMs = now.getTime();
        try {
          await hermesChat.updateAssistantProgress(hermesChatAssistantMessageId, progressText);
        } catch (err) {
          logger.warn({ err, runId: run.id }, "failed to update Hermes chat progress");
        }
      };
      let lastActivityTouchMs = 0;
      const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
        const sanitizedChunk = redactCurrentUserText(chunk, currentUserRedactionOptions);
        const now = new Date();
        const ts = now.toISOString();
        for (const line of evaluateRuntimeGuardLines(stream, sanitizedChunk)) {
          const runtimeGuard = evaluateRuntimeBroadScanToolGuard({
            adapterType: agent.adapterType,
            line,
            ts,
            context,
          });
          if (runtimeGuard.blocked) {
            throw Object.assign(new Error(runtimeGuard.reason ?? "Step Input Manifest blocked runtime broad scan command"), {
              code: "manifest_broad_scan_tool_blocked",
            });
          }
        }
        if (stream === "stdout") stdoutExcerpt = appendExcerpt(stdoutExcerpt, sanitizedChunk);
        if (stream === "stderr") stderrExcerpt = appendExcerpt(stderrExcerpt, sanitizedChunk);
        if (stream === "stdout") await maybeUpdateHermesChatProgress(now);

        if (handle) {
          await runLogStore.append(handle, {
            stream,
            chunk: sanitizedChunk,
            ts,
          });
        }
        if (now.getTime() - lastActivityTouchMs >= RUN_ACTIVITY_TOUCH_INTERVAL_MS) {
          lastActivityTouchMs = now.getTime();
          await db
            .update(heartbeatRuns)
            .set({ updatedAt: now })
            .where(eq(heartbeatRuns.id, run.id));
        }

        const payloadChunk =
          sanitizedChunk.length > MAX_LIVE_LOG_CHUNK_BYTES
            ? sanitizedChunk.slice(sanitizedChunk.length - MAX_LIVE_LOG_CHUNK_BYTES)
            : sanitizedChunk;

        publishLiveEvent({
          companyId: run.companyId,
          type: "heartbeat.run.log",
          payload: {
            runId: run.id,
            agentId: run.agentId,
            ts,
            stream,
            chunk: payloadChunk,
            truncated: payloadChunk.length !== sanitizedChunk.length,
          },
        });
      };
      for (const warning of runtimeWorkspaceWarnings) {
        const logEntry = formatRuntimeWorkspaceWarningLog(warning);
        await onLog(logEntry.stream, logEntry.chunk);
      }
      const adapterEnv = Object.fromEntries(
        Object.entries(parseObject(resolvedConfig.env)).filter(
          (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
        ),
      );
      const runtimeServices = await ensureRuntimeServicesForRun({
        db,
        runId: run.id,
        agent: {
          id: agent.id,
          name: agent.name,
          companyId: agent.companyId,
        },
        issue: issueRef,
        workspace: executionWorkspace,
        executionWorkspaceId: persistedExecutionWorkspace?.id ?? issueRef?.executionWorkspaceId ?? null,
        config: resolvedConfig,
        adapterEnv,
        onLog,
      });
      if (runtimeServices.length > 0) {
        context.paperclipRuntimeServices = runtimeServices;
        context.paperclipRuntimePrimaryUrl =
          runtimeServices.find((service) => readNonEmptyString(service.url))?.url ?? null;
      }
      refreshStepInputManifest(context, taskKey);
      await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: context,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id));
      if (issueId && (executionWorkspace.created || runtimeServices.some((service) => !service.reused))) {
        try {
          await issuesSvc.addComment(
            issueId,
            buildWorkspaceReadyComment({
              workspace: executionWorkspace,
              runtimeServices,
            }),
            { agentId: agent.id, enqueuePlanQaWakeup },
          );
        } catch (err) {
          await onLog(
            "stderr",
            `[paperclip] Failed to post workspace-ready comment: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
      let earlySessionUpdate: AdapterSessionUpdate | null = null;
      let earlySessionIdAfter: string | null = null;
      const onAdapterMeta = async (meta: AdapterInvocationMeta) => {
        if (meta.env && secretKeys.size > 0) {
          for (const key of secretKeys) {
            if (key in meta.env) meta.env[key] = "***REDACTED***";
          }
        }
        await appendRunEvent(currentRun, seq++, {
          eventType: "adapter.invoke",
          stream: "system",
          level: "info",
          message: "adapter invocation",
          payload: meta as unknown as Record<string, unknown>,
        });
      };
      const onAdapterSessionUpdate = async (update: AdapterSessionUpdate) => {
        const sessionId = readNonEmptyString(update.sessionId);
        if (!sessionId) return;
        const sessionDisplayId = readNonEmptyString(update.sessionDisplayId) ?? sessionId;
        if (earlySessionUpdate?.sessionDisplayId === sessionDisplayId || earlySessionUpdate?.sessionId === sessionId) {
          return;
        }
        earlySessionUpdate = {
          ...update,
          sessionId,
          sessionDisplayId,
          sessionParams: parseObject(update.sessionParams),
        };
        earlySessionIdAfter = sessionDisplayId ?? sessionId;
        await db
          .update(heartbeatRuns)
          .set({
            sessionIdAfter: sessionDisplayId,
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, run.id));
        await appendRunEvent(currentRun, seq++, {
          eventType: "adapter.session.update",
          stream: "system",
          level: "info",
          message: "adapter session discovered",
          payload: earlySessionUpdate as unknown as Record<string, unknown>,
        });
      };

      const adapter = getServerAdapter(agent.adapterType);
      const authToken = adapter.supportsLocalAgentJwt
        ? createLocalAgentJwt(agent.id, agent.companyId, agent.adapterType, run.id)
        : null;
      if (authToken) {
        runtimeConfig = {
          ...runtimeConfig,
          env: {
            ...parseObject(runtimeConfig.env),
            PAPERCLIP_API_KEY: authToken,
          },
        };
      }
      if (adapter.supportsLocalAgentJwt && !authToken) {
        logger.warn(
          {
            companyId: agent.companyId,
            agentId: agent.id,
            runId: run.id,
            adapterType: agent.adapterType,
          },
          "local agent jwt secret missing or invalid; running without injected PAPERCLIP_API_KEY",
        );
      }
      const hasResumableSession = hasResumableSessionForRun(runtimeForAdapter, executionWorkspace.cwd);
      const contextBudgetPreflight = await evaluateContextBudgetPreflight({
        runtimeConfig: agent.runtimeConfig,
        adapterType: agent.adapterType,
        adapterConfig: runtimeConfig,
        agent,
        runId: run.id,
        context,
        hasResumableSession,
        cwd: executionWorkspace.cwd,
        authTokenPresent:
          typeof parseObject(resolvedConfig.env).PAPERCLIP_API_KEY === "string" || Boolean(authToken),
      });
      if (contextBudgetPreflight.blocked) {
        throw Object.assign(
          new Error(
            contextBudgetPreflight.reason ?? "Context budget preflight blocked adapter execution",
          ),
          { code: "context_budget_exceeded" },
        );
      }
      const stepInputManifestGuard = await evaluateStepInputManifestGuard({
        adapterConfig: runtimeConfig,
        agent,
        runId: run.id,
        context,
        hasResumableSession,
        cwd: executionWorkspace.cwd,
      });
      if (stepInputManifestGuard.blocked) {
        throw Object.assign(
          new Error(
            stepInputManifestGuard.reason ?? "Step Input Manifest blocked broad scan instruction",
          ),
          { code: "manifest_broad_scan_blocked" },
        );
      }
      if (missionAgentRuntimeForRun && missionIssueEnvelopePolicy.fullContextInjection) {
        await markMissionRuntimeBootstrapInjected(db, missionAgentRuntimeForRun.runtime.id).catch((err) => {
          logger.warn({ err, missionId, agentId: agent.id }, "failed to mark mission runtime bootstrap injected");
        });
      }

      const adapterResult = await adapter.execute({
        runId: run.id,
        agent: { ...agent, adapterConfig: runtimeConfig },
        runtime: runtimeForAdapter,
        config: runtimeConfig,
        context,
        onLog,
        onMeta: onAdapterMeta,
        onSessionUpdate: onAdapterSessionUpdate,
        onSpawn: async (meta) => {
          await persistRunProcessMetadata(run.id, meta);
        },
        authToken: authToken ?? undefined,
      });
      for (const line of [
        ...evaluateRuntimeGuardLines("stdout", "", true),
        ...evaluateRuntimeGuardLines("stderr", "", true),
      ]) {
        const runtimeGuard = evaluateRuntimeBroadScanToolGuard({
          adapterType: agent.adapterType,
          line,
          ts: new Date().toISOString(),
          context,
        });
        if (runtimeGuard.blocked) {
          throw Object.assign(new Error(runtimeGuard.reason ?? "Step Input Manifest blocked runtime broad scan command"), {
            code: "manifest_broad_scan_tool_blocked",
          });
        }
      }
      const adapterManagedRuntimeServices = adapterResult.runtimeServices
        ? await persistAdapterManagedRuntimeServices({
            db,
            adapterType: agent.adapterType,
            runId: run.id,
            agent: {
              id: agent.id,
              name: agent.name,
              companyId: agent.companyId,
            },
            issue: issueRef,
            workspace: executionWorkspace,
            reports: adapterResult.runtimeServices,
          })
        : [];
      if (adapterManagedRuntimeServices.length > 0) {
        const combinedRuntimeServices = [
          ...runtimeServices,
          ...adapterManagedRuntimeServices,
        ];
        context.paperclipRuntimeServices = combinedRuntimeServices;
        context.paperclipRuntimePrimaryUrl =
          combinedRuntimeServices.find((service) => readNonEmptyString(service.url))?.url ?? null;
        refreshStepInputManifest(context, taskKey);
        await db
          .update(heartbeatRuns)
          .set({
            contextSnapshot: context,
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, run.id));
        if (issueId) {
          try {
            await issuesSvc.addComment(
              issueId,
              buildWorkspaceReadyComment({
                workspace: executionWorkspace,
                runtimeServices: adapterManagedRuntimeServices,
              }),
              { agentId: agent.id, enqueuePlanQaWakeup },
            );
          } catch (err) {
            await onLog(
              "stderr",
              `[paperclip] Failed to post adapter-managed runtime comment: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }
      }
      const nextSessionState = resolveNextSessionState({
        codec: sessionCodec,
        adapterResult,
        previousParams: previousSessionParams,
        previousDisplayId: runtimeForAdapter.sessionDisplayId,
        previousLegacySessionId: runtimeForAdapter.sessionId,
      });
      const persistedSessionIdAfter =
        nextSessionState.displayId ??
        nextSessionState.legacySessionId ??
        earlySessionIdAfter ??
        null;
      const rawUsage = normalizeUsageTotals(adapterResult.usage);
      const sessionUsageResolution = await resolveNormalizedUsageForSession({
        agentId: agent.id,
        runId: run.id,
        sessionId: nextSessionState.displayId ?? nextSessionState.legacySessionId,
        rawUsage,
      });
      const normalizedUsage = sessionUsageResolution.normalizedUsage;

      let outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
      const latestRun = await getRun(run.id);
      const latestTerminalRun = latestRun && isTerminalHeartbeatRunStatus(latestRun.status) ? latestRun : null;
      if (latestTerminalRun?.status === "cancelled") {
        outcome = "cancelled";
      } else if (latestTerminalRun?.status === "timed_out") {
        outcome = "timed_out";
      } else if (latestTerminalRun?.status === "failed") {
        outcome = "failed";
      } else if (latestTerminalRun?.status === "succeeded") {
        outcome = "succeeded";
      } else if (adapterResult.timedOut) {
        outcome = "timed_out";
      } else if ((adapterResult.exitCode ?? 0) === 0 && !adapterResult.errorMessage) {
        outcome = "succeeded";
      } else {
        outcome = "failed";
      }
      const codexAuthAutoBlock =
        outcome === "failed"
          ? detectCodexAuthFailureForAutoBlock({
              adapterType: agent.adapterType,
              errorCode: adapterResult.errorCode ?? null,
              errorMessage: adapterResult.errorMessage ?? null,
              stdoutExcerpt,
              stderrExcerpt,
            })
          : null;

      let logSummary: { bytes: number; sha256?: string; compressed: boolean } | null = null;
      if (handle) {
        logSummary = await runLogStore.finalize(handle);
      }

      const status =
        outcome === "succeeded"
          ? "succeeded"
          : outcome === "cancelled"
            ? "cancelled"
            : outcome === "timed_out"
              ? "timed_out"
              : "failed";

      const usageJson =
        normalizedUsage || adapterResult.costUsd != null
          ? ({
              ...(normalizedUsage ?? {}),
              ...(rawUsage ? {
                rawInputTokens: rawUsage.inputTokens,
                rawCachedInputTokens: rawUsage.cachedInputTokens,
                rawOutputTokens: rawUsage.outputTokens,
              } : {}),
              ...(sessionUsageResolution.derivedFromSessionTotals ? { usageSource: "session_delta" } : {}),
              ...((persistedSessionIdAfter)
                ? { persistedSessionId: persistedSessionIdAfter }
                : {}),
              sessionReused: runtimeForAdapter.sessionId != null || runtimeForAdapter.sessionDisplayId != null,
              taskSessionReused: taskSessionForRun != null,
              freshSession: runtimeForAdapter.sessionId == null && runtimeForAdapter.sessionDisplayId == null,
              sessionRotated: sessionCompaction.rotate,
              sessionRotationReason: sessionCompaction.reason,
              provider: readNonEmptyString(adapterResult.provider) ?? "unknown",
              biller: resolveLedgerBiller(adapterResult),
              model: readNonEmptyString(adapterResult.model) ?? "unknown",
              ...(adapterResult.costUsd != null ? { costUsd: adapterResult.costUsd } : {}),
              billingType: normalizeLedgerBillingType(adapterResult.billingType),
            } as Record<string, unknown>)
          : null;

        if (codexAuthAutoBlock) {
          try {
            await pauseAgentForReauthRequired(agent.id, codexAuthAutoBlock);
          } catch (pauseErr) {
            await onLog(
              "stderr",
              `[paperclip] Failed to mark agent reauth_required after codex auth failure: ${
                pauseErr instanceof Error ? pauseErr.message : String(pauseErr)
              }\n`,
            );
          }
        }

        if (
          codexAuthAutoBlock &&
          issueId &&
          issueContext?.status === "in_progress" &&
          issueContext.assigneeAgentId === agent.id
        ) {
          try {
            const autoBlockedIssue = await issuesSvc.update(issueId, { status: "blocked" });
            if (autoBlockedIssue) {
              const { workflowService } = await import("./workflow/engine.js");
              await workflowService.syncRunStatusForIssue(db, autoBlockedIssue.id);
              await syncSrbSourceIssueStatus({
                db,
                issueId: autoBlockedIssue.id,
                status: autoBlockedIssue.status,
              });
            }
            await issuesSvc.addComment(
              issueId,
              buildCodexAuthAutoBlockedComment({
                ...codexAuthAutoBlock,
                runId: run.id,
              }),
              { agentId: agent.id, enqueuePlanQaWakeup },
            );
          } catch (autoBlockErr) {
            await onLog(
              "stderr",
              `[paperclip] Failed to auto-block issue after codex auth failure: ${
                autoBlockErr instanceof Error ? autoBlockErr.message : String(autoBlockErr)
              }\n`,
            );
          }
      }

      const completedRun = { ...run, status } as typeof heartbeatRuns.$inferSelect;
      await updateRuntimeState(agent, completedRun, adapterResult, {
          legacySessionId: nextSessionState.legacySessionId,
        }, normalizedUsage);
      if (effectiveTaskKey) {
        if (adapterResult.clearSession || (!nextSessionState.params && !nextSessionState.displayId)) {
          await clearTaskSessions(agent.companyId, agent.id, {
            taskKey: effectiveTaskKey,
            adapterType: agent.adapterType,
          });
        } else {
          await upsertTaskSession({
            companyId: agent.companyId,
            agentId: agent.id,
            adapterType: agent.adapterType,
            taskKey: effectiveTaskKey,
            sessionParamsJson: nextSessionState.params,
            sessionDisplayId: nextSessionState.displayId,
            lastRunId: completedRun.id,
            lastError: outcome === "succeeded" ? null : (adapterResult.errorMessage ?? "run_failed"),
          });
        }
      }
      // Touch the mission session record when missionId is present, to update
      // lastActiveAt and increment runCount for idle-timeout tracking.
      if (missionId) {
        const msnStore = missionSessionStore(db);
        if (missionSessionBinding) {
          await persistMissionSessionBinding({
            agent,
            sessionSecretId: missionSessionBinding.session.sessionSecretId,
            sessionId: nextSessionState.legacySessionId,
          }).catch((err) => {
            logger.warn({ err, missionId, agentId: agent.id }, "failed to persist mission session binding");
          });
          await msnStore.touch(missionSessionBinding.session.id).catch((err) => {
            logger.warn({ err, missionId, agentId: agent.id }, "failed to touch mission session");
          });
        }
      }

      const finalizedRun = latestTerminalRun ?? await setRunStatus(run.id, status, {
        finishedAt: new Date(),
        error:
          outcome === "succeeded"
            ? null
            : redactCurrentUserText(
                adapterResult.errorMessage ?? (outcome === "timed_out" ? "Timed out" : "Adapter failed"),
                currentUserRedactionOptions,
              ),
        errorCode:
          outcome === "timed_out"
            ? "timeout"
            : outcome === "cancelled"
              ? "cancelled"
              : outcome === "failed"
                ? (adapterResult.errorCode ?? "adapter_failed")
                : null,
        exitCode: adapterResult.exitCode,
        signal: adapterResult.signal,
        usageJson,
        resultJson: adapterResult.resultJson ?? null,
        sessionIdAfter: persistedSessionIdAfter,
        stdoutExcerpt,
        stderrExcerpt,
        logBytes: logSummary?.bytes,
        logSha256: logSummary?.sha256,
        logCompressed: logSummary?.compressed ?? false,
      });

      if (!latestTerminalRun) {
        await setWakeupStatus(run.wakeupRequestId, outcome === "succeeded" ? "completed" : status, {
          finishedAt: new Date(),
          error: adapterResult.errorMessage ?? null,
        });
      }

      if (finalizedRun) {
        await finalizeHermesChatRun(db, finalizedRun.id).catch((err) => {
          logger.warn({ err, runId: finalizedRun.id }, "failed to finalize Hermes chat response");
        });
        if (!latestTerminalRun) {
          await appendRunEvent(finalizedRun, seq++, {
            eventType: "lifecycle",
            stream: "system",
            level: outcome === "succeeded" ? "info" : "error",
            message: `run ${outcome}`,
            payload: {
              status,
              exitCode: adapterResult.exitCode,
            },
          });
        }
        if (missionAgentRuntimeForRun && missionId) {
          const resultSummary = summarizeHeartbeatRunResultJson(adapterResult.resultJson ?? null);
          const summaryText =
            (typeof resultSummary?.summary === "string" ? resultSummary.summary : null) ??
            (typeof resultSummary?.result === "string" ? resultSummary.result : null) ??
            (typeof resultSummary?.message === "string" ? resultSummary.message : null) ??
            (typeof resultSummary?.error === "string" ? resultSummary.error : null) ??
            adapterResult.errorMessage ??
            `Heartbeat run ${status}`;
          const handoffMarkdown = buildMissionIssueHandoffMarkdown({
            missionId,
            issueId: issueContext?.id ?? issueId ?? null,
            agentId: agent.id,
            runId: finalizedRun.id,
            status,
            issueGoal: issueContext?.description ?? issueContext?.title ?? null,
            summaryText,
            evidenceRefs: [
              { type: "heartbeat_run", id: finalizedRun.id, description: `Run ended with ${status}` },
              ...(finalizedRun.logSha256 ? [{ type: "run_log", id: finalizedRun.logSha256, description: "Finalized run log sha256" }] : []),
            ],
          });
          const handoff = await persistMissionIssueHandoff(db, {
            companyId: agent.companyId,
            missionId,
            issueId: issueContext?.id ?? issueId ?? null,
            agentId: agent.id,
            runId: finalizedRun.id,
            missionSessionId: missionSessionBinding?.session.id ?? null,
            status,
            handoffMarkdown,
            handoffJson: {
              issueGoal: issueContext?.description ?? issueContext?.title ?? undefined,
              actionsTaken: [summaryText],
              evidence: [
                { type: "heartbeat_run", id: finalizedRun.id, description: `Run ended with ${status}` },
              ],
              importantCaveats: ["Handoff is generated from runtime result summary; verify evidence refs before relying on completion claims."],
              stateDelta: { status, runId: finalizedRun.id },
              recommendedNextPrompt: `Continue mission ${missionId}; reconcile handoff ${finalizedRun.id} before selecting next issue.`,
            },
            evidenceRefsJson: [
              { type: "heartbeat_run", id: finalizedRun.id, description: `Run ended with ${status}` },
            ],
          });
          await updateMissionRollingStateFromHandoff(db, {
            companyId: agent.companyId,
            missionId,
            runId: finalizedRun.id,
            issueId: issueContext?.id ?? issueId ?? null,
            handoffId: handoff.id,
            status,
            summaryText,
            inputTokens: normalizedUsage?.inputTokens ?? null,
            outputTokens: normalizedUsage?.outputTokens ?? null,
            costCents: adapterResult.costUsd == null ? null : Math.round(adapterResult.costUsd * 100),
          });
          await completeMissionAgentRuntimeRun(db, {
            runtimeId: missionAgentRuntimeForRun.runtime.id,
            status,
            sessionId: persistedSessionIdAfter,
            inputTokens: normalizedUsage?.inputTokens ?? null,
            outputTokens: normalizedUsage?.outputTokens ?? null,
            costCents: adapterResult.costUsd == null ? null : Math.round(adapterResult.costUsd * 100),
            error: outcome === "succeeded" ? null : adapterResult.errorMessage ?? status,
          });
        }
        let queuedAdapterFallbackRun: typeof heartbeatRuns.$inferSelect | null = null;
        // Adapter failures can use a fallback command, but do not repeat the same
        // fallback after a deterministic provider/model configuration failure.
        if (outcome === "failed" && finalizedRun) {
          const fb = resolveAdapterFallbackConfig(agent.adapterConfig);
          if (fb && shouldQueueRunFailureAdapterFallback({ run: finalizedRun, fallback: fb })) {
            const fallbackRun = await enqueueAdapterFallbackRun(finalizedRun, agent, new Date(), {
              fallbackCommand: fb.command,
              fallbackProvider: fb.provider,
              fallbackModel: fb.model,
              fallbackReason: "run_failed",
            });
            queuedAdapterFallbackRun = fallbackRun;
            await appendRunEvent(finalizedRun, seq++, {
              eventType: "lifecycle",
              stream: "system",
              level: "warn",
              message: `Run failed — queued fallback ${fallbackRun?.id ?? ""}`.trim(),
              payload: {
                exitCode: adapterResult.exitCode ?? null,
                errorMessage: adapterResult.errorMessage ?? null,
                fallbackRunId: fallbackRun?.id ?? null,
              },
            });
          } else if (fb) {
            await appendRunEvent(finalizedRun, seq++, {
              eventType: "lifecycle",
              stream: "system",
              level: "warn",
              message: "Run failed - adapter fallback suppressed",
              payload: {
                exitCode: adapterResult.exitCode ?? null,
                errorMessage: adapterResult.errorMessage ?? null,
                fallbackCommand: fb.command,
                fallbackAttempt: resolveAdapterFallbackAttempt(finalizedRun.contextSnapshot),
                reason: isTerminalAdapterFallbackConfigurationFailure(finalizedRun)
                  ? "terminal_fallback_configuration_failure"
                  : "fallback_attempt_limit_reached",
              },
            });
          }
        }
        if (!queuedAdapterFallbackRun) {
          await releaseIssueExecutionAndPromote(finalizedRun);
        }
      }
      await finalizeAgentStatus(agent.id, outcome);
    } catch (err) {
      const message = redactCurrentUserText(
        err instanceof Error ? err.message : "Unknown adapter failure",
        await getCurrentUserRedactionOptions(),
      );
      const errorCode = resolveHeartbeatFailureCode(err, "adapter_failed");
      logger.error({ err, runId }, "heartbeat execution failed");

      let logSummary: { bytes: number; sha256?: string; compressed: boolean } | null = null;
      if (handle) {
        try {
          logSummary = await runLogStore.finalize(handle);
        } catch (finalizeErr) {
          logger.warn({ err: finalizeErr, runId }, "failed to finalize run log after error");
        }
      }

      const failedRun = await setRunStatus(run.id, "failed", {
        error: message,
        errorCode,
        finishedAt: new Date(),
        stdoutExcerpt,
        stderrExcerpt,
        logBytes: logSummary?.bytes,
        logSha256: logSummary?.sha256,
        logCompressed: logSummary?.compressed ?? false,
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: new Date(),
        error: message,
      });

      if (failedRun) {
        await finalizeHermesChatRun(db, failedRun.id).catch((finalizeErr) => {
          logger.warn({ err: finalizeErr, runId: failedRun.id }, "failed to finalize Hermes chat failure response");
        });
        await appendRunEvent(failedRun, seq++, {
          eventType: "error",
          stream: "system",
          level: "error",
          message,
        });
        let queuedAdapterFallbackRun: typeof heartbeatRuns.$inferSelect | null = null;
        if (errorCode === "adapter_failed") {
          const fb = resolveAdapterFallbackConfig(agent.adapterConfig);
          if (fb && shouldQueueRunFailureAdapterFallback({ run: failedRun, fallback: fb })) {
            const fallbackRun = await enqueueAdapterFallbackRun(failedRun, agent, new Date(), {
              fallbackCommand: fb.command,
              fallbackProvider: fb.provider,
              fallbackModel: fb.model,
              fallbackReason: "run_failed",
            });
            queuedAdapterFallbackRun = fallbackRun;
            await appendRunEvent(failedRun, seq++, {
              eventType: "lifecycle",
              stream: "system",
              level: "warn",
              message: `Run failed — queued fallback ${fallbackRun?.id ?? ""}`.trim(),
              payload: {
                errorMessage: message,
                fallbackRunId: fallbackRun?.id ?? null,
              },
            });
          } else if (fb) {
            await appendRunEvent(failedRun, seq++, {
              eventType: "lifecycle",
              stream: "system",
              level: "warn",
              message: "Run failed - adapter fallback suppressed",
              payload: {
                errorMessage: message,
                fallbackCommand: fb.command,
                fallbackAttempt: resolveAdapterFallbackAttempt(failedRun.contextSnapshot),
                reason: isTerminalAdapterFallbackConfigurationFailure(failedRun)
                  ? "terminal_fallback_configuration_failure"
                  : "fallback_attempt_limit_reached",
              },
            });
          }
        }
        if (missionAgentRuntimeForRun) {
          await completeMissionAgentRuntimeRun(db, {
            runtimeId: missionAgentRuntimeForRun.runtime.id,
            status: "failed",
            sessionId: runtimeForAdapter.sessionDisplayId ?? runtimeForAdapter.sessionId ?? null,
            error: message,
          }).catch((runtimeErr) => {
            logger.warn({ err: runtimeErr, runId, agentId: agent.id }, "failed to mark mission runtime failed");
          });
        }
        if (!queuedAdapterFallbackRun) {
          await releaseIssueExecutionAndPromote(failedRun);
        }

        await updateRuntimeState(agent, failedRun, {
          exitCode: null,
          signal: null,
          timedOut: false,
          errorMessage: message,
        }, {
          legacySessionId: runtimeForAdapter.sessionId,
        });

        if (effectiveTaskKey && (previousSessionParams || previousSessionDisplayId || taskSession)) {
          await upsertTaskSession({
            companyId: agent.companyId,
            agentId: agent.id,
            adapterType: agent.adapterType,
            taskKey: effectiveTaskKey,
            sessionParamsJson: previousSessionParams,
            sessionDisplayId: previousSessionDisplayId,
            lastRunId: failedRun.id,
            lastError: message,
          });
        }
      }

      await finalizeAgentStatus(agent.id, "failed");
    }
    } catch (outerErr) {
          // Setup code before adapter.execute threw (e.g. ensureRuntimeState, resolveWorkspaceForRun).
          // The inner catch did not fire, so we must record the failure here.
          const message = outerErr instanceof Error ? outerErr.message : "Unknown setup failure";
          logger.error({ err: outerErr, runId }, "heartbeat execution setup failed");
          await setRunStatus(runId, "failed", {
            error: message,
            errorCode: resolveHeartbeatFailureCode(outerErr, "adapter_failed"),
            finishedAt: new Date(),
          }).catch(() => undefined);
          await setWakeupStatus(run.wakeupRequestId, "failed", {
            finishedAt: new Date(),
            error: message,
          }).catch(() => undefined);
          const failedRun = await getRun(runId).catch(() => null);
          if (failedRun) {
            // Emit a run-log event so the failure is visible in the run timeline,
            // consistent with what the inner catch block does for adapter failures.
            await appendRunEvent(failedRun, 1, {
              eventType: "error",
              stream: "system",
              level: "error",
              message,
            }).catch(() => undefined);
            await releaseIssueExecutionAndPromote(failedRun).catch(() => undefined);
          }
          // Ensure the agent is not left stuck in "running" if the inner catch handler's
          // DB calls threw (e.g. a transient DB error in finalizeAgentStatus).
          await finalizeAgentStatus(run.agentId, "failed").catch(() => undefined);
        } finally {
          await releaseRuntimeServicesForRun(run.id).catch(() => undefined);
          activeRunExecutions.delete(run.id);
          await startNextQueuedRunForAgent(run.agentId);
        }
  }

  async function releaseIssueExecutionAndPromote(run: typeof heartbeatRuns.$inferSelect) {
    let postTransactionWorkflowIssueSyncIssueId: string | null = null;
    const transactionResult = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from issues where company_id = ${run.companyId} and (execution_run_id = ${run.id} or checkout_run_id = ${run.id}) for update`,
      );

      const issue = await tx
        .select({
          id: issues.id,
          companyId: issues.companyId,
          projectId: issues.projectId,
          missionId: issues.missionId,
          parentId: issues.parentId,
          identifier: issues.identifier,
          title: issues.title,
          description: issues.description,
          originKind: issues.originKind,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, run.companyId),
            run.issueId
              ? or(eq(issues.executionRunId, run.id), eq(issues.checkoutRunId, run.id), eq(issues.id, run.issueId))
              : or(eq(issues.executionRunId, run.id), eq(issues.checkoutRunId, run.id)),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!issue) return;

      const runAgent = await tx
        .select({
          id: agents.id,
          name: agents.name,
          adapterType: agents.adapterType,
          adapterConfig: agents.adapterConfig,
          runtimeConfig: agents.runtimeConfig,
        })
        .from(agents)
        .where(eq(agents.id, run.agentId))
        .then((rows) => rows[0] ?? null);
      const usage = parseObject(run.usageJson);
      const agentAdapterConfig = parseObject(runAgent?.adapterConfig);
      const agentRuntimeConfig = parseObject(runAgent?.runtimeConfig);
      const classification = classifyHeartbeatRunFailure({
        status: run.status,
        adapterType: runAgent?.adapterType ?? null,
        errorCode: run.errorCode,
        errorMessage: run.error,
        stdoutExcerpt: run.stdoutExcerpt,
        stderrExcerpt: run.stderrExcerpt,
        provider: readNonEmptyString(usage.provider),
        model: readNonEmptyString(usage.model),
        command: readNonEmptyString(agentAdapterConfig.command) ?? readNonEmptyString(agentRuntimeConfig.command),
      });

      // Agent self-learning wiki (Phase 1): provider overload / runaway-stdout 패턴 기록 (non-blocking).
      if (classification.category === "overload") {
        fireWikiRecord(wikiSvc, {
          companyId: run.companyId,
          agentId: run.agentId,
          pattern: "provider overload (529/503/500)",
          cause: "외부 LLM provider 일시 과부하(500/503/529)로 요청을 거부/재시도.",
          solution: "adapter가 exponential backoff 재시도를 수행. 회복 후 자동 재개되므로 즉시 수동 개입은 불필요.",
          errorCode: classification.reasonCode ?? "provider_overload",
        }, run.id);
      }
      if (/\bstdout\b.{0,40}exceeded|runaway output/i.test(run.stderrExcerpt ?? "")) {
        fireWikiRecord(wikiSvc, {
          companyId: run.companyId,
          agentId: run.agentId,
          pattern: "adapter 자식 stdout 폭발",
          cause: "어댑터 자식 프로세스가 stdout을 닫지 않고 무한 출력 → event loop 독점 → 64MB cap-kill.",
          solution: "자식의 대량 stdout은 파일 리다이렉트 후 tail. 명령/플래그로 스트리밍 출력 억제.",
          errorCode: "child_stdout_runaway_capkill",
        }, run.id);
      }
      // Agent wiki hook (adapter_failed non-overload): adapter 실행 실패 교훈 축적 (non-blocking).
      // provider overload(529)는 위 overload 분류로 별도 기록되므로 제외. 이 블록은 issue-linked failed run
      // 에 도달(classifyHeartbeatRunFailure 이후)하므로 adapter_failed run을 커버.
      if (run.status === "failed" && run.errorCode === "adapter_failed" && classification.category !== "overload") {
        fireWikiRecord(wikiSvc, {
          companyId: run.companyId,
          agentId: run.agentId,
          pattern: "adapter_failed (adapter 실행 실패)",
          cause: "adapter 실행이 실패해 run 종료. opencode models discovery timeout(20s), command 시작 실패(ENOENT), adapter 내부 에러 등. provider overload(529)는 overload 분류로 별도 기록.",
          solution: "opencode models timeout은 retry+stale serve로 완화. 반복 시 adapter command·PATH·인증·리소스 점검. command 부재는 영구 장애이므로 adapter 설정 확인.",
          errorCode: "adapter_failed",
        }, run.id);
      }

      const isLinkedToRun = issue.checkoutRunId === run.id || issue.executionRunId === run.id || issue.id === run.issueId;
      const shouldAutoCaptureMissionChildOutput =
        run.status === "succeeded" &&
        !!issue.missionId &&
        !!issue.parentId &&
        issue.assigneeAgentId === run.agentId &&
        issue.status !== "done" &&
        issue.status !== "cancelled" &&
        (issue.status === "in_progress" || (issue.status === "blocked" && containsToolLimitLifecycleFailure(run)));
      const shouldAutoCompleteSuccessfulIssue =
        run.status === "succeeded" &&
        isLinkedToRun &&
        issue.status === "in_progress" &&
        issue.assigneeAgentId === run.agentId;
      const requestChangesVerdict = run.status === "succeeded" ? extractRequestChangesVerdict(run) : null;
      const shouldBlockRequestChangesVerdict =
        !!requestChangesVerdict &&
        isLinkedToRun &&
        !!issue.missionId &&
        canApplyRequestChangesValidationGate(issue) &&
        (issue.status === "in_progress" || issue.status === "done") &&
        issue.assigneeAgentId === run.agentId;
      const claimedArtifactPaths =
        run.status === "succeeded" && isLinkedToRun && !!issue.missionId
          ? extractClaimedArtifactPaths(run)
          : [];
      const missionWorkProductPaths = issue.missionId
        ? await resolveMissionWorkProductPaths(tx, {
          companyId: issue.companyId,
          missionId: issue.missionId,
          projectId: issue.projectId,
        })
        : null;
      const allowedArtifactRoot = missionWorkProductPaths?.missionOutputDir ?? null;
      // 이 issue의 workflow step-run metadata에서 명시 graphWorkProductRequired 플래그 조회.
      // stamp가 없으면(undefined) gate가 종래 휴리스틱으로 fallback한다.
      const stepRunMetadata = isLinkedToRun && !!issue.missionId
        ? await tx
          .select({ metadata: workflowStepRuns.metadata })
          .from(workflowStepRuns)
          .where(eq(workflowStepRuns.issueId, issue.id))
          .limit(1)
          .then((rows) => rows[0]?.metadata ?? null)
        : null;
      const stepRunRequiresWorkProduct = resolveStepRunRequiresWorkProduct(stepRunMetadata);
      const shouldCheckMissingWorkProductRegistration =
        // produced-nothing guard: producer-type issue 가 succeeded run 후 workProduct 가 하나도 없으면
        // claimed paths 유무와 무관하게 gate 발화(자동 done 차단). workProduct 가 있으면 통과.
        isLinkedToRun &&
        !!issue.missionId &&
        canApplyMissingWorkProductRegistrationGate(issue, stepRunRequiresWorkProduct) &&
        (issue.status === "in_progress" || issue.status === "done") &&
        issue.assigneeAgentId === run.agentId;

      if (shouldBlockRequestChangesVerdict) {
        const now = new Date();
        await tx
          .update(issues)
          .set({
            status: "blocked",
            checkoutRunId: null,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            completedAt: null,
            updatedAt: now,
          })
          .where(eq(issues.id, issue.id));
        await tx.insert(issueComments).values({
          companyId: issue.companyId,
          issueId: issue.id,
          authorAgentId: run.agentId,
          body: buildRequestChangesValidationGateComment({ run, verdict: requestChangesVerdict }),
        });
        await tx.insert(activityLog).values({
          companyId: issue.companyId,
          actorType: "system",
          actorId: "heartbeat",
          action: "issue.validation_request_changes_auto_blocked",
          entityType: "issue",
          entityId: issue.id,
          agentId: run.agentId,
          runId: run.id,
          details: {
            previousStatus: issue.status,
            nextStatus: "blocked",
            reason: "request_changes_verdict",
            verdict: "REQUEST_CHANGES",
          },
        });
        postTransactionWorkflowIssueSyncIssueId = issue.id;
        // Phase 5 (plan 8.1 final QA / mission quality contract): completion QA run returned
        // REQUEST_CHANGES → best-effort quality review item via the thin writer (no heavy service
        // import on the heartbeat hot path; per-mission dedupe). Never blocks heartbeat on failure.
        try {
          await writeQualityFinding(db, {
            companyId: issue.companyId,
            missionId: issue.missionId!,
            title: `Final QA / purpose-fitness failure — mission ${issue.missionId}`,
            targetType: "mission_output",
            triggerSource: "final_qa_failure",
            targetId: issue.missionId!,
            failureType: "plan_goal_mismatch",
            triggerMetadata: {
              reason: (requestChangesVerdict as { excerpt?: string } | null)?.excerpt ?? "Final QA returned REQUEST_CHANGES.",
            },
          });
        } catch {
          // swallowed: heartbeat validation must not depend on the quality board.
        }
        return {
          promotedRun: null,
          postTransactionRequestChangesOwnerAction: { sourceIssue: issue, run, verdict: requestChangesVerdict },
        };
      }

      if (shouldCheckMissingWorkProductRegistration) {
        const existingWorkProducts = await tx
          .select({
            id: issueWorkProducts.id,
            url: issueWorkProducts.url,
            externalId: issueWorkProducts.externalId,
            status: issueWorkProducts.status,
            isPrimary: issueWorkProducts.isPrimary,
            metadata: issueWorkProducts.metadata,
          })
          .from(issueWorkProducts)
          .where(eq(issueWorkProducts.issueId, issue.id))
          .limit(10);
        const hasSatisfiedExistingWorkProductRegistration = hasSatisfiedWorkProductRegistration({
          existingWorkProducts,
          claimedArtifactPaths,
          issue,
          allowedArtifactRoot,
        });
        const autoRegisteredWorkProduct = hasSatisfiedExistingWorkProductRegistration
          ? null
          : existingWorkProducts.length > 0
            ? null
            : (await autoRegisterWorkProductFromIssueDocument({
                tx,
                issue,
                run,
                claimedArtifactPaths,
                allowedArtifactRoot,
              }) ?? await autoRegisterWorkProductFromClaimedFile({
                tx,
                issue,
                run,
                claimedArtifactPaths,
                allowedArtifactRoot,
                preferClaimedArtifactPath: stepRunRequiresWorkProduct === true || hasDeliverableOutputContract(issue.description),
              }));
        if (!hasSatisfiedWorkProductRegistration({
          existingWorkProducts,
          claimedArtifactPaths,
          issue,
          autoRegisteredWorkProduct,
          allowedArtifactRoot,
        })) {
          const now = new Date();
          await tx
            .update(issues)
            .set({
              status: "blocked",
              checkoutRunId: null,
              executionRunId: null,
              executionAgentNameKey: null,
              executionLockedAt: null,
              completedAt: null,
              updatedAt: now,
            })
            .where(eq(issues.id, issue.id));
          await tx.insert(issueComments).values({
            companyId: issue.companyId,
            issueId: issue.id,
            authorAgentId: run.agentId,
            body: buildMissingWorkProductRegistrationGateComment({ run, claimedArtifactPaths, allowedArtifactRoot }),
          });
          await tx.insert(activityLog).values({
            companyId: issue.companyId,
            actorType: "system",
            actorId: "heartbeat",
            action: "issue.artifact_work_product_missing_auto_blocked",
            entityType: "issue",
            entityId: issue.id,
            agentId: run.agentId,
            runId: run.id,
            details: {
              previousStatus: issue.status,
              nextStatus: "blocked",
              reason: "missing_work_product_registration",
              claimedArtifactPaths,
            },
          });
          // Agent self-learning wiki (Phase 1): workProduct 미등록 패턴 기록 (non-blocking).
          fireWikiRecord(wikiSvc, {
            companyId: issue.companyId,
            agentId: run.agentId,
            missionId: issue.missionId ?? null,
            pattern: "workProduct 미등록",
            cause: "run이 산출물 파일 경로를 보고했지만 issue에 공식 workProduct가 등록되지 않아 mission artifact gate가 해당 이슈를 block함.",
            solution: "산출물 파일을 지정된 출력 디렉토리에 만들고 실행 출력 끝에 `[ARTIFACT]: <절대경로>` 한 줄을 남긴다. workProduct 등록은 시스템이 자동 처리하므로 POST/curl 등록을 시도하지 않는다.",
            errorCode: "workproduct_registration_missing",
          }, run.id);
          postTransactionWorkflowIssueSyncIssueId = issue.id;
          return null;
        }
      }

      if (
        shouldAutoCompleteSuccessfulIssue &&
        issue.originKind === "mission_main_executor_oversight" &&
        issue.missionId
      ) {
        const [mission] = await tx
          .select({ id: missions.id, status: missions.status })
          .from(missions)
          .where(and(eq(missions.id, issue.missionId), eq(missions.companyId, issue.companyId)))
          .limit(1);
        if (mission && !TERMINAL_MISSION_STATUSES.has(mission.status)) {
          const now = new Date();
          const latestRunForComment = await tx
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, run.id))
            .limit(1)
            .then((rows) => rows[0] ?? run);
          await tx
            .update(issues)
            .set({
              status: "todo",
              checkoutRunId: null,
              executionRunId: null,
              executionAgentNameKey: null,
              executionLockedAt: null,
              completedAt: null,
              cancelledAt: null,
              updatedAt: now,
            })
            .where(eq(issues.id, issue.id));
          await tx.insert(issueComments).values({
            companyId: issue.companyId,
            issueId: issue.id,
            authorAgentId: run.agentId,
            body: buildMissionOversightRunSucceededReleaseComment(latestRunForComment, mission.status),
          });
          await tx.insert(activityLog).values({
            companyId: issue.companyId,
            actorType: "system",
            actorId: "heartbeat",
            action: "mission.oversight_run_succeeded_released",
            entityType: "mission",
            entityId: issue.missionId,
            agentId: run.agentId,
            runId: run.id,
            details: {
              issueId: issue.id,
              issueIdentifier: issue.identifier,
              previousStatus: issue.status,
              nextStatus: "todo",
              reason: "oversight_successful_run_kept_alive_until_mission_terminal",
              missionStatus: mission.status,
            },
          });
          postTransactionWorkflowIssueSyncIssueId = issue.id;
          return {
            promotedRun: null,
            postTransactionMissionOwnerPlanDecision: { issue, actorAgentId: run.agentId },
          };
        }
      }

      if (shouldAutoCaptureMissionChildOutput || shouldAutoCompleteSuccessfulIssue) {
        const now = new Date();
        const latestRunForComment = await tx
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, run.id))
          .limit(1)
          .then((rows) => rows[0] ?? run);
        await tx
          .update(issues)
          .set({
            status: "done",
            checkoutRunId: null,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(issues.id, issue.id));
        await tx.insert(issueComments).values({
          companyId: issue.companyId,
          issueId: issue.id,
          authorAgentId: run.agentId,
          body: shouldAutoCaptureMissionChildOutput
            ? buildMissionChildRunOutputComment(latestRunForComment)
            : buildSuccessfulIssueRunAutoCompletedComment(latestRunForComment),
        });
        await tx.insert(activityLog).values({
          companyId: issue.companyId,
          actorType: "system",
          actorId: "heartbeat",
          action: shouldAutoCaptureMissionChildOutput
            ? "issue.lifecycle_gap_auto_completed"
            : "issue.run_succeeded_auto_completed",
          entityType: "issue",
          entityId: issue.id,
          agentId: run.agentId,
          runId: run.id,
          details: {
            previousStatus: issue.status,
            nextStatus: "done",
            reason: shouldAutoCaptureMissionChildOutput
              ? "successful_mission_child_run_output_captured"
              : "successful_checked_out_run_auto_completed",
          },
        });
        postTransactionWorkflowIssueSyncIssueId = issue.id;
        return {
          promotedRun: null,
          postTransactionMissionOwnerPlanDecision: { issue, actorAgentId: run.agentId },
        };
      }

      if (
        ["failed", "timed_out", "cancelled"].includes(run.status) &&
        isLinkedToRun &&
        issue.status === "in_progress" &&
        issue.assigneeAgentId === run.agentId
      ) {
        if (issue.originKind === "mission_main_executor_oversight" && issue.missionId) {
          const now = new Date();
          await tx
            .update(issues)
            .set({
              status: "todo",
              checkoutRunId: null,
              executionRunId: null,
              executionAgentNameKey: null,
              executionLockedAt: null,
              updatedAt: now,
            })
            .where(eq(issues.id, issue.id));
          await tx.insert(issueComments).values({
            companyId: issue.companyId,
            issueId: issue.id,
            authorAgentId: run.agentId,
            body: buildMissionOversightRunFailureComment({ run, classification }),
          });
          await tx.insert(activityLog).values({
            companyId: issue.companyId,
            actorType: "system",
            actorId: "heartbeat",
            action: "mission.oversight_run_failure_observed",
            entityType: "mission",
            entityId: issue.missionId,
            agentId: run.agentId,
            runId: run.id,
            details: {
              issueId: issue.id,
              issueIdentifier: issue.identifier,
              previousStatus: "in_progress",
              nextStatus: "todo",
              reason: "oversight_terminal_run_failure_released",
              runStatus: run.status,
              classification,
            },
          });
          return null;
        }

        const now = new Date();
        await tx
          .update(issues)
          .set({
            status: "blocked",
            checkoutRunId: null,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: now,
          })
          .where(eq(issues.id, issue.id));
        await tx.insert(issueComments).values({
          companyId: issue.companyId,
          issueId: issue.id,
          authorAgentId: run.agentId,
          body: buildFailedIssueRunAutoBlockedComment({ run, classification }),
        });
        await tx.insert(activityLog).values({
          companyId: issue.companyId,
          actorType: "system",
          actorId: "heartbeat",
          action: "issue.run_failure_auto_blocked",
          entityType: "issue",
          entityId: issue.id,
          agentId: run.agentId,
          runId: run.id,
          details: {
            previousStatus: "in_progress",
            nextStatus: "blocked",
            reason: "terminal_run_failure",
            runStatus: run.status,
            classification,
          },
        });
        if (issue.missionId) {
          const oversightIssueId = issue.parentId ?? issue.id;
          if (oversightIssueId !== issue.id) {
            await tx.insert(issueComments).values({
              companyId: issue.companyId,
              issueId: oversightIssueId,
              authorAgentId: run.agentId,
              body: buildMissionWorkerFailureOversightComment({
                run,
                sourceIssue: { id: issue.id, identifier: issue.identifier, title: issue.title },
                classification,
              }),
            });
          }
          await tx.insert(activityLog).values({
            companyId: issue.companyId,
            actorType: "system",
            actorId: "heartbeat",
            action: "mission.worker_run_failure_observed",
            entityType: "mission",
            entityId: issue.missionId,
            agentId: run.agentId,
            runId: run.id,
            details: {
              issueId: issue.id,
              issueIdentifier: issue.identifier,
              oversightIssueId,
              runStatus: run.status,
              classification,
            },
          });
        }
        return null;
      }

      await tx
        .update(issues)
        .set({
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issue.id));

      while (true) {
        const deferred = await tx
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, issue.companyId),
              eq(agentWakeupRequests.status, "deferred_issue_execution"),
              sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
            ),
          )
          .orderBy(asc(agentWakeupRequests.requestedAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);

        if (!deferred) return null;

        const deferredAgent = await tx
          .select()
          .from(agents)
          .where(eq(agents.id, deferred.agentId))
          .then((rows) => rows[0] ?? null);

        if (
          !deferredAgent ||
          deferredAgent.companyId !== issue.companyId ||
          deferredAgent.status === "paused" ||
          deferredAgent.status === "terminated" ||
          deferredAgent.status === "pending_approval"
        ) {
          await tx
            .update(agentWakeupRequests)
            .set({
              status: "failed",
              finishedAt: new Date(),
              error: "Deferred wake could not be promoted: agent is not invokable",
              updatedAt: new Date(),
            })
            .where(eq(agentWakeupRequests.id, deferred.id));
          continue;
        }

        const deferredPayload = parseObject(deferred.payload);
        const deferredContextSeed = parseObject(deferredPayload[DEFERRED_WAKE_CONTEXT_KEY]);
        const promotedContextSeed: Record<string, unknown> = { ...deferredContextSeed };
        const promotedReason = readNonEmptyString(deferred.reason) ?? "issue_execution_promoted";
        const promotedSource =
          (readNonEmptyString(deferred.source) as WakeupOptions["source"]) ?? "automation";
        const promotedTriggerDetail =
          (readNonEmptyString(deferred.triggerDetail) as WakeupOptions["triggerDetail"]) ?? null;
        const promotedPayload = deferredPayload;
        delete promotedPayload[DEFERRED_WAKE_CONTEXT_KEY];

        const {
          contextSnapshot: promotedContextSnapshot,
          taskKey: promotedTaskKey,
        } = enrichWakeContextSnapshot({
          contextSnapshot: promotedContextSeed,
          reason: promotedReason,
          source: promotedSource,
          triggerDetail: promotedTriggerDetail,
          payload: promotedPayload,
        });

        const sessionBefore = await resolveSessionBeforeForWakeup(deferredAgent, promotedTaskKey, {
          missionId: readNonEmptyString(promotedContextSnapshot.missionId),
        });
        const now = new Date();
        const newRun = await tx
          .insert(heartbeatRuns)
          .values({
            companyId: deferredAgent.companyId,
            agentId: deferredAgent.id,
            issueId: issue.id,
            invocationSource: promotedSource,
            triggerDetail: promotedTriggerDetail,
            status: "queued",
            wakeupRequestId: deferred.id,
            contextSnapshot: promotedContextSnapshot,
            sessionIdBefore: sessionBefore,
          })
          .returning()
          .then((rows) => rows[0]);

        await tx
          .update(agentWakeupRequests)
          .set({
            status: "queued",
            reason: "issue_execution_promoted",
            runId: newRun.id,
            claimedAt: null,
            finishedAt: null,
            error: null,
            updatedAt: now,
          })
          .where(eq(agentWakeupRequests.id, deferred.id));

        await tx
          .update(issues)
          .set({
            executionRunId: newRun.id,
            executionAgentNameKey: normalizeAgentNameKey(deferredAgent.name),
            executionLockedAt: now,
            updatedAt: now,
          })
          .where(eq(issues.id, issue.id));

        return newRun;
      }
    });

    const transactionObject =
      !!transactionResult && typeof transactionResult === "object" ? transactionResult : null;
    const hasPostTransactionMissionOwnerPlanDecision =
      !!transactionObject && "postTransactionMissionOwnerPlanDecision" in transactionObject;
    const postTransactionMissionOwnerPlanDecision = hasPostTransactionMissionOwnerPlanDecision
      ? transactionObject.postTransactionMissionOwnerPlanDecision
      : null;
    const hasPostTransactionRequestChangesOwnerAction =
      !!transactionObject && "postTransactionRequestChangesOwnerAction" in transactionObject;
    const postTransactionRequestChangesOwnerAction = hasPostTransactionRequestChangesOwnerAction
      ? transactionObject.postTransactionRequestChangesOwnerAction
      : null;
    const promotedRun = (
      hasPostTransactionMissionOwnerPlanDecision || hasPostTransactionRequestChangesOwnerAction
        ? transactionObject?.promotedRun
        : transactionResult
    ) as typeof heartbeatRuns.$inferSelect | null | undefined;

    if (postTransactionMissionOwnerPlanDecision) {
      await recordMissionOwnerPlanDecisionAfterComment(
        db,
        postTransactionMissionOwnerPlanDecision.issue,
        postTransactionMissionOwnerPlanDecision.actorAgentId,
        enqueuePlanQaWakeup,
      );
    }

    if (postTransactionRequestChangesOwnerAction) {
      await ensureMissionOwnerActionForRequestChanges(postTransactionRequestChangesOwnerAction);
    }

    if (postTransactionWorkflowIssueSyncIssueId) {
      const { workflowService } = await import("./workflow/engine.js");
      await workflowService.syncRunStatusForIssue(db, postTransactionWorkflowIssueSyncIssueId);
    }

    if (!promotedRun) return;

    publishLiveEvent({
      companyId: promotedRun.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: promotedRun.id,
        agentId: promotedRun.agentId,
        invocationSource: promotedRun.invocationSource,
        triggerDetail: promotedRun.triggerDetail,
        wakeupRequestId: promotedRun.wakeupRequestId,
      },
    });

    await startNextQueuedRunForAgent(promotedRun.agentId);
  }

  async function enqueueWakeup(agentId: string, opts: WakeupOptions = {}) {
    const source = opts.source ?? "on_demand";
    const triggerDetail = opts.triggerDetail ?? null;
    const contextSnapshot: Record<string, unknown> = { ...(opts.contextSnapshot ?? {}) };
    const reason = opts.reason ?? null;
    const payload = opts.payload ?? null;
    const {
      contextSnapshot: enrichedContextSnapshot,
      issueIdFromPayload,
      taskKey,
      wakeCommentId,
    } = enrichWakeContextSnapshot({
      contextSnapshot,
      reason,
      source,
      triggerDetail,
      payload,
    });
    const issueId = readNonEmptyString(enrichedContextSnapshot.issueId) ?? issueIdFromPayload;

    let agent = await getAgent(agentId);
    if (!agent) throw notFound("Agent not found");

    if (reason === "retry_failed_run" && issueId) {
      const currentIssueAssignee = await db
        .select({ assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
        .then((rows) => rows[0]?.assigneeAgentId ?? null);

      if (currentIssueAssignee && currentIssueAssignee !== agentId) {
        const assigneeAgent = await getAgent(currentIssueAssignee);
        if (assigneeAgent && assigneeAgent.companyId === agent.companyId) {
          agentId = currentIssueAssignee;
          agent = assigneeAgent;
        }
      }
    }

    const writeSkippedRequest = async (skipReason: string) => {
      await db.insert(agentWakeupRequests).values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason: skipReason,
        payload,
        status: "skipped",
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        finishedAt: new Date(),
        // [Task 1C] typed queue columns — payload JSON 의존 축소.
        requestKind: readNonEmptyString((payload as Record<string, unknown> | null)?.kind as string) ?? readNonEmptyString((payload as Record<string, unknown> | null)?.mutation as string) ?? skipReason,
        issueId: issueId ?? null,
        missionId: readNonEmptyString(enrichedContextSnapshot.missionId) ?? null,
        workflowRunId: readNonEmptyString(enrichedContextSnapshot.workflowRunId) ?? null,
        workflowStepRunId: readNonEmptyString(enrichedContextSnapshot.workflowStepRunId) ?? null,
      });
      // [Task 6C] mirror queue_rejected transition event (all skip paths covered via writeSkippedRequest)
      await recordQueueTransitionEvent({
        companyId: agent.companyId,
        missionId: readNonEmptyString(enrichedContextSnapshot.missionId) ?? null,
        issueId: issueId ?? null,
        workflowRunId: readNonEmptyString(enrichedContextSnapshot.workflowRunId) ?? null,
        workflowStepRunId: readNonEmptyString(enrichedContextSnapshot.workflowStepRunId) ?? null,
        eventType: "queue_rejected",
        layer: "queue",
        decision: "rejected",
        reason: skipReason,
        reasonCode: skipReason,
        idempotencyKey: `queue-rejected:${agent.companyId}:${agentId}:${skipReason}:${issueId ?? "no-issue"}`,
      });
    };

    let projectId = readNonEmptyString(enrichedContextSnapshot.projectId);
    if (!projectId && issueId) {
      projectId = await db
        .select({ projectId: issues.projectId })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
        .then((rows) => rows[0]?.projectId ?? null);
    }

    const missionIdForWake =
      readNonEmptyString(enrichedContextSnapshot.missionId) ??
      (issueId
        ? await db
            .select({ missionId: issues.missionId })
            .from(issues)
            .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
            .then((rows) => rows[0]?.missionId ?? null)
        : null);
    // [AREA: structured-events Task 1D] typed queue context derived from payload/contextSnapshot.
    // 모든 agent_wakeup_requests insert 경로에 mirror. payload 원본은 변경하지 않는다(호환성).
    const typedQueueColumns = {
      requestKind: readNonEmptyString((payload as Record<string, unknown> | null)?.["kind"] as string)
        ?? readNonEmptyString((payload as Record<string, unknown> | null)?.["mutation"] as string)
        ?? reason
        ?? source,
      issueId: issueId ?? null,
      missionId: (missionIdForWake ?? readNonEmptyString(enrichedContextSnapshot.missionId)) ?? null,
      workflowRunId: (readNonEmptyString(enrichedContextSnapshot.workflowRunId)
        ?? readNonEmptyString((payload as Record<string, unknown> | null)?.["workflowRunId"] as string)) ?? null,
      workflowStepRunId: (readNonEmptyString(enrichedContextSnapshot.workflowStepRunId)
        ?? readNonEmptyString((payload as Record<string, unknown> | null)?.["workflowStepRunId"] as string)) ?? null,
    };
    if (missionIdForWake) {
      try {
        await assertMissionRuntimeAcceptsWork(db, {
          companyId: agent.companyId,
          missionId: missionIdForWake,
        });
      } catch (err) {
        await writeSkippedRequest("mission.terminal");
        throw conflict(err instanceof Error ? err.message : "Mission is terminal", {
          missionId: missionIdForWake,
        });
      }
    }

    if (issueId && missionIdForWake) {
      const deferredOpsIssue = await deferOperationsMissionIssueToMainExecutor({
        agent,
        issueId,
        missionId: missionIdForWake,
      });
      if (deferredOpsIssue) {
        await writeSkippedRequest("operations_mission_issue_deferred_to_main_executor");
        if (deferredOpsIssue.mission.ownerAgentId !== agentId) {
          await enqueueWakeup(deferredOpsIssue.mission.ownerAgentId, {
            source: "automation",
            triggerDetail: "operations_mission_boundary",
            reason: "operations_mission_issue_deferred_to_main_executor",
            idempotencyKey: `ops-mission-boundary:${missionIdForWake}:${issueId}:${deferredOpsIssue.ownerAction.id}`,
            requestedByActorType: "system",
            requestedByActorId: "heartbeat",
            payload: {
              issueId: deferredOpsIssue.ownerAction.id,
              sourceIssueId: issueId,
              operationsAgentId: agentId,
            },
            contextSnapshot: {
              taskKey: `issue:${deferredOpsIssue.ownerAction.id}`,
              issueId: deferredOpsIssue.ownerAction.id,
              missionId: missionIdForWake,
              sourceIssueId: issueId,
              roleBoundary: "hermes_ops_chief_of_staff_liaison",
            },
          });
        }
        return null;
      }
    }

    const budgetBlock = await budgets.getInvocationBlock(agent.companyId, agentId, {
      issueId,
      projectId,
    });
    if (budgetBlock) {
      await writeSkippedRequest("budget.blocked");
      throw conflict(budgetBlock.reason, {
        scopeType: budgetBlock.scopeType,
        scopeId: budgetBlock.scopeId,
      });
    }

    if (
      agent.status === "paused" ||
      agent.status === "terminated" ||
      agent.status === "pending_approval"
    ) {
      throw conflict("Agent is not invokable in its current state", { status: agent.status });
    }

    const policy = parseHeartbeatPolicy(agent);

    if (source === "timer" && !policy.enabled) {
      await writeSkippedRequest("heartbeat.disabled");
      return null;
    }
    if (source !== "timer" && !policy.wakeOnDemand) {
      await writeSkippedRequest("heartbeat.wakeOnDemand.disabled");
      return null;
    }

    const bypassIssueExecutionLock =
      reason === "issue_comment_mentioned" ||
      readNonEmptyString(enrichedContextSnapshot.wakeReason) === "issue_comment_mentioned";

    if (issueId && !bypassIssueExecutionLock) {
      const agentNameKey = normalizeAgentNameKey(agent.name);
      const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey, {
        missionId: readNonEmptyString(enrichedContextSnapshot.missionId),
      });

      const outcome = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from issues where id = ${issueId} and company_id = ${agent.companyId} for update`,
        );

        const issue = await tx
          .select({
            id: issues.id,
            companyId: issues.companyId,
            status: issues.status,
            executionRunId: issues.executionRunId,
            executionAgentNameKey: issues.executionAgentNameKey,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null);

        if (!issue) {
          await tx.insert(agentWakeupRequests).values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason: "issue_execution_issue_not_found",
            payload,
            status: "skipped",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
            ...typedQueueColumns,
            finishedAt: new Date(),
          });
          return { kind: "skipped" as const };
        }

        let activeExecutionRun = issue.executionRunId
          ? await tx
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, issue.executionRunId))
            .then((rows) => rows[0] ?? null)
          : null;

        if (activeExecutionRun && activeExecutionRun.status !== "queued" && activeExecutionRun.status !== "running") {
          activeExecutionRun = null;
        }

        if (!activeExecutionRun && issue.executionRunId) {
          await tx
            .update(issues)
            .set({
              executionRunId: null,
              executionAgentNameKey: null,
              executionLockedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(issues.id, issue.id));
        }

        if (!activeExecutionRun) {
          const legacyRun = await tx
            .select()
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, issue.companyId),
                inArray(heartbeatRuns.status, ["queued", "running"]),
                or(eq(heartbeatRuns.issueId, issue.id), sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`),
              ),
            )
            .orderBy(
              sql`case when ${heartbeatRuns.status} = 'running' then 0 else 1 end`,
              asc(heartbeatRuns.createdAt),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (legacyRun) {
            activeExecutionRun = legacyRun;
            const legacyAgent = await tx
              .select({ name: agents.name })
              .from(agents)
              .where(eq(agents.id, legacyRun.agentId))
              .then((rows) => rows[0] ?? null);
            await tx
              .update(issues)
              .set({
                executionRunId: legacyRun.id,
                executionAgentNameKey: normalizeAgentNameKey(legacyAgent?.name),
                executionLockedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(issues.id, issue.id));
          }
        }

        if (activeExecutionRun) {
          const executionAgent = await tx
            .select({ name: agents.name })
            .from(agents)
            .where(eq(agents.id, activeExecutionRun.agentId))
            .then((rows) => rows[0] ?? null);
          const executionAgentNameKey =
            normalizeAgentNameKey(issue.executionAgentNameKey) ??
            normalizeAgentNameKey(executionAgent?.name);
          const isSameExecutionAgent =
            Boolean(executionAgentNameKey) && executionAgentNameKey === agentNameKey;
          const shouldQueueFollowupForCommentWake =
            Boolean(wakeCommentId) &&
            activeExecutionRun.status === "running" &&
            isSameExecutionAgent;

          if (isSameExecutionAgent && !shouldQueueFollowupForCommentWake) {
            const mergedContextSnapshot = mergeCoalescedContextSnapshot(
              activeExecutionRun.contextSnapshot,
              enrichedContextSnapshot,
            );
            refreshStepInputManifest(mergedContextSnapshot, runTaskKey(activeExecutionRun));
            const mergedRun = await tx
              .update(heartbeatRuns)
              .set({
                contextSnapshot: mergedContextSnapshot,
                updatedAt: new Date(),
              })
              .where(eq(heartbeatRuns.id, activeExecutionRun.id))
              .returning()
              .then((rows) => rows[0] ?? activeExecutionRun);

            await tx.insert(agentWakeupRequests).values({
              companyId: agent.companyId,
              agentId,
              source,
              triggerDetail,
              reason: "issue_execution_same_name",
              payload,
              ...typedQueueColumns,
              status: "coalesced",
              coalescedCount: 1,
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
              runId: mergedRun.id,
              finishedAt: new Date(),
            });

            return { kind: "coalesced" as const, run: mergedRun };
          }

          const deferredPayload = {
            ...(payload ?? {}),
            issueId,
            [DEFERRED_WAKE_CONTEXT_KEY]: enrichedContextSnapshot,
          };

          const existingDeferred = await tx
            .select()
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.companyId, agent.companyId),
                eq(agentWakeupRequests.agentId, agentId),
                eq(agentWakeupRequests.status, "deferred_issue_execution"),
                sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
              ),
            )
            .orderBy(asc(agentWakeupRequests.requestedAt))
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (existingDeferred) {
            const existingDeferredPayload = parseObject(existingDeferred.payload);
            const existingDeferredContext = parseObject(existingDeferredPayload[DEFERRED_WAKE_CONTEXT_KEY]);
            const mergedDeferredContext = mergeCoalescedContextSnapshot(
              existingDeferredContext,
              enrichedContextSnapshot,
            );
            refreshStepInputManifest(
              mergedDeferredContext,
              deriveTaskKey(mergedDeferredContext, null),
            );
            const mergedDeferredPayload = {
              ...existingDeferredPayload,
              ...(payload ?? {}),
              issueId,
              [DEFERRED_WAKE_CONTEXT_KEY]: mergedDeferredContext,
            };

            await tx
              .update(agentWakeupRequests)
              .set({
                payload: mergedDeferredPayload,
                coalescedCount: (existingDeferred.coalescedCount ?? 0) + 1,
                updatedAt: new Date(),
              })
              .where(eq(agentWakeupRequests.id, existingDeferred.id));

            return { kind: "deferred" as const };
          }

          await tx.insert(agentWakeupRequests).values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason: "issue_execution_deferred",
            payload: deferredPayload,
            ...typedQueueColumns,
            status: "deferred_issue_execution",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
          });

          return { kind: "deferred" as const };
        }

        // [B] 같은 mission 에 이미 queued/running run 이 있으면 새 run 을 만들지
        // 않는다(중복 run/issue 차단). 대신 wakeup request 를 runId=null queued
        // 상태로 남겨 실행요청 Queue 처럼 처리하고, agent/mission slot 이 비면
        // startNextQueuedRunForAgent 가 실제 heartbeat run 으로 승격한다.
        const missionIdForDedup = readNonEmptyString(enrichedContextSnapshot.missionId);
        if (missionIdForDedup) {
          const existingMissionRun = await tx
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.agentId, agentId),
                sql`heartbeat_runs.status in ('queued','running')`,
                sql`heartbeat_runs.context_snapshot ->> 'missionId' = ${missionIdForDedup}`,
              ),
            )
            .limit(1);
          if (existingMissionRun.length > 0) {
            const queuedPayload = {
              ...(payload ?? {}),
              issueId,
              [DEFERRED_WAKE_CONTEXT_KEY]: enrichedContextSnapshot,
            };
            const existingQueuedWake = await tx
              .select()
              .from(agentWakeupRequests)
              .where(
                and(
                  eq(agentWakeupRequests.companyId, agent.companyId),
                  eq(agentWakeupRequests.agentId, agentId),
                  eq(agentWakeupRequests.status, "queued"),
                  sql`${agentWakeupRequests.runId} is null`,
                  sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
                ),
              )
              .orderBy(asc(agentWakeupRequests.requestedAt))
              .limit(1)
              .then((rows) => rows[0] ?? null);

            if (existingQueuedWake) {
              const existingQueuedPayload = parseObject(existingQueuedWake.payload);
              const existingQueuedContext = parseObject(existingQueuedPayload[DEFERRED_WAKE_CONTEXT_KEY]);
              const mergedQueuedContext = mergeCoalescedContextSnapshot(
                existingQueuedContext,
                enrichedContextSnapshot,
              );
              refreshStepInputManifest(
                mergedQueuedContext,
                deriveTaskKey(mergedQueuedContext, null),
              );
              const mergedQueuedPayload = {
                ...existingQueuedPayload,
                ...(payload ?? {}),
                issueId,
                [DEFERRED_WAKE_CONTEXT_KEY]: mergedQueuedContext,
              };

              await tx
                .update(agentWakeupRequests)
                .set({
                  payload: mergedQueuedPayload,
                  coalescedCount: (existingQueuedWake.coalescedCount ?? 0) + 1,
                  updatedAt: new Date(),
                })
                .where(eq(agentWakeupRequests.id, existingQueuedWake.id));

              return { kind: "deferred" as const };
            }

            await tx.insert(agentWakeupRequests).values({
              companyId: agent.companyId,
              agentId,
              source,
              triggerDetail,
              reason,
              payload: queuedPayload,
              ...typedQueueColumns,
              status: "queued",
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
            });
            return { kind: "deferred" as const };
          }
        }

        const wakeupRequest = await tx
          .insert(agentWakeupRequests)
          .values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason,
            payload,
            ...typedQueueColumns,
            status: "queued",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
          })
          .returning()
          .then((rows) => rows[0]);

        const newRun = await tx
          .insert(heartbeatRuns)
          .values({
            companyId: agent.companyId,
            agentId,
            issueId,
            invocationSource: source,
            triggerDetail,
            status: "queued",
            wakeupRequestId: wakeupRequest.id,
            contextSnapshot: enrichedContextSnapshot,
            sessionIdBefore: sessionBefore,
          })
          .returning()
          .then((rows) => rows[0]);

        await tx
          .update(agentWakeupRequests)
          .set({
            runId: newRun.id,
            updatedAt: new Date(),
          })
          .where(eq(agentWakeupRequests.id, wakeupRequest.id));

        const issueRunStartedAt = new Date();
        const startedIssue = await tx
          .update(issues)
          .set({
            executionRunId: newRun.id,
            checkoutRunId: newRun.id,
            status: "in_progress",
            startedAt: issueRunStartedAt,
            executionAgentNameKey: agentNameKey,
            executionLockedAt: issueRunStartedAt,
            updatedAt: issueRunStartedAt,
          })
          .where(and(eq(issues.id, issue.id), inArray(issues.status, ISSUE_RUN_START_STATUSES)))
          .returning({ id: issues.id })
          .then((rows) => rows[0] ?? null);

        if (startedIssue) {
          await tx.insert(activityLog).values({
            companyId: issue.companyId,
            actorType: "system",
            actorId: "heartbeat",
            action: "issue.execution_started",
            entityType: "issue",
            entityId: issue.id,
            agentId,
            runId: newRun.id,
            details: {
              previousStatus: issue.status,
              nextStatus: "in_progress",
              reason: "issue_linked_run_started",
            },
          });
        }

        return { kind: "queued" as const, run: newRun };
      });

      // [Task 6C] mirror queue decision events based on enqueueWakeup outcome
      if (outcome.kind === "queued" && outcome.run) {
        await recordQueueTransitionEvent({
          companyId: agent.companyId,
          missionId: missionIdForWake,
          issueId: issueId ?? null,
          wakeupRequestId: outcome.run.wakeupRequestId,
          heartbeatRunId: outcome.run.id,
          eventType: "queue_accepted",
          layer: "queue",
          decision: "accepted",
          reason: "heartbeat_run_created",
          reasonCode: "heartbeat_run_created",
          idempotencyKey: `queue-accepted:${outcome.run.wakeupRequestId ?? "no-wake"}:${outcome.run.id}`,
        });
      } else if (outcome.kind === "deferred" || outcome.kind === "coalesced") {
        await recordQueueTransitionEvent({
          companyId: agent.companyId,
          missionId: missionIdForWake,
          issueId: issueId ?? null,
          eventType: "queue_waiting",
          layer: "queue",
          decision: "waiting",
          reason: "active_run_or_execution_lock",
          reasonCode: "active_run_or_execution_lock",
          idempotencyKey: `queue-waiting:${agent.companyId}:${agentId}:${issueId ?? "no-issue"}`,
        });
      }

      if (outcome.kind === "deferred" || outcome.kind === "skipped") return null;
      if (outcome.kind === "coalesced") return outcome.run;

      const newRun = outcome.run;
      publishLiveEvent({
        companyId: newRun.companyId,
        type: "heartbeat.run.queued",
        payload: {
          runId: newRun.id,
          agentId: newRun.agentId,
          invocationSource: newRun.invocationSource,
          triggerDetail: newRun.triggerDetail,
          wakeupRequestId: newRun.wakeupRequestId,
        },
      });

      await startNextQueuedRunForAgent(agent.id);
      return newRun;
    }

    const activeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])))
      .orderBy(desc(heartbeatRuns.createdAt));

    const sameScopeQueuedRun = activeRuns.find(
      (candidate) => candidate.status === "queued" && isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const sameScopeRunningRun = activeRuns.find(
      (candidate) => candidate.status === "running" && isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const shouldQueueFollowupForCommentWake =
      Boolean(wakeCommentId) && Boolean(sameScopeRunningRun) && !sameScopeQueuedRun;

    const coalescedTargetRun =
      sameScopeQueuedRun ??
      (shouldQueueFollowupForCommentWake ? null : sameScopeRunningRun ?? null);

    if (coalescedTargetRun) {
      const mergedContextSnapshot = mergeCoalescedContextSnapshot(
        coalescedTargetRun.contextSnapshot,
        contextSnapshot,
      );
      refreshStepInputManifest(mergedContextSnapshot, runTaskKey(coalescedTargetRun));
      const mergedRun = await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: mergedContextSnapshot,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, coalescedTargetRun.id))
        .returning()
        .then((rows) => rows[0] ?? coalescedTargetRun);

      await db.insert(agentWakeupRequests).values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason,
        payload,
        status: "coalesced",
        coalescedCount: 1,
        ...typedQueueColumns,
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        runId: mergedRun.id,
        finishedAt: new Date(),
      });
      return mergedRun;
    }

    const wakeupRequest = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason,
        payload,
        ...typedQueueColumns,
        status: "queued",
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
      })
      .returning()
      .then((rows) => rows[0]);

    const wakeupMissionId = readNonEmptyString(enrichedContextSnapshot.missionId);
    const wakeupEffectiveTaskKey = wakeupMissionId ? `mission:${wakeupMissionId}` : taskKey;
    const sessionBefore = await resolveSessionBeforeForWakeup(agent, wakeupEffectiveTaskKey, {
      missionId: wakeupMissionId,
    });

    const newRun = await db
      .insert(heartbeatRuns)
      .values({
        companyId: agent.companyId,
        agentId,
        issueId,
        invocationSource: source,
        triggerDetail,
        status: "queued",
        wakeupRequestId: wakeupRequest.id,
        contextSnapshot: enrichedContextSnapshot,
        sessionIdBefore: sessionBefore,
      })
      .returning()
      .then((rows) => rows[0]);

    await db
      .update(agentWakeupRequests)
      .set({
        runId: newRun.id,
        updatedAt: new Date(),
      })
      .where(eq(agentWakeupRequests.id, wakeupRequest.id));

    publishLiveEvent({
      companyId: newRun.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: newRun.id,
        agentId: newRun.agentId,
        invocationSource: newRun.invocationSource,
        triggerDetail: newRun.triggerDetail,
        wakeupRequestId: newRun.wakeupRequestId,
      },
    });

    await startNextQueuedRunForAgent(agent.id);

    return newRun;
  }

  async function listProjectScopedRunIds(companyId: string, projectId: string) {
    const runIssueId = sql<string | null>`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot} ->> 'issueId')`;
    const effectiveProjectId = sql<string | null>`coalesce(${heartbeatRuns.contextSnapshot} ->> 'projectId', ${issues.projectId}::text)`;

    const rows = await db
      .selectDistinctOn([heartbeatRuns.id], { id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .leftJoin(
        issues,
        and(
          eq(issues.companyId, companyId),
          sql`${issues.id}::text = ${runIssueId}`,
        ),
      )
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
          sql`${effectiveProjectId} = ${projectId}`,
        ),
      );

    return rows.map((row) => row.id);
  }

  async function listProjectScopedWakeupIds(companyId: string, projectId: string) {
    const wakeIssueId = sql<string | null>`${agentWakeupRequests.payload} ->> 'issueId'`;
    const effectiveProjectId = sql<string | null>`coalesce(${agentWakeupRequests.payload} ->> 'projectId', ${issues.projectId}::text)`;

    const rows = await db
      .selectDistinctOn([agentWakeupRequests.id], { id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .leftJoin(
        issues,
        and(
          eq(issues.companyId, companyId),
          sql`${issues.id}::text = ${wakeIssueId}`,
        ),
      )
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
          sql`${agentWakeupRequests.runId} is null`,
          sql`${effectiveProjectId} = ${projectId}`,
        ),
      );

    return rows.map((row) => row.id);
  }

  async function cancelPendingWakeupsForBudgetScope(scope: BudgetEnforcementScope) {
    const now = new Date();
    let wakeupIds: string[] = [];

    if (scope.scopeType === "company") {
      wakeupIds = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, scope.companyId),
            inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
            sql`${agentWakeupRequests.runId} is null`,
          ),
        )
        .then((rows) => rows.map((row) => row.id));
    } else if (scope.scopeType === "agent") {
      wakeupIds = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, scope.companyId),
            eq(agentWakeupRequests.agentId, scope.scopeId),
            inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
            sql`${agentWakeupRequests.runId} is null`,
          ),
        )
        .then((rows) => rows.map((row) => row.id));
    } else {
      wakeupIds = await listProjectScopedWakeupIds(scope.companyId, scope.scopeId);
    }

    if (wakeupIds.length === 0) return 0;

    await db
      .update(agentWakeupRequests)
      .set({
        status: "cancelled",
        finishedAt: now,
        error: "Cancelled due to budget pause",
        updatedAt: now,
      })
      .where(inArray(agentWakeupRequests.id, wakeupIds));

    return wakeupIds.length;
  }

  async function cancelRunInternal(runId: string, reason = "Cancelled by control plane") {
    const run = await getRun(runId);
    if (!run) throw notFound("Heartbeat run not found");
    if (run.status !== "running" && run.status !== "queued") return run;

    const running = runningProcesses.get(run.id);
    if (running) {
      running.child.kill("SIGTERM");
      const graceMs = Math.max(1, running.graceSec) * 1000;
      setTimeout(() => {
        if (!running.child.killed) {
          running.child.kill("SIGKILL");
        }
      }, graceMs);
    } else if (terminateRecordedProcess(run.processPid, "SIGTERM")) {
      setTimeout(() => {
        terminateRecordedProcess(run.processPid, "SIGKILL");
      }, 5_000);
    }

    const cancelled = await setRunStatus(run.id, "cancelled", {
      finishedAt: new Date(),
      error: reason,
      errorCode: "cancelled",
    });

    await setWakeupStatus(run.wakeupRequestId, "cancelled", {
      finishedAt: new Date(),
      error: reason,
    });

    if (cancelled) {
      await appendRunEvent(cancelled, 1, {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message: "run cancelled",
      });
      await releaseIssueExecutionAndPromote(cancelled);
    }

    runningProcesses.delete(run.id);
    await finalizeAgentStatus(run.agentId, "cancelled");
    await startNextQueuedRunForAgent(run.agentId);
    return cancelled;
  }

  async function cancelActiveForAgentInternal(agentId: string, reason = "Cancelled due to agent pause") {
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])));

    for (const run of runs) {
      await setRunStatus(run.id, "cancelled", {
        finishedAt: new Date(),
        error: reason,
        errorCode: "cancelled",
      });

      await setWakeupStatus(run.wakeupRequestId, "cancelled", {
        finishedAt: new Date(),
        error: reason,
      });

      const running = runningProcesses.get(run.id);
      if (running) {
        running.child.kill("SIGTERM");
        runningProcesses.delete(run.id);
      } else if (terminateRecordedProcess(run.processPid, "SIGTERM")) {
        setTimeout(() => {
          terminateRecordedProcess(run.processPid, "SIGKILL");
        }, 5_000);
      }
      await releaseIssueExecutionAndPromote(run);
    }

    return runs.length;
  }

  async function cancelBudgetScopeWork(scope: BudgetEnforcementScope) {
    if (scope.scopeType === "agent") {
      await cancelActiveForAgentInternal(scope.scopeId, "Cancelled due to budget pause");
      await cancelPendingWakeupsForBudgetScope(scope);
      return;
    }

    const runIds =
      scope.scopeType === "company"
        ? await db
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, scope.companyId),
              inArray(heartbeatRuns.status, ["queued", "running"]),
            ),
          )
          .then((rows) => rows.map((row) => row.id))
        : await listProjectScopedRunIds(scope.companyId, scope.scopeId);

    for (const runId of runIds) {
      await cancelRunInternal(runId, "Cancelled due to budget pause");
    }

    await cancelPendingWakeupsForBudgetScope(scope);
  }

  return {
    list: async (companyId: string, agentId?: string, limit?: number) => {
      const query = db
        .select(heartbeatRunListColumns)
        .from(heartbeatRuns)
        .where(
          agentId
            ? and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId))
            : eq(heartbeatRuns.companyId, companyId),
        )
        .orderBy(desc(heartbeatRuns.createdAt));

      const rows = limit ? await query.limit(limit) : await query;
      return rows.map((row) => ({
        ...row,
        resultJson: summarizeHeartbeatRunResultJson(row.resultJson),
      }));
    },

    getRun,

    getRuntimeState: async (agentId: string) => {
      const state = await getRuntimeState(agentId);
      const agent = await getAgent(agentId);
      if (!agent) return null;
      const ensured = state ?? (await ensureRuntimeState(agent));
      const latestTaskSession = await db
        .select()
        .from(agentTaskSessions)
        .where(and(eq(agentTaskSessions.companyId, agent.companyId), eq(agentTaskSessions.agentId, agent.id)))
        .orderBy(desc(agentTaskSessions.updatedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      const activeMissionSessions = await db
        .select()
        .from(missionSessions)
        .where(
          and(
            eq(missionSessions.companyId, agent.companyId),
            eq(missionSessions.agentId, agent.id),
            eq(missionSessions.status, "active"),
          ),
        )
        .orderBy(desc(missionSessions.lastActiveAt), desc(missionSessions.createdAt));
      const latestMissionSession = activeMissionSessions[0] ?? null;
      const latestMissionSessionId = latestMissionSession
        ? await secretsSvc
            .resolveSecretValue(agent.companyId, latestMissionSession.sessionSecretId, "latest")
            .catch(() => null)
        : null;
      const sessionAuthority =
        activeMissionSessions.length > 0
          ? "mission_session"
          : latestTaskSession?.sessionDisplayId
            ? "task_session"
            : ensured.sessionId
              ? "runtime_state"
              : "none";

      return {
        ...ensured,
        sessionDisplayId: latestMissionSessionId ?? latestTaskSession?.sessionDisplayId ?? ensured.sessionId,
        sessionParamsJson: sessionAuthority === "task_session" ? (latestTaskSession?.sessionParamsJson ?? null) : null,
        sessionAuthority,
        activeMissionSessionCount: activeMissionSessions.length,
        latestMissionSession: latestMissionSession
          ? {
              missionId: latestMissionSession.missionId,
              sessionId: latestMissionSessionId,
              lastActiveAt: latestMissionSession.lastActiveAt,
              runCount: latestMissionSession.runCount,
            }
          : null,
      };
    },

    listTaskSessions: async (agentId: string) => {
      const agent = await getAgent(agentId);
      if (!agent) throw notFound("Agent not found");

      return db
        .select()
        .from(agentTaskSessions)
        .where(and(eq(agentTaskSessions.companyId, agent.companyId), eq(agentTaskSessions.agentId, agentId)))
        .orderBy(desc(agentTaskSessions.updatedAt), desc(agentTaskSessions.createdAt));
    },

    resetRuntimeSession: async (agentId: string, opts?: { taskKey?: string | null }) => {
      const agent = await getAgent(agentId);
      if (!agent) throw notFound("Agent not found");
      await ensureRuntimeState(agent);
      const taskKey = readNonEmptyString(opts?.taskKey);
      const clearedTaskSessions = await clearTaskSessions(
        agent.companyId,
        agent.id,
        taskKey ? { taskKey, adapterType: agent.adapterType } : undefined,
      );
      const runtimePatch: Partial<typeof agentRuntimeState.$inferInsert> = {
        sessionId: null,
        lastError: null,
        updatedAt: new Date(),
      };
      if (!taskKey) {
        runtimePatch.stateJson = {};
      }

      const updated = await db
        .update(agentRuntimeState)
        .set(runtimePatch)
        .where(eq(agentRuntimeState.agentId, agentId))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!updated) return null;
      return {
        ...updated,
        sessionDisplayId: null,
        sessionParamsJson: null,
        clearedTaskSessions,
      };
    },

    listEvents: (runId: string, afterSeq = 0, limit = 200) =>
      db
        .select()
        .from(heartbeatRunEvents)
        .where(and(eq(heartbeatRunEvents.runId, runId), gt(heartbeatRunEvents.seq, afterSeq)))
        .orderBy(asc(heartbeatRunEvents.seq))
        .limit(Math.max(1, Math.min(limit, 1000))),

    readLog: async (runId: string, opts?: { offset?: number; limitBytes?: number }) => {
      const run = await getRun(runId);
      if (!run) throw notFound("Heartbeat run not found");
      if (!run.logStore || !run.logRef) throw notFound("Run log not found");

      const result = await runLogStore.read(
        {
          store: run.logStore as "local_file",
          logRef: run.logRef,
        },
        opts,
      );

      return {
        runId,
        store: run.logStore,
        logRef: run.logRef,
        ...result,
        content: redactCurrentUserText(result.content, await getCurrentUserRedactionOptions()),
      };
    },

    invoke: async (
      agentId: string,
      source: "timer" | "assignment" | "on_demand" | "automation" | "scheduler" = "on_demand",
      contextSnapshot: Record<string, unknown> = {},
      triggerDetail: string = "manual",
      actor?: { actorType?: "user" | "agent" | "system"; actorId?: string | null },
    ) =>
      enqueueWakeup(agentId, {
        source,
        triggerDetail,
        contextSnapshot,
        requestedByActorType: actor?.actorType,
        requestedByActorId: actor?.actorId ?? null,
      }),

    wakeup: enqueueWakeup,

    reportRunActivity: clearDetachedRunWarning,

    reapOrphanedRuns,

    resumeQueuedRuns,

    tickTimers: async (now = new Date()) => {
      const allAgents = await db.select().from(agents);
      let checked = 0;
      let enqueued = 0;
      let skipped = 0;

      for (const agent of allAgents) {
        if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") continue;
        const policy = parseHeartbeatPolicy(agent);
        if (!policy.enabled || policy.intervalSec <= 0) continue;

        checked += 1;
        const baseline = new Date(agent.lastHeartbeatAt ?? agent.createdAt).getTime();
        const elapsedMs = now.getTime() - baseline;
        if (elapsedMs < policy.intervalSec * 1000) continue;

        // [수정시 영향] 이 에이전트가 이미 queued/running run 을 가지고 있으면
        // timer wake 를 skip 한다. run 이 finalize 되지 않아 lastHeartbeatAt 가
        // 갱신되지 않더라도, active run 이 존재하면 매 tick 새 wake 를 만들지
        // 않는다(매 tick 재발사 + queued run 적체 방지).
        const activeRun = await db
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.agentId, agent.id),
              sql`${heartbeatRuns.status} in ('queued','running')`,
            ),
          )
          .limit(1);
        if (activeRun.length > 0) {
          skipped += 1;
          continue;
        }

        const run = await enqueueWakeup(agent.id, {
          source: "timer",
          triggerDetail: "system",
          reason: "heartbeat_timer",
          requestedByActorType: "system",
          requestedByActorId: "heartbeat_scheduler",
          contextSnapshot: {
            source: "scheduler",
            reason: "interval_elapsed",
            now: now.toISOString(),
          },
        });
        if (run) enqueued += 1;
        else skipped += 1;
      }

      return { checked, enqueued, skipped };
    },

    cancelRun: (runId: string) => cancelRunInternal(runId),

    cancelActiveForAgent: (agentId: string) => cancelActiveForAgentInternal(agentId),

    cancelBudgetScopeWork,

    getActiveRunForAgent: async (agentId: string) => {
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            eq(heartbeatRuns.status, "running"),
          ),
        )
        .orderBy(desc(heartbeatRuns.startedAt))
        .limit(1);
      return run ?? null;
    },
  };
}

/**
 * @fileoverview Plugin management REST API routes
 *
 * This module provides Express routes for managing the complete plugin lifecycle:
 * - Listing and filtering plugins by status
 * - Installing plugins from npm or local paths
 * - Uninstalling plugins (soft delete or hard purge)
 * - Enabling/disabling plugins
 * - Running health diagnostics
 * - Upgrading plugins
 * - Retrieving UI slot contributions for frontend rendering
 * - Discovering and executing plugin-contributed agent tools
 *
 * All routes require board-level authentication (assertBoard middleware).
 *
 * @module server/routes/plugins
 * @see doc/plugins/PLUGIN_SPEC.md for the full plugin specification
 */

import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Request, Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  heartbeatRuns,
  companies,
  pluginEntities,
  pluginWebhookDeliveries,
} from "@paperclipai/db";
import type {
  PluginBridgeErrorCode,
  PluginLauncherRenderContextSnapshot,
} from "@paperclipai/shared";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import { pluginLoader } from "../services/plugin-loader.js";
import { registerPluginCatalogRoutes } from "./plugin-catalog.js";
import { registerPluginConfigRoutes } from "./plugin-config-routes.js";
import { registerPluginDiagnosticsRoutes } from "./plugin-diagnostics-routes.js";
import { registerPluginLifecycleRoutes } from "./plugin-lifecycle-routes.js";
import { logActivity } from "../services/activity-log.js";
import { publishGlobalLiveEvent } from "../services/live-events.js";
import type { PluginJobScheduler } from "../services/plugin-job-scheduler.js";
import type { PluginJobStore } from "../services/plugin-job-store.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { PluginStreamBus } from "../services/plugin-stream-bus.js";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { workflowService } from "../services/workflow/engine.js";
import type { WorkflowDefinition, WorkflowRun, WorkflowStepRun } from "../services/workflow/types.js";
import { issueService } from "../services/issues.js";
import { workProductService } from "../services/work-products.js";
import {
  completeWorkflowToolStepFromResult,
  type WorkflowExecutionMode,
} from "../services/workflow/dag-engine.js";
import {
  executeCoreWorkflowTool,
  resolveRunStepEnv,
} from "../services/workflow/core-tool-executor.js";
import { listWorkflowToolCatalog } from "../services/workflow/tool-catalog.js";
import { authorizeRunToolExecution } from "../services/workflow/plugin-tool-authorization.js";

/** Request body for POST /api/plugins/install */
interface PluginInstallRequest {
  /** npm package name (e.g., @paperclip/plugin-linear) or local path */
  packageName: string;
  /** Target version for npm packages (optional, defaults to latest) */
  version?: string;
  /** True if packageName is a local filesystem path */
  isLocalPath?: boolean;
}

/** Response body for GET /api/plugins/:pluginId/health */
interface PluginHealthCheckResult {
  pluginId: string;
  status: string;
  healthy: boolean;
  checks: Array<{
    name: string;
    passed: boolean;
    message?: string;
  }>;
  lastError?: string;
}

/** UUID v4 regex used for plugin ID route resolution. */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type WorkflowAgentNameById = ReadonlyMap<string, string>;

function serializeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, serializeValue(entry)]),
    );
  }
  return value;
}

function resolveNativeWorkflowAgentName(
  step: WorkflowDefinition["steps"][number],
  agentNameById: WorkflowAgentNameById,
): string {
  const explicitAgentName = typeof step.agentName === "string" ? step.agentName.trim() : "";
  if (explicitAgentName) return explicitAgentName;

  const agentId = typeof step.agentId === "string" ? step.agentId.trim() : "";
  if (!agentId) return "";

  return agentNameById.get(agentId) ?? agentId;
}

async function safeListWorkflowAgentNameById(db: Db, companyId: string): Promise<Map<string, string>> {
  if (typeof (db as { select?: unknown }).select !== "function") return new Map();

  try {
    const agentRows = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    return new Map(
      agentRows
        .filter((agent) => typeof agent.id === "string" && typeof agent.name === "string" && agent.name.trim())
        .map((agent) => [agent.id, agent.name.trim()]),
    );
  } catch {
    return new Map();
  }
}

function nativeWorkflowStepForPlugin(
  step: WorkflowDefinition["steps"][number],
  agentNameById: WorkflowAgentNameById = new Map(),
): Record<string, unknown> {
  const toolNames = Array.isArray(step.toolNames) ? step.toolNames.filter(Boolean) : [];
  const tools = Array.isArray(step.tools) ? step.tools.filter(Boolean) : toolNames;
  const dependencies = Array.isArray(step.dependencies)
    ? step.dependencies
    : Array.isArray(step.dependsOn)
      ? step.dependsOn
      : [];
  const type = step.type ?? (!step.agentId && toolNames.length > 0 ? "tool" : "agent");
  return {
    ...(serializeValue(step) as Record<string, unknown>),
    id: step.id,
    title: step.title ?? step.name,
    description: step.description ?? "",
    type,
    toolName: step.toolName ?? toolNames[0] ?? "",
    agentName: resolveNativeWorkflowAgentName(step, agentNameById),
    toolNames,
    tools,
    dependsOn: dependencies,
    dependencies,
  };
}

function nativeWorkflowDefinitionForPlugin(
  definition: WorkflowDefinition,
  agentNameById: WorkflowAgentNameById = new Map(),
): Record<string, unknown> {
  return {
    ...(serializeValue(definition) as Record<string, unknown>),
    id: definition.id,
    companyId: definition.companyId,
    name: definition.name,
    description: definition.description ?? "",
    status: definition.status ?? "active",
    executionMode: definition.executionMode,
    steps: definition.steps.map((step) => nativeWorkflowStepForPlugin(step, agentNameById)),
  };
}

async function nativeWorkflowRunDetailForPlugin(
  db: Db,
  run: WorkflowRun,
  definition: WorkflowDefinition | null,
  stepRuns: WorkflowStepRun[],
): Promise<Record<string, unknown>> {
  const issueSvc = issueService(db);
  const workProductsSvc = workProductService(db);
  const agentNameById = await safeListWorkflowAgentNameById(db, run.companyId);
  const stepDefinitionById = new Map((definition?.steps ?? []).map((step) => [step.id, nativeWorkflowStepForPlugin(step, agentNameById)]));
  const serializedStepRuns = await Promise.all(stepRuns.map(async (stepRun) => {
    const stepDefinition = stepDefinitionById.get(stepRun.stepId);
    let issueIdentifier: string | undefined;
    let workProducts: unknown[] = [];
    if (stepRun.issueId) {
      try {
        const issue = await issueSvc.getById(stepRun.issueId);
        issueIdentifier = issue && typeof issue.identifier === "string" ? issue.identifier : undefined;
      } catch {
        issueIdentifier = undefined;
      }
      try {
        workProducts = await workProductsSvc.listForIssue(stepRun.issueId);
      } catch {
        workProducts = [];
      }
    }
    return {
      ...(serializeValue(stepRun) as Record<string, unknown>),
      id: stepRun.id,
      status: stepRun.status,
      stepTitle: typeof stepDefinition?.title === "string" ? stepDefinition.title : stepRun.stepId,
      stepType: typeof stepDefinition?.type === "string" ? stepDefinition.type : undefined,
      issueIdentifier,
      workProducts: serializeValue(workProducts),
    };
  }));

  return {
    run: serializeValue(run),
    stepRuns: serializedStepRuns,
    workflow: definition ? nativeWorkflowDefinitionForPlugin(definition, agentNameById) : null,
  };
}

/**
 * Resolve a plugin by either database ID or plugin key.
 *
 * Lookup order:
 * - UUID-like IDs: getById first, then getByKey.
 * - Scoped package keys (e.g. "@scope/name"): getByKey only, never getById.
 * - Other non-UUID IDs: try getById first (test/memory registries may allow this),
 *   then fallback to getByKey. Any UUID parse error from getById is ignored.
 *
 * @param registry - The plugin registry service instance
 * @param pluginId - Either a database UUID or plugin key (manifest id)
 * @returns Plugin record or null if not found
 */
async function resolvePlugin(
  registry: ReturnType<typeof pluginRegistryService>,
  pluginId: string,
) {
  const isUuid = UUID_REGEX.test(pluginId);
  const isScopedPackageKey = pluginId.startsWith("@") || pluginId.includes("/");

  // Scoped package IDs are valid plugin keys but invalid UUIDs.
  // Skip getById() entirely to avoid Postgres uuid parse errors.
  if (isScopedPackageKey && !isUuid) {
    return registry.getByKey(pluginId);
  }

  try {
    const byId = await registry.getById(pluginId);
    if (byId) return byId;
  } catch (error) {
    const maybeCode =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    // Ignore invalid UUID cast errors and continue with key lookup.
    if (maybeCode !== "22P02") {
      throw error;
    }
  }

  return registry.getByKey(pluginId);
}

/**
 * Optional dependencies for plugin job scheduling routes.
 *
 * When provided, job-related routes (list jobs, list runs, trigger job) are
 * mounted. When omitted, the routes return 501 Not Implemented.
 */
export interface PluginRouteJobDeps {
  /** The job scheduler instance. */
  scheduler: PluginJobScheduler;
  /** The job persistence store. */
  jobStore: PluginJobStore;
}

/**
 * Optional dependencies for plugin webhook routes.
 *
 * When provided, the webhook ingestion route is enabled. When omitted,
 * webhook POST requests return 501 Not Implemented.
 */
export interface PluginRouteWebhookDeps {
  /** The worker manager for dispatching handleWebhook RPC calls. */
  workerManager: PluginWorkerManager;
}

/**
 * Optional dependencies for plugin tool routes.
 *
 * When provided, tool discovery and execution routes are enabled.
 * When omitted, the tool routes return 501 Not Implemented.
 */
export interface PluginRouteToolDeps {
  /** The tool dispatcher for listing and executing plugin tools. */
  toolDispatcher: PluginToolDispatcher;
}

/**
 * Optional dependencies for plugin UI bridge routes.
 *
 * When provided, the getData and performAction bridge proxy routes are enabled,
 * allowing plugin UI components to communicate with their worker backend via
 * `usePluginData()` and `usePluginAction()` hooks.
 *
 * @see PLUGIN_SPEC.md §13.8 — `getData`
 * @see PLUGIN_SPEC.md §13.9 — `performAction`
 * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
 */
export interface PluginRouteBridgeDeps {
  /** The worker manager for dispatching getData/performAction RPC calls. */
  workerManager: PluginWorkerManager;
  /** Optional stream bus for SSE push from worker to UI. */
  streamBus?: PluginStreamBus;
}

/** Request body for POST /api/plugins/tools/execute */
interface PluginToolExecuteRequest {
  /** Fully namespaced tool name (e.g., "acme.linear:search-issues"). */
  tool: string;
  /** Parameters matching the tool's declared JSON Schema. */
  parameters?: unknown;
  /** Agent run context. */
  runContext: ToolRunContext;
}

/**
 * Create Express router for plugin management API.
 *
 * Routes provided:
 *
 * | Method | Path | Description |
 * |--------|------|-------------|
 * | GET | /plugins | List all plugins (optional ?status= filter) |
 * | GET | /plugins/ui-contributions | Get UI slots from ready plugins |
 * | GET | /plugins/:pluginId | Get single plugin by ID or key |
 * | POST | /plugins/install | Install from npm or local path |
 * | DELETE | /plugins/:pluginId | Uninstall (optional ?purge=true) |
 * | POST | /plugins/:pluginId/enable | Enable a plugin |
 * | POST | /plugins/:pluginId/disable | Disable a plugin |
 * | GET | /plugins/:pluginId/health | Run health diagnostics |
 * | POST | /plugins/:pluginId/upgrade | Upgrade to newer version |
 * | GET | /plugins/:pluginId/jobs | List jobs for a plugin |
 * | GET | /plugins/:pluginId/jobs/:jobId/runs | List runs for a job |
 * | POST | /plugins/:pluginId/jobs/:jobId/trigger | Manually trigger a job |
 * | POST | /plugins/:pluginId/webhooks/:endpointKey | Receive inbound webhook |
 * | GET | /plugins/tools | List all available plugin tools |
 * | GET | /plugins/tools?pluginId=... | List tools for a specific plugin |
 * | POST | /plugins/tools/execute | Execute a plugin tool |
 * | GET | /plugins/:pluginId/config | Get current plugin config |
 * | POST | /plugins/:pluginId/config | Save (upsert) plugin config |
 * | POST | /plugins/:pluginId/config/test | Test config via validateConfig RPC |
 * | POST | /plugins/:pluginId/bridge/data | Proxy getData to plugin worker |
 * | POST | /plugins/:pluginId/bridge/action | Proxy performAction to plugin worker |
 * | POST | /plugins/:pluginId/data/:key | Proxy getData to plugin worker (key in URL) |
 * | POST | /plugins/:pluginId/actions/:key | Proxy performAction to plugin worker (key in URL) |
 * | GET | /plugins/:pluginId/bridge/stream/:channel | SSE stream from worker to UI |
 * | GET | /plugins/:pluginId/dashboard | Aggregated health dashboard data |
 *
 * **Route Ordering Note:** Static routes (like /ui-contributions, /tools) must be
 * registered before parameterized routes (like /:pluginId) to prevent Express from
 * matching them as a plugin ID.
 *
 * @param db - Database connection instance
 * @param jobDeps - Optional job scheduling dependencies
 * @param webhookDeps - Optional webhook ingestion dependencies
 * @param toolDeps - Optional tool dispatcher dependencies
 * @param bridgeDeps - Optional bridge proxy dependencies for getData/performAction
 * @returns Express router with plugin routes mounted
 */
export function pluginRoutes(
  db: Db,
  loader: ReturnType<typeof pluginLoader>,
  jobDeps?: PluginRouteJobDeps,
  webhookDeps?: PluginRouteWebhookDeps,
  toolDeps?: PluginRouteToolDeps,
  bridgeDeps?: PluginRouteBridgeDeps,
) {
  const router = Router();
  const registry = pluginRegistryService(db);
  const lifecycle = pluginLifecycleManager(db, {
    loader,
    workerManager: bridgeDeps?.workerManager ?? webhookDeps?.workerManager,
  });

  /**
   * Compute plugin health checks, including the worker-reported `health` RPC.
   * Shared by GET /plugins/:pluginId/health and /dashboard so both reflect
   * worker truth (registry/manifest/status alone can report "healthy" while a
   * configured backend is actually unreachable).
   *
   * Note: the worker health RPC returns the plugin's real state (degraded/error).
   *   When status is not "ok", healthy is forced to false. An unsupported RPC or
   *   timeout is treated as a failed check.
   */
  async function computePluginHealth(plugin: {
    id: string;
    status: string;
    manifestJson: { id?: string } | null;
    lastError: string | null;
  }): Promise<PluginHealthCheckResult> {
    const checks: PluginHealthCheckResult["checks"] = [];

    checks.push({ name: "registry", passed: true, message: "Plugin found in registry" });

    const hasValidManifest = Boolean(plugin.manifestJson?.id);
    checks.push({
      name: "manifest",
      passed: hasValidManifest,
      message: hasValidManifest ? "Manifest is valid" : "Manifest is invalid or missing",
    });

    const statusOk = plugin.status === "ready";
    checks.push({ name: "status", passed: statusOk, message: `Current status: ${plugin.status}` });

    const hasNoError = !plugin.lastError;
    if (!hasNoError) {
      checks.push({ name: "error_state", passed: false, message: plugin.lastError ?? undefined });
    }

    // Worker-reported health RPC (plugin truth). Only when a worker handle exists.
    const wm = bridgeDeps?.workerManager ?? webhookDeps?.workerManager ?? null;
    const handle = wm?.getWorker(plugin.id);
    let workerHealthOk = true;
    if (handle) {
      try {
        const diag = await handle.call("health", {} as Record<string, never>, 3000);
        const ok = diag.status === "ok";
        workerHealthOk = ok;
        checks.push({
          name: "worker_health",
          passed: ok,
          message: diag.message?.trim() ? diag.message : `Worker reports: ${diag.status}`,
        });
      } catch (err) {
        workerHealthOk = false;
        checks.push({
          name: "worker_health",
          passed: false,
          message: `Worker health RPC failed: ${err instanceof Error ? err.message : "unknown error"}`,
        });
      }
    }

    const healthy = statusOk && hasValidManifest && hasNoError && workerHealthOk;
    return {
      pluginId: plugin.id,
      status: plugin.status,
      healthy,
      checks,
      lastError: plugin.lastError ?? undefined,
    };
  }

  const nativeWorkflowActionKeys = new Set([
    "create-workflow",
    "update-workflow",
    "delete-workflow",
    "start-workflow",
    "resume-run",
    "cancel-run",
    "abort-run",
    "manual-complete",
    "handle-tool-execution-result",
  ]);

  function normalizedWorkflowActionParams(
    key: string,
    body: ({
      companyId?: string;
      params?: Record<string, unknown>;
      renderEnvironment?: PluginLauncherRenderContextSnapshot | null;
    } & Record<string, unknown>) | PluginBridgeActionRequest | undefined,
  ): Record<string, unknown> {
    if (body?.params && typeof body.params === "object") return body.params;
    if (!body || !nativeWorkflowActionKeys.has(key)) return {};

    const { renderEnvironment: _renderEnvironment, params: _params, key: _key, ...topLevelParams } =
      body as Record<string, unknown>;
    return topLevelParams;
  }

  function parseNativeWorkflowExecutionMode(value: unknown): WorkflowExecutionMode | undefined {
    return value === "static_dag" || value === "dynamic_owner_plan" ? value : undefined;
  }

  function parsePluginWorkflowStatus(value: unknown): "active" | "paused" | "archived" | undefined {
    return value === "active" || value === "paused" || value === "archived" ? value : undefined;
  }

  const pluginWorkflowPatchKeys = [
    "name",
    "description",
    "status",
    "triggerLabels",
    "labelIds",
    "steps",
    "schedule",
    "projectId",
    "goalId",
    "maxDailyRuns",
    "timezone",
    "deadlineTime",
    "createParentIssuePolicy",
    "executionMode",
    "dynamicPlanBootstrapOnly",
    "lastScheduledRunAt",
    "lastScheduleError",
    "lastScheduleErrorAt",
  ] as const;

  function pickPluginWorkflowPatch(source: Record<string, unknown>): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    for (const key of pluginWorkflowPatchKeys) {
      if (key in source) patch[key] = source[key];
    }
    return patch;
  }

  function mergePluginWorkflowData(
    current: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Record<string, unknown> {
    const merged = { ...current, ...patch };
    for (const key of Object.keys(merged)) {
      if (merged[key] === undefined) delete merged[key];
    }
    return merged;
  }

  function requiredCompanyId(
    params: Record<string, unknown>,
    body: { companyId?: string } | undefined,
  ): string | null {
    const value = typeof params.companyId === "string"
      ? params.companyId.trim()
      : typeof body?.companyId === "string"
        ? body.companyId.trim()
        : "";
    return value || null;
  }

  async function updatePluginWorkflowDefinitionEntity(input: {
    companyId: string;
    pluginId: string;
    workflowId: string;
    patch: Record<string, unknown>;
  }): Promise<Record<string, unknown> | null> {
    const selectableDb = db as Db & { select?: unknown; update?: unknown };
    if (typeof selectableDb.select !== "function" || typeof selectableDb.update !== "function") return null;

    const rows = await db
      .select({
        id: pluginEntities.id,
        data: pluginEntities.data,
        status: pluginEntities.status,
      })
      .from(pluginEntities)
      .where(and(
        eq(pluginEntities.pluginId, input.pluginId),
        eq(pluginEntities.entityType, "workflow-definition"),
        eq(pluginEntities.scopeKind, "company"),
        eq(pluginEntities.scopeId, input.companyId),
      ));

    const pluginDefinition = rows.find((row) => {
      const data = row.data && typeof row.data === "object" ? row.data as Record<string, unknown> : {};
      return row.id === input.workflowId || data.id === input.workflowId;
    });
    if (!pluginDefinition) return null;

    const currentData = pluginDefinition.data && typeof pluginDefinition.data === "object"
      ? pluginDefinition.data as Record<string, unknown>
      : {};
    const data = mergePluginWorkflowData(currentData, input.patch);
    const status = parsePluginWorkflowStatus(data.status);
    const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : undefined;

    await db
      .update(pluginEntities)
      .set({
        data,
        ...(status ? { status } : {}),
        ...(name ? { title: name } : {}),
        updatedAt: new Date(),
      })
      .where(eq(pluginEntities.id, pluginDefinition.id));

    return data;
  }

  async function refreshNativeWorkflowDefinitionFromPluginEntity(input: {
    companyId: string;
    pluginId: string;
    workflowId: string;
  }): Promise<void> {
    const selectableDb = db as Db & { select?: unknown };
    if (typeof selectableDb.select !== "function") return;

    const rows = await db
      .select({
        id: pluginEntities.id,
        data: pluginEntities.data,
      })
      .from(pluginEntities)
      .where(and(
        eq(pluginEntities.pluginId, input.pluginId),
        eq(pluginEntities.entityType, "workflow-definition"),
        eq(pluginEntities.scopeKind, "company"),
        eq(pluginEntities.scopeId, input.companyId),
      ));

    const pluginDefinition = rows.find((row) => {
      const data = row.data && typeof row.data === "object" ? row.data as Record<string, unknown> : {};
      return row.id === input.workflowId || data.id === input.workflowId;
    });
    const data = pluginDefinition?.data && typeof pluginDefinition.data === "object"
      ? pluginDefinition.data as Record<string, unknown>
      : null;
    if (!data || !Array.isArray(data.steps)) return;

    const existing = await workflowService.getDefinition(db, input.workflowId);
    if (!existing || existing.companyId !== input.companyId) return;

    const name = typeof data.name === "string" && data.name.trim()
      ? data.name.trim()
      : existing.name;
    const executionMode = parseNativeWorkflowExecutionMode(data.executionMode);
    await workflowService.updateDefinition(db, input.workflowId, {
      name,
      steps: data.steps as never,
      ...(executionMode ? { executionMode } : {}),
    });
  }

  async function handleNativeWorkflowEngineAction(input: {
    key: string;
    pluginId: string;
    params: Record<string, unknown>;
    body: { companyId?: string } | undefined;
    req: Request;
    res: Response;
  }): Promise<boolean> {
    const { key, params, body, req, res } = input;
    if (!nativeWorkflowActionKeys.has(key)) return false;

    const companyId = requiredCompanyId(params, body);
    if (!companyId) {
      res.status(400).json({ error: "companyId is required" });
      return true;
    }
    assertCompanyAccess(req, companyId);

    if (key === "handle-tool-execution-result") {
      const stepRunId = typeof params.stepRunId === "string" ? params.stepRunId.trim() : "";
      if (!stepRunId) {
        res.status(400).json({ error: "stepRunId is required" });
        return true;
      }

      const run = await completeWorkflowToolStepFromResult(db, {
        companyId,
        stepRunId,
        success: params.success === true,
        requestId: typeof params.requestId === "string" ? params.requestId : undefined,
        workflowRunId: typeof params.workflowRunId === "string" ? params.workflowRunId : undefined,
        stepId: typeof params.stepId === "string" ? params.stepId : undefined,
        toolName: typeof params.toolName === "string" ? params.toolName : undefined,
        stdout: typeof params.stdout === "string" ? params.stdout : undefined,
        data: params.data,
        stderr: typeof params.stderr === "string" ? params.stderr : undefined,
        exitCode: typeof params.exitCode === "number" ? params.exitCode : null,
        error: typeof params.error === "string" ? params.error : undefined,
      });
      if (!run) return false;

      res.json({ data: { ok: true, run } });
      return true;
    }

    if (key === "start-workflow") {
      const workflowId = typeof params.workflowId === "string" ? params.workflowId.trim() : "";
      if (!workflowId) {
        res.status(400).json({ error: "workflowId is required" });
        return true;
      }

      const missionId = typeof params.missionId === "string" && params.missionId.trim()
        ? params.missionId.trim()
        : undefined;
      const triggeredBy = typeof params.triggerSource === "string" && params.triggerSource.trim()
        ? params.triggerSource.trim()
        : req.actor.type;
      await refreshNativeWorkflowDefinitionFromPluginEntity({
        companyId,
        pluginId: input.pluginId,
        workflowId,
      });
      const run = await workflowService.trigger(db, {
        companyId,
        workflowId,
        missionId,
        triggeredBy,
      });
      await updatePluginWorkflowDefinitionEntity({
        companyId,
        pluginId: input.pluginId,
        workflowId,
        patch: {
          lastScheduleError: undefined,
          lastScheduleErrorAt: undefined,
        },
      });
      res.json({ data: { run, ...run } });
      return true;
    }

    if (key === "resume-run") {
      const runId = typeof params.runId === "string" ? params.runId.trim() : "";
      if (!runId) {
        res.status(400).json({ error: "runId is required" });
        return true;
      }

      const existingRun = await workflowService.getRun(db, runId);
      if (!existingRun) {
        res.status(404).json({
          error: "Native workflow run not found",
          message: "Legacy plugin workflow-run execution is disabled; start a new server-native workflow run instead.",
        });
        return true;
      }
      if (existingRun.companyId !== companyId) {
        res.status(404).json({ error: "Workflow run not found" });
        return true;
      }

      const run = await workflowService.resumeRun(db, { companyId, runId });
      res.json({ data: { run, ...run } });
      return true;
    }

    if (key === "cancel-run" || key === "abort-run") {
      const runId = typeof params.runId === "string" ? params.runId.trim() : "";
      if (!runId) {
        res.status(400).json({ error: "runId is required" });
        return true;
      }

      const run = await workflowService.getRun(db, runId);
      if (!run || run.companyId !== companyId) {
        res.status(404).json({ error: "Workflow run not found" });
        return true;
      }

      const cancelled = await workflowService.cancelRun(db, { runId, companyId });
      res.json({ data: { id: runId, runId, status: cancelled ? "cancelled" : run.status, cancelled } });
      return true;
    }

    if (key === "manual-complete") {
      const issueId = typeof params.issueId === "string" ? params.issueId.trim() : "";
      if (!issueId) {
        res.status(400).json({ error: "issueId is required" });
        return true;
      }

      const svc = issueService(db);
      const existing = await svc.getById(issueId);
      if (!existing || existing.companyId !== companyId) {
        res.status(404).json({ error: "Issue not found" });
        return true;
      }

      const issue = await svc.update(issueId, { status: "done", workflowSyncSource: "plugins_route" });
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return true;
      }
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.updated",
        entityType: "issue",
        entityId: issue.id,
        details: {
          status: "done",
          identifier: issue.identifier,
          source: "workflow.manual-complete",
          _previous: { status: existing.status },
        },
      });
      const run = await workflowService.syncRunStatusForIssue(db, issue.id, "plugins_route");
      res.json({ data: { issue, run } });
      return true;
    }

    if (key === "delete-workflow") {
      const workflowId = typeof params.workflowId === "string" ? params.workflowId.trim()
        : typeof params.id === "string" ? params.id.trim() : "";
      if (!workflowId) {
        res.status(400).json({ error: "workflowId is required" });
        return true;
      }

      const workflow = await workflowService.getDefinition(db, workflowId);
      if (!workflow || workflow.companyId !== companyId) {
        res.status(404).json({ error: "Workflow definition not found" });
        return true;
      }

      const deleted = await workflowService.deleteDefinition(db, workflowId);
      res.json({ data: { id: workflowId, status: "archived", deleted } });
      return true;
    }

    if (key === "create-workflow") {
      const workflow = (params.workflow && typeof params.workflow === "object"
        ? params.workflow
        : params) as Record<string, unknown>;
      const name = typeof workflow.name === "string" ? workflow.name.trim() : "";
      if (!name) {
        res.status(400).json({ error: "workflow.name is required" });
        return true;
      }
      const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
      const executionMode = parseNativeWorkflowExecutionMode(workflow.executionMode);
      const definition = await workflowService.createDefinition(db, {
        companyId,
        name,
        steps: steps as never,
        ...(executionMode ? { executionMode } : {}),
      });
      res.json({ data: { workflow: definition, ...definition } });
      return true;
    }

    if (key === "update-workflow") {
      const workflowId = typeof params.workflowId === "string" ? params.workflowId.trim()
        : typeof params.id === "string" ? params.id.trim() : "";
      if (!workflowId) {
        res.status(400).json({ error: "workflowId is required" });
        return true;
      }

      const existing = await workflowService.getDefinition(db, workflowId);
      if (!existing || existing.companyId !== companyId) {
        res.status(404).json({ error: "Workflow definition not found" });
        return true;
      }

      const source = (params.patch && typeof params.patch === "object"
        ? params.patch
        : params.workflow && typeof params.workflow === "object"
          ? params.workflow
          : params) as Record<string, unknown>;
      const updates: Parameters<typeof workflowService.updateDefinition>[2] = {};
      if (typeof source.name === "string") updates.name = source.name.trim();
      if (Array.isArray(source.steps)) updates.steps = source.steps as never;
      const executionMode = parseNativeWorkflowExecutionMode(source.executionMode);
      if (executionMode) updates.executionMode = executionMode;

      const pluginPatch = pickPluginWorkflowPatch(source);
      const pluginData = Object.keys(pluginPatch).length > 0
        ? await updatePluginWorkflowDefinitionEntity({
          companyId,
          pluginId: input.pluginId,
          workflowId,
          patch: pluginPatch,
        })
        : null;

      const definition = Object.keys(updates).length > 0
        ? await workflowService.updateDefinition(db, workflowId, updates)
        : existing;
      if (!definition) {
        res.status(404).json({ error: "Workflow definition not found" });
        return true;
      }
      const responseDefinition = {
        ...definition,
        ...(pluginData ?? {}),
      };
      res.json({ data: { workflow: responseDefinition, ...responseDefinition } });
      return true;
    }

    return false;
  }

  async function resolvePluginAuditCompanyIds(req: Request): Promise<string[]> {
    if (typeof (db as { select?: unknown }).select === "function") {
      const rows = await db
        .select({ id: companies.id })
        .from(companies);
      return rows.map((row) => row.id);
    }

    if (req.actor.type === "agent" && req.actor.companyId) {
      return [req.actor.companyId];
    }

    if (req.actor.type === "board") {
      return req.actor.companyIds ?? [];
    }

    return [];
  }

  async function logPluginMutationActivity(
    req: Request,
    action: string,
    entityId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const companyIds = await resolvePluginAuditCompanyIds(req);
    if (companyIds.length === 0) return;

    const actor = getActorInfo(req);
    await Promise.all(companyIds.map((companyId) =>
      logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action,
        entityType: "plugin",
        entityId,
        details,
      })));
  }

  // Read-only plugin catalog routes (listing, examples, UI contributions).
  // Registered before any parameterized :pluginId route so Express does not
  // match "examples" or "ui-contributions" as a plugin id. See plugin-catalog.ts.
  registerPluginCatalogRoutes(router, registry);

  // ===========================================================================
  // Tool discovery and execution routes
  // ===========================================================================

  /**
   * GET /api/plugins/tools
   *
   * List all available plugin-contributed tools in an agent-friendly format.
   *
   * Query params:
   * - `pluginId` (optional): Filter to tools from a specific plugin
   *
   * Response: `AgentToolDescriptor[]`
   * Errors: 501 if tool dispatcher is not configured
   */
  router.get("/plugins/tools", async (req, res) => {
    assertBoard(req);

    if (!toolDeps) {
      res.status(501).json({ error: "Plugin tool dispatch is not enabled" });
      return;
    }

    const pluginId = req.query.pluginId as string | undefined;
    const filter = pluginId ? { pluginId } : undefined;
    const tools = toolDeps.toolDispatcher.listToolsForAgent(filter);
    res.json(tools);
  });

  /**
   * POST /api/plugins/tools/execute
   *
   * Execute a plugin-contributed tool by its namespaced name.
   *
   * This is the primary endpoint used by the agent service to invoke
   * plugin tools during an agent run.
   *
   * Request body:
   * - `tool`: Fully namespaced tool name (e.g., "acme.linear:search-issues")
   * - `parameters`: Parameters matching the tool's declared JSON Schema
   * - `runContext`: Agent run context with agentId, runId, companyId, and optional projectId
   *
   * Response: `ToolExecutionResult`
   * Errors:
   * - 400 if request validation fails
   * - 404 if tool is not found
   * - 501 if tool dispatcher is not configured
   * - 502 if the plugin worker is unavailable or the RPC call fails
   */
  router.post("/plugins/tools/execute", async (req, res) => {
    const body = (req.body as PluginToolExecuteRequest | undefined);
    if (!body) {
      res.status(400).json({ error: "Request body is required" });
      return;
    }

    const { tool, parameters, runContext } = body;

    // Validate required fields
    if (!tool || typeof tool !== "string") {
      res.status(400).json({ error: '"tool" is required and must be a string' });
      return;
    }

    if (!runContext || typeof runContext !== "object") {
      res.status(400).json({ error: '"runContext" is required and must be an object' });
      return;
    }

    if (!runContext.agentId || !runContext.runId || !runContext.companyId) {
      res.status(400).json({
        error: '"runContext" must include agentId, runId, and companyId',
      });
      return;
    }

    assertCompanyAccess(req, runContext.companyId);
    let workflowRunIssueId: string | null = null;
    const registeredTool = toolDeps?.toolDispatcher.getTool(tool) ?? null;
    if (req.actor.type === "agent") {
      const agentId = req.actor.agentId;
      const companyId = req.actor.companyId;
      if (!agentId || !companyId) {
        res.status(403).json({ error: "Agent run context is not valid for tool execution" });
        return;
      }
      const run = await db
        .select({
          id: heartbeatRuns.id,
          agentId: heartbeatRuns.agentId,
          companyId: heartbeatRuns.companyId,
          status: heartbeatRuns.status,
          issueId: heartbeatRuns.issueId,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runContext.runId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      const catalog = await listWorkflowToolCatalog(db, runContext.companyId);
      const catalogTool = catalog.tools.find((entry) => entry.name === tool);
      const authorization = authorizeRunToolExecution({
        actor: {
          type: "agent",
          agentId,
          companyId,
        },
        runContext,
        run,
        toolName: tool,
        currentEffectiveGrant: catalog.grants.some((grant) => grant.agentId === runContext.agentId && grant.toolName === tool),
        registeredEnabledTool: Boolean(
          catalogTool?.enabled
          && (catalogTool.source !== "plugin" || registeredTool !== null),
        ),
      });
      if (!authorization.allowed) {
        res.status(403).json({ error: authorization.reason });
        return;
      }
      workflowRunIssueId = run?.issueId ?? null;
    } else {
      assertBoard(req);
    }

    if (registeredTool) {
      try {
        const result = await toolDeps!.toolDispatcher.executeTool(
          tool,
          parameters ?? {},
          runContext,
        );
        res.json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        // Distinguish between "worker not running" (502) and other errors (500)
        if (message.includes("not running") || message.includes("worker")) {
          res.status(502).json({ error: message });
        } else {
          res.status(500).json({ error: message });
        }
      }
      return;
    }

    try {
      const stepEnv = await resolveRunStepEnv(db, String(runContext.runId));
      const coreResult = await executeCoreWorkflowTool({
        db,
        companyId: runContext.companyId,
        agentId: runContext.agentId,
        issueId: workflowRunIssueId,
        toolName: tool,
        parameters: parameters ?? {},
        requestId: randomUUID(),
        workflowRunId: stepEnv.PAPERCLIP_WORKFLOW_RUN_ID ?? null,
        stepId: stepEnv.PAPERCLIP_WORKFLOW_STEP_ID ?? null,
        stepEnv,
      });
      if (coreResult.status !== 404 || coreResult.body.source === "core") {
        res.status(coreResult.status).json(coreResult.body);
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
      return;
    }

    if (!toolDeps) {
      res.status(501).json({ error: "Plugin tool dispatch is not enabled and no core workflow tool matched" });
      return;
    }
    res.status(404).json({ error: `Tool "${tool}" not found` });
  });

  /**
   * POST /api/plugins/install
   *
   * Install a plugin from npm or a local filesystem path.
   *
   * Request body:
   * - packageName: npm package name or local path (required)
   * - version: Target version for npm packages (optional)
   * - isLocalPath: Set true if packageName is a local path
   *
   * The installer:
   * 1. Downloads from npm or loads from local path
   * 2. Validates the manifest (schema + capability consistency)
   * 3. Registers in the database
   * 4. Transitions to `ready` state if no new capability approval is needed
   *
   * Response: `PluginRecord`
   *
   * Errors:
   * - `400` — validation failure or install error (package not found, bad manifest, etc.)
   * - `500` — installation succeeded but manifest is missing (indicates a loader bug)
   */
  router.post("/plugins/install", async (req, res) => {
    assertBoard(req);
    const { packageName, version, isLocalPath } = req.body as PluginInstallRequest;

    // Input validation
    if (!packageName || typeof packageName !== "string") {
      res.status(400).json({ error: "packageName is required and must be a string" });
      return;
    }

    if (version !== undefined && typeof version !== "string") {
      res.status(400).json({ error: "version must be a string if provided" });
      return;
    }

    if (isLocalPath !== undefined && typeof isLocalPath !== "boolean") {
      res.status(400).json({ error: "isLocalPath must be a boolean if provided" });
      return;
    }

    // Validate package name format
    const trimmedPackage = packageName.trim();
    if (trimmedPackage.length === 0) {
      res.status(400).json({ error: "packageName cannot be empty" });
      return;
    }

    // Basic security check for package name (prevent injection)
    if (!isLocalPath && /[<>:"|?*]/.test(trimmedPackage)) {
      res.status(400).json({ error: "packageName contains invalid characters" });
      return;
    }

    try {
      const installOptions = isLocalPath
        ? { localPath: trimmedPackage }
        : { packageName: trimmedPackage, version: version?.trim() };

      const discovered = await loader.installPlugin(installOptions);

      if (!discovered.manifest) {
        res.status(500).json({ error: "Plugin installed but manifest is missing" });
        return;
      }

      // Transition to ready state
      const existingPlugin = await registry.getByKey(discovered.manifest.id);
      if (existingPlugin) {
        await lifecycle.load(existingPlugin.id);
        const updated = await registry.getById(existingPlugin.id);
        await logPluginMutationActivity(req, "plugin.installed", existingPlugin.id, {
          pluginId: existingPlugin.id,
          pluginKey: existingPlugin.pluginKey,
          packageName: updated?.packageName ?? existingPlugin.packageName,
          version: updated?.version ?? existingPlugin.version,
          source: isLocalPath ? "local_path" : "npm",
        });
        publishGlobalLiveEvent({ type: "plugin.ui.updated", payload: { pluginId: existingPlugin.id, action: "installed" } });
        res.json(updated);
      } else {
        // This shouldn't happen since installPlugin already registers in the DB
        res.status(500).json({ error: "Plugin installed but not found in registry" });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // ===========================================================================
  // UI Bridge proxy routes (getData / performAction)
  // ===========================================================================

  /** Request body for POST /api/plugins/:pluginId/bridge/data */
  interface PluginBridgeDataRequest {
    /** Plugin-defined data key (e.g. `"sync-health"`). */
    key: string;
    /** Optional company scope for authorizing company-context bridge calls. */
    companyId?: string;
    /** Optional context and query parameters from the UI. */
    params?: Record<string, unknown>;
    /** Optional host launcher/render metadata for the worker bridge call. */
    renderEnvironment?: PluginLauncherRenderContextSnapshot | null;
  }

  /** Request body for POST /api/plugins/:pluginId/bridge/action */
  interface PluginBridgeActionRequest {
    /** Plugin-defined action key (e.g. `"resync"`). */
    key: string;
    /** Optional company scope for authorizing company-context bridge calls. */
    companyId?: string;
    /** Optional parameters from the UI. */
    params?: Record<string, unknown>;
    /** Optional host launcher/render metadata for the worker bridge call. */
    renderEnvironment?: PluginLauncherRenderContextSnapshot | null;
  }

  /** Response envelope for bridge errors. */
  interface PluginBridgeErrorResponse {
    code: PluginBridgeErrorCode;
    message: string;
    details?: unknown;
  }

  /**
   * Map a worker RPC error to a bridge-level error code.
   *
   * JsonRpcCallError carries numeric codes from the plugin RPC error code space.
   * This helper maps them to the string error codes defined in PluginBridgeErrorCode.
   *
   * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
   */
  function mapRpcErrorToBridgeError(err: unknown): PluginBridgeErrorResponse {
    if (err instanceof JsonRpcCallError) {
      switch (err.code) {
        case PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE:
          return {
            code: "WORKER_UNAVAILABLE",
            message: err.message,
            details: err.data,
          };
        case PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED:
          return {
            code: "CAPABILITY_DENIED",
            message: err.message,
            details: err.data,
          };
        case PLUGIN_RPC_ERROR_CODES.TIMEOUT:
          return {
            code: "TIMEOUT",
            message: err.message,
            details: err.data,
          };
        case PLUGIN_RPC_ERROR_CODES.WORKER_ERROR:
          return {
            code: "WORKER_ERROR",
            message: err.message,
            details: err.data,
          };
        default:
          return {
            code: "UNKNOWN",
            message: err.message,
            details: err.data,
          };
      }
    }

    const message = err instanceof Error ? err.message : String(err);

    // Worker not running — surface as WORKER_UNAVAILABLE
    if (message.includes("not running") || message.includes("not registered")) {
      return {
        code: "WORKER_UNAVAILABLE",
        message,
      };
    }

    return {
      code: "UNKNOWN",
      message,
    };
  }

  /**
   * POST /api/plugins/:pluginId/bridge/data
   *
   * Proxy a `getData` call from the plugin UI to the plugin worker.
   *
   * This is the server-side half of the `usePluginData(key, params)` bridge hook.
   * The frontend sends a POST with the data key and optional params; the host
   * forwards the call to the worker via the `getData` RPC method and returns
   * the result.
   *
   * Request body:
   * - `key`: Plugin-defined data key (e.g. `"sync-health"`)
   * - `params`: Optional query parameters forwarded to the worker handler
   *
   * Response: The raw result from the worker's `getData` handler
   *
   * Error response body follows the `PluginBridgeError` shape:
   * `{ code: PluginBridgeErrorCode, message: string, details?: unknown }`
   *
   * Errors:
   * - 400 if request validation fails
   * - 404 if plugin not found
   * - 501 if bridge deps are not configured
   * - 502 if the worker is unavailable or returns an error
   *
   * @see PLUGIN_SPEC.md §13.8 — `getData`
   * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
   */
  router.post("/plugins/:pluginId/bridge/data", async (req, res) => {
    assertBoard(req);

    if (!bridgeDeps) {
      res.status(501).json({ error: "Plugin bridge is not enabled" });
      return;
    }

    const { pluginId } = req.params;

    // Resolve plugin
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    // Validate plugin is in ready state
    if (plugin.status !== "ready") {
      const bridgeError: PluginBridgeErrorResponse = {
        code: "WORKER_UNAVAILABLE",
        message: `Plugin is not ready (current status: ${plugin.status})`,
      };
      res.status(502).json(bridgeError);
      return;
    }

    // Validate request body
    const body = req.body as PluginBridgeDataRequest | undefined;
    if (!body || !body.key || typeof body.key !== "string") {
      res.status(400).json({ error: '"key" is required and must be a string' });
      return;
    }

    if (body.companyId) {
      assertCompanyAccess(req, body.companyId);
    }

    try {
      const result = await bridgeDeps.workerManager.call(
        plugin.id,
        "getData",
        {
          key: body.key,
          params: body.params ?? {},
          renderEnvironment: body.renderEnvironment ?? null,
        },
      );
      res.json({ data: result });
    } catch (err) {
      const bridgeError = mapRpcErrorToBridgeError(err);
      res.status(502).json(bridgeError);
    }
  });

  /**
   * POST /api/plugins/:pluginId/bridge/action
   *
   * Proxy a `performAction` call from the plugin UI to the plugin worker.
   *
   * This is the server-side half of the `usePluginAction(key)` bridge hook.
   * The frontend sends a POST with the action key and optional params; the host
   * forwards the call to the worker via the `performAction` RPC method and
   * returns the result.
   *
   * Request body:
   * - `key`: Plugin-defined action key (e.g. `"resync"`)
   * - `params`: Optional parameters forwarded to the worker handler
   *
   * Response: The raw result from the worker's `performAction` handler
   *
   * Error response body follows the `PluginBridgeError` shape:
   * `{ code: PluginBridgeErrorCode, message: string, details?: unknown }`
   *
   * Errors:
   * - 400 if request validation fails
   * - 404 if plugin not found
   * - 501 if bridge deps are not configured
   * - 502 if the worker is unavailable or returns an error
   *
   * @see PLUGIN_SPEC.md §13.9 — `performAction`
   * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
   */
  router.post("/plugins/:pluginId/bridge/action", async (req, res) => {
    assertBoard(req);

    if (!bridgeDeps) {
      res.status(501).json({ error: "Plugin bridge is not enabled" });
      return;
    }

    const { pluginId } = req.params;

    // Resolve plugin
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    // Validate plugin is in ready state
    if (plugin.status !== "ready") {
      const bridgeError: PluginBridgeErrorResponse = {
        code: "WORKER_UNAVAILABLE",
        message: `Plugin is not ready (current status: ${plugin.status})`,
      };
      res.status(502).json(bridgeError);
      return;
    }

    // Validate request body
    const body = req.body as PluginBridgeActionRequest | undefined;
    if (!body || !body.key || typeof body.key !== "string") {
      res.status(400).json({ error: '"key" is required and must be a string' });
      return;
    }

    if (body.companyId) {
      assertCompanyAccess(req, body.companyId);
    }

    const actionParams = normalizedWorkflowActionParams(body.key, body);
    if (plugin.pluginKey === "insightflo.workflow-engine") {
      const handledNativeAction = await handleNativeWorkflowEngineAction({
        key: body.key,
        pluginId: plugin.id,
        params: actionParams,
        body,
        req,
        res,
      });
      if (handledNativeAction) return;
    }

    try {
      const result = await bridgeDeps.workerManager.call(
        plugin.id,
        "performAction",
        {
          key: body.key,
          params: body.params ?? {},
          renderEnvironment: body.renderEnvironment ?? null,
        },
      );
      res.json({ data: result });
    } catch (err) {
      const bridgeError = mapRpcErrorToBridgeError(err);
      res.status(502).json(bridgeError);
    }
  });

  // ===========================================================================
  // URL-keyed bridge routes (key as path parameter)
  // ===========================================================================

  /**
   * POST /api/plugins/:pluginId/data/:key
   *
   * Proxy a `getData` call from the plugin UI to the plugin worker, with the
   * data key specified as a URL path parameter instead of in the request body.
   *
   * This is a REST-friendly alternative to `POST /plugins/:pluginId/bridge/data`.
   * The frontend bridge hooks use this endpoint for cleaner URLs.
   *
   * Request body (optional):
   * - `params`: Optional query parameters forwarded to the worker handler
   *
   * Response: The raw result from the worker's `getData` handler wrapped as `{ data: T }`
   *
   * Error response body follows the `PluginBridgeError` shape:
   * `{ code: PluginBridgeErrorCode, message: string, details?: unknown }`
   *
   * Errors:
   * - 404 if plugin not found
   * - 501 if bridge deps are not configured
   * - 502 if the worker is unavailable or returns an error
   *
   * @see PLUGIN_SPEC.md §13.8 — `getData`
   * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
   */
  router.post("/plugins/:pluginId/data/:key", async (req, res) => {
    assertBoard(req);

    if (!bridgeDeps) {
      res.status(501).json({ error: "Plugin bridge is not enabled" });
      return;
    }

    const { pluginId, key } = req.params;

    // Resolve plugin
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    // Validate plugin is in ready state
    if (plugin.status !== "ready") {
      const bridgeError: PluginBridgeErrorResponse = {
        code: "WORKER_UNAVAILABLE",
        message: `Plugin is not ready (current status: ${plugin.status})`,
      };
      res.status(502).json(bridgeError);
      return;
    }

    const body = req.body as {
      companyId?: string;
      params?: Record<string, unknown>;
      renderEnvironment?: PluginLauncherRenderContextSnapshot | null;
    } | undefined;

    if (body?.companyId) {
      assertCompanyAccess(req, body.companyId);
    }

    try {
      const result = await bridgeDeps.workerManager.call(
        plugin.id,
        "getData",
        {
          key,
          params: body?.params ?? {},
          renderEnvironment: body?.renderEnvironment ?? null,
        },
      );
      if (plugin.pluginKey === "insightflo.workflow-engine" && key === "workflow-overview") {
        const params = body?.params ?? {};
        const companyId = typeof params.companyId === "string"
          ? params.companyId
          : typeof body?.companyId === "string"
            ? body.companyId
            : undefined;
        if (companyId) {
          assertCompanyAccess(req, companyId);
          const [nativeDefinitions, nativeRuns, agentNameById] = await Promise.all([
            workflowService.listDefinitions(db, companyId),
            workflowService.listRuns(db, { companyId }),
            safeListWorkflowAgentNameById(db, companyId),
          ]);
          const definitionNameById = new Map(nativeDefinitions.map((definition) => [definition.id, definition.name]));
          const nativeRunSummaries = nativeRuns.map((run) => ({
            id: run.id,
            workflowName: definitionNameById.get(run.workflowId) ?? run.workflowId,
            status: run.status,
            startedAt: (run.startedAt ?? run.createdAt).toISOString(),
            completedAt: run.completedAt?.toISOString(),
            triggerSource: run.triggeredBy,
          }));
          const resultRecord = result && typeof result === "object" ? result as Record<string, unknown> : {};
          const pluginWorkflows = Array.isArray(resultRecord.workflows) ? resultRecord.workflows : [];
          const pluginWorkflowIds = new Set(pluginWorkflows
            .map((workflow) => workflow && typeof workflow === "object" && "id" in workflow
              ? (workflow as { id?: unknown }).id
              : undefined)
            .filter((id): id is string => typeof id === "string" && id.length > 0));
          const nativeWorkflowSummaries = nativeDefinitions
            .filter((definition) => !pluginWorkflowIds.has(definition.id))
            .map((definition) => nativeWorkflowDefinitionForPlugin(definition, agentNameById));
          res.json({
            data: {
              ...resultRecord,
              workflows: [
                ...pluginWorkflows,
                ...nativeWorkflowSummaries,
              ],
              activeRuns: nativeRunSummaries.filter((run) => run.status === "running"),
              recentRuns: nativeRunSummaries.filter((run) => run.status !== "running").slice(0, 10),
            },
          });
          return;
        }
      }
      if (plugin.pluginKey === "insightflo.workflow-engine" && key === "workflow-run-detail" && result == null) {
        const params = body?.params ?? {};
        const runId = typeof params.runId === "string"
          ? params.runId.trim()
          : typeof (body as Record<string, unknown> | undefined)?.runId === "string"
            ? String((body as Record<string, unknown>).runId).trim()
            : "";
        if (runId) {
          const nativeRun = await workflowService.getRun(db, runId);
          if (nativeRun) {
            assertCompanyAccess(req, nativeRun.companyId);
            const [nativeDefinition, nativeStepRuns] = await Promise.all([
              workflowService.getDefinition(db, nativeRun.workflowId),
              workflowService.listStepRuns(db, nativeRun.id),
            ]);
            res.json({
              data: await nativeWorkflowRunDetailForPlugin(db, nativeRun, nativeDefinition, nativeStepRuns),
            });
            return;
          }
        }
      }
      res.json({ data: result });
    } catch (err) {
      const bridgeError = mapRpcErrorToBridgeError(err);
      res.status(502).json(bridgeError);
    }
  });

  /**
   * POST /api/plugins/:pluginId/actions/:key
   *
   * Proxy a `performAction` call from the plugin UI to the plugin worker, with
   * the action key specified as a URL path parameter instead of in the request body.
   *
   * This is a REST-friendly alternative to `POST /plugins/:pluginId/bridge/action`.
   * The frontend bridge hooks use this endpoint for cleaner URLs.
   *
   * Request body (optional):
   * - `params`: Optional parameters forwarded to the worker handler
   *
   * Response: The raw result from the worker's `performAction` handler wrapped as `{ data: T }`
   *
   * Error response body follows the `PluginBridgeError` shape:
   * `{ code: PluginBridgeErrorCode, message: string, details?: unknown }`
   *
   * Errors:
   * - 404 if plugin not found
   * - 501 if bridge deps are not configured
   * - 502 if the worker is unavailable or returns an error
   *
   * @see PLUGIN_SPEC.md §13.9 — `performAction`
   * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
   */
  router.post("/plugins/:pluginId/actions/:key", async (req, res) => {
    assertBoard(req);

    if (!bridgeDeps) {
      res.status(501).json({ error: "Plugin bridge is not enabled" });
      return;
    }

    const { pluginId, key } = req.params;

    // Resolve plugin
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    // Validate plugin is in ready state
    if (plugin.status !== "ready") {
      const bridgeError: PluginBridgeErrorResponse = {
        code: "WORKER_UNAVAILABLE",
        message: `Plugin is not ready (current status: ${plugin.status})`,
      };
      res.status(502).json(bridgeError);
      return;
    }

    const body = req.body as ({
      companyId?: string;
      params?: Record<string, unknown>;
      renderEnvironment?: PluginLauncherRenderContextSnapshot | null;
    } & Record<string, unknown>) | undefined;

    if (body?.companyId) {
      assertCompanyAccess(req, body.companyId);
    }

    const actionParams = normalizedWorkflowActionParams(key, body);

    if (plugin.pluginKey === "insightflo.workflow-engine") {
      const handledNativeAction = await handleNativeWorkflowEngineAction({
        key,
        pluginId: plugin.id,
        params: actionParams,
        body,
        req,
        res,
      });
      if (handledNativeAction) return;
    }

    try {
      const result = await bridgeDeps.workerManager.call(
        plugin.id,
        "performAction",
        {
          key,
          params: actionParams,
          renderEnvironment: body?.renderEnvironment ?? null,
        },
      );
      res.json({ data: result });
    } catch (err) {
      const bridgeError = mapRpcErrorToBridgeError(err);
      res.status(502).json(bridgeError);
    }
  });

  // ===========================================================================
  // SSE stream bridge route
  // ===========================================================================

  /**
   * GET /api/plugins/:pluginId/bridge/stream/:channel
   *
   * Server-Sent Events endpoint for real-time streaming from plugin worker to UI.
   *
   * The worker pushes events via `ctx.streams.emit(channel, event)` which arrive
   * as JSON-RPC notifications to the host, get published on the PluginStreamBus,
   * and are fanned out to all connected SSE clients matching (pluginId, channel,
   * companyId).
   *
   * Query parameters:
   * - `companyId` (required): Scope events to a specific company
   *
   * SSE event types:
   * - `message`: A data event from the worker (default)
   * - `open`: The worker opened the stream channel
   * - `close`: The worker closed the stream channel — client should disconnect
   *
   * Errors:
   * - 400 if companyId is missing
   * - 404 if plugin not found
   * - 501 if bridge deps or stream bus are not configured
   */
  router.get("/plugins/:pluginId/bridge/stream/:channel", async (req, res) => {
    assertBoard(req);

    if (!bridgeDeps?.streamBus) {
      res.status(501).json({ error: "Plugin stream bridge is not enabled" });
      return;
    }

    const { pluginId, channel } = req.params;
    const companyId = req.query.companyId as string | undefined;

    if (!companyId) {
      res.status(400).json({ error: '"companyId" query parameter is required' });
      return;
    }

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    assertCompanyAccess(req, companyId);

    // Set SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    // Send initial comment to establish the connection
    res.write(":ok\n\n");

    let unsubscribed = false;
    const safeUnsubscribe = () => {
      if (!unsubscribed) {
        unsubscribed = true;
        unsubscribe();
      }
    };

    const unsubscribe = bridgeDeps.streamBus.subscribe(
      plugin.id,
      channel,
      companyId,
      (event, eventType) => {
        if (unsubscribed || !res.writable) return;
        try {
          if (eventType !== "message") {
            res.write(`event: ${eventType}\n`);
          }
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          // Connection closed or write error — stop delivering
          safeUnsubscribe();
        }
      },
    );

    req.on("close", safeUnsubscribe);
    res.on("error", safeUnsubscribe);
  });

  // Lifecycle, diagnostics, and config routes for /plugins/:pluginId.
  // Registered after static/bridge/stream routes and before jobs, in the same
  // position these handlers occupied before extraction. See plugin-lifecycle-routes.ts,
  // plugin-diagnostics-routes.ts, plugin-config-routes.ts.
  registerPluginLifecycleRoutes(router, {
    registry,
    lifecycle,
    workerManager: bridgeDeps?.workerManager,
    resolvePlugin,
    logPluginMutationActivity,
  });
  registerPluginDiagnosticsRoutes(router, {
    registry,
    db,
    resolvePlugin,
    computePluginHealth,
  });
  registerPluginConfigRoutes(router, {
    registry,
    lifecycle,
    workerManager: bridgeDeps?.workerManager,
    resolvePlugin,
    logPluginMutationActivity,
    mapRpcErrorToBridgeError,
  });

  // ===========================================================================
  // Job scheduling routes
  // ===========================================================================

  /**
   * GET /api/plugins/:pluginId/jobs
   *
   * List all scheduled jobs for a plugin.
   *
   * Query params:
   * - `status` (optional): Filter by job status (`active`, `paused`, `failed`)
   *
   * Response: PluginJobRecord[]
   * Errors: 404 if plugin not found
   */
  router.get("/plugins/:pluginId/jobs", async (req, res) => {
    assertBoard(req);
    if (!jobDeps) {
      res.status(501).json({ error: "Job scheduling is not enabled" });
      return;
    }

    const { pluginId } = req.params;
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const rawStatus = req.query.status as string | undefined;
    const validStatuses = ["active", "paused", "failed"];
    if (rawStatus !== undefined && !validStatuses.includes(rawStatus)) {
      res.status(400).json({
        error: `Invalid status '${rawStatus}'. Must be one of: ${validStatuses.join(", ")}`,
      });
      return;
    }

    try {
      const jobs = await jobDeps.jobStore.listJobs(
        plugin.id,
        rawStatus as "active" | "paused" | "failed" | undefined,
      );
      res.json(jobs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /**
   * GET /api/plugins/:pluginId/jobs/:jobId/runs
   *
   * List execution history for a specific job.
   *
   * Query params:
   * - `limit` (optional): Maximum number of runs to return (default: 50)
   *
   * Response: PluginJobRunRecord[]
   * Errors: 404 if plugin not found
   */
  router.get("/plugins/:pluginId/jobs/:jobId/runs", async (req, res) => {
    assertBoard(req);
    if (!jobDeps) {
      res.status(501).json({ error: "Job scheduling is not enabled" });
      return;
    }

    const { pluginId, jobId } = req.params;
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const job = await jobDeps.jobStore.getJobByIdForPlugin(plugin.id, jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 25;
    if (isNaN(limit) || limit < 1 || limit > 500) {
      res.status(400).json({ error: "limit must be a number between 1 and 500" });
      return;
    }

    try {
      const runs = await jobDeps.jobStore.listRunsByJob(jobId, limit);
      res.json(runs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/plugins/:pluginId/jobs/:jobId/trigger
   *
   * Manually trigger a job execution outside its cron schedule.
   *
   * Creates a run with `trigger: "manual"` and dispatches immediately.
   * The response returns before the job completes (non-blocking).
   *
   * Response: `{ runId: string, jobId: string }`
   * Errors:
   * - 404 if plugin not found
   * - 400 if job not found, not active, already running, or worker unavailable
   */
  router.post("/plugins/:pluginId/jobs/:jobId/trigger", async (req, res) => {
    assertBoard(req);
    if (!jobDeps) {
      res.status(501).json({ error: "Job scheduling is not enabled" });
      return;
    }

    const { pluginId, jobId } = req.params;
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const job = await jobDeps.jobStore.getJobByIdForPlugin(plugin.id, jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    try {
      const result = await jobDeps.scheduler.triggerJob(jobId, "manual");
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // ===========================================================================
  // Webhook ingestion route
  // ===========================================================================

  /**
   * POST /api/plugins/:pluginId/webhooks/:endpointKey
   *
   * Receive an inbound webhook delivery for a plugin.
   *
   * This route is called by external systems (e.g. GitHub, Linear, Stripe) to
   * deliver webhook payloads to a plugin. The host validates that:
   * 1. The plugin exists and is in 'ready' state
   * 2. The plugin declares the `webhooks.receive` capability
   * 3. The `endpointKey` matches a declared webhook in the manifest
   *
   * The delivery is recorded in the `plugin_webhook_deliveries` table and
   * dispatched to the worker via the `handleWebhook` RPC method.
   *
   * **Note:** This route does NOT require board authentication — webhook
   * endpoints must be publicly accessible for external callers. Signature
   * verification is the plugin's responsibility.
   *
   * Response: `{ deliveryId: string, status: string }`
   * Errors:
   * - 404 if plugin not found or endpointKey not declared
   * - 400 if plugin is not in ready state or lacks webhooks.receive capability
   * - 502 if the worker is unavailable or the RPC call fails
   */
  router.post("/plugins/:pluginId/webhooks/:endpointKey", async (req, res) => {
    if (!webhookDeps) {
      res.status(501).json({ error: "Webhook ingestion is not enabled" });
      return;
    }

    const { pluginId, endpointKey } = req.params;

    // Step 1: Resolve the plugin
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    // Step 2: Validate the plugin is in 'ready' state
    if (plugin.status !== "ready") {
      res.status(400).json({
        error: `Plugin is not ready (current status: ${plugin.status})`,
      });
      return;
    }

    // Step 3: Validate the plugin has webhooks.receive capability
    const manifest = plugin.manifestJson;
    if (!manifest) {
      res.status(400).json({ error: "Plugin manifest is missing" });
      return;
    }

    const capabilities = manifest.capabilities ?? [];
    if (!capabilities.includes("webhooks.receive")) {
      res.status(400).json({
        error: "Plugin does not have the webhooks.receive capability",
      });
      return;
    }

    // Step 4: Validate the endpointKey exists in the manifest's webhook declarations
    const declaredWebhooks = manifest.webhooks ?? [];
    const webhookDecl = declaredWebhooks.find(
      (w) => w.endpointKey === endpointKey,
    );
    if (!webhookDecl) {
      res.status(404).json({
        error: `Webhook endpoint '${endpointKey}' is not declared by this plugin`,
      });
      return;
    }

    // Step 5: Extract request data
    const requestId = randomUUID();
    const rawHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") {
        rawHeaders[key] = value;
      } else if (Array.isArray(value)) {
        rawHeaders[key] = value.join(", ");
      }
    }

    // Use the raw buffer stashed by the express.json() `verify` callback.
    // This preserves the exact bytes the provider signed, whereas
    // JSON.stringify(req.body) would re-serialize and break HMAC verification.
    const stashedRaw = (req as unknown as { rawBody?: Buffer }).rawBody;
    const rawBody = stashedRaw ? stashedRaw.toString("utf-8") : "";
    const parsedBody = req.body as unknown;
    const payload = (req.body as Record<string, unknown> | undefined) ?? {};

    // Step 6: Record the delivery in the database
    const startedAt = new Date();
    const [delivery] = await db
      .insert(pluginWebhookDeliveries)
      .values({
        pluginId: plugin.id,
        webhookKey: endpointKey,
        status: "pending",
        payload,
        headers: rawHeaders,
        startedAt,
      })
      .returning({ id: pluginWebhookDeliveries.id });

    // Step 7: Dispatch to the worker via handleWebhook RPC
    try {
      await webhookDeps.workerManager.call(plugin.id, "handleWebhook", {
        endpointKey,
        headers: req.headers as Record<string, string | string[]>,
        rawBody,
        parsedBody,
        requestId,
      });

      // Step 8: Update delivery record to success
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      await db
        .update(pluginWebhookDeliveries)
        .set({
          status: "success",
          durationMs,
          finishedAt,
        })
        .where(eq(pluginWebhookDeliveries.id, delivery.id));

      res.status(200).json({
        deliveryId: delivery.id,
        status: "success",
      });
    } catch (err) {
      // Step 8 (error): Update delivery record to failed
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      const errorMessage = err instanceof Error ? err.message : String(err);

      await db
        .update(pluginWebhookDeliveries)
        .set({
          status: "failed",
          durationMs,
          error: errorMessage,
          finishedAt,
        })
        .where(eq(pluginWebhookDeliveries.id, delivery.id));

      res.status(502).json({
        deliveryId: delivery.id,
        status: "failed",
        error: errorMessage,
      });
    }
  });

  // ===========================================================================
  // Plugin health dashboard — aggregated diagnostics for the settings page
  // ===========================================================================

  /**
   * GET /api/plugins/:pluginId/dashboard
   *
   * Aggregated health dashboard data for a plugin's settings page.
   *
   * Returns worker diagnostics (status, uptime, crash history), recent job
   * runs, recent webhook deliveries, and the current health check result —
   * all in a single response to avoid multiple round-trips.
   *
   * Response: PluginDashboardData
   * Errors: 404 if plugin not found
   */
  router.get("/plugins/:pluginId/dashboard", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    // --- Worker diagnostics ---
    let worker: {
      status: string;
      pid: number | null;
      uptime: number | null;
      consecutiveCrashes: number;
      totalCrashes: number;
      pendingRequests: number;
      lastCrashAt: number | null;
      nextRestartAt: number | null;
    } | null = null;

    // Try bridgeDeps first (primary source for worker manager), fallback to webhookDeps
    const wm = bridgeDeps?.workerManager ?? webhookDeps?.workerManager ?? null;
    if (wm) {
      const handle = wm.getWorker(plugin.id);
      if (handle) {
        const diag = handle.diagnostics();
        worker = {
          status: diag.status,
          pid: diag.pid,
          uptime: diag.uptime,
          consecutiveCrashes: diag.consecutiveCrashes,
          totalCrashes: diag.totalCrashes,
          pendingRequests: diag.pendingRequests,
          lastCrashAt: diag.lastCrashAt,
          nextRestartAt: diag.nextRestartAt,
        };
      }
    }

    // --- Recent job runs (last 10, newest first) ---
    let recentJobRuns: Array<{
      id: string;
      jobId: string;
      jobKey?: string;
      trigger: string;
      status: string;
      durationMs: number | null;
      error: string | null;
      startedAt: string | null;
      finishedAt: string | null;
      createdAt: string;
    }> = [];

    if (jobDeps) {
      try {
        const runs = await jobDeps.jobStore.listRunsByPlugin(plugin.id, undefined, 10);
        // Also fetch job definitions so we can include jobKey
        const jobs = await jobDeps.jobStore.listJobs(plugin.id);
        const jobKeyMap = new Map(jobs.map((j) => [j.id, j.jobKey]));

        recentJobRuns = runs
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .map((r) => ({
            id: r.id,
            jobId: r.jobId,
            jobKey: jobKeyMap.get(r.jobId) ?? undefined,
            trigger: r.trigger,
            status: r.status,
            durationMs: r.durationMs,
            error: r.error,
            startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : null,
            finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
            createdAt: new Date(r.createdAt).toISOString(),
          }));
      } catch {
        // Job data unavailable — leave empty
      }
    }

    // --- Recent webhook deliveries (last 10, newest first) ---
    let recentWebhookDeliveries: Array<{
      id: string;
      webhookKey: string;
      status: string;
      durationMs: number | null;
      error: string | null;
      startedAt: string | null;
      finishedAt: string | null;
      createdAt: string;
    }> = [];

    try {
      const deliveries = await db
        .select({
          id: pluginWebhookDeliveries.id,
          webhookKey: pluginWebhookDeliveries.webhookKey,
          status: pluginWebhookDeliveries.status,
          durationMs: pluginWebhookDeliveries.durationMs,
          error: pluginWebhookDeliveries.error,
          startedAt: pluginWebhookDeliveries.startedAt,
          finishedAt: pluginWebhookDeliveries.finishedAt,
          createdAt: pluginWebhookDeliveries.createdAt,
        })
        .from(pluginWebhookDeliveries)
        .where(eq(pluginWebhookDeliveries.pluginId, plugin.id))
        .orderBy(desc(pluginWebhookDeliveries.createdAt))
        .limit(10);

      recentWebhookDeliveries = deliveries.map((d) => ({
        id: d.id,
        webhookKey: d.webhookKey,
        status: d.status,
        durationMs: d.durationMs,
        error: d.error,
        startedAt: d.startedAt ? d.startedAt.toISOString() : null,
        finishedAt: d.finishedAt ? d.finishedAt.toISOString() : null,
        createdAt: d.createdAt.toISOString(),
      }));
    } catch {
      // Webhook data unavailable — leave empty
    }

    // --- Health check (shared with GET /health, includes worker health RPC) ---
    const health = await computePluginHealth(plugin);

    res.json({
      pluginId: plugin.id,
      worker,
      recentJobRuns,
      recentWebhookDeliveries,
      health,
      checkedAt: new Date().toISOString(),
    });
  });

  return router;
}

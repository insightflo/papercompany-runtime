import express, { Router, type Request as ExpressRequest } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import type { StorageService } from "./storage/types.js";
import { httpLogger, errorHandler } from "./middleware/index.js";
import { actorMiddleware } from "./middleware/auth.js";
import { boardMutationGuard } from "./middleware/board-mutation-guard.js";
import { privateHostnameGuard, resolvePrivateHostnameAllowSet } from "./middleware/private-hostname-guard.js";
import { healthRoutes } from "./routes/health.js";
import { metricsRoutes } from "./routes/metrics.js";
import { companyRoutes } from "./routes/companies.js";
import { companySkillRoutes } from "./routes/company-skills.js";
import { companyInstructionRoutes } from "./routes/company-instructions.js";
import { agentRoutes } from "./routes/agents.js";
import { projectRoutes } from "./routes/projects.js";
import { issueRoutes } from "./routes/issues.js";
import { routineRoutes } from "./routes/routines.js";
import { schedulerRoutes } from "./routes/scheduler.js";
import { worktreeRoutes } from "./routes/worktree.js";
import { missionRoutes } from "./routes/missions.js";
import { workflowRoutes } from "./routes/workflows.js";
import { srbWebhookRoutes } from "./routes/srb-webhook.js";
import { requireMaintenanceCompany } from "./middleware/company-kind-gate.js";
import { executionWorkspaceRoutes } from "./routes/execution-workspaces.js";
import { goalRoutes } from "./routes/goals.js";
import { approvalRoutes } from "./routes/approvals.js";
import { secretRoutes } from "./routes/secrets.js";
import { costRoutes } from "./routes/costs.js";
import { channelConfigRoutes } from "./routes/channel-config.js";
import { hermesChatRoutes } from "./routes/hermes-chat.js";
import { activityRoutes } from "./routes/activity.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { sidebarBadgeRoutes } from "./routes/sidebar-badges.js";
import { instanceSettingsRoutes } from "./routes/instance-settings.js";
import { llmRoutes } from "./routes/llms.js";
import { assetRoutes } from "./routes/assets.js";
import { accessRoutes } from "./routes/access.js";
import { assertCompanyAccess } from "./routes/authz.js";
import { pluginRoutes } from "./routes/plugins.js";
import { pluginUiStaticRoutes } from "./routes/plugin-ui-static.js";
import { applyUiBranding } from "./ui-branding.js";
import { logger } from "./middleware/logger.js";
import { DEFAULT_LOCAL_PLUGIN_DIR, pluginLoader } from "./services/plugin-loader.js";
import { executionWorkspaceService, issueService } from "./services/index.js";
import { createPluginWorkerManager } from "./services/plugin-worker-manager.js";
import { createPluginJobScheduler } from "./services/plugin-job-scheduler.js";
import { pluginJobStore } from "./services/plugin-job-store.js";
import { createPluginToolDispatcher } from "./services/plugin-tool-dispatcher.js";
import { pluginLifecycleManager } from "./services/plugin-lifecycle.js";
import { createPluginJobCoordinator } from "./services/plugin-job-coordinator.js";
import { buildHostServices, flushPluginLogBuffer } from "./services/plugin-host-services.js";
import { createPluginEventBus } from "./services/plugin-event-bus.js";
import { setPluginEventBus } from "./services/activity-log.js";
import { createPluginDevWatcher } from "./services/plugin-dev-watcher.js";
import { createPluginHostServiceCleanup } from "./services/plugin-host-service-cleanup.js";
import { pluginRegistryService } from "./services/plugin-registry.js";
import { createHostClientHandlers } from "@paperclipai/plugin-sdk";
import { heartbeatService } from "./services/heartbeat.js";
import { createScheduler } from "./services/scheduler/index.js";
import { createDeliveryRetryWorker } from "./services/srb/delivery-retry-worker.js";
import { createNonceCleanupJob } from "./services/srb/nonce-cleanup.js";
import { createAuditLogCleanupJob } from "./services/audit-log-cleanup.js";
import { createMissionOwnerSupervisionMonitor } from "./services/mission-owner-supervision-monitor.js";
import { createAlertRules, setAlertRules } from "./services/alert-rules.js";
import { createChannelRegistry } from "./channel/index.js";
import { registerTelegramCommands } from "./channel/telegram/commands.js";
import { getChatId } from "./channel/telegram/outbound.js";
import { startAlertMonitor } from "./channel/telegram/alerts.js";
import { setWorkflowToolStepExecutor } from "./services/workflow/dag-engine.js";
import { registerNativeWorkflowToolResultEventHandlers } from "./services/workflow/tool-result-events.js";
import { resolveWorkflowSchedulerOwnership } from "./services/workflow/scheduler-ownership.js";
import { createNativeWorkflowScheduler } from "./services/workflow/native-scheduler.js";
import type { BetterAuthSessionResult } from "./auth/better-auth.js";

type UiMode = "none" | "static" | "vite-dev";
type ApiAliasSurface = "work-items" | "work-contexts" | "execution-contexts" | "recurring-procedures";

export function resolveViteHmrPort(serverPort: number): number {
  if (serverPort <= 55_535) {
    return serverPort + 10_000;
  }
  return Math.max(1_024, serverPort - 10_000);
}

export function resolveUiRoot(baseDir = path.dirname(fileURLToPath(import.meta.url)), cwd = process.cwd()): string {
  const candidates = [
    path.resolve(baseDir, "../../ui"),
    path.resolve(baseDir, "../ui"),
    path.resolve(cwd, "ui"),
  ];

  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "index.html"))) ?? candidates[0]!;
}

function addAliasFields(value: unknown, pairs: Array<[string, string]>): unknown {
  if (Array.isArray(value)) return value.map((entry) => addAliasFields(entry, pairs));
  if (!value || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(source)) {
    next[key] = addAliasFields(fieldValue, pairs);
  }
  for (const [fromKey, toKey] of pairs) {
    if (source[fromKey] !== undefined && next[toKey] === undefined) {
      next[toKey] = next[fromKey];
    }
  }
  return next;
}

function transformAliasResponse(alias: ApiAliasSurface, body: unknown): unknown {
  switch (alias) {
    case "work-items":
      return addAliasFields(body, [
        ["projectId", "workContextId"],
        ["projectWorkspaceId", "workContextSpaceId"],
        ["executionWorkspaceId", "executionContextId"],
        ["parentId", "parentWorkItemId"],
        ["issueId", "workItemId"],
        ["issueNumber", "workItemNumber"],
        ["linkedIssueId", "linkedWorkItemId"],
      ]);
    case "work-contexts":
      return addAliasFields(body, [["projectId", "workContextId"]]);
    case "execution-contexts":
      return addAliasFields(body, [
        ["projectId", "workContextId"],
        ["projectWorkspaceId", "workContextSpaceId"],
        ["sourceIssueId", "sourceWorkItemId"],
      ]);
    case "recurring-procedures":
      return addAliasFields(body, [
        ["projectId", "workContextId"],
        ["parentIssueId", "parentWorkItemId"],
        ["linkedIssueId", "linkedWorkItemId"],
        ["activeIssue", "activeWorkItem"],
        ["parentIssue", "parentWorkItem"],
        ["linkedIssue", "linkedWorkItem"],
      ]);
  }
}

export async function createApp(
  db: Db,
  opts: {
    uiMode: UiMode;
    serverPort: number;
    storageService: StorageService;
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    allowedHostnames: string[];
    bindHost: string;
    authReady: boolean;
    companyDeletionEnabled: boolean;
    instanceId?: string;
    hostVersion?: string;
    localPluginDir?: string;
    betterAuthHandler?: express.RequestHandler;
    resolveSession?: (req: ExpressRequest) => Promise<BetterAuthSessionResult | null>;
  },
) {
  const app = express();

  app.use(express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }));
  app.use(httpLogger);
  const privateHostnameGateEnabled =
    opts.deploymentMode === "authenticated" && opts.deploymentExposure === "private";
  const privateHostnameAllowSet = resolvePrivateHostnameAllowSet({
    allowedHostnames: opts.allowedHostnames,
    bindHost: opts.bindHost,
  });
  app.use(
    privateHostnameGuard({
      enabled: privateHostnameGateEnabled,
      allowedHostnames: opts.allowedHostnames,
      bindHost: opts.bindHost,
    }),
  );
  app.use(
    actorMiddleware(db, {
      deploymentMode: opts.deploymentMode,
      resolveSession: opts.resolveSession,
    }),
  );
  app.get("/api/auth/get-session", (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.json({
      session: {
        id: `paperclip:${req.actor.source}:${req.actor.userId}`,
        userId: req.actor.userId,
      },
      user: {
        id: req.actor.userId,
        email: null,
        name: req.actor.source === "local_implicit" ? "Local Board" : null,
      },
    });
  });
  if (opts.betterAuthHandler) {
    app.all("/api/auth/*authPath", opts.betterAuthHandler);
  }
  app.use(llmRoutes(db));

  // Mount API routes
  const api = Router();
  const issuesSvc = issueService(db);
  const executionWorkspacesSvc = executionWorkspaceService(db);
  api.get("/companies/:companyId/work-items", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const assigneeUserFilterRaw = req.query.assigneeUserId as string | undefined;
    const touchedByUserFilterRaw = req.query.touchedByUserId as string | undefined;
    const inboxArchivedByUserFilterRaw = req.query.inboxArchivedByUserId as string | undefined;
    const unreadForUserFilterRaw = req.query.unreadForUserId as string | undefined;
    const assigneeUserId = assigneeUserFilterRaw === "me" && req.actor.type === "board" ? req.actor.userId : assigneeUserFilterRaw;
    const touchedByUserId = touchedByUserFilterRaw === "me" && req.actor.type === "board" ? req.actor.userId : touchedByUserFilterRaw;
    const inboxArchivedByUserId = inboxArchivedByUserFilterRaw === "me" && req.actor.type === "board" ? req.actor.userId : inboxArchivedByUserFilterRaw;
    const unreadForUserId = unreadForUserFilterRaw === "me" && req.actor.type === "board" ? req.actor.userId : unreadForUserFilterRaw;
    const result = await issuesSvc.list(companyId, {
      status: req.query.status as string | undefined,
      assigneeAgentId: req.query.assigneeAgentId as string | undefined,
      participantAgentId: req.query.participantAgentId as string | undefined,
      assigneeUserId,
      touchedByUserId,
      inboxArchivedByUserId,
      unreadForUserId,
      projectId: (req.query.projectId as string | undefined) ?? (req.query.workContextId as string | undefined),
      parentId: (req.query.parentId as string | undefined) ?? (req.query.parentWorkItemId as string | undefined),
      labelId: req.query.labelId as string | undefined,
      originKind: req.query.originKind as string | undefined,
      originId: req.query.originId as string | undefined,
      includeRoutineExecutions:
        req.query.includeRoutineExecutions === "true" || req.query.includeRoutineExecutions === "1",
      q: req.query.q as string | undefined,
    });
    res.json(
      result.map((issue) => ({
        ...issue,
        workContextId: issue.projectId,
        workContextSpaceId: issue.projectWorkspaceId,
        parentWorkItemId: issue.parentId,
        executionContextId: issue.executionWorkspaceId,
        workItemNumber: issue.issueNumber,
      })),
    );
  });
  api.get("/companies/:companyId/execution-contexts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const workspaces = await executionWorkspacesSvc.list(companyId, {
      projectId: (req.query.projectId as string | undefined) ?? (req.query.workContextId as string | undefined),
      projectWorkspaceId:
        (req.query.projectWorkspaceId as string | undefined) ?? (req.query.workContextSpaceId as string | undefined),
      issueId: (req.query.issueId as string | undefined) ?? (req.query.workItemId as string | undefined),
      status: req.query.status as string | undefined,
      reuseEligible: req.query.reuseEligible === "true",
    });
    res.json(
      workspaces.map((workspace) => ({
        ...workspace,
        workContextId: workspace.projectId,
        workContextSpaceId: workspace.projectWorkspaceId,
        sourceWorkItemId: workspace.sourceIssueId,
      })),
    );
  });
  api.use((req, res, next) => {
    const rewriteRules: Array<{ alias: ApiAliasSurface; pattern: RegExp; replacement: string }> = [
      { alias: "work-items", pattern: /^\/companies\/([^/]+)\/work-items(?=\?|$)/, replacement: "/companies/$1/issues" },
      { alias: "work-items", pattern: /^\/companies\/([^/]+)\/work-items\//, replacement: "/companies/$1/issues/" },
      { alias: "work-items", pattern: /^\/work-items\//, replacement: "/issues/" },
      { alias: "work-contexts", pattern: /^\/companies\/([^/]+)\/work-contexts(?=\?|$)/, replacement: "/companies/$1/projects" },
      { alias: "work-contexts", pattern: /^\/companies\/([^/]+)\/work-contexts\//, replacement: "/companies/$1/projects/" },
      { alias: "work-contexts", pattern: /^\/work-contexts\//, replacement: "/projects/" },
      { alias: "execution-contexts", pattern: /^\/companies\/([^/]+)\/execution-contexts(?=\?|$)/, replacement: "/companies/$1/execution-workspaces" },
      { alias: "execution-contexts", pattern: /^\/companies\/([^/]+)\/execution-contexts\//, replacement: "/companies/$1/execution-workspaces/" },
      { alias: "execution-contexts", pattern: /^\/execution-contexts\//, replacement: "/execution-workspaces/" },
      { alias: "recurring-procedures", pattern: /^\/companies\/([^/]+)\/recurring-procedures(?=\?|$)/, replacement: "/companies/$1/routines" },
      { alias: "recurring-procedures", pattern: /^\/companies\/([^/]+)\/recurring-procedures\//, replacement: "/companies/$1/routines/" },
      { alias: "recurring-procedures", pattern: /^\/recurring-procedures\//, replacement: "/routines/" },
      { alias: "recurring-procedures", pattern: /^\/recurring-procedure-triggers(?=\/|\?|$)/, replacement: "/routine-triggers" },
    ];

    for (const rule of rewriteRules) {
      if (rule.pattern.test(req.url)) {
        const originalJson = res.json.bind(res);
        res.json = ((body: unknown) => originalJson(transformAliasResponse(rule.alias, body))) as typeof res.json;
        req.url = req.url.replace(rule.pattern, rule.replacement);
        (req as { _parsedUrl?: unknown })._parsedUrl = undefined;
        break;
      }
    }
    next();
  });
  api.use(boardMutationGuard());
  api.use(
    "/health",
    healthRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      companyDeletionEnabled: opts.companyDeletionEnabled,
    }),
  );
  api.use("/metrics", metricsRoutes());
  api.use(issueRoutes(db, opts.storageService));
  api.use("/companies", companyRoutes(db, opts.storageService));
  api.use(hermesChatRoutes(db));
  api.use(companySkillRoutes(db));
  api.use(companyInstructionRoutes(db));
  api.use(agentRoutes(db));
  api.use(assetRoutes(db, opts.storageService));
  api.use(projectRoutes(db));
  api.use(routineRoutes(db));
  api.use(schedulerRoutes(db));
  api.use(missionRoutes(db));
  api.use(workflowRoutes(db));
  api.use(srbWebhookRoutes(db));
  api.use(executionWorkspaceRoutes(db));
  api.use(worktreeRoutes(db));
  // CRITICAL: single mount for maintenance gate — per-route is forbidden
  api.use("/maintenance", requireMaintenanceCompany(db), worktreeRoutes(db));
  api.use(goalRoutes(db));
  api.use(approvalRoutes(db));
  api.use(secretRoutes(db));
  api.use(costRoutes(db));
  api.use(channelConfigRoutes(db));
  api.use(activityRoutes(db));
  api.use(dashboardRoutes(db));
  api.use(sidebarBadgeRoutes(db));
  api.use(instanceSettingsRoutes(db));
  const hostServicesDisposers = new Map<string, () => void>();
  const workerManager = createPluginWorkerManager();
  const pluginRegistry = pluginRegistryService(db);
  const eventBus = createPluginEventBus();
  setPluginEventBus(eventBus);
  registerNativeWorkflowToolResultEventHandlers(db, eventBus);
  const workflowSchedulerOwnership = resolveWorkflowSchedulerOwnership();
  logger.info({
    mode: workflowSchedulerOwnership.mode,
    nativeSchedulerEnabled: workflowSchedulerOwnership.nativeSchedulerEnabled,
    pluginReconcilerDisableRequested: workflowSchedulerOwnership.pluginReconcilerDisableRequested,
    pluginReconcilerEffectiveDisabled: workflowSchedulerOwnership.pluginReconcilerEffectiveDisabled,
  }, "Workflow scheduler ownership mode");
  const jobStore = pluginJobStore(db);
  const lifecycle = pluginLifecycleManager(db, { workerManager });
  const pluginScheduler = createPluginJobScheduler({
    db,
    jobStore,
    workerManager,
    disabledScheduledJobs: workflowSchedulerOwnership.pluginReconcilerEffectiveDisabled
      ? [{ pluginKey: "insightflo.workflow-engine", jobKey: "workflow-reconciler" }]
      : [],
  });
  const toolDispatcher = createPluginToolDispatcher({
    workerManager,
    lifecycleManager: lifecycle,
    db,
  });
  setWorkflowToolStepExecutor(async (request) => {
    const toolRegistryPlugin = await pluginRegistry.getByKey("insightflo.tool-registry");
    if (!toolRegistryPlugin) {
      throw new Error("Tool Registry plugin is not installed.");
    }
    if (toolRegistryPlugin.status !== "ready") {
      throw new Error(`Tool Registry plugin is not ready (current status: ${toolRegistryPlugin.status}).`);
    }
    if (!workerManager.isRunning(toolRegistryPlugin.id)) {
      throw new Error("Tool Registry plugin worker is not running.");
    }

    const result = await workerManager.call(toolRegistryPlugin.id, "performAction", {
      key: "tool-registry.execute-workflow-tool",
      params: {
        requestId: request.requestId,
        toolName: request.toolName,
        args: request.args ?? {},
        companyId: request.companyId,
        workflowRunId: request.workflowRunId,
        workflowId: request.workflowId,
        stepId: request.stepId,
        stepRunId: request.stepRunId,
      },
      renderEnvironment: null,
    });
    return result && typeof result === "object" ? result : undefined;
  });
  const jobCoordinator = createPluginJobCoordinator({
    db,
    lifecycle,
    scheduler: pluginScheduler,
    jobStore,
  });
  const hostServiceCleanup = createPluginHostServiceCleanup(lifecycle, hostServicesDisposers);
  const loader = pluginLoader(
    db,
    { localPluginDir: opts.localPluginDir ?? DEFAULT_LOCAL_PLUGIN_DIR },
    {
      workerManager,
      eventBus,
      jobScheduler: pluginScheduler,
      jobStore,
      toolDispatcher,
      lifecycleManager: lifecycle,
      instanceInfo: {
        instanceId: opts.instanceId ?? "default",
        hostVersion: opts.hostVersion ?? "0.0.0",
      },
      buildHostHandlers: (pluginId, manifest) => {
        const notifyWorker = (method: string, params: unknown) => {
          const handle = workerManager.getWorker(pluginId);
          if (handle) handle.notify(method, params);
        };
        const services = buildHostServices(db, pluginId, manifest.id, eventBus, notifyWorker);
        hostServicesDisposers.set(pluginId, () => services.dispose());
        return createHostClientHandlers({
          pluginId,
          capabilities: manifest.capabilities,
          services,
        });
      },
    },
  );
  api.use(
    pluginRoutes(
      db,
      loader,
      { scheduler: pluginScheduler, jobStore },
      { workerManager },
      { toolDispatcher },
      { workerManager },
    ),
  );
  api.use(
    accessRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      bindHost: opts.bindHost,
      allowedHostnames: opts.allowedHostnames,
    }),
  );
  app.use("/api", api);
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });
  app.use(pluginUiStaticRoutes(db, {
    localPluginDir: opts.localPluginDir ?? DEFAULT_LOCAL_PLUGIN_DIR,
  }));

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  if (opts.uiMode === "static") {
    // Try published location first (server/ui-dist/), then monorepo dev location (../../ui/dist)
    const candidates = [
      path.resolve(__dirname, "../ui-dist"),
      path.resolve(__dirname, "../../ui/dist"),
    ];
    const uiDist = candidates.find((p) => fs.existsSync(path.join(p, "index.html")));
    if (uiDist) {
      const indexHtml = applyUiBranding(fs.readFileSync(path.join(uiDist, "index.html"), "utf-8"));
      app.use(express.static(uiDist));
      app.get(/.*/, (_req, res) => {
        res.status(200).set("Content-Type", "text/html").end(indexHtml);
      });
    } else {
      console.warn("[paperclip] UI dist not found; running in API-only mode");
    }
  }

  if (opts.uiMode === "vite-dev") {
    const uiRoot = resolveUiRoot(__dirname);
    const hmrPort = resolveViteHmrPort(opts.serverPort);
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      root: uiRoot,
      appType: "custom",
      server: {
        middlewareMode: true,
        hmr: {
          host: opts.bindHost,
          port: hmrPort,
          clientPort: hmrPort,
        },
        allowedHosts: privateHostnameGateEnabled ? Array.from(privateHostnameAllowSet) : undefined,
      },
    });

    app.use(vite.middlewares);
    app.get(/.*/, async (req, res, next) => {
      try {
        const templatePath = path.resolve(uiRoot, "index.html");
        const template = fs.readFileSync(templatePath, "utf-8");
        const html = applyUiBranding(await vite.transformIndexHtml(req.originalUrl, template));
        res.status(200).set({ "Content-Type": "text/html" }).end(html);
      } catch (err) {
        next(err);
      }
    });
  }

  app.use(errorHandler);

  // Initialize and start the scheduler
  const heartbeat = heartbeatService(db);
  const scheduler = createScheduler(db, {
    heartbeat: {
      enqueueWakeup: (agentId, opts) => heartbeat.wakeup(agentId, {
        source: opts?.source === "scheduler" ? "scheduler" : "automation",
        triggerDetail: opts?.triggerDetail ?? null,
        contextSnapshot: opts?.missionId ? { missionId: opts.missionId } : undefined,
        reason: opts?.reason ?? null,
      }),
    },
  });
  scheduler.start();

  // Initialize channel registry (Telegram bots)
  const channelRegistry = createChannelRegistry(db);
  void channelRegistry.start()
    .then(() => {
      for (const companyId of channelRegistry.getActiveCompanyIds()) {
        registerTelegramCommands(db, companyId);
      }
    })
    .catch((err) => {
      logger.error({ err }, "Failed to start channel registry");
    });

  // Initialize alert rules — broadcast to all registered Telegram chats
  const alertRules = createAlertRules(
    () => scheduler.getState(),
    async (message) => {
      for (const companyId of channelRegistry.getActiveCompanyIds()) {
        const chatId = getChatId(companyId);
        if (chatId === undefined) continue;
        const sender = channelRegistry.getTelegramSender(companyId);
        if (!sender) continue;
        try {
          await sender(chatId, message);
        } catch (err) {
          logger.warn({ err, companyId }, "Alert: failed to send to company");
        }
      }
    },
  );
  setAlertRules(alertRules);
  alertRules.start();

  // Start Telegram alert monitor — worktree violation spike detection (P9-T9)
  const stopAlertMonitor = startAlertMonitor(db);
  process.once("exit", stopAlertMonitor);

  const srbRetryWorker = createDeliveryRetryWorker(db);
  srbRetryWorker.start();

  const srbNonceCleanup = createNonceCleanupJob(db);
  srbNonceCleanup.start();

  const auditLogCleanup = createAuditLogCleanupJob(db);
  auditLogCleanup.start();

  const missionOwnerSupervisionMonitor = createMissionOwnerSupervisionMonitor(db, {
    onOwnerActionCreated: ({ mission, issue, sourceIssue, reason }) => {
      if (!issue.assigneeAgentId) return null;
      return heartbeat.wakeup(issue.assigneeAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: reason ?? "mission_unblock_action_created",
        payload: {
          issueId: issue.id,
          missionId: mission.id,
          mutation: "mission_main_executor_unblock",
          sourceIssueId: sourceIssue.id,
        },
        requestedByActorType: "system",
        requestedByActorId: "mission-owner-supervision-monitor",
        contextSnapshot: {
          issueId: issue.id,
          missionId: mission.id,
          source: "mission_supervision_monitor",
          sourceIssueId: sourceIssue.id,
        },
      });
    },
    onOwnerDecisionRetrySourceIssueApplied: ({ mission, ownerActionIssue, sourceIssue, targetAgentId, idempotencyKey, wakeCommentId }) => heartbeat.wakeup(targetAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "mission_owner_decision_retry_source_issue",
      idempotencyKey,
      payload: {
        issueId: sourceIssue.id,
        missionId: mission.id,
        mutation: "mission_owner_decision_retry_source_issue",
        ownerActionIssueId: ownerActionIssue.id,
        wakeCommentId,
      },
      requestedByActorType: "system",
      requestedByActorId: "mission-owner-supervision-monitor",
      contextSnapshot: {
        issueId: sourceIssue.id,
        missionId: mission.id,
        source: "mission_owner_decision_retry_source_issue",
        ownerActionIssueId: ownerActionIssue.id,
        wakeCommentId,
      },
    }),
    onStaleSourceIssueWakeupRequested: ({ mission, sourceIssue, targetAgentId, failedRun, idempotencyKey, wakeCommentId }) => heartbeat.wakeup(targetAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "mission_stale_source_issue_wakeup",
      idempotencyKey,
      payload: {
        issueId: sourceIssue.id,
        missionId: mission.id,
        mutation: "mission_stale_source_issue_wakeup",
        failedRunId: failedRun.id,
        failedRunStatus: failedRun.status,
        wakeCommentId,
      },
      requestedByActorType: "system",
      requestedByActorId: "mission-owner-supervision-monitor",
      contextSnapshot: {
        issueId: sourceIssue.id,
        missionId: mission.id,
        source: "mission_stale_source_issue_wakeup",
        failedRunId: failedRun.id,
        failedRunStatus: failedRun.status,
        wakeCommentId,
      },
    }),
  });
  missionOwnerSupervisionMonitor.start();
  process.once("exit", () => missionOwnerSupervisionMonitor.stop());

  const nativeWorkflowScheduler = workflowSchedulerOwnership.mode === "native-shadow"
    ? createNativeWorkflowScheduler({ db, mode: "shadow" })
    : workflowSchedulerOwnership.mode === "native-active-plugin-disabled"
      ? createNativeWorkflowScheduler({ db, mode: "active" })
    : null;
  nativeWorkflowScheduler?.start();
  if (nativeWorkflowScheduler) {
    process.once("exit", () => nativeWorkflowScheduler.stop());
  }

  pluginScheduler.start();
  jobCoordinator.start();
  void toolDispatcher.initialize().catch((err) => {
    logger.error({ err }, "Failed to initialize plugin tool dispatcher");
  });
  const devWatcher = opts.uiMode === "vite-dev"
    ? createPluginDevWatcher(
      lifecycle,
      async (pluginId) => (await pluginRegistry.getById(pluginId))?.packagePath ?? null,
    )
    : null;
  void loader.loadAll().then((result) => {
    if (!result) return;
    for (const loaded of result.results) {
      if (devWatcher && loaded.success && loaded.plugin.packagePath) {
        devWatcher.watch(loaded.plugin.id, loaded.plugin.packagePath);
      }
    }
  }).catch((err) => {
    logger.error({ err }, "Failed to load ready plugins on startup");
  });
  process.once("exit", () => {
    devWatcher?.close();
    hostServiceCleanup.disposeAll();
    hostServiceCleanup.teardown();
  });
  process.once("beforeExit", () => {
    void flushPluginLogBuffer();
  });

  return app;
}

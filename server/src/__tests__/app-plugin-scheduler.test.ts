import { beforeEach, describe, expect, it, vi } from "vitest";

const pluginSchedulerStart = vi.fn();
const nativeWorkflowSchedulerStart = vi.fn();
const missionOwnerSupervisionMonitorStart = vi.fn();
const nativeWorkflowToolResultEventHandlers = vi.fn();
const createPluginJobSchedulerMock = vi.fn(() => ({
  start: pluginSchedulerStart,
  stop: vi.fn(),
  registerPlugin: vi.fn(),
  unregisterPlugin: vi.fn(),
  triggerJob: vi.fn(),
  tick: vi.fn(),
  diagnostics: vi.fn(() => ({
    running: false,
    activeJobCount: 0,
    activeJobIds: [],
    tickCount: 0,
    lastTickAt: null,
  })),
}));
const createNativeWorkflowSchedulerMock = vi.fn(() => ({
  start: nativeWorkflowSchedulerStart,
  stop: vi.fn(),
  tick: vi.fn(),
  getState: vi.fn(),
}));
const pluginEventBus = {
  forPlugin: vi.fn(),
  emit: vi.fn(),
  clearPlugin: vi.fn(),
  subscriptionCount: vi.fn(() => 0),
};
const createMissionOwnerSupervisionMonitorMock = vi.fn(() => ({
  start: missionOwnerSupervisionMonitorStart,
  stop: vi.fn(),
  run: vi.fn(),
}));

vi.mock("../services/plugin-job-scheduler.js", () => ({
  createPluginJobScheduler: createPluginJobSchedulerMock,
}));

vi.mock("../services/workflow/native-scheduler.js", () => ({
  createNativeWorkflowScheduler: createNativeWorkflowSchedulerMock,
}));

vi.mock("../services/plugin-job-coordinator.js", () => ({
  createPluginJobCoordinator: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock("../services/plugin-loader.js", () => ({
  DEFAULT_LOCAL_PLUGIN_DIR: "plugins",
  pluginLoader: vi.fn(() => ({
    loadAll: vi.fn(async () => ({ results: [] })),
  })),
}));

vi.mock("../services/plugin-worker-manager.js", () => ({
  createPluginWorkerManager: vi.fn(() => ({
    getWorker: vi.fn(() => null),
  })),
}));

vi.mock("../services/plugin-tool-dispatcher.js", () => ({
  createPluginToolDispatcher: vi.fn(() => ({
    initialize: vi.fn(async () => undefined),
  })),
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: vi.fn(() => ({
    on: vi.fn(),
    off: vi.fn(),
  })),
}));

vi.mock("../services/plugin-job-store.js", () => ({
  pluginJobStore: vi.fn(() => ({})),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: vi.fn(() => ({})),
}));

vi.mock("../services/plugin-event-bus.js", () => ({
  createPluginEventBus: vi.fn(() => pluginEventBus),
}));

vi.mock("../services/activity-log.js", () => ({
  setPluginEventBus: vi.fn(),
}));

vi.mock("../services/workflow/tool-result-events.js", () => ({
  registerNativeWorkflowToolResultEventHandlers: nativeWorkflowToolResultEventHandlers,
}));

vi.mock("../services/plugin-dev-watcher.js", () => ({
  createPluginDevWatcher: vi.fn(() => null),
}));

vi.mock("../services/plugin-host-service-cleanup.js", () => ({
  createPluginHostServiceCleanup: vi.fn(() => ({
    disposeAll: vi.fn(),
    teardown: vi.fn(),
  })),
}));

vi.mock("../services/plugin-host-services.js", () => ({
  buildHostServices: vi.fn(() => ({ dispose: vi.fn() })),
  flushPluginLogBuffer: vi.fn(),
}));

vi.mock("../services/alert-rules.js", () => ({
  createAlertRules: vi.fn(() => ({ start: vi.fn(), getState: vi.fn() })),
  setAlertRules: vi.fn(),
}));

vi.mock("../services/scheduler/index.js", () => ({
  createScheduler: vi.fn(() => ({
    start: vi.fn(),
    getState: vi.fn(() => ({})),
  })),
}));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: vi.fn(() => ({
    wakeup: vi.fn(),
  })),
}));

vi.mock("../channel/index.js", () => ({
  createChannelRegistry: vi.fn(() => ({
    start: vi.fn(async () => undefined),
    getActiveCompanyIds: vi.fn(() => []),
    getTelegramSender: vi.fn(() => null),
  })),
}));

vi.mock("../channel/telegram/outbound.js", () => ({
  getChatId: vi.fn(() => undefined),
}));

vi.mock("../channel/telegram/alerts.js", () => ({
  startAlertMonitor: vi.fn(() => vi.fn()),
}));

vi.mock("../services/srb/delivery-retry-worker.js", () => ({
  createDeliveryRetryWorker: vi.fn(() => ({ start: vi.fn() })),
}));

vi.mock("../services/srb/nonce-cleanup.js", () => ({
  createNonceCleanupJob: vi.fn(() => ({ start: vi.fn() })),
}));

vi.mock("../services/audit-log-cleanup.js", () => ({
  createAuditLogCleanupJob: vi.fn(() => ({ start: vi.fn() })),
}));

vi.mock("../services/mission-owner-supervision-monitor.js", () => ({
  createMissionOwnerSupervisionMonitor: createMissionOwnerSupervisionMonitorMock,
}));

describe("createApp plugin scheduler lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.WORKFLOW_NATIVE_SCHEDULER_ENABLED;
    delete process.env.WORKFLOW_PLUGIN_RECONCILER_DISABLED;
    pluginSchedulerStart.mockClear();
    nativeWorkflowSchedulerStart.mockClear();
    createPluginJobSchedulerMock.mockClear();
    createNativeWorkflowSchedulerMock.mockClear();
    missionOwnerSupervisionMonitorStart.mockClear();
    nativeWorkflowToolResultEventHandlers.mockClear();
    pluginEventBus.forPlugin.mockClear();
    pluginEventBus.emit.mockClear();
    pluginEventBus.clearPlugin.mockClear();
    pluginEventBus.subscriptionCount.mockClear();
    createMissionOwnerSupervisionMonitorMock.mockClear();
  });

  it("starts the plugin job scheduler so plugin cron jobs can tick", async () => {
    const { createApp } = await import("../app.js");

    await createApp({} as never, {
      uiMode: "none",
      serverPort: 3200,
      storageService: {} as never,
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      allowedHostnames: [],
      bindHost: "127.0.0.1",
      authReady: true,
      companyDeletionEnabled: true,
    });

    expect(pluginSchedulerStart).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("starts native active scheduling and disables only the workflow-engine reconciler job when cutover flags are enabled", async () => {
    process.env.WORKFLOW_NATIVE_SCHEDULER_ENABLED = "true";
    process.env.WORKFLOW_PLUGIN_RECONCILER_DISABLED = "true";
    const { createApp } = await import("../app.js");

    await createApp({} as never, {
      uiMode: "none",
      serverPort: 3200,
      storageService: {} as never,
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      allowedHostnames: [],
      bindHost: "127.0.0.1",
      authReady: true,
      companyDeletionEnabled: true,
    });

    expect(createNativeWorkflowSchedulerMock).toHaveBeenCalledWith(expect.objectContaining({
      mode: "active",
    }));
    expect(nativeWorkflowSchedulerStart).toHaveBeenCalledTimes(1);
    expect(createPluginJobSchedulerMock).toHaveBeenCalledWith(expect.objectContaining({
      disabledScheduledJobs: [
        { pluginKey: "insightflo.workflow-engine", jobKey: "workflow-reconciler" },
      ],
    }));
    expect(pluginSchedulerStart).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("registers native workflow tool-result event handlers on the shared plugin event bus", async () => {
    const { createApp } = await import("../app.js");
    const db = {} as never;

    await createApp(db, {
      uiMode: "none",
      serverPort: 3200,
      storageService: {} as never,
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      allowedHostnames: [],
      bindHost: "127.0.0.1",
      authReady: true,
      companyDeletionEnabled: true,
    });

    expect(nativeWorkflowToolResultEventHandlers).toHaveBeenCalledWith(db, pluginEventBus);
  }, 60_000);

  it("starts the mission owner supervision monitor so stale active missions are inspected automatically", async () => {
    const { createApp } = await import("../app.js");

    await createApp({} as never, {
      uiMode: "none",
      serverPort: 3200,
      storageService: {} as never,
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      allowedHostnames: [],
      bindHost: "127.0.0.1",
      authReady: true,
      companyDeletionEnabled: true,
    });

    expect(missionOwnerSupervisionMonitorStart).toHaveBeenCalledTimes(1);
    expect(createMissionOwnerSupervisionMonitorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        onOwnerActionCreated: expect.any(Function),
      }),
    );
  }, 60_000);
});

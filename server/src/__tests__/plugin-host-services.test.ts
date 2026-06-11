import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  issueCreate: vi.fn(),
  issueGetById: vi.fn(),
  issueUpdate: vi.fn(),
  heartbeatWakeup: vi.fn(),
  logActivity: vi.fn(),
  syncSrbSourceIssueStatus: vi.fn(),
  registryGetConfig: vi.fn(),
  registryUpsertEntity: vi.fn(),
  registryListEntities: vi.fn(),
}));

vi.mock("../services/companies.js", () => ({ companyService: () => ({}) }));
vi.mock("../services/agents.js", () => ({ agentService: () => ({}) }));
vi.mock("../services/projects.js", () => ({ projectService: () => ({}) }));
vi.mock("../services/issues.js", () => ({
  issueService: () => ({
    create: mocks.issueCreate,
    getById: mocks.issueGetById,
    update: mocks.issueUpdate,
  }),
}));
vi.mock("../services/goals.js", () => ({ goalService: () => ({}) }));
vi.mock("../services/documents.js", () => ({ documentService: () => ({}) }));
vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => ({
    wakeup: mocks.heartbeatWakeup,
  }),
}));
vi.mock("../services/live-events.js", () => ({ subscribeCompanyLiveEvents: vi.fn() }));
vi.mock("../services/activity.js", () => ({ activityService: () => ({}) }));
vi.mock("../services/costs.js", () => ({ costService: () => ({}) }));
vi.mock("../services/assets.js", () => ({ assetService: () => ({}) }));
vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => ({
    getConfig: mocks.registryGetConfig.mockResolvedValue(null),
    upsertEntity: mocks.registryUpsertEntity,
    listEntities: mocks.registryListEntities,
  }),
}));
vi.mock("../services/plugin-state-store.js", () => ({
  pluginStateStore: () => ({
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  }),
}));
vi.mock("../services/plugin-secrets-handler.js", () => ({
  createPluginSecretsHandler: () => ({
    resolve: vi.fn(),
  }),
}));
vi.mock("../services/activity-log.js", () => ({
  logActivity: mocks.logActivity,
}));
vi.mock("../services/srb/source-status-sync.js", () => ({
  syncSrbSourceIssueStatus: mocks.syncSrbSourceIssueStatus,
}));
vi.mock("../services/workflow/engine.js", () => ({
  workflowService: {
    syncRunStatusForIssue: vi.fn(async () => null),
  },
}));
vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  },
}));

import type { PluginEventBus } from "../services/plugin-event-bus.js";
import { buildHostServices } from "../services/plugin-host-services.js";

describe("buildHostServices issues", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.heartbeatWakeup.mockResolvedValue({ id: "run-1" });
    mocks.registryGetConfig.mockResolvedValue(null);
    mocks.registryUpsertEntity.mockImplementation(async (_pluginId, input) => ({
      id: "entity-1",
      pluginId: "plugin-install-1",
      ...input,
    }));
    mocks.registryListEntities.mockResolvedValue([]);
  });

  function createEventBus(): PluginEventBus {
    return {
      emit: vi.fn().mockResolvedValue({ delivered: 0, errors: [] }),
      forPlugin: vi.fn(() => ({
        emit: vi.fn().mockResolvedValue({ delivered: 0, errors: [] }),
        subscribe: vi.fn(),
        clear: vi.fn(),
      })),
      clearPlugin: vi.fn(),
      subscriptionCount: vi.fn().mockReturnValue(0),
    };
  }

  it("propagates workflow tool-result subscriber failures so plugins can use fallback delivery", async () => {
    const scopedEmit = vi.fn().mockResolvedValue({
      errors: [{ pluginId: "paperclip.native-workflow-engine", error: new Error("db unavailable") }],
    });
    const eventBus: PluginEventBus = {
      emit: vi.fn().mockResolvedValue({ errors: [] }),
      forPlugin: vi.fn(() => ({
        emit: scopedEmit,
        subscribe: vi.fn(),
        clear: vi.fn(),
      })),
      clearPlugin: vi.fn(),
      subscriptionCount: vi.fn().mockReturnValue(0),
    };

    const services = buildHostServices(
      {} as never,
      "tool-registry-install-1",
      "insightflo.tool-registry",
      eventBus,
    );

    await expect(services.events.emit({
      name: "tool-execution-result",
      companyId: "company-1",
      payload: { stepRunId: "step-run-1" },
    })).rejects.toThrow("Workflow tool-result event delivery failed");
    expect(scopedEmit).toHaveBeenCalledWith("tool-execution-result", "company-1", { stepRunId: "step-run-1" });

    services.dispose();
  });

  it("keeps generic plugin event subscriber failures isolated", async () => {
    const scopedEmit = vi.fn().mockResolvedValue({
      errors: [{ pluginId: "subscriber-plugin", error: new Error("subscriber failed") }],
    });
    const eventBus: PluginEventBus = {
      emit: vi.fn().mockResolvedValue({ errors: [] }),
      forPlugin: vi.fn(() => ({
        emit: scopedEmit,
        subscribe: vi.fn(),
        clear: vi.fn(),
      })),
      clearPlugin: vi.fn(),
      subscriptionCount: vi.fn().mockReturnValue(0),
    };

    const services = buildHostServices(
      {} as never,
      "tool-registry-install-1",
      "insightflo.tool-registry",
      eventBus,
    );

    await expect(services.events.emit({
      name: "tool-graph-updated",
      companyId: "company-1",
      payload: { ok: true },
    })).resolves.toBeUndefined();

    services.dispose();
  });

  it("logs issue.created and queues assignment wake for plugin-created issues", async () => {
    mocks.issueCreate.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      title: "Mirror maintenance request",
      identifier: "PAP-42",
      assigneeAgentId: "agent-1",
      status: "todo",
    });

    const eventBus: PluginEventBus = {
      emit: vi.fn().mockResolvedValue({ delivered: 0, errors: [] }),
      forPlugin: vi.fn(() => ({
        emit: vi.fn().mockResolvedValue({ delivered: 0, errors: [] }),
        subscribe: vi.fn(),
        clear: vi.fn(),
      })),
      clearPlugin: vi.fn(),
      subscriptionCount: vi.fn().mockReturnValue(0),
    };

    const services = buildHostServices(
      {} as never,
      "plugin-install-1",
      "paperclipai.service-request-bridge",
      eventBus,
    );

    const issue = await services.issues.create({
      companyId: "company-1",
      title: "Mirror maintenance request",
      status: "todo",
      assigneeAgentId: "agent-1",
    });

    expect(issue).toMatchObject({ id: "issue-1", status: "todo" });
    expect(mocks.logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId: "company-1",
      actorType: "system",
      actorId: "plugin-install-1",
      action: "issue.created",
      entityType: "issue",
      entityId: "issue-1",
      details: { title: "Mirror maintenance request", identifier: "PAP-42" },
    }));
    expect(mocks.heartbeatWakeup).toHaveBeenCalledWith("agent-1", expect.objectContaining({
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: "issue-1", mutation: "create" },
      requestedByActorType: "system",
      requestedByActorId: "plugin-install-1",
      contextSnapshot: { issueId: "issue-1", source: "plugin.issues.create" },
    }));

    services.dispose();
  });

  it("logs issue.updated and wakes the assignee when plugin update assigns an issue", async () => {
    mocks.issueGetById.mockResolvedValue({
      id: "issue-2",
      companyId: "company-1",
      identifier: "PAP-43",
      assigneeAgentId: null,
      status: "todo",
    });
    mocks.issueUpdate.mockResolvedValue({
      id: "issue-2",
      companyId: "company-1",
      identifier: "PAP-43",
      assigneeAgentId: "agent-2",
      status: "todo",
    });

    const eventBus: PluginEventBus = {
      emit: vi.fn().mockResolvedValue({ delivered: 0, errors: [] }),
      forPlugin: vi.fn(() => ({
        emit: vi.fn().mockResolvedValue({ delivered: 0, errors: [] }),
        subscribe: vi.fn(),
        clear: vi.fn(),
      })),
      clearPlugin: vi.fn(),
      subscriptionCount: vi.fn().mockReturnValue(0),
    };

    const services = buildHostServices(
      {} as never,
      "plugin-install-1",
      "paperclipai.service-request-bridge",
      eventBus,
    );

    const issue = await services.issues.update({
      issueId: "issue-2",
      companyId: "company-1",
      patch: { assigneeAgentId: "agent-2" },
    });

    expect(issue).toMatchObject({ id: "issue-2", assigneeAgentId: "agent-2" });
    expect(mocks.logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId: "company-1",
      actorType: "system",
      actorId: "plugin-install-1",
      action: "issue.updated",
      entityType: "issue",
      entityId: "issue-2",
      details: {
        assigneeAgentId: "agent-2",
        identifier: "PAP-43",
        _previous: { assigneeAgentId: null },
      },
    }));
    expect(mocks.heartbeatWakeup).toHaveBeenCalledWith("agent-2", expect.objectContaining({
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: "issue-2", mutation: "update" },
      requestedByActorType: "system",
      requestedByActorId: "plugin-install-1",
      contextSnapshot: { issueId: "issue-2", source: "plugin.issues.update" },
    }));
    expect(mocks.syncSrbSourceIssueStatus).not.toHaveBeenCalled();

    services.dispose();
  });

  it("logs issue.updated and wakes the assignee when plugin update moves an assigned issue out of backlog", async () => {
    mocks.issueGetById.mockResolvedValue({
      id: "issue-3",
      companyId: "company-1",
      identifier: "PAP-44",
      assigneeAgentId: "agent-3",
      status: "backlog",
    });
    mocks.issueUpdate.mockResolvedValue({
      id: "issue-3",
      companyId: "company-1",
      identifier: "PAP-44",
      assigneeAgentId: "agent-3",
      status: "todo",
    });

    const eventBus: PluginEventBus = {
      emit: vi.fn().mockResolvedValue({ delivered: 0, errors: [] }),
      forPlugin: vi.fn(() => ({
        emit: vi.fn().mockResolvedValue({ delivered: 0, errors: [] }),
        subscribe: vi.fn(),
        clear: vi.fn(),
      })),
      clearPlugin: vi.fn(),
      subscriptionCount: vi.fn().mockReturnValue(0),
    };

    const services = buildHostServices(
      {} as never,
      "plugin-install-1",
      "paperclipai.service-request-bridge",
      eventBus,
    );

    const issue = await services.issues.update({
      issueId: "issue-3",
      companyId: "company-1",
      patch: { status: "todo" },
    });

    expect(issue).toMatchObject({ id: "issue-3", status: "todo" });
    expect(mocks.syncSrbSourceIssueStatus).toHaveBeenCalledWith({
      db: expect.anything(),
      issueId: "issue-3",
      status: "todo",
    });
    expect(mocks.heartbeatWakeup).toHaveBeenCalledWith("agent-3", expect.objectContaining({
      source: "automation",
      triggerDetail: "system",
      reason: "issue_status_changed",
      payload: { issueId: "issue-3", mutation: "update" },
      requestedByActorType: "system",
      requestedByActorId: "plugin-install-1",
      contextSnapshot: { issueId: "issue-3", source: "plugin.issue.status_change" },
    }));

    services.dispose();
  });

  it("blocks a linked issue when a plugin workflow step run fails", async () => {
    mocks.issueGetById.mockResolvedValue({
      id: "issue-4",
      companyId: "company-1",
      identifier: "CMPA-1517",
      assigneeAgentId: "agent-4",
      status: "todo",
    });
    mocks.issueUpdate.mockResolvedValue({
      id: "issue-4",
      companyId: "company-1",
      identifier: "CMPA-1517",
      assigneeAgentId: "agent-4",
      status: "blocked",
    });

    const services = buildHostServices(
      {} as never,
      "plugin-install-1",
      "paperclipai.service-request-bridge",
      createEventBus(),
    );

    await services.entities.upsert({
      entityType: "workflow-step-run",
      scopeKind: "company",
      scopeId: "company-1",
      externalId: "run-1:step-1",
      title: "Generate report",
      data: {
        workflowRunId: "run-1",
        issueId: "issue-4",
        status: "failed",
      },
    });

    expect(mocks.issueUpdate).toHaveBeenCalledWith("issue-4", { status: "blocked" });
    expect(mocks.syncSrbSourceIssueStatus).toHaveBeenCalledWith({
      db: expect.anything(),
      issueId: "issue-4",
      status: "blocked",
    });
    expect(mocks.logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId: "company-1",
      actorType: "system",
      actorId: "plugin-install-1",
      action: "issue.updated",
      entityType: "issue",
      entityId: "issue-4",
      details: {
        status: "blocked",
        identifier: "CMPA-1517",
        _previous: { status: "todo" },
      },
    }));

    services.dispose();
  });
});

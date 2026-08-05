import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  issueGetById: vi.fn(),
  agentGetById: vi.fn(),
  heartbeatWakeup: vi.fn(),
}));

vi.mock("../services/companies.js", () => ({ companyService: () => ({}) }));
vi.mock("../services/agents.js", () => ({
  agentService: () => ({ getById: mocks.agentGetById }),
}));
vi.mock("../services/projects.js", () => ({ projectService: () => ({}) }));
vi.mock("../services/issues.js", () => ({
  issueService: () => ({ getById: mocks.issueGetById }),
}));
vi.mock("../services/goals.js", () => ({ goalService: () => ({}) }));
vi.mock("../services/documents.js", () => ({ documentService: () => ({}) }));
vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => ({ wakeup: mocks.heartbeatWakeup }),
}));
vi.mock("../services/live-events.js", () => ({ subscribeCompanyLiveEvents: vi.fn() }));
vi.mock("../services/activity.js", () => ({ activityService: () => ({}) }));
vi.mock("../services/costs.js", () => ({ costService: () => ({}) }));
vi.mock("../services/assets.js", () => ({ assetService: () => ({}) }));
vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => ({
    getConfig: vi.fn().mockResolvedValue(null),
    upsertEntity: vi.fn(),
    listEntities: vi.fn().mockResolvedValue([]),
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
  createPluginSecretsHandler: () => ({ resolve: vi.fn() }),
}));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../services/srb/source-status-sync.js", () => ({
  syncSrbSourceIssueStatus: vi.fn(),
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
vi.mock("@paperclipai/db", () => ({
  pluginLogs: {},
  agentTaskSessions: {},
  issueComments: {},
}));

import type { PluginEventBus } from "../services/plugin-event-bus.js";
import { buildHostServices } from "../services/plugin-host-services.js";

const validAgent = {
  id: "agent-1",
  companyId: "company-1",
  name: "Engineer",
  status: "idle",
};

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

function createServices(db: never = {} as never) {
  return buildHostServices(
    db,
    "plugin-install-1",
    "paperclipai.service-request-bridge",
    createEventBus(),
  );
}

describe("buildHostServices agents.invoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.agentGetById.mockResolvedValue(validAgent);
    mocks.issueGetById.mockResolvedValue(null);
    mocks.heartbeatWakeup.mockResolvedValue({ id: "run-1" });
  });

  it("wakes with issue/comment context from the supplied context", async () => {
    mocks.issueGetById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-42",
      status: "todo",
      assigneeAgentId: "agent-1",
    });

    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            then: (resolve: (rows: unknown[]) => unknown) => resolve([
              { id: "comment-1", issueId: "issue-1", companyId: "company-1" },
            ]),
          }),
        }),
      }),
    } as never;

    const services = createServices(db);
    const result = await services.agents.invoke({
      agentId: "agent-1",
      companyId: "company-1",
      prompt: "Review the plan",
      reason: "review-requested",
      context: {
        issueId: "issue-1",
        commentId: "comment-1",
        taskKey: "task-1",
      },
    });

    expect(result).toEqual({ runId: "run-1" });
    expect(mocks.heartbeatWakeup).toHaveBeenCalledWith("agent-1", {
      source: "automation",
      triggerDetail: "system",
      reason: "review-requested",
      payload: {
        prompt: "Review the plan",
        issueId: "issue-1",
        commentId: "comment-1",
      },
      contextSnapshot: {
        issueId: "issue-1",
        taskId: "issue-1",
        taskKey: "task-1",
        commentId: "comment-1",
        wakeCommentId: "comment-1",
      },
      requestedByActorType: "system",
      requestedByActorId: "plugin-install-1",
    });

    services.dispose();
  });

  it("rejects an issue from another company", async () => {
    mocks.issueGetById.mockResolvedValue({
      id: "issue-9",
      companyId: "company-2",
      status: "todo",
    });

    const services = createServices();
    await expect(services.agents.invoke({
      agentId: "agent-1",
      companyId: "company-1",
      prompt: "p",
      context: { issueId: "issue-9" },
    })).rejects.toThrow("Issue not found");
    expect(mocks.heartbeatWakeup).not.toHaveBeenCalled();

    services.dispose();
  });

  it("rejects a comment that does not belong to the supplied issue", async () => {
    mocks.issueGetById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      status: "todo",
    });

    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            then: (resolve: (rows: unknown[]) => unknown) => resolve([]),
          }),
        }),
      }),
    } as never;

    const services = createServices(db);
    await expect(services.agents.invoke({
      agentId: "agent-1",
      companyId: "company-1",
      prompt: "p",
      context: { issueId: "issue-1", commentId: "comment-1" },
    })).rejects.toThrow("Comment not found for the supplied issue");
    expect(mocks.heartbeatWakeup).not.toHaveBeenCalled();

    services.dispose();
  });

  it("rejects commentId without issueId", async () => {
    const services = createServices();
    await expect(services.agents.invoke({
      agentId: "agent-1",
      companyId: "company-1",
      prompt: "p",
      context: { commentId: "comment-1" },
    })).rejects.toThrow("commentId requires issueId");
    expect(mocks.heartbeatWakeup).not.toHaveBeenCalled();

    services.dispose();
  });
});

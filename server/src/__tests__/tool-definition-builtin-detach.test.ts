import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { toolDefinitionRoutes } from "../routes/tool-definitions.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const TOOL_ID = "33333333-3333-4333-8333-333333333333";

const mockToolService = vi.hoisted(() => ({
  createDefinition: vi.fn(),
  deleteDefinition: vi.fn(),
  getDefinitionById: vi.fn(),
  listDefinitions: vi.fn(),
  updateDefinition: vi.fn(),
}));

vi.mock("../services/tools/registry.js", () => ({ toolService: mockToolService }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn(async () => undefined) }));

function definition(adapterConfig: Record<string, unknown>) {
  return {
    id: TOOL_ID,
    companyId: COMPANY_ID,
    name: "send-telegram",
    description: "Send a Telegram notification",
    inputSchema: { type: "object" },
    adapterType: "builtin",
    adapterConfig,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as never as { actor: unknown }).actor = {
      type: "board",
      userId: "board-user-1",
      companyIds: [COMPANY_ID],
      source: "authenticated",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", toolDefinitionRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("builtin Tool Registry ownership detachment", () => {
  beforeEach(() => vi.resetAllMocks());

  it("allows a board to keep builtin execution while clearing the source marker", async () => {
    const detachedConfig = {
      source: "",
      command: "python3 send_telegram_wrapper.py",
      workingDirectory: "/srv/papercompany/tools/notifications",
    };
    mockToolService.getDefinitionById.mockResolvedValue(definition({
      ...detachedConfig,
      source: "tool-registry",
    }));
    mockToolService.updateDefinition.mockResolvedValue(definition(detachedConfig));

    const response = await request(createApp())
      .patch(`/api/companies/${COMPANY_ID}/tools/${TOOL_ID}`)
      .send({ adapterType: "builtin", adapterConfig: detachedConfig });

    expect(response.status).toBe(200);
    expect(mockToolService.updateDefinition).toHaveBeenCalledWith(
      expect.anything(),
      TOOL_ID,
      { adapterType: "builtin", adapterConfig: detachedConfig },
    );
  });
});

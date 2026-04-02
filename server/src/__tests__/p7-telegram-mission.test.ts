/**
 * P7-T8: E2E test — Telegram mission status query
 *
 * Tests the buildTelegramHandler() from commands.ts using vitest mocks.
 * No real DB or Telegram connection is used.
 *
 * Coverage:
 *   - /mission <missionId>  → sender called with mission title and status
 *   - /mission create <title> → sender called with success/created message
 *   - /mission (no args)    → sender called with usage error
 *   - Unknown command       → sender called with error message
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @paperclipai/db to prevent the postgres transitive import from breaking vitest
vi.mock("@paperclipai/db", () => ({
  agents: {},
  approvals: {},
  issues: {},
  missions: {},
  channelConfigs: {},
  missionAgents: {},
}));

// ---------------------------------------------------------------------------
// Mock getChannelRegistry before importing commands.ts so the module resolves
// the mock instead of the real singleton.
// ---------------------------------------------------------------------------

const mockSender = vi.fn<(chatId: number, text: string) => Promise<void>>().mockResolvedValue(undefined);

vi.mock("../channel/index.js", () => ({
  getChannelRegistry: vi.fn(() => ({
    getTelegramSender: (_companyId: string) => mockSender,
  })),
}));

// ---------------------------------------------------------------------------
// Mock registerChatId from outbound — no-op is fine for unit tests
// ---------------------------------------------------------------------------

vi.mock("../channel/telegram/outbound.js", () => ({
  registerChatId: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock missionService — controls what the DB "returns"
// ---------------------------------------------------------------------------

const mockMissionGetById = vi.fn();
const mockMissionList = vi.fn();
const mockMissionCreate = vi.fn();

vi.mock("../services/missions.js", () => ({
  missionService: (_db: unknown) => ({
    getById: mockMissionGetById,
    list: mockMissionList,
    create: mockMissionCreate,
  }),
}));

// ---------------------------------------------------------------------------
// Mock issueService and approvalService (not exercised in these tests)
// ---------------------------------------------------------------------------

vi.mock("../services/issues.js", () => ({
  issueService: (_db: unknown) => ({
    getById: vi.fn().mockResolvedValue(null),
    getByIdentifier: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(null),
  }),
}));

vi.mock("../services/approvals.js", () => ({
  approvalService: (_db: unknown) => ({
    getById: vi.fn().mockResolvedValue(null),
    approve: vi.fn().mockResolvedValue(null),
  }),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { buildTelegramHandler } from "../channel/telegram/commands.js";
import type { TelegramMessage } from "../channel/telegram/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COMPANY_ID = "test-company-id";
const CHAT_ID = 12345;
const CONTEXT = { companyId: COMPANY_ID, botJwt: "test-jwt" };

/** Build a fake TelegramMessage for a command string like "/mission abc-123" */
function makeMessage(text: string): TelegramMessage {
  return {
    message_id: 1,
    chat: { id: CHAT_ID, type: "private" },
    date: Math.floor(Date.now() / 1000),
    text,
    command: text.split(" ")[0],
  };
}

/** Stub Db — commands only use it when passed through to missionService/agentSelect */
const stubDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn().mockResolvedValue([]),
} as unknown as import("@paperclipai/db").Db;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildTelegramHandler — /mission", () => {
  let handler: ReturnType<typeof buildTelegramHandler>;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = buildTelegramHandler(stubDb, COMPANY_ID);
  });

  it("sends mission title and status when mission is found by ID", async () => {
    const fakeMission = {
      id: "mission-uuid-001",
      title: "Alpha Strike",
      status: "active",
      ownerAgentId: "agent-uuid-001",
      startedAt: new Date("2026-01-01T00:00:00Z"),
      completedAt: null,
      agents: [],
    };

    mockMissionGetById.mockResolvedValueOnce(fakeMission);

    // Also stub DB issues select to return empty (no issue count needed)
    const dbWithIssues = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    } as unknown as import("@paperclipai/db").Db;

    const h = buildTelegramHandler(dbWithIssues, COMPANY_ID);
    await h(makeMessage("/mission mission-uuid-001"), CONTEXT);

    expect(mockSender).toHaveBeenCalledOnce();
    const [calledChatId, calledText] = mockSender.mock.calls[0];
    expect(calledChatId).toBe(CHAT_ID);
    expect(calledText).toContain("Alpha Strike");
    expect(calledText).toContain("active");
  });

  it("sends error when mission ID is not found", async () => {
    mockMissionGetById.mockResolvedValueOnce(null);
    mockMissionList.mockResolvedValueOnce([]); // fallback list also empty

    await handler(makeMessage("/mission nonexistent-id"), CONTEXT);

    expect(mockSender).toHaveBeenCalledOnce();
    const [, text] = mockSender.mock.calls[0];
    expect(text).toMatch(/not found/i);
    expect(text).toContain("nonexistent-id");
  });

  it("sends usage error when /mission has no args", async () => {
    await handler(makeMessage("/mission"), CONTEXT);

    expect(mockSender).toHaveBeenCalledOnce();
    const [, text] = mockSender.mock.calls[0];
    expect(text).toMatch(/usage/i);
  });

  it("sends success message when /mission create <title> succeeds", async () => {
    const createdMission = {
      id: "new-mission-uuid",
      title: "Test Mission",
      status: "planning",
      ownerAgentId: "agent-001",
      startedAt: null,
      completedAt: null,
      agents: [],
    };

    // Stub the DB select for agents lookup (returns a first agent)
    const dbWithAgent = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ id: "agent-001" }]),
    } as unknown as import("@paperclipai/db").Db;

    mockMissionCreate.mockResolvedValueOnce(createdMission);

    const h = buildTelegramHandler(dbWithAgent, COMPANY_ID);
    await h(makeMessage("/mission create Test Mission"), CONTEXT);

    expect(mockMissionCreate).toHaveBeenCalledOnce();
    expect(mockMissionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Test Mission",
        companyId: COMPANY_ID,
      }),
    );

    expect(mockSender).toHaveBeenCalledOnce();
    const [, text] = mockSender.mock.calls[0];
    // formatMissionCreated outputs "Mission Created" and the title
    expect(text).toMatch(/mission created/i);
    expect(text).toContain("Test Mission");
  });

  it("sends error when /mission create has no title", async () => {
    await handler(makeMessage("/mission create"), CONTEXT);

    expect(mockSender).toHaveBeenCalledOnce();
    const [, text] = mockSender.mock.calls[0];
    expect(text).toMatch(/usage/i);
  });

  it("sends error when /mission create but no agents exist in company", async () => {
    // DB returns no agents
    const dbNoAgent = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    } as unknown as import("@paperclipai/db").Db;

    const h = buildTelegramHandler(dbNoAgent, COMPANY_ID);
    await h(makeMessage("/mission create My Mission"), CONTEXT);

    expect(mockSender).toHaveBeenCalledOnce();
    const [, text] = mockSender.mock.calls[0];
    expect(text).toMatch(/no agents/i);
  });
});

describe("buildTelegramHandler — unknown command", () => {
  it("sends error for unknown command", async () => {
    vi.clearAllMocks();
    const handler = buildTelegramHandler(stubDb, COMPANY_ID);
    await handler(makeMessage("/foobar"), CONTEXT);

    expect(mockSender).toHaveBeenCalledOnce();
    const [, text] = mockSender.mock.calls[0];
    expect(text).toMatch(/unknown command/i);
  });
});

describe("buildTelegramHandler — no sender registered", () => {
  it("returns early when no sender found for company", async () => {
    vi.clearAllMocks();

    // Override registry to return null sender
    const { getChannelRegistry } = await import("../channel/index.js");
    vi.mocked(getChannelRegistry).mockReturnValueOnce({
      getTelegramSender: () => null,
    } as unknown as ReturnType<typeof getChannelRegistry>);

    const handler = buildTelegramHandler(stubDb, COMPANY_ID);
    await handler(makeMessage("/mission some-id"), CONTEXT);

    expect(mockSender).not.toHaveBeenCalled();
  });
});

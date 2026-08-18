/**
 * Telegram chatId persistence — restart-survival of the outbound chat map.
 *
 * Covers:
 *   - persistChatId: write-on-change, skip-same, no-row no-op, merge into existing configJson
 *   - initOutboundNotifier: hydrates the in-memory map from channel_configs.configJson.telegramChatId
 *   - buildTelegramHandler: inbound message persists the chatId (not just in-memory register)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@paperclipai/db", () => ({
  channelConfigs: {},
  heartbeatRuns: {},
}));

vi.mock("../channel/index.js", () => ({
  getChannelRegistry: vi.fn(() => ({
    registerOutboundHandler: vi.fn(),
    getTelegramSender: vi.fn(() => vi.fn().mockResolvedValue(undefined)),
  })),
}));

vi.mock("../services/heartbeat-run-summary.js", () => ({
  summarizeHeartbeatRunResultJson: vi.fn().mockResolvedValue(null),
}));

vi.mock("../services/hermes-chat.js", () => ({
  applyRunHonestyCaveat: vi.fn((text: string) => text),
}));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: {},
}));

vi.mock("../services/issues.js", () => ({
  issueService: vi.fn(() => ({})),
}));

vi.mock("../services/approvals.js", () => ({
  approvalService: {},
}));

vi.mock("../services/missions.js", () => ({
  missionService: () => ({
    getById: vi.fn(),
    list: vi.fn(),
    create: vi.fn(),
  }),
}));

const { persistChatIdSpy } = vi.hoisted(() => ({ persistChatIdSpy: vi.fn() }));
vi.mock("../channel/telegram/outbound.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channel/telegram/outbound.js")>();
  persistChatIdSpy.mockImplementation(actual.persistChatId);
  return { ...actual, persistChatId: persistChatIdSpy };
});

import {
  getChatId,
  initOutboundNotifier,
  persistChatId,
  registerChatId,
} from "../channel/telegram/outbound.js";
import { buildTelegramHandler } from "../channel/telegram/commands.js";
import type { TelegramMessage } from "../channel/telegram/types.js";

type Thenable = { then: (resolve: (value: unknown) => void) => unknown };

function fakeSelectDb(rowsByTable: Record<string, unknown[]>) {
  const updateCalls: Array<{ set: Record<string, unknown>; where: unknown }> = [];
  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit() {
                  return {
                    then(resolve: (value: unknown) => void) {
                      resolve(rowsByTable.channelConfigs?.slice(0, 1) ?? []);
                    },
                  } satisfies Thenable;
                },
                // initOutboundNotifier uses .where(...).then (await on builder)
                then(resolve: (value: unknown) => void) {
                  resolve(rowsByTable.channelConfigs ?? []);
                },
              };
            },
          };
        },
      };
    },
    update() {
      const call = { set: {} as Record<string, unknown>, where: null as unknown };
      updateCalls.push(call);
      return {
        set(values: Record<string, unknown>) {
          call.set = values;
          return {
            where(_condition: unknown) {
              call.where = _condition;
              return {
                then(resolve: (value: unknown) => void) {
                  resolve([]);
                },
              };
            },
          };
        },
      };
    },
  };
  return { db, updateCalls };
}

describe("telegram chatId persistence", () => {
  beforeEach(() => {
    // in-memory map 재초기화 영향 제거: 고유 companyId 사용
  });

  it("persistChatId writes the chatId into channel config only on change", async () => {
    const companyId = `c-${Math.random().toString(36).slice(2)}`;
    const { db, updateCalls } = fakeSelectDb({
      channelConfigs: [{ configJson: { botUsername: "ga bot", botTokenSecretId: "sec" } }],
    });

    await persistChatId(db as never, companyId, 424242);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.set.configJson).toEqual({
      botUsername: "ga bot",
      botTokenSecretId: "sec",
      telegramChatId: 424242,
    });

    // 같은 chatId 로는 다시 쓰지 않는다.
    const again = fakeSelectDb({
      channelConfigs: [{ configJson: { botUsername: "ga bot", telegramChatId: 424242 } }],
    });
    await persistChatId(again.db as never, companyId, 424242);
    expect(again.updateCalls).toHaveLength(0);
  });

  it("persistChatId is a no-op when no channel config row exists", async () => {
    const { db, updateCalls } = fakeSelectDb({ channelConfigs: [] });
    await persistChatId(db as never, "no-config-company", 1);
    expect(updateCalls).toHaveLength(0);
  });

  it("initOutboundNotifier restores persisted chatIds without overwriting live registrations", async () => {
    const liveCompanyId = `live-${Math.random().toString(36).slice(2)}`;
    const restoredCompanyId = `restore-${Math.random().toString(36).slice(2)}`;
    // 재시작 시나리오: live 등록은 없고 복원 대상만 저장되어 있다.
    registerChatId(liveCompanyId, 999);

    const rows = [
      { companyId: liveCompanyId, enabled: true, configJson: { telegramChatId: 111 } },
      { companyId: restoredCompanyId, enabled: true, configJson: { telegramChatId: 42 } },
      { companyId: "disabled-co", enabled: false, configJson: { telegramChatId: 7 } },
    ];
    const { db } = fakeSelectDb({ channelConfigs: rows });

    await initOutboundNotifier(db as never);

    expect(getChatId(restoredCompanyId)).toBe(42);
    // 이미 인메모리에 있는 live 값은 덮지 않는다.
    expect(getChatId(liveCompanyId)).toBe(999);
    // disabled 행은 복원하지 않는다.
    expect(getChatId("disabled-co")).toBeUndefined();
  });

  it("inbound telegram messages persist the chatId for restart survival", async () => {
    const companyId = `inbound-${Math.random().toString(36).slice(2)}`;
    const chatId = Math.floor(Math.random() * 100000) + 1000;
    const { db } = fakeSelectDb({ channelConfigs: [{ configJson: { botUsername: "b" } }] });
    const handler = buildTelegramHandler(db as never, companyId);
    const message: TelegramMessage = {
      message_id: 1,
      chat: { id: chatId, type: "private" },
      date: Math.floor(Date.now() / 1000),
      text: "/help",
      command: "/help",
    };

    await handler(message, { companyId, botJwt: "jwt" });

    expect(persistChatIdSpy).toHaveBeenCalledWith(db, companyId, chatId);
  });
});

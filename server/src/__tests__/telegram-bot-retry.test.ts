import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramBot } from "../channel/telegram/bot.js";

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    resolveSecretValue: async () => "test-bot-token",
  }),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeBot(): TelegramBot {
  return new TelegramBot({} as never, {
    companyId: "company-1",
    botTokenSecretId: "secret-1",
    botUsername: "test_bot",
  });
}

describe("TelegramBot sendMessage retry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries transient network failures and delivers the message", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { message_id: 1 } }));
    vi.stubGlobal("fetch", fetchMock);

    const bot = makeBot();
    await expect(bot.sendMessage(12345, "hello")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("surfaces the error after exhausting retry attempts", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    const bot = makeBot();
    await expect(bot.sendMessage(12345, "hello")).rejects.toThrow(/network error/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry client (4xx) API errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: false, description: "Bad Request: chat not found" }, 400));
    vi.stubGlobal("fetch", fetchMock);

    const bot = makeBot();
    await expect(bot.sendMessage(12345, "hello")).rejects.toThrow(/chat not found/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries server (5xx) API errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: false, description: "Internal Server Error" }, 500))
      .mockResolvedValueOnce(jsonResponse({ ok: false, description: "Internal Server Error" }, 500))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { message_id: 1 } }));
    vi.stubGlobal("fetch", fetchMock);

    const bot = makeBot();
    await expect(bot.sendMessage(12345, "hello")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries rate-limited (429) responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: false, description: "Too Many Requests: retry after 1" }, 429))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { message_id: 1 } }));
    vi.stubGlobal("fetch", fetchMock);

    const bot = makeBot();
    await expect(bot.sendMessage(12345, "hello")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a non-JSON 5xx response as retryable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { message_id: 1 } }));
    vi.stubGlobal("fetch", fetchMock);

    const bot = makeBot();
    await expect(bot.sendMessage(12345, "hello")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

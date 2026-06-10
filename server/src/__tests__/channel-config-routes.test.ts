import { afterEach, describe, expect, it, vi } from "vitest";
import { validateTelegramBotConnection } from "../routes/channel-config.js";

describe("Telegram channel connection validation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("validates a bot token with Telegram getMe", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        ok: true,
        result: { username: "inflo_research_bot", first_name: "Inflo Research" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await validateTelegramBotConnection({
      botToken: "8991408179:token",
      botUsername: "inflo_research_bot",
    });

    expect(result).toEqual({ ok: true, botUsername: "inflo_research_bot" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bot8991408179:token/getMe",
      { method: "POST" },
    );
  });

  it("reports when the saved username does not match the token owner", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => ({
        ok: true,
        result: { username: "other_bot" },
      }),
    }));

    const result = await validateTelegramBotConnection({
      botToken: "8991408179:token",
      botUsername: "inflo_research_bot",
    });

    expect(result).toEqual({
      ok: false,
      botUsername: "other_bot",
      error: "Bot username mismatch: token belongs to @other_bot",
    });
  });

  it("surfaces Telegram API errors without exposing the token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => ({
        ok: false,
        description: "Unauthorized",
      }),
    }));

    const result = await validateTelegramBotConnection({
      botToken: "8991408179:bad-token",
      botUsername: "inflo_research_bot",
    });

    expect(result).toEqual({ ok: false, error: "Unauthorized" });
  });
});

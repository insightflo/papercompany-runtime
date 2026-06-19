import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverOpenCodeModelsCached,
  ensureOpenCodeModelConfiguredAndAvailable,
  isRetryableDiscoveryError,
  listOpenCodeModels,
  resetOpenCodeModelsCacheForTests,
  resetOpenCodeModelsDiscoveryForTests,
  seedOpenCodeModelsCacheForTests,
  setOpenCodeModelsDiscoveryForTests,
  withRetry,
} from "./models.js";

// cache key(seed/lookup 양쪽에 동일 전달 → env 타이밍에 무관하게 key 일치) + discovery 실패 유발.
const BAD_COMMAND = "__paperclip_missing_opencode_command__";

describe("openCode models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    resetOpenCodeModelsCacheForTests();
    resetOpenCodeModelsDiscoveryForTests();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(listOpenCodeModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openai/gpt-5",
      }),
    ).rejects.toThrow("Failed to start command");
  });

  it("returns fresh cached models without running discovery", async () => {
    const seeded = [{ id: "openai/gpt-5", label: "openai/gpt-5" }];
    seedOpenCodeModelsCacheForTests({ command: BAD_COMMAND }, seeded, 30_000); // fresh (+30s)
    await expect(discoverOpenCodeModelsCached({ command: BAD_COMMAND })).resolves.toEqual(seeded);
  });

  it("serves stale cached models when fresh discovery fails", async () => {
    const seeded = [{ id: "openai/gpt-5", label: "openai/gpt-5" }];
    seedOpenCodeModelsCacheForTests({ command: BAD_COMMAND }, seeded, -30_000); // expired 30s ago, within retention
    await expect(discoverOpenCodeModelsCached({ command: BAD_COMMAND })).resolves.toEqual(seeded);
  });

  it("rejects when discovery fails and no stale cache exists", async () => {
    resetOpenCodeModelsCacheForTests();
    await expect(discoverOpenCodeModelsCached({ command: BAD_COMMAND })).rejects.toThrow(
      "Failed to start command",
    );
  });

  it("checks configured-model availability against stale cache when fresh discovery fails", async () => {
    const seeded = [{ id: "openai/gpt-5", label: "openai/gpt-5" }];
    seedOpenCodeModelsCacheForTests({ command: BAD_COMMAND }, seeded, -30_000); // stale
    // configured model is present in stale list → availability OK against stale (warns, but returns models)
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "openai/gpt-5", command: BAD_COMMAND }),
    ).resolves.toEqual(seeded);
  });

  it("still rejects an unavailable configured model even when using stale cache", async () => {
    const seeded = [{ id: "openai/gpt-5", label: "openai/gpt-5" }];
    seedOpenCodeModelsCacheForTests({ command: BAD_COMMAND }, seeded, -30_000); // stale
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "anthropic/claude-5", command: BAD_COMMAND }),
    ).rejects.toThrow("Configured OpenCode model is unavailable");
  });

  it("does not retry discovery when a usable stale cache exists (1 attempt)", async () => {
    const seeded = [{ id: "openai/gpt-5", label: "openai/gpt-5" }];
    seedOpenCodeModelsCacheForTests({ command: BAD_COMMAND }, seeded, -30_000); // stale
    let calls = 0;
    setOpenCodeModelsDiscoveryForTests(async () => {
      calls += 1;
      throw new Error("`opencode models` failed: boom"); // retryable
    });
    await expect(discoverOpenCodeModelsCached({ command: BAD_COMMAND })).resolves.toEqual(seeded);
    expect(calls).toBe(1);
  });

  it("retries discovery up to max attempts when no stale cache exists", async () => {
    let calls = 0;
    setOpenCodeModelsDiscoveryForTests(async () => {
      calls += 1;
      throw new Error("`opencode models` failed: boom"); // retryable
    });
    await expect(discoverOpenCodeModelsCached({ command: BAD_COMMAND })).rejects.toThrow("boom");
    expect(calls).toBe(2); // MODELS_DISCOVERY_MAX_ATTEMPTS
  });

  it("sanitizes PATH out of the stale-serve warning reason", async () => {
    const seeded = [{ id: "openai/gpt-5", label: "openai/gpt-5" }];
    seedOpenCodeModelsCacheForTests({ command: BAD_COMMAND }, seeded, -30_000); // stale
    const verbosePath = "/Users/kwak/.local/bin:/usr/bin:/bin";
    setOpenCodeModelsDiscoveryForTests(async () => {
      throw new Error(
        `Failed to start command "${BAD_COMMAND}" in "/cwd". Verify adapter command, working directory, and PATH (${verbosePath}).`,
      );
    });
    const warns: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warns.push(args.join(" "));
    });
    try {
      await discoverOpenCodeModelsCached({ command: BAD_COMMAND });
      const staleWarn = warns.find((w) => w.includes("STALE cached models")) ?? "";
      expect(staleWarn).toContain("reason="); // 핵심 reason 남음
      expect(staleWarn).not.toContain(verbosePath); // PATH 전체 제거
      expect(staleWarn).not.toContain("/Users/kwak"); // PATH 잔여 없음
    } finally {
      spy.mockRestore();
    }
  });
});

describe("openCode models withRetry", () => {
  it("returns on first success without retrying", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        return "ok";
      },
      3,
      10,
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries a retryable failure then succeeds", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("`opencode models` failed: boom");
        return "ok";
      },
      3,
      10,
      isRetryableDiscoveryError,
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("does not retry a non-retryable (start) failure", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error("Failed to start command");
        },
        3,
        10,
        isRetryableDiscoveryError,
      ),
    ).rejects.toThrow("Failed to start command");
    expect(calls).toBe(1);
  });

  it("throws the last error when all retryable attempts fail", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error("`opencode models` failed: x");
        },
        2,
        10,
        isRetryableDiscoveryError,
      ),
    ).rejects.toThrow("x");
    expect(calls).toBe(2);
  });
});

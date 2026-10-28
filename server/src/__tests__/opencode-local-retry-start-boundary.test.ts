import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

const child = vi.hoisted(() => ({ queue: [] as unknown[], actualStarts: 0 }));

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  const boundary = await import("../../../packages/adapter-utils/src/child-process-start-boundary.js");
  return {
    ...actual,
    ...boundary,
    readPaperclipRuntimeSkillEntries: vi.fn(async () => []),
    resolvePaperclipDesiredSkillNames: vi.fn(() => []),
    removeMaintainerOnlySkillSymlinks: vi.fn(async () => []),
    ensurePaperclipSkillSymlink: vi.fn(async () => {}),
    runChildProcess: vi.fn(async () => {
      const next = child.queue.shift();
      if (next === "block") {
        throw new boundary.ChildProcessStartRejectedError({
          kind: "additional_start_blocked",
          reasonCode: "runtime_shutting_down",
          externalStarted: true,
        });
      }
      if (next instanceof Error) throw next;
      child.actualStarts += 1;
      return next as RunProcessResult;
    }),
  };
});

vi.mock("../../../packages/adapters/opencode-local/src/server/models.js", () => ({
  ensureOpenCodeModelConfiguredAndAvailable: vi.fn(async () => {}),
}));

import { execute } from "../../../packages/adapters/opencode-local/src/server/execute.js";

function processResult(events: Record<string, unknown>[], exitCode = 0): RunProcessResult {
  return {
    exitCode,
    signal: null,
    timedOut: false,
    stdout: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    stderr: "",
    pid: 201,
    startedAt: "2026-10-28T00:00:00.000Z",
  };
}

const overloaded = processResult([
  {
    type: "step_finish",
    sessionID: "overload-session",
    part: { tokens: { input: 13, output: 8, reasoning: 2, cache: { read: 4 } }, cost: 0.03 },
  },
  { type: "error", sessionID: "overload-session", error: { message: "provider status 529 overloaded" } },
]);

const staleSession = processResult([
  { type: "error", error: { message: "Unknown session stale-session" } },
], 1);

function executeOpenCode(runtimeSessionId: string | null, config: Record<string, unknown> = {}) {
  return execute({
    runId: "opencode-boundary-run",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "OpenCode",
      adapterType: "opencode_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: runtimeSessionId,
      sessionParams: runtimeSessionId ? { sessionId: runtimeSessionId, cwd: os.tmpdir() } : null,
      sessionDisplayId: runtimeSessionId,
      taskKey: null,
    },
    config: {
      command: process.execPath,
      cwd: os.tmpdir(),
      promptTemplate: "Continue.",
      model: "test/model",
      overloadBackoffMs: 0,
      ...config,
    },
    context: {},
    onLog: async () => {},
  });
}

describe("opencode retry child-start boundary", () => {
  beforeEach(() => {
    child.queue = [];
    child.actualStarts = 0;
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  it("returns the last overload result when shutdown blocks its retry", async () => {
    child.queue.push(overloaded, "block");
    const result = await executeOpenCode(null, { maxOverloadRetries: 1 });

    expect(child.actualStarts).toBe(1);
    expect(result).toMatchObject({
      errorMessage: "provider status 529 overloaded",
      sessionId: "overload-session",
      usage: { inputTokens: 13, outputTokens: 10, cachedInputTokens: 4 },
    });
  });

  it("returns the initial result when shutdown blocks fresh fallback", async () => {
    child.queue.push(staleSession, "block");
    const result = await executeOpenCode("stale-session", { maxOverloadRetries: 0 });

    expect(child.actualStarts).toBe(1);
    expect(result).toMatchObject({
      errorMessage: "Unknown session stale-session",
      sessionId: null,
      clearSession: true,
    });
  });

  it("does not swallow a genuine retry failure", async () => {
    child.queue.push(overloaded, new Error("real opencode spawn failure"));
    await expect(executeOpenCode(null, { maxOverloadRetries: 1 })).rejects.toThrow("real opencode spawn failure");
    expect(child.actualStarts).toBe(1);
  });
});

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

import { execute } from "../../../packages/adapters/claude-local/src/server/execute.js";

function processResult(events: Record<string, unknown>[]): RunProcessResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    stderr: "",
    pid: 101,
    startedAt: "2026-10-28T00:00:00.000Z",
  };
}

const overloaded = processResult([
  { type: "system", subtype: "init", session_id: "overload-session", model: "claude-test" },
  {
    type: "result",
    subtype: "success",
    session_id: "overload-session",
    is_error: true,
    api_error_status: 529,
    result: "API Error: 529 overloaded",
    usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3 },
    total_cost_usd: 0.02,
  },
]);

const staleSession = {
  ...processResult([
  { type: "system", subtype: "init", session_id: "stale-session", model: "claude-test" },
  {
    type: "result",
    subtype: "error_during_execution",
    session_id: "stale-session",
    is_error: true,
    result: "No conversation found with session ID stale-session",
    usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 2 },
  },
  ]),
  exitCode: 1,
};

function executeClaude(runtimeSessionId: string | null, config: Record<string, unknown> = {}) {
  return execute({
    runId: "claude-boundary-run",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude",
      adapterType: "claude_local",
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
      overloadBackoffMs: 0,
      ...config,
    },
    context: {},
    onLog: async () => {},
  });
}

describe("claude retry child-start boundary", () => {
  beforeEach(() => {
    child.queue = [];
    child.actualStarts = 0;
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  it("returns the last overload result when shutdown blocks its retry", async () => {
    child.queue.push(overloaded, "block");
    const result = await executeClaude(null, { maxOverloadRetries: 1 });

    expect(child.actualStarts).toBe(1);
    expect(child.queue).toHaveLength(0);
    expect(result).toMatchObject({
      errorCode: "claude_api_error_529",
      sessionId: "overload-session",
      usage: { inputTokens: 11, outputTokens: 7, cachedInputTokens: 3 },
      summary: "API Error: 529 overloaded",
    });
  });

  it("returns the stale-session result when shutdown blocks fresh fallback", async () => {
    child.queue.push(staleSession, "block");
    const result = await executeClaude("stale-session", { maxOverloadRetries: 0 });

    expect(child.actualStarts).toBe(1);
    expect(result).toMatchObject({
      errorCode: "claude_result_error",
      sessionId: null,
      clearSession: true,
      usage: { inputTokens: 5, outputTokens: 1, cachedInputTokens: 2 },
    });
    expect(result.errorMessage).toContain("No conversation found");
  });

  it("does not swallow a genuine retry failure", async () => {
    child.queue.push(overloaded, new Error("real spawn failure"));
    await expect(executeClaude(null, { maxOverloadRetries: 1 })).rejects.toThrow("real spawn failure");
    expect(child.actualStarts).toBe(1);
  });
});

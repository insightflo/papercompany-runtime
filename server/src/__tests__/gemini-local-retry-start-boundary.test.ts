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

import { execute } from "../../../packages/adapters/gemini-local/src/server/execute.js";

function processResult(
  events: Record<string, unknown>[],
  overrides: Partial<RunProcessResult> = {},
): RunProcessResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    stderr: "",
    pid: 101,
    startedAt: "2026-10-28T00:00:00.000Z",
    ...overrides,
  };
}

const staleSession = processResult(
  [
    {
      type: "assistant",
      session_id: "stale-gemini",
      message: { content: [{ type: "output_text", text: "last real Gemini result" }] },
    },
    {
      type: "result",
      session_id: "stale-gemini",
      subtype: "error",
      is_error: true,
      error: "session stale-gemini not found",
      usage: { input_tokens: 19, cached_input_tokens: 7, output_tokens: 11 },
      total_cost_usd: 0.05,
    },
  ],
  { exitCode: 1, stderr: "session stale-gemini not found" },
);

const freshResult = processResult([
  {
    type: "assistant",
    session_id: "fresh-gemini",
    message: { content: [{ type: "output_text", text: "fresh result" }] },
  },
  {
    type: "result",
    session_id: "fresh-gemini",
    subtype: "success",
    usage: { input_tokens: 2, cached_input_tokens: 1, output_tokens: 3 },
  },
]);

function executeGemini() {
  return execute({
    runId: "gemini-boundary-run",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Gemini",
      adapterType: "gemini_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: "stale-gemini",
      sessionParams: { sessionId: "stale-gemini", cwd: os.tmpdir() },
      sessionDisplayId: "stale-gemini",
      taskKey: null,
    },
    config: {
      command: process.execPath,
      cwd: os.tmpdir(),
      promptTemplate: "Continue.",
    },
    context: {},
    onLog: async () => {},
  });
}

describe("gemini retry child-start boundary", () => {
  beforeEach(() => {
    child.queue = [];
    child.actualStarts = 0;
  });

  it("preserves the initial result and clears the stale session when fresh retry is blocked", async () => {
    child.queue.push(staleSession, "block");
    const result = await executeGemini();

    expect(child.actualStarts).toBe(1);
    expect(child.queue).toHaveLength(0);
    expect(result).toMatchObject({
      exitCode: 1,
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      clearSession: true,
      usage: { inputTokens: 19, cachedInputTokens: 7, outputTokens: 11 },
      summary: "last real Gemini result",
      costUsd: 0.05,
    });
  });

  it("keeps retry session semantics when the fresh attempt starts", async () => {
    child.queue.push(staleSession, freshResult);
    const result = await executeGemini();

    expect(child.actualStarts).toBe(2);
    expect(result).toMatchObject({
      exitCode: 0,
      sessionId: "fresh-gemini",
      clearSession: false,
      usage: { inputTokens: 2, cachedInputTokens: 1, outputTokens: 3 },
      summary: "fresh result",
    });
  });

  it("does not swallow a genuine fresh-session failure", async () => {
    child.queue.push(staleSession, new Error("real spawn failure"));
    await expect(executeGemini()).rejects.toThrow("real spawn failure");
    expect(child.actualStarts).toBe(1);
  });
});

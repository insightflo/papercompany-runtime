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

import { execute } from "../../../packages/adapters/cursor-local/src/server/execute.js";

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
    { type: "assistant", session_id: "stale-cursor", message: { text: "last real Cursor result" } },
    {
      type: "result",
      session_id: "stale-cursor",
      usage: { input_tokens: 17, cached_input_tokens: 6, output_tokens: 9 },
      total_cost_usd: 0.04,
    },
  ],
  { exitCode: 1, stderr: "session stale-cursor not found" },
);

const freshResult = processResult([
  { type: "assistant", session_id: "fresh-cursor", message: { text: "fresh result" } },
  {
    type: "result",
    session_id: "fresh-cursor",
    usage: { input_tokens: 2, cached_input_tokens: 1, output_tokens: 3 },
  },
]);

function executeCursor() {
  return execute({
    runId: "cursor-boundary-run",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Cursor",
      adapterType: "cursor_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: "stale-cursor",
      sessionParams: { sessionId: "stale-cursor", cwd: os.tmpdir() },
      sessionDisplayId: "stale-cursor",
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

describe("cursor retry child-start boundary", () => {
  beforeEach(() => {
    child.queue = [];
    child.actualStarts = 0;
  });

  it("preserves the initial result and clears the stale session when fresh retry is blocked", async () => {
    child.queue.push(staleSession, "block");

    const result = await executeCursor();

    expect(child.actualStarts).toBe(1);
    expect(child.queue).toHaveLength(0);
    expect(result).toMatchObject({
      exitCode: 1,
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      clearSession: true,
      usage: { inputTokens: 17, cachedInputTokens: 6, outputTokens: 9 },
      summary: "last real Cursor result",
      costUsd: 0.04,
    });
  });

  it("keeps the existing successful fresh-session retry behavior", async () => {
    child.queue.push(staleSession, freshResult);

    const result = await executeCursor();

    expect(child.actualStarts).toBe(2);
    expect(result).toMatchObject({
      exitCode: 0,
      sessionId: "fresh-cursor",
      clearSession: false,
      usage: { inputTokens: 2, cachedInputTokens: 1, outputTokens: 3 },
      summary: "fresh result",
    });
  });

  it("does not swallow a genuine fresh-session failure", async () => {
    child.queue.push(staleSession, new Error("real spawn failure"));

    await expect(executeCursor()).rejects.toThrow("real spawn failure");
    expect(child.actualStarts).toBe(1);
  });
});

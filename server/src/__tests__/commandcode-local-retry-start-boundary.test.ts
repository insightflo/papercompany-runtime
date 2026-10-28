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

import { execute } from "../../../packages/adapters/commandcode-local/src/server/execute.js";

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
      type: "result",
      subtype: "error",
      sessionId: "stale-commandcode",
      finalText: "last real Command Code result",
      usage: { inputTokens: 19, outputTokens: 7, cacheReadTokens: 4 },
      error: "unknown session stale-commandcode",
    },
  ],
  { exitCode: 1 },
);

const freshResult = processResult([
  {
    type: "result",
    subtype: "success",
    sessionId: "fresh-commandcode",
    finalText: "fresh result",
    usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 1 },
  },
]);

function executeCommandCode() {
  return execute({
    runId: "commandcode-boundary-run",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Command Code",
      adapterType: "commandcode_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: "stale-commandcode",
      sessionParams: { sessionId: "stale-commandcode", cwd: os.tmpdir() },
      sessionDisplayId: "stale-commandcode",
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

describe("commandcode retry child-start boundary", () => {
  beforeEach(() => {
    child.queue = [];
    child.actualStarts = 0;
  });

  it("preserves the initial result and clears the stale session when fresh retry is blocked", async () => {
    child.queue.push(staleSession, "block");

    const result = await executeCommandCode();

    expect(child.actualStarts).toBe(1);
    expect(child.queue).toHaveLength(0);
    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: null,
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      clearSession: true,
      usage: { inputTokens: 19, outputTokens: 7, cachedInputTokens: 4 },
      summary: "last real Command Code result",
    });
    expect(result.resultJson).toMatchObject({ stdout: expect.stringContaining("last real Command Code result") });
  });

  it("keeps the existing successful fresh-session retry behavior", async () => {
    child.queue.push(staleSession, freshResult);

    const result = await executeCommandCode();

    expect(child.actualStarts).toBe(2);
    expect(result).toMatchObject({
      exitCode: 0,
      sessionId: "fresh-commandcode",
      clearSession: false,
      usage: { inputTokens: 2, outputTokens: 3, cachedInputTokens: 1 },
      summary: "fresh result",
    });
  });

  it("does not swallow a genuine fresh-session failure", async () => {
    child.queue.push(staleSession, new Error("real spawn failure"));

    await expect(executeCommandCode()).rejects.toThrow("real spawn failure");
    expect(child.actualStarts).toBe(1);
  });
});

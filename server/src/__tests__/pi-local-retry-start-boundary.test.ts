import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

const child = vi.hoisted(() => ({ queue: [] as unknown[], executionStarts: 0 }));
const polling = vi.hoisted(() => ({ starts: 0, stops: 0 }));

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  const boundary = await import("../../../packages/adapter-utils/src/child-process-start-boundary.js");
  return {
    ...actual,
    ...boundary,
    runChildProcess: vi.fn(async (_runId: string, _command: string, args: string[]) => {
      if (args.includes("--list-models")) {
        return processResult("provider  model\ntest      model\n");
      }
      const next = child.queue.shift();
      if (next === "block") {
        throw new boundary.ChildProcessStartRejectedError({
          kind: "additional_start_blocked",
          reasonCode: "runtime_shutting_down",
          externalStarted: true,
        });
      }
      if (next instanceof Error) throw next;
      child.executionStarts += 1;
      return next as RunProcessResult;
    }),
  };
});

vi.mock("../../../packages/adapters/pi-local/src/server/operator-interrupt.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../packages/adapters/pi-local/src/server/operator-interrupt.js")
  >();
  return {
    ...actual,
    startOperatorInterruptPolling: vi.fn(() => {
      polling.starts += 1;
      return { stop: () => { polling.stops += 1; } };
    }),
  };
});

import { execute } from "../../../packages/adapters/pi-local/src/server/execute.js";
import { resetPiModelsCacheForTests } from "../../../packages/adapters/pi-local/src/server/models.js";

function processResult(
  stdout: string,
  overrides: Partial<RunProcessResult> = {},
): RunProcessResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr: "",
    pid: 101,
    startedAt: "2026-10-28T00:00:00.000Z",
    ...overrides,
  };
}

function piOutput(message: string, usage: { input: number; output: number; cacheRead: number }): string {
  return `${JSON.stringify({
    type: "turn_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: message }],
      usage: { ...usage, cost: { total: 0 } },
    },
    toolResults: [],
  })}\n`;
}

const staleSession = processResult(
  piOutput("last real Pi result", { input: 23, output: 9, cacheRead: 5 }),
  { exitCode: 1, stderr: "unknown session stale-pi-session" },
);
const freshResult = processResult(piOutput("fresh Pi result", { input: 2, output: 3, cacheRead: 1 }));

let roots: string[] = [];

async function executePi() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-retry-boundary-"));
  roots.push(root);
  const cwd = path.join(root, "workspace");
  const home = path.join(root, "home");
  const stalePath = path.join(home, ".pi", "paperclips", "stale.jsonl");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(path.dirname(stalePath), { recursive: true });
  await fs.writeFile(stalePath, "", "utf8");
  const timingLogs: string[] = [];

  const result = await execute({
    runId: "pi-boundary-run",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Pi",
      adapterType: "pi_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: stalePath,
      sessionParams: { sessionId: stalePath, cwd },
      sessionDisplayId: stalePath,
      taskKey: null,
    },
    config: {
      command: process.execPath,
      cwd,
      model: "test/model",
      env: { HOME: home },
    },
    context: {},
    onLog: async (stream, chunk) => {
      if (stream === "stderr" && chunk.includes("pi-local-timing")) timingLogs.push(chunk);
    },
  });

  return { result, stalePath, timingLogs };
}

describe("pi retry child-start boundary", () => {
  beforeEach(() => {
    child.queue = [];
    child.executionStarts = 0;
    polling.starts = 0;
    polling.stops = 0;
    resetPiModelsCacheForTests();
  });

  afterEach(async () => {
    await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
    roots = [];
  });

  it("preserves the initial result and cleans up the blocked fresh retry", async () => {
    child.queue.push(staleSession, "block");

    const { result, timingLogs } = await executePi();

    expect(child.executionStarts).toBe(1);
    expect(child.queue).toHaveLength(0);
    expect(polling).toEqual({ starts: 2, stops: 2 });
    expect(timingLogs).toHaveLength(1);
    expect(result).toMatchObject({
      exitCode: 1,
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      clearSession: true,
      usage: { inputTokens: 23, outputTokens: 9, cachedInputTokens: 5 },
      summary: "last real Pi result",
    });
  });

  it("keeps the existing successful fresh-session retry behavior", async () => {
    child.queue.push(staleSession, freshResult);

    const { result, stalePath, timingLogs } = await executePi();

    expect(child.executionStarts).toBe(2);
    expect(polling).toEqual({ starts: 2, stops: 2 });
    expect(timingLogs).toHaveLength(1);
    expect(result).toMatchObject({
      exitCode: 0,
      clearSession: false,
      usage: { inputTokens: 2, outputTokens: 3, cachedInputTokens: 1 },
      summary: "fresh Pi result",
    });
    expect(result.sessionId).not.toBe(stalePath);
  });

  it("does not swallow a genuine fresh-session failure and still stops both pollers", async () => {
    child.queue.push(staleSession, new Error("real spawn failure"));

    await expect(executePi()).rejects.toThrow("real spawn failure");
    expect(child.executionStarts).toBe(1);
    expect(polling).toEqual({ starts: 2, stops: 2 });
  });
});

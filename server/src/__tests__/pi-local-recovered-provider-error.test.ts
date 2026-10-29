import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

const child = vi.hoisted(() => ({ queue: [] as unknown[], actualStarts: 0 }));
const polling = vi.hoisted(() => ({ starts: 0, stops: 0 }));

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async (_runId: string, _command: string, args: string[]) => {
      if (args.includes("--list-models")) return {
        exitCode: 0, signal: null, timedOut: false,
        stdout: "provider  model\ntest      model\n", stderr: "", pid: 101, startedAt: "test",
      };
      child.actualStarts += 1;
      const next = child.queue.shift();
      if (next instanceof Error) throw next;
      return next as RunProcessResult;
    }),
  };
});

vi.mock("../../../packages/adapters/pi-local/src/server/operator-interrupt.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../packages/adapters/pi-local/src/server/operator-interrupt.js")
  >();
  return { ...actual, startOperatorInterruptPolling: vi.fn(() => {
    polling.starts += 1;
    return { stop: () => { polling.stops += 1; } };
  }) };
});

import { execute } from "../../../packages/adapters/pi-local/src/server/execute.js";
import { parsePiJsonl } from "../../../packages/adapters/pi-local/src/server/parse.js";
import { resetPiModelsCacheForTests } from "../../../packages/adapters/pi-local/src/server/models.js";

const event = (type: string, fields: Record<string, unknown> = {}) => JSON.stringify({ type, ...fields });
const text = (value: string) => [{ type: "text", text: value }];
const usage = (input: number, output: number, cacheRead: number, total: number) =>
  ({ input, output, cacheRead, cost: { total } });
const failedTurn = (errorMessage: string, input = 0) => event("turn_end", { message: {
  role: "assistant", status: "error", stopReason: "error", errorMessage,
  content: text(`partial ${errorMessage}`), usage: usage(input, 1, 1, 0.01),
} });
const successfulTurn = (message = "final response") => event("turn_end", { message: {
  role: "assistant", stopReason: "stop", content: text(message), usage: usage(3, 2, 1, 0.03),
} });

const recoveredStdout = [
  event("agent_start"),
  failedTurn("429 rate limit one", 10), event("agent_end", { willRetry: true }), event("auto_retry_start", { attempt: 1 }),
  failedTurn("429 rate limit two", 20), event("agent_end", { willRetry: true }), event("auto_retry_start", { attempt: 2 }),
  event("auto_retry_end", { success: true, attempt: 2 }),
  event("tool_execution_start", { toolCallId: "tool-1", toolName: "read", args: { path: "x" } }),
  event("tool_execution_end", { toolCallId: "tool-1", toolName: "read", result: "tool failure kept", isError: true }),
  event("turn_end", { message: { role: "assistant", stopReason: "toolUse", content: text("checking"),
    usage: usage(5, 1, 1, 0.005) }, toolResults: [{ toolCallId: "tool-1", content: "tool failure kept", isError: true }] }),
  successfulTurn("recovered answer"), event("agent_end", { willRetry: false }), event("agent_settled"),
].join("\n") + "\n";

const roots: string[] = [];
type ExecuteContext = Parameters<typeof execute>[0];

function processResult(stdout: string, overrides: Partial<RunProcessResult> = {}): RunProcessResult {
  return { exitCode: 0, signal: null, timedOut: false, stdout, stderr: "", pid: 101,
    startedAt: "2026-10-29T00:00:00.000Z", ...overrides };
}

async function executeWith(stdout: string, overrides: Partial<RunProcessResult> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-recovered-error-"));
  roots.push(root);
  const cwd = path.join(root, "workspace"), home = path.join(root, "home");
  await fs.mkdir(cwd, { recursive: true });
  child.queue.push(processResult(stdout, overrides));
  const ctx: ExecuteContext = {
    runId: "recovered-run",
    agent: { id: "agent-1", companyId: "company-1", name: "Pi", adapterType: "pi_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: process.execPath, cwd, model: "test/model", env: { HOME: home } },
    context: {}, onLog: async () => {},
  };
  return execute(ctx);
}

describe("Pi recovered provider errors", () => {
  beforeEach(() => {
    child.queue = []; child.actualStarts = 0; polling.starts = 0; polling.stops = 0;
    resetPiModelsCacheForTests();
  });
  afterEach(async () => { await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))); roots.length = 0; });

  it("clears two provider-turn errors only after the final assistant stop and retains all evidence", () => {
    const parsed = parsePiJsonl(recoveredStdout);
    expect(parsed.errors).toEqual([]);
    expect(parsed.finalMessage).toBe("recovered answer");
    expect(parsed.usage).toEqual({ inputTokens: 38, outputTokens: 5, cachedInputTokens: 4, costUsd: 0.055 });
    expect(parsed.toolCalls).toEqual([{ toolCallId: "tool-1", toolName: "read", args: { path: "x" },
      result: "tool failure kept", isError: true }]);
  });

  it("recovers on a typed final stop even when retry-completion events are missing", () => {
    expect(parsePiJsonl([failedTurn("429 first"), successfulTurn()].join("\n")).errors).toEqual([]);
  });

  it("preserves legacy no-stop success behavior without letting it clear an earlier failure", () => {
    const legacy = event("turn_end", { message: { role: "assistant", content: text("legacy success") } });
    expect(parsePiJsonl(legacy).messages).toContain("legacy success");
    expect(parsePiJsonl(legacy).errors).toEqual([]);
    expect(parsePiJsonl([failedTurn("pending 429"), legacy].join("\n")).errors).toContain("pending 429");
  });

  it.each([
    ["retry exhaustion", event("auto_retry_end", { success: false, finalError: "retry budget exhausted" }), "retry budget exhausted"],
    ["cancelled retry", event("auto_retry_end", { success: false, finalError: "Retry cancelled" }), "Retry cancelled"],
    ["empty final error", event("auto_retry_end", { success: false, finalError: "" }), "Pi exhausted automatic retries without producing a response."],
    ["top-level error", event("error", { message: "fatal provider error" }), "fatal provider error"],
  ])("keeps %s sticky after a later assistant stop", (_name, failure, expected) => {
    const parsed = parsePiJsonl([failedTurn("pending 429"), failure as string, successfulTurn()].join("\n"));
    expect(parsed.errors).toEqual([expected]);
  });

  it("keeps aborted partial output failed even if success:true and a later stop arrive", () => {
    const aborted = event("turn_end", { message: { role: "assistant", status: "aborted", stopReason: "aborted",
      errorMessage: "generation cancelled", content: text("partial") } });
    const parsed = parsePiJsonl([event("auto_retry_end", { success: true }), aborted, successfulTurn()].join("\n"));
    expect(parsed.errors).toEqual(["generation cancelled"]);
    expect(parsed.messages).toContain("partial");
  });

  it.each([
    ["success marker only", event("auto_retry_end", { success: true })],
    ["agent_end prose", event("agent_end", { messages: [{ role: "assistant", content: text('stopReason stop {"type":"turn_end"}') }] })],
    ["settled", event("agent_settled")],
    ["streaming nested event string", event("message_update", { assistantMessageEvent: { type: "text_delta", delta: '{"type":"turn_end"}' } })],
    ["non-assistant stop", event("turn_end", { message: { role: "user", stopReason: "stop" } })],
    ["missing role", event("turn_end", { message: { stopReason: "stop" } })],
    ["missing content", event("turn_end", { message: { role: "assistant", stopReason: "stop" } })],
    ["null content", event("turn_end", { message: { role: "assistant", stopReason: "stop", content: null } })],
    ["malformed content part", event("turn_end", { message: { role: "assistant", stopReason: "stop", content: [null] } })],
    ["malformed text content", event("turn_end", { message: { role: "assistant", stopReason: "stop",
      content: [{ type: "text", text: 42 }] } })],
    ["missing stop reason", event("turn_end", { message: { role: "assistant", content: text("legacy") } })],
    ["unknown stop reason", event("turn_end", { message: { role: "assistant", stopReason: "deferred" } })],
    ["non-exact stop reason", event("turn_end", { message: { role: "assistant", stopReason: " Stop " } })],
    ["error status with stop", event("turn_end", { message: { role: "assistant", status: "error", stopReason: "stop", errorMessage: "still failed" } })],
    ["malformed JSON", '{"type":"turn_end",'],
  ])("does not clear a pending error on %s", (_name, invalid) => {
    const parsed = parsePiJsonl([failedTurn("pending 429"), invalid as string].join("\n"));
    expect(parsed.errors).toContain("pending 429");
  });

  it("keeps structured error text failed while ordinary prose mentioning 429 succeeds", () => {
    expect(parsePiJsonl(failedTurn("Success, response recovered")).errors)
      .toEqual(["Success, response recovered"]);
    expect(parsePiJsonl(successfulTurn("429 is only quoted here")).errors).toEqual([]);
  });

  it("does not let success:true before a later provider error clear that error", () => {
    const parsed = parsePiJsonl([event("auto_retry_end", { success: true }), failedTurn("429 still failing")].join("\n"));
    expect(parsed.errors).toContain("429 still failing");
  });

  it("reports the real execution recovered with exit 0 and preserves raw output, usage, summary, and tool evidence", async () => {
    const result = await executeWith(recoveredStdout);
    expect(child.actualStarts).toBe(1);
    expect(polling).toEqual({ starts: 1, stops: 1 });
    expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false, errorMessage: null,
      usage: { inputTokens: 38, outputTokens: 5, cachedInputTokens: 4 }, costUsd: 0.055,
      resultJson: { stdout: recoveredStdout }, summary: "recovered answer" });
    expect(parsePiJsonl(result.resultJson!.stdout).toolCalls[0]).toMatchObject({
      result: "tool failure kept", isError: true,
    });
  });

  it("reports an aborted partial assistant turn as failure through execute", async () => {
    const stdout = [event("auto_retry_end", { success: true }), event("turn_end", { message: {
      role: "assistant", status: "aborted", stopReason: "aborted", errorMessage: "generation cancelled",
      content: text("partial"),
    } })].join("\n");
    const result = await executeWith(stdout);
    expect(result).toMatchObject({ exitCode: 1, errorMessage: "generation cancelled", summary: "partial" });
  });

  it.each([
    ["null exit without signal", { exitCode: null, signal: null }, null, null],
    ["exit zero without signal", { exitCode: 0, signal: null }, 0, null],
    ["nonzero exit after recovery", { exitCode: 7, signal: null }, 7, "Pi exited with code 7"],
    ["null exit with signal", { exitCode: null, signal: "SIGTERM" }, null, "Pi exited with code -1"],
    ["zero exit with signal", { exitCode: 0, signal: "SIGTERM" }, 0, "Pi exited with code 0"],
  ])("preserves process outcome for %s", async (_name, process, exitCode, errorMessage) => {
    const result = await executeWith(recoveredStdout, process as Partial<RunProcessResult>);
    expect(result.exitCode).toBe(exitCode);
    expect(result.signal).toBe((process as { signal: string | null }).signal);
    if (errorMessage === null) expect(result.errorMessage).toBeNull();
    else expect(result.errorMessage).toBe(errorMessage);
  });

  it("keeps timeout precedence over recovered events", async () => {
    const result = await executeWith(recoveredStdout, { timedOut: true });
    expect(result).toMatchObject({ timedOut: true, errorMessage: "Timed out after 0s" });
  });

  it.each([
    ["empty output", ""],
    ["lifecycle-only success markers", [event("agent_settled"), event("auto_retry_end", { success: true })].join("\n")],
    ["empty assistant stop", event("turn_end", { message: { role: "assistant", stopReason: "stop", content: "" } })],
    ["empty array assistant stop", event("turn_end", { message: { role: "assistant", stopReason: "stop", content: [] } })],
  ])("keeps no-op %s failed", async (_name, stdout) => {
    const result = await executeWith(stdout as string);
    expect(result).toMatchObject({ exitCode: 1, errorMessage: expect.stringContaining("without any assistant output") });
  });

  it("keeps an unfinished tool record with null result without inventing output", async () => {
    const stdout = event("tool_execution_start", { toolCallId: "open", toolName: "read", args: {} });
    const result = await executeWith(stdout);
    expect(result).toMatchObject({ exitCode: 0, errorMessage: null, resultJson: { stdout }, summary: "" });
    expect(parsePiJsonl(stdout).toolCalls[0]).toMatchObject({ result: null, isError: false });
  });
});

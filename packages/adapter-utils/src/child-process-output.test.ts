import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { setImmediate as turn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChildProcessOutput } from "./child-process-output.js";
import { appendWithCap, MAX_CAPTURE_BYTES, runChildProcess, runningProcesses } from "./server-utils.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

type Options = Parameters<typeof runChildProcess>[3];
const ids = new Set<string>();
function start(script: string, options: Partial<Options> = {}) {
  const id = randomUUID();
  ids.add(id);
  const result = runChildProcess(id, process.execPath, ["-e", script], {
    cwd: process.cwd(), env: {}, timeoutSec: 5, graceSec: 1,
    onLog: async () => {}, ...options,
  });
  return { id, result };
}

afterEach(async () => {
  for (const id of ids) {
    const child = runningProcesses.get(id)?.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>((done) => child.once("close", () => done()));
      child.kill("SIGKILL");
      await closed;
    }
  }
  ids.clear();
});

function fixture(onLog: Options["onLog"], fatalOnLogError = false) {
  const stdout = new PassThrough(), stderr = new PassThrough();
  const terminate = vi.fn(), onLogError = vi.fn();
  const output = createChildProcessOutput({
    stdout, stderr, appendWithCap, onLog, onLogError, fatalOnLogError, terminate,
  });
  return { output, stdout, stderr, terminate, onLogError };
}

describe("child output delivery (C07 preservation contract)", () => {
  it("serializes observed stdout/stderr events and resumes only after the whole queue", async () => {
    const gate = deferred(), seen: string[] = [];
    const h = fixture(async (stream, text) => {
      seen.push(stream + ":" + text);
      if (text === "A") await gate.promise;
    });
    h.output.accept("stdout", Buffer.from("A"));
    h.output.accept("stderr", "B");
    h.output.accept("stdout", "C");
    expect(h.output.stdout).toBe("AC");
    expect(h.output.stderr).toBe("B");
    expect(h.stdout.isPaused()).toBe(true);
    expect(h.stderr.isPaused()).toBe(true);
    const drained = h.output.drain();
    await turn();
    expect(seen).toEqual(["stdout:A"]);
    gate.resolve();
    await drained;
    expect(seen).toEqual(["stdout:A", "stderr:B", "stdout:C"]);
    expect(h.stdout.isPaused()).toBe(false);
    expect(h.stderr.isPaused()).toBe(false);
  });

  it.each([false, true])("preserves first fatal error and nonfatal delivery (fatal=%s)", async (fatal) => {
    const onLog = vi.fn<Options["onLog"]>()
      .mockRejectedValueOnce(new Error("first failure"))
      .mockRejectedValueOnce(new Error("second failure"));
    const h = fixture(onLog, fatal);
    h.output.accept("stdout", "out");
    h.output.accept("stderr", "err");
    if (fatal) await expect(h.output.drain()).rejects.toThrow("first failure");
    else await h.output.drain();
    expect(h.onLogError.mock.calls.map((call) => call[1])).toEqual(["stdout", "stderr"]);
    expect(onLog).toHaveBeenNthCalledWith(1, "stdout", "out");
    expect(onLog).toHaveBeenNthCalledWith(2, "stderr", "err");
    expect(h.terminate).toHaveBeenCalledTimes(fatal ? 1 : 0);
    expect(h.output.stdout).toBe("out");
    expect(h.output.stderr).toBe("err");
    expect(h.stdout.isPaused()).toBe(false);
    expect(h.stderr.isPaused()).toBe(false);
  });

  // C07 adopted:50-58,68-79: volume must not kill; retain the existing tail,
  // including final Pi/Codex parser input. Earlier usage remains outside the tail.
  it("finishes a real 65MiB child with slow delivery and intact final parser records", async () => {
    const records = [
      { type: "thread.started", thread_id: "final-thread" },
      { type: "turn_end", message: { content: "pi final", usage: { input: 11, output: 7, cacheRead: 3, cost: { total: 0.25 } } } },
      { type: "agent_end", messages: [{ role: "assistant", content: "pi final" }] },
      { type: "item.completed", item: { type: "agent_message", text: "codex final" } },
      { type: "turn.completed", usage: { input_tokens: 17, cached_input_tokens: 5, output_tokens: 9 } },
      { type: "result", completed: true, items: 8 },
    ];
    const tail = "\n" + records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    const prefix = "early output outside the retained tail\n";
    const size = 65 * 1024 * 1024;
    let bytes = 0, active = 0, maxActive = 0, paused = true;
    let stderr = "";
    let id = "";
    let child: ChildProcess | undefined;
    const run = start(`
      const write = (pipe, text) => new Promise((done, fail) =>
        pipe.write(text, (err) => err ? fail(err) : done()));
      (async () => {
        await write(process.stdout, ${JSON.stringify(prefix)});
        const block = Buffer.alloc(64 * 1024, 120);
        for (let i = 0; i < 1040; i++) await write(process.stdout, block);
        await write(process.stdout, ${JSON.stringify(tail)});
        await write(process.stderr, "last stderr\\n");
        process.exitCode = 7;
      })().catch(() => { process.exitCode = 99; });
    `, {
      timeoutSec: 0,
      onLog: async (stream, text) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        child ??= runningProcesses.get(id)?.child;
        paused = paused && child?.stdout?.isPaused() === true && child?.stderr?.isPaused() === true;
        if (stream === "stdout") bytes += Buffer.byteLength(text);
        else stderr += text;
        await turn();
        active -= 1;
      },
    });
    id = run.id;
    const result = await run.result;
    expect(bytes).toBe(size + Buffer.byteLength(prefix + tail));
    expect(maxActive).toBe(1);
    expect(paused).toBe(true);
    expect(result.stdout.length).toBe(MAX_CAPTURE_BYTES);
    expect(result.stdout.endsWith(tail)).toBe(true);
    expect(result.stdout).not.toContain(prefix);
    expect(stderr).toBe("last stderr\n");
    expect(result.stderr).toBe(stderr);
    expect(result).toMatchObject({ exitCode: 7, signal: null, timedOut: false, idleTimedOut: false });
    expect(result.pid).toBeGreaterThan(0);
    expect(result.startedAt).toEqual(expect.any(String));
    expect(runningProcesses.has(id)).toBe(false);
  }, 30_000);

  it("keeps stdin open for injection and releases it from an output callback", async () => {
    const release = deferred();
    let injected = false;
    const run = start(`
      let text = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (part) => { text += part; });
      process.stdin.on("end", () => process.stdout.write("input=" + text));
      process.stdout.write("ready\\n");
    `, {
      stdin: "initial/", stdinRelease: release.promise,
      stdinOnReady: (write) => { injected = write("injected"); },
      onLog: async (stream, text) => {
        if (stream === "stdout" && text.includes("ready")) release.resolve();
      },
    });
    const result = await run.result;
    expect(injected).toBe(true);
    expect(result.stdout).toBe("ready\ninput=initial/injected");
    expect(result.exitCode).toBe(0);
  });

  it("drains pending delivery on a close event before resolving", async () => {
    const entered = deferred(), gate = deferred();
    let settled = false;
    let child: ChildProcess | undefined;
    const run = start("process.stdout.write('last');setInterval(() => {}, 1000);", {
      onLog: async () => {
        child = runningProcesses.get(run.id)!.child;
        entered.resolve();
        await gate.promise;
      },
    });
    void run.result.then(() => { settled = true; });
    await entered.promise;
    // Inject close to isolate its drain contract without making a callback wait
    // for natural close, which itself may need the paused pipes to resume.
    child!.emit("close", 7, null);
    const closed = new Promise<void>((done) => child!.once("close", () => done()));
    try {
      await turn();
      expect(settled).toBe(false);
      expect(runningProcesses.has(run.id)).toBe(false);
      gate.resolve();
      expect(await run.result).toMatchObject({ stdout: "last", exitCode: 7 });
    } finally {
      gate.resolve();
      child!.kill("SIGKILL");
      await closed;
    }
  });

  it("rejects a child error immediately even while delivery is blocked", async () => {
    const entered = deferred(), gate = deferred();
    let child: ChildProcess | undefined;
    const run = start("process.stdout.write('ready');setInterval(() => {}, 1000);", {
      onLog: async () => {
        child = runningProcesses.get(run.id)!.child;
        entered.resolve();
        await gate.promise;
      },
    });
    const rejected = expect(run.result).rejects.toThrow("synthetic child error");
    await entered.promise;
    const closed = new Promise<void>((done) => child!.once("close", () => done()));
    try {
      child!.emit("error", new Error("synthetic child error"));
      await rejected;
      expect(runningProcesses.has(run.id)).toBe(false);
    } finally {
      child!.kill("SIGKILL");
      gate.resolve();
      await closed;
    }
  });

  it("returns a real child result after a nonfatal sink error", async () => {
    const errors: unknown[] = [];
    const run = start("process.stdout.write('last');", {
      onLog: async () => { throw new Error("disk unavailable"); },
      onLogError: (err) => { errors.push(err); },
    });
    expect(await run.result).toMatchObject({ stdout: "last", exitCode: 0, signal: null });
    expect(errors).toHaveLength(1);
  });

  it("terminates on a fatal sink error and reports the original failure after close", async () => {
    const errors: unknown[] = [];
    const run = start("process.stdout.write('ready');setInterval(() => {}, 1000);", {
      fatalOnLogError: true,
      onLog: async () => { throw new Error("disk unavailable"); },
      onLogError: (err) => { errors.push(err); },
    });
    await expect(run.result).rejects.toThrow("disk unavailable");
    expect(errors).toHaveLength(1);
    expect(runningProcesses.has(run.id)).toBe(false);
  });

  it("keeps external cancellation distinct from timeout", async () => {
    const run = start("process.stdout.write('ready');setInterval(() => {}, 1000);", {
      onLog: async () => { runningProcesses.get(run.id)!.child.kill("SIGTERM"); },
    });
    expect(await run.result).toMatchObject({ signal: "SIGTERM", timedOut: false, idleTimedOut: false });
  });

  it("keeps the hard timeout active during continuously received output", async () => {
    const run = start("setInterval(() => process.stdout.write('.'), 10);", {
      timeoutSec: 1, idleTimeoutSec: 2,
    });
    const result = await run.result;
    expect(result.stdout).not.toBe("");
    expect(result).toMatchObject({ signal: "SIGTERM", timedOut: true, idleTimedOut: false });
  });

  it("keeps the idle clock running while the sink is slow", async () => {
    let delivering = false, exitedWhileDelivering = false;
    const run = start("process.stdout.write('ready');setInterval(() => {}, 1000);", {
      timeoutSec: 3, idleTimeoutSec: 0.3,
      onLog: async (stream, text) => {
        if (stream === "stdout" && text === "ready") {
          delivering = true;
          runningProcesses.get(run.id)!.child.once("exit", () => {
            exitedWhileDelivering = delivering;
          });
          await new Promise((done) => setTimeout(done, 600));
          delivering = false;
        }
      },
    });
    const result = await run.result;
    expect(result.stdout).toBe("ready");
    expect(exitedWhileDelivering).toBe(true);
    expect(result).toMatchObject({ signal: "SIGTERM", timedOut: true, idleTimedOut: true });
    expect(result.stderr).toContain("No process output for 0.3s");
  });
});

import { expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { PassThrough, type Readable } from "node:stream";
import { collectQaProcessGuard, qaProcessGuardNodeArgs } from "../services/workflow/qa-process-guard.js";

// Independent expectations: C01/document revision 4 and the recorded real-Node
// probes require ready-only normal exits and sticky fault evidence after throws.
const READY = '{"version":1,"kind":"ready"}\n';
const FAULT = '{"version":1,"kind":"fault"}\n';
const dataUrl = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
// FD4 remains opaque here; the existing verifier owns its schema and attribution.
const resultSource = (result = "negative") =>
  `const fs=require("node:fs");fs.writeFileSync(4,${JSON.stringify(result)});`;

async function runNode(script: string, options: {
  preload?: boolean; before?: string; holdStdout?: boolean; eofHandshake?: boolean;
} = {}) {
  const args = [...(options.before ? ["--import", dataUrl(options.before)] : []),
    ...(options.preload === false ? [] : qaProcessGuardNodeArgs()), "-e", script];
  const child = spawn(process.execPath, args, { env: { ...process.env, NODE_OPTIONS: "" },
    stdio: [options.eofHandshake ? "pipe" : "ignore", "pipe", "pipe", "pipe", "pipe", "pipe"] });
  const channel = child.stdio[5] as Readable;
  const failures: Error[] = [], ioErrors: Error[] = [], markers: Buffer[] = [];
  const output: Buffer[][] = [[], [], []];
  let stdoutBytes = 0, timedOut = false;
  const order: string[] = [];
  const guard = collectQaProcessGuard(channel, error => failures.push(error));
  channel.on("data", (chunk: Buffer) => markers.push(chunk));
  channel.once("end", () => {
    order.push("guard-end");
    if (options.eofHandshake) child.stdin!.end("x");
  });
  child.stdin?.on("error", error => ioErrors.push(error));
  child.stdout!.on("data", (chunk: Buffer) => { stdoutBytes += chunk.length; });
  if (options.holdStdout) child.stdout!.pause();
  [child.stderr!, child.stdio[3] as Readable, child.stdio[4] as Readable].forEach((stream, index) => {
    stream.on("data", (chunk: Buffer) => output[index].push(chunk));
    stream.on("error", error => ioErrors.push(error));
  });
  child.stdout!.on("error", error => ioErrors.push(error));
  child.once("exit", () => { order.push("child-exit"); child.stdout!.resume(); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
    guard.dispose(new Error("fixture_timeout"));
    child.stdio.forEach(stream => stream?.destroy());
  }, 5000);
  try {
    const exit = await closed;
    await guard.drained;
    if (timedOut) throw new Error("fixture_timeout");
    if (ioErrors.length) throw ioErrors[0];
    return { ...exit, guard, failures, order, stdoutBytes,
      markers: Buffer.concat(markers).toString("utf8"),
      diagnostic: Buffer.concat(output[1]).toString("utf8"),
      fd4: Buffer.concat(output[2]).toString("utf8") };
  } finally {
    clearTimeout(timer);
    guard.dispose();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child.stdio.forEach(stream => stream?.destroy());
  }
}

it("provides per-call strict rejection handling and a file-independent Node preload", () => {
  const args = qaProcessGuardNodeArgs();
  expect(args.slice(0, 2)).toEqual(["--unhandled-rejections=strict", "--import"]);
  expect(args[2]).toMatch(/^data:text\/javascript,/);
});

it.each([["negative", 1], ["positive", 0]] as const)("normal %s preserves FD4 and only reports ready", async (result, code) => {
  const r = await runNode(resultSource(result) + `console.log("qa_process_guard_fault");
    console.error("uncaughtException");process.exitCode=${code};`);
  expect(r.code).toBe(code);
  expect(r.signal).toBeNull();
  expect(r.fd4).toBe(result);
  expect(r.markers).toBe(READY);
  expect(r.failures).toEqual([]);
  expect(() => r.guard.assertHealthy()).not.toThrow();
});

const crashes = [
  ["sync", "throw Error('fixture');", 1],
  ["async", "setImmediate(()=>{throw Error('fixture')});", 1],
  ["rejection", "Promise.reject(Error('fixture'));", 1],
  ["capture", "process.setUncaughtExceptionCaptureCallback(()=>{process.exitCode=0});throw Error('fixture');", 0],
  ["handler", "process.on('uncaughtException',()=>{process.exitCode=0});throw Error('fixture');", 0],
  ["exit-code-change", "process.on('exit',()=>{process.exitCode=0});throw Error('fixture');", 0],
  ["exit-handler", "process.on('exit',()=>{throw Error('fixture')});process.exitCode=1;", 1],
  ["two-faults", `let captures=0;process.setUncaughtExceptionCaptureCallback(()=>{
    if(++captures===1)setImmediate(()=>{throw Error('second')});else process.exitCode=0;
  });throw Error('first');`, 0],
] as const;
it.each(crashes)("same FD4 followed by %s remains an execution fault", async (_name, tail, code) => {
  const r = await runNode(resultSource() + tail);
  expect(r.code).toBe(code);
  expect(r.fd4).toBe("negative");
  expect(r.markers).toBe(READY + FAULT);
  expect(r.failures.map(error => error.message)).toEqual(["qa_process_guard_fault"]);
  expect(() => r.guard.assertHealthy()).toThrow("qa_process_guard_fault");
});

it("observes actual synchronous stdout EAGAIN after console output, independently of output limits", async () => {
  const r = await runNode(resultSource() + `console.log('diagnostic');
    try { fs.writeFileSync(1,Buffer.alloc(10*1024*1024+1,120)); }
    catch(error) { fs.writeSync(3,JSON.stringify({code:error.code}));throw error; }
    process.exitCode=1;`, { holdStdout: true });
  // FD3 is a fixture-only diagnostic here, not a production failure classifier.
  expect(JSON.parse(r.diagnostic)).toEqual({ code: "EAGAIN" });
  expect(r.stdoutBytes).toBeLessThan(10 * 1024 * 1024);
  expect(r.fd4).toBe("negative");
  expect(r.markers).toBe(READY + FAULT);
  expect(() => r.guard.assertHealthy()).toThrow("qa_process_guard_fault");
});

it("accepts normal FD5 EOF before owned exit without a sleep or callback-order heuristic", async () => {
  const r = await runNode(resultSource() + `fs.closeSync(5);
    fs.readSync(0,Buffer.alloc(1),0,1,null);process.exitCode=1;`, { eofHandshake: true });
  expect(r.order).toEqual(["guard-end", "child-exit"]);
  expect(r.code).toBe(1);
  expect(r.markers).toBe(READY);
  expect(r.failures).toEqual([]);
  expect(() => r.guard.assertHealthy()).not.toThrow();
});

const invalidFrames = [
  ["missing", ""],
  ["duplicate-ready", READY + READY],
  ["duplicate-fault", READY + FAULT + FAULT],
  ["wrong-order", FAULT + READY],
  ["malformed", "{\n"],
  ["extra-field", '{"version":1,"kind":"ready","extra":true}\n'],
  ["duplicate-key", '{"version":1,"version":1,"kind":"ready"}\n'],
  ["wrong-version", '{"version":2,"kind":"ready"}\n'],
  ["wrong-type", '{"version":"1","kind":"ready"}\n'],
  ["unknown-kind", '{"version":1,"kind":"finished"}\n'],
  ["incomplete-line", READY.slice(0, -1)],
  ["empty-line", READY + "\n"],
  ["bom", "\ufeff" + READY],
  ["invalid-utf8", Buffer.from([0xc3, 0x28, 10])],
  ["overflow", Buffer.alloc(129, 120)],
] as const;
it.each(invalidFrames)("rejects %s even alongside the same negative FD4 and exit one", async (_name, frame) => {
  const bytes = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
  const r = await runNode(resultSource() +
    `fs.writeSync(5,Buffer.from(${JSON.stringify(bytes.toString("base64"))},'base64'));process.exitCode=1;`,
    { preload: false });
  expect(r.code).toBe(1);
  expect(r.fd4).toBe("negative");
  expect(r.failures).toHaveLength(1);
  expect(() => r.guard.assertHealthy()).toThrow(/^qa_process_guard_/);
});

it.each([["ready", "throw"], ["ready", "partial"], ["fault", "throw"], ["fault", "partial"]] as const)(
  "%s marker write %s kills the child instead of leaving ambiguous exit one", async (kind, mode) => {
    // Test-only preload injects the real fs write failure before the guard imports it.
    const before = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
      const write=fs.writeSync.bind(fs);fs.writeSync=(fd,...args)=>{
        const bytes=args[0];
        if(fd===5&&Buffer.isBuffer(bytes)&&bytes.toString().includes('"kind":"${kind}"')){
          ${mode === "throw" ? "throw Error('fixture_write_failure');" : "return write(fd,bytes,0,bytes.length-1);"}
        }
        return write(fd,...args);
      };syncBuiltinESMExports();`;
    const r = await runNode(resultSource() + "throw Error('fixture');", { before });
    expect(r.code).toBeNull();
    expect(r.signal).toBe("SIGKILL");
    expect(r.markers).not.toBe(READY + FAULT);
    if (mode === "partial") expect(() => r.guard.assertHealthy()).toThrow("incomplete_frame");
    // Ready-only evidence alone cannot override the caller's signal failure gate.
  },
);

it("kills on a fault write to a closed FD5 even if an exception callback would choose exit one", async () => {
  const r = await runNode(resultSource() + `process.setUncaughtExceptionCaptureCallback(()=>{process.exitCode=1});
    fs.closeSync(5);throw Error('fixture');`);
  expect(r.code).toBeNull();
  expect(r.signal).toBe("SIGKILL");
  expect(r.markers).toBe(READY);
});

it("collects a ready record split at every byte and releases its own listeners", async () => {
  const stream = new PassThrough(), notify = vi.fn();
  const guard = collectQaProcessGuard(stream, notify);
  const closed = once(stream, "close");
  expect(() => guard.assertHealthy()).toThrow("not_drained");
  for (const byte of Buffer.from(READY)) stream.write(Buffer.from([byte]));
  stream.end();
  await guard.drained;
  guard.dispose(); guard.dispose();
  await closed;
  expect(() => guard.assertHealthy()).not.toThrow();
  expect(notify).not.toHaveBeenCalled();
  for (const event of ["data", "end", "error", "close"]) expect(stream.listenerCount(event)).toBe(0);
});

it.each([false, true])("reports a channel failure (read error=%s) and preserves it during cleanup", async (readError) => {
  const stream = new PassThrough(), notify = vi.fn();
  const guard = collectQaProcessGuard(stream, notify);
  const closed = new Promise<void>(resolve => stream.once("close", resolve));
  stream.write(Buffer.from(READY));
  stream.destroy(readError ? new Error("fixture_io") : undefined);
  await guard.drained;
  await closed;
  const first = notify.mock.calls[0][0] as Error;
  expect(first.message).toBe(readError ? "qa_process_guard_channel_error" : "qa_process_guard_closed_without_eof");
  guard.dispose(new Error("later_cancel")); guard.dispose();
  expect(() => guard.assertHealthy()).toThrow(first);
  expect(notify).toHaveBeenCalledTimes(1);
});

it("disposal releases an open reader, settles intake and retains cancellation", async () => {
  const stream = new PassThrough(), notify = vi.fn();
  const guard = collectQaProcessGuard(stream, notify);
  const closed = once(stream, "close"), cancelled = new Error("fixture_cancelled");
  stream.write(Buffer.from(READY));
  guard.dispose(cancelled); guard.dispose(new Error("later"));
  await guard.drained;
  await closed;
  expect(stream.destroyed).toBe(true);
  expect(() => guard.assertHealthy()).toThrow(cancelled);
  expect(notify).toHaveBeenCalledTimes(1);
});

it("fault evidence stays failed through disposal and a later cancellation", async () => {
  const stream = new PassThrough(), notify = vi.fn();
  const guard = collectQaProcessGuard(stream, notify);
  const closed = once(stream, "close");
  stream.write(Buffer.from(READY + FAULT));
  guard.dispose(new Error("later_cancel")); guard.dispose();
  await guard.drained;
  await closed;
  expect(() => guard.assertHealthy()).toThrow("qa_process_guard_fault");
  expect(notify).toHaveBeenCalledTimes(1);
});

it("a missing FD5 fails closed and remains failed after repeated cleanup", async () => {
  const notify = vi.fn(), guard = collectQaProcessGuard(null, notify);
  await guard.drained;
  guard.dispose(); guard.dispose();
  expect(() => guard.assertHealthy()).toThrow("missing_channel");
  expect(notify).toHaveBeenCalledTimes(1);
});

import type { Readable } from "node:stream";
import { TextDecoder } from "node:util";

export const QA_PROCESS_GUARD_FD = 5;
export const QA_PROCESS_GUARD_MAX_BYTES = 128;
const READY = '{"version":1,"kind":"ready"}\n';
const FAULT = '{"version":1,"kind":"fault"}\n';

// Generated JavaScript travels with both the development TS and compiled JS.
// Eligibility belongs to the caller's frozen-contract/deployment checks.
const preload = `import { writeSync } from "node:fs";
import { Buffer } from "node:buffer";
const write = writeSync;
const kill = process.kill.bind(process, process.pid, "SIGKILL");
let faultReported = false;
function report(frame) {
  try {
    if (write(${QA_PROCESS_GUARD_FD}, frame) === frame.length) return;
  } catch {}
  // Missing or partial evidence must never leave an ambiguous exit-one result.
  kill();
}
process.on("uncaughtExceptionMonitor", () => {
  if (faultReported) return;
  faultReported = true;
  report(Buffer.from(${JSON.stringify(FAULT)}));
});
report(Buffer.from(${JSON.stringify(READY)}));
`;
const preloadUrl = `data:text/javascript,${encodeURIComponent(preload)}`;

/** Insert before the entrypoint of an independently verified direct Node call. */
export function qaProcessGuardNodeArgs(): string[] {
  return ["--unhandled-rejections=strict", "--import", preloadUrl];
}

export interface QaProcessGuard {
  /** FD5 reached EOF, failed, or was disposed; this does not await child exit. */
  readonly drained: Promise<void>;
  /** Call after owned-process exit and all invocation channels have drained. */
  assertHealthy(): void;
  /** Release only this FD5 reader; preserve the first failure. */
  dispose(reason?: Error): void;
}

/**
 * C01: observe execution faults separately from FD4 result verification.
 * The caller owns process termination, deadlines, cancellation and other pipes.
 * onFailure receives the first failure immediately; drained never rejects.
 */
export function collectQaProcessGuard(
  stream: Readable | null | undefined,
  onFailure: (error: Error) => void,
): QaProcessGuard {
  let pending = Buffer.alloc(0);
  let size = 0;
  let ready = false;
  let ended = false;
  let terminal = false;
  let disposed = false;
  let failure: Error | undefined;
  let finish!: () => void;
  const drained = new Promise<void>(resolve => {
    finish = () => { terminal = true; resolve(); };
  });
  const fail = (error: Error) => {
    if (failure) return;
    failure = error;
    pending = Buffer.alloc(0);
    onFailure(error);
  };
  const reject = (reason: string) => fail(new Error(`qa_process_guard_${reason}`));

  function onData(chunk: unknown) {
    if (failure || disposed) return;
    if (!Buffer.isBuffer(chunk)) { reject("channel_error"); return; }
    size += chunk.length;
    if (size > QA_PROCESS_GUARD_MAX_BYTES) { reject("too_large"); return; }
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const newline = pending.indexOf(10);
      if (newline < 0) return;
      const bytes = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      let line: string;
      try {
        line = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch { reject("invalid_utf8"); return; }
      // Exact Runtime-owned records reject extra/duplicate keys, BOM, alternate
      // versions and types. Chunk boundaries have no framing significance.
      if (!ready && line === READY.slice(0, -1)) ready = true;
      else if (ready && line === FAULT.slice(0, -1)) { reject("fault"); return; }
      else { reject("invalid_frame"); return; }
    }
  }
  function onEnd() {
    ended = true;
    if (pending.length) reject("incomplete_frame");
    else if (!ready) reject("missing_ready");
    finish();
  }
  function onError(cause: Error) {
    fail(new Error("qa_process_guard_channel_error", { cause }));
    finish();
  }
  function detach() {
    stream?.off("data", onData);
    stream?.off("end", onEnd);
    stream?.off("error", onError);
    stream?.off("close", onClose);
  }
  function onClose() {
    if (!ended && !disposed) reject("closed_without_eof");
    finish();
    detach();
  }

  const guard: QaProcessGuard = {
    drained,
    assertHealthy() {
      if (failure) throw failure;
      if (!terminal || !ended) throw new Error("qa_process_guard_not_drained");
    },
    dispose(reason) {
      if (disposed) return;
      disposed = true;
      if (reason || !ended) fail(reason ?? new Error("qa_process_guard_disposed"));
      pending = Buffer.alloc(0);
      stream?.off("data", onData);
      stream?.off("end", onEnd);
      // Keep error handling until close, including an already queued I/O error.
      if (stream?.closed) detach();
      else stream?.destroy();
      finish();
    },
  };
  if (!stream) {
    reject("missing_channel");
    finish();
    return guard;
  }
  stream.on("data", onData);
  stream.once("end", onEnd);
  stream.on("error", onError);
  stream.once("close", onClose);
  if (stream.destroyed) onClose();
  else if (stream.readableEnded) onEnd();
  return guard;
}

import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { toolProgressEventSchema, type ToolProgressPolicy } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { ToolProgressError } from "../tools/progress-policy.js";
import { createToolProgressStore } from "../tools/progress-store.js";
import { withToolProgress } from "../tools/progress-monitor.js";
import type { ProgressScope } from "../tools/progress-scope.js";

const MAX_BUFFER = 10 * 1024 * 1024;
const protocolError = () => new ToolProgressError(500, "tool_progress_protocol_error");
async function readProgress(stream: Readable, accept: (raw: unknown) => Promise<void>, signal: AbortSignal) {
  let pending = Buffer.alloc(0);
  for await (const chunk of stream) {
    signal.throwIfAborted();
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < buffer.length) {
      const newline = buffer.indexOf(10, offset);
      const end = newline < 0 ? buffer.length : newline;
      if (pending.length + end - offset > 4096) throw protocolError();
      pending = Buffer.concat([pending, buffer.subarray(offset, end)]);
      if (newline < 0) break;
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pending)); }
      catch { throw protocolError(); }
      await accept(raw); // Serial intake + stream backpressure: no per-message Promise queue.
      signal.throwIfAborted();
      pending = Buffer.alloc(0);
      offset = newline + 1;
    }
  }
  if (pending.length > 0) throw protocolError();
}
export async function executeLocalToolWithProgress(input: {
  db: Db; scope: ProgressScope; policy: ToolProgressPolicy;
  executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
}): Promise<{ stdout: string; stderr: string }> {
  const store = createToolProgressStore(input.db);
  const heartbeat = await store.start(input.scope, input.policy);
  let cleanup: (() => Promise<void>) | undefined;
  return withToolProgress({ store, heartbeat, succeeded: () => true, cleanup: async () => { await cleanup?.(); },
    operation: async (signal) => {
      signal.throwIfAborted();
      const child = spawn(input.executable, input.args, { cwd: input.cwd,
        env: { ...input.env, PAPERCOMPANY_TOOL_EXECUTION_ID: heartbeat.id, PAPERCOMPANY_TOOL_PROGRESS_FD: "3" },
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      });
      let childError: Error | undefined;
      let closed = false;
      let ownedExited = false;
      let terminating = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const channel = child.stdio[3] as Readable;
      const releasePipes = () => {
        // Descendants may retain descriptors after our owned process has exited.
        // Destroy only this invocation's read handles, and only on failure/abort.
        if (!terminating || !ownedExited) return;
        child.stdout?.destroy(); child.stderr?.destroy(); channel.destroy();
      };
      const ownedExit = () => {
        ownedExited = true;
        clearTimeout(killTimer);
        releasePipes();
      };
      const terminate = () => {
        if (closed || terminating) return;
        terminating = true;
        if (ownedExited) { releasePipes(); return; }
        child.kill("SIGTERM");
        killTimer = setTimeout(() => { if (!ownedExited) child.kill("SIGKILL"); }, 2000);
        killTimer.unref?.();
      };
      const fail = (error: Error) => { childError ??= error; terminate(); };
      const collected: Buffer[][] = [[], []];
      const sizes = [0, 0];
      [child.stdout!, child.stderr!].forEach((stream, index) => {
        stream.on("data", (chunk: Buffer) => {
          sizes[index] += chunk.length;
          if (sizes[index] > MAX_BUFFER) { fail(new ToolProgressError(500, "tool_progress_output_overflow")); return; }
          collected[index].push(chunk);
        });
        stream.on("error", () => fail(new ToolProgressError(500, "tool_progress_child_io_error")));
      });
      const close = new Promise<number | null>((resolve) => {
        child.once("error", () => {
          if (child.pid === undefined) ownedExit(); // Spawn failure has no exit event.
          fail(new ToolProgressError(500, "tool_progress_child_error"));
        });
        child.once("exit", (code) => {
          ownedExit();
          if (code !== 0) fail(Object.assign(new ToolProgressError(500, "tool_progress_child_failed"), { code }));
        });
        child.once("close", (code) => {
          closed = true; clearTimeout(killTimer); signal.removeEventListener("abort", terminate); resolve(code);
        });
      });
      signal.addEventListener("abort", terminate, { once: true });
      if (signal.aborted) terminate();
      const intake = readProgress(channel, async (raw) => {
        const parsed = toolProgressEventSchema.safeParse(raw);
        if (!parsed.success) throw protocolError();
        await store.acceptLocal(input.scope.companyId, heartbeat.id, parsed.data);
      }, signal).catch((error: unknown) => fail(error instanceof ToolProgressError ? error : protocolError()));
      cleanup = async () => { await close; await intake; };
      const code = await close;
      await intake;
      signal.throwIfAborted();
      const stdout = Buffer.concat(collected[0]).toString("utf8");
      const stderr = Buffer.concat(collected[1]).toString("utf8");
      if (childError) throw Object.assign(childError, { stdout, stderr });
      if (code !== 0) throw Object.assign(new ToolProgressError(500, "tool_progress_child_failed"), { code, stdout, stderr });
      return { stdout, stderr };
    },
  });
}

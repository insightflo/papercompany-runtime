import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { digest } from "./artifact-files.js";
import { collectQaProcessGuard, qaProcessGuardNodeArgs, QA_PROCESS_GUARD_FD, type QaProcessGuard } from "./qa-process-guard.js";

export function encodeQaInput(content: Buffer, assets: { fileName: string; bytes: Buffer }[], qa: Buffer | null = null,
  html?: { ancillary: { fileName: string; bytes: Buffer }[] }, schemaVersion = "workflow.artifact-input.v1") {
  const part = (bytes: Buffer) => ({ base64: bytes.toString("base64"), sha256: digest(bytes), byteSize: bytes.length });
  const data = Buffer.from(JSON.stringify({ schemaVersion, content: part(content),
    assets: assets.map(a => ({ fileName: a.fileName, ...part(a.bytes) })), qa: qa ? part(qa) : null,
    ...(html ? { mode: "html", ancillary: html.ancillary.map(a => ({ fileName: a.fileName, ...part(a.bytes) })) } : {}) }));
  if (data.length > 64 * 1024 * 1024) throw new Error("qa_input_transport_too_large");
  return data;
}

/** FD4 is a machine result channel, never stdout. A missing consumer fails closed. */
export function wireQaTransport(child: ChildProcess, input: Buffer | undefined,
  result: boolean, fail: (error: Error) => void) {
  const chunks: Buffer[] = []; let size = 0;
  if (input) {
    child.stdin!.on("error", error => fail(error));
    child.stdin!.end(input);
  }
  if (result) {
    const stream = child.stdio[4] as Readable;
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) { fail(new Error("qa_result_transport_too_large")); stream.destroy(); }
      else chunks.push(chunk);
    });
    stream.on("error", fail);
  }
  return () => Buffer.concat(chunks);
}

/** acceptQaExit1 is only set by the caller after direct-Node/deployment checks. */
export function executeQaByteTool(input: { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  inputBytes: Buffer; qaResult: boolean; acceptQaExit1?: boolean; timeoutMs: number }) {
  return new Promise<{ stdout: string; stderr: string; qaResultBytes: Buffer; exitCode: number }>((resolve, reject) => {
    const guarded = input.qaResult && input.acceptQaExit1;
    const child = spawn(input.executable, [...(guarded ? qaProcessGuardNodeArgs() : []), ...input.args],
      { cwd: input.cwd, env: input.env,
        stdio: ["pipe", "pipe", "pipe", "ignore", input.qaResult ? "pipe" : "ignore", guarded ? "pipe" : "ignore"] });
    let failure: Error | undefined, guard: QaProcessGuard | undefined;
    let ownedExited = false;
    const releasePipes = () => {
      if (!failure || !ownedExited) return;
      // A descendant may hold any inherited pipe after the owned child exits.
      guard?.dispose(failure);
      child.stdio.forEach(stream => stream?.destroy());
    };
    const fail = (error: Error) => { failure ??= error; child.kill("SIGKILL"); releasePipes(); };
    const result = wireQaTransport(child, input.inputBytes, input.qaResult, fail);
    guard = guarded ? collectQaProcessGuard(child.stdio[QA_PROCESS_GUARD_FD] as Readable, fail) : undefined;
    const output = ["", ""];
    [child.stdout!, child.stderr!].forEach((s, i) => s.on("data", chunk => {
      output[i] += chunk; if (Buffer.byteLength(output[i]) > 10 * 1024 * 1024) fail(new Error("tool_output_overflow"));
    }).on("error", fail));
    const timer = setTimeout(() => fail(new Error("tool_timeout")), input.timeoutMs);
    child.on("error", error => { if (child.pid === undefined) ownedExited = true; fail(error); });
    child.once("exit", (code, signal) => {
      ownedExited = true;
      if (signal || (code !== 0 && !(guarded && code === 1))) fail(new Error("qa_tool_failed"));
      releasePipes();
    });
    child.once("close", async (code, signal) => {
      clearTimeout(timer);
      await guard?.drained; // close also drained FD4, stdout and stderr.
      try { guard?.assertHealthy(); } catch (error) { failure ??= error as Error; }
      guard?.dispose();
      const qaResultBytes = result();
      // A healthy guard only admits a candidate; FD4 still needs caller verification.
      if (failure || signal || (code !== 0 && !(guarded && code === 1))) {
        reject(Object.assign(failure ?? new Error("qa_tool_failed"), { code, signal, stdout: output[0], stderr: output[1], qaResultBytes }));
      } else resolve({ stdout: output[0], stderr: output[1], qaResultBytes, exitCode: code! });
    });
  });
}

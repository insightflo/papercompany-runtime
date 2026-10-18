import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { digest } from "./artifact-files.js";

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

export function executeQaByteTool(input: { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  inputBytes: Buffer; qaResult: boolean; acceptQaExit1?: boolean; timeoutMs: number }) {
  return new Promise<{ stdout: string; stderr: string; qaResultBytes: Buffer; exitCode: number }>((resolve, reject) => {
    const child = spawn(input.executable, input.args, { cwd: input.cwd, env: input.env,
      stdio: ["pipe", "pipe", "pipe", "ignore", input.qaResult ? "pipe" : "ignore"] });
    let failure: Error | undefined;
    const fail = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
    const result = wireQaTransport(child, input.inputBytes, input.qaResult, fail);
    const output = ["", ""];
    [child.stdout!, child.stderr!].forEach((s, i) => s.on("data", chunk => {
      output[i] += chunk; if (Buffer.byteLength(output[i]) > 10 * 1024 * 1024) fail(new Error("tool_output_overflow"));
    }).on("error", fail));
    const timer = setTimeout(() => fail(new Error("tool_timeout")), input.timeoutMs);
    child.on("error", fail);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const qaResultBytes = result();
      // Exit one is only a candidate for the caller to verify, never a QA verdict here.
      if (failure || signal || (code !== 0 && !(input.qaResult && input.acceptQaExit1 && code === 1))) {
        reject(Object.assign(failure ?? new Error("qa_tool_failed"), { code, signal, stdout: output[0], stderr: output[1], qaResultBytes }));
      } else resolve({ stdout: output[0], stderr: output[1], qaResultBytes, exitCode: code! });
    });
  });
}

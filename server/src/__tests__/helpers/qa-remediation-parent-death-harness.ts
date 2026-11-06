import { spawnSync, type ChildProcessByStdio } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type { Readable } from "node:stream";
import { createServer, type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import type { Db } from "@paperclipai/db";

// 자식 프로세스의 cwd 이자 `--import tsx` 해석 기준. vitest 는 저장소 루트에서 실행되므로
// process.cwd() 를 쓰면 server/node_modules 의 tsx 를 찾지 못해 자식이 즉시 죽는다.
export const SERVER_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const CHILD_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "qa-remediation-parent-death-child.ts");
export const NATIVE_HELPER = fileURLToPath(new URL("../../services/workflow/control-flow/qa-remediation-file-owner.py", import.meta.url));
export const PYTHON = process.env.PAPERCLIP_QA_FILE_OWNER_PYTHON
  ?? process.env.PYTHON
  ?? process.env.PATH?.split(delimiter).map((part) => join(part, "python3"))
    .find((candidate) => { try { accessSync(candidate, constants.X_OK); return true; } catch { return false; } });
if (!PYTHON) throw new Error("A Python 3 executable is required for C5 parent-death integration tests");

export type ChildMessage = { readonly kind: string; readonly [key: string]: unknown };
type BarrierHit = { readonly phase: "before" | "after"; readonly src: string; readonly dst: string; readonly helperPid: number; readonly parentPid: number };

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

export function within<T>(promise: Promise<T>, label: string, milliseconds = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
  })]).finally(() => { if (timer) clearTimeout(timer); });
}

export function processState(pid: number): string | null {
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

export function processExited(pid: number): boolean {
  const state = processState(pid);
  return state === null || state.startsWith("Z");
}

export async function waitForProcessExit(pid: number): Promise<string | null> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = processState(pid);
    if (state === null || state.startsWith("Z")) return state;
    await delay(20);
  }
  throw new Error(`native helper PID ${pid} remained alive; last observed state=${processState(pid)}`);
}

export async function waitForBackendGone(db: Db, pid: number) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const rows = await db.$client.unsafe("SELECT pid FROM pg_stat_activity WHERE pid = $1::integer", [pid]);
    if (rows.length === 0) return;
    await delay(25);
  }
  throw new Error(`owning Node database backend PID ${pid} remained present after process death`);
}

export async function createRenameBarrier(dir: string, nativeHelper: string) {
  const server: Server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("parent-death barrier did not bind a TCP port");
  let socket: Socket | null = null, buffer = "", replaceSent = false, returnSent = false;
  const hits: BarrierHit[] = [];
  const before = deferred<BarrierHit>(), after = deferred<BarrierHit>();
  server.once("connection", (accepted) => {
    socket = accepted;
    accepted.setEncoding("utf8");
    accepted.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const hit = JSON.parse(line) as BarrierHit;
        hits.push(hit);
        if (hit.phase === "before") before.resolve(hit);
        if (hit.phase === "after") after.resolve(hit);
        index = buffer.indexOf("\n");
      }
    });
  });
  const wrapper = join(dir, "parent-death-owner.py");
  const script = [
    "import json, os, runpy, socket",
    `HELPER = ${JSON.stringify(nativeHelper)}`,
    `PORT = ${address.port}`,
    "real_replace = os.replace",
    "def gated_replace(src, dst):",
    "    connection = socket.create_connection(('127.0.0.1', PORT), timeout=45)",
    "    event = {'phase':'before','src':src,'dst':dst,'helperPid':os.getpid(),'parentPid':os.getppid()}",
    "    connection.sendall((json.dumps(event)+'\\n').encode())",
    "    if connection.recv(128).strip() != b'replace': os._exit(97)",
    "    result = real_replace(src, dst)",
    "    event['phase'] = 'after'",
    "    connection.sendall((json.dumps(event)+'\\n').encode())",
    "    if connection.recv(128).strip() != b'return': os._exit(98)",
    "    connection.close()",
    "    return result",
    "os.replace = gated_replace",
    "runpy.run_path(HELPER, run_name='__main__')",
    "",
  ].join("\n");
  await writeFile(wrapper, script, { mode: 0o600 });
  return {
    helperPath: wrapper, before: before.promise, after: after.promise, hits,
    replace() {
      if (!socket) throw new Error("native helper has not reached the replace barrier");
      socket.write("replace\n");
      replaceSent = true;
    },
    returnFromReplace() {
      if (!socket) throw new Error("native helper has not reported its replace result");
      socket.write("return\n");
      returnSent = true;
    },
    async releaseForCleanup() {
      if (!socket) return;
      if (!replaceSent) { socket.write("replace\n"); replaceSent = true; }
      try { await within(after.promise, "cleanup post-replace barrier", 5_000); } catch { /* failure teardown continues */ }
      if (socket && !returnSent) { socket.write("return\n"); returnSent = true; }
    },
    close() {
      socket?.destroy();
      return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export function observeRootChild(child: ChildProcessByStdio<null, Readable, Readable>) {
  const started = deferred<ChildMessage>();
  const messages: ChildMessage[] = [];
  let stdout = "", stderr = "", buffer = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const message = JSON.parse(line) as ChildMessage;
        messages.push(message);
        if (message.kind === "root_started") started.resolve(message);
        if (message.kind === "root_error" || message.kind === "unhandled") started.reject(new Error(JSON.stringify(message)));
      } catch { /* Non-JSON loader output remains in the raw captured stream. */ }
      index = buffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const closed = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.once("error", (error) => started.reject(error));
  return { started: started.promise, messages, closed, output: () => ({ stdout, stderr }) };
}

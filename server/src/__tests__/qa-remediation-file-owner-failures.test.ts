import { afterAll, afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  QA_REMEDIATION_MAX_FILE_BYTES,
} from "../services/workflow/control-flow/qa-remediation-contract.js";
import {
  QaRemediationFileOwner,
  runGuardedPublication,
  type FileOwnerExit,
  type FileOwnerPublishItem,
} from "../services/workflow/control-flow/qa-remediation-file-owner.js";

const helperPath = fileURLToPath(new URL("../services/workflow/control-flow/qa-remediation-file-owner.py", import.meta.url));
const pythonCommand = "python3";
const BEFORE = Buffer.from("before bytes\n");
const AFTER = Buffer.from("after bytes\n");
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const dirs: string[] = [];
const owners = new Set<QaRemediationFileOwner>();
const begins: Promise<QaRemediationFileOwner>[] = [];
const servers = new Set<Server>();
const sockets = new Set<Socket>();
interface DirectFixture { helper: string; pidFile: string; lockRoot: string; targets: readonly string[] }
const directFixtures: DirectFixture[] = [];
let directFixtureExitsObserved = 0;

afterEach(async () => {
  const stop = async (items: Iterable<QaRemediationFileOwner>) => {
    const results = await Promise.allSettled([...items].map((owner) => owner.abort()));
    return results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  };
  let failures = await stop(owners);
  owners.clear();
  for (const result of await Promise.allSettled(begins.splice(0))) if (result.status === "fulfilled") owners.add(result.value);
  failures.push(...await stop(owners));
  owners.clear();
  failures.push(...await stopDirectFixtures());
  for (const socket of sockets) if (!socket.destroyed) socket.destroy();
  const closeResults = await Promise.allSettled([...servers].map(closeServer));
  servers.clear();
  sockets.clear();
  failures.push(...closeResults.flatMap((result) => result.status === "rejected" ? [result.reason] : []));
  if (failures.length) throw new AggregateError(failures, "owned helper or barrier cleanup failed; temp files retained");
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

afterAll(() => console.info(`C5 direct fixture cleanup observed ${directFixtureExitsObserved} owned process exit(s)`));

async function workspace(initial: string | Buffer = BEFORE) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "c5-fail-")));
  dirs.push(dir);
  const lockRoot = path.join(dir, "guards");
  await mkdir(lockRoot, { mode: 0o700 });
  const file = path.join(dir, "report.txt");
  await writeFile(file, initial, { mode: 0o600 });
  return { dir, lockRoot, file };
}

function item(target: string, before: string | Buffer, after: string | Buffer): FileOwnerPublishItem {
  return {
    target, beforeSha256: sha(before), beforeSize: Buffer.byteLength(before),
    afterSha256: sha(after), afterSize: Buffer.byteLength(after), bytesB64: Buffer.from(after).toString("base64"),
  };
}

function begin(lockRoot: string, targets: readonly string[], pathOverride = helperPath) {
  const pending = QaRemediationFileOwner.begin({ lockRoot, targets, pythonCommand, helperPath: pathOverride });
  const tracked = pending.then((owner) => { owners.add(owner); return owner; });
  begins.push(tracked);
  return tracked;
}

function probeGuard(lockRoot: string, target: string) {
  const guard = path.join(lockRoot, `c5-${sha(target)}.guard`);
  return spawnSync(pythonCommand, ["-c", "import fcntl,sys\nf=open(sys.argv[1],'r+')\ntry: fcntl.flock(f.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(42)\n", guard], { encoding: "utf8", timeout: 5000 });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function ownDirectFixture(helper: string, pidFile: string, lockRoot: string, targets: readonly string[]) {
  directFixtures.push({ helper, pidFile, lockRoot, targets });
}

function directFixtureAlive(fixture: DirectFixture, pid: number): boolean {
  if (!alive(pid)) return false;
  const observed = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 5000 });
  if (observed.error) throw observed.error;
  if (observed.status !== 0) return false;
  if (!observed.stdout.includes(fixture.helper)) throw new Error(`PID ${pid} no longer identifies its exact fixture`);
  return true;
}

async function stopDirectFixtures(): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const fixture of directFixtures.splice(0)) {
    try {
      let pid: number;
      try { pid = Number(await readFile(fixture.pidFile, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid owned fixture PID: ${pid}`);
      if (directFixtureAlive(fixture, pid)) {
        try { process.kill(pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      const deadline = Date.now() + 5000;
      while (directFixtureAlive(fixture, pid)) {
        if (Date.now() >= deadline) throw new Error(`owned fixture PID ${pid} did not exit`);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      for (const target of fixture.targets) {
        const guard = path.join(fixture.lockRoot, `c5-${sha(target)}.guard`);
        try { await stat(guard); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        const probe = probeGuard(fixture.lockRoot, target);
        if (probe.error || probe.status !== 0) throw new Error(`owned fixture PID ${pid} exited but guard remains unavailable`);
      }
      directFixtureExitsObserved += 1;
    } catch (error) { failures.push(error); }
  }
  return failures;
}

function observedExit(error: unknown): FileOwnerExit | null | undefined {
  return (error as { exit?: FileOwnerExit | null })?.exit;
}

async function childPid(file: string): Promise<number> {
  const pid = Number(await readFile(file, "utf8"));
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  return pid;
}

function py(value: string): string { return JSON.stringify(value); }

async function wrapper(dir: string, body = "") {
  const pidFile = path.join(dir, `child-${randomUUID()}.pid`);
  const helper = path.join(dir, `wrapper-${randomUUID()}.py`);
  const source = [
    "import os, runpy, sys",
    `open(${py(pidFile)}, 'w').write(str(os.getpid()))`,
    body,
    `runpy.run_path(${py(helperPath)}, run_name='__main__')`,
  ].join("\n");
  await writeFile(helper, source);
  return { helper, pidFile };
}

interface BarrierHit {
  readonly socket: Socket;
  readonly closed: Promise<void>;
  next(): Promise<string>;
  send(line: string): void;
}

async function barrier(dir: string): Promise<{ socketPath: string; connected: Promise<BarrierHit> }> {
  const socketPath = path.join(dir, "barrier.sock");
  let connect!: (hit: BarrierHit) => void;
  let rejectConnect!: (error: Error) => void;
  const connected = new Promise<BarrierHit>((resolve, reject) => { connect = resolve; rejectConnect = reject; });
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffered = "";
    let failure: Error | null = null;
    const queued: string[] = [];
    const waiting: { resolve(value: string): void; reject(error: Error): void }[] = [];
    const closed = new Promise<void>((resolve) => socket.once("close", () => { sockets.delete(socket); resolve(); }));
    socket.setEncoding("utf8");
    socket.on("error", (error) => {
      failure = error;
      for (const waiter of waiting.splice(0)) waiter.reject(error);
    });
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const waiter = waiting.shift();
        if (waiter) waiter.resolve(line); else queued.push(line);
        newline = buffered.indexOf("\n");
      }
    });
    connect({
      socket, closed,
      next: () => failure ? Promise.reject(failure) : queued.length ? Promise.resolve(queued.shift()!) : new Promise((resolve, reject) => waiting.push({ resolve, reject })),
      send: (line) => { socket.write(`${line}\n`); },
    });
  });
  server.on("error", rejectConnect);
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return { socketPath, connected };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function within<T>(promise: Promise<T>, label: string, milliseconds = 5000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`deadline waiting for ${label}`)), milliseconds);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

const authorityModes = ["sync throw", "async reject"] as const;
it.each(authorityModes)("%s releases the acquired owner before preserving the caller error", async (mode) => {
  const { dir, lockRoot, file } = await workspace();
  const wrapped = await wrapper(dir);
  ownDirectFixture(wrapped.helper, wrapped.pidFile, lockRoot, [file]);
  const sentinel = new Error(`authority ${mode}`);
  const revalidateAuthority = mode === "sync throw"
    ? () => { throw sentinel; }
    : async () => { throw sentinel; };
  const rejection = await within(runGuardedPublication({
    lockRoot, targets: [file], pythonCommand, helperPath: wrapped.helper,
    items: [item(file, BEFORE, AFTER)], revalidateAuthority,
  }).then(
    () => { throw new Error("authority failure unexpectedly returned an outcome"); },
    (error: unknown) => error,
  ), "authority publication rejection");
  expect(rejection).toBe(sentinel);
  const pid = await childPid(wrapped.pidFile);
  expect(alive(pid)).toBe(false);
  const probe = probeGuard(lockRoot, file);
  expect(probe.error).toBeUndefined();
  expect(probe.status).toBe(0);
  const preserved = await readFile(file);
  expect(preserved).toEqual(BEFORE);
  expect(sha(preserved)).toBe(sha(BEFORE));
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  const next = await begin(lockRoot, [file]);
  const published = await next.publish([item(file, BEFORE, AFTER)]);
  expect(published.files[0]).toMatchObject({ status: "applied", observedSha256: sha(AFTER), observedSize: AFTER.length });
  expect(await readFile(file)).toEqual(AFTER);
  expect(await next.close()).toEqual({ code: 0, signal: null });
});

it("post-begin bytes cap failure waits for the real child exit and guard release", async () => {
  const { dir, lockRoot, file } = await workspace();
  const wrapped = await wrapper(dir);
  ownDirectFixture(wrapped.helper, wrapped.pidFile, lockRoot, [file]);
  const tooLarge = Buffer.alloc(QA_REMEDIATION_MAX_FILE_BYTES + 1, 0x61);
  const rejection = await within(runGuardedPublication({
    lockRoot, targets: [file], pythonCommand, helperPath: wrapped.helper,
    items: [{ target: file, beforeSha256: sha(BEFORE), beforeSize: BEFORE.length, afterSha256: sha(tooLarge), afterSize: tooLarge.length, bytesB64: tooLarge.toString("base64") }],
    revalidateAuthority: async () => ({ authorized: true }),
  }).then(
    () => { throw new Error("oversized publication unexpectedly returned an outcome"); },
    (error: unknown) => error,
  ), "oversized publication rejection");
  expect(rejection).toMatchObject({ code: "bytes_over_cap" });
  const exit = observedExit(rejection);
  expect(exit).toBeDefined();
  expect(exit).not.toBeNull();
  expect(exit?.code !== null || exit?.signal !== null).toBe(true);
  expect(alive(await childPid(wrapped.pidFile))).toBe(false);
  expect(probeGuard(lockRoot, file).status).toBe(0);
  const preserved = await readFile(file);
  expect(preserved).toEqual(BEFORE);
  expect(sha(preserved)).toBe(sha(BEFORE));
});

it("a correlated native refusal does not reject while its wrapper still holds the guard", async () => {
  const { dir, lockRoot, file } = await workspace();
  const channel = await barrier(dir);
  const wrapped = await wrapper(dir, `
import json, socket
real_stdout = sys.stdout
def announce_and_wait(stage, wait_for=None):
    channel = socket.socket(socket.AF_UNIX)
    channel.connect(${py(channel.socketPath)})
    channel.sendall((stage + "\\n").encode())
    if wait_for is not None:
        channel.recv(64)
    return channel
class Output:
    def write(self, data):
        frame = json.loads(data)
        if frame.get("type") == "error":
            channel = announce_and_wait("refusal-ready", True)
            real_stdout.write(data); real_stdout.flush()
            channel.sendall(b"refusal-emitted\\n")
            channel.recv(64)
            return len(data)
        return real_stdout.write(data)
    def flush(self): real_stdout.flush()
sys.stdout = Output()
`);
  const owner = await begin(lockRoot, [file], wrapped.helper);
  const pid = await childPid(wrapped.pidFile);
  let settled = false;
  const other = path.join(dir, "outside.txt");
  const publication = owner.publish([item(other, "outside\n", "refused\n")]).then(
    (value) => { settled = true; return { status: "fulfilled" as const, value }; },
    (error: unknown) => {
      settled = true;
      return { status: "rejected" as const, error, aliveAtRejection: alive(pid), guardAtRejection: probeGuard(lockRoot, file) };
    },
  );
  const hit = await within(channel.connected, "refusal barrier connection");
  expect(await within(hit.next(), "refusal-ready handshake")).toBe("refusal-ready");
  expect(alive(pid)).toBe(true);
  expect(probeGuard(lockRoot, file).status).toBe(42);
  expect(settled).toBe(false);
  hit.send("emit");
  const boundary = await within(Promise.race([
    hit.next().then((line) => ({ kind: "line" as const, line })),
    hit.closed.then(() => ({ kind: "closed" as const })),
  ]), "correlated refusal exit boundary");
  if (boundary.kind === "line") {
    expect(boundary.line).toBe("refusal-emitted");
  }
  await within(hit.closed, "owned refusal process termination");
  const result = await within(publication, "public refusal result");
  expect(result.status).toBe("rejected");
  if (result.status !== "rejected") throw new Error("native refusal unexpectedly fulfilled");
  expect(result.error).toMatchObject({ code: "item_out_of_scope" });
  expect(result.aliveAtRejection).toBe(false);
  expect(result.guardAtRejection.error).toBeUndefined();
  expect(result.guardAtRejection.status).toBe(0);
  const exit = observedExit(result.error);
  expect(exit).toBeDefined();
  expect(exit).not.toBeNull();
  expect(exit?.code !== null || exit?.signal !== null).toBe(true);
  expect(await owner.awaitExit()).toEqual(exit);
  expect(alive(pid)).toBe(false);
  expect(probeGuard(lockRoot, file).status).toBe(0);
  const preserved = await readFile(file);
  expect(preserved).toEqual(BEFORE);
  expect(sha(preserved)).toBe(sha(BEFORE));
});

const corruptions = [
  { name: "published held", case: "published-held", initial: BEFORE },
  { name: "published io_error", case: "published-io_error", initial: BEFORE },
  { name: "published not_attempted", case: "published-not_attempted", initial: BEFORE },
  { name: "applied digest omitted", case: "omit-digest", initial: BEFORE },
  { name: "applied digest null", case: "null-digest", initial: BEFORE },
  { name: "applied digest wrong", case: "wrong-digest", initial: BEFORE },
  { name: "applied size omitted", case: "omit-size", initial: BEFORE },
  { name: "applied size null", case: "null-size", initial: BEFORE },
  { name: "applied size wrong", case: "wrong-size", initial: BEFORE },
  { name: "already_applied digest wrong", case: "already-digest", initial: AFTER },
  { name: "already_applied size wrong", case: "already-size", initial: AFTER },
] as const;

it.each(corruptions)("rejects protocol-corrupt publication reply: $name", async ({ case: corruption, initial }) => {
  const { dir, lockRoot, file } = await workspace(initial);
  const wrapped = await wrapper(dir, `
import json
corruption = ${py(corruption)}
real_stdout = sys.stdout
class Output:
    def write(self, data):
        frame = json.loads(data)
        if frame.get("type") == "publish_result":
            row = frame["files"][0]
            if corruption == "published-held": row["status"] = "held"
            elif corruption == "published-io_error": row["status"] = "io_error"
            elif corruption == "published-not_attempted": row["status"] = "not_attempted"
            elif corruption == "omit-digest": row.pop("observedSha256")
            elif corruption == "null-digest": row["observedSha256"] = None
            elif corruption == "wrong-digest": row["observedSha256"] = "f" * 64
            elif corruption == "omit-size": row.pop("observedSize")
            elif corruption == "null-size": row["observedSize"] = None
            elif corruption == "wrong-size": row["observedSize"] += 1
            elif corruption == "already-digest": row["observedSha256"] = "f" * 64
            elif corruption == "already-size": row["observedSize"] += 1
            data = json.dumps(frame, separators=(",", ":")) + "\\n"
        return real_stdout.write(data)
    def flush(self): real_stdout.flush()
sys.stdout = Output()
`);
  const owner = await begin(lockRoot, [file], wrapped.helper);
  const pid = await childPid(wrapped.pidFile);
  const result = await owner.publish([item(file, BEFORE, AFTER)]).then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  expect(result.status).toBe("rejected");
  if (result.status !== "rejected") throw new Error("corrupted protocol reply unexpectedly fulfilled");
  expect(result.error).toMatchObject({ code: "protocol_mismatch" });
  const exit = observedExit(result.error);
  expect(exit).toBeDefined();
  expect(exit).not.toBeNull();
  expect(exit?.code !== null || exit?.signal !== null).toBe(true);
  expect(await owner.awaitExit()).toEqual(exit);
  expect(alive(pid)).toBe(false);
  expect(probeGuard(lockRoot, file).status).toBe(0);
  expect(await readFile(file)).toEqual(AFTER);  // native work is retained; protocol rejection never rolls it back
});

it("preserves native partial io_error actuals and leaves later items not attempted", async () => {
  const { dir, lockRoot, file: first } = await workspace();
  const secondDir = path.join(dir, "second");
  const thirdDir = path.join(dir, "third");
  await mkdir(secondDir); await mkdir(thirdDir);
  const second = path.join(secondDir, "report.txt");
  const third = path.join(thirdDir, "report.txt");
  await writeFile(second, BEFORE, { mode: 0o600 });
  await writeFile(third, BEFORE, { mode: 0o600 });
  const channel = await barrier(dir);
  const wrapped = await wrapper(dir, `
import os, socket
real_replace = os.replace
def replace_first(source, target):
    result = real_replace(source, target)
    if target == ${py(first)}:
        wait = socket.socket(socket.AF_UNIX); wait.connect(${py(channel.socketPath)}); wait.sendall(b"first-applied\\n"); wait.recv(64)
    return result
os.replace = replace_first
`);
  const owner = await begin(lockRoot, [first, second, third], wrapped.helper);
  const publishing = owner.publish([item(first, BEFORE, AFTER), item(second, BEFORE, "second after\n"), item(third, BEFORE, "third after\n")]);
  const hit = await within(channel.connected, "first native rename barrier");
  expect(await within(hit.next(), "first applied marker")).toBe("first-applied");
  expect(await readFile(first)).toEqual(AFTER);
  expect(await readFile(second)).toEqual(BEFORE);
  expect(await readFile(third)).toEqual(BEFORE);
  await rm(secondDir, { recursive: true });  // next real tempfile creation fails with ENOENT
  await expect(readFile(second)).rejects.toMatchObject({ code: "ENOENT" });
  hit.send("continue");
  const result = await within(publishing, "partial native result");
  expect(result.outcome).toBe("io_error");
  expect(result.files.map((row) => row.status)).toEqual(["applied", "io_error", "not_attempted"]);
  expect(result.files[0]).toMatchObject({ observedSha256: sha(AFTER), observedSize: AFTER.length });
  expect(result.files[1]).toMatchObject({ observedSha256: sha(BEFORE), observedSize: BEFORE.length });
  expect(result.files[2]).toMatchObject({ observedSha256: sha(BEFORE), observedSize: BEFORE.length });
  expect(await readFile(first)).toEqual(AFTER);
  expect(await readFile(third)).toEqual(BEFORE);
  expect(await owner.close()).toEqual({ code: 0, signal: null });
});

const renameStages = ["before-rename", "after-rename"] as const;
it.each(renameStages)("abort at %s preserves actual bytes and waits before a contender classifies them", async (stage) => {
  const { dir, lockRoot, file } = await workspace();
  const unrelatedFile = path.join(dir, "unrelated.txt");
  await writeFile(unrelatedFile, "other before\n", { mode: 0o600 });
  const channel = await barrier(dir);
  const wrapped = await wrapper(dir, `
import os, socket
real_replace = os.replace
def replace_at_boundary(source, target):
    if ${py(stage)} == "before-rename":
        wait = socket.socket(socket.AF_UNIX); wait.connect(${py(channel.socketPath)}); wait.sendall(b"before-rename\\n"); wait.recv(64)
    real_replace(source, target)
    if ${py(stage)} == "after-rename":
        wait = socket.socket(socket.AF_UNIX); wait.connect(${py(channel.socketPath)}); wait.sendall(b"after-rename\\n"); wait.recv(64)
os.replace = replace_at_boundary
`);
  const owner = await begin(lockRoot, [file], wrapped.helper);
  const pid = await childPid(wrapped.pidFile);
  const publication = owner.publish([item(file, BEFORE, AFTER)]).then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  const hit = await within(channel.connected, `${stage} handshake`);
  expect(await within(hit.next(), `${stage} event`)).toBe(stage);
  const waits: string[] = [];
  let resolveWait!: (value: string[]) => void;
  const waitEvent = new Promise<string[]>((resolve) => { resolveWait = resolve; });
  const contenderPromise = QaRemediationFileOwner.begin({
    lockRoot, targets: [file], pythonCommand, helperPath,
    onEvent: (event) => { waits.push(event.target); resolveWait(waits); },
  }).then((contender) => { owners.add(contender); return contender; });
  begins.push(contenderPromise);
  expect(await within(waitEvent, "independent lock_wait")).toEqual([file]);
  const unrelated = await begin(lockRoot, [unrelatedFile]);
  expect((await unrelated.publish([item(unrelatedFile, "other before\n", "other after\n")])).files[0]?.status).toBe("applied");
  expect(await unrelated.close()).toEqual({ code: 0, signal: null });
  const expectedAtAbort = stage === "before-rename" ? BEFORE : AFTER;
  expect(await readFile(file)).toEqual(expectedAtAbort);
  const aborted = await owner.abort();
  expect(aborted.actualResult).toBe("unknown");
  expect(aborted.exit).not.toBeNull();
  expect(aborted.exit?.code !== null || aborted.exit?.signal !== null).toBe(true);
  await within(hit.closed, `${stage} helper socket close`);
  const firstResult = await within(publication, "aborted publish result");
  expect(firstResult.status).toBe("rejected");
  if (firstResult.status !== "rejected") throw new Error("aborted publication unexpectedly fulfilled");
  expect(observedExit(firstResult.error)).toEqual(aborted.exit);
  expect(alive(pid)).toBe(false);
  expect(await readFile(file)).toEqual(expectedAtAbort);
  const contender = await within(contenderPromise, "contender ready after owner exit");
  const settled = await contender.publish([item(file, BEFORE, AFTER)]);
  expect(settled.outcome).toBe("published");
  expect(settled.files[0]).toMatchObject({
    status: stage === "before-rename" ? "applied" : "already_applied",
    observedSha256: sha(AFTER), observedSize: AFTER.length,
  });
  expect(await readFile(file)).toEqual(AFTER);
  expect(await contender.close()).toEqual({ code: 0, signal: null });
  const independent = await begin(lockRoot, [unrelatedFile]);
  expect((await independent.publish([item(unrelatedFile, "other after\n", "still usable\n")])).files[0]?.status).toBe("applied");
  expect(await independent.close()).toEqual({ code: 0, signal: null });
});

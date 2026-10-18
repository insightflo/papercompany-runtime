import { constants } from "node:fs";
import { mkdtemp, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, symlink, writeFile, stat } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { captureArtifactRoot } from "../services/workflow/artifact-files.js";
import { createArtifactDirectory, writeArtifactFile } from "../services/workflow/artifact-writer.js";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const roots: string[] = [];
const bytes = Buffer.from("C03_PROBE_PAYLOAD: complete validated machine receipt");
afterEach(async () => {
  for (const root of roots.splice(0)) {
    execFileSync("chmod", ["-R", "u+w", root]);
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), "artifact-durability-"))); roots.push(temp);
  const base = path.join(temp, "base"), outside = path.join(temp, "outside");
  await mkdir(base); await mkdir(outside);
  return { temp, base, outside, root: await captureArtifactRoot(base) };
}
async function preload(temp: string, body: string) {
  const file = path.join(temp, "hook.cjs");
  await writeFile(file, `const fs = require('node:fs'), c = fs.constants;\n${body}`);
  return file;
}
async function inject(file: string) {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.mocked(spawn).mockImplementationOnce((command, args, options) => actual.spawn(command, args as readonly string[], {
    ...options, env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(file)}` },
  }));
  return () => vi.mocked(spawn).mockImplementation(actual.spawn);
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

// C03's independent expectation: failure may leave no final file or complete bytes,
// never a partial final file; removing a finite fault permits the same request again.
it.each(["partial-write", "short-write", "file-sync", "directory-sync", "kill-write", "kill-after-link"])(
  "does not publish partial bytes and retries after %s", async mode => {
    const f = await fixture(), finalPath = path.join(f.base, "receipt.json");
    const hook = await preload(f.temp, `
const mode = ${JSON.stringify(mode)}, write = fs.writeFileSync, sync = fs.fsyncSync, link = fs.linkSync;
const fail = () => { throw Object.assign(Error('finite_C03'), {code: 'EIO'}); };
fs.writeFileSync = function(fd, data, ...rest) {
  if (typeof fd === 'number' && Buffer.isBuffer(data) && data.toString().startsWith('C03_PROBE_PAYLOAD:')
      && ['partial-write', 'short-write', 'kill-write'].includes(mode)) {
    write.call(fs, fd, data.subarray(0, 9), ...rest);
    if (mode === 'kill-write') process.kill(process.pid, 'SIGKILL');
    if (mode === 'partial-write') fail();
    return;
  }
  return write.call(fs, fd, data, ...rest);
};
fs.fsyncSync = function(fd) {
  const directory = fs.fstatSync(fd).isDirectory();
  if ((mode === 'file-sync' && !directory) || (mode === 'directory-sync' && directory)) fail();
  return sync.call(fs, fd);
};
fs.linkSync = function(...args) {
  const result = link.apply(fs, args);
  if (mode === 'kill-after-link') process.kill(process.pid, 'SIGKILL');
  return result;
};`);
    const restore = await inject(hook);
    try { await expect(writeArtifactFile(f.root, "receipt.json", bytes)).rejects.toThrow(); }
    finally { restore(); }
    const visible = await readFile(finalPath).catch(() => null);
    expect(visible === null || visible.equals(bytes)).toBe(true);
    if (["directory-sync", "kill-after-link"].includes(mode)) expect(visible).toEqual(bytes);
    else expect(visible).toBeNull();
    const log = path.join(f.temp, "retry-syncs");
    const recorder = await preload(f.temp, `
const sync = fs.fsyncSync;
fs.fsyncSync = function(fd) {
  const result = sync.call(fs, fd);
  fs.appendFileSync(${JSON.stringify(log)}, fs.fstatSync(fd).isDirectory() ? 'd' : 'f');
  return result;
};`);
    const restoreRetry = await inject(recorder);
    try { await writeArtifactFile(f.root, "receipt.json", bytes); }
    finally { restoreRetry(); }
    expect(await readFile(finalPath)).toEqual(bytes);
    const synced = await readFile(log, "utf8");
    expect(synced).toContain("f"); expect(synced).toContain("d");
  }, 20000,
);

it("leaves colliding and uncleanable temporary files alone and uses a fresh name on retry", async () => {
  const f = await fixture();
  const hook = await preload(f.temp, `
const open = fs.openSync, write = fs.writeFileSync, unlink = fs.unlinkSync;
let collided = false;
fs.openSync = function(name, flags, ...rest) {
  if (!collided && typeof name === 'string' && name.startsWith('.artifact-') && (flags & c.O_CREAT)) {
    collided = true;
    const fd = open.call(fs, name, flags, ...rest);
    fs.writeSync(fd, Buffer.from('unowned')); fs.closeSync(fd);
    throw Object.assign(Error('collision'), {code: 'EEXIST'});
  }
  return open.call(fs, name, flags, ...rest);
};
fs.writeFileSync = function(fd, data, ...rest) {
  if (typeof fd === 'number' && Buffer.isBuffer(data) && data.toString().startsWith('C03_PROBE_PAYLOAD:')) {
    write.call(fs, fd, data.subarray(0, 9), ...rest);
    throw Object.assign(Error('finite_C03'), {code: 'EIO'});
  }
  return write.call(fs, fd, data, ...rest);
};
fs.unlinkSync = function(name) {
  if (String(name).startsWith('.artifact-')) throw Object.assign(Error('cleanup'), {code: 'EIO'});
  return unlink.call(fs, name);
};`);
  const restore = await inject(hook);
  try { await expect(writeArtifactFile(f.root, "receipt.json", bytes)).rejects.toThrow("finite_C03"); }
  finally { restore(); }
  expect(await readFile(path.join(f.base, "receipt.json")).catch(() => null)).toBeNull();
  const names = await readdir(f.base), debris = await Promise.all(names.map(name => readFile(path.join(f.base, name))));
  expect(names).toHaveLength(2);
  expect(debris.map(b => b.toString()).sort()).toEqual(["C03_PROBE", "unowned"].sort());
  await writeArtifactFile(f.root, "receipt.json", bytes);
  expect(await readFile(path.join(f.base, "receipt.json"))).toEqual(bytes);
  expect(await Promise.all(names.map(name => readFile(path.join(f.base, name))))).toEqual(debris);
});

it.each([false, true])("serializes two real publishers without replacing the winner (different=%s)", async different => {
  const f = await fixture(), actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const hook = await preload(f.temp, `
const link = fs.linkSync;
fs.linkSync = function(...args) {
  fs.writeSync(3, Buffer.from('ready'));
  const fd = fs.openSync(process.env.C03_GATE, 'r');
  try { fs.readSync(fd, Buffer.alloc(1), 0, 1, null); } finally { fs.closeSync(fd); }
  return link.apply(fs, args);
};`);
  const gates = [];
  for (let index = 0; index < 2; index++) {
    const file = path.join(f.temp, `gate-${index}`); execFileSync("mkfifo", [file]);
    gates.push({ file, handle: await open(file, constants.O_RDWR), ready: deferred<void>() });
  }
  let index = 0;
  vi.mocked(spawn).mockImplementation((command, args, options) => {
    const gate = gates[index++];
    const child = actual.spawn(command, args as readonly string[], { ...options,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      env: { ...process.env, C03_GATE: gate.file,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(hook)}` } });
    (child.stdio[3] as Readable).once("data", () => gate.ready.resolve(undefined));
    child.once("error", gate.ready.reject);
    child.once("exit", () => gate.ready.reject(new Error("writer exited before barrier")));
    return child;
  });
  const writes = [writeArtifactFile(f.root, "receipt.json", bytes),
    writeArtifactFile(f.root, "receipt.json", different ? Buffer.from("different complete bytes") : bytes)];
  const settled = Promise.allSettled(writes);
  try {
    await Promise.all(gates.map(g => g.ready.promise));
    await gates[0].handle.write(Buffer.from("x")); await writes[0];
    await gates[1].handle.write(Buffer.from("x"));
    const result = await settled;
    expect(result[0].status).toBe("fulfilled");
    expect(result[1].status).toBe(different ? "rejected" : "fulfilled");
    expect(await readFile(path.join(f.base, "receipt.json"))).toEqual(bytes);
  } finally {
    await Promise.all(gates.map(g => g.handle.write(Buffer.from("x"))));
    await settled;
    await Promise.all(gates.map(g => g.handle.close()));
    vi.mocked(spawn).mockImplementation(actual.spawn);
  }
}, 20000);

it("reuses an existing exact file without replacing its inode and refuses other bytes", async () => {
  const f = await fixture(), file = path.join(f.base, "receipt.json"); await writeFile(file, bytes);
  const before = await stat(file);
  await writeArtifactFile(f.root, "receipt.json", bytes);
  await expect(writeArtifactFile(f.root, "receipt.json", Buffer.from("other"))).rejects.toThrow("artifact_file_conflict");
  expect((await stat(file)).ino).toBe(before.ino); expect(await readFile(file)).toEqual(bytes);
});
it("preserves past partial files and symlinks instead of repairing or following them", async () => {
  const f = await fixture(), partial = path.join(f.base, "partial.json"), outside = path.join(f.outside, "original");
  await writeFile(partial, bytes.subarray(0, 9)); await writeFile(outside, bytes);
  await symlink(outside, path.join(f.base, "linked.json"));
  await expect(writeArtifactFile(f.root, "partial.json", bytes)).rejects.toThrow("artifact_file_conflict");
  await expect(writeArtifactFile(f.root, "linked.json", bytes)).rejects.toThrow();
  expect(await readFile(partial)).toEqual(bytes.subarray(0, 9));
  expect(await readlink(path.join(f.base, "linked.json"))).toBe(outside);
  expect(await readFile(outside)).toEqual(bytes);
});
it.each(["root", "ancestor"])("rejects a replaced %s without an outside write", async boundary => {
  const f = await fixture();
  if (boundary === "root") { await rename(f.base, f.base + "-old"); await symlink(f.outside, f.base); }
  else await symlink(f.outside, path.join(f.base, "runs"));
  await expect(createArtifactDirectory(f.root, "runs/attempt", [{ relative: "input/a", bytes }], [])).rejects.toThrow();
  expect(await readdir(f.outside)).toEqual([]);
});
it("syncs every recursive directory link up to the captured root and retains exclusive directory creation", async () => {
  const f = await fixture(), log = path.join(f.temp, "directory-syncs");
  const hook = await preload(f.temp, `
const sync = fs.fsyncSync;
fs.fsyncSync = function(fd) {
  const result = sync.call(fs, fd);
  if (fs.fstatSync(fd).isDirectory()) fs.appendFileSync(${JSON.stringify(log)}, fs.realpathSync('.') + '\\n');
  return result;
};`);
  const restore = await inject(hook);
  try { await createArtifactDirectory(f.root, "runs/qa/attempt", [{ relative: "input/a", bytes }], ["input"]); }
  finally { restore(); }
  const synced = new Set((await readFile(log, "utf8")).trim().split("\n"));
  for (const relative of [".", "runs", "runs/qa", "runs/qa/attempt", "runs/qa/attempt/input"]) {
    expect(synced.has(path.resolve(f.base, relative))).toBe(true);
  }
  await expect(createArtifactDirectory(f.root, "runs/qa/attempt", [], [])).rejects.toThrow();
});

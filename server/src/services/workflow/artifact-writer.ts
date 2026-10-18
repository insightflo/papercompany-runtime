import { spawn } from "node:child_process";
import path from "node:path";
import type { ArtifactRoot } from "./artifact-files.js";

type Directory = { name: string; exclusive: boolean; readonly: boolean; target: boolean;
  directories: Directory[]; files: { name: string; base64: string }[] };

// Each child has a kernel-pinned cwd. Opening the next directory with NOFOLLOW,
// then checking that inode in the next child's cwd closes the open/spawn race.
// mkdir/open/chmod never traverse an unpinned ancestor (including on macOS,
// where Node exposes neither mkdirat nor fchdir). No chmod-based trust boundary.
const writer = `
const fs = require('node:fs'), cp = require('node:child_process'), crypto = require('node:crypto'), c = fs.constants;
const {node, dev, ino, program} = JSON.parse(fs.readFileSync(0, 'utf8'));
const base = fs.statSync('.');
if (base.dev !== dev || base.ino !== ino) throw Error('artifact_root_replaced');
const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;
function verify(fd, bytes) {
  const before = fs.fstatSync(fd);
  if (!before.isFile() || before.size !== bytes.length) throw Error('artifact_file_conflict');
  const actual = Buffer.alloc(bytes.length + 1);
  let size = 0;
  while (size < actual.length) {
    const count = fs.readSync(fd, actual, size, actual.length - size, size);
    if (!count) break;
    size += count;
  }
  const after = fs.fstatSync(fd);
  if (!sameInode(before, after) || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || size !== bytes.length || !actual.subarray(0, size).equals(bytes)) throw Error('artifact_file_conflict');
}
function reuse(name, bytes) {
  let fd;
  try { fd = fs.openSync(name, c.O_RDONLY | c.O_NONBLOCK | c.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  try { verify(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  return true;
}
function persist(file) {
  const bytes = Buffer.from(file.base64, 'base64');
  if (reuse(file.name, bytes)) return;
  let temporary, fd;
  for (let attempt = 0; attempt < 32; attempt++) {
    const name = '.artifact-' + crypto.randomBytes(24).toString('hex') + '.tmp';
    try {
      fd = fs.openSync(name, c.O_RDWR | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW, 0o400);
      temporary = name;
      break;
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  if (fd === undefined) throw Error('artifact_temporary_collision');
  const owned = fs.fstatSync(fd);
  let failure;
  try {
    fs.writeFileSync(fd, bytes);
    verify(fd, bytes);
    fs.fsyncSync(fd);
    const current = fs.lstatSync(temporary);
    if (!current.isFile() || !sameInode(current, owned)) throw Error('artifact_temporary_replaced');
    try { fs.linkSync(temporary, file.name); }
    catch (error) {
      if (error.code !== 'EEXIST' || !reuse(file.name, bytes)) throw error;
    }
  } catch (error) { failure = error; }
  finally {
    try { fs.closeSync(fd); } catch (error) { failure ??= error; }
    try {
      const current = fs.lstatSync(temporary);
      if (!current.isFile() || !sameInode(current, owned)) throw Error('artifact_temporary_replaced');
      fs.unlinkSync(temporary);
    } catch (error) { if (error.code !== 'ENOENT') failure ??= error; }
  }
  if (failure) throw failure;
}
let target = node.target ? {dev: base.dev, ino: base.ino} : null;
for (const child of node.directories) {
  try { fs.mkdirSync(child.name, {mode: 0o700}); }
  catch (e) { if (e.code !== 'EEXIST' || child.exclusive) throw e; }
  const fd = fs.openSync(child.name, c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    const result = cp.spawnSync(process.execPath, ['-e', program], {cwd: child.name,
      input: JSON.stringify({node: child, dev: stat.dev, ino: stat.ino, program}),
      encoding: 'utf8', maxBuffer: 65536, timeout: 20000});
    if (result.error || result.status !== 0) throw Error(result.error?.message || result.stderr);
    const value = JSON.parse(result.stdout); if (value) target = value;
  } finally { fs.closeSync(fd); }
}
for (const file of node.files) persist(file);
const directoryFd = fs.openSync('.', c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW);
try {
  if (node.readonly) fs.fchmodSync(directoryFd, 0o500);
  // Every child syncs itself; unwinding also syncs every parent directory link.
  // Reuse repeats both file and directory sync after an interrupted publication.
  fs.fsyncSync(directoryFd);
} finally { fs.closeSync(directoryFd); }
process.stdout.write(JSON.stringify(target));
`;

/** Exclusively create a QA attempt/delivery below an existing pinned root. */
export async function createArtifactDirectory(root: ArtifactRoot, relative: string,
  files: { relative: string; bytes: Buffer }[], readonlyDirectories: string[]): Promise<ArtifactRoot> {
  const segments = (value: string) => {
    if (path.isAbsolute(value) || value.split(/[\\/]/).some(s => !s || s === "." || s === "..")) throw new Error("artifact_path_invalid");
    return value.split("/");
  };
  const directory = (name: string): Directory => ({ name, exclusive: false, readonly: false, target: false, directories: [], files: [] });
  const tree = directory(".");
  const descend = (base: Directory, parts: string[]) => parts.reduce((parent, name) => {
    let child = parent.directories.find(d => d.name === name);
    if (!child) { child = directory(name); parent.directories.push(child); }
    return child;
  }, base);
  const target = descend(tree, segments(relative)); target.exclusive = true; target.target = true;
  for (const name of readonlyDirectories) (name === "." ? target : descend(target, segments(name))).readonly = true;
  for (const file of files) {
    const parts = segments(file.relative), name = parts.pop()!;
    descend(target, parts).files.push({ name, base64: file.bytes.toString("base64") });
  }
  const result = await runWriter(root, tree);
  return { path: path.join(root.path, relative), ...result };
}

/** Persist exact bytes without replacing an existing result under the captured inode. */
export async function writeArtifactFile(root: ArtifactRoot, name: string, bytes: Buffer) {
  if (!name || name.includes("\\") || name.includes("\0") || path.basename(name) !== name || [".", ".."].includes(name)) {
    throw new Error("artifact_path_invalid");
  }
  await runWriter(root, { name: ".", exclusive: false, readonly: false, target: true,
    directories: [], files: [{ name, base64: bytes.toString("base64") }] });
}

async function runWriter(root: ArtifactRoot, tree: Directory) {
  return new Promise<{ dev: number; ino: number }>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", writer], { cwd: root.path, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-65536); });
    child.on("error", reject); child.stdin.on("error", reject);
    child.on("close", code => {
      if (code !== 0) return reject(new Error(stderr || "artifact_directory_write_failed"));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ node: tree, dev: root.dev, ino: root.ino, program: writer }));
  });
}

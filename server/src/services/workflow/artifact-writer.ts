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
const fs = require('node:fs'), cp = require('node:child_process'), c = fs.constants;
const {node, dev, ino, program} = JSON.parse(fs.readFileSync(0, 'utf8'));
const base = fs.statSync('.');
if (base.dev !== dev || base.ino !== ino) throw Error('artifact_root_replaced');
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
for (const file of node.files) {
  const fd = fs.openSync(file.name, c.O_WRONLY | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW, 0o400);
  try { fs.writeFileSync(fd, Buffer.from(file.base64, 'base64')); } finally { fs.closeSync(fd); }
}
if (node.readonly) {
  const fd = fs.openSync('.', c.O_RDONLY | c.O_DIRECTORY);
  try { fs.fchmodSync(fd, 0o500); } finally { fs.closeSync(fd); }
}
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

/** Exclusively persist a machine result under the captured inode, not its display path. */
export async function writeArtifactFile(root: ArtifactRoot, name: string, bytes: Buffer) {
  if (path.basename(name) !== name || [".", ".."].includes(name)) throw new Error("artifact_path_invalid");
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

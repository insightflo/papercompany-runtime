import { realpath, lstat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { createHash } from "node:crypto";

export const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export type ArtifactRoot = { path: string; dev: number; ino: number };
export async function captureArtifactRoot(root: string): Promise<ArtifactRoot> {
  const canonical = await realpath(root);
  const s = await lstat(root);
  if (!s.isDirectory() || s.isSymbolicLink() || canonical !== path.resolve(root)) throw new Error("artifact_root_not_canonical");
  return { path: canonical, dev: s.dev, ino: s.ino };
}

// A child owns a pinned cwd: replacing any ancestor cannot redirect later opens.
// Linux walks directory FDs. Darwin O_NOFOLLOW_ANY is the kernel all-components
// no-symlink flag (fcntl.h), not merely leaf O_NOFOLLOW. No path is reopened after verification.
const reader = `
const f = require('node:fs'), c = f.constants;
const [relative, dev, ino, cap] = process.argv.slice(1), max = Number(cap);
const base = f.statSync('.');
if (base.dev !== Number(dev) || base.ino !== Number(ino)) throw Error('artifact_root_replaced');
const segments = relative.split('/');
if (segments.some(p => !p || p === '.' || p === '..')) throw Error('artifact_path_invalid');
let fd;
if (process.platform === 'darwin') {
  fd = f.openSync(relative, c.O_RDONLY | c.O_NONBLOCK | 0x20000000);
} else if (process.platform === 'linux') {
  let parent = f.openSync('.', c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW);
  try {
    for (const segment of segments.slice(0, -1)) {
      const next = f.openSync('/proc/self/fd/' + parent + '/' + segment, c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW);
      f.closeSync(parent); parent = next;
    }
    fd = f.openSync('/proc/self/fd/' + parent + '/' + segments.at(-1), c.O_RDONLY | c.O_NONBLOCK | c.O_NOFOLLOW);
  } finally { f.closeSync(parent); }
} else throw Error('artifact_safe_open_platform_unsupported');
try {
  const before = f.fstatSync(fd);
  if (!before.isFile() || before.size > max) throw Error('artifact_file_invalid');
  const bytes = Buffer.alloc(max + 1); let size = 0, n;
  while ((n = f.readSync(fd, bytes, size, bytes.length - size, null)) > 0) { size += n; if (size > max) throw Error('artifact_oversize'); }
  const after = f.fstatSync(fd);
  if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw Error('artifact_changed');
  f.writeSync(1, bytes.subarray(0, size));
} finally { f.closeSync(fd); }
`;
export async function readArtifactBytes(root: ArtifactRoot, relative: string, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024
    || path.isAbsolute(relative) || relative.split(/[\\\\/]/).some(p => !p || p === '.' || p === '..')) {
    throw new Error("artifact_path_invalid");
  }
  const result = await promisify(execFile)(process.execPath,
    ["-e", reader, relative, String(root.dev), String(root.ino), String(maxBytes)],
    { cwd: root.path, encoding: "buffer", maxBuffer: maxBytes + 16384, timeout: 10000 });
  return result.stdout;
}

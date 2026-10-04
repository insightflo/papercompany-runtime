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

/**
 * [Q3 생산 시점 다이제스트] 완료 경로(completeWorkflowToolStepFromResult)가 영수증 없는 내구
 * toolResult 에 artifactSha256 를 찍을 때 쓰는 안전 읽기. 읽을 수 없는 산출물(유실·초과·비정규
 * 루트)은 null — 완료 자체를 실패시키지 않는 additive 기록이고, 이후 seed 검증은 다이제스트
 * 부재 기록에 대해 여전히 fail-closed 로 재사용을 거절한다(현 bytes 재기준화 없음).
 */
export async function readArtifactDigest(file: string): Promise<string | null> {
  try {
    const root = await captureArtifactRoot(path.dirname(file));
    return digest(await readArtifactBytes(root, path.basename(file), 32 * 1024 * 1024));
  } catch {
    return null;
  }
}

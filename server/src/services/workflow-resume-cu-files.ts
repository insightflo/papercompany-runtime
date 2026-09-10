import { constants } from "node:fs";
import { lstat, open, mkdir } from "node:fs/promises";
import path from "node:path";
import { fail, OBJECT_CAP, sha } from "./workflow-resume-cu-contract.js";

/** Server-configured physical roots only. Never resolve an arbitrary caller pathname. */
export async function directoryChain(directory: string, privateRoot = false) {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) fail("cu_evidence_unavailable", 503);
  let current = path.parse(directory).root;
  const chain: Array<{ path: string; ino: number; dev: number }> = [];
  for (const part of directory.slice(current.length).split("/").filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("cu_evidence_io", 422);
    chain.push({ path: current, ino: info.ino, dev: info.dev });
  }
  if (privateRoot) {
    const info = await lstat(directory);
    if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) fail("cu_evidence_io", 422);
  }
  return chain;
}
export async function readRegular(file: string, cap = OBJECT_CAP): Promise<Buffer> {
  const chain = await directoryChain(path.dirname(file));
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile()) fail("cu_evidence_io", 422);
    if (before.size > cap) fail("cu_evidence_limit", 422);
    const chunks: Buffer[] = []; let total = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(1024 * 1024, cap + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead; if (total > cap) fail("cu_evidence_limit", 422);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (before.size !== total || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail("cu_evidence_io", 422);
    for (const entry of chain) {
      const info = await lstat(entry.path);
      if (!info.isDirectory() || info.ino !== entry.ino || info.dev !== entry.dev) fail("cu_evidence_io", 422);
    }
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}
export async function writePrivate(file: string, raw: Buffer) {
  await directoryChain(path.dirname(file));
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); }
  if (sha(await readRegular(file, raw.length)) !== sha(raw)) fail("cu_evidence_io", 422);
  const parent = await open(path.dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
}
export async function privateSubmission(root: string, id: string) {
  await directoryChain(root, true);
  const directory = path.join(root, id);
  await mkdir(directory, { mode: 0o700 });
  await mkdir(path.join(directory, "object-cache"), { mode: 0o700 });
  await mkdir(path.join(directory, "result"), { mode: 0o700 });
  return directory;
}

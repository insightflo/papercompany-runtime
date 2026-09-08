import { constants } from "node:fs";
import { open as fsOpen } from "node:fs/promises";
import { createHash } from "node:crypto";

export const WORKFLOW_IF_CONDITION_ERROR_PREFIX = "Workflow IF condition failed:";
const MAX_CONDITION_SOURCE_BYTES = 1024 * 1024;
const READ_CHUNK_SIZE = 64 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
export function workflowConditionFailure(message: string): never {
  throw new Error(`${WORKFLOW_IF_CONDITION_ERROR_PREFIX} ${message}`);
}
const fail = workflowConditionFailure;

/** Hash exactly the bounded Buffer subsequently decoded and parsed, never a second file read. */
export async function readBoundedJsonFile(filePath: string, title: string, expectedHash?: string): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof fsOpen>> | null = null;
  try {
    handle = await fsOpen(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    // Some legacy short-read tests supply only a size. Real descriptors always provide isFile.
    if (typeof stat.isFile === "function" && !stat.isFile()) fail(`work product "${title}" is not a regular file`);
    if (stat.size > MAX_CONDITION_SOURCE_BYTES) {
      fail(`work product "${title}" (${stat.size} bytes) exceeds the ${MAX_CONDITION_SOURCE_BYTES}-byte limit`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buf = Buffer.alloc(READ_CHUNK_SIZE);
      const { bytesRead } = await handle.read(buf, 0, READ_CHUNK_SIZE, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_CONDITION_SOURCE_BYTES) {
        fail(`work product "${title}" grew beyond the ${MAX_CONDITION_SOURCE_BYTES}-byte limit during read`);
      }
      chunks.push(buf.subarray(0, bytesRead));
    }
    const buffer = Buffer.concat(chunks);
    if (expectedHash !== undefined && createHash("sha256").update(buffer).digest("hex") !== expectedHash) {
      fail(`work product "${title}" does not match its verified hash`);
    }
    let text: string;
    try { text = UTF8_DECODER.decode(buffer); }
    catch { return fail(`work product "${title}" is not valid UTF-8`); }
    try { return JSON.parse(text); }
    catch { fail(`work product "${title}" is not valid JSON`); }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(WORKFLOW_IF_CONDITION_ERROR_PREFIX)) throw err;
    fail(`work product "${title}" could not be read`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

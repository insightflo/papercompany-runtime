import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { conflict } from "../../errors.js";
import { preserveProducerMetadata, type registeredProducer } from "./producer-provenance.js";

type LocalProduct = { metadata?: Record<string, unknown> | null; url?: string | null };

export function metadataPath(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).path;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function resolveWorkProductLocalFilePath(product: LocalProduct): string | null {
  const localPath = metadataPath(product.metadata);
  if (localPath && path.isAbsolute(localPath)) return localPath;
  const url = product.url?.trim();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:") return null;
    return fileURLToPath(parsed);
  } catch {
    return null;
  }
}

/** Measure the same regular-file descriptor, bounded in memory, without trusting caller digests. */
async function productionSeal(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("workproduct_producer_file_not_regular");
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    let byteSize = 0;
    // Never chase a concurrently growing file; compare its final size/timestamps below.
    while (byteSize < before.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - byteSize), null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      byteSize += bytesRead;
    }
    const after = await handle.stat();
    if (byteSize !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs) throw new Error("workproduct_producer_file_changed");
    return { sha256: hash.digest("hex"), byteSize };
  } finally {
    await handle.close();
  }
}

/** Called only after registeredProducer's original admission/fence checks, inside the write transaction. */
export async function sealedProducerMetadata(product: LocalProduct & { provider: string },
  producer: Awaited<ReturnType<typeof registeredProducer>>) {
  const metadata = preserveProducerMetadata(product.metadata, producer);
  if (producer?.schemaVersion !== "workflow.work-product-producer.v1"
    || !["local", "local_file"].includes(product.provider)) return metadata;
  const file = resolveWorkProductLocalFilePath(product);
  try {
    if (!file) throw new Error("workproduct_producer_path_missing");
    metadata.workflowProducer = { ...producer, ...await productionSeal(file) };
  } catch {
    // A new local write cannot silently become a legacy, unsealed record.
    throw conflict("workproduct_producer_file_unreadable");
  }
  return metadata;
}

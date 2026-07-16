import { createHash } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import type { Db } from "@paperclipai/db";
import { isSafeCompanyDataStorageKeyPrefix, normalizeCompanyDataStorageKeyPrefix, type CompanyDataStorageConfig } from "@paperclipai/shared/validators/company-data-storage";
import { badRequest, notFound } from "../errors.js";
import { loadConfig } from "../config.js";
import type { CompanyDataStorageService } from "./company-data-storage.js";
import {
  assertSafeTarget,
  createDefaultLocalFs,
  isWithin,
  localCompanyDir,
  realpathOrSelf,
  resolveWithin,
  walkLocalTree,
  type LocalFsAdapter,
} from "./company-data-local-disk.js";

const MAX_LIST_OBJECTS = 1000;

export type DataObjectMeta = {
  key: string;
  size: number;
  contentType?: string;
  etag?: string;
  lastModified?: string;
};

export type DataObjectContent = {
  stream: Readable;
  size: number;
  contentType?: string;
  etag?: string;
  lastModified?: string;
};

export type DataObjectListResult = {
  objects: DataObjectMeta[];
  truncated: boolean;
};

export type DataObjectWriteResult = DataObjectMeta;

type S3ClientLike = {
  send(command: unknown): Promise<unknown>;
};

export type CompanyDataObjectDeps = {
  storageService: Pick<CompanyDataStorageService, "resolveActive">;
  resolveSecretValue: (companyId: string, secretId: string) => Promise<string>;
  resolveLocalDataRoot?: () => string;
  createS3Client?: (config: {
    region: string;
    endpoint: string;
    forcePathStyle: boolean;
    credentials: { accessKeyId: string; secretAccessKey: string };
  }) => Promise<S3ClientLike> | S3ClientLike;
  fsAdapter?: LocalFsAdapter;
};

/** Normalize a user-supplied key/prefix into safe forward-slash segments. */
export function normalizeObjectKey(objectKey: string): string {
  const normalized = objectKey.replace(/\\/g, "/").trim();
  if (!normalized || normalized.startsWith("/")) {
    throw badRequest("Invalid object key");
  }
  if (/[\u0000-\u001F\u007F]/.test(normalized)) throw badRequest("Invalid object key");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw badRequest("Invalid object key");
  }
  return parts.join("/");
}

export function normalizePrefix(prefix?: string): string {
  if (!prefix) return "";
  const cleaned = prefix.trim().replace(/^\/+|\/+$/g, "");
  return cleaned ? normalizeObjectKey(cleaned) : "";
}

function contentTypeFor(fileName: string): string {
  switch (path.extname(fileName).toLowerCase()) {
    case ".json": return "application/json";
    case ".md": return "text/markdown; charset=utf-8";
    case ".html": return "text/html; charset=utf-8";
    case ".csv": return "text/csv; charset=utf-8";
    case ".txt": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

function etagFor(body: Buffer): string {
  return `"${createHash("md5").update(body).digest("hex")}"`;
}

function defaultLocalDataRoot(): string {
  return loadConfig().storageLocalDiskBaseDir;
}

function s3Scope(
  config: Extract<CompanyDataStorageConfig, { provider: "s3" }>,
): string {
  const prefix = normalizeCompanyDataStorageKeyPrefix(config.keyPrefix);
  if (!isSafeCompanyDataStorageKeyPrefix(prefix)) {
    throw badRequest("Invalid company data storage key prefix");
  }
  return `${prefix}/`;
}

export function createCompanyDataObjectService(
  _db: Db,
  deps: CompanyDataObjectDeps,
) {
  const fsAdapter = deps.fsAdapter ?? createDefaultLocalFs();
  const resolveLocalDataRoot = deps.resolveLocalDataRoot ?? defaultLocalDataRoot;

  async function resolveS3Client(
    companyId: string,
    config: Extract<CompanyDataStorageConfig, { provider: "s3" }>,
  ) {
    const createS3Client = deps.createS3Client ?? (async (cfg) => {
      const { S3Client } = await import("@aws-sdk/client-s3");
      return new S3Client(cfg) as unknown as S3ClientLike;
    });
    const [accessKeyId, secretAccessKey] = await Promise.all([
      deps.resolveSecretValue(companyId, config.accessKeySecretId),
      deps.resolveSecretValue(companyId, config.secretAccessKeySecretId),
    ]);
    return createS3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: Boolean(config.forcePathStyle),
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async function listObjects(
    companyId: string,
    options: { prefix?: string; limit?: number } = {},
  ): Promise<DataObjectListResult> {
    const limit = Math.min(Math.max(options.limit ?? MAX_LIST_OBJECTS, 1), MAX_LIST_OBJECTS);
    const userPrefix = normalizePrefix(options.prefix);
    const config = await deps.storageService.resolveActive(companyId);

    if (config.provider === "local_disk") {
      const baseLexical = resolveLocalDataRoot();
      const baseReal = await realpathOrSelf(fsAdapter, baseLexical);
      const rootLexical = localCompanyDir(baseLexical, companyId);
      await assertSafeTarget(fsAdapter, baseLexical, baseReal, rootLexical);
      const rootReal = await realpathOrSelf(fsAdapter, rootLexical);
      if (!isWithin(baseReal, rootReal)) throw badRequest("Invalid object key path");
      // Guard the listing prefix itself: a symlinked prefix would let readdir
      // escape the company root before child-dirent filtering can intervene.
      const prefixPath = userPrefix ? resolveWithin(rootLexical, userPrefix) : rootLexical;
      await assertSafeTarget(fsAdapter, rootLexical, rootReal, prefixPath);
      const raw = await walkLocalTree(fsAdapter, rootLexical, userPrefix, limit + 1);
      return { objects: raw.slice(0, limit), truncated: raw.length > limit };
    }

    const scope = s3Scope(config);
    const client = await resolveS3Client(companyId, config);
    const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
    const internalPrefix = userPrefix ? `${scope}${userPrefix}/` : scope;
    const output = await client.send(new ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: internalPrefix,
      MaxKeys: limit,
    })) as { Contents?: Array<{ Key?: string; Size?: number; LastModified?: Date; ETag?: string }>; IsTruncated?: boolean };
    const objects: DataObjectMeta[] = (output.Contents ?? [])
      .filter((entry) => typeof entry.Key === "string" && !entry.Key!.endsWith("/"))
      .map((entry) => ({
        key: entry.Key!.slice(scope.length),
        size: Number(entry.Size ?? 0),
        etag: entry.ETag,
        lastModified: entry.LastModified instanceof Date ? entry.LastModified.toISOString() : undefined,
      }))
      .filter((entry) => entry.key.length > 0);
    return { objects, truncated: Boolean(output.IsTruncated) };
  }

  async function readObject(companyId: string, key: string): Promise<DataObjectContent> {
    const safeKey = normalizeObjectKey(key);
    const config = await deps.storageService.resolveActive(companyId);

    if (config.provider === "local_disk") {
      const baseLexical = resolveLocalDataRoot();
      const baseReal = await realpathOrSelf(fsAdapter, baseLexical);
      const rootLexical = localCompanyDir(baseLexical, companyId);
      await assertSafeTarget(fsAdapter, baseLexical, baseReal, rootLexical);
      const rootReal = await realpathOrSelf(fsAdapter, rootLexical);
      if (!isWithin(baseReal, rootReal)) throw badRequest("Invalid object key path");
      const filePath = resolveWithin(rootLexical, safeKey);
      await assertSafeTarget(fsAdapter, rootLexical, rootReal, filePath);
      const stat = await fsAdapter.stat(filePath);
      if (!stat || !stat.isFile()) throw notFound("Object not found");
      return {
        stream: fsAdapter.createReadStream(filePath),
        size: stat.size,
        contentType: contentTypeFor(safeKey),
        lastModified: stat.mtime.toISOString(),
      };
    }

    const scope = s3Scope(config);
    const client = await resolveS3Client(companyId, config);
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    try {
      const output = await client.send(new GetObjectCommand({
        Bucket: config.bucket,
        Key: `${scope}${safeKey}`,
      })) as {
        Body?: unknown; ContentType?: string; ContentLength?: number;
        ETag?: string; LastModified?: Date;
      };
      return {
        stream: await toReadable(output.Body),
        size: Number(output.ContentLength ?? 0),
        contentType: output.ContentType,
        etag: output.ETag,
        lastModified: output.LastModified instanceof Date ? output.LastModified.toISOString() : undefined,
      };
    } catch (err) {
      const code = (err as { name?: string }).name;
      if (code === "NoSuchKey" || code === "NotFound") throw notFound("Object not found");
      throw err;
    }
  }

  async function writeObject(
    companyId: string,
    key: string,
    body: Buffer,
    contentType?: string,
  ): Promise<DataObjectWriteResult> {
    const safeKey = normalizeObjectKey(key);
    const type = (contentType?.trim() || contentTypeFor(safeKey)).toLowerCase();
    const config = await deps.storageService.resolveActive(companyId);

    if (config.provider === "local_disk") {
      const baseLexical = resolveLocalDataRoot();
      const baseReal = await realpathOrSelf(fsAdapter, baseLexical);
      const rootLexical = localCompanyDir(baseLexical, companyId);
      await assertSafeTarget(fsAdapter, baseLexical, baseReal, rootLexical);
      await fsAdapter.mkdir(rootLexical, { recursive: true });
      const rootReal = await realpathOrSelf(fsAdapter, rootLexical);
      if (!isWithin(baseReal, rootReal)) throw badRequest("Invalid object key path");
      const target = resolveWithin(rootLexical, safeKey);
      // Verify ancestry before creating any directories, then re-verify after,
      // so a planted symlink parent cannot cause an outside mutation first.
      await assertSafeTarget(fsAdapter, rootLexical, rootReal, target);
      await fsAdapter.mkdir(path.dirname(target), { recursive: true });
      await assertSafeTarget(fsAdapter, rootLexical, rootReal, target);
      const temp = `${target}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await fsAdapter.writeFile(temp, body);
      await fsAdapter.rename(temp, target);
      return { key: safeKey, size: body.length, contentType: type, etag: etagFor(body), lastModified: new Date().toISOString() };
    }

    const scope = s3Scope(config);
    const client = await resolveS3Client(companyId, config);
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: `${scope}${safeKey}`,
      Body: body,
      ContentType: type,
      ContentLength: body.length,
    }));
    return { key: safeKey, size: body.length, contentType: type, etag: etagFor(body), lastModified: new Date().toISOString() };
  }

  return { listObjects, readObject, writeObject };
}

export type CompanyDataObjectService = ReturnType<typeof createCompanyDataObjectService>;

async function toReadable(body: unknown): Promise<Readable> {
  if (!body) throw notFound("Object not found");
  if (body instanceof Readable) return body;
  const candidate = body as {
    transformToWebStream?: () => ReadableStream<Uint8Array>;
    arrayBuffer?: () => Promise<ArrayBuffer>;
  };
  if (typeof candidate.transformToWebStream === "function") {
    const webStream = candidate.transformToWebStream();
    const reader = webStream.getReader();
    return Readable.from((async function* () {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) yield value;
      }
    })());
  }
  if (typeof candidate.arrayBuffer === "function") {
    return Readable.from(Buffer.from(await candidate.arrayBuffer()));
  }
  throw badRequest("Unsupported object body");
}

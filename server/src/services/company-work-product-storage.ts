import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySecrets, companyWorkProductStorages } from "@paperclipai/db";
import {
  companyWorkProductStorageConfigSchema,
  type CompanyWorkProductStorageConfig,
} from "@paperclipai/shared/validators/company-work-product-storage";
import { unprocessable } from "../errors.js";
import { secretService } from "./secrets.js";

const LOCAL_DISK_CONFIG: CompanyWorkProductStorageConfig = { provider: "local_disk" };
const S3_TEST_ERROR = "Unable to verify S3 storage connection.";

type S3ClientLike = {
  send(command: unknown): Promise<unknown>;
};

type S3ClientConfig = {
  region: string;
  endpoint: string;
  forcePathStyle: boolean;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
  };
};

export type CompanyWorkProductStorageTestResult = {
  ok: boolean;
  provider: "local_disk" | "s3";
  error?: string;
};

export type CompanyWorkProductStorageDeps = {
  resolveSecretValue?: (
    companyId: string,
    secretId: string,
    version: number | "latest",
  ) => Promise<string>;
  createS3Client?: (config: S3ClientConfig) => Promise<S3ClientLike> | S3ClientLike;
};

export type CompanyWorkProductStorageService = {
  get(companyId: string): Promise<CompanyWorkProductStorageConfig>;
  save(
    companyId: string,
    config: CompanyWorkProductStorageConfig,
  ): Promise<CompanyWorkProductStorageConfig>;
  testConnection(companyId: string): Promise<CompanyWorkProductStorageTestResult>;
};

function parseConfig(config: CompanyWorkProductStorageConfig): CompanyWorkProductStorageConfig {
  const parsed = companyWorkProductStorageConfigSchema.safeParse(config);
  if (!parsed.success) throw unprocessable("Invalid company work-product storage configuration");
  return parsed.data;
}

function endpointHasCredentials(endpoint: string): boolean {
  const parsed = new URL(endpoint);
  return Boolean(parsed.username || parsed.password || parsed.search || parsed.hash);
}

function safeStoredConfig(
  row: typeof companyWorkProductStorages.$inferSelect | null,
): CompanyWorkProductStorageConfig {
  if (!row || row.provider !== "s3") return LOCAL_DISK_CONFIG;
  const parsed = companyWorkProductStorageConfigSchema.safeParse({
    provider: "s3",
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    keyPrefix: row.keyPrefix ?? undefined,
    forcePathStyle: row.forcePathStyle,
    accessKeySecretId: row.accessKeySecretId,
    secretAccessKeySecretId: row.secretAccessKeySecretId,
  });
  if (!parsed.success) return LOCAL_DISK_CONFIG;
  if (parsed.data.provider !== "s3") return LOCAL_DISK_CONFIG;
  if (endpointHasCredentials(parsed.data.endpoint)) return LOCAL_DISK_CONFIG;
  return parsed.data;
}

function probeKey(companyId: string, keyPrefix?: string): string {
  const suffix = `__papercompany_connection_check/${companyId}/${randomUUID()}`;
  const prefix = keyPrefix?.trim().replace(/^\/+|\/+$/g, "");
  return prefix ? `${prefix}/${suffix}` : suffix;
}

async function defaultS3Client(config: S3ClientConfig): Promise<S3ClientLike> {
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3Client(config) as unknown as S3ClientLike;
}

export function createCompanyWorkProductStorageService(
  db: Db,
  deps: CompanyWorkProductStorageDeps = {},
): CompanyWorkProductStorageService {
  const resolveSecretValue = deps.resolveSecretValue ?? secretService(db).resolveSecretValue;
  const createS3Client = deps.createS3Client ?? defaultS3Client;

  async function get(companyId: string): Promise<CompanyWorkProductStorageConfig> {
    const row = await db
      .select()
      .from(companyWorkProductStorages)
      .where(eq(companyWorkProductStorages.companyId, companyId))
      .then((rows) => rows[0] ?? null);
    return safeStoredConfig(row);
  }

  async function assertSecretReferences(
    companyId: string,
    accessKeySecretId: string,
    secretAccessKeySecretId: string,
  ) {
    const ids = [...new Set([accessKeySecretId, secretAccessKeySecretId])];
    const secrets = await db
      .select({ id: companySecrets.id, companyId: companySecrets.companyId })
      .from(companySecrets)
      .where(inArray(companySecrets.id, ids));
    const sameCompanyIds = new Set(
      secrets.filter((secret) => secret.companyId === companyId).map((secret) => secret.id),
    );
    if (!ids.every((id) => sameCompanyIds.has(id))) {
      throw unprocessable("Storage secret references must exist and belong to the same company");
    }
  }

  async function save(
    companyId: string,
    config: CompanyWorkProductStorageConfig,
  ): Promise<CompanyWorkProductStorageConfig> {
    const parsed = parseConfig(config);
    if (parsed.provider === "local_disk") {
      await db.delete(companyWorkProductStorages).where(eq(companyWorkProductStorages.companyId, companyId));
      return LOCAL_DISK_CONFIG;
    }

    if (endpointHasCredentials(parsed.endpoint)) {
      throw unprocessable("Storage endpoint must not include credentials, query parameters, or fragments");
    }
    await assertSecretReferences(
      companyId,
      parsed.accessKeySecretId,
      parsed.secretAccessKeySecretId,
    );

    const now = new Date();
    const values = {
      companyId,
      provider: "s3",
      endpoint: parsed.endpoint,
      region: parsed.region,
      bucket: parsed.bucket,
      keyPrefix: parsed.keyPrefix ?? null,
      forcePathStyle: Boolean(parsed.forcePathStyle),
      accessKeySecretId: parsed.accessKeySecretId,
      secretAccessKeySecretId: parsed.secretAccessKeySecretId,
      updatedAt: now,
    } as const;
    await db
      .insert(companyWorkProductStorages)
      .values(values)
      .onConflictDoUpdate({
        target: companyWorkProductStorages.companyId,
        set: {
          provider: values.provider,
          endpoint: values.endpoint,
          region: values.region,
          bucket: values.bucket,
          keyPrefix: values.keyPrefix,
          forcePathStyle: values.forcePathStyle,
          accessKeySecretId: values.accessKeySecretId,
          secretAccessKeySecretId: values.secretAccessKeySecretId,
          updatedAt: now,
        },
      });
    return parsed;
  }

  async function testConnection(companyId: string): Promise<CompanyWorkProductStorageTestResult> {
    const config = await get(companyId);
    if (config.provider === "local_disk") return { ok: true, provider: "local_disk" };

    let client: S3ClientLike | undefined;
    let key: string | undefined;
    let putSucceeded = false;
    try {
      const [accessKeyId, secretAccessKey] = await Promise.all([
        resolveSecretValue(companyId, config.accessKeySecretId, "latest"),
        resolveSecretValue(companyId, config.secretAccessKeySecretId, "latest"),
      ]);
      client = await createS3Client({
        region: config.region,
        endpoint: config.endpoint,
        forcePathStyle: Boolean(config.forcePathStyle),
        credentials: { accessKeyId, secretAccessKey },
      });
      key = probeKey(companyId, config.keyPrefix);
      const { PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
      await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: "papercompany connection check",
        ContentType: "text/plain",
      }));
      putSucceeded = true;
      await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
      putSucceeded = false;
      return { ok: true, provider: "s3" };
    } catch {
      return { ok: false, provider: "s3", error: S3_TEST_ERROR };
    } finally {
      if (putSucceeded && client && key) {
        try {
          const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
          await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
        } catch {
          // Cleanup failure must not replace the safe connection diagnostic.
        }
      }
    }
  }

  return { get, save, testConnection };
}

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySecrets, companyDataStorages } from "@paperclipai/db";
import {
  companyDataStorageConfigSchema,
  type CompanyDataStorageConfig,
} from "@paperclipai/shared/validators/company-data-storage";
import { unprocessable } from "../errors.js";
import { secretService } from "./secrets.js";

const LOCAL_DISK_CONFIG: CompanyDataStorageConfig = { provider: "local_disk" };
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

export type CompanyDataStorageTestResult = {
  ok: boolean;
  provider: "local_disk" | "s3";
  error?: string;
};

export type CompanyDataStorageDeps = {
  resolveSecretValue?: (
    companyId: string,
    secretId: string,
    version: number | "latest",
  ) => Promise<string>;
  createS3Client?: (config: S3ClientConfig) => Promise<S3ClientLike> | S3ClientLike;
};

export type CompanyDataStorageService = {
  get(companyId: string): Promise<CompanyDataStorageConfig>;
  save(
    companyId: string,
    config: CompanyDataStorageConfig,
  ): Promise<CompanyDataStorageConfig>;
  testConnection(companyId: string): Promise<CompanyDataStorageTestResult>;
  resolveActive(companyId: string): Promise<CompanyDataStorageConfig>;
};

function parseConfig(config: CompanyDataStorageConfig): CompanyDataStorageConfig {
  const parsed = companyDataStorageConfigSchema.safeParse(config);
  if (!parsed.success) throw unprocessable("Invalid company data storage configuration");
  return parsed.data;
}

function endpointHasCredentials(endpoint: string): boolean {
  const parsed = new URL(endpoint);
  return Boolean(parsed.username || parsed.password || parsed.search || parsed.hash);
}

function safeStoredConfig(
  row: typeof companyDataStorages.$inferSelect | null,
): CompanyDataStorageConfig {
  if (!row || row.provider === "local_disk") return LOCAL_DISK_CONFIG;
  if (row.provider !== "s3") {
    throw unprocessable("Saved company data storage configuration is invalid; reconfigure the storage.");
  }
  const parsed = companyDataStorageConfigSchema.safeParse({
    provider: "s3",
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    keyPrefix: row.keyPrefix ?? undefined,
    forcePathStyle: row.forcePathStyle,
    accessKeySecretId: row.accessKeySecretId,
    secretAccessKeySecretId: row.secretAccessKeySecretId,
  });
  if (!parsed.success || parsed.data.provider !== "s3" || endpointHasCredentials(parsed.data.endpoint)) {
    throw unprocessable("Saved company data storage configuration is invalid; reconfigure the storage.");
  }
  return parsed.data;
}

function probeKey(companyId: string, keyPrefix?: string): string {
  const suffix = `__papercompany_data_connection_check/${companyId}/${randomUUID()}`;
  const prefix = keyPrefix?.trim().replace(/^\/+|\/+$/g, "");
  return prefix ? `${prefix}/${suffix}` : suffix;
}

async function defaultS3Client(config: S3ClientConfig): Promise<S3ClientLike> {
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3Client(config) as unknown as S3ClientLike;
}

export function createCompanyDataStorageService(
  db: Db,
  deps: CompanyDataStorageDeps = {},
): CompanyDataStorageService {
  const resolveSecretValue = deps.resolveSecretValue ?? secretService(db).resolveSecretValue;
  const createS3Client = deps.createS3Client ?? defaultS3Client;

  async function fetchRow(companyId: string) {
    return db
      .select()
      .from(companyDataStorages)
      .where(eq(companyDataStorages.companyId, companyId))
      .then((rows) => rows[0] ?? null);
  }

  async function get(companyId: string): Promise<CompanyDataStorageConfig> {
    return safeStoredConfig(await fetchRow(companyId));
  }

  async function resolveActive(companyId: string): Promise<CompanyDataStorageConfig> {
    return get(companyId);
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
    config: CompanyDataStorageConfig,
  ): Promise<CompanyDataStorageConfig> {
    const parsed = parseConfig(config);
    if (parsed.provider === "local_disk") {
      await db.delete(companyDataStorages).where(eq(companyDataStorages.companyId, companyId));
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
      .insert(companyDataStorages)
      .values(values)
      .onConflictDoUpdate({
        target: companyDataStorages.companyId,
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

  async function testConnection(companyId: string): Promise<CompanyDataStorageTestResult> {
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
        Body: "papercompany data connection check",
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

  return { get, save, testConnection, resolveActive };
}

import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  companySecrets,
  companyWorkProductStorages,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createCompanyWorkProductStorageService } from "../services/company-work-product-storage.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping company work-product storage tests: ${support.reason ?? "unsupported environment"}`);
}

describeDb("company work-product storage service", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-work-product-storage-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(companyWorkProductStorages);
    await db.delete(companySecrets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 }); await tempDb?.cleanup();
  });

  async function addCompany() {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: "Storage test company",
      issuePrefix: `S${id.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  async function addSecret(companyId: string, name: string) {
    const id = randomUUID();
    await db.insert(companySecrets).values({ id, companyId, name });
    return id;
  }

  function s3Config(accessKeySecretId: string, secretAccessKeySecretId: string) {
    return {
      provider: "s3" as const,
      endpoint: "https://objects.example.test:9000",
      region: "us-east-1",
      bucket: "work-products",
      keyPrefix: "companies/acme",
      forcePathStyle: true,
      accessKeySecretId,
      secretAccessKeySecretId,
    };
  }

  it("defaults to local disk and does not make a connection attempt", async () => {
    const companyId = await addCompany();
    const createS3Client = vi.fn();
    const resolveSecretValue = vi.fn();
    const service = createCompanyWorkProductStorageService(db, { createS3Client, resolveSecretValue });

    await expect(service.get(companyId)).resolves.toEqual({ provider: "local_disk" });
    await expect(service.testConnection(companyId)).resolves.toEqual({ ok: true, provider: "local_disk" });
    expect(createS3Client).not.toHaveBeenCalled();
    expect(resolveSecretValue).not.toHaveBeenCalled();
  });

  it("requires both secret references to belong to the company and removes an S3 profile for local disk", async () => {
    const companyId = await addCompany();
    const otherCompanyId = await addCompany();
    const accessKeySecretId = await addSecret(companyId, "access-key");
    const secretAccessKeySecretId = await addSecret(companyId, "secret-access-key");
    const foreignSecretId = await addSecret(otherCompanyId, "foreign-key");
    const service = createCompanyWorkProductStorageService(db);

    await expect(service.save(companyId, s3Config(accessKeySecretId, foreignSecretId))).rejects.toMatchObject({ status: 422 });
    await expect(service.save(companyId, {
      ...s3Config(accessKeySecretId, secretAccessKeySecretId),
      endpoint: "https://user:password@objects.example.test",
    })).rejects.toMatchObject({ status: 422 });
    await expect(service.save(companyId, {
      ...s3Config(accessKeySecretId, secretAccessKeySecretId),
      endpoint: "https://objects.example.test?accessKey=raw-access-key",
    })).rejects.toMatchObject({ status: 422 });

    await expect(service.save(companyId, s3Config(accessKeySecretId, secretAccessKeySecretId))).resolves.toEqual(
      s3Config(accessKeySecretId, secretAccessKeySecretId),
    );
    await expect(service.save(companyId, { provider: "local_disk" })).resolves.toEqual({ provider: "local_disk" });
    await expect(service.get(companyId)).resolves.toEqual({ provider: "local_disk" });
    await expect(db.select().from(companyWorkProductStorages)).resolves.toEqual([]);
  });

  it("probes S3 with resolved credentials and cleans up the check object", async () => {
    const companyId = await addCompany();
    const accessKeySecretId = await addSecret(companyId, "access-key");
    const secretAccessKeySecretId = await addSecret(companyId, "secret-access-key");
    const sent: unknown[] = [];
    const client = { send: vi.fn(async (command: unknown) => {
      sent.push(command);
      return {};
    }) };
    const resolveSecretValue = vi.fn(async (_companyId: string, secretId: string) =>
      secretId === accessKeySecretId ? "resolved-access-key" : "resolved-secret-access-key");
    const createS3Client = vi.fn(async (config) => client);
    const service = createCompanyWorkProductStorageService(db, { createS3Client, resolveSecretValue });

    await service.save(companyId, s3Config(accessKeySecretId, secretAccessKeySecretId));

    await expect(service.testConnection(companyId)).resolves.toEqual({ ok: true, provider: "s3" });
    expect(resolveSecretValue).toHaveBeenNthCalledWith(1, companyId, accessKeySecretId, "latest");
    expect(resolveSecretValue).toHaveBeenNthCalledWith(2, companyId, secretAccessKeySecretId, "latest");
    expect(createS3Client).toHaveBeenCalledWith({
      region: "us-east-1",
      endpoint: "https://objects.example.test:9000",
      forcePathStyle: true,
      credentials: {
        accessKeyId: "resolved-access-key",
        secretAccessKey: "resolved-secret-access-key",
      },
    });
    expect(sent).toHaveLength(3);
    expect(sent[0]).toBeInstanceOf(PutObjectCommand);
    expect(sent[1]).toBeInstanceOf(HeadObjectCommand);
    expect(sent[2]).toBeInstanceOf(DeleteObjectCommand);
    expect((sent[0] as PutObjectCommand).input).toMatchObject({
      Bucket: "work-products",
      Key: expect.stringContaining(`__papercompany_connection_check/${companyId}/`),
    });
  });

  it("returns a generic error without resolved credentials and still cleans up after a failed probe", async () => {
    const companyId = await addCompany();
    const accessKeySecretId = await addSecret(companyId, "access-key");
    const secretAccessKeySecretId = await addSecret(companyId, "secret-access-key");
    const accessValue = "resolved-access-key";
    const secretValue = "resolved-secret-access-key";
    const sent: unknown[] = [];
    const client = { send: vi.fn(async (command: unknown) => {
      sent.push(command);
      if (command instanceof HeadObjectCommand) throw new Error(`denied for ${accessValue}:${secretValue}`);
      return {};
    }) };
    const service = createCompanyWorkProductStorageService(db, {
      createS3Client: async () => client,
      resolveSecretValue: async (_companyId, secretId) => secretId === accessKeySecretId ? accessValue : secretValue,
    });

    await service.save(companyId, s3Config(accessKeySecretId, secretAccessKeySecretId));
    const result = await service.testConnection(companyId);

    expect(result).toEqual({ ok: false, provider: "s3", error: "Unable to verify S3 storage connection." });
    expect(JSON.stringify(result)).not.toContain(accessValue);
    expect(JSON.stringify(result)).not.toContain(secretValue);
    expect(sent.map((command) => command.constructor.name)).toEqual([
      "PutObjectCommand",
      "HeadObjectCommand",
      "DeleteObjectCommand",
    ]);
  });
});

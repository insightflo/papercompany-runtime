import { mkdtemp, rm, mkdir, symlink, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { createCompanyDataObjectService } from "../services/company-data-objects.js";
import { createDefaultLocalFs } from "../services/company-data-local-disk.js";
import { HttpError } from "../errors.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

type Captured = { Bucket?: string; Key?: string; Prefix?: string };

function s3Config(keyPrefix = "gazua") {
  return {
    provider: "s3" as const,
    endpoint: "https://objects.example.test:9000",
    region: "us-east-1",
    bucket: "shared-data",
    keyPrefix,
    forcePathStyle: true,
    accessKeySecretId: "ak-secret",
    secretAccessKeySecretId: "sak-secret",
  };
}

function makeS3Mock() {
  const sent: { ctor: string; input: Captured }[] = [];
  const client = {
    send: vi.fn(async (command: unknown) => {
      const ctor = (command as { constructor: { name: string } }).constructor.name;
      const input = (command as { input?: Captured }).input ?? {};
      sent.push({ ctor, input });
      if (command instanceof ListObjectsV2Command) {
        return { Contents: [{ Key: `${input.Prefix}latest.json`, Size: 7 }], IsTruncated: false };
      }
      if (command instanceof GetObjectCommand) {
        return { Body: Readable.from(Buffer.from('{"v":1}')), ContentType: "application/json", ContentLength: 7, ETag: '"e1"', LastModified: new Date("2026-07-16T00:00:00Z") };
      }
      return {};
    }),
  };
  return { client, sent };
}

function makeObjectService(opts: {
  config: ReturnType<typeof s3Config>;
  s3?: ReturnType<typeof makeS3Mock>;
  resolveLocalDataRoot?: () => string;
  fsAdapter?: ReturnType<typeof createDefaultLocalFs>;
}) {
  return createCompanyDataObjectService({} as never, {
    storageService: { resolveActive: async () => opts.config } as never,
    resolveSecretValue: async () => "resolved",
    createS3Client: async () => opts.s3!.client,
    resolveLocalDataRoot: opts.resolveLocalDataRoot,
    fsAdapter: opts.fsAdapter,
  });
}

describe("company data objects — S3 prefix mapping (no company UUID)", () => {
  const s3 = makeS3Mock();
  const service = makeObjectService({ config: s3Config("gazua"), s3 });

  it("lists physical keys under the configured prefix and exposes relative keys", async () => {
    const result = await service.listObjects(COMPANY_ID, { prefix: "blog-insights" });
    expect(s3.sent.at(-1)!.input.Prefix).toBe("gazua/blog-insights/");
    expect(result.objects.map((o) => o.key)).toEqual(["blog-insights/latest.json"]);
    expect(JSON.stringify(result.objects)).not.toContain(COMPANY_ID);
  });

  it("reads using the physical key prefix and exposes a relative key", async () => {
    const result = await service.readObject(COMPANY_ID, "blog-insights/latest.json");
    expect(s3.sent.at(-1)!.input.Key).toBe("gazua/blog-insights/latest.json");
    expect(result.size).toBe(7);
    expect(result.etag).toBe('"e1"');
  });

  it("writes using the physical key prefix and returns a relative key", async () => {
    const result = await service.writeObject(COMPANY_ID, "blog-insights/latest.json", Buffer.from('{"v":2}'));
    const write = s3.sent.at(-1)!;
    expect(write.ctor).toBe("PutObjectCommand");
    expect(write.input.Key).toBe("gazua/blog-insights/latest.json");
    expect(result.key).toBe("blog-insights/latest.json");
    expect(JSON.stringify(result)).not.toContain(COMPANY_ID);
  });

  it("rejects missing or unsafe physical company roots before an S3 command", async () => {
    for (const keyPrefix of ["", "../gazua", "gazua//macro"]) {
      const unsafe = makeS3Mock();
      const svc = makeObjectService({ config: s3Config(keyPrefix), s3: unsafe });
      await expect(
        svc.writeObject(COMPANY_ID, "macro/latest.json", Buffer.from("x")),
      ).rejects.toMatchObject({ status: 400 });
      expect(unsafe.sent).toHaveLength(0);
    }
  });
});

describe("company data objects — key/prefix normalization", () => {
  const s3 = makeS3Mock();
  const service = makeObjectService({ config: s3Config("gazua"), s3 });

  it("rejects parent-directory traversal in object keys", async () => {
    await expect(service.readObject(COMPANY_ID, "../escape.json")).rejects.toMatchObject({ status: 400 });
    await expect(service.writeObject(COMPANY_ID, "a/../../b.json", Buffer.from("x"))).rejects.toMatchObject({ status: 400 });
  });

  it("rejects absolute and empty keys", async () => {
    await expect(service.readObject(COMPANY_ID, "/etc/passwd")).rejects.toMatchObject({ status: 400 });
    await expect(service.readObject(COMPANY_ID, "")).rejects.toMatchObject({ status: 400 });
  });

  it("rejects control characters in object keys", async () => {
    await expect(service.readObject(COMPANY_ID, "macro/latest\n.json")).rejects.toMatchObject({ status: 400 });
  });
});

describe("company data objects — local disk provider", () => {
  let base: string;
  let service: ReturnType<typeof makeObjectService>;

  beforeAll(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), "paperclip-data-objects-"));
    service = makeObjectService({
      config: { provider: "local_disk" } as never,
      resolveLocalDataRoot: () => base,
      fsAdapter: createDefaultLocalFs(),
    });
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function drain(stream: Readable): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

  it("writes, lists, and reads back an object under the company-scoped local root", async () => {
    const written = await service.writeObject(COMPANY_ID, "macro/latest.json", Buffer.from('{"v":3}', "utf8"), "application/json");
    expect(written.key).toBe("macro/latest.json");
    expect(written.contentType).toBe("application/json");

    const listed = await service.listObjects(COMPANY_ID, { prefix: "macro" });
    expect(listed.objects.map((o) => o.key)).toContain("macro/latest.json");

    const content = await service.readObject(COMPANY_ID, "macro/latest.json");
    expect(await drain(content.stream)).toBe('{"v":3}');
    expect(content.contentType).toBe("application/json");
  });

  it("supports a history layout for change detection", async () => {
    await service.writeObject(COMPANY_ID, "macro/history/2026-07-16T00:00:00Z.json", Buffer.from('{"snap":1}'));
    const listed = await service.listObjects(COMPANY_ID, { prefix: "macro/history" });
    expect(listed.objects.map((o) => o.key)).toContain("macro/history/2026-07-16T00:00:00Z.json");
  });

  it("returns not-found for missing objects", async () => {
    await expect(service.readObject(COMPANY_ID, "macro/missing.json")).rejects.toMatchObject({ status: 404 });
  });
  it("rejects decoded company traversal before creating anything outside company-data", async () => {
    const decodedTraversal = decodeURIComponent("%2e%2e%2fescape");
    await expect(
      service.writeObject(decodedTraversal, "latest.json", Buffer.from("x")),
    ).rejects.toMatchObject({ status: 400 });
    await expect(stat(path.join(base, "escape", "latest.json"))).rejects.toThrow();
  });
});

describe("company data objects — symlink traversal protection", () => {
  let base: string;
  let service: ReturnType<typeof makeObjectService>;

  beforeAll(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), "paperclip-data-symlink-"));
    service = makeObjectService({
      config: { provider: "local_disk" } as never,
      resolveLocalDataRoot: () => base,
      fsAdapter: createDefaultLocalFs(),
    });
    // Seed a real object so the company root exists.
    await service.writeObject(COMPANY_ID, "real.json", Buffer.from("ok"));
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("rejects reading a symlinked object that escapes the company root", async () => {
    const companyRoot = path.join(base, "company-data", COMPANY_ID);
    const outside = path.join(base, "outside-secret.json");
    await writeFile(outside, "secret");
    await symlink(outside, path.join(companyRoot, "escaped.json"));

    await expect(service.readObject(COMPANY_ID, "escaped.json")).rejects.toMatchObject({ status: 400 });
  });

  it("rejects writing through a symlinked parent directory and does not mutate outside", async () => {
    const companyRoot = path.join(base, "company-data", COMPANY_ID);
    const outsideDir = path.join(base, "outside-dir");
    await mkdir(outsideDir, { recursive: true });
    await symlink(outsideDir, path.join(companyRoot, "linked-dir"));

    await expect(service.writeObject(COMPANY_ID, "linked-dir/payload.json", Buffer.from("x"))).rejects.toMatchObject({ status: 400 });
    // The symlinked parent must not have been used to create a file outside the root.
    await expect(stat(path.join(outsideDir, "payload.json"))).rejects.toThrow();
  });

  it("rejects listing when the prefix itself is a symlink that escapes the root", async () => {
    const companyRoot = path.join(base, "company-data", COMPANY_ID);
    const outsideListDir = path.join(base, "outside-list");
    await mkdir(outsideListDir, { recursive: true });
    await writeFile(path.join(outsideListDir, "leaked.json"), "leaked");
    await symlink(outsideListDir, path.join(companyRoot, "linked"));

    await expect(service.listObjects(COMPANY_ID, { prefix: "linked" })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects even an in-root symlink object (data objects must be regular files)", async () => {
    const companyRoot = path.join(base, "company-data", COMPANY_ID);
    await symlink(path.join(companyRoot, "real.json"), path.join(companyRoot, "alias.json"));
    await expect(service.readObject(COMPANY_ID, "alias.json")).rejects.toBeInstanceOf(HttpError);
  });
});

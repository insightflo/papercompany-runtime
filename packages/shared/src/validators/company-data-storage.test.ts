import { describe, expect, it } from "vitest";
import { companyDataStorageConfigSchema } from "./company-data-storage.js";

const validS3Input = {
  provider: "s3",
  endpoint: "https://objects.example.test:9000",
  region: "  us-east-1  ",
  bucket: "  company-shared-data  ",
  keyPrefix: "gazua",
  accessKeySecretId: "11111111-1111-4111-8111-111111111111",
  secretAccessKeySecretId: "22222222-2222-4222-8222-222222222222",
} as const;

describe("company data storage config", () => {
  it("accepts the local default config", () => {
    expect(companyDataStorageConfigSchema.parse({ provider: "local_disk" })).toEqual({
      provider: "local_disk",
    });
  });

  it("accepts an S3-compatible config, normalizes names, and defaults path style", () => {
    expect(companyDataStorageConfigSchema.parse(validS3Input)).toEqual({
      ...validS3Input,
      region: "us-east-1",
      bucket: "company-shared-data",
      forcePathStyle: false,
    });

    expect(companyDataStorageConfigSchema.safeParse({
      ...validS3Input,
      endpoint: "http://localhost:9000",
    }).success).toBe(true);
  });

  it("requires and normalizes a safe segment-only S3 company root", () => {
    const parsed = companyDataStorageConfigSchema.parse({
      ...validS3Input,
      keyPrefix: " /data/gazua/ ",
    });
    expect(parsed.provider).toBe("s3");
    if (parsed.provider !== "s3") throw new Error("Expected S3 config");
    expect(parsed.keyPrefix).toBe("data/gazua");

    for (const keyPrefix of ["", "/", "../gazua", "gazua/../other", "gazua//macro", "gazua/%2e%2e"]) {
      expect(companyDataStorageConfigSchema.safeParse({
        ...validS3Input,
        keyPrefix,
      }).success).toBe(false);
    }
  });

  it("requires every S3 connection and secret reference field", () => {
    const requiredFields = [
      "endpoint",
      "region",
      "bucket",
      "keyPrefix",
      "accessKeySecretId",
      "secretAccessKeySecretId",
    ] as const;

    for (const field of requiredFields) {
      const input: Record<string, unknown> = { ...validS3Input };
      delete input[field];
      expect(companyDataStorageConfigSchema.safeParse(input).success).toBe(false);
    }
  });

  it("rejects invalid endpoints and secret IDs", () => {
    expect(companyDataStorageConfigSchema.safeParse({
      ...validS3Input,
      endpoint: "ftp://objects.example.test",
    }).success).toBe(false);
    expect(companyDataStorageConfigSchema.safeParse({
      ...validS3Input,
      endpoint: "/relative-endpoint",
    }).success).toBe(false);
    expect(companyDataStorageConfigSchema.safeParse({
      ...validS3Input,
      accessKeySecretId: "not-a-uuid",
    }).success).toBe(false);
  });

  it("rejects raw secret material and unknown fields", () => {
    expect(companyDataStorageConfigSchema.safeParse({
      ...validS3Input,
      accessKey: "not-allowed",
    }).success).toBe(false);
    expect(companyDataStorageConfigSchema.safeParse({
      ...validS3Input,
      secretAccessKey: "not-allowed",
    }).success).toBe(false);
    expect(companyDataStorageConfigSchema.safeParse({
      ...validS3Input,
      unexpected: true,
    }).success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { companyWorkProductStorageConfigSchema } from "./company-work-product-storage.js";

const validS3Input = {
  provider: "s3",
  endpoint: "https://objects.example.test:9000",
  region: "  us-east-1  ",
  bucket: "  company-work-products  ",
  keyPrefix: "companies/acme/work-products",
  accessKeySecretId: "11111111-1111-4111-8111-111111111111",
  secretAccessKeySecretId: "22222222-2222-4222-8222-222222222222",
} as const;

describe("company work-product storage config", () => {
  it("accepts the local default config", () => {
    expect(companyWorkProductStorageConfigSchema.parse({ provider: "local_disk" })).toEqual({
      provider: "local_disk",
    });
  });

  it("accepts an S3-compatible config, normalizes names, and defaults path style", () => {
    expect(companyWorkProductStorageConfigSchema.parse(validS3Input)).toEqual({
      ...validS3Input,
      region: "us-east-1",
      bucket: "company-work-products",
      forcePathStyle: false,
    });

    expect(companyWorkProductStorageConfigSchema.safeParse({
      ...validS3Input,
      endpoint: "http://localhost:9000",
    }).success).toBe(true);
  });

  it("requires every S3 connection and secret reference field", () => {
    const requiredFields = [
      "endpoint",
      "region",
      "bucket",
      "accessKeySecretId",
      "secretAccessKeySecretId",
    ] as const;

    for (const field of requiredFields) {
      const input: Record<string, unknown> = { ...validS3Input };
      delete input[field];
      expect(companyWorkProductStorageConfigSchema.safeParse(input).success).toBe(false);
    }
  });

  it("rejects invalid endpoints and secret IDs", () => {
    expect(companyWorkProductStorageConfigSchema.safeParse({
      ...validS3Input,
      endpoint: "ftp://objects.example.test",
    }).success).toBe(false);
    expect(companyWorkProductStorageConfigSchema.safeParse({
      ...validS3Input,
      endpoint: "/relative-endpoint",
    }).success).toBe(false);
    expect(companyWorkProductStorageConfigSchema.safeParse({
      ...validS3Input,
      accessKeySecretId: "not-a-uuid",
    }).success).toBe(false);
  });

  it("rejects raw secret material and unknown fields", () => {
    expect(companyWorkProductStorageConfigSchema.safeParse({
      ...validS3Input,
      accessKey: "not-allowed",
    }).success).toBe(false);
    expect(companyWorkProductStorageConfigSchema.safeParse({
      ...validS3Input,
      secretAccessKey: "not-allowed",
    }).success).toBe(false);
    expect(companyWorkProductStorageConfigSchema.safeParse({
      ...validS3Input,
      unexpected: true,
    }).success).toBe(false);
  });
});

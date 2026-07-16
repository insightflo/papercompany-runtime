import { z } from "zod";

const httpEndpointSchema = z.string().url().refine((value) => {
  try {
    const endpoint = new URL(value);
    return (endpoint.protocol === "http:" || endpoint.protocol === "https:") && Boolean(endpoint.hostname);
  } catch {
    return false;
  }
}, "Endpoint must be an absolute HTTP(S) URL.");
const KEY_PREFIX_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function normalizeCompanyDataStorageKeyPrefix(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

export function isSafeCompanyDataStorageKeyPrefix(value: string): boolean {
  const normalized = normalizeCompanyDataStorageKeyPrefix(value);
  if (!normalized) return false;
  return normalized.split("/").every((segment) =>
    segment !== "." &&
    segment !== ".." &&
    KEY_PREFIX_SEGMENT.test(segment)
  );
}

const keyPrefixSchema = z.string()
  .transform(normalizeCompanyDataStorageKeyPrefix)
  .refine(isSafeCompanyDataStorageKeyPrefix, {
    message: "Key prefix must be a non-empty slash-separated company root without traversal segments.",
  });


const localDiskStorageConfigSchema = z.object({
  provider: z.literal("local_disk"),
}).strict();

const s3StorageConfigSchema = z.object({
  provider: z.literal("s3"),
  endpoint: httpEndpointSchema,
  region: z.string().trim().min(1),
  bucket: z.string().trim().min(1),
  keyPrefix: keyPrefixSchema,
  forcePathStyle: z.boolean().optional().default(false),
  accessKeySecretId: z.string().uuid(),
  secretAccessKeySecretId: z.string().uuid(),
}).strict();

export const companyDataStorageConfigSchema = z.discriminatedUnion("provider", [
  localDiskStorageConfigSchema,
  s3StorageConfigSchema,
]);

export type CompanyDataStorageConfig = z.infer<typeof companyDataStorageConfigSchema>;

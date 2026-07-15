import { z } from "zod";

const httpEndpointSchema = z.string().url().refine((value) => {
  try {
    const endpoint = new URL(value);
    return (endpoint.protocol === "http:" || endpoint.protocol === "https:") && Boolean(endpoint.hostname);
  } catch {
    return false;
  }
}, "Endpoint must be an absolute HTTP(S) URL.");

const localDiskStorageConfigSchema = z.object({
  provider: z.literal("local_disk"),
}).strict();

const s3StorageConfigSchema = z.object({
  provider: z.literal("s3"),
  endpoint: httpEndpointSchema,
  region: z.string().trim().min(1),
  bucket: z.string().trim().min(1),
  keyPrefix: z.string().optional(),
  forcePathStyle: z.boolean().optional().default(false),
  accessKeySecretId: z.string().uuid(),
  secretAccessKeySecretId: z.string().uuid(),
}).strict();

export const companyWorkProductStorageConfigSchema = z.discriminatedUnion("provider", [
  localDiskStorageConfigSchema,
  s3StorageConfigSchema,
]);

export type CompanyWorkProductStorageConfig = z.infer<typeof companyWorkProductStorageConfigSchema>;

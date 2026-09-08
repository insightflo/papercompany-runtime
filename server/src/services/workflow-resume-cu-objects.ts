import path from "node:path";
import { eq } from "drizzle-orm";
import { companyWorkProductStorages, type Db } from "@paperclipai/db";
import { companyWorkProductStorageConfigSchema } from "@paperclipai/shared/validators/company-work-product-storage";
import { secretService } from "./secrets.js";
import { fail, objectKey, parse, OBJECT_CAP } from "./workflow-resume-cu-contract.js";
import { directoryChain, readRegular } from "./workflow-resume-cu-files.js";

export type CuObjectReader = (companyId: string, key: string, cap?: number) => Promise<Buffer>;
/** Logical CU keys are not generic StorageService company-prefixed keys.
 * Callers first derive an exact job-specific allowlist from versioned contracts.
 * Config/credentials belong solely to the server; no request endpoint/root override.
 */
export function createCuObjectReader(db: Db): CuObjectReader {
  return async (companyId, key, cap = OBJECT_CAP) => {
    parse(objectKey, key);
    const [row] = await db.select().from(companyWorkProductStorages).where(eq(companyWorkProductStorages.companyId, companyId));
    if (!row || row.provider === "local_disk") {
      const root = process.env.PAPERCLIP_CU_LOCAL_OBJECT_ROOT;
      if (!root || !path.isAbsolute(root)) fail("cu_evidence_unavailable", 503);
      await directoryChain(root, true);
      return readRegular(path.join(root, key), cap);
    }
    const configured = companyWorkProductStorageConfigSchema.safeParse({ provider: row.provider,
      endpoint: row.endpoint, region: row.region, bucket: row.bucket, forcePathStyle: row.forcePathStyle,
      accessKeySecretId: row.accessKeySecretId, secretAccessKeySecretId: row.secretAccessKeySecretId,
      keyPrefix: row.keyPrefix ?? undefined });
    // Use the same company storage contract, but never downgrade broken S3 configuration to local.
    if (!configured.success || configured.data.provider !== "s3") fail("cu_evidence_unavailable", 503);
    const config = configured.data, endpoint = new URL(config.endpoint);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) fail("cu_evidence_unavailable", 503);
    const prefix = config.keyPrefix?.replace(/^\/+|\/+$/g, "");
    if (prefix) parse(objectKey, prefix);
    const secrets = secretService(db);
    const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: await secrets.resolveSecretValue(companyId, config.accessKeySecretId, "latest"),
        secretAccessKey: await secrets.resolveSecretValue(companyId, config.secretAccessKeySecretId, "latest") } });
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: prefix ? `${prefix}/${key}` : key }));
      if ((response.ContentLength ?? 0) > cap) fail("cu_evidence_limit", 422);
      if (!response.Body) fail("cu_evidence_io", 422);
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        size += chunk.length; if (size > cap) fail("cu_evidence_limit", 422);
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks, size);
    } finally { client.destroy(); }
  };
}

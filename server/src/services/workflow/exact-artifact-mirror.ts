import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { CompanyWorkProductStorageConfig } from "@paperclipai/shared/validators/company-work-product-storage";
import { sha, fail } from "../workflow-resume-cu-contract.js";
import { safeWorkProductPathSegment } from "../work-products/output-paths.js";
import type { WorkflowArtifactMirrorDeps, WorkflowArtifactStorageMirror } from "./artifact-mirror.js";
import { EXACT_RESULT_CAP, EXACT_RESULT_TITLE, type ExactProducer } from "./exact-artifact-validation.js";

async function boundedBody(body: unknown): Promise<Buffer> {
  if (body instanceof Uint8Array) {
    if (!body.length || body.length > EXACT_RESULT_CAP) fail("cu_artifact_readback_failed", 503);
    return Buffer.from(body);
  }
  if (!body || typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") fail("cu_artifact_readback_failed", 503);
  const chunks: Buffer[] = []; let size = 0;
  // No transformToByteArray: enforce the cap while consuming, including unknown ContentLength.
  for await (const chunk of body as AsyncIterable<unknown>) {
    if (!(chunk instanceof Uint8Array)) fail("cu_artifact_readback_failed", 503);
    size += chunk.length;
    if (size > EXACT_RESULT_CAP) fail("cu_artifact_readback_failed", 503);
    chunks.push(Buffer.from(chunk));
  }
  if (!size) fail("cu_artifact_readback_failed", 503);
  return Buffer.concat(chunks, size);
}

/** Isolated exact-only key/readback contract. Legacy mirror still performs its single PUT. */
export async function mirrorExactArtifact(config: CompanyWorkProductStorageConfig, producer: ExactProducer,
  bytes: Buffer, deps: WorkflowArtifactMirrorDeps): Promise<WorkflowArtifactStorageMirror | null> {
  if (config.provider === "local_disk") return null;
  try {
    const objectKey = [config.keyPrefix?.trim().replace(/^\/+|\/+$/g, ""), "companies", producer.companyId,
      "workflow-runs", producer.workflowRunId, "steps", safeWorkProductPathSegment(producer.stepId),
      "attempts", producer.stepRunId, "generations", String(producer.executionGeneration), "submissions",
      producer.submissionId, EXACT_RESULT_TITLE].filter(Boolean).join("/");
    const [accessKeyId, secretAccessKey] = await Promise.all([
      deps.resolveSecretValue(producer.companyId, config.accessKeySecretId, "latest"),
      deps.resolveSecretValue(producer.companyId, config.secretAccessKeySecretId, "latest"),
    ]);
    const client = await (deps.createS3Client ?? (settings => new S3Client(settings)))({ endpoint: config.endpoint,
      region: config.region, forcePathStyle: Boolean(config.forcePathStyle), credentials: { accessKeyId, secretAccessKey } });
    await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: objectKey, Body: bytes,
      ContentType: "application/json", ContentLength: bytes.length }));
    const fetched = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: objectKey })) as
      { Body?: unknown; ContentLength?: number } | undefined;
    if (!fetched || (fetched.ContentLength !== undefined && fetched.ContentLength > EXACT_RESULT_CAP)) fail("cu_artifact_readback_failed", 503);
    if (sha(await boundedBody(fetched.Body)) !== sha(bytes)) fail("cu_artifact_readback_failed", 503);
    return { provider: "s3", endpoint: config.endpoint, bucket: config.bucket, objectKey };
  } catch {
    // No provider diagnostics, credentials, result bytes, or private paths escape.
    fail("cu_artifact_readback_failed", 503);
  }
}

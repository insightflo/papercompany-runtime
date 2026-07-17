import { readFile } from "node:fs/promises";
import path from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { CompanyWorkProductStorageConfig } from "@paperclipai/shared/validators/company-work-product-storage";
import { unprocessable } from "../../errors.js";
import { isPathInsideOrEqual, safeWorkProductPathSegment } from "../work-products/output-paths.js";

type S3ClientLike = { send(command: unknown): Promise<unknown> };

type S3ClientConfig = {
  endpoint: string;
  region: string;
  forcePathStyle: boolean;
  credentials: { accessKeyId: string; secretAccessKey: string };
};

export type WorkflowArtifactMirrorDeps = {
  resolveSecretValue: (companyId: string, secretId: string, version: number | "latest") => Promise<string>;
  createS3Client?: (config: S3ClientConfig) => S3ClientLike | Promise<S3ClientLike>;
};

export type WorkflowArtifactStorageMirror = {
  provider: "s3";
  endpoint: string;
  bucket: string;
  objectKey: string;
};

function normalizePrefix(prefix: string | undefined) {
  return prefix?.trim().replace(/^\/+|\/+$/g, "") ?? "";
}

function contentTypeFor(fileName: string) {
  switch (path.extname(fileName).toLowerCase()) {
    case ".json": return "application/json";
    case ".md": return "text/markdown; charset=utf-8";
    case ".html": return "text/html; charset=utf-8";
    case ".csv": return "text/csv; charset=utf-8";
    case ".txt": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

function objectKeyFor(
  config: Extract<CompanyWorkProductStorageConfig, { provider: "s3" }>,
  input: { companyId: string; workflowRunId?: string | null; stepId?: string | null; artifactPath: string },
) {
  const segments = [
    normalizePrefix(config.keyPrefix),
    "companies",
    safeWorkProductPathSegment(input.companyId),
    "workflow-runs",
    safeWorkProductPathSegment(input.workflowRunId ?? "manual"),
    "steps",
    safeWorkProductPathSegment(input.stepId ?? "unknown"),
    safeWorkProductPathSegment(path.basename(input.artifactPath)),
  ].filter(Boolean);
  return segments.join("/");
}

async function defaultS3Client(config: S3ClientConfig): Promise<S3ClientLike> {
  return new S3Client(config) as unknown as S3ClientLike;
}

export async function mirrorWorkflowArtifactToCompanyStorage(
  config: CompanyWorkProductStorageConfig,
  input: {
    companyId: string;
    workflowRunId?: string | null;
    stepId?: string | null;
    stepOutputDir: string;
    artifactPath: string;
  },
  deps: WorkflowArtifactMirrorDeps,
): Promise<WorkflowArtifactStorageMirror | null> {
  if (config.provider === "local_disk") return null;
  if (!isPathInsideOrEqual(input.artifactPath, input.stepOutputDir)) {
    throw unprocessable("Workflow artifact must be inside the step output directory");
  }

  return uploadLocalArtifactToCompanyStorage(config, input, deps);
}

export async function mirrorRegisteredWorkflowArtifactToCompanyStorage(
  config: CompanyWorkProductStorageConfig,
  input: {
    companyId: string;
    workflowRunId?: string | null;
    stepId?: string | null;
    artifactPath: string;
  },
  deps: WorkflowArtifactMirrorDeps,
): Promise<WorkflowArtifactStorageMirror | null> {
  if (config.provider === "local_disk") return null;
  if (!path.isAbsolute(input.artifactPath)) {
    throw unprocessable("Registered workflow artifact must use an absolute local path");
  }
  return uploadLocalArtifactToCompanyStorage(config, input, deps);
}

async function uploadLocalArtifactToCompanyStorage(
  config: Extract<CompanyWorkProductStorageConfig, { provider: "s3" }>,
  input: {
    companyId: string;
    workflowRunId?: string | null;
    stepId?: string | null;
    artifactPath: string;
  },
  deps: WorkflowArtifactMirrorDeps,
): Promise<WorkflowArtifactStorageMirror> {
  const [accessKeyId, secretAccessKey, body] = await Promise.all([
    deps.resolveSecretValue(input.companyId, config.accessKeySecretId, "latest"),
    deps.resolveSecretValue(input.companyId, config.secretAccessKeySecretId, "latest"),
    readFile(input.artifactPath),
  ]);
  const createS3Client = deps.createS3Client ?? defaultS3Client;
  const client = await createS3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: Boolean(config.forcePathStyle),
    credentials: { accessKeyId, secretAccessKey },
  });
  const fileName = path.basename(input.artifactPath);
  const objectKey = objectKeyFor(config, input);
  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: objectKey,
    Body: body,
    ContentType: contentTypeFor(fileName),
    ContentLength: body.length,
  }));
  return {
    provider: "s3",
    endpoint: config.endpoint,
    bucket: config.bucket,
    objectKey,
  };
}

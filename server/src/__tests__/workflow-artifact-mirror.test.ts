import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import {
  agentToolGrants,
  agents,
  companies,
  companySecrets,
  companyWorkProductStorages,
  createDb,
  missions,
  toolDefinitions,
  workflowDefinitions,
  workflowRuns,
} from "@paperclipai/db";
import type { CompanyWorkProductStorageConfig } from "@paperclipai/shared/validators/company-work-product-storage";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import { mirrorWorkflowArtifactToCompanyStorage } from "../services/workflow/artifact-mirror.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const ARTIFACT = { date: "2026-07-16", findings: ["one"] };
const RESULT = { ok: true, count: 1 };
const HTTP_CONFIG = {
  url: "https://n8n.example.test/webhook/collect",
  method: "POST",
  auth: { type: "header", headerName: "X-Key", secretId: "tool-secret", version: "latest" },
  response: { resultField: "result", artifactField: "artifact", artifactFileName: "result.json", artifactPathResultField: "artifactPath" },
};

function s3Config(): CompanyWorkProductStorageConfig {
  return {
    provider: "s3", endpoint: "https://storage.example.test", region: "us-east-1", bucket: "work-products",
    keyPrefix: "research-company", forcePathStyle: true,
    accessKeySecretId: randomUUID(), secretAccessKeySecretId: randomUUID(),
  };
}

function createS3Client() {
  return { send: vi.fn(async () => ({})) };
}

describe("workflow artifact mirror", () => {
  const directories: string[] = [];

  afterEach(() => {
    while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
  });

  it("mirrors a step artifact to the configured S3-compatible storage", async () => {
    const stepOutputDir = mkdtempSync(join(tmpdir(), "workflow-artifact-"));
    directories.push(stepOutputDir);
    const artifactPath = join(stepOutputDir, "result.json");
    writeFileSync(artifactPath, JSON.stringify(ARTIFACT));
    const config = s3Config();
    const client = createS3Client();
    const createClient = vi.fn(async () => client);
    const resolveSecretValue = vi.fn(async (_companyId: string, secretId: string) =>
      secretId === config.accessKeySecretId ? "ACCESS" : "SECRET");

    await mirrorWorkflowArtifactToCompanyStorage(
      config,
      { companyId: "company-1", workflowRunId: "run-1", stepId: "collect", stepOutputDir, artifactPath },
      { createS3Client: createClient, resolveSecretValue },
    );

    expect(createClient).toHaveBeenCalledWith({
      endpoint: config.endpoint, region: config.region, forcePathStyle: true,
      credentials: { accessKeyId: "ACCESS", secretAccessKey: "SECRET" },
    });
    const command = client.send.mock.calls[0]?.[0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input.Bucket).toBe("work-products");
    expect(command.input.Key).toBe("research-company/companies/company-1/workflow-runs/run-1/steps/collect/result.json");
    expect(Buffer.from(command.input.Body as Uint8Array).toString()).toBe(JSON.stringify(ARTIFACT));
  });

  it("keeps local storage as a no-op mirror", async () => {
    const stepOutputDir = mkdtempSync(join(tmpdir(), "workflow-artifact-local-"));
    directories.push(stepOutputDir);
    const artifactPath = join(stepOutputDir, "result.json");
    writeFileSync(artifactPath, JSON.stringify(ARTIFACT));
    const createClient = vi.fn();

    await mirrorWorkflowArtifactToCompanyStorage(
      { provider: "local_disk" },
      { companyId: "company-1", workflowRunId: "run-1", stepId: "collect", stepOutputDir, artifactPath },
      { createS3Client: createClient, resolveSecretValue: vi.fn() },
    );

    expect(createClient).not.toHaveBeenCalled();
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("remote workflow artifact storage", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const directories: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-artifact-mirror-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(agentToolGrants); await db.delete(toolDefinitions); await db.delete(companyWorkProductStorages);
    await db.delete(companySecrets); await db.delete(workflowRuns); await db.delete(workflowDefinitions);
    await db.delete(missions); await db.delete(agents); await db.delete(companies);
    while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
  });

  afterAll(async () => { await tempDb?.cleanup(); });

  it("mirrors an HTTP tool artifact after keeping its local workflow path", async () => {
    const companyId = randomUUID(); const agentId = randomUUID(); const runId = randomUUID();
    const missionId = randomUUID(); const workflowId = randomUUID(); const toolId = randomUUID();
    const accessKeySecretId = randomUUID(); const secretAccessKeySecretId = randomUUID();
    const root = mkdtempSync(join(tmpdir(), "workflow-artifact-dispatch-")); directories.push(root);
    await db.insert(companies).values({ id: companyId, name: "Storage Co", issuePrefix: "STO", workProductRoot: root, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Operator", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "Artifact mirror" });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "mirror" });
    await db.insert(workflowRuns).values({ id: runId, workflowId, companyId, missionId, status: "running", triggeredBy: "test" });
    await db.insert(companySecrets).values([
      { id: accessKeySecretId, companyId, name: "S3 access key", provider: "local_encrypted" },
      { id: secretAccessKeySecretId, companyId, name: "S3 secret key", provider: "local_encrypted" },
    ]);
    await db.insert(companyWorkProductStorages).values({ companyId, provider: "s3", endpoint: "https://storage.example.test", region: "us-east-1", bucket: "work-products", keyPrefix: "research-company", forcePathStyle: true, accessKeySecretId, secretAccessKeySecretId });
    await db.insert(toolDefinitions).values({ id: toolId, companyId, name: "collect-http", description: "collect", adapterType: "http", adapterConfig: HTTP_CONFIG });
    await db.insert(agentToolGrants).values({ companyId, agentId, toolId, grantedBy: "board" });
    const client = createS3Client();

    const result = await executeCoreWorkflowTool({
      db, companyId, agentId, toolName: "collect-http", parameters: {}, requestId: "artifact-mirror", workflowRunId: runId, stepId: "collect",
      remoteDeps: {
        fetchImpl: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ result: RESULT, artifact: ARTIFACT }), text: async () => "" })) as never,
        resolveSecretValue: async () => "storage-secret",
        artifactMirrorDeps: { createS3Client: async () => client },
      } as never,
    });

    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject(RESULT);
    const artifactPath = (result.body.data as Record<string, unknown>).artifactPath;
    expect(typeof artifactPath).toBe("string");
    expect(readFileSync(artifactPath as string, "utf8")).toBe(JSON.stringify(ARTIFACT));
    expect(client.send).toHaveBeenCalledTimes(1);
  });
});

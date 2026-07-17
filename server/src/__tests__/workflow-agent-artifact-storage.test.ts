import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import {
  agents,
  companies,
  companySecrets,
  companyWorkProductStorages,
  createDb,
  issueWorkProducts,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkflowApiActor } from "../services/workflow/agent-api.js";
import { registerWorkflowArtifactWithStorage } from "../services/workflow/registered-artifact-storage.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("workflow agent artifact storage", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-agent-storage-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
    tempDirs.clear();
    await db.delete(workflowTransitionEvents);
    await db.delete(issueWorkProducts);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(issues);
    await db.delete(workflowDefinitions);
    await db.delete(missions);
    await db.delete(companyWorkProductStorages);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("mirrors the local working file before registering the workflow workProduct", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const issueId = randomUUID();
    const accessKeySecretId = randomUUID();
    const secretAccessKeySecretId = randomUUID();
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-workflow-s3-root-"));
    tempDirs.add(root);

    await db.insert(companies).values({
      id: companyId,
      name: "Gazua",
      issuePrefix: "GAZ",
      workProductRoot: root,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Reporter",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "Evening report" });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "gazua-evening",
      stepsJson: [{ id: "produce-report", name: "Produce report", dependencies: [] }],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "test",
      status: "running",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      identifier: "GAZ-1",
      title: "Produce report",
      status: "in_progress",
      originKind: "workflow_execution",
      originRunId: workflowRunId,
      assigneeAgentId: agentId,
      startedAt: new Date("2026-07-17T00:00:00.000Z"),
    });
    await db.insert(workflowStepRuns).values({
      id: randomUUID(),
      workflowRunId,
      stepId: "produce-report",
      issueId,
      status: "running",
      startedAt: new Date("2026-07-17T00:00:01.000Z"),
    });
    await db.insert(companySecrets).values([
      { id: accessKeySecretId, companyId, name: "S3 access key", provider: "local_encrypted" },
      { id: secretAccessKeySecretId, companyId, name: "S3 secret key", provider: "local_encrypted" },
    ]);
    await db.insert(companyWorkProductStorages).values({
      companyId,
      provider: "s3",
      endpoint: "https://storage.example.test",
      region: "us-east-1",
      bucket: "work-products",
      keyPrefix: "gazua",
      forcePathStyle: true,
      accessKeySecretId,
      secretAccessKeySecretId,
    });

    const artifactPath = path.join(
      root,
      "missions",
      missionId,
      "runs",
      workflowRunId,
      "steps",
      "produce-report",
      "report.md",
    );
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, "# Mirrored Report\n", "utf8");
    const client = { send: vi.fn(async () => ({})) };
    const actor: WorkflowApiActor = { actorType: "agent", actorId: agentId, agentId, runId: null };
    const mirrorDeps = {
      resolveSecretValue: vi.fn(async (_companyId: string, secretId: string) =>
        secretId === accessKeySecretId ? "ACCESS" : "SECRET"),
      createS3Client: vi.fn(async () => client),
    };

    const product = await registerWorkflowArtifactWithStorage({
      db,
      issue: (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!,
      actor,
      data: { path: artifactPath, title: "report.md", type: "document", isPrimary: true },
      artifactMirrorDeps: mirrorDeps,
    });

    expect(client.send).toHaveBeenCalledTimes(1);
    const command = client.send.mock.calls[0]?.[0] as PutObjectCommand;
    const expectedKey = `gazua/companies/${companyId}/workflow-runs/${workflowRunId}/steps/produce-report/report.md`;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({ Bucket: "work-products", Key: expectedKey });
    expect(Buffer.from(command.input.Body as Uint8Array).toString()).toBe("# Mirrored Report\n");
    expect(product).toMatchObject({
      provider: "local_file",
      metadata: { path: artifactPath, storageMirror: { provider: "s3", bucket: "work-products", objectKey: expectedKey } },
    });

    const failedArtifactPath = path.join(path.dirname(artifactPath), "upload-failed.md");
    await writeFile(failedArtifactPath, "# Must Not Register\n", "utf8");
    client.send.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(registerWorkflowArtifactWithStorage({
      db,
      issue: (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!,
      actor,
      data: { path: failedArtifactPath, title: "upload-failed.md", type: "document", isPrimary: false },
      artifactMirrorDeps: mirrorDeps,
    })).rejects.toThrow("storage unavailable");

    const rows = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issueId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalId).toBe(artifactPath);
  });
});

import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  agents, companies, createDb, heartbeatRuns, issues, missions, runDatabaseBackup,
  workflowDefinitions, workflowRuns,
} from "@paperclipai/db";
import { workProductService } from "../../services/work-products.js";
import { startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";

export async function startRuntimeReadinessRestoreFixture() {
  const source = await startEmbeddedPostgresTestDatabase("runtime-readiness-restore-");
  const sourceDb = createDb(source.connectionString);
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime-readiness-files-"));
  const liveRoot = path.join(root, "live");
  const fileSnapshot = path.join(root, "file-snapshot");
  const backupDir = path.join(root, "database-backup");

  async function createEmptyDatabase(label: string) {
    const name = `rr_${label}_${randomUUID().replaceAll("-", "")}`;
    await sourceDb.$client.unsafe(`CREATE DATABASE "${name}"`);
    const url = new URL(source.connectionString);
    url.pathname = `/${name}`;
    return url.toString();
  }

  async function seedMission() {
    const companyId = randomUUID(), agentId = randomUUID(), missionId = randomUUID();
    const issueId = randomUUID(), heartbeatRunId = randomUUID();
    await mkdir(liveRoot, { recursive: true });
    await sourceDb.insert(companies).values({ id: companyId, name: "Restore", issuePrefix: randomUUID(), workProductRoot: liveRoot });
    await sourceDb.insert(agents).values({ id: agentId, companyId, name: "Owner", status: "active", adapterType: "codex_local" });
    await sourceDb.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "Restore mission",
      status: "active", startedAt: new Date("2026-10-28T00:00:00.000Z"), description: "Created automatically for workflow run: restore" });
    const [definition] = await sourceDb.insert(workflowDefinitions).values({ companyId, name: "Restore flow", stepsJson: [] }).returning();
    await sourceDb.insert(workflowRuns).values({ companyId, missionId, workflowId: definition.id, status: "completed",
      triggeredBy: "test", startedAt: new Date("2026-10-28T00:00:00.000Z"), completedAt: new Date("2026-10-28T00:01:00.000Z") });
    await sourceDb.insert(issues).values({ id: issueId, companyId, missionId, title: "Produced", originKind: "workflow_execution",
      status: "done", assigneeAgentId: agentId, completedAt: new Date("2026-10-28T00:01:00.000Z") });
    await sourceDb.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId, agentId, issueId, status: "completed",
      finishedAt: new Date("2026-10-28T00:01:00.000Z") });
    const artifactPath = path.join(liveRoot, "missions", missionId, "report.json");
    const bytes = Buffer.from('{"status":"complete","version":1}');
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const product = await workProductService(sourceDb).createForIssue(issueId, companyId, {
      provider: "local_file", type: "document", title: "report.json", status: "active", isPrimary: true,
      createdByRunId: heartbeatRunId, metadata: { path: artifactPath, sha256 },
    });
    return { companyId, agentId, missionId, issueId, heartbeatRunId, artifactPath, bytes, sha256, productId: product!.id };
  }

  async function snapshot() {
    const backup = await runDatabaseBackup({ connectionString: source.connectionString, backupDir, retentionDays: 1 });
    await cp(liveRoot, fileSnapshot, { recursive: true });
    return backup;
  }

  async function restoreFilesToOriginalMount() {
    await rm(liveRoot, { recursive: true, force: true });
    await cp(fileSnapshot, liveRoot, { recursive: true });
  }

  return {
    sourceDb, sourceConnectionString: source.connectionString, liveRoot, seedMission, snapshot,
    createEmptyDatabase, restoreFilesToOriginalMount,
    readArtifact: (file: string) => readFile(file),
    cleanup: async () => {
      await sourceDb.$client.end({ timeout: 5 });
      await source.cleanup();
      await rm(root, { recursive: true, force: true });
    },
  };
}

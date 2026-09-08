import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll } from "vitest";
import {
  activityLog, agentRuntimeState, agentTaskSessions, agentWakeupRequests, agents,
  companies, companySecrets, companySkills, createDb,
  heartbeatRunFinalizations, heartbeatRunFinalizationSteps,
  instanceSettings, issueComments, issueWorkProducts, issues, missionAgentRuntimes,
  missions, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";
import { assertNoHeartbeatWriters, resetControlNodeBoundary } from "./workflow-control-node-boundary.js";

export function useControlNodeFixture() {
  let db: ReturnType<typeof createDb> | undefined;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let artifactRoot = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-control-node-");
    db = createDb(tempDb.connectionString);
    artifactRoot = await mkdtemp(path.join(tmpdir(), "paperclip-control-node-artifacts-"));
    await db.insert(instanceSettings).values({
      singletonKey: "default", general: {},
      experimental: { enableHeartbeatFinalizationV1: true },
    } as never);
  }, 60_000);

  afterEach(async () => {
    if (!db) return;
    await assertNoHeartbeatWriters(db);
    resetControlNodeBoundary();
    await db.delete(agentTaskSessions);
    await db.delete(missionAgentRuntimes);
    await db.delete(workflowTransitionEvents);
    await db.delete(activityLog);
    await db.update(issues).set({ checkoutRunId: null, executionRunId: null });
    await db.delete(heartbeatRunFinalizationSteps);
    await db.delete(heartbeatRunFinalizations);
    await db.delete(agentWakeupRequests);
    await db.delete(issueWorkProducts);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    try {
      await db?.$client.end({ timeout: 5 });
    } finally {
      try { await tempDb?.cleanup(); }
      finally { if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true }); }
    }
  });

  return {
    get db() { if (!db) throw new Error("Control-node DB is not initialized"); return db; },
    get artifactRoot() { return artifactRoot; },
  };
}

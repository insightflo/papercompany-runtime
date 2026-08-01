import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueWorkProducts,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { submitMissionOwnerDecision } from "../services/missions/mission-owner-recovery-agent-api.js";

// Regression for INF-181: the owner registered INF-180's existing artifact, submitted the
// structured recover_artifact decision, then blocked the owner-action because no source resume
// had been dispatched. Exercise the decision producer, not the handback helper directly.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping recover-artifact-resume tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEP("recover_artifact decision lifecycle", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recover-artifact-resume-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Recover Artifact Resume Co",
      issuePrefix: `RA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    // Worker agent: mission owner + source assignee + recover_artifact decision author.
    //   active + wakeOnDemand(default true) so the guarded native resume wake queues. This is a
    //   regular executor, NOT the Hermes operations liaison, so the generic heartbeat deferral
    //   for operations-mission issues does not apply (and must not be weakened).
    agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "writer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });


  async function seedBlockedSourceWithStepRun() {
    const missionId = randomUUID();
    const ownerHeartbeatRunId = randomUUID();
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Recover artifact mission",
      status: "active",
    });
    const workflowId = randomUUID();
    const workflowRunId = randomUUID();
    const stepRunId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Source workflow",
      stepsJson: [{ id: "src", name: "Source step", agentId, dependencies: [] }],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "running",
      startedAt: new Date(),
    });
    const [source] = await db
      .insert(issues)
      .values({
        companyId,
        missionId,
        title: "Blocked source",
        status: "blocked",
        originKind: "workflow_execution",
        assigneeAgentId: agentId,
      })
      .returning({ id: issues.id });
    await db.insert(workflowStepRuns).values({
      id: stepRunId,
      workflowRunId,
      stepId: "src",
      issueId: source.id,
      status: "running",
      startedAt: new Date(),
    });
    const [unblock] = await db
      .insert(issues)
      .values({
        companyId,
        missionId,
        title: "Unblock action",
        status: "in_progress",
        originKind: "mission_main_executor_unblock",
        originId: source.id,
        assigneeAgentId: agentId,
      })
      .returning({ id: issues.id });
    await db.insert(heartbeatRuns).values({
      id: ownerHeartbeatRunId,
      companyId,
      agentId,
      issueId: unblock.id,
      status: "running",
      startedAt: new Date(),
      createdAt: new Date(),
    });
    await db
      .update(issues)
      .set({ checkoutRunId: ownerHeartbeatRunId, executionRunId: ownerHeartbeatRunId })
      .where(eq(issues.id, unblock.id));
    return { source, unblock, missionId, workflowRunId, stepRunId, ownerHeartbeatRunId };
  }

  async function registerWorkProduct(sourceId: string, verified = true) {
    const workProductId = randomUUID();
    await db.insert(issueWorkProducts).values({
      id: workProductId,
      companyId,
      issueId: sourceId,
      type: "file",
      provider: "local",
      title: "Recovered artifact",
      externalId: `/tmp/recovered-${workProductId}.json`,
      status: "active",
      isPrimary: true,
      metadata: { path: `/tmp/recovered-${workProductId}.json` },
    });
    if (verified) {
      await db.insert(activityLog).values({
        companyId,
        actorType: "agent",
        actorId: "workflow-agent-api",
        action: "issue.workflow_artifact_registered",
        entityType: "issue",
        entityId: sourceId,
        details: { workProductId },
      });
    }
  }

  async function submitRecoverArtifact(
    seed: Awaited<ReturnType<typeof seedBlockedSourceWithStepRun>>,
  ) {
    return submitMissionOwnerDecision({
      db,
      issueId: seed.unblock.id,
      actor: {
        actorType: "agent",
        actorId: agentId,
        agentId,
        runId: seed.ownerHeartbeatRunId,
      },
      data: { decision: "recover_artifact", sourceIssueRef: seed.source.id },
    });
  }

  it("decision submission wakes the source exactly once when official evidence exists", async () => {
    const seed = await seedBlockedSourceWithStepRun();
    const { source, unblock } = seed;
    await registerWorkProduct(source.id);

    await submitRecoverArtifact(seed);

    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.issueId, source.id));
    const nativeWakes = wakes.filter((wake) => wake.reason === "workflow_step_runnable");
    expect(nativeWakes).toHaveLength(1);
    const nativeWake = nativeWakes[0] ?? null;
    expect(nativeWake).not.toBeNull();
    const payload = (nativeWake?.payload ?? {}) as Record<string, unknown>;
    expect(payload.mutation).toBe("workflow_resume");

    const [unblockAfter] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, unblock.id))
      .limit(1);
    expect(unblockAfter?.status).toBe("done");
    const [ownerRun] = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, seed.ownerHeartbeatRunId));
    expect(ownerRun).toEqual({ status: "running", errorCode: null });
  });

  it("decision submission does not resume without Workflow API registration evidence", async () => {
    const seed = await seedBlockedSourceWithStepRun();
    const { source, unblock } = seed;
    await registerWorkProduct(source.id, false);

    await submitRecoverArtifact(seed);

    const wakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.issueId, source.id));
    expect(wakes).toHaveLength(0);

    const [unblockAfter] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, unblock.id))
      .limit(1);
    expect(unblockAfter?.status).toBe("in_progress");
  });
});

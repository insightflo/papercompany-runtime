import { randomUUID } from "node:crypto";
import { and, eq, gte } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueWorkProducts,
  issues,
  missions,
  workflowDefinitions,
  workflowDelegations,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { reconcileRecoveredWorkflowStep } from "../services/missions/recovery-closeout.js";
import { startDelegatedWorkflowStep } from "../services/workflow-delegations.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip workflow provenance direct-writer integration tests: ${support.reason ?? "unsupported"}`);

describeEP("workflow step-status provenance direct writers", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workflow-step-provenance-direct-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("records recovery closeout's failed-to-completed physical flip", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const producerIssueId = randomUUID();
    const qaIssueId = randomUUID();
    const producerStepRunId = randomUUID();
    const qaStepRunId = randomUUID();
    const artifactAt = new Date("2026-07-30T12:00:00.000Z");

    await db.insert(companies).values({ id: companyId, name: "Recovery provenance", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "owner", role: "owner" });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "Recovery", status: "active" });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Recovery workflow",
      stepsJson: [
        { id: "producer", name: "Produce", dependencies: [] },
        { id: "qa", name: "QA Review", dependencies: ["producer"] },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      companyId,
      missionId,
      workflowId,
      status: "running",
      triggeredBy: "test",
      startedAt: artifactAt,
    });
    await db.insert(issues).values([
      { id: producerIssueId, companyId, missionId, title: "Producer", status: "done" },
      { id: qaIssueId, companyId, missionId, title: "QA", status: "in_review" },
    ]);
    await db.insert(workflowStepRuns).values([
      { id: producerStepRunId, workflowRunId: runId, stepId: "producer", issueId: producerIssueId, status: "failed" },
      { id: qaStepRunId, workflowRunId: runId, stepId: "qa", issueId: qaIssueId, status: "running" },
    ]);
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId: producerIssueId,
      type: "artifact",
      provider: "test",
      title: "Recovered artifact",
      status: "active",
      updatedAt: artifactAt,
    });
    await db.insert(workflowTransitionEvents).values({
      companyId,
      missionId,
      workflowRunId: runId,
      workflowStepRunId: qaStepRunId,
      issueId: qaIssueId,
      eventType: "workflow_validation_verdict",
      layer: "workflow_validation",
      verdict: "pass",
      createdAt: new Date(artifactAt.getTime() + 1),
    });

    await expect(reconcileRecoveredWorkflowStep(db, {
      companyId,
      missionId,
      qaGateIssueId: qaIssueId,
    })).resolves.toMatchObject({ reconciled: true, workflowStepRunId: producerStepRunId });

    const events = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowStepRunId, producerStepRunId),
      eq(workflowTransitionEvents.eventType, "workflow_step_status_transition"),
    ));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromStatus: "failed", toStatus: "completed", reasonCode: "workflow_agent_api" });
  });

  it("records delegation restoration when it terminalizes a source step", async () => {
    const sourceCompanyId = randomUUID();
    const targetCompanyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const stepRunId = randomUUID();
    const sourceIssueId = randomUUID();
    const targetIssueId = randomUUID();
    const now = new Date();

    await db.insert(companies).values([
      { id: sourceCompanyId, name: "Source", status: "active", issuePrefix: `SRC${sourceCompanyId.slice(0, 6)}` },
      { id: targetCompanyId, name: "Target", status: "active", issuePrefix: `TGT${targetCompanyId.slice(0, 6)}` },
    ]);
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId: sourceCompanyId, name: "Delegation", stepsJson: [] });
    await db.insert(workflowRuns).values({ id: runId, companyId: sourceCompanyId, workflowId, status: "running", triggeredBy: "test", startedAt: now });
    await db.insert(issues).values([
      { id: sourceIssueId, companyId: sourceCompanyId, title: "Source", status: "in_review" },
      { id: targetIssueId, companyId: targetCompanyId, title: "Target", status: "done" },
    ]);
    await db.insert(workflowStepRuns).values({ id: stepRunId, workflowRunId: runId, stepId: "delegate", status: "running" });
    await db.insert(workflowDelegations).values({
      sourceCompanyId,
      sourceWorkflowRunId: runId,
      sourceWorkflowStepRunId: stepRunId,
      sourceIssueId,
      targetCompanyId,
      targetIssueId,
      status: "completed",
      completedAt: now,
    });

    await expect(startDelegatedWorkflowStep({
      db,
      run: { id: runId, companyId: sourceCompanyId, missionId: null },
      definition: { id: workflowId } as never,
      step: { id: "delegate" } as never,
      stepRun: (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)))[0]!,
      args: { targetCompanyId },
      now,
    })).resolves.toBe(true);

    const [event] = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowStepRunId, stepRunId),
      eq(workflowTransitionEvents.eventType, "workflow_step_status_transition"),
      gte(workflowTransitionEvents.createdAt, now),
    ));
    expect(event).toMatchObject({ fromStatus: "running", toStatus: "completed", reasonCode: "workflow_delegation" });
  });
});

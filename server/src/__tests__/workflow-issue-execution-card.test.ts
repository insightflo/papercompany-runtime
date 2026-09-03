import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueExecutionCards,
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

const heartbeatWakeup = vi.fn();

vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return {
    ...actual,
    heartbeatService: () => ({ wakeup: heartbeatWakeup }),
  };
});

import { executeWorkflowRun } from "../services/workflow/dag-engine.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("workflow issue execution cards", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-cards-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    heartbeatWakeup.mockReset();
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueExecutionCards);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("creates a structured execution card and passes its hash to the wakeup context", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-run" });
    await db.insert(companies).values({
      id: companyId,
      name: "Execution Card Co",
      issuePrefix: "ECC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Producer",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Card mission",
      status: "active",
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Card workflow",
      stepsJson: [{
        id: "produce",
        name: "Produce artifact",
        agentId,
        dependencies: [],
        description: "Create the report.",
        graphWorkProductRequired: true,
      }],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      missionId,
      triggeredBy: "system",
      status: "pending",
    });

    await executeWorkflowRun(db, runId);

    const [issue] = await db.select().from(issues).where(eq(issues.originRunId, runId));
    if (!issue) throw new Error("workflow issue was not created");
    const [card] = await db.select().from(issueExecutionCards).where(eq(issueExecutionCards.issueId, issue.id));
    if (!card) throw new Error("execution card was not created");

    expect(card.workflowRunId).toBe(runId);
    expect(card.cardJson.workflow?.stepId).toBe("produce");
    expect(card.cardJson.requiredOutputs.workProduct.required).toBe(true);
    expect(heartbeatWakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      contextSnapshot: expect.objectContaining({
        paperclipIssueExecutionCardHash: card.contentHash,
        paperclipIssueExecutionCard: expect.objectContaining({
          requiredOutputs: expect.objectContaining({
            workProduct: expect.objectContaining({ required: true }),
          }),
        }),
      }),
    }));
  });

  it("records the step dispatch contract in the execution card as a structured field", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-run" });
    await db.insert(companies).values({
      id: companyId,
      name: "Step Contract Co",
      issuePrefix: "SCC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Producer",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Step contract workflow",
      stepsJson: [
        {
          id: "produce",
          name: "Produce artifact",
          agentId,
          dependencies: [],
          description: "Create the report.",
          graphWorkProductRequired: true,
          contract: {
            preconditions: ["Upstream brief exists", "", "  "],
            postconditions: ["Report registers a workProduct"],
            undefinedBehaviors: ["If the data source is unreachable the content is undefined — report blocked"],
          },
        },
      ],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "system",
      status: "pending",
    });

    await executeWorkflowRun(db, runId);

    const [issue] = await db.select().from(issues).where(eq(issues.originRunId, runId));
    if (!issue) throw new Error("workflow issue was not created");
    const [card] = await db.select().from(issueExecutionCards).where(eq(issueExecutionCards.issueId, issue.id));
    if (!card) throw new Error("execution card was not created");

    // Structured record: trimmed, empty items dropped, exact sections preserved.
    expect(card.cardJson.stepContract).toEqual({
      preconditions: ["Upstream brief exists"],
      postconditions: ["Report registers a workProduct"],
      undefinedBehaviors: ["If the data source is unreachable the content is undefined — report blocked"],
    });
  });

  it("resyncs a workflow issue execution card when the issue contract changes", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-run" });
    await db.insert(companies).values({
      id: companyId,
      name: "Execution Card Resync Co",
      issuePrefix: "ECR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Producer",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "Card resync workflow",
      stepsJson: [{
        id: "publish",
        name: "Publish artifact",
        agentId,
        dependencies: [],
        description: "Publish the page.",
        graphWorkProductRequired: false,
      }],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "system",
      status: "pending",
    });
    await executeWorkflowRun(db, runId);

    const [issue] = await db.select().from(issues).where(eq(issues.originRunId, runId));
    if (!issue) throw new Error("workflow issue was not created");
    const [beforeCard] = await db.select().from(issueExecutionCards).where(eq(issueExecutionCards.issueId, issue.id));
    if (!beforeCard) throw new Error("execution card was not created");

    await issueService(db).update(issue.id, {
      description: `${issue.description ?? ""}\n\nDelivery Verification:\n- Read back the public URL.`,
    });

    const [afterCard] = await db.select().from(issueExecutionCards).where(eq(issueExecutionCards.issueId, issue.id));
    if (!afterCard) throw new Error("execution card was not resynced");
    expect(afterCard.contentHash).not.toBe(beforeCard.contentHash);
    expect(afterCard.cardJson.requiredOutputs.deliveryReadback.required).toBe(false);

    const [resyncActivity] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue_execution_card.resynced"));
    expect(resyncActivity?.entityId).toBe(issue.id);
    expect(resyncActivity?.details).toMatchObject({
      previousHash: beforeCard.contentHash,
      nextHash: afterCard.contentHash,
      workflowRunId: runId,
      workflowDefinitionId: workflowId,
      stepId: "publish",
    });
  });

  it("omits stepContract from the execution card when the step declares no contract", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();

    heartbeatWakeup.mockResolvedValue({ id: "queued-run" });
    await db.insert(companies).values({
      id: companyId,
      name: "No Contract Co",
      issuePrefix: "NCC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Producer",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId,
      companyId,
      name: "No contract workflow",
      stepsJson: [{
        id: "publish",
        name: "Publish artifact",
        agentId,
        dependencies: [],
        description: "Publish the page.",
        graphWorkProductRequired: false,
      }],
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      triggeredBy: "system",
      status: "pending",
    });
    await executeWorkflowRun(db, runId);

    const [issue] = await db.select().from(issues).where(eq(issues.originRunId, runId));
    if (!issue) throw new Error("workflow issue was not created");
    const [card] = await db.select().from(issueExecutionCards).where(eq(issueExecutionCards.issueId, issue.id));
    if (!card) throw new Error("execution card was not created");

    expect(card.cardJson.stepContract).toBeUndefined();
  });
});

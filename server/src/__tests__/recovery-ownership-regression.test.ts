// RES-1315 regression: active QA recovery 중 oversight 가 producer 를 재오픈/재wakeup 하지 않음 증명.
// DB-backed(embedded postgres). retry_source_issue case 의 resolveRecoveryOwnership gate 검증.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueWorkProducts,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { missionService } from "../services/missions.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping recovery ownership regression test: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

type Seed = {
  companyId: string;
  ownerAgentId: string;
  missionId: string;
  workflowRunId: string;
  producerIssueId: string;
  qaGateIssueId: string;
  unblockIssueId: string;
};

async function seedLiveQaRecovery(
  db: ReturnType<typeof createDb>,
  liveRecoveryTarget: "qa" | "unblock" | "none" = "qa",
): Promise<Seed> {
  const companyId = randomUUID();
  const ownerAgentId = randomUUID();
  const missionId = randomUUID();
  const workflowDefinitionId = randomUUID();
  const workflowRunId = randomUUID();
  const producerIssueId = randomUUID();
  const qaGateIssueId = randomUUID();
  const unblockIssueId = randomUUID();
  const producerStepRunId = randomUUID();
  const qaStepRunId = randomUUID();
  const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`;

  await db.insert(companies).values({
    id: companyId,
    name: "RES1315 Co",
    issuePrefix,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: ownerAgentId, companyId, name: "Owner", role: "ceo", status: "active",
    adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
  });
  await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "RES-1315 mission", status: "active" });
  await db.insert(workflowDefinitions).values({
    id: workflowDefinitionId, companyId, name: "produce+qa",
    stepsJson: [
      { id: "produce", name: "Produce", dependencies: [] },
      { id: "qa", name: "QA", dependencies: ["produce"], type: "qa" },
    ],
  });
  await db.insert(workflowRuns).values({
    id: workflowRunId, workflowId: workflowDefinitionId, companyId, missionId, status: "running", triggeredBy: "system",
  });
  await db.insert(issues).values([
    {
      id: producerIssueId, companyId, missionId, identifier: `${issuePrefix}-1315`, title: "Producer",
      status: "done", assigneeAgentId: ownerAgentId, originKind: "workflow_execution",
      originId: workflowRunId, originRunId: workflowRunId, completedAt: new Date("2026-07-12T09:00:00.000Z"),
    },
    {
      id: qaGateIssueId, companyId, missionId, identifier: `${issuePrefix}-1316`, title: "QA gate",
      status: "blocked", assigneeAgentId: ownerAgentId, originKind: "workflow_execution",
      originId: workflowRunId, originRunId: workflowRunId,
    },
    {
      id: unblockIssueId, companyId, missionId, identifier: `${issuePrefix}-1317`, title: "[Unblock] QA gate",
      status: "todo", assigneeAgentId: ownerAgentId, originKind: "mission_main_executor_unblock",
      originId: qaGateIssueId,
    },
  ]);
  await db.insert(workflowStepRuns).values([
    { id: producerStepRunId, workflowRunId, stepId: "produce", issueId: producerIssueId, status: "completed", startedAt: new Date("2026-07-12T08:50:00.000Z"), completedAt: new Date("2026-07-12T09:00:00.000Z") },
    { id: qaStepRunId, workflowRunId, stepId: "qa", issueId: qaGateIssueId, status: "pending", startedAt: new Date("2026-07-12T09:05:00.000Z") },
  ]);
  await db.insert(issueWorkProducts).values({
    id: randomUUID(), companyId, issueId: producerIssueId, type: "document", provider: "local",
    externalId: "/tmp/producer.md", title: "producer.md", status: "active", reviewState: "none",
    isPrimary: true, healthStatus: "unknown", metadata: { path: "/tmp/producer.md" },
  });
  // owner decision on unblock → retry_source_issue(QA gate source).
  await db.insert(issueComments).values({
    id: randomUUID(), companyId, issueId: unblockIssueId, authorAgentId: ownerAgentId,
    body: `### Mission owner decision\nDecision: retry_source_issue\nSource issue: ${issuePrefix}-1316\nReason: re-run QA after producer fix\nNext action: rerun validator\nEvidence: producer artifact updated`,
    createdAt: new Date("2026-07-12T09:30:00.000Z"),
  });
  if (liveRecoveryTarget !== "none") {
    const issueId = liveRecoveryTarget === "qa" ? qaGateIssueId : unblockIssueId;
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(), companyId, agentId: ownerAgentId, source: "test", reason: "mission_validation_request_changes",
      status: "queued", issueId, missionId, payload: { issueId },
    });
  }

  return { companyId, ownerAgentId, missionId, workflowRunId, producerIssueId, qaGateIssueId, unblockIssueId };
}

describeEmbeddedPostgres("RES-1315: oversight observe-only while QA recovery is live", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-res1315-regression-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  it("does not reopen the producer and dispatches no producer retry wakeup while QA recovery is live", async () => {
    const seed = await seedLiveQaRecovery(db);
    const dispatched: Array<{ sourceIssueId?: string }> = [];
    const svc = missionService(db, {
      onOwnerDecisionRetrySourceIssueApplied: async (input: { sourceIssue: { id: string } }) => {
        dispatched.push({ sourceIssueId: input.sourceIssue.id });
        return { status: "dispatched" as const };
      },
    });

    const result = await svc.runActiveMissionOwnerSupervision({
      staleAfterMinutes: 30,
      applySafeActions: true,
      applyOwnerDecisionActions: true,
      dispatchOwnerDecisionWakeups: true,
      dispatchStaleSourceIssueWakeups: false,
      now: new Date("2026-07-12T10:00:00.000Z"),
    });

    const missionResult = result.missions.find((m) => m.missionId === seed.missionId);
    const producerAfter = await db.select().from(issues).where(eq(issues.id, seed.producerIssueId)).then((r) => r[0]);

    // producer must stay done(DAG-recovered) — not reopened by oversight.
    expect(producerAfter?.status).toBe("done");
    // no retry applied to the producer.
    expect(dispatched.some((d) => d.sourceIssueId === seed.producerIssueId)).toBe(false);
    // finding documents observe-only.
    expect(missionResult?.findings.some((f) => f.includes("owner_action_qa_recovery_owned"))).toBe(true);
  });

  it("does not treat a running owner action as live QA recovery", async () => {
    const seed = await seedLiveQaRecovery(db, "none");
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: seed.companyId,
      agentId: seed.ownerAgentId,
      issueId: seed.unblockIssueId,
      status: "running",
      startedAt: new Date("2026-07-12T09:31:00.000Z"),
    });
    const dispatched: string[] = [];
    const svc = missionService(db, {
      onOwnerDecisionRetrySourceIssueApplied: async ({ sourceIssue }) => {
        dispatched.push(sourceIssue.id);
        return { status: "dispatched" as const };
      },
    });

    const result = await svc.runMainExecutorSupervision({
      missionId: seed.missionId,
      staleAfterMinutes: 30,
      applySafeActions: true,
      applyOwnerDecisionActions: true,
      dispatchOwnerDecisionWakeups: true,
    });
    const qaAfter = await db.select().from(issues).where(eq(issues.id, seed.qaGateIssueId)).then((rows) => rows[0]);

    expect(qaAfter?.status).toBe("todo");
    expect(dispatched).toEqual([seed.qaGateIssueId]);
    expect(result.findings.some((finding) => finding.includes("owner_action_qa_recovery_owned"))).toBe(false);
  });

  it("does not treat a queued owner action wakeup as live QA recovery", async () => {
    const seed = await seedLiveQaRecovery(db, "unblock");
    const dispatched: string[] = [];
    const svc = missionService(db, {
      onOwnerDecisionRetrySourceIssueApplied: async ({ sourceIssue }) => {
        dispatched.push(sourceIssue.id);
        return { status: "dispatched" as const };
      },
    });

    const result = await svc.runMainExecutorSupervision({
      missionId: seed.missionId,
      staleAfterMinutes: 30,
      applySafeActions: true,
      applyOwnerDecisionActions: true,
      dispatchOwnerDecisionWakeups: true,
    });
    const qaAfter = await db.select().from(issues).where(eq(issues.id, seed.qaGateIssueId)).then((rows) => rows[0]);

    expect(qaAfter?.status).toBe("todo");
    expect(dispatched).toEqual([seed.qaGateIssueId]);
    expect(result.findings.some((finding) => finding.includes("owner_action_qa_recovery_owned"))).toBe(false);
  });

  it("settles a blocked owner action after its QA source is done during an active workflow", async () => {
    const seed = await seedLiveQaRecovery(db, "none");
    await db.update(issues).set({ status: "done", completedAt: new Date("2026-07-12T09:32:00.000Z") }).where(eq(issues.id, seed.qaGateIssueId));
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, seed.unblockIssueId));

    await missionService(db).runMainExecutorSupervision({
      missionId: seed.missionId,
      staleAfterMinutes: 30,
      applySafeActions: true,
      applyOwnerDecisionActions: false,
    });

    const unblockAfter = await db.select().from(issues).where(eq(issues.id, seed.unblockIssueId)).then((rows) => rows[0]);

    expect(unblockAfter?.status).toBe("done");
  });
});

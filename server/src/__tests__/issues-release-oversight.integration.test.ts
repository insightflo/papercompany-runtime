import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, createDb, heartbeatRuns, issues, operatorDecisionContinuations } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { issueService } from "../services/issues.js";
import { operatorDecisionContinuationWorker } from "../services/operator-decision-continuation-worker.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
import { ensureQaSourceDefectOwnerCard } from "../services/workflow/qa-source-defect-owner-card.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { FINDINGS_SOURCE_ONLY, seedQaSourceDefectScenario } from "./helpers/qa-source-defect-seed.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip oversight release tests: ${support.reason ?? "unsupported"}`);

describeDb("oversight release preserves the continuation owner", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("oversight-release-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  async function checkedOutScenario(originKind = "mission_main_executor_oversight") {
    const seed = await seedQaSourceDefectScenario(db, FINDINGS_SOURCE_ONLY);
    const checkoutRunId = randomUUID();
    await db.update(issues).set({ originKind }).where(eq(issues.id, seed.oversightIssueId));
    await db.insert(heartbeatRuns).values({
      id: checkoutRunId, companyId: seed.companyId, agentId: seed.ownerId,
      issueId: seed.oversightIssueId, status: "running",
    });
    const checkedOut = await issueService(db).checkout(seed.oversightIssueId, seed.ownerId, ["todo"], checkoutRunId);
    expect(checkedOut).toMatchObject({ status: "in_progress", checkoutRunId, executionRunId: checkoutRunId });
    // Admission sets this timestamp separately from checkout; exercise clearing a non-null lock.
    const executionLockedAt = new Date();
    await db.update(issues).set({ executionLockedAt }).where(eq(issues.id, seed.oversightIssueId));
    return { ...seed, checkoutRunId, executionLockedAt };
  }

  it.each(["agent", "board"] as const)("%s release keeps the oversight owner but clears execution ownership", async (actor) => {
    const seed = await checkedOutScenario();
    const released = actor === "agent"
      ? await issueService(db).release(seed.oversightIssueId, seed.ownerId, seed.checkoutRunId)
      : await issueService(db).release(seed.oversightIssueId);
    const expected = {
      status: "todo", assigneeAgentId: seed.ownerId,
      checkoutRunId: null, executionRunId: null, executionLockedAt: null,
    };
    expect(released).toMatchObject(expected);
    const [persisted] = await db.select().from(issues).where(eq(issues.id, seed.oversightIssueId));
    expect(persisted).toMatchObject(expected);
  });

  it.each([
    ["manual", "agent"], ["manual", "board"],
    ["routine_execution", "agent"], ["routine_execution", "board"],
  ] as const)("%s %s release still unassigns the issue", async (origin, actor) => {
    const seed = await checkedOutScenario(origin);
    if (actor === "agent") await issueService(db).release(seed.oversightIssueId, seed.ownerId, seed.checkoutRunId);
    else await issueService(db).release(seed.oversightIssueId);
    const [persisted] = await db.select().from(issues).where(eq(issues.id, seed.oversightIssueId));
    expect(persisted).toMatchObject({
      status: "todo", assigneeAgentId: null,
      checkoutRunId: null, executionRunId: null, executionLockedAt: null,
    });
  });

  it.each([
    ["other agent", "Only assignee can release issue"],
    ["other run", "Only checkout run can release issue"],
    ["missing run", "Only checkout run can release issue"],
  ] as const)("rejects %s without changing the oversight owner or locks", async (actor, message) => {
    const seed = await checkedOutScenario();
    await expect(issueService(db).release(
      seed.oversightIssueId,
      actor === "other agent" ? randomUUID() : seed.ownerId,
      actor === "missing run" ? null : actor === "other run" ? randomUUID() : seed.checkoutRunId,
    )).rejects.toMatchObject({ status: 409, message });
    const [persisted] = await db.select().from(issues).where(eq(issues.id, seed.oversightIssueId));
    expect(persisted).toMatchObject({
      status: "in_progress", assigneeAgentId: seed.ownerId,
      checkoutRunId: seed.checkoutRunId, executionRunId: seed.checkoutRunId,
      executionLockedAt: seed.executionLockedAt,
    });
  });

  it("release → QA card → board resolution admits a durable continuation to the mission owner", async () => {
    const seed = await checkedOutScenario();
    await issueService(db).release(seed.oversightIssueId, seed.ownerId, seed.checkoutRunId);
    const card = await ensureQaSourceDefectOwnerCard({
      db, companyId: seed.companyId, missionId: seed.missionId, workflowRunId: seed.runId,
      producerStepId: "produce", iteration: 0, maxIterations: 2,
      findings: FINDINGS_SOURCE_ONLY,
      qaRefs: [{ qaStepId: "qa-validate", qaIssueId: seed.qaIssueId }],
      linkIssueId: seed.oversightIssueId,
    });
    expect(card.outcome).toBe("created");
    if (card.outcome !== "created") throw new Error(`Unexpected card outcome: ${card.outcome}`);
    await operatorDecisionWriteService(db).resolve(card.decisionId, {
      actionId: "submit", selectedOptionIds: ["rerun_source_collection"], comment: null,
    }, "release-test-board");
    const worker = operatorDecisionContinuationWorker(db, {
      workerId: "oversight-release-test",
      // Replace only external wake admission; the worker verifies this real durable queue row.
      async wakeup(agentId, options) {
        await db.insert(agentWakeupRequests).values({
          companyId: seed.companyId, agentId, issueId: options.payload.issueId,
          source: options.source, triggerDetail: options.triggerDetail, reason: options.reason,
          status: "queued", payload: options.payload, idempotencyKey: options.idempotencyKey,
          requestedByActorType: options.requestedByActorType, requestedByActorId: options.requestedByActorId,
        });
      },
    });
    await worker.pollOnce();
    const [continuation] = await db.select().from(operatorDecisionContinuations)
      .where(eq(operatorDecisionContinuations.operatorDecisionId, card.decisionId));
    expect(continuation).toMatchObject({
      companyId: seed.companyId, issueId: seed.oversightIssueId,
      state: "accepted", targetAgentId: seed.ownerId, attemptCount: 1, errorCode: null,
    });
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, seed.companyId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      id: continuation!.wakeupRequestId, agentId: seed.ownerId, issueId: seed.oversightIssueId,
      status: "queued", reason: "operator_decision_resolved", requestedByActorId: "release-test-board",
      idempotencyKey: `operator-decision-wake:${card.decisionId}:g1:a1`,
      payload: { operatorDecisionId: card.decisionId, actionId: "submit", selectedOptionIds: ["rerun_source_collection"] },
    });
    // Acceptance is queue evidence only, not proof of live agent execution.
  });
});

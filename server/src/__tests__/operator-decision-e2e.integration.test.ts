import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  issues,
  operatorDecisionContinuations,
  operatorDecisions,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { infloOpportunityOperatorDecisionInput } from "./helpers/inflo-operator-decision-fixture.js";
import { operatorDecisionContinuationWorker } from "../services/operator-decision-continuation-worker.js";
import { operatorDecisionReadService } from "../services/operator-decisions-read.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("Inflo Operator Decision end-to-end", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let issueId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("operator-decision-inflo-e2e-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });
  beforeEach(async () => {
    await db.delete(activityLog);
    await db.delete(operatorDecisionContinuations);
    await db.delete(operatorDecisions);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Inflo", issuePrefix: `I${companyId.slice(0, 4)}` });
    agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Opportunity Lead" });
    issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Prepare selected opportunity proposal intake",
      status: "todo",
      assigneeAgentId: agentId,
    });
  });

  it("persists the choice, Activity evidence, and one admitted linked-work wakeup", async () => {
    const write = operatorDecisionWriteService(db);
    const created = await write.create(
      companyId,
      infloOpportunityOperatorDecisionInput("inflo:fixture:choice", issueId),
      { type: "agent", id: agentId },
    );
    const pending = await operatorDecisionReadService(db).list(companyId, { view: "pending", limit: 50 });
    expect(pending.data[0]).toMatchObject({
      id: created.decision.id,
      definition: {
        approvedScope: expect.arrayContaining(["Prepare an internal draft only"]),
        forbiddenScope: expect.arrayContaining(["External contact", "Submission", "Price commitment", "Contract commitment"]),
      },
    });

    const resolved = await write.resolve(created.decision.id, {
      actionId: "prepare_internal_proposal",
      selectedOptionIds: ["candidate-north"],
      comment: "Proceed internally",
    }, "board-user");
    expect(resolved.decision).toMatchObject({
      status: "resolved",
      resolvedByUserId: "board-user",
      result: { actionId: "prepare_internal_proposal", outcome: "submit", selectedOptionIds: ["candidate-north"] },
    });
    expect((await operatorDecisionReadService(db).list(companyId, { view: "pending", limit: 50 })).data).toEqual([]);

    const wakeup = vi.fn(async (targetAgentId: string, options: Record<string, unknown>) => {
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId: targetAgentId,
        source: "automation",
        triggerDetail: "system",
        reason: "operator_decision_resolved",
        payload: options.payload as Record<string, unknown>,
        status: "queued",
        requestedByActorType: "user",
        requestedByActorId: "board-user",
        idempotencyKey: options.idempotencyKey as string,
        requestKind: "operator_decision_resolution",
        issueId,
      });
    });
    await operatorDecisionContinuationWorker(db, { wakeup, workerId: "inflo-e2e" }).pollOnce();
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      payload: {
        kind: "operator_decision_resolution",
        operatorDecisionId: created.decision.id,
        issueId,
        actionId: "prepare_internal_proposal",
        selectedOptionIds: ["candidate-north"],
      },
      idempotencyKey: `operator-decision-wake:${created.decision.id}:g1:a1`,
    }));
    expect(await db.select().from(operatorDecisionContinuations)).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
    const actions = (await db.select().from(activityLog).where(eq(activityLog.entityId, created.decision.id)))
      .map((row) => row.action);
    expect(actions).toEqual([
      "operator_decision.created",
      "operator_decision.resolved",
      "operator_decision.continuation_accepted",
    ]);

    const replay = await write.resolve(created.decision.id, {
      actionId: "prepare_internal_proposal",
      selectedOptionIds: ["candidate-north"],
      comment: "Proceed internally",
    }, "board-user");
    expect(replay.applied).toBe(false);
    expect(await db.select().from(operatorDecisionContinuations)).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
  });

  it.each([
    ["hold_all", "hold"],
    ["reject_shortlist", "reject"],
  ])("records %s without an external or continuation side effect", async (actionId, outcome) => {
    const write = operatorDecisionWriteService(db);
    const fixture = {
      ...infloOpportunityOperatorDecisionInput(`inflo:fixture:${actionId}`, issueId),
      continuationMode: "none" as const,
    };
    const created = await write.create(companyId, fixture, { type: "user", id: "board" });
    const resolved = await write.resolve(created.decision.id, { actionId, selectedOptionIds: [], comment: null }, "board");
    expect(resolved.decision.result).toMatchObject({ actionId, outcome });
    expect(resolved.continuation).toBeNull();
    expect(await db.select().from(operatorDecisionContinuations)).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });
});

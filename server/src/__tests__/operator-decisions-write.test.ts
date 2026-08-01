import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issues,
  operatorDecisionContinuations,
  operatorDecisions,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

const definition = {
  options: [{ id: "one", label: "One", description: null, facts: [], evidenceRefs: [] }],
  actions: [
    { id: "choose", label: "Choose", outcome: "submit" as const, tone: "primary" as const, requiresSelection: true },
    { id: "hold", label: "Hold", outcome: "hold" as const, tone: "neutral" as const, requiresSelection: false },
  ],
  selection: { min: 1, max: 1 },
  comment: { mode: "optional" as const, label: "Note", placeholder: null, maxLength: 100 },
  approvedScope: ["internal"],
  forbiddenScope: ["external"],
};

function input(requestKey: string, issueId: string | null = null) {
  return {
    schemaVersion: 1 as const,
    requestKey,
    priority: "high" as const,
    interactionType: "single_select" as const,
    title: "Choose",
    description: "Choose one",
    sourceType: "workflow_step",
    sourceId: "step-1",
    sourceContext: { missionId: null, workflowId: null, workflowRunId: null, artifactRefs: [] },
    definition,
    issueId,
    continuationMode: issueId ? "issue_current_assignee" as const : "none" as const,
  };
}

describeDb("operator decision write service", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let otherCompanyId: string;
  let agentId: string;
  let issueId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("operator-decisions-write-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  beforeEach(async () => {
    await db.delete(activityLog);
    await db.delete(operatorDecisionContinuations);
    await db.delete(operatorDecisions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "One", issuePrefix: `O${companyId.slice(0, 4)}` },
      { id: otherCompanyId, name: "Two", issuePrefix: `T${otherCompanyId.slice(0, 4)}` },
    ]);
    agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent" });
    issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Work", assigneeAgentId: agentId, status: "todo" });
  });

  it("creates idempotently and rejects request hash conflicts", async () => {
    const service = operatorDecisionWriteService(db);
    const first = await service.create(companyId, input("same"), { type: "agent", id: agentId });
    const replay = await service.create(companyId, input("same"), { type: "agent", id: agentId });
    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, decision: { id: first.decision.id } });
    await expect(service.create(companyId, { ...input("same"), title: "Different" }, { type: "agent", id: agentId }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("enforces same-company requesters and linked issues", async () => {
    const service = operatorDecisionWriteService(db);
    await expect(service.create(otherCompanyId, input("agent-boundary"), { type: "agent", id: agentId }))
      .rejects.toMatchObject({ status: 403 });
    await expect(service.create(otherCompanyId, input("issue-boundary", issueId), { type: "user", id: "board" }))
      .rejects.toMatchObject({ status: 422 });
  });

  it("atomically stores result, activity, and exactly one explicit continuation", async () => {
    const service = operatorDecisionWriteService(db);
    const created = await service.create(companyId, input("resolve", issueId), { type: "agent", id: agentId });
    const resolved = await service.resolve(created.decision.id, {
      actionId: "choose",
      selectedOptionIds: ["one"],
      comment: " yes ",
    }, "board-user");
    expect(resolved).toMatchObject({ applied: true, decision: { status: "resolved", result: { outcome: "submit", comment: "yes" } } });
    expect(resolved.continuation).toMatchObject({ state: "pending", attemptCount: 0 });
    expect(await db.select().from(operatorDecisionContinuations)).toHaveLength(1);
    const activities = await db.select().from(activityLog).where(eq(activityLog.entityId, created.decision.id));
    expect(activities.map((row) => row.action)).toEqual(["operator_decision.created", "operator_decision.resolved"]);
    expect(activities[1]?.details).not.toHaveProperty("comment");
  });

  it("makes resolution immutable with identical replay and first-writer-wins", async () => {
    const service = operatorDecisionWriteService(db);
    const created = await service.create(companyId, input("immutable"), { type: "user", id: "board-user" });
    const body = { actionId: "choose", selectedOptionIds: ["one"], comment: null };
    const [one, two] = await Promise.all([
      service.resolve(created.decision.id, body, "board-user"),
      service.resolve(created.decision.id, body, "board-user"),
    ]);
    expect([one.applied, two.applied].sort()).toEqual([false, true]);
    await expect(service.resolve(created.decision.id, { actionId: "hold", selectedOptionIds: [], comment: null }, "board-user"))
      .rejects.toMatchObject({ status: 409 });
  });

  it("resolves after issue deletion and records a null-issue outbox", async () => {
    const service = operatorDecisionWriteService(db);
    const created = await service.create(companyId, input("deleted", issueId), { type: "user", id: "board" });
    await db.delete(issues).where(eq(issues.id, issueId));
    const resolved = await service.resolve(created.decision.id, {
      actionId: "choose", selectedOptionIds: ["one"], comment: null,
    }, "board");
    expect(resolved.decision.issueId).toBeNull();
    expect(resolved.continuation).toMatchObject({ state: "pending" });
  });
});

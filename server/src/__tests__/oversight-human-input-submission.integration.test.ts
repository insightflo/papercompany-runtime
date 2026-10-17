import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issues, missions, workflowTransitionEvents } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { submitMissionOwnerDecision } from "../services/missions/mission-owner-recovery-agent-api.js";
import { HUMAN_OPERATOR_REQUEST_ACTION } from "../services/missions/human-operator-alert-events.js";
import { listCompanyHumanOperatorRequests } from "../services/missions/human-operator-requests.js";
import { publishLiveEvent } from "../services/live-events.js";

vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));

// [Stage 1 bridge] 카드 생성(write.create)이 operator_decision.created live 이벤트를 추가 발행한다.
//   기존 계약("알림 1회")은 사람 알림(mission.human_input_requested) 기준이므로 타입으로 센다.
function humanAlertPublishes() {
  return vi.mocked(publishLiveEvent).mock.calls.filter((call) => (call[0] as { type?: string })?.type === "mission.human_input_requested");
}

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

beforeAll(async () => { tempDb = await startEmbeddedPostgresTestDatabase("oversight-human-input-"); }, 60_000);
afterAll(async () => { await tempDb?.cleanup(); });

describeEP("oversight structured human-input submissions", () => {
  let db!: ReturnType<typeof createDb>;
  beforeAll(() => { db = createDb(tempDb!.connectionString); });
  afterEach(async () => {
    vi.clearAllMocks();
    await db.delete(activityLog);
    await db.delete(workflowTransitionEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function seed(originKind = "mission_main_executor_oversight", source = false) {
    const companyId = randomUUID(), ownerId = randomUUID(), otherId = randomUUID();
    const missionId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Oversight", issuePrefix: `OV${companyId.slice(0, 6)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([ownerId, otherId].map((id) => ({ id, companyId, name: id, role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })));
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: ownerId, title: "Oversight mission", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, missionId, title: "Owner oversight", status: "in_progress", originKind, originId: source ? randomUUID() : null, assigneeAgentId: ownerId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: ownerId, issueId, status: "running" });
    await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, issueId));
    return { companyId, ownerId, otherId, missionId, issueId, runId };
  }

  const actor = (s: Awaited<ReturnType<typeof seed>>, runId = s.runId, agentId = s.ownerId) => ({ actorType: "agent" as const, actorId: agentId, agentId, runId });
  const submit = (s: Awaited<ReturnType<typeof seed>>, data: Record<string, unknown>, overrides: { issueId?: string; runId?: string; agentId?: string } = {}) => submitMissionOwnerDecision({
    db, issueId: overrides.issueId ?? s.issueId, actor: actor(s, overrides.runId, overrides.agentId), data: data as never,
  });

  async function snapshot(issueId: string) {
    const [issue] = await db.select({ checkoutRunId: issues.checkoutRunId }).from(issues).where(eq(issues.id, issueId));
    const [events, activities] = await Promise.all([
      db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(eq(workflowTransitionEvents.issueId, issueId)),
      db.select({ id: activityLog.id }).from(activityLog).where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, HUMAN_OPERATOR_REQUEST_ACTION))),
    ]);
    return { checkoutRunId: issue?.checkoutRunId, eventIds: events.map((row) => row.id), activityIds: activities.map((row) => row.id) };
  }

  async function expectRejectedUnchanged(issueId: string, run: () => Promise<unknown>) {
    const before = await snapshot(issueId), emissions = vi.mocked(publishLiveEvent).mock.calls.length;
    await expect(run()).rejects.toThrow();
    expect(await snapshot(issueId)).toEqual(before);
    expect(publishLiveEvent).toHaveBeenCalledTimes(emissions);
  }

  // RED proof is pending controller verification: before this implementation, the first submission
  // is rejected by the existing Unblock-only origin guard.
  it.each(["request_input", "escalate"] as const)("records and alerts source-less oversight %s", async (decision) => {
    const s = await seed();
    const result = await submit(s, { decision, reason: "retry is not authority; done is only text", nextAction: "Ask the operator.", sourceIssueRef: "not-a-source" });
    expect(result.submission.decision).toBe(decision);
    const [row] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, result.eventId));
    expect(row).toMatchObject({ eventType: "mission_owner_decision", layer: "mission_owner_recovery", issueId: s.issueId, missionId: s.missionId, heartbeatRunId: s.runId });
    expect(row?.payload).toMatchObject({ sourceIssueId: null, decision });
    expect(row?.payload).not.toHaveProperty("sourceIssueRef");
    const [activity] = await db.select().from(activityLog).where(eq(activityLog.action, HUMAN_OPERATOR_REQUEST_ACTION));
    expect(activity?.details).toMatchObject({ issueId: s.issueId, decisionEventId: result.eventId, decision });
    expect(activity?.details).not.toHaveProperty("sourceIssueId");
    expect(humanAlertPublishes()).toHaveLength(1);
    const requests = await listCompanyHumanOperatorRequests(db, { companyId: s.companyId });
    expect(requests[0]).toMatchObject({ issueId: s.issueId, missionId: s.missionId });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, s.companyId))).toHaveLength(0);
  });

  it("deduplicates repeated and concurrent identical submissions and alerts once", async () => {
    const s = await seed(), data = { decision: "request_input", reason: "Need approval." };
    const results = await Promise.all([submit(s, data), submit(s, data), submit(s, data)]);
    expect(new Set(results.map((result) => result.eventId)).size).toBe(1);
    expect(await snapshot(s.issueId).then((state) => state.activityIds)).toHaveLength(1);
    expect(humanAlertPublishes()).toHaveLength(1);
  });

  it("rejects foreign company, owner, issue, and run without durable changes", async () => {
    const s = await seed(), foreign = await seed();
    await expectRejectedUnchanged(s.issueId, () => submit(s, { decision: "request_input" }, { agentId: s.otherId }));
    await expectRejectedUnchanged(foreign.issueId, () => submit(s, { decision: "request_input" }, { issueId: foreign.issueId }));
    await expectRejectedUnchanged(s.issueId, () => submit(s, { decision: "request_input" }, { runId: foreign.runId }));
    const otherIssueId = randomUUID(), otherRunId = randomUUID();
    await db.insert(issues).values({ id: otherIssueId, companyId: s.companyId, missionId: s.missionId, title: "Other issue", status: "in_progress", assigneeAgentId: s.ownerId });
    await db.insert(heartbeatRuns).values({ id: otherRunId, companyId: s.companyId, agentId: s.ownerId, issueId: otherIssueId, status: "running" });
    await expectRejectedUnchanged(s.issueId, () => submit(s, { decision: "request_input" }, { runId: otherRunId }));
  });

  it("rejects terminal run, source-less Unblock, disallowed oversight choices, and recovery targets", async () => {
    const s = await seed();
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, s.runId));
    await expectRejectedUnchanged(s.issueId, () => submit(s, { decision: "request_input" }));
    const unblock = await seed("mission_main_executor_unblock");
    await expectRejectedUnchanged(unblock.issueId, () => submit(unblock, { decision: "request_input" }));
    const oversight = await seed();
    await expectRejectedUnchanged(oversight.issueId, () => submit(oversight, { decision: "retry_source_issue", reason: "retry" }));
    await expectRejectedUnchanged(oversight.issueId, () => submit(oversight, { decision: "request_input", recoveryTarget: { kind: "tool_step" } }));
  });

  it.each(["completed", "cancelled"])("rejects %s mission before stale checkout adoption", async (status) => {
    const s = await seed(), staleRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: staleRunId, companyId: s.companyId, agentId: s.ownerId, issueId: s.issueId, status: "failed" });
    await db.update(issues).set({ checkoutRunId: staleRunId }).where(eq(issues.id, s.issueId));
    await db.update(missions).set({ status }).where(eq(missions.id, s.missionId));
    await expectRejectedUnchanged(s.issueId, () => submit(s, { decision: "request_input" }));
    expect((await snapshot(s.issueId)).checkoutRunId).toBe(staleRunId);
  });

  it("rolls back decision and checkout adoption when activity insertion fails", async () => {
    const s = await seed(), staleRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: staleRunId, companyId: s.companyId, agentId: s.ownerId, issueId: s.issueId, status: "failed" });
    await db.update(issues).set({ checkoutRunId: staleRunId }).where(eq(issues.id, s.issueId));
    const injectedDb = new Proxy(db, { get(target, property) {
      if (property === "transaction") return (callback: (tx: unknown) => Promise<unknown>) => target.transaction((tx) => callback(new Proxy(tx, { get(inner, key) {
        if (key === "insert") return (table: unknown) => table === activityLog ? { values: () => { throw new Error("injected activity insert failure"); } } : inner.insert(table as never);
        const value = Reflect.get(inner, key, inner); return typeof value === "function" ? value.bind(inner) : value;
      } }) as never));
      const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
    } }) as typeof db;
    const before = await snapshot(s.issueId);
    await expect(submitMissionOwnerDecision({ db: injectedDb, issueId: s.issueId, actor: actor(s), data: { decision: "request_input" } })).rejects.toThrow("injected activity insert failure");
    expect(await snapshot(s.issueId)).toEqual(before);
    expect((await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.issueId, s.issueId)))).toHaveLength(0);
    expect(publishLiveEvent).not.toHaveBeenCalled();
  });
});

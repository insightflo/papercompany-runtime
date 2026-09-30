import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentWakeupRequests, agents, approvals, companies, heartbeatRuns, issues, missions, workflowRecoveryAuthorities,
  workflowRuns, workflowStepRuns, workflowTerminalDecisions, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { applyOwnerCapOverrideRetry } from "../services/workflow/source-issue-cap-override.js";
import { capOwnerAction, seedCapExhaustedRun, startCapOverrideTestDb, type Seed } from "./helpers/cap-override-fixtures.js";

describe("full cap override atomic acceptance", () => {
  let fixture: Awaited<ReturnType<typeof startCapOverrideTestDb>>, db: Db;
  beforeAll(async () => { fixture = await startCapOverrideTestDb(); db = fixture.db; }, 60_000);
  afterAll(async () => { await db.$client.end(); await fixture.cleanup(); });
  const apply = (s: Seed, connection = db) => applyOwnerCapOverrideRetry(connection, {
    companyId: s.companyId, issueId: s.producerIssueId, ownerAction: capOwnerAction(s),
  });
  async function snapshot(s: Seed) {
    return {
      runs: await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.workflowRunId)),
      steps: await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, s.workflowRunId)).orderBy(workflowStepRuns.id),
      issues: await db.select().from(issues).where(eq(issues.companyId, s.companyId)).orderBy(issues.id),
      events: await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, s.companyId)).orderBy(workflowTransitionEvents.id),
      authorities: await db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.companyId, s.companyId)),
      wakes: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, s.companyId)).orderBy(agentWakeupRequests.id),
      heartbeats: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, s.companyId)).orderBy(heartbeatRuns.id),
    };
  }
  // This is a real Drizzle transaction on its reserved PostgreSQL connection, not a fake DB.
  function observeTransaction(beforeCommit: () => Promise<void>, afterCommit?: () => Promise<void>) {
    return new Proxy(db, { get(target, property, receiver) {
      if (property === "transaction") return async (callback: Parameters<Db["transaction"]>[0]) => {
        const result = await target.transaction(async (tx) => {
          const value = await callback(tx);
          await beforeCommit();
          return value;
        });
        await afterCommit?.();
        return result;
      };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }
  it("budget change after the only commit cannot strand a forwarded run without a native queue receipt", async () => {
    const s = await seedCapExhaustedRun(db);
    let commits = 0;
    const observed = observeTransaction(async () => {}, async () => {
      commits++;
      if (commits === 1) await db.update(companies).set({ budgetMonthlyCents: 1, spentMonthlyCents: 1 }).where(eq(companies.id, s.companyId));
    });
    expect((await apply(s, observed)).kind).toBe("cap_override_applied");
    const after = await snapshot(s);
    expect(commits).toBe(1);
    expect(after.runs[0].status).toBe("running");
    expect(after.steps.find((x) => x.id === s.producerStepRunId)).toMatchObject({ status: "pending", iterationIndex: 2 });
    const wakes = after.wakes.filter((x) => x.idempotencyKey === `cap-override-wake:${s.ownerDecisionEventId}`);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ status: "queued", requestKind: "workflow_resume", workflowRunId: s.workflowRunId,
      workflowStepRunId: s.producerStepRunId, issueId: s.producerIssueId, workflowExecutionGeneration: 0 });
    expect(after.events.find((x) => x.eventType === "owner_cap_override_retry")?.payload)
      .toMatchObject({ status: "accepted", acceptedWakeupRequestId: wakes[0].id });
    expect(after.heartbeats.filter((x) => x.issueId === s.producerIssueId)).toHaveLength(0);
  });
  it.each(["queue", "audit_insert", "audit_accept", "commit"])("%s failure leaves every related row unchanged", async (point) => {
    const s = await seedCapExhaustedRun(db, { producerIssueStatus: "done" });
    const before = await snapshot(s);
    const table = point === "queue" ? "agent_wakeup_requests" : "workflow_transition_events";
    const event = point === "audit_accept" ? "UPDATE" : "INSERT";
    const predicate = point === "queue" ? "NEW.idempotency_key LIKE 'cap-override-wake:%'"
      : point === "audit_accept" ? "NEW.event_type = 'owner_cap_override_retry' AND NEW.payload->>'status' = 'accepted'"
      : "NEW.event_type = 'owner_cap_override_retry'";
    // A deferred constraint trigger raises at actual COMMIT, after reset, queue insert and acceptance.
    await db.$client.unsafe(`CREATE FUNCTION cap_full_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.company_id = '${s.companyId}'::uuid AND ${predicate} THEN RAISE EXCEPTION 'injected ${point}'; END IF;
      RETURN NEW; END $$;
      CREATE ${point === "commit" ? "CONSTRAINT" : ""} TRIGGER cap_full_fail
      ${point === "commit" ? "AFTER INSERT ON workflow_transition_events DEFERRABLE INITIALLY DEFERRED" : `BEFORE ${event} ON ${table}`}
      FOR EACH ROW EXECUTE FUNCTION cap_full_fail()`);
    try {
      expect(await apply(s)).toMatchObject({ kind: "report_only", reason: "cap_override_queue_rolled_back" });
      expect(await snapshot(s)).toEqual(before);
    } finally {
      await db.$client.unsafe(`DROP TRIGGER cap_full_fail ON ${table}; DROP FUNCTION cap_full_fail()`);
    }
  });
  it("all writes are invisible on an independent connection until the one outer commit", async () => {
    const s = await seedCapExhaustedRun(db), before = await snapshot(s);
    let commits = 0;
    const observed = observeTransaction(async () => {
      commits++;
      expect(await snapshot(s)).toEqual(before);
    });
    expect((await apply(s, observed)).kind).toBe("cap_override_applied");
    expect(commits).toBe(1);
    const after = await snapshot(s);
    expect(after.events.filter((x) => x.eventType === "owner_cap_override_retry")).toHaveLength(1);
    expect(after.wakes.filter((x) => x.idempotencyKey === `cap-override-wake:${s.ownerDecisionEventId}`)).toHaveLength(1);
    expect(after.heartbeats).toEqual(before.heartbeats);
  });
  it.each(["cancel", "budget", "producer_paused", "replaced"])("%s refusal leaves reset, issue, audit, authority and queue unchanged", async (variant) => {
    const s = await seedCapExhaustedRun(db, { producerIssueStatus: "done" });
    if (variant === "cancel") await db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, s.missionId));
    if (variant === "budget") await db.update(companies).set({ budgetMonthlyCents: 1, spentMonthlyCents: 1 }).where(eq(companies.id, s.companyId));
    if (variant === "producer_paused") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, s.producerAgentId));
    if (variant === "replaced") {
      const [approval] = await db.insert(approvals).values({ companyId: s.companyId, type: "workflow_replacement", status: "approved", payload: {} }).returning();
      const [target] = await db.insert(workflowRuns).values({ companyId: s.companyId, missionId: s.missionId, workflowId: s.workflowId, triggeredBy: "test" }).returning();
      const [terminal] = await db.insert(workflowTerminalDecisions).values({ companyId: s.companyId, workflowRunId: s.workflowRunId,
        decidedAuthorityVersion: 0, decision: "failed", policyCause: "recovery_deadline_hard", discoveryPath: "stuck_diagnostic", origin: "reconciler" }).returning();
      await db.insert(workflowRecoveryAuthorities).values({ companyId: s.companyId, workflowRunId: s.workflowRunId,
        targetAuthorityVersion: 0, resultingAuthorityVersion: 0, targetDecisionId: terminal.id, recoveryKind: "replacement_from_start_v1",
        requestedBy: "test", requestReference: s.ownerDecisionEventId, ownerDecisionEventId: s.ownerDecisionEventId,
        operatorApprovalId: approval.id, replacementRunId: target.id, requestHash: "a".repeat(64), replacementContract: {} });
    }
    const before = await snapshot(s);
    expect((await apply(s)).kind).toBe("report_only");
    expect(await snapshot(s)).toEqual(before);
  });
  it.each(["cancel", "budget", "owner_changed"])("%s between preflight and locked apply refuses without partial writes", async (variant) => {
    const s = await seedCapExhaustedRun(db, { producerIssueStatus: "done" });
    const before = await snapshot(s);
    let injected = false;
    const connection = new Proxy(db, { get(target, property, receiver) {
      if (property === "transaction") return async (callback: Parameters<Db["transaction"]>[0]) => {
        if (!injected) {
          injected = true;
          if (variant === "cancel") await db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, s.missionId));
          if (variant === "budget") await db.update(companies).set({ budgetMonthlyCents: 1, spentMonthlyCents: 1 }).where(eq(companies.id, s.companyId));
          if (variant === "owner_changed") await db.update(missions).set({ ownerAgentId: s.qaAgentId }).where(eq(missions.id, s.missionId));
        }
        return target.transaction(callback);
      };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    expect((await apply(s, connection)).kind).toBe("report_only");
    expect(injected).toBe(true);
    expect(await snapshot(s)).toEqual(before);
  });
  it("duplicate concurrent full calls accept once and never increment twice", async () => {
    const s = await seedCapExhaustedRun(db);
    const results = await Promise.all([apply(s), apply(s)]);
    expect(results.filter((r) => r.kind === "cap_override_applied")).toHaveLength(1);
    const after = await snapshot(s);
    expect(after.steps.find((x) => x.id === s.producerStepRunId)?.iterationIndex).toBe(2);
    expect(after.events.filter((x) => x.eventType === "owner_cap_override_retry")).toHaveLength(1);
    expect(after.wakes.filter((x) => x.idempotencyKey === `cap-override-wake:${s.ownerDecisionEventId}`)).toHaveLength(1);
    expect(after.heartbeats.filter((x) => x.issueId === s.producerIssueId)).toHaveLength(0);
  });
});

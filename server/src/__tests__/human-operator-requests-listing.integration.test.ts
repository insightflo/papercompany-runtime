import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, issues, operatorDecisionContinuations, operatorDecisions } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { listCompanyHumanOperatorRequests } from "../services/missions/human-operator-requests.js";
import {
  embeddedRequestStateSupported, startHumanRequestFixture,
  type DeliveryInput, type HumanRequestFixture,
} from "./helpers/human-operator-request-state-fixture.js";

const supported = await embeddedRequestStateSupported();
const describePg = supported ? describe : describe.skip;
const READ_ONLY_TRANSACTION = "set transaction isolation level repeatable read read only";
type Listings = Awaited<ReturnType<typeof listCompanyHumanOperatorRequests>>;
const byEvent = (rows: Listings, eventId: string) => rows.find((row) => row.requestState?.decisionEventId === eventId);
const stableId = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;

function assertReadOnlyProjectionQueries(queries: readonly string[], expectedDataQueries?: number) {
  const normalized = queries.map((query) => query.trim().toLowerCase());
  const setup = normalized.filter((query) => query === READ_ONLY_TRANSACTION);
  expect(setup).toEqual([READ_ONLY_TRANSACTION]);
  const dataQueries = normalized.filter((query) => query !== READ_ONLY_TRANSACTION);
  if (expectedDataQueries !== undefined) expect(dataQueries).toHaveLength(expectedDataQueries);
  expect(dataQueries.every((query) => query.startsWith("select "))).toBe(true);
  expect(normalized).toHaveLength(dataQueries.length + 1);
}

describePg("human operator request state projection", () => {
  let fixture: HumanRequestFixture | undefined;
  const h = () => {
    if (!fixture) throw new Error("fixture not started");
    return fixture;
  };

  beforeAll(async () => { fixture = await startHumanRequestFixture(); }, 60_000);
  afterAll(async () => { await fixture?.close(); });
  afterEach(async () => { await fixture?.reset(); });

  it("keeps source navigation separate from owner and preserves historical summary", async () => {
    const fx = h(), w = await fx.createWorld({ ownerStatus: "done", sourceStatus: "blocked" });
    const eventId = randomUUID(), runId = randomUUID();
    await fx.addActivity(w, eventId, { runId, extra: {
      issueTitle: "[Unblock] GAZ-1350: 2026-08-25 미국시장 시그널 해석", issueIdentifier: "GAZ-1352",
      reason: "accepted reassign event 423304dd-9f5b-4c88-b4c5-7c17d67865ab did not materialize.",
      nextAction: "Assign the idle research agent and dispatch its workflow wakeup.", evidence: "failed-run-count=2",
    } });
    const cardId = await fx.addCard(w, { eventId, requestKey: `moi2:${randomUUID()}`, runId });
    const [request] = await listCompanyHumanOperatorRequests(fx.db, { companyId: w.companyId });
    expect(request!.issueId).toBe(w.sourceId);
    expect(request!.event.scope?.issueId).toBe(w.sourceId);
    expect(request!.event.suggestedResumeTarget?.issueId).toBe(w.sourceId);
    expect(request!.requestState).toMatchObject({ identity: "exact", decisionEventId: eventId, ownerActionIssueId: w.ownerId, sourceIssueId: w.sourceId, decision: { id: cardId } });
    expect(request!.summary.split("\n")).toEqual(expect.arrayContaining([
      expect.stringContaining("이슈 GAZ-1352 — [Unblock] GAZ-1350"), expect.stringContaining("423304dd"),
      expect.stringContaining("Assign the idle research agent"), expect.stringContaining("failed-run-count=2"),
    ]));
  });

  it("uses the open owner as navigation when its validated source is closed", async () => {
    const fx = h(), w = await fx.createWorld({ ownerStatus: "blocked", sourceStatus: "done" });
    const eventId = randomUUID(), runId = randomUUID();
    await fx.addActivity(w, eventId, { runId });
    const cardId = await fx.addCard(w, { eventId, requestKey: `moi2:${randomUUID()}`, runId });
    const before = await fx.snapshot(); fx.clearQueries();
    const [request] = await listCompanyHumanOperatorRequests(fx.db, { companyId: w.companyId });
    const readQueries = [...fx.queries];
    expect(await fx.snapshot()).toEqual(before);

    assertReadOnlyProjectionQueries(readQueries, 6);
    expect(request!.issueId).toBe(w.ownerId);
    expect(request!.event.scope?.issueId).toBe(w.ownerId);
    expect(request!.event.suggestedResumeTarget?.issueId).toBe(w.ownerId);
    expect(request!.requestState).toMatchObject({
      identity: "exact", decisionEventId: eventId, ownerActionIssueId: w.ownerId, sourceIssueId: w.sourceId,
      decision: { id: cardId, status: "resolved", result: { actionId: "approve", outcome: "approve" } },
    });
  });

  it.each([
    [{ ownerStatus: "done", sourceStatus: "done" }],
    [{ ownerStatus: "done", sourceStatus: "blocked", missionStatus: "completed" }],
  ])("keeps closed issue/mission requests out of the open listing", async (input) => {
    const fx = h(), w = await fx.createWorld(input); await fx.addActivity(w, randomUUID());
    expect(await listCompanyHumanOperatorRequests(fx.db, { companyId: w.companyId })).toHaveLength(0);
  });

  it("keeps an owner-only request navigable without a source issue", async () => {
    const fx = h(), w = await fx.createWorld(); await fx.addActivity(w, randomUUID(), { sourceId: null, decision: "request_input" });
    const [request] = await listCompanyHumanOperatorRequests(fx.db, { companyId: w.companyId });
    expect(request!.issueId).toBe(w.ownerId);
    expect(request!.requestState).toMatchObject({ identity: "missing", ownerActionIssueId: w.ownerId, sourceIssueId: null });
  });

  it("groups only the same immutable event and sorts equal timestamps by activity ID", async () => {
    const fx = h(), w = await fx.createWorld(), first = randomUUID(), later = randomUUID(), base = new Date("2026-10-30T00:00:00Z");
    const low = stableId(1), high = stableId(2);
    await fx.addActivities([
      fx.activity(w, first, { createdAt: new Date(base.getTime() + 1_000) }),
      fx.activity(w, first, { createdAt: base }), fx.activity(w, later, { createdAt: new Date(base.getTime() + 2_000) }),
      fx.activity(w, first, { decision: "request_input", createdAt: new Date(base.getTime() + 3_000) }),
      fx.activity(w, randomUUID(), { ownerId: w.sourceId, sourceId: null, createdAt: new Date(base.getTime() + 4_000) }),
      fx.activity(w, randomUUID(), { id: low, createdAt: new Date(base.getTime() + 5_000) }),
      fx.activity(w, randomUUID(), { id: high, createdAt: new Date(base.getTime() + 5_000) }),
    ]);
    const rows = await listCompanyHumanOperatorRequests(fx.db, { companyId: w.companyId });
    expect(rows).toHaveLength(6);
    expect(rows.find((row) => row.requestState?.decisionEventId === first && row.severity === "blocked")?.count).toBe(2);
    expect(rows.find((row) => row.requestState?.decisionEventId === first && row.severity === "attention")?.count).toBe(1);
    expect(byEvent(rows, later)?.count).toBe(1);
    expect(rows.find((row) => row.requestState?.ownerActionIssueId === w.sourceId)?.count).toBe(1);
    expect(rows.slice(0, 2).map((row) => row.event.sourceRef.id)).toEqual([high, low]);
    expect(byEvent(rows, first)?.requestState?.decision).toBeNull();
  });

  it("keeps malformed, unsupported, duplicate, owner, mission, snapshot, run and company conflicts visible", async () => {
    const fx = h(), w = await fx.createWorld(), foreign = await fx.createWorld();
    const ids = Object.fromEntries(["duplicate", "snapshot", "snapshotRun", "company", "mission", "run", "owner", "source", "sourceType", "unsupported", "malformedKey", "missing", "foreignCard", "payloadOwner", "payloadMission"].map((key) => [key, randomUUID()]));
    const runId = randomUUID(), wrongRunId = randomUUID();
    const specialized = new Set(["company", "snapshotRun", "run", "source", "payloadOwner", "payloadMission"]);
    for (const [key, event] of Object.entries(ids)) if (!specialized.has(key)) await fx.addActivity(w, event);
    await fx.addActivity(w, ids.run!, { runId });
    await fx.addActivity(w, ids.source!, { sourceId: w.ownerId });
    await fx.addActivity(w, ids.payloadOwner!, { payloadIssueId: w.sourceId });
    await fx.addActivity(w, ids.payloadMission!, { payloadMissionId: randomUUID() });
    await fx.addActivity(w, ids.snapshotRun!);
    await fx.addActivity(w, "not-a-uuid");
    await fx.addActivity(w, ids.company!, { extra: { companyId: foreign.companyId } });
    await fx.addCard(w, { eventId: ids.duplicate! }); await fx.addCard(w, { eventId: ids.duplicate! });
    await fx.addCard(w, { eventId: ids.snapshot!, snapshotIssueId: w.sourceId });
    await fx.addCard(w, { eventId: ids.snapshotRun!, runId, snapshotRunId: wrongRunId });
    await fx.addCard(w, { eventId: ids.mission!, missionId: randomUUID() });
    await fx.addCard(w, { eventId: ids.run!, runId: wrongRunId, snapshotRunId: wrongRunId });
    await fx.addCard(w, { eventId: ids.owner!, ownerId: w.sourceId, requestKey: `moi1:${ids.owner}` });
    await fx.addCard(w, { eventId: ids.sourceType!, sourceType: "workflow_qa_rejection", requestKey: `moi1:${ids.sourceType}` });
    await fx.addCard(w, { eventId: ids.unsupported!, requestKey: `moi3:${randomUUID()}` });
    await fx.addCard(w, { eventId: ids.malformedKey!, requestKey: "moi2:not-a-uuid" });
    await fx.addCard(foreign, { eventId: ids.foreignCard!, requestKey: `moi1:${ids.foreignCard}` });
    const rows = await listCompanyHumanOperatorRequests(fx.db, { companyId: w.companyId });
    const state = (eventId: string) => byEvent(rows, eventId)?.requestState;
    expect(state(ids.duplicate!)).toMatchObject({ identity: "ambiguous", reasonCode: "duplicate_exact_cards", decision: null });
    expect(state(ids.snapshot!)).toMatchObject({ identity: "ambiguous", reasonCode: "card_snapshot_owner_conflict", decision: null });
    expect(state(ids.snapshotRun!)).toMatchObject({ identity: "ambiguous", reasonCode: "card_run_conflict", decision: null });
    expect(state(ids.company!)).toMatchObject({ identity: "ambiguous", reasonCode: "company_identity_conflict" });
    expect(state(ids.mission!)).toMatchObject({ identity: "ambiguous", reasonCode: "card_mission_conflict" });
    expect(state(ids.run!)).toMatchObject({ identity: "ambiguous", reasonCode: "request_run_conflict" });
    expect(state(ids.owner!)).toMatchObject({ identity: "ambiguous", reasonCode: "card_relation_conflict" });
    expect(state(ids.source!)).toMatchObject({ identity: "ambiguous", reasonCode: "source_scope_conflict" });
    expect(state(ids.sourceType!)).toMatchObject({ identity: "unsupported", reasonCode: "unsupported_card_source" });
    expect(state(ids.unsupported!)).toMatchObject({ identity: "unsupported", reasonCode: "unsupported_card_key" });
    expect(state(ids.malformedKey!)).toMatchObject({ identity: "unsupported", reasonCode: "unsupported_card_key" });
    expect(state("not-a-uuid")).toMatchObject({ identity: "unsupported", reasonCode: "invalid_decision_event_id" });
    expect(state(ids.payloadOwner!)).toMatchObject({ identity: "ambiguous", reasonCode: "owner_identity_conflict" });
    expect(state(ids.payloadMission!)).toMatchObject({ identity: "ambiguous", reasonCode: "mission_identity_conflict" });
    expect(state(ids.foreignCard!)).toMatchObject({ identity: "missing", reasonCode: "exact_card_not_found", decision: null });
    expect(state(ids.missing!)).toMatchObject({ identity: "missing", reasonCode: "exact_card_not_found" });
  });

  it("preserves an original resolved moi2 result while later events and lastSeen aliases stay independent", async () => {
    const fx = h(), w = await fx.createWorld(), original = randomUUID(), alias = randomUUID(), independent = randomUUID(), moi1 = randomUUID();
    await fx.addActivity(w, original); await fx.addActivity(w, alias); await fx.addActivity(w, independent); await fx.addActivity(w, moi1);
    const originalCard = await fx.addCard(w, { eventId: original, requestKey: `moi2:${randomUUID()}`, lastSeen: alias });
    const moi1Card = await fx.addCard(w, { eventId: moi1, requestKey: `moi1:${moi1}`, status: "pending" });
    await fx.addDelivery(w, originalCard, { state: "exhausted", generation: 2, manualRetryCount: 1, attemptCount: 3 });
    const before = await fx.snapshot();
    fx.clearQueries();
    const first = await listCompanyHumanOperatorRequests(fx.db, { companyId: w.companyId });
    const firstQueries = [...fx.queries]; fx.clearQueries();
    const second = await listCompanyHumanOperatorRequests(fx.db, { companyId: w.companyId });
    const secondQueries = [...fx.queries];
    const after = await fx.snapshot();
    assertReadOnlyProjectionQueries(firstQueries, 8);
    assertReadOnlyProjectionQueries(secondQueries, 8);
    expect(byEvent(first, original)?.requestState).toMatchObject({
      identity: "exact", decision: { id: originalCard, sourceId: original, status: "resolved", result: { actionId: "approve" } },
      continuation: { state: "exhausted", generation: 2, manualRetryCount: 1, attemptCount: 3, maxAttempts: 3, effectiveStatus: "exhausted", errorCode: "attempts_exhausted", retryHint: expect.stringContaining("시도 한도") },
    });
    expect(byEvent(first, alias)?.requestState).toMatchObject({ identity: "ambiguous", reasonCode: "repeat_alias_only", decision: null, continuation: null });
    expect(byEvent(first, independent)?.requestState).toMatchObject({ identity: "missing", reasonCode: "exact_card_not_found", decision: null, continuation: null });
    expect(byEvent(first, moi1)?.requestState).toMatchObject({ identity: "exact", decision: { id: moi1Card, requestKey: `moi1:${moi1}`, status: "pending" }, attention: true });
    expect(second).toEqual(first);
    expect(after).toEqual(before);
  });

  it("projects each native continuation state by exact event and batches scoped facts", async () => {
    const fx = h(), w = await fx.createWorld(), foreign = await fx.createWorld();
    const [misboundIssue, terminalIssue] = await fx.createOwnerIssues(w, 2);
    await fx.db.update(issues).set({ status: "done" }).where(eq(issues.id, terminalIssue!));
    const cases: Array<{ name: string; delivery?: DeliveryInput; expected: Record<string, unknown> }> = [
      { name: "pending", delivery: { state: "pending" }, expected: { effectiveStatus: "pending", errorCode: null, attention: false } },
      { name: "deferred", delivery: { state: "accepted", wakeupStatus: "deferred_issue_execution" }, expected: { effectiveStatus: "deferred", errorCode: null, attention: false } },
      { name: "running", delivery: { state: "accepted", wakeupStatus: "claimed", runStatus: "running" }, expected: { effectiveStatus: "running", errorCode: null, attention: false } },
      { name: "completed", delivery: { state: "accepted", wakeupStatus: "claimed", runStatus: "succeeded" }, expected: { effectiveStatus: "completed", errorCode: null, attention: false } },
      { name: "wrong-issue-completed", delivery: { state: "accepted", wakeupStatus: "claimed", runStatus: "succeeded", issueId: misboundIssue! }, expected: { noContinuation: true, attention: null } },
      { name: "exhausted", delivery: { state: "exhausted", generation: 3, manualRetryCount: 2, attemptCount: 3 }, expected: { effectiveStatus: "exhausted", errorCode: "attempts_exhausted", generation: 3, manualRetryCount: 2, attemptCount: 3, attention: true } },
      { name: "wrong-terminal-issue", delivery: { state: "exhausted", issueId: terminalIssue! }, expected: { noContinuation: true, attention: null } },
      { name: "missing-wakeup", delivery: { state: "accepted", missingWakeup: true }, expected: { noContinuation: true, attention: true } },
      { name: "missing-run", delivery: { state: "accepted", wakeupStatus: "claimed", missingRun: true }, expected: { effectiveStatus: "blocked", errorCode: "proof_missing", attention: true } },
      { name: "missing-delivery", expected: { noContinuation: true, attention: true } },
      { name: "foreign-wakeup", delivery: { state: "accepted", wakeupStatus: "claimed", wakeupCompanyId: foreign.companyId, wakeupAgentId: foreign.agentId }, expected: { noContinuation: true, attention: null } },
      { name: "foreign-continuation", delivery: { state: "pending", continuationCompanyId: foreign.companyId, issueId: foreign.ownerId, targetAgentId: foreign.agentId }, expected: { noContinuation: true, attention: null } },
    ];
    const eventByName = new Map<string, string>(), cardByName = new Map<string, string>();
    for (const item of cases) {
      const eventId = randomUUID(); eventByName.set(item.name, eventId);
      await fx.addActivity(w, eventId);
      const cardId = await fx.addCard(w, { eventId, requestKey: `moi2:${randomUUID()}` }); cardByName.set(item.name, cardId);
      if (item.name === "missing-wakeup") {
        const beforeRejectedInsert = await fx.snapshot();
        await expect(fx.addDelivery(w, cardId, item.delivery!)).rejects.toMatchObject({ code: "23503" });
        const continuations = await fx.db.select({ id: operatorDecisionContinuations.id })
          .from(operatorDecisionContinuations).where(eq(operatorDecisionContinuations.operatorDecisionId, cardId));
        expect(continuations).toHaveLength(0);
        expect(await fx.snapshot()).toEqual(beforeRejectedInsert);
      } else if (item.delivery) await fx.addDelivery(w, cardId, item.delivery);
    }
    const beforeProjection = await fx.snapshot();
    fx.clearQueries();
    const rows = await listCompanyHumanOperatorRequests(fx.db, { companyId: w.companyId });
    const readQueries = [...fx.queries];
    expect(await fx.snapshot()).toEqual(beforeProjection);
    for (const item of cases) {
      const state = byEvent(rows, eventByName.get(item.name)!)?.requestState;
      expect(state).toMatchObject({ identity: "exact", decision: { id: cardByName.get(item.name) } });
      const { noContinuation, attention, ...continuationExpectation } = item.expected;
      expect(state?.attention).toBe(attention);
      if (noContinuation) expect(state?.continuation).toBeNull();
      else expect(state?.continuation).toMatchObject(continuationExpectation);
    }
    for (const name of ["wrong-issue-completed", "wrong-terminal-issue"]) {
      expect(byEvent(rows, eventByName.get(name)!)?.requestState).toMatchObject({
        identity: "exact", attention: null, continuation: null,
        decision: { id: cardByName.get(name), status: "resolved", result: { actionId: "approve", outcome: "approve" } },
      });
    }
    const from = (table: string) => readQueries.filter((query) => new RegExp(`from\\s+"${table}"`, "i").test(query));
    assertReadOnlyProjectionQueries(readQueries, 10);
    expect(from("operator_decision_continuations")).toHaveLength(1);
    expect(from("agent_wakeup_requests")).toHaveLength(1);
    expect(from("heartbeat_runs")).toHaveLength(1);
    expect(from("issues").filter((query) => /assignee_agent_id/i.test(query))).toHaveLength(1);
    expect(from("agents")).toHaveLength(1);
    expect(from("heartbeat_runs")[0]).not.toMatch(/context_snapshot|stdout_excerpt|stderr_excerpt|log_ref/i);
    const continuationQuery = readQueries.find((query) => /from\s+"operator_decision_continuations"/i.test(query))!;
    const continuationParams = fx.queryParams[readQueries.indexOf(continuationQuery)]!;
    expect(cases.filter((item) => item.delivery).map((item) => cardByName.get(item.name)!).every((id) => continuationParams.includes(id))).toBe(true);
    const indexes = await fx.indexNames();
    expect(indexes).toEqual(expect.arrayContaining([
      "operator_decisions_company_request_uq", "operator_decisions_issue_created_idx", "operator_decisions_pkey",
      "operator_decision_continuations_decision_uq", "agent_wakeup_requests_pkey", "heartbeat_runs_pkey", "issues_pkey", "agents_pkey",
    ]));
  });

  it("bounds 1/default-50/max-100 listing windows with stable order and unrelated history", async () => {
    const fx = h();
    for (const scenario of [{ candidates: 1, limit: 1 }, { candidates: 50 }, { candidates: 300, limit: 100 }]) {
      await fx.reset();
      const w = await fx.createWorld(), tie = new Date("2026-10-30T01:00:00Z");
      const events = Array.from({ length: scenario.candidates }, () => randomUUID());
      await fx.addActivities(events.map((eventId, index) => fx.activity(w, eventId, { id: stableId(index + 1), createdAt: tie })));
      if (scenario.candidates === 300) {
        const unrelated = Array.from({ length: 300 }, (_, index) => ({ ...fx.activity(w, randomUUID(), { id: stableId(index + 1_000), createdAt: tie }), action: "unrelated_history" }));
        await fx.addActivities(unrelated);
        const cards = Array.from({ length: 300 }, (_, index) => fx.cardValues(w, { eventId: randomUUID(), ownerId: w.sourceId, requestKey: `history:${index}:${randomUUID()}` }));
        await fx.db.insert(operatorDecisions).values(cards);
      }
      fx.clearQueries();
      const rows = await listCompanyHumanOperatorRequests(fx.db, { companyId: w.companyId, ...(scenario.limit ? { limit: scenario.limit } : {}) });
      expect(rows).toHaveLength(scenario.limit ?? 50);
      const expected = events.slice(-rows.length).reverse().map((_, index) => stableId(events.length - index));
      expect(rows.map((row) => row.event.sourceRef.id)).toEqual(expected);
      expect(rows.every((row) => row.requestState?.identity === "missing")).toBe(true);
      assertReadOnlyProjectionQueries(fx.queries, 5);
      const activityIndex = fx.queries.findIndex((query) => /from\s+"activity_log"/i.test(query));
      expect(activityIndex).toBeGreaterThanOrEqual(0);
      expect(fx.queryParams[activityIndex]?.at(-1)).toBe(Math.min((scenario.limit ?? 50) * 5, 250));
      expect(fx.queries[activityIndex]).toMatch(/order by "activity_log"\."created_at" desc, "activity_log"\."id" desc/i);
      const ownerQueryIndex = fx.queries.findIndex((query) => /from\s+"operator_decisions"/i.test(query) && /where .*"operator_decisions"\."issue_id" in/i.test(query));
      expect(fx.queryParams[ownerQueryIndex]).toContain(w.ownerId);
      expect(fx.queryParams[ownerQueryIndex]).not.toContain(w.sourceId);
    }
  });

  it("marks moi2 discovery overflow incomplete, preserves exact moi1, and excludes an unvisited owner anchor", async () => {
    const fx = h(), w = await fx.createWorld(), moreOwners = await fx.createOwnerIssues(w, 250);
    const owners = [w.ownerId, ...moreOwners], tie = new Date("2026-10-30T02:00:00Z");
    const activities = owners.map((ownerId, index) => ({
      ownerId, eventId: randomUUID(), activityId: stableId(index + 1),
    }));
    await fx.addActivities(activities.map(({ ownerId, eventId, activityId }) => fx.activity(w, eventId, { id: activityId, ownerId, createdAt: tie })));
    const windowed = activities.slice(1).reverse();
    const direct = windowed[0]!;
    const moi2 = windowed[1]!;
    const cards = [
      fx.cardValues(w, { eventId: direct.eventId, ownerId: direct.ownerId, requestKey: `moi1:${direct.eventId}`, createdAt: tie }),
      fx.cardValues(w, { eventId: moi2.eventId, ownerId: moi2.ownerId, requestKey: `moi2:${randomUUID()}`, createdAt: new Date("2099-01-01T00:00:00Z") }),
      ...windowed.slice(2).map((item) => fx.cardValues(w, { eventId: item.eventId, ownerId: item.ownerId, requestKey: `moi2:${randomUUID()}`, createdAt: tie })),
      fx.cardValues(w, { eventId: randomUUID(), ownerId: direct.ownerId, requestKey: `moi2:${randomUUID()}`, createdAt: new Date("2000-01-01T00:00:00Z") }),
      fx.cardValues(w, { eventId: activities[0]!.eventId, ownerId: activities[0]!.ownerId, requestKey: `moi2:${randomUUID()}`, createdAt: tie }),
    ];
    await fx.db.insert(operatorDecisions).values(cards);
    fx.clearQueries();
    const rows = await listCompanyHumanOperatorRequests(fx.db, { companyId: w.companyId, limit: 100 });
    assertReadOnlyProjectionQueries(fx.queries, 6);
    expect(rows).toHaveLength(100);
    expect(byEvent(rows, direct.eventId)?.requestState).toMatchObject({ identity: "exact", decision: { requestKey: `moi1:${direct.eventId}` } });
    expect(byEvent(rows, moi2.eventId)?.requestState).toMatchObject({ identity: "ambiguous", reasonCode: "card_search_incomplete", decision: null });
    expect(rows.slice(1).every((row) => row.requestState?.reasonCode === "card_search_incomplete")).toBe(true);
    const ownerIndex = fx.queries.findIndex((query) => /from\s+"operator_decisions"/i.test(query) && /where .*"operator_decisions"\."issue_id" in/i.test(query));
    expect(ownerIndex).toBeGreaterThanOrEqual(0);
    expect(fx.queryParams[ownerIndex]?.at(-1)).toBe(250);
    expect(fx.queryParams[ownerIndex]).toContain(direct.ownerId);
    expect(fx.queryParams[ownerIndex]).not.toContain(activities[0]!.ownerId);
    expect(fx.queries.filter((query) => /from\s+"operator_decisions"/i.test(query))).toHaveLength(2);
  });
});

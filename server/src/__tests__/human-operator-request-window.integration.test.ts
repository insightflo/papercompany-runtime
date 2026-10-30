import { randomUUID } from "node:crypto";
import { activityLog, agents, companies, issues, missions } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { listCompanyHumanOperatorRequests } from "../services/missions/human-operator-requests.js";
import {
  embeddedRequestStateSupported,
  startHumanRequestFixture,
  type HumanRequestFixture,
} from "./helpers/human-operator-request-state-fixture.js";

const supported = await embeddedRequestStateSupported();
const describePg = supported ? describe : describe.skip;
const READ_ONLY_TRANSACTION = "set transaction isolation level repeatable read read only";
type Listings = Awaited<ReturnType<typeof listCompanyHumanOperatorRequests>>;

async function durableSnapshot(fx: HumanRequestFixture) {
  const [activities, owners, missionsRows, companiesRows, agentsRows, requestState] = await Promise.all([
    fx.db.select().from(activityLog).orderBy(activityLog.id),
    fx.db.select().from(issues).orderBy(issues.id),
    fx.db.select().from(missions).orderBy(missions.id),
    fx.db.select().from(companies).orderBy(companies.id),
    fx.db.select().from(agents).orderBy(agents.id),
    fx.snapshot(),
  ]);
  return { activities, owners, missions: missionsRows, companies: companiesRows, agents: agentsRows, requestState };
}

function assertBoundedRead(
  queries: readonly string[], params: readonly unknown[][], candidateLimit: number, companyId: string,
) {
  const normalized = queries.map((query) => query.trim().toLowerCase());
  expect(normalized.filter((query) => query === READ_ONLY_TRANSACTION)).toEqual([READ_ONLY_TRANSACTION]);
  const dataIndexes = normalized.flatMap((query, index) => query === READ_ONLY_TRANSACTION ? [] : [index]);
  const dataQueries = dataIndexes.map((index) => normalized[index]!);
  expect(dataQueries).toHaveLength(5);
  expect(dataQueries.every((query) => query.startsWith("select "))).toBe(true);

  const candidateIndex = dataIndexes.find((index) => normalized[index]!.includes('from "activity_log"'));
  expect(candidateIndex).toBeDefined();
  const candidateQuery = normalized[candidateIndex!]!;
  const candidateParams = params[candidateIndex!]!;
  expect(candidateQuery).toContain('inner join "issues"');
  expect(candidateQuery).toContain('inner join "missions"');
  expect(candidateQuery).toContain('"missions"."status" in');
  expect(candidateQuery.indexOf('"missions"."status" in')).toBeLessThan(candidateQuery.indexOf("order by"));
  expect(candidateQuery.indexOf("order by")).toBeLessThan(candidateQuery.lastIndexOf("limit"));
  expect(candidateQuery).not.toMatch(/::\s*uuid/);
  expect(candidateParams).toEqual(expect.arrayContaining(["planning", "active", "paused"]));
  expect(candidateParams.filter((value) => value === companyId)).toHaveLength(3);
  expect(candidateParams.at(-1)).toBe(candidateLimit);
}

const eventFor = (rows: Listings, eventId: string) =>
  rows.find((row) => row.requestState?.decisionEventId === eventId);

describePg("human operator request candidate window eligibility (PostgreSQL)", () => {
  let fixture: HumanRequestFixture | undefined;
  const h = () => {
    if (!fixture) throw new Error("fixture not started");
    return fixture;
  };

  beforeAll(async () => { fixture = await startHumanRequestFixture(); }, 60_000);
  afterAll(async () => { await fixture?.close(); });
  afterEach(async () => { await fixture?.reset(); });

  it("keeps older active and paused requests visible ahead of terminal history", async () => {
    const fx = h();
    const active = await fx.createWorld({ ownerStatus: "blocked", sourceStatus: "done", missionStatus: "active" });
    const pausedMissionId = randomUUID(), terminalMissionId = randomUUID();
    const pausedOwnerId = randomUUID(), terminalOwnerId = randomUUID();
    await fx.db.insert(missions).values([
      { id: pausedMissionId, companyId: active.companyId, ownerAgentId: active.agentId, title: "Paused mission", status: "paused" },
      { id: terminalMissionId, companyId: active.companyId, ownerAgentId: active.agentId, title: "Completed mission", status: "completed" },
    ]);
    await fx.db.insert(issues).values([
      { id: pausedOwnerId, companyId: active.companyId, missionId: pausedMissionId, title: "Paused owner", status: "blocked", assigneeAgentId: active.agentId },
      { id: terminalOwnerId, companyId: active.companyId, missionId: terminalMissionId, title: "Completed owner", status: "blocked", assigneeAgentId: active.agentId },
    ]);
    const paused = { ...active, missionId: pausedMissionId, ownerId: pausedOwnerId };
    const terminal = { ...active, missionId: terminalMissionId, ownerId: terminalOwnerId };
    const foreign = await fx.createWorld({ missionStatus: "active" });
    const base = new Date("2026-10-30T00:00:00.000Z");
    const terminalRows = Array.from({ length: 250 }, (_, index) => fx.activity(terminal,
      randomUUID(), { sourceId: null, createdAt: new Date(base.getTime() + index * 1_000) }));
    const activeEvent = randomUUID(), pausedEvent = randomUUID(), foreignEvent = randomUUID();
    const foreignOwnerEvent = randomUUID(), malformedEvent = randomUUID();
    await fx.addActivities([
      ...terminalRows,
      fx.activity(active, activeEvent, { createdAt: new Date(base.getTime() - 1_000) }),
      fx.activity(paused, pausedEvent, { sourceId: null, createdAt: new Date(base.getTime() - 2_000) }),
      fx.activity(active, malformedEvent, { ownerId: "not-a-uuid", createdAt: new Date(base.getTime() + 300_000) }),
      fx.activity(active, foreignOwnerEvent, { ownerId: foreign.ownerId, createdAt: new Date(base.getTime() + 300_500) }),
      fx.activity(foreign, foreignEvent, { createdAt: new Date(base.getTime() + 301_000) }),
    ]);

    const before = await durableSnapshot(fx);
    const cases = [
      { limit: 1, candidateLimit: 5, expected: [activeEvent] },
      { limit: undefined, candidateLimit: 250, expected: [activeEvent, pausedEvent] },
      { limit: 100, candidateLimit: 250, expected: [activeEvent, pausedEvent] },
    ];
    for (const scenario of cases) {
      fx.clearQueries();
      const rows = await listCompanyHumanOperatorRequests(fx.db, {
        companyId: active.companyId,
        ...(scenario.limit === undefined ? {} : { limit: scenario.limit }),
      });
      const queries = [...fx.queries], params = [...fx.queryParams];
      assertBoundedRead(queries, params, scenario.candidateLimit, active.companyId);

      expect(rows.map((row) => row.requestState?.decisionEventId)).toEqual(scenario.expected);
      expect(eventFor(rows, foreignEvent)).toBeUndefined();
      expect(eventFor(rows, foreignOwnerEvent)).toBeUndefined();
      expect(eventFor(rows, malformedEvent)).toBeUndefined();
      if (scenario.limit === undefined) {
        const activeRequest = eventFor(rows, activeEvent)!;
        expect(activeRequest.missionStatus).toBe("active");
        expect(activeRequest.issueId).toBe(active.ownerId);
        expect(activeRequest.event.scope?.issueId).toBe(active.ownerId);
        expect(activeRequest.event.suggestedResumeTarget?.issueId).toBe(active.ownerId);
        expect(activeRequest.requestState).toMatchObject({ ownerActionIssueId: active.ownerId, sourceIssueId: active.sourceId });
        expect(eventFor(rows, pausedEvent)?.missionStatus).toBe("paused");
        expect(rows).toHaveLength(2);
      }
      expect(await durableSnapshot(fx)).toEqual(before);
    }
  });
});

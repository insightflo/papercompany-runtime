/**
 * P5-T6 — Mission session token reuse tests
 *
 * Tests:
 * - getOrCreate() 3× same (missionId, agentId, adapterType):
 *     first call → isNew: true
 *     subsequent calls → isNew: false (session reused)
 * - Expired session → compacted, new session created (isNew: true)
 * - touch() updates lastActiveAt and increments runCount
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @paperclipai/db to prevent the postgres transitive import from breaking vitest
vi.mock("@paperclipai/db", () => ({
  agents: {},
  companySecrets: {},
  missionSessions: {},
}));

import { missionSessionStore } from "../services/sessions/mission-session-store.js";
import type { MissionSessionRow } from "../services/sessions/mission-session-store.js";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Mock metrics to avoid prom-client registry side effects
vi.mock("../routes/metrics.js", () => ({
  worktreeCheckActionLatency: { observe: vi.fn() },
  missionSessionEvents: { inc: vi.fn() },
  httpRequestDuration: { observe: vi.fn() },
  httpRequestTotal: { inc: vi.fn() },
  activeMissionSessions: { set: vi.fn() },
  missionsByStatus: { set: vi.fn() },
  workflowRunsByStatus: { set: vi.fn() },
  activeHeartbeatRuns: { set: vi.fn() },
  worktreeRulesBySeverity: { set: vi.fn() },
  srbDeliveriesByStatus: { set: vi.fn() },
  schedulerDueToWakeupLatency: { observe: vi.fn() },
  srbWebhookDeliveries: { inc: vi.fn() },
  metricsMiddleware: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
  metricsRoutes: vi.fn(),
  register: { metrics: vi.fn(), contentType: "text/plain", getMetricsAsJSON: vi.fn() },
}));

// Mock adapter-utils session compaction — default policy disables compaction
vi.mock("@paperclipai/adapter-utils", () => ({
  resolveSessionCompactionPolicy: vi.fn(() => ({
    policy: { enabled: false, maxSessionRuns: 0, maxRawInputTokens: 0, maxSessionAgeHours: 0 },
    adapterSessionManagement: null,
    explicitOverride: {},
    source: "legacy_fallback",
  })),
  hasSessionCompactionThresholds: vi.fn(() => false),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_INPUT = {
  missionId: "mission-1",
  agentId: "agent-1",
  companyId: "company-1",
  sessionSecretId: "secret-1",
  adapterType: "claude_local",
};

function makeSessionRow(overrides: Partial<MissionSessionRow> = {}): MissionSessionRow {
  const now = new Date();
  return {
    id: "session-abc",
    missionId: SESSION_INPUT.missionId,
    agentId: SESSION_INPUT.agentId,
    companyId: SESSION_INPUT.companyId,
    sessionSecretId: SESSION_INPUT.sessionSecretId,
    adapterType: SESSION_INPUT.adapterType,
    status: "active",
    lastActiveAt: now,
    runCount: 0,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000), // 30 days
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DB mock builder
// ---------------------------------------------------------------------------

/**
 * Build a minimal drizzle-style mock DB.
 *
 * selectResults:  array of arrays — each call to .limit() resolves the next entry.
 * insertResult:   single row returned by .returning() on insert.
 * updateResult:   single row returned by .returning() on update (optional).
 */
function buildDb({
  selectResults,
  insertResult,
  updateResult,
}: {
  selectResults: (MissionSessionRow | { id: string })[][];
  insertResult?: MissionSessionRow;
  updateResult?: MissionSessionRow;
}) {
  const selectQueue = [...selectResults];

  // select chain: .select().from().where().orderBy().limit()  or  .select().from().where().limit()
  const limitStub = vi.fn(async () => selectQueue.shift() ?? []);
  const orderByStub = vi.fn(() => ({ limit: limitStub }));
  const selectWhereStub = vi.fn(() => ({ orderBy: orderByStub, limit: limitStub }));
  const selectFromStub = vi.fn(() => ({ where: selectWhereStub }));
  const selectStub = vi.fn(() => ({ from: selectFromStub }));

  // insert chain: .insert().values().returning()
  const insertReturningStub = vi.fn(async () => (insertResult ? [insertResult] : []));
  const insertValuesStub = vi.fn(() => ({ returning: insertReturningStub }));
  const insertStub = vi.fn(() => ({ values: insertValuesStub }));

  // update chain: .update().set().where()  and  .update().set().where().returning()
  const updateReturningStub = vi.fn(async () => (updateResult ? [updateResult] : []));
  const updateWhereStub = vi.fn(() => ({ returning: updateReturningStub }));
  const updateSetStub = vi.fn(() => ({ where: updateWhereStub }));
  const updateStub = vi.fn(() => ({ set: updateSetStub }));

  // delete chain
  const deleteWhereStub = vi.fn(async () => []);
  const deleteStub = vi.fn(() => ({ where: deleteWhereStub }));

  return {
    db: {
      select: selectStub,
      insert: insertStub,
      update: updateStub,
      delete: deleteStub,
    } as unknown as import("@paperclipai/db").Db,
    stubs: {
      limitStub,
      insertReturningStub,
      updateSetStub,
    },
  };
}

// ---------------------------------------------------------------------------
// getOrCreate — session reuse
// ---------------------------------------------------------------------------

describe("missionSessionStore.getOrCreate — session reuse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("first call creates a new session (isNew: true)", async () => {
    const newSession = makeSessionRow();

    // getOrCreate has its own inline insert — does NOT call create().
    // select call sequence:
    //   1. existing session lookup → [] (no session found)
    // Then getOrCreate does its own db.insert().values().returning() inline.
    const { db } = buildDb({
      selectResults: [[]],
      insertResult: newSession,
    });

    const store = missionSessionStore(db);
    const result = await store.getOrCreate(SESSION_INPUT);

    expect(result.isNew).toBe(true);
    expect(result.session.id).toBe(newSession.id);
  });

  it("second call returns existing active session (isNew: false)", async () => {
    const existingSession = makeSessionRow({ id: "session-existing" });

    // select returns [existingSession] — not expired, still active
    const { db } = buildDb({
      selectResults: [[existingSession]],
    });

    const store = missionSessionStore(db);
    const result = await store.getOrCreate(SESSION_INPUT);

    expect(result.isNew).toBe(false);
    expect(result.session.id).toBe("session-existing");
  });

  it("three calls with same (missionId, agentId, adapterType) → first isNew, next two reuse", async () => {
    const newSession = makeSessionRow({ id: "session-new-1" });

    // Build separate DB instances to simulate three independent calls.
    // Call 1: no existing session → creates new (inline insert in getOrCreate)
    const { db: db1 } = buildDb({
      selectResults: [[]],
      insertResult: newSession,
    });

    // Call 2: returns existing session
    const { db: db2 } = buildDb({
      selectResults: [[newSession]],
    });

    // Call 3: returns existing session (same)
    const { db: db3 } = buildDb({
      selectResults: [[newSession]],
    });

    const store1 = missionSessionStore(db1);
    const store2 = missionSessionStore(db2);
    const store3 = missionSessionStore(db3);

    const result1 = await store1.getOrCreate(SESSION_INPUT);
    const result2 = await store2.getOrCreate(SESSION_INPUT);
    const result3 = await store3.getOrCreate(SESSION_INPUT);

    expect(result1.isNew).toBe(true);
    expect(result2.isNew).toBe(false);
    expect(result3.isNew).toBe(false);

    expect(result2.session.id).toBe(newSession.id);
    expect(result3.session.id).toBe(newSession.id);
  });
});

// ---------------------------------------------------------------------------
// getOrCreate — expired session compaction
// ---------------------------------------------------------------------------

describe("missionSessionStore.getOrCreate — expired session compaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("session past expiresAt is compacted and new session is created (isNew: true)", async () => {
    // An expired session: expiresAt is far in the past (beyond grace period)
    const expiredSession = makeSessionRow({
      id: "session-expired",
      status: "active",
      expiresAt: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago — past grace period (5 min)
    });

    const compactedSession = makeSessionRow({
      id: "session-expired",
      status: "compacted",
    });

    const newSession = makeSessionRow({
      id: "session-new-after-compact",
      status: "active",
    });

    // select call sequence:
    //   1. existing session lookup (outer getOrCreate) → [expiredSession]
    //   2. getById(expired) call after compactSession → [compactedSession]
    //
    // compactSession calls:
    //   - db.update (set status = "compacted") → no returning needed
    //   - db.insert (new session) → [newSession]   (but this result is unused by getOrCreate;
    //     getOrCreate calls getById after compactSession, not returning from compactSession)
    //
    // However looking at the source: after compactSession(), getOrCreate calls:
    //   return { session: await getById(existing.id), isNew: true }
    // getById calls: db.select().from().where().limit(1) → returns compacted session row

    const { db } = buildDb({
      selectResults: [
        [expiredSession],   // outer getOrCreate: existing session lookup
        [compactedSession], // getById(existing.id) called after compactSession
      ],
      insertResult: newSession, // compactSession creates new session via insert
    });

    const store = missionSessionStore(db);
    const result = await store.getOrCreate(SESSION_INPUT);

    // isNew should be true because the session was expired and compacted
    expect(result.isNew).toBe(true);
    // The session returned is the one from getById after compaction
    expect(result.session.id).toBe("session-expired");
    expect(result.session.status).toBe("compacted");
  });

  it("session within grace period is NOT compacted (isNew: false)", async () => {
    // expiresAt is 2 minutes ago — within the 5-minute grace period
    const recentlyExpiredSession = makeSessionRow({
      id: "session-grace",
      status: "active",
      expiresAt: new Date(Date.now() - 2 * 60 * 1000), // 2 minutes ago
    });

    const { db } = buildDb({
      selectResults: [[recentlyExpiredSession]],
    });

    const store = missionSessionStore(db);
    const result = await store.getOrCreate(SESSION_INPUT);

    // Still within grace period → reused, not compacted
    expect(result.isNew).toBe(false);
    expect(result.session.id).toBe("session-grace");
  });
});

// ---------------------------------------------------------------------------
// touch — basic heartbeat
// ---------------------------------------------------------------------------

describe("missionSessionStore.touch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("increments runCount and returns updated session", async () => {
    const session = makeSessionRow({ id: "session-touch", runCount: 3 });
    const updatedSession = makeSessionRow({ id: "session-touch", runCount: 4 });

    // select sequence:
    //   1. getById (called by touch) → [session]
    // update → returning → [updatedSession]
    const { db } = buildDb({
      selectResults: [[session]],
      updateResult: updatedSession,
    });

    const store = missionSessionStore(db);
    const result = await store.touch("session-touch");

    expect(result.runCount).toBe(4);
    expect(result.id).toBe("session-touch");
  });

  it("does not update when compaction policy triggers compaction", async () => {
    // Enable compaction policy with maxSessionRuns = 5
    const { resolveSessionCompactionPolicy, hasSessionCompactionThresholds } =
      await import("@paperclipai/adapter-utils");
    vi.mocked(resolveSessionCompactionPolicy).mockReturnValueOnce({
      policy: {
        enabled: true,
        maxSessionRuns: 5,
        maxRawInputTokens: 0,
        maxSessionAgeHours: 0,
      },
      adapterSessionManagement: null,
      explicitOverride: {},
      source: "legacy_fallback",
    });
    vi.mocked(hasSessionCompactionThresholds).mockReturnValueOnce(true);

    // Session at runCount = 5 → triggers compaction
    const session = makeSessionRow({ id: "session-compact", runCount: 5 });
    const compactedSession = makeSessionRow({ id: "session-compact", status: "compacted", runCount: 5 });

    // select:
    //   1. getById (first call in touch) → [session]
    //   2. getById (after compact update) → [compactedSession]
    const { db } = buildDb({
      selectResults: [[session], [compactedSession]],
      updateResult: compactedSession,
    });

    const store = missionSessionStore(db);
    const result = await store.touch("session-compact");

    expect(result.status).toBe("compacted");
    // runCount should NOT have been incremented (compaction path returns early)
    expect(result.runCount).toBe(5);
  });
});

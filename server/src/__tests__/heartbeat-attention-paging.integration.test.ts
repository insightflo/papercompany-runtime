import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  createBoundedReadsTestDb,
  freshAgent,
  freshCompany,
  seedRun,
} from "./helpers/bounded-reads-test-utils.js";
import {
  attentionHeartbeatRuns,
  listHeartbeatRunSummaryPage,
} from "../services/heartbeat-bounded-reads.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip bounded-read integration tests: ${support.reason ?? "unsupported"}`);

describeEP("heartbeat attention paging (integration)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentA: string;
  let agentB: string;

  beforeAll(async () => {
    const setup = await createBoundedReadsTestDb("heartbeat-attention-paging-");
    db = setup.db;
    tempDb = setup.tempDb;
    companyId = setup.companyId;
    agentA = await freshAgent(db, companyId);
    agentB = await freshAgent(db, companyId);
  });

  afterAll(async () => {
    if (tempDb) {
      await tempDb.cleanup();
      tempDb = null;
    }
  });

  async function runsForAgent(agentId: string) {
    return db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, createdAt: heartbeatRuns.createdAt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId))
      .orderBy(heartbeatRuns.createdAt);
  }

  it("attention does not hide an agent behind another agent with many recent runs", async () => {
    const company = await freshCompany(db);
    const busyAgent = await freshAgent(db, company);
    const quietAgent = await freshAgent(db, company);
    const base = Date.UTC(2026, 6, 5, 0, 0, 0);
    // busyAgent has 25 recent failures; quietAgent has a single older failure.
    for (let i = 0; i < 25; i += 1) {
      await seedRun(db, company, busyAgent, "failed", new Date(base + i * 60_000));
    }
    await seedRun(db, company, quietAgent, "failed", new Date(base - 60_000));

    const attention = await attentionHeartbeatRuns(db, { companyId: company, limit: 10 });
    expect(attention.summary.agents).toBe(2);
    expect(attention.summary.failed).toBe(2);
    expect(attention.items).toHaveLength(2);
    const agentIds = new Set(attention.items.map((item) => item.agentId));
    expect(agentIds.has(busyAgent)).toBe(true);
    expect(agentIds.has(quietAgent)).toBe(true);
  });

  it("attention summary counts agents beyond the first page", async () => {
    const company = await freshCompany(db);
    const base = Date.UTC(2026, 6, 6, 0, 0, 0);
    for (let i = 0; i < 15; i += 1) {
      const agentId = await freshAgent(db, company);
      await seedRun(db, company, agentId, "failed", new Date(base + i * 60_000));
    }

    const page1 = await attentionHeartbeatRuns(db, { companyId: company, limit: 5 });
    expect(page1.items).toHaveLength(5);
    expect(page1.nextCursor).not.toBeNull();
    // Exact summary covers ALL latest attention runs, not just this page.
    expect(page1.summary.agents).toBe(15);
    expect(page1.summary.agents).toBe(page1.summary.failed);
  });

  it("attention page 2 has no duplicates and continues after the cursor", async () => {
    const company = await freshCompany(db);
    const base = Date.UTC(2026, 6, 7, 0, 0, 0);
    for (let i = 0; i < 12; i += 1) {
      const agentId = await freshAgent(db, company);
      await seedRun(db, company, agentId, "failed", new Date(base + i * 60_000));
    }

    const page1 = await attentionHeartbeatRuns(db, { companyId: company, limit: 5 });
    expect(page1.items).toHaveLength(5);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await attentionHeartbeatRuns(db, {
      companyId: company,
      limit: 5,
      cursor: { createdAt: new Date(page1.nextCursor!.createdAt), id: page1.nextCursor!.id },
    });
    expect(page2.items).toHaveLength(5);

    const ids1 = new Set(page1.items.map((item) => item.runId));
    for (const item of page2.items) {
      expect(ids1.has(item.runId)).toBe(false);
    }
    // Page 2 items must be strictly older than the cursor item.
    const cursorTime = new Date(page1.nextCursor!.createdAt).getTime();
    const cursorId = page1.nextCursor!.id;
    for (const item of page2.items) {
      const time = item.createdAt.getTime();
      expect(time < cursorTime || (time === cursorTime && item.runId < cursorId)).toBe(true);
    }
  });

  it("attention with a stale/missing cursor does not repeat page 1", async () => {
    const company = await freshCompany(db);
    const base = Date.UTC(2026, 6, 8, 0, 0, 0);
    for (let i = 0; i < 12; i += 1) {
      const agentId = await freshAgent(db, company);
      await seedRun(db, company, agentId, "failed", new Date(base + i * 60_000));
    }

    const page1 = await attentionHeartbeatRuns(db, { companyId: company, limit: 5 });
    expect(page1.items).toHaveLength(5);

    // Cursor points at a boundary that is older than every eligible run
    // (the cursor row itself is stale/missing). Keyset comparison must end
    // the page instead of resetting to page 1.
    const staleCursor = {
      createdAt: new Date(page1.items[4]!.createdAt.getTime() - 10 * 60_000),
      id: "missing-run-id",
    };
    const stalePage = await attentionHeartbeatRuns(db, {
      companyId: company,
      limit: 5,
      cursor: staleCursor,
    });

    // No eligible rows are older than the stale boundary, so the page must
    // be empty — never a repeat of page 1.
    expect(stalePage.items).toHaveLength(0);
    expect(stalePage.nextCursor).toBeNull();
  });

  it("dismissedRunIds excludes off-page runs from the exact summary after refresh", async () => {
    const company = await freshCompany(db);
    const base = Date.UTC(2026, 6, 9, 0, 0, 0);
    const runIds: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const agentId = await freshAgent(db, company);
      runIds.push(await seedRun(db, company, agentId, "failed", new Date(base + i * 60_000)));
    }

    // Page 1 shows 5; page 2 holds the 7 older runs.
    const page1 = await attentionHeartbeatRuns(db, { companyId: company, limit: 5 });
    const page2 = await attentionHeartbeatRuns(db, {
      companyId: company,
      limit: 5,
      cursor: { createdAt: new Date(page1.nextCursor!.createdAt), id: page1.nextCursor!.id },
    });
    expect(page2.items).toHaveLength(5);

    // Dismiss one run from page 2, then "refresh": the exact summary must
    // drop it even though it is not on page 1.
    const dismissedRunId = page2.items[0]!.runId;
    const refreshed = await attentionHeartbeatRuns(db, {
      companyId: company,
      limit: 5,
      dismissedRunIds: [dismissedRunId],
    });
    expect(refreshed.summary.agents).toBe(11);
    expect(refreshed.summary.failed).toBe(11);
    // A stale dismissed id (not a current attention run) has no effect.
    const staleDismissed = await attentionHeartbeatRuns(db, {
      companyId: company,
      limit: 5,
      dismissedRunIds: [dismissedRunId, "missing-run-id"],
    });
    expect(staleDismissed.summary.agents).toBe(11);
    expect(staleDismissed.items.some((item) => item.runId === dismissedRunId)).toBe(false);
    void runIds;
  });
});

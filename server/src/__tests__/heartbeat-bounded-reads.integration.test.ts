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
  seedOpenIssue,
  seedResolvedIssue,
  seedRun,
} from "./helpers/bounded-reads-test-utils.js";
import {
  attentionHeartbeatRuns,
  countHeartbeatRuns,
  listHeartbeatRunSummaryPage,
} from "../services/heartbeat-bounded-reads.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip bounded-read integration tests: ${support.reason ?? "unsupported"}`);

describeEP("heartbeat bounded reads (integration)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentA: string;
  let agentB: string;

  beforeAll(async () => {
    const setup = await createBoundedReadsTestDb("heartbeat-bounded-reads-");
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

  it("pages DESC by createdAt and uses lt() on ties (id desc) so pages do not overlap", async () => {
    const now = Date.UTC(2026, 6, 10, 12, 0, 0);
    const created = (offsetMin: number) => new Date(now + offsetMin * 60_000);
    // Same createdAt for two runs (tie) to exercise id ordering.
    await seedRun(db, companyId, agentA, "succeeded", created(0));
    await seedRun(db, companyId, agentA, "failed", created(0));
    await seedRun(db, companyId, agentA, "succeeded", created(5));
    await seedRun(db, companyId, agentA, "succeeded", created(10));

    const page1 = await listHeartbeatRunSummaryPage(db, { companyId, agentId: agentA, limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    // Newest first; tie breaks by id desc.
    const newest = (await runsForAgent(agentA)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    expect(page1.items[0]!.id).toBe(newest[0]!.id);
    expect(page1.items[1]!.id).toBe(newest[1]!.id);

    const page2 = await listHeartbeatRunSummaryPage(db, {
      companyId,
      agentId: agentA,
      limit: 2,
      cursor: { createdAt: page1.items[1]!.createdAt, id: page1.items[1]!.id },
    });
    expect(page2.items).toHaveLength(2);
    const seenIds = new Set([...page1.items, ...page2.items].map((r) => r.id));
    expect(seenIds.size).toBe(4);
    // No overlap: page2 must not contain the last item of page1.
    expect(page2.items.some((r) => r.id === page1.items[1]!.id)).toBe(false);
  });

  it("maps DB timed_out to the timedOut count field", async () => {
    await seedRun(db, companyId, agentB, "timed_out", new Date());
    await seedRun(db, companyId, agentB, "succeeded", new Date());
    const counts = await countHeartbeatRuns(db, { companyId, agentId: agentB });
    expect(counts.timedOut).toBe(1);
    expect(counts.succeeded).toBe(1);
    expect(counts.total).toBe(2);
  });

  it("attention picks the latest run per agent across all statuses (later success clears older failure)", async () => {
    await seedRun(db, companyId, agentA, "failed", new Date(Date.UTC(2026, 6, 1, 0, 0, 0)));
    await seedRun(db, companyId, agentA, "succeeded", new Date(Date.UTC(2026, 6, 2, 0, 0, 0)));

    const attention = await attentionHeartbeatRuns(db, { companyId, agentId: agentA });
    expect(attention.items).toHaveLength(0);
    expect(attention.summary.agents).toBe(0);
    expect(attention.summary.failed).toBe(0);
  });

  it("attention keeps the latest failure when it is still the latest run", async () => {
    const agentId = await freshAgent(db, companyId);
    await seedRun(db, companyId, agentId, "failed", new Date(Date.UTC(2026, 6, 1, 0, 0, 0)));
    await seedRun(db, companyId, agentId, "failed", new Date(Date.UTC(2026, 6, 3, 0, 0, 0)), { error: "boom" });

    const attention = await attentionHeartbeatRuns(db, { companyId, agentId });
    expect(attention.items).toHaveLength(1);
    expect(attention.items[0]!.status).toBe("failed");
    expect(attention.items[0]!.error).toBe("boom");
    expect(attention.summary.failed).toBe(1);
  });

  it("attention excludes runs whose issue is already resolved", async () => {
    const agentId = await freshAgent(db, companyId);
    const issueId = await seedResolvedIssue(db, companyId);
    await seedRun(db, companyId, agentId, "failed", new Date(), { issueId });

    const attention = await attentionHeartbeatRuns(db, { companyId, agentId });
    expect(attention.items).toHaveLength(0);
    expect(attention.summary.agents).toBe(0);
  });

  it("attention includes an unresolved-issue failure", async () => {
    const agentId = await freshAgent(db, companyId);
    const issueId = await seedOpenIssue(db, companyId);
    await seedRun(db, companyId, agentId, "timed_out", new Date(), { issueId });

    const attention = await attentionHeartbeatRuns(db, { companyId, agentId });
    expect(attention.items).toHaveLength(1);
    expect(attention.items[0]!.issueId).toBe(issueId);
    expect(attention.summary.timedOut).toBe(1);
  });

  it("lightweight summary excludes heavy payload columns", async () => {
    const id = await seedRun(db, companyId, agentA, "succeeded", new Date(), {
      contextSnapshot: { issueId: "x" },
      resultJson: { summary: "huge" },
      stdoutExcerpt: "out",
      stderrExcerpt: "err",
      logRef: "s3://bucket/log",
      logBytes: 123,
      usageJson: { inputTokens: 10 },
    });
    const page = await listHeartbeatRunSummaryPage(db, { companyId, agentId: agentA, limit: 100 });
    const match = page.items.find((r) => r.id === id);
    expect(match).toBeDefined();
    expect(match!.contextSnapshot).toBeUndefined();
    expect(match!.resultJson).toBeUndefined();
    expect(match!.resultSummary).toBe("huge");
    expect(match!.stdoutExcerpt).toBeUndefined();
    expect(match!.stderrExcerpt).toBeUndefined();
    expect(match!.logRef).toBeUndefined();
    expect(match!.logBytes).toBeUndefined();
    expect(match!.usageJson).toEqual({ inputTokens: 10 });
  });
});

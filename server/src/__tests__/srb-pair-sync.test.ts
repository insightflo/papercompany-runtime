import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issues,
  srbIssuePairs,
  srbLinks,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

import { createSrbPairSync } from "../services/srb/pair-sync.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres SRB pair sync tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("SRB pair sync", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-srb-pair-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(srbIssuePairs);
    await db.delete(issues);
    await db.delete(srbLinks);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("persists the pair before initial blocked sync on local mirror creation", async () => {
    const sourceCompanyId = randomUUID();
    const mirrorCompanyId = randomUUID();
    const linkId = randomUUID();
    const sourceIssueId = randomUUID();
    const mirrorIssueId = randomUUID();
    const inboundReceive = vi.fn(async (tx: Pick<typeof db, "insert" | "update" | "select" | "delete">) => {
      await tx.insert(issues).values({
        id: mirrorIssueId,
        companyId: mirrorCompanyId,
        title: "Mirror issue",
        status: "todo",
      });
      return {
        deliveryId: "delivery-1",
        issueId: mirrorIssueId,
        issueIdentifier: "MC-1",
        status: "received" as const,
        postCommit: {
          actorId: linkId,
          issue: {
            id: mirrorIssueId,
            companyId: mirrorCompanyId,
            title: "Mirror issue",
            identifier: "MC-1",
            assigneeAgentId: null,
            status: "todo",
          },
        },
      };
    });
    const heartbeat = { wakeup: vi.fn().mockResolvedValue({ id: "run-1" }) };
    const sync = createSrbPairSync(db, {
      inbound: {
        receive: inboundReceive,
      },
      heartbeat: heartbeat as never,
      issueSvc: {
        ...issueService(db),
        update: vi.fn(async (id, patch) => {
          const pair = await db
            .select()
            .from(srbIssuePairs)
            .where(eq(srbIssuePairs.sourceIssueId, sourceIssueId))
            .then((rows) => rows[0] ?? null);
          expect(pair).toMatchObject({
            sourceIssueId,
            mirrorIssueId,
          });
          return await issueService(db).update(id, patch);
        }),
      },
    });

    await db.insert(companies).values([
      {
        id: sourceCompanyId,
        name: "Source Co",
        issuePrefix: `SC${sourceCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: mirrorCompanyId,
        name: "Mirror Co",
        issuePrefix: `MC${mirrorCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(srbLinks).values({
      id: linkId,
      localCompanyId: sourceCompanyId,
      remoteCompanyId: mirrorCompanyId,
      remoteServerUrl: null,
      direction: "two_way",
      createdBy: "test",
    });

    await db.insert(issues).values([
      {
        id: sourceIssueId,
        companyId: sourceCompanyId,
        title: "Source issue",
        status: "blocked",
      },
    ]);

    const result = await sync.createLocalPairFromSourceIssue({
      linkId,
      sourceIssueId,
      payload: {
        title: "Mirror issue",
        status: "todo",
      },
      createdBy: "workflow",
    });

    expect(result.pair).toMatchObject({
      linkId,
      sourceIssueId,
      mirrorIssueId,
      statusSyncMode: "blocked_only",
      lastSyncedStatus: "blocked",
    });
    expect(inboundReceive).toHaveBeenCalledTimes(1);
    const mirrorIssue = await db.select().from(issues).where(eq(issues.id, mirrorIssueId)).then((rows) => rows[0] ?? null);
    expect(mirrorIssue?.status).toBe("blocked");
  });

  it("reuses an existing pair instead of creating a duplicate mirror on retry", async () => {
    const sourceCompanyId = randomUUID();
    const mirrorCompanyId = randomUUID();
    const linkId = randomUUID();
    const sourceIssueId = randomUUID();
    const mirrorIssueId = randomUUID();
    const inboundReceive = vi.fn();
    const sync = createSrbPairSync(db, {
      inbound: { receive: inboundReceive },
    });

    await db.insert(companies).values([
      {
        id: sourceCompanyId,
        name: "Source Co",
        issuePrefix: `SQ${sourceCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: mirrorCompanyId,
        name: "Mirror Co",
        issuePrefix: `MQ${mirrorCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(srbLinks).values({
      id: linkId,
      localCompanyId: sourceCompanyId,
      remoteCompanyId: mirrorCompanyId,
      remoteServerUrl: null,
      direction: "two_way",
      createdBy: "test",
    });
    await db.insert(issues).values([
      {
        id: sourceIssueId,
        companyId: sourceCompanyId,
        title: "Source issue",
        status: "todo",
      },
      {
        id: mirrorIssueId,
        companyId: mirrorCompanyId,
        title: "Mirror issue",
        status: "todo",
        identifier: "MQ-1",
      },
    ]);
    const [existingPair] = await db.insert(srbIssuePairs).values({
      linkId,
      sourceCompanyId,
      sourceIssueId,
      mirrorCompanyId,
      mirrorIssueId,
      statusSyncMode: "blocked_only",
      createdBy: "test",
    }).returning();

    const result = await sync.createLocalPairFromSourceIssue({
      linkId,
      sourceIssueId,
      payload: {
        title: "Mirror issue",
      },
      createdBy: "workflow",
    });

    expect(inboundReceive).not.toHaveBeenCalled();
    expect(result.pair.id).toBe(existingPair.id);
    expect(result.mirrorIssueId).toBe(mirrorIssueId);
    expect(result.mirrorIssueIdentifier).toBe("MQ-1");
    const pairs = await db.select().from(srbIssuePairs).where(eq(srbIssuePairs.linkId, linkId));
    expect(pairs).toHaveLength(1);
  });

  it("returns the canonical pair when two same-link/source creations race", async () => {
    const sourceCompanyId = randomUUID();
    const mirrorCompanyId = randomUUID();
    const linkId = randomUUID();
    const sourceIssueId = randomUUID();
    const mirrorIssueIdA = randomUUID();
    const mirrorIssueIdB = randomUUID();
    let callCount = 0;
    const inboundReceive = vi.fn(async (tx: Pick<typeof db, "insert" | "update" | "select" | "delete">) => {
      callCount += 1;
      const mirrorIssueId = callCount === 1 ? mirrorIssueIdA : mirrorIssueIdB;
      await tx.insert(issues).values({
        id: mirrorIssueId,
        companyId: mirrorCompanyId,
        title: `Mirror issue ${callCount}`,
        status: "todo",
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        deliveryId: `delivery-${callCount}`,
        issueId: mirrorIssueId,
        issueIdentifier: `MR-${callCount}`,
        status: "received" as const,
        postCommit: {
          actorId: linkId,
          issue: {
            id: mirrorIssueId,
            companyId: mirrorCompanyId,
            title: `Mirror issue ${callCount}`,
            identifier: `MR-${callCount}`,
            assigneeAgentId: null,
            status: "todo",
          },
        },
      };
    });
    const sync = createSrbPairSync(db, {
      inbound: { receive: inboundReceive },
      heartbeat: { wakeup: vi.fn().mockResolvedValue({ id: "run-1" }) } as never,
    });

    await db.insert(companies).values([
      {
        id: sourceCompanyId,
        name: "Source Co",
        issuePrefix: `RC${sourceCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: mirrorCompanyId,
        name: "Mirror Co",
        issuePrefix: `RM${mirrorCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(srbLinks).values({
      id: linkId,
      localCompanyId: sourceCompanyId,
      remoteCompanyId: mirrorCompanyId,
      remoteServerUrl: null,
      direction: "two_way",
      createdBy: "test",
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId: sourceCompanyId,
      title: "Source issue",
      status: "todo",
    });

    const [first, second] = await Promise.all([
      sync.createLocalPairFromSourceIssue({
        linkId,
        sourceIssueId,
        payload: { title: "Mirror issue" },
        createdBy: "workflow",
      }),
      sync.createLocalPairFromSourceIssue({
        linkId,
        sourceIssueId,
        payload: { title: "Mirror issue" },
        createdBy: "workflow",
      }),
    ]);

    expect(inboundReceive.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(inboundReceive.mock.calls.length).toBeLessThanOrEqual(2);
    expect(first.pair.id).toBe(second.pair.id);
    expect(first.mirrorIssueId).toBe(second.mirrorIssueId);
    const pairs = await db.select().from(srbIssuePairs).where(eq(srbIssuePairs.linkId, linkId));
    expect(pairs).toHaveLength(1);
  });

  it("propagates later source blocked updates to the mirror and stamps the durable pair", async () => {
    const sourceCompanyId = randomUUID();
    const mirrorCompanyId = randomUUID();
    const linkId = randomUUID();
    const sourceIssueId = randomUUID();
    const mirrorIssueId = randomUUID();
    const sync = createSrbPairSync(db);

    await db.insert(companies).values([
      {
        id: sourceCompanyId,
        name: "Source Co",
        issuePrefix: `SX${sourceCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: mirrorCompanyId,
        name: "Mirror Co",
        issuePrefix: `MX${mirrorCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(srbLinks).values({
      id: linkId,
      localCompanyId: sourceCompanyId,
      remoteCompanyId: mirrorCompanyId,
      remoteServerUrl: null,
      direction: "two_way",
      createdBy: "test",
    });
    await db.insert(issues).values([
      {
        id: sourceIssueId,
        companyId: sourceCompanyId,
        title: "Source issue",
        status: "todo",
      },
      {
        id: mirrorIssueId,
        companyId: mirrorCompanyId,
        title: "Mirror issue",
        status: "todo",
      },
    ]);
    await db.insert(srbIssuePairs).values({
      linkId,
      sourceCompanyId,
      sourceIssueId,
      mirrorCompanyId,
      mirrorIssueId,
      statusSyncMode: "blocked_only",
      createdBy: "test",
    });

    const synced = await sync.syncBlockedStatus({
      sourceIssueId,
      sourceStatus: "blocked",
    });

    expect(synced).toHaveLength(1);
    expect(synced[0]).toMatchObject({
      sourceIssueId,
      mirrorIssueId,
      lastSyncedStatus: "blocked",
    });
    const mirrorIssue = await db.select().from(issues).where(eq(issues.id, mirrorIssueId)).then((rows) => rows[0] ?? null);
    expect(mirrorIssue?.status).toBe("blocked");
  });

  it("mirrors the full source status on initial pair creation when configured", async () => {
    const sourceCompanyId = randomUUID();
    const mirrorCompanyId = randomUUID();
    const linkId = randomUUID();
    const sourceIssueId = randomUUID();
    const mirrorIssueId = randomUUID();
    const inboundReceive = vi.fn(async (tx: Pick<typeof db, "insert" | "update" | "select" | "delete">) => {
      await tx.insert(issues).values({
        id: mirrorIssueId,
        companyId: mirrorCompanyId,
        title: "Mirror issue",
        status: "todo",
      });
      return {
        deliveryId: "delivery-1",
        issueId: mirrorIssueId,
        issueIdentifier: "MC-2",
        status: "received" as const,
        postCommit: {
          actorId: linkId,
          issue: {
            id: mirrorIssueId,
            companyId: mirrorCompanyId,
            title: "Mirror issue",
            identifier: "MC-2",
            assigneeAgentId: null,
            status: "todo",
          },
        },
      };
    });
    const sync = createSrbPairSync(db, {
      inbound: { receive: inboundReceive },
      heartbeat: { wakeup: vi.fn().mockResolvedValue({ id: "run-1" }) } as never,
    });

    await db.insert(companies).values([
      {
        id: sourceCompanyId,
        name: "Source Co",
        issuePrefix: `FS${sourceCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: mirrorCompanyId,
        name: "Mirror Co",
        issuePrefix: `FM${mirrorCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(srbLinks).values({
      id: linkId,
      localCompanyId: sourceCompanyId,
      remoteCompanyId: mirrorCompanyId,
      remoteServerUrl: null,
      direction: "two_way",
      createdBy: "test",
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId: sourceCompanyId,
      title: "Source issue",
      status: "done",
    });

    const result = await sync.createLocalPairFromSourceIssue({
      linkId,
      sourceIssueId,
      payload: { title: "Mirror issue", status: "todo" },
      createdBy: "workflow",
      statusSyncMode: "mirror_source_status",
    });

    expect(result.pair).toMatchObject({
      statusSyncMode: "mirror_source_status",
      lastSyncedStatus: "done",
    });
    const mirrorIssue = await db.select().from(issues).where(eq(issues.id, mirrorIssueId)).then((rows) => rows[0] ?? null);
    expect(mirrorIssue?.status).toBe("done");
  });

  it("mirrors later non-blocked source status updates when configured for full status sync", async () => {
    const sourceCompanyId = randomUUID();
    const mirrorCompanyId = randomUUID();
    const linkId = randomUUID();
    const sourceIssueId = randomUUID();
    const mirrorIssueId = randomUUID();
    const sync = createSrbPairSync(db);

    await db.insert(companies).values([
      {
        id: sourceCompanyId,
        name: "Source Co",
        issuePrefix: `US${sourceCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: mirrorCompanyId,
        name: "Mirror Co",
        issuePrefix: `UM${mirrorCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(srbLinks).values({
      id: linkId,
      localCompanyId: sourceCompanyId,
      remoteCompanyId: mirrorCompanyId,
      remoteServerUrl: null,
      direction: "two_way",
      createdBy: "test",
    });
    await db.insert(issues).values([
      {
        id: sourceIssueId,
        companyId: sourceCompanyId,
        title: "Source issue",
        status: "done",
      },
      {
        id: mirrorIssueId,
        companyId: mirrorCompanyId,
        title: "Mirror issue",
        status: "todo",
      },
    ]);
    await db.insert(srbIssuePairs).values({
      linkId,
      sourceCompanyId,
      sourceIssueId,
      mirrorCompanyId,
      mirrorIssueId,
      statusSyncMode: "mirror_source_status",
      createdBy: "test",
    });

    const synced = await sync.syncSourceStatus({
      sourceIssueId,
      sourceStatus: "done",
    });

    expect(synced).toHaveLength(1);
    expect(synced[0]).toMatchObject({
      sourceIssueId,
      mirrorIssueId,
      lastSyncedStatus: "done",
    });
    const mirrorIssue = await db.select().from(issues).where(eq(issues.id, mirrorIssueId)).then((rows) => rows[0] ?? null);
    expect(mirrorIssue?.status).toBe("done");
  });
});

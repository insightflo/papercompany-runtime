import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping issue counter self-heal tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService.create counter self-heal", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-counter-heal-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("mints a fresh identifier when a row bypassed the counter (no duplicate-key wedge)", async () => {
    const companyId = randomUUID();
    const issuePrefix = `CH${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "CounterHealCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    // Normal creation through the counter.
    const first = await svc.create(companyId, {
      createdByUserId: "operator",
      originKind: "manual",
      status: "todo",
      title: "counter-based issue",
    });
    expect(first.issueNumber).toBe(1);
    expect(first.identifier).toBe(`${issuePrefix}-1`);

    // Simulate an import/manual insert that bypasses the company counter with a
    // higher number — the exact condition that produced the RES-5200 wedge.
    await db.insert(issues).values({
      companyId,
      issueNumber: 5200,
      identifier: `${issuePrefix}-5200`,
      title: "imported row that bypassed the counter",
      status: "todo",
      originKind: "manual",
    });
    // Counter lagging just below the bypassed number, as found in production.
    await db
      .update(companies)
      .set({ issueCounter: 5199 })
      .where(eq(companies.id, companyId));

    // Before the fix this insert violated issues_identifier_idx and rolled back
    // the counter bump forever; now the counter self-heals past the bypass row.
    const second = await svc.create(companyId, {
      createdByUserId: "operator",
      originKind: "manual",
      status: "todo",
      title: "issue after bypass",
    });
    expect(second.issueNumber).toBe(5201);
    expect(second.identifier).toBe(`${issuePrefix}-5201`);

    const third = await svc.create(companyId, {
      createdByUserId: "operator",
      originKind: "manual",
      status: "todo",
      title: "issue after heal stays sequential",
    });
    expect(third.issueNumber).toBe(5202);
  });
});

import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, approvals, activityLog } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedReplacement } from "./helpers/replacement-scenario.js";
import * as lifecycle from "../services/workflow/replacement-approval.js";
import { admitReplacement } from "../services/workflow/replacement-admission.js";
import { approvalService } from "../services/approvals.js";

describe("replacement board lifecycle", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  const roots: string[] = [];
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("replacement-lifecycle-"); db = createDb(temp.connectionString); }, 60_000);
  afterAll(async () => { await db.$client.end(); await temp.cleanup(); roots.forEach(r => rmSync(r, { recursive: true, force: true })); });
  async function seed() { const s = await seedReplacement(db, false); roots.push(s.tempRoot); return s; }
  async function row(id: string) { return (await db.select().from(approvals).where(eq(approvals.id, id)))[0]; }
  it("proposes only the approved contract, requests revision and resubmits before approval", async () => {
    const s = await seed();
    expect(s.proposal.payload).not.toHaveProperty("userFixDigest");
    expect(s.proposal.payload).not.toHaveProperty("approvedBaseHash");
    expect(s.proposal.payload).not.toHaveProperty("priorIntentKey");
    await lifecycle.resolveReplacement(db, s.companyId, s.proposal.id, s.board, "revision_requested", { decisionNote: "Fix inputs" });
    expect((await row(s.proposal.id)).status).toBe("revision_requested");
    await expect(lifecycle.approveReplacement(db, s.companyId, s.proposal.id, s.board)).rejects.toThrow("replacement_approval_stale");
    const revised = await lifecycle.resubmitReplacement(db, s.companyId, s.proposal.id, s.board, { metadata: { note: "reviewed" } });
    expect(revised).toMatchObject({ status: "pending", decidedByUserId: null });
    expect(revised.payload).toMatchObject({ metadata: { note: "reviewed" }, targetRunId: s.proposal.payload.targetRunId });
    expect(revised.payload.inputHash).not.toBe(s.proposal.payload.inputHash);
    await lifecycle.approveReplacement(db, s.companyId, s.proposal.id, s.board);
    const approved = await row(s.proposal.id);
    expect(approved.decidedByUserId).toBe("local-board");
    await expect(lifecycle.resubmitReplacement(db, s.companyId, s.proposal.id, s.board, {})).rejects.toThrow();
    await expect(lifecycle.resolveReplacement(db, s.companyId, s.proposal.id, s.board, "rejected", {})).rejects.toThrow();
    expect(await row(s.proposal.id)).toEqual(approved);
  });
  it("reject and revision require authenticated same-company board, never payload provenance", async () => {
    const s = await seed(), before = await row(s.proposal.id);
    for (const action of ["rejected", "revision_requested"] as const) {
      await expect(lifecycle.resolveReplacement(db, s.companyId, s.proposal.id, s.actor, action, {})).rejects.toThrow("replacement_operator_required");
      await expect(lifecycle.resolveReplacement(db, s.companyId, s.proposal.id, { type: "board", userId: "outsider", companyIds: [randomUUID()] }, action, {})).rejects.toThrow();
      await expect(lifecycle.resolveReplacement(db, randomUUID(), s.proposal.id, s.board, action, {})).rejects.toThrow();
      await expect(lifecycle.resolveReplacement(db, s.companyId, s.proposal.id, s.board, action, { decidedByUserId: "forged" })).rejects.toThrow();
    }
    expect(await row(s.proposal.id)).toEqual(before);
    const rejected = await lifecycle.resolveReplacement(db, s.companyId, s.proposal.id, s.board, "rejected", { decisionNote: "No restart" });
    expect(rejected).toMatchObject({ status: "rejected", decidedByUserId: "local-board", decisionNote: "No restart" });
    expect((await db.select().from(activityLog).where(eq(activityLog.entityId, s.proposal.id))).map(r => r.action)).toContain("workflow.replacement_rejected");
  });
  it("approve versus revision has one winner, approved payload is immutable", async () => {
    const s = await seed();
    const outcomes = await Promise.allSettled([
      lifecycle.approveReplacement(db, s.companyId, s.proposal.id, s.board),
      lifecycle.resolveReplacement(db, s.companyId, s.proposal.id, s.board, "revision_requested", {}),
    ]);
    expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await row(s.proposal.id)).payload).toEqual(s.proposal.payload);
  });
  it("comments remain readable without granting generic mutation authority", async () => {
    const s = await seed();
    expect(await approvalService(db).listComments(s.proposal.id)).toEqual([]);
    await expect(approvalService(db).requestRevision(s.proposal.id, "agent:pretend")).rejects.toThrow("board-only");
  });
  it("resubmit racing approval never changes an already approved payload", async () => {
    const s = await seed();
    await lifecycle.resolveReplacement(db, s.companyId, s.proposal.id, s.board, "revision_requested", {});
    const outcomes = await Promise.allSettled([
      lifecycle.resubmitReplacement(db, s.companyId, s.proposal.id, s.board, { metadata: { edit: "before approval" } }),
      lifecycle.approveReplacement(db, s.companyId, s.proposal.id, s.board),
    ]);
    expect(outcomes[0].status).toBe("fulfilled");
    if ((await row(s.proposal.id)).status === "pending") await lifecycle.approveReplacement(db, s.companyId, s.proposal.id, s.board);
    const approved = await row(s.proposal.id);
    expect(approved.payload.metadata).toEqual({ edit: "before approval" });
    await expect(lifecycle.resubmitReplacement(db, s.companyId, s.proposal.id, s.board, { metadata: {} })).rejects.toThrow();
    expect(await row(s.proposal.id)).toEqual(approved);
  });
  it("consumed approval cannot change; exact replay returns original terminal target", async () => {
    const s = await seed(); await lifecycle.approveReplacement(db, s.companyId, s.proposal.id, s.board);
    const target = await admitReplacement(db, s.input, s.actor);
    const before = await row(s.proposal.id);
    await expect(lifecycle.resubmitReplacement(db, s.companyId, s.proposal.id, s.board, { metadata: { changed: true } })).rejects.toThrow();
    expect(await row(s.proposal.id)).toEqual(before);
    expect(await admitReplacement(db, s.input, s.actor)).toMatchObject({ replay: true, run: { id: target.run.id } });
    await expect(admitReplacement(db, { ...s.input, replacementIntent: { ...s.input.replacementIntent, idempotencyKey: "new-key" } }, s.actor)).rejects.toThrow("replacement_authority_consumed");
  });
});

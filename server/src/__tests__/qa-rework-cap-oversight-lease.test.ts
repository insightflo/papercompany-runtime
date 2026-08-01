import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, createDb, issues, missions, workflowTransitionEvents } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  buildQaCapKeyHash, buildQaCapKeyMarker, ensureQaReworkCapOversightIssue, fencedLinkAndUnhide,
  isQaReworkCapOversightIssue,
} from "../services/missions/qa-rework-cap-oversight.js";
import {
  cleanQaCapFixture, loadQaCapStepRows, seedQaCapBase, seedQaCapWorkflow,
  seedStepHeartbeat, seedWorkflowVerdict, type QaCapTestDb,
} from "./helpers/qa-cap-oversight-fixture.js";
import { detectQaReworkCapExhaustion } from "../services/missions/qa-rework-cap-oversight-detection.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`skip qa-cap lease: ${support.reason ?? "unsupported"}`);

async function setupScenario(db: QaCapTestDb, stepId: string) {
  const base = await seedQaCapBase(db);
  const seed = await seedQaCapWorkflow(db, base, { iteration: 2, edges: [{ stepId, maxIterations: 2 }] });
  const qa = seed.qas[0]!;
  const hb = await seedStepHeartbeat(db, base, {
    workflowRunId: seed.runId, workflowStepRunId: qa.stepRunId, issueId: qa.issueId,
    createdAt: new Date(Date.now() - 10_000),
  });
  await seedWorkflowVerdict(db, base, {
    workflowRunId: seed.runId, workflowStepRunId: qa.stepRunId, issueId: qa.issueId,
    heartbeatRunId: hb, createdAt: new Date(Date.now() - 9_000),
  });
  const [exhaustion] = await detectQaReworkCapExhaustion({
    db, companyId: base.companyId, stepRows: await loadQaCapStepRows(db, base),
  });
  const keyHash = buildQaCapKeyHash({
    companyId: base.companyId, workflowRunId: exhaustion.workflowRunId,
    producerStepId: exhaustion.producerStepId, qaStepId: exhaustion.qaStepId,
    producerIteration: exhaustion.producerIteration, producerCompletedAt: exhaustion.producerCompletedAt,
  });
  const token = `lease:${Date.now() - 120_000}:stale`;
  await db.insert(workflowTransitionEvents).values({
    companyId: base.companyId, missionId: base.missionId,
    workflowRunId: exhaustion.workflowRunId, workflowStepRunId: exhaustion.qaStepRunId,
    eventType: "qa_cap_oversight_claim", layer: "workflow_validation",
    idempotencyKey: `qa-cap-oversight:${keyHash}`, correlationId: token,
    payload: { kind: "qa_cap_oversight_claim", keyHash, ...exhaustion },
    createdAt: new Date(Date.now() - 120_000),
  });
  const [mission] = await db.select().from(missions).where(eq(missions.id, base.missionId));
  const [oversight] = await db.insert(issues).values({
    companyId: base.companyId, missionId: base.missionId, title: `[OVERSIGHT] ${stepId}`,
    status: "todo", originKind: "mission_main_executor_oversight", assigneeAgentId: base.agentId,
  }).returning();
  const [claim] = await db.select().from(workflowTransitionEvents)
    .where(and(eq(workflowTransitionEvents.companyId, base.companyId), eq(workflowTransitionEvents.eventType, "qa_cap_oversight_claim"))).limit(1);
  return { base, exhaustion, mission, oversight, keyHash, claimId: claim!.id };
}

function issueSpy(db: QaCapTestDb, base: any, oversight: any) {
  let count = 0;
  const fn = vi.fn(async (_co: string, data: any) => {
    count++;
    const [row] = await db.insert(issues).values({
      companyId: base.companyId, missionId: base.missionId, title: data.title,
      status: "todo", description: data.description, assigneeAgentId: base.agentId,
      originKind: "mission_main_executor_unblock", originId: oversight.id,
      hiddenAt: data.hiddenAt ?? null,
    }).returning();
    return row;
  });
  return { fn, getCount: () => count };
}

function wakeWithCoverage(db: QaCapTestDb, base: any) {
  let wakeCount = 0;
  const fn = vi.fn(async (input: { reason?: string; issue?: { id: string } }) => {
    if (input.reason !== "qa_rework_cap_oversight_created") return { id: "other" };
    wakeCount++;
    await db.insert(agentWakeupRequests).values({
      companyId: base.companyId, agentId: base.agentId, source: "assignment",
      status: "queued", reason: "test", issueId: input.issue!.id, missionId: base.missionId,
    });
    return { id: "ok" };
  });
  return { fn, getWakeCount: () => wakeCount };
}

const visibleCap = (rows: any[]) => rows.filter((r) => isQaReworkCapOversightIssue(r.description) && !r.hiddenAt).length;

describeEP("QA cap oversight lease/fencing CAS", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => { tempDb = await startEmbeddedPostgresTestDatabase("qa-cap-lease-"); db = createDb(tempDb.connectionString); }, 60_000);
  afterEach(async () => { await cleanQaCapFixture(db); });
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  it("fresh lease: B returns null while A is paused inside createIssue", async () => {
    const { base, exhaustion, mission, oversight } = await setupScenario(db, "qa-fresh");
    const spy = issueSpy(db, base, oversight);
    const wake = wakeWithCoverage(db, base);
    let resolveA!: () => void;
    let resolveEntered!: () => void;
    const entered = new Promise<void>((r) => { resolveEntered = r; });
    const aHold = new Promise<void>((r) => { resolveA = r; });
    const aCreateFn = vi.fn(async (co: string, data: any) => {
      const row = await spy.fn(co, data);
      resolveEntered();
      await aHold;
      return row;
    });
    const aPromise = ensureQaReworkCapOversightIssue({ db, mission, oversightIssue: oversight, exhaustion, workflowName: "WF", createIssue: aCreateFn, onOwnerActionCreated: wake.fn });
    await entered; // A is deterministically inside createIssue — claim unlinked, lease fresh.
    const bResult = await ensureQaReworkCapOversightIssue({ db, mission, oversightIssue: oversight, exhaustion, workflowName: "WF", createIssue: spy.fn, onOwnerActionCreated: wake.fn });
    expect(bResult).toBeNull();
    expect(spy.getCount()).toBe(1);
    resolveA();
    await aPromise;
    expect(wake.getWakeCount()).toBe(1);
  });

  it("stale race: A paused after hidden create, B takeover reuses hidden issue, A fails", async () => {
    const { base, exhaustion, mission, oversight, claimId } = await setupScenario(db, "qa-stale");
    const spy = issueSpy(db, base, oversight);
    const wake = wakeWithCoverage(db, base);
    let resolveA!: () => void;
    let resolveEntered!: () => void;
    const entered = new Promise<void>((r) => { resolveEntered = r; });
    const aHold = new Promise<void>((r) => { resolveA = r; });
    const aCreateFn = vi.fn(async (co: string, data: any) => {
      const row = await spy.fn(co, data);
      resolveEntered();
      await aHold;
      return row;
    });
    const aPromise = ensureQaReworkCapOversightIssue({ db, mission, oversightIssue: oversight, exhaustion, workflowName: "WF", createIssue: aCreateFn, onOwnerActionCreated: wake.fn });
    await entered; // A created hidden issue, paused before fencedLinkAndUnhide.
    // Force A's lease stale so B can take over.
    await db.update(workflowTransitionEvents).set({ correlationId: `lease:${Date.now() - 120_000}:forceStale` })
      .where(eq(workflowTransitionEvents.id, claimId));
    const bResult = await ensureQaReworkCapOversightIssue({ db, mission, oversightIssue: oversight, exhaustion, workflowName: "WF", createIssue: spy.fn, onOwnerActionCreated: wake.fn });
    expect(bResult?.created).toBe(false); // B reused A's hidden issue via marker scan + fencedLinkAndUnhide.
    resolveA();
    const aResult = await aPromise;
    expect(aResult).toBeNull(); // A's fencedLinkAndUnhide failed — no wake.
    const all = await db.select().from(issues).where(and(eq(issues.companyId, base.companyId), eq(issues.originKind, "mission_main_executor_unblock")));
    expect(visibleCap(all)).toBe(1);
    expect(wake.getWakeCount()).toBe(1); // Only B dispatched.
  });

  it("rejects takeover when lease token is unparseable", async () => {
    const { base, exhaustion, mission, oversight, claimId } = await setupScenario(db, "qa-inv");
    await db.update(workflowTransitionEvents).set({ correlationId: "not-a-lease-token" }).where(eq(workflowTransitionEvents.id, claimId));
    const result = await ensureQaReworkCapOversightIssue({ db, mission, oversightIssue: oversight, exhaustion, workflowName: "WF", createIssue: vi.fn(), onOwnerActionCreated: async () => ({ id: "ok" }) });
    expect(result).toBeNull();
  });

  it("fencedLinkAndUnhide: exact token links+unhides, wrong token fails (unlinked claim)", async () => {
    const { base, exhaustion, mission, oversight, keyHash, claimId } = await setupScenario(db, "qa-fla");
    const keyMarker = buildQaCapKeyMarker(keyHash);
    const tokenA = "lease:1000000:tokenA";
    // Ensure claim is unlinked with known token.
    await db.update(workflowTransitionEvents).set({ correlationId: tokenA, issueId: null }).where(eq(workflowTransitionEvents.id, claimId));
    // Create a hidden marker issue.
    const [hiddenIssue] = await db.insert(issues).values({
      companyId: base.companyId, missionId: base.missionId, title: "[QA Cap] hidden test",
      status: "todo", description: `<!-- ${keyMarker} --> hidden`, assigneeAgentId: base.agentId,
      originKind: "mission_main_executor_unblock", originId: oversight.id, hiddenAt: new Date(),
    }).returning();
    // Wrong token → false. Claim stays unlinked, issue stays hidden.
    expect(await fencedLinkAndUnhide(db, claimId, hiddenIssue.id, "lease:9999:wrong", base.companyId)).toBe(false);
    const [afterWrong] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, claimId));
    expect(afterWrong.issueId).toBeNull();
    const [issueWrong] = await db.select().from(issues).where(eq(issues.id, hiddenIssue.id));
    expect(issueWrong.hiddenAt).not.toBeNull();
    // Exact token → true. Claim linked, issue unhidden.
    expect(await fencedLinkAndUnhide(db, claimId, hiddenIssue.id, tokenA, base.companyId)).toBe(true);
    const [afterRight] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, claimId));
    expect(afterRight.issueId).toBe(hiddenIssue.id);
    const [issueRight] = await db.select().from(issues).where(eq(issues.id, hiddenIssue.id));
    expect(issueRight.hiddenAt).toBeNull();
  });
});

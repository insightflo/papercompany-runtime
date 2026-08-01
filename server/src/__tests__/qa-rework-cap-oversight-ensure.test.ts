import { and, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, createDb, issues, missions, workflowTransitionEvents } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  buildQaCapKeyHash,
  buildQaCapKeyMarker,
  ensureQaReworkCapOversightIssue,
  isQaReworkCapOversightIssue,
} from "../services/missions/qa-rework-cap-oversight.js";
import { createOwnerActions } from "../services/missions/owner-actions.js";
import { missionService } from "../services/missions.js";
import {
  cleanQaCapFixture,
  loadQaCapStepRows,
  seedQaCapBase,
  seedQaCapWorkflow,
  seedStepHeartbeat,
  seedWorkflowVerdict,
  type QaCapBase,
  type QaCapTestDb,
} from "./helpers/qa-cap-oversight-fixture.js";
import { detectQaReworkCapExhaustion } from "../services/missions/qa-rework-cap-oversight-detection.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`skip qa-cap ensure: ${support.reason ?? "unsupported"}`);

/** Mock callback that simulates heartbeat.wakeup by creating a real queued agentWakeupRequests row. */
function wakeWithCoverage(db: QaCapTestDb, base: QaCapBase) {
  return vi.fn(async (input: { reason?: string; issue?: { id: string } }) => {
    if (input.reason !== "qa_rework_cap_oversight_created") return { id: "other" };
    await db.insert(agentWakeupRequests).values({
      companyId: base.companyId, agentId: base.agentId,
      source: "assignment", status: "queued", reason: "mission_main_executor_unblock",
      issueId: input.issue!.id, missionId: base.missionId,
    });
    return { id: "wake-ok" };
  });
}

async function seedDetected(db: QaCapTestDb, base: QaCapBase, input: { producerStepId?: string } = {}) {
  const seed = await seedQaCapWorkflow(db, base, {
    iteration: 2, producerStepId: input.producerStepId,
    edges: [{ stepId: "qa:%_:colon", maxIterations: 2 }],
  });
  const qa = seed.qas[0]!;
  const hb = await seedStepHeartbeat(db, base, {
    workflowRunId: seed.runId, workflowStepRunId: qa.stepRunId,
    issueId: qa.issueId, createdAt: new Date(Date.now() - 10_000),
  });
  await seedWorkflowVerdict(db, base, {
    workflowRunId: seed.runId, workflowStepRunId: qa.stepRunId,
    issueId: qa.issueId, heartbeatRunId: hb, createdAt: new Date(Date.now() - 9_000),
  });
  const detected = await detectQaReworkCapExhaustion({
    db, companyId: base.companyId, stepRows: await loadQaCapStepRows(db, base),
  });
  expect(detected).toHaveLength(1);
  return { seed, exhaustion: detected[0]! };
}

async function seedOversight(db: QaCapTestDb, base: QaCapBase) {
  const [mission] = await db.select().from(missions).where(eq(missions.id, base.missionId));
  const [oversight] = await db.insert(issues).values({
    companyId: base.companyId, missionId: base.missionId,
    title: "[OVERSIGHT] Cap WF", status: "todo",
    originKind: "mission_main_executor_oversight", assigneeAgentId: base.agentId,
  }).returning();
  return { mission, oversight };
}

async function visibleCapIssues(db: QaCapTestDb, base: QaCapBase) {
  const rows = await db.select().from(issues).where(and(
    eq(issues.companyId, base.companyId), eq(issues.missionId, base.missionId),
    eq(issues.originKind, "mission_main_executor_unblock"), isNull(issues.hiddenAt),
  ));
  return rows.filter((r) => isQaReworkCapOversightIssue(r.description));
}

describeEP("QA cap oversight atomic ensure", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("qa-cap-ensure-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterEach(async () => { await cleanQaCapFixture(db); });
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  it("dispatches wake and verifies DB coverage (not just callback return)", async () => {
    const base = await seedQaCapBase(db);
    const { exhaustion } = await seedDetected(db, base);
    const { mission, oversight } = await seedOversight(db, base);
    const createIssue = createOwnerActions({ db, deps: {} }).createMissionOwnerActionIssue;
    const wake = wakeWithCoverage(db, base);
    const result = await ensureQaReworkCapOversightIssue({
      db, mission, oversightIssue: oversight, exhaustion,
      workflowName: "Cap WF", createIssue, onOwnerActionCreated: wake,
    });
    expect(result?.created).toBe(true);
    expect(wake).toHaveBeenCalledTimes(1);
    expect((await visibleCapIssues(db, base)).length).toBe(1);
  });

  it("non-null resolved callback with no agentWakeupRequests/heartbeat row = failure", async () => {
    const base = await seedQaCapBase(db);
    const { exhaustion } = await seedDetected(db, base);
    const { mission, oversight } = await seedOversight(db, base);
    const createIssue = createOwnerActions({ db, deps: {} }).createMissionOwnerActionIssue;
    // Returns truthy but creates NO DB row — must be detected as failure.
    const wake = vi.fn().mockResolvedValue({ id: "fake-but-no-db-row" });
    await expect(ensureQaReworkCapOversightIssue({
      db, mission, oversightIssue: oversight, exhaustion,
      workflowName: "Cap WF", createIssue, onOwnerActionCreated: wake,
    })).rejects.toThrow("no live wake coverage");
    expect((await visibleCapIssues(db, base)).length).toBe(1); // issue created before wake
  });

  it("null callback with no live coverage is a failure", async () => {
    const base = await seedQaCapBase(db);
    const { exhaustion } = await seedDetected(db, base);
    const { mission, oversight } = await seedOversight(db, base);
    const createIssue = createOwnerActions({ db, deps: {} }).createMissionOwnerActionIssue;
    await expect(ensureQaReworkCapOversightIssue({
      db, mission, oversightIssue: oversight, exhaustion,
      workflowName: "Cap WF", createIssue, onOwnerActionCreated: vi.fn().mockResolvedValue(null),
    })).rejects.toThrow("no live wake coverage");
  });

  it("skips re-wake when a live wake already covers the issue (idempotent)", async () => {
    const base = await seedQaCapBase(db);
    const { exhaustion } = await seedDetected(db, base);
    const { mission, oversight } = await seedOversight(db, base);
    const createIssue = createOwnerActions({ db, deps: {} }).createMissionOwnerActionIssue;
    const wake = wakeWithCoverage(db, base);
    const first = await ensureQaReworkCapOversightIssue({
      db, mission, oversightIssue: oversight, exhaustion,
      workflowName: "Cap WF", createIssue, onOwnerActionCreated: wake,
    });
    // Second pass: the queued request from first call is still live → callback NOT called.
    const second = await ensureQaReworkCapOversightIssue({
      db, mission, oversightIssue: oversight, exhaustion,
      workflowName: "Cap WF", createIssue, onOwnerActionCreated: wake,
    });
    expect(second?.created).toBe(false);
    expect(wake).toHaveBeenCalledTimes(1);
    expect((await visibleCapIssues(db, base)).length).toBe(1);
  });

  it("requires the owner-action callback before claiming or creating", async () => {
    const base = await seedQaCapBase(db);
    const { exhaustion } = await seedDetected(db, base);
    const { mission, oversight } = await seedOversight(db, base);
    const createIssue = createOwnerActions({ db, deps: {} }).createMissionOwnerActionIssue;
    await expect(ensureQaReworkCapOversightIssue({
      db, mission, oversightIssue: oversight, exhaustion,
      workflowName: "Cap WF", createIssue, onOwnerActionCreated: undefined,
    })).rejects.toThrow("onOwnerActionCreated callback is required");
    expect((await visibleCapIssues(db, base)).length).toBe(0);
  });

  it("callback failure propagates and is retried on the next pass", async () => {
    const base = await seedQaCapBase(db);
    const { exhaustion } = await seedDetected(db, base);
    const { mission, oversight } = await seedOversight(db, base);
    const createIssue = createOwnerActions({ db, deps: {} }).createMissionOwnerActionIssue;
    const wake = wakeWithCoverage(db, base);
    wake.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(ensureQaReworkCapOversightIssue({
      db, mission, oversightIssue: oversight, exhaustion,
      workflowName: "Cap WF", createIssue, onOwnerActionCreated: wake,
    })).rejects.toThrow("queue unavailable");
    const retry = await ensureQaReworkCapOversightIssue({
      db, mission, oversightIssue: oversight, exhaustion,
      workflowName: "Cap WF", createIssue, onOwnerActionCreated: wake,
    });
    expect(retry?.created).toBe(false);
    expect(wake).toHaveBeenCalledTimes(2);
    expect((await visibleCapIssues(db, base)).length).toBe(1);
  });

  it("concurrent ensure creates exactly one visible issue (orphan hidden via CAS)", async () => {
    const base = await seedQaCapBase(db);
    const { exhaustion } = await seedDetected(db, base);
    const { mission, oversight } = await seedOversight(db, base);
    const createIssue = createOwnerActions({ db, deps: {} }).createMissionOwnerActionIssue;
    const wake = wakeWithCoverage(db, base);
    const call = () => ensureQaReworkCapOversightIssue({
      db, mission, oversightIssue: oversight, exhaustion,
      workflowName: "Cap WF", createIssue, onOwnerActionCreated: wake,
    });
    const results = await Promise.all([call(), call()]);
    // Exactly one visible qa-cap marker issue.
    expect((await visibleCapIssues(db, base)).length).toBe(1);
    // Exactly one claim row.
    const claims = await db.select({ id: workflowTransitionEvents.id })
      .from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, base.companyId),
        eq(workflowTransitionEvents.eventType, "qa_cap_oversight_claim"),
      ));
    expect(claims.length).toBe(1);
    // Claim links to the visible issue.
    const [claimRow] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, claims[0]!.id));
    const [visible] = await visibleCapIssues(db, base);
    expect(claimRow?.issueId).toBe(visible!.id);
  });

  it("hashes special step IDs and separates same-iteration newer completions", async () => {
    const base = await seedQaCapBase(db);
    const { exhaustion } = await seedDetected(db, base, { producerStepId: "producer:%_:colon" });
    const { mission, oversight } = await seedOversight(db, base);
    const createIssue = createOwnerActions({ db, deps: {} }).createMissionOwnerActionIssue;
    const wake = wakeWithCoverage(db, base);
    const first = await ensureQaReworkCapOversightIssue({
      db, mission, oversightIssue: oversight, exhaustion,
      workflowName: "Cap WF", createIssue, onOwnerActionCreated: wake,
    });
    const newer = { ...exhaustion, producerCompletedAt: new Date(new Date(exhaustion.producerCompletedAt).getTime() + 1_000).toISOString() };
    const second = await ensureQaReworkCapOversightIssue({
      db, mission, oversightIssue: oversight, exhaustion: newer,
      workflowName: "Cap WF", createIssue, onOwnerActionCreated: wake,
    });
    expect(first!.issue.id).not.toBe(second!.issue.id);
    expect((await visibleCapIssues(db, base)).length).toBe(2);
  });

  it("supervision reports queue failure, retries next tick, and never grace-defaults", async () => {
    const base = await seedQaCapBase(db);
    await seedDetected(db, base);
    await seedOversight(db, base);
    let capWakeAttempts = 0;
    const wake = vi.fn(async (input: { reason?: string; issue?: { id: string } }) => {
      if (input.reason !== "qa_rework_cap_oversight_created") return { id: "other" };
      capWakeAttempts += 1;
      if (capWakeAttempts === 1) throw new Error("queue unavailable");
      await db.insert(agentWakeupRequests).values({
        companyId: base.companyId, agentId: base.agentId,
        source: "assignment", status: "queued", reason: "mission_main_executor_unblock",
        issueId: input.issue!.id, missionId: base.missionId,
      });
      return { id: "wake-ok" };
    });
    const svc = missionService(db, { onOwnerActionCreated: wake });
    const first = await svc.runMainExecutorSupervision({ missionId: base.missionId, applyOwnerDecisionActions: true });
    expect(first.findings.some((l) => l.startsWith("qa_rework_cap_oversight_error:"))).toBe(true);
    expect((await visibleCapIssues(db, base)).length).toBe(1);
    const [capIssue] = await visibleCapIssues(db, base);
    await db.update(issues).set({ createdAt: new Date(Date.now() - 25 * 60 * 1000) }).where(eq(issues.id, capIssue!.id));
    const second = await svc.runMainExecutorSupervision({ missionId: base.missionId, applyOwnerDecisionActions: true });
    expect(second.findings.some((l) => l.startsWith("qa_rework_cap_oversight: "))).toBe(true);
    expect(second.findings.some((l) => l.includes("owner_action_grace_default_retry"))).toBe(false);
    expect(capWakeAttempts).toBe(2);
  });

  it("crash-recovery reconciliation hides orphan from crashed creator", async () => {
    const base = await seedQaCapBase(db);
    const { exhaustion } = await seedDetected(db, base);
    const { mission, oversight } = await seedOversight(db, base);
    const createIssue = createOwnerActions({ db, deps: {} }).createMissionOwnerActionIssue;
    const wake = wakeWithCoverage(db, base);
    // Step 1: ensure creates issue A, links claim.
    const issueA = (await ensureQaReworkCapOversightIssue({
      db, mission, oversightIssue: oversight, exhaustion,
      workflowName: "Cap WF", createIssue, onOwnerActionCreated: wake,
    }))!.issue.id;
    // Step 2: seed crash-before-CAS orphan B (same keyMarker, visible).
    const keyMarker = buildQaCapKeyMarker(buildQaCapKeyHash({
      companyId: base.companyId, workflowRunId: exhaustion.workflowRunId,
      producerStepId: exhaustion.producerStepId, qaStepId: exhaustion.qaStepId,
      producerIteration: exhaustion.producerIteration, producerCompletedAt: exhaustion.producerCompletedAt,
    }));
    const [orphanB] = await db.insert(issues).values({
      companyId: base.companyId, missionId: base.missionId, title: "[QA Cap] crash orphan",
      status: "todo", description: `<!-- ${keyMarker} --> orphan`,
      originKind: "mission_main_executor_unblock", originId: oversight.id, assigneeAgentId: base.agentId,
    }).returning();
    expect((await visibleCapIssues(db, base)).length).toBe(2);
    // Step 3: re-run ensure — early-return reuse reconciles orphans.
    await ensureQaReworkCapOversightIssue({
      db, mission, oversightIssue: oversight, exhaustion,
      workflowName: "Cap WF", createIssue, onOwnerActionCreated: wake,
    });
    const visible = await visibleCapIssues(db, base);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.id).toBe(issueA);
    const [orphanRow] = await db.select({ hiddenAt: issues.hiddenAt }).from(issues).where(eq(issues.id, orphanB.id));
    expect(orphanRow?.hiddenAt).not.toBeNull();
    const claims = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, base.companyId), eq(workflowTransitionEvents.eventType, "qa_cap_oversight_claim"),
    ));
    expect(claims).toHaveLength(1);
    expect(claims[0]!.issueId).toBe(issueA);
  });
});

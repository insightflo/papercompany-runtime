import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, createDb, heartbeatRuns, issues, missions, workflowDefinitions,
  workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { loadExecutionDefinition } from "../services/workflow/execution-definition.js";
import { queueSourceIssueResume } from "../services/workflow/source-issue-recovery-accept.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { capOwnerAction, reloadRun, reloadStepRun, seedCapExhaustedRun, testWake } from "./helpers/cap-override-fixtures.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) throw new Error("Embedded PostgreSQL support is required for the native identifier test");

type RetrySubmission = {
  sourceIssueRef?: string;
  reworkTargetRef?: string;
  recoveryTarget?: { kind: "issue"; issueId: string };
};

describe("native owner retry identifier acceptance", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("owner-retry-native-identifier-");
    db = createDb(database.connectionString);
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
  });

  async function seedNativeWorld() {
    const w = await seedCapExhaustedRun(db, { skipDecisionComment: true, runStatus: "running", producerIteration: 0 });
    const targetIdentifier = `HUM-${randomUUID().slice(0, 8)}`;
    await db.update(issues).set({ identifier: targetIdentifier, status: "todo" })
      .where(eq(issues.id, w.producerIssueId));
    await db.update(workflowStepRuns).set({ status: "pending", startedAt: null, completedAt: null })
      .where(eq(workflowStepRuns.id, w.producerStepRunId));
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, w.ownerActionIssueId));
    await db.insert(heartbeatRuns).values({ id: w.ownerDecisionHeartbeatRunId, companyId: w.companyId,
      agentId: w.ownerAgentId, issueId: w.ownerActionIssueId, status: "running" });
    return { ...w, targetIdentifier };
  }

  async function recordRetry(world: Awaited<ReturnType<typeof seedNativeWorld>>, fields: RetrySubmission) {
    const submission = { decision: "retry_source_issue" as const, reason: "Owner authorized the retry", ...fields };
    const recorded = await recordMissionOwnerDecision({ db,
      issue: { id: world.ownerActionIssueId, companyId: world.companyId, missionId: world.missionId },
      sourceIssueId: world.qaIssueId, heartbeatRunId: world.ownerDecisionHeartbeatRunId, submission });
    return { ...world, submission, decisionEventId: recorded.eventId };
  }

  async function nativeAccept(w: Awaited<ReturnType<typeof recordRetry>>, wakeFn: ReturnType<typeof testWake> = testWake(db)) {
    const run = await reloadRun(db, w.workflowRunId);
    const stepRun = await reloadStepRun(db, w.workflowRunId, "produce");
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run.workflowId));
    const execution = await loadExecutionDefinition(db, run.id, { requireHistorical: false });
    const step = execution.steps.find((candidate) => candidate.id === stepRun.stepId);
    if (!definition || !step) throw new Error("native identifier fixture missing workflow definition/step");
    return queueSourceIssueResume(db, { run, definition, step, stepRun, issueId: w.producerIssueId,
      allowBlockedIssue: true, wakeFn, ownerAction: capOwnerAction(w, w.decisionEventId) });
  }

  const acceptedWakes = (w: Awaited<ReturnType<typeof recordRetry>>) => db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, w.companyId), eq(agentWakeupRequests.issueId, w.producerIssueId),
    eq(agentWakeupRequests.workflowRunId, w.workflowRunId), eq(agentWakeupRequests.workflowStepRunId, w.producerStepRunId),
    eq(agentWakeupRequests.requestKind, "workflow_resume")));

  async function issueInSameMission(w: Awaited<ReturnType<typeof seedNativeWorld>>) {
    const identifier = `OTHER-${randomUUID().slice(0, 8)}`;
    await db.insert(issues).values({ companyId: w.companyId, missionId: w.missionId,
      title: "Conflicting target", status: "todo", identifier });
    return identifier;
  }

  async function issueInOtherMission(w: Awaited<ReturnType<typeof seedNativeWorld>>) {
    const missionId = randomUUID(), identifier = `OTHER-${randomUUID().slice(0, 8)}`;
    await db.insert(missions).values({ id: missionId, companyId: w.companyId, ownerAgentId: w.ownerAgentId,
      title: "Other mission", status: "active" });
    await db.insert(issues).values({ companyId: w.companyId, missionId, title: "Foreign mission target",
      status: "todo", identifier });
    return identifier;
  }

  it("accepts a ref-only owner retry using the target's human identifier", async () => {
    const world = await seedNativeWorld();
    const w = await recordRetry(world, { sourceIssueRef: world.targetIdentifier });
    const outcome = await nativeAccept(w);
    expect(outcome).toBe(true);
    expect(await acceptedWakes(w)).toHaveLength(1);
  });

  it("accepts a typed target cross-checked by its identifier and preserves one accepted wake on replay", async () => {
    const world = await seedNativeWorld();
    const w = await recordRetry(world, { recoveryTarget: { kind: "issue", issueId: world.producerIssueId },
      reworkTargetRef: world.targetIdentifier });
    const wakeFn = async (input: Parameters<ReturnType<typeof testWake>>[0]) => {
      if (!input.stepRunId) return false;
      const existing = await input.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, input.run.companyId), eq(agentWakeupRequests.issueId, input.issueId),
        eq(agentWakeupRequests.workflowRunId, input.run.id), eq(agentWakeupRequests.workflowStepRunId, input.stepRunId),
        eq(agentWakeupRequests.requestKind, "workflow_resume"),
        inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution", "coalesced", "completed"]))).limit(1);
      return existing.length > 0 || testWake(db)(input);
    };
    const outcome = await nativeAccept(w, wakeFn);
    expect(outcome).toBe(true);
    const replay = await recordMissionOwnerDecision({ db,
      issue: { id: w.ownerActionIssueId, companyId: w.companyId, missionId: w.missionId },
      sourceIssueId: w.qaIssueId, heartbeatRunId: w.ownerDecisionHeartbeatRunId, submission: w.submission });
    expect(replay.eventId).toBe(w.decisionEventId);
    expect(await nativeAccept(w, wakeFn)).toBe(false);
    expect(await acceptedWakes(w)).toHaveLength(1);
  });

  it("rejects a typed target paired with a conflicting same-mission identifier", async () => {
    const world = await seedNativeWorld();
    const w = await recordRetry(world, { recoveryTarget: { kind: "issue", issueId: world.producerIssueId },
      reworkTargetRef: await issueInSameMission(world) });
    expect(await nativeAccept(w)).toBe(false);
    expect(await acceptedWakes(w)).toHaveLength(0);
  });

  it("rejects a ref-only identifier from a different mission", async () => {
    const world = await seedNativeWorld();
    const w = await recordRetry(world, { sourceIssueRef: await issueInOtherMission(world) });
    expect(await nativeAccept(w)).toBe(false);
    expect(await acceptedWakes(w)).toHaveLength(0);
  });
});

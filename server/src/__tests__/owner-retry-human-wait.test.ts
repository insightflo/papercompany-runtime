import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, missions, operatorDecisions,
  workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { lockOwnerHumanRequestAuthority } from "../services/missions/owner-human-request-authority.js";
import { saveOwnerHumanRequest } from "../services/missions/owner-human-request-state.js";
import { readExactOwnerRetryHumanWait, type OwnerRetryHumanWaitContext } from "../services/missions/owner-retry-human-wait.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
import { buildMissionOwnerHumanInputDecisionCard, createMissionOwnerHumanInputDecisionCard } from "../services/missions/mission-owner-human-input-card.js";
import { buildHistoricalDefaultOwnerHumanInputVariant } from "../services/missions/mission-owner-human-default-definition.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
import { validateAndHashOperatorDecisionCreate } from "../services/operator-decision-result.js";
import { renewOwnerHumanRequestWithCard } from "../services/missions/owner-human-request-renew.js";
import type { OwnerRecoveryTarget } from "../services/missions/mission-owner-recovery-events.js";
import { seedToolRecoveryScenario } from "./helpers/tool-recovery-scenario.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
type World = { companyId: string; missionId: string; ownerAgentId: string; sourceIssueId: string;
  ownerActionIssueId: string; heartbeatRunId: string };
type ToolTarget = { kind: "tool_step"; workflowRunId: string; stepRunId: string;
  expectedAuthorityVersion: number; expectedExecutionGeneration: number; failedDispatchRequestId: string | null };
const mismatchedTarget = (kind: "issue" | "tool_step"): OwnerRecoveryTarget => kind === "issue"
  ? { kind, issueId: randomUUID() }
  : { kind, workflowRunId: randomUUID(), stepRunId: randomUUID(), expectedAuthorityVersion: 0,
    expectedExecutionGeneration: 0, failedDispatchRequestId: null };

describeDb("exact owner retry human waits", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("owner-retry-human-wait-");
    db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await database?.cleanup(); });

  async function world(): Promise<World> {
    const w = { companyId: randomUUID(), missionId: randomUUID(), ownerAgentId: randomUUID(),
      sourceIssueId: randomUUID(), ownerActionIssueId: randomUUID(), heartbeatRunId: randomUUID() };
    await db.insert(companies).values({ id: w.companyId, name: "Wait scope", issuePrefix: randomUUID() });
    await db.insert(agents).values({ id: w.ownerAgentId, companyId: w.companyId, name: "Owner", status: "active" });
    await db.insert(missions).values({ id: w.missionId, companyId: w.companyId, ownerAgentId: w.ownerAgentId,
      title: "Exact wait", status: "active" });
    await db.insert(issues).values([
      { id: w.sourceIssueId, companyId: w.companyId, missionId: w.missionId, title: "Source", status: "blocked" },
      { id: w.ownerActionIssueId, companyId: w.companyId, missionId: w.missionId, title: "Owner action",
        status: "in_progress", assigneeAgentId: w.ownerAgentId, originKind: "mission_main_executor_unblock",
        originId: w.sourceIssueId },
    ]);
    await db.insert(heartbeatRuns).values({ id: w.heartbeatRunId, companyId: w.companyId,
      agentId: w.ownerAgentId, issueId: w.ownerActionIssueId, status: "running" });
    return w;
  }
  async function submit(w: World, key: string, target?: ToolTarget) {
    const submission = { decision: "request_input" as const,
      ...(target ? { recoveryTarget: target } : { recoveryTarget: { kind: "issue" as const, issueId: w.sourceIssueId } }),
      reason: "Need a human decision" };
    const saved = await db.transaction(async (tx) => {
      const auth = await lockOwnerHumanRequestAuthority(tx, { companyId: w.companyId, missionId: w.missionId,
        ownerActionIssueId: w.ownerActionIssueId, agentId: w.ownerAgentId, heartbeatRunId: w.heartbeatRunId,
        recoveryTarget: submission.recoveryTarget });
      const decision = await recordMissionOwnerDecision({ db: tx,
        issue: { id: w.ownerActionIssueId, companyId: w.companyId, missionId: w.missionId },
        submission, sourceIssueId: w.sourceIssueId, heartbeatRunId: w.heartbeatRunId });
      return saveOwnerHumanRequest(auth, { schemaVersion: 1, requestKey: key,
        expectedCurrentLifetimeId: null, identityMode: "keyed", decisionEventId: decision.eventId, submission });
    });
    await createMissionOwnerHumanInputDecisionCard(db, { ...saved.lifetime.cardInput,
      lifetimeId: saved.lifetime.lifetimeId });
    return saved;
  }
  async function renew(w: World, anchor: World, lifetimeId: string, key: string) {
    return db.transaction((tx) => renewOwnerHumanRequestWithCard(tx, { companyId: w.companyId,
      previousLifetimeId: lifetimeId, anchorIssueId: anchor.ownerActionIssueId, requestKey: key }));
  }
  async function retry(w: World, anchor: World, target: OwnerRecoveryTarget) {
    return recordMissionOwnerDecision({ db,
      issue: { id: anchor.ownerActionIssueId, companyId: w.companyId, missionId: w.missionId },
      sourceIssueId: w.sourceIssueId, heartbeatRunId: anchor.heartbeatRunId,
      submission: { decision: "retry_source_issue", recoveryTarget: target } });
  }
  async function resolveCard(lifetimeId: string, outcome: "approve" | "hold" | "reject") {
    const [card] = await db.select().from(operatorDecisions)
      .where(eq(operatorDecisions.requestKey, `moi2:${lifetimeId}`));
    expect(card).toBeTruthy();
    return operatorDecisionWriteService(db).resolve(card!.id,
      { actionId: outcome, selectedOptionIds: [outcome], comment: "Operator decision" }, "board");
  }
  async function legacyCard(w: World, target: OwnerRecoveryTarget) {
    const decision = await recordMissionOwnerDecision({ db,
      issue: { id: w.ownerActionIssueId, companyId: w.companyId, missionId: w.missionId },
      sourceIssueId: w.sourceIssueId, heartbeatRunId: w.heartbeatRunId,
      submission: { decision: "request_input", recoveryTarget: target } });
    const input = buildMissionOwnerHumanInputDecisionCard({ companyId: w.companyId, missionId: w.missionId,
      decisionEventId: decision.eventId, decision: "request_input", ownerActionIssueId: w.ownerActionIssueId,
      ownerActionIssueStatus: "in_progress", requestedByAgentId: w.ownerAgentId, sourceIssueId: w.sourceIssueId });
    return operatorDecisionWriteService(db).create(w.companyId, input, { type: "agent", id: w.ownerAgentId });
  }
  const context = (w: World, source = w.sourceIssueId, retry = source, toolTarget?: unknown): OwnerRetryHumanWaitContext => ({
    companyId: w.companyId, missionId: w.missionId, ownerActionIssueId: w.ownerActionIssueId,
    originalSourceIssueId: source, retryIssueId: retry, ...(toolTarget !== undefined ? { toolTarget } : {}),
  });
  async function inspect(w: World, value: OwnerRetryHumanWaitContext) {
    return db.transaction(async (tx) => {
      await tx.select({ id: missions.id }).from(missions).where(and(eq(missions.id, w.missionId),
        eq(missions.companyId, w.companyId))).for("update");
      return readExactOwnerRetryHumanWait(tx, value);
    });
  }
  async function sibling(w: World) {
    const next = { ...w, ownerActionIssueId: randomUUID(), heartbeatRunId: randomUUID() };
    await db.insert(issues).values({ id: next.ownerActionIssueId, companyId: w.companyId, missionId: w.missionId,
      title: "Renewed owner action", status: "in_progress", assigneeAgentId: w.ownerAgentId,
      originKind: "mission_main_executor_unblock", originId: w.sourceIssueId });
    await db.insert(heartbeatRuns).values({ id: next.heartbeatRunId, companyId: w.companyId,
      agentId: w.ownerAgentId, issueId: next.ownerActionIssueId, status: "running" });
    return next;
  }

  it("keeps source waits exact, ignores oversight waits, and follows a real renewal chain", async () => {
    const w = await world();
    const first = await submit(w, "wait:first");
    const before = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, w.companyId));
    expect(await inspect(w, context(w))).toMatchObject({ kind: "waiting", bindingIds: [first.lifetime.lifetimeId] });
    const unrelated = randomUUID();
    await db.insert(issues).values({ id: unrelated, companyId: w.companyId, missionId: w.missionId,
      title: "Independent issue", status: "blocked" });
    expect(await inspect(w, context(w, unrelated))).toMatchObject({ kind: "clear" });

    const oversightId = randomUUID(), oversightHeartbeat = randomUUID();
    await db.insert(issues).values({ id: oversightId, companyId: w.companyId, missionId: w.missionId,
      title: "Mission oversight", status: "todo", assigneeAgentId: w.ownerAgentId,
      originKind: "mission_main_executor_oversight", originId: null });
    await db.insert(heartbeatRuns).values({ id: oversightHeartbeat, companyId: w.companyId,
      agentId: w.ownerAgentId, issueId: oversightId, status: "running" });
    await db.transaction(async (tx) => {
      const auth = await lockOwnerHumanRequestAuthority(tx, { companyId: w.companyId, missionId: w.missionId,
        ownerActionIssueId: oversightId, agentId: w.ownerAgentId, heartbeatRunId: oversightHeartbeat });
      const decision = await recordMissionOwnerDecision({ db: tx,
        issue: { id: oversightId, companyId: w.companyId, missionId: w.missionId }, heartbeatRunId: oversightHeartbeat,
        submission: { decision: "request_input" } });
      await saveOwnerHumanRequest(auth, { schemaVersion: 1, requestKey: "oversight:wait",
        expectedCurrentLifetimeId: null, identityMode: "keyed", decisionEventId: decision.eventId,
        submission: { decision: "request_input" } });
    });
    expect(await inspect(w, context(w))).toMatchObject({ kind: "waiting" });
    expect(await inspect(w, context(w, unrelated))).toMatchObject({ kind: "clear" });
    expect(await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, w.companyId))).toEqual(
      expect.arrayContaining(before));

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, w.ownerActionIssueId));
    const next = await sibling(w);
    const renewed = await renew(w, next, first.lifetime.lifetimeId, "wait:renewed");
    expect(await inspect(next, context(next))).toMatchObject({ kind: "waiting",
      bindingIds: [renewed.current.lifetime.lifetimeId] });
    await retry(w, next, { kind: "issue", issueId: w.sourceIssueId });
    expect(await inspect(next, context(next))).toMatchObject({ kind: "clear" });
  });

  it.each(["hold", "reject"] as const)("keeps the renewed %s wait when D < R < L", async (outcome) => {
    const w = await world(), first = await submit(w, `wait:${outcome}`);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, w.ownerActionIssueId));
    const next = await sibling(w), decision = await retry(w, next, { kind: "issue", issueId: w.sourceIssueId });
    const base = Date.now() - 10_000, decisionAt = new Date(base), retryAt = new Date(base + 5_000);
    await db.update(workflowTransitionEvents).set({ createdAt: decisionAt })
      .where(eq(workflowTransitionEvents.id, first.lifetime.decisionEventId));
    await db.update(workflowTransitionEvents).set({ createdAt: retryAt })
      .where(eq(workflowTransitionEvents.id, decision.eventId));
    const renewed = await renew(w, next, first.lifetime.lifetimeId, `wait:renewed:${outcome}`);
    const [lifetimeRow] = await db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.id, renewed.current.lifetime.lifetimeId));
    expect(lifetimeRow!.createdAt.getTime()).toBeGreaterThan(retryAt.getTime());
    await resolveCard(renewed.current.lifetime.lifetimeId, outcome);
    expect(await inspect(next, context(next))).toMatchObject({ kind: "waiting",
      bindingIds: [renewed.current.lifetime.lifetimeId] });
  });

  it("clears only for a strictly later exact retry and validates historical pending moi2 renewal cards", async () => {
    const w = await world(), [definition] = await db.insert(workflowDefinitions).values({ companyId: w.companyId,
      name: "historical moi2", stepsJson: [] }).returning();
    const [run] = await db.insert(workflowRuns).values({ companyId: w.companyId, missionId: w.missionId, workflowId: definition!.id, triggeredBy: "test", status: "failed" }).returning();
    await db.update(issues).set({ originRunId: run!.id }).where(eq(issues.id, w.sourceIssueId));
    const first = await submit(w, "wait:pending-card");
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, w.ownerActionIssueId));
    const next = await sibling(w), renewed = await renew(w, next, first.lifetime.lifetimeId, "wait:pending-renewal");
    const [card] = await db.select().from(operatorDecisions)
      .where(eq(operatorDecisions.requestKey, `moi2:${renewed.current.lifetime.lifetimeId}`));
    expect(card).toMatchObject({ status: "pending", sourceType: "mission_owner_human_input" });
    const historical = buildHistoricalDefaultOwnerHumanInputVariant(buildMissionOwnerHumanInputDecisionCard(
      { ...renewed.current.lifetime.cardInput, lifetimeId: renewed.current.lifetime.lifetimeId }));
    const stored = validateAndHashOperatorDecisionCreate(historical!);
    await db.update(operatorDecisions).set({ definition: stored.input.definition, requestHash: stored.requestHash })
      .where(eq(operatorDecisions.id, card!.id));
    const laterRetry = await retry(w, next, { kind: "issue", issueId: w.sourceIssueId });
    const [lifetimeRow] = await db.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.id, renewed.current.lifetime.lifetimeId));
    await db.update(workflowTransitionEvents).set({ createdAt: new Date(lifetimeRow!.createdAt.getTime() + 1_000) })
      .where(eq(workflowTransitionEvents.id, laterRetry.eventId));
    expect(await inspect(next, context(next))).toMatchObject({ kind: "clear" });
  });

  it.each(["issue Y", "tool step"] as const)("does not let a later %s retry release source X", async (name) => {
    const target = mismatchedTarget(name === "issue Y" ? "issue" : "tool_step");
    const w = await world(), current = await submit(w, "wait:target-mismatch");
    if (target.kind === "issue") await db.insert(issues).values({ id: target.issueId, companyId: w.companyId,
      missionId: w.missionId, title: "Resolved retry target", status: "blocked" });
    await retry(w, w, target);
    const resolved = target.kind === "issue" ? target.issueId : w.sourceIssueId;
    expect(await inspect(w, context(w, w.sourceIssueId, resolved))).toMatchObject({ kind: "waiting",
      bindingIds: [current.lifetime.lifetimeId] });
  });

  it.each(["issue Y", "tool step"] as const)("does not bind a legacy source card to %s by provenance", async (name) => {
    const target = mismatchedTarget(name === "issue Y" ? "issue" : "tool_step");
    const w = await world();
    if (target.kind === "issue") await db.insert(issues).values({ id: target.issueId, companyId: w.companyId,
      missionId: w.missionId, title: "Resolved retry target", status: "blocked" });
    await legacyCard(w, target);
    expect(await inspect(w, context(w))).toMatchObject({ kind: "clear" });
  });

  it("does not ignore a malformed same-target moi2 card by prefix", async () => {
    const w = await world(), current = await submit(w, "wait:corrupt-card");
    const [card] = await db.select().from(operatorDecisions)
      .where(eq(operatorDecisions.requestKey, `moi2:${current.lifetime.lifetimeId}`));
    await db.update(operatorDecisions).set({ requestKey: "moi2:not-a-lifetime" })
      .where(eq(operatorDecisions.id, card!.id));
    expect(await inspect(w, context(w))).toMatchObject({ kind: "unresolved",
      reasonCode: "legacy_human_wait_unresolved" });
  });

  it("uses the versioned owner-tool link and current generation for exact tool waits", async () => {
    const scenario = await seedToolRecoveryScenario({ db, artifactExists: false });
    const w: World = { companyId: scenario.companyId, missionId: scenario.missionId,
      ownerAgentId: scenario.ownerAgentId, sourceIssueId: scenario.oversightIssueId,
      ownerActionIssueId: scenario.recoveryIssueId, heartbeatRunId: randomUUID() };
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, w.ownerActionIssueId));
    await db.insert(heartbeatRuns).values({ id: w.heartbeatRunId, companyId: w.companyId,
      agentId: w.ownerAgentId, issueId: w.ownerActionIssueId, status: "running" });
    const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, scenario.stepRunId));
    const target: ToolTarget = { kind: "tool_step", workflowRunId: scenario.workflowRunId,
      stepRunId: scenario.stepRunId, expectedAuthorityVersion: 0,
      expectedExecutionGeneration: step!.executionGeneration, failedDispatchRequestId: step!.lastDispatchRequestId };
    await db.insert(workflowTransitionEvents).values({ companyId: w.companyId, missionId: w.missionId,
      issueId: w.ownerActionIssueId, workflowRunId: target.workflowRunId, workflowStepRunId: target.stepRunId,
      eventType: "owner_tool_recovery_target_v1", layer: "mission_owner_recovery",
      idempotencyKey: `owner-tool-card:${target.stepRunId}`,
      payload: { schemaVersion: 1, kind: "tool_step", workflowRunId: target.workflowRunId, stepRunId: target.stepRunId } });
    const current = await submit(w, "tool:wait", target);
    expect(await inspect(w, context(w, w.sourceIssueId, w.sourceIssueId, target)))
      .toMatchObject({ kind: "waiting", bindingIds: [current.lifetime.lifetimeId] });
    expect(await inspect(w, context(w, w.sourceIssueId, w.sourceIssueId,
      { ...target, expectedExecutionGeneration: target.expectedExecutionGeneration + 1 })))
      .toMatchObject({ kind: "unresolved", reasonCode: "tool_target_not_current" });
    expect(await inspect(w, context(w, w.sourceIssueId, w.sourceIssueId,
      { ...target, workflowRunId: randomUUID(), stepRunId: randomUUID() })))
      .toMatchObject({ kind: "unresolved", reasonCode: "tool_target_not_current" });
  });

  it("uses validated legacy target snapshots and treats terminal or malformed currentness safely", async () => {
    const w = await world();
    const [definition] = await db.insert(workflowDefinitions).values({ companyId: w.companyId,
      name: "legacy snapshot", stepsJson: [] }).returning();
    const [run] = await db.insert(workflowRuns).values({ companyId: w.companyId, missionId: w.missionId,
      workflowId: definition!.id, triggeredBy: "test", status: "failed" }).returning();
    const [step] = await db.insert(workflowStepRuns).values({ workflowRunId: run!.id,
      stepId: "legacy-step", status: "failed" }).returning();
    const decision = await recordMissionOwnerDecision({ db,
      issue: { id: w.ownerActionIssueId, companyId: w.companyId, missionId: w.missionId },
      sourceIssueId: w.sourceIssueId, heartbeatRunId: w.heartbeatRunId,
      submission: { decision: "request_input", recoveryTarget: { kind: "issue", issueId: w.sourceIssueId } } });
    const cardInput = buildMissionOwnerHumanInputDecisionCard({ companyId: w.companyId,
      missionId: w.missionId, decisionEventId: decision.eventId, decision: "request_input",
      ownerActionIssueId: w.ownerActionIssueId, ownerActionIssueStatus: "in_progress",
      requestedByAgentId: w.ownerAgentId, sourceIssueId: w.sourceIssueId, workflowRunId: run!.id });
    const cardRequest = { ...cardInput, sourceContext: { ...cardInput.sourceContext,
      targetSnapshot: { issueId: w.ownerActionIssueId, issueStatus: "in_progress", workflowRunId: run!.id,
        workflowRunStatus: "failed", stepRunId: step!.id, stepRunStatus: "failed",
        executionGeneration: step!.executionGeneration } } };
    const created = await operatorDecisionWriteService(db).create(w.companyId, cardRequest,
      { type: "agent", id: w.ownerAgentId });
    const cardId = created.decision.id;
    const [stored] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, cardId));
    await db.update(operatorDecisions).set({ sourceContext: { ...stored!.sourceContext, planDecisionHash: null } })
      .where(eq(operatorDecisions.id, cardId));
    expect(await inspect(w, context(w))).toMatchObject({ kind: "waiting", bindingIds: [cardId] });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, w.ownerActionIssueId));
    expect(await inspect(w, context(w))).toMatchObject({ kind: "clear" });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, w.ownerActionIssueId));
    await db.update(workflowStepRuns).set({ executionGeneration: step!.executionGeneration + 1 })
      .where(eq(workflowStepRuns.id, step!.id));
    expect(await inspect(w, context(w))).toMatchObject({ kind: "clear" });
    await db.update(workflowStepRuns).set({ executionGeneration: step!.executionGeneration })
      .where(eq(workflowStepRuns.id, step!.id));
    await db.update(operatorDecisions).set({ sourceContext: { ...stored!.sourceContext,
      targetSnapshot: { issueId: w.ownerActionIssueId, issueStatus: "in_progress", unexpected: true } } })
      .where(eq(operatorDecisions.id, cardId));
    expect(await inspect(w, context(w))).toMatchObject({ kind: "unresolved", reasonCode: "legacy_human_wait_unresolved" });
  });
});

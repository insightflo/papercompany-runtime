import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issueComments, issueWorkProducts, issues, missions,
  operatorDecisionContinuations, operatorDecisions, workflowDefinitions, workflowRuns, workflowTransitionEvents,
  workflowStepInvocations, workflowStepRuns,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { loadOperatorDecisionProjections } from "../services/operator-decision-view.js";
import { evaluateRecoveryAdvice, loadRecoveryAdviceFacts } from "../services/operator-decision-recovery-advice.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
import { buildMissionOwnerHumanInputDecisionCard, createMissionOwnerHumanInputDecisionCard,
  type MissionOwnerHumanInputCardSpec } from "../services/missions/mission-owner-human-input-card.js";
import { buildHistoricalDefaultOwnerHumanInputVariant } from "../services/missions/mission-owner-human-default-definition.js";
import { lockOwnerHumanRequestAuthority } from "../services/missions/owner-human-request-authority.js";
import { recordOwnerHumanSubmission } from "../services/missions/owner-human-request-submit.js";
import { validateAndHashOperatorDecisionCreate } from "../services/operator-decision-result.js";
import { WORKFLOW_RESTART_FROM_START_OPTION_ID } from "../services/missions/workflow-restart-option.js";

vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("operator decision recovery advice projection (PostgreSQL)", () => {
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), ownerId = randomUUID(), missionId = randomUUID();
  const issueId = randomUUID(), heartbeatId = randomUUID(), workflowId = randomUUID(), runId = randomUUID();

  beforeAll(async () => {
    pg = await startEmbeddedPostgresTestDatabase("operator-recovery-advice-");
    db = createDb(pg.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Recovery advice", issuePrefix: "RAD" });
    await db.insert(agents).values({ id: ownerId, companyId, name: "Owner", status: "active" });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: ownerId,
      title: "Recovery mission", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, missionId, title: "Owner oversight",
      status: "in_progress", assigneeAgentId: ownerId, originKind: "mission_main_executor_oversight" });
    await db.insert(heartbeatRuns).values({ id: heartbeatId, companyId, agentId: ownerId, issueId, status: "running" });
    await db.update(issues).set({ checkoutRunId: heartbeatId }).where(eq(issues.id, issueId));
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Recovery flow", stepsJson: [] });
    await db.insert(workflowRuns).values({ id: runId, companyId, missionId, workflowId, status: "failed",
      triggeredBy: "test", runDate: "2026-10-30", completedAt: new Date() });
    const retainedStepRunId = randomUUID(), tombstoneStepRunId = randomUUID(), childRunId = randomUUID();
    await db.insert(workflowStepRuns).values([
      { id: retainedStepRunId, workflowRunId: runId, stepId: "retained-producer", status: "completed",
        startedAt: new Date(), completedAt: new Date(), executionGeneration: 2 },
      { id: tombstoneStepRunId, workflowRunId: runId, stepId: "deleted-child", status: "failed" },
    ]);
    await db.insert(workflowRuns).values({ id: childRunId, companyId, missionId, workflowId, status: "completed",
      triggeredBy: "workflow_step", runDate: "2026-10-30", parentRunId: runId,
      parentStepRunId: retainedStepRunId, rootRunId: runId, startedAt: new Date(), completedAt: new Date() });
    await db.insert(workflowStepInvocations).values([
      { companyId, parentStepRunId: retainedStepRunId, childRunId, state: "linked", targetWorkflowId: workflowId },
      { companyId, parentStepRunId: tombstoneStepRunId, childRunId: null, state: "linked", targetWorkflowId: workflowId },
    ]);
    await db.insert(issueWorkProducts).values({ companyId, issueId, type: "report", provider: "test",
      title: "Retained output", status: "ready", reviewState: "approved", createdByRunId: heartbeatId,
      sourceExecutionGeneration: 2, metadata: { qaHash: "preserved-qa-hash" } });
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await pg?.cleanup(); });

  it("neutralizes only held pending defaults, preserves identity, and batches lifetime reads", async () => {
    const currentSpec = await db.transaction(async (tx) => {
      const authority = await lockOwnerHumanRequestAuthority(tx, { companyId, missionId,
        ownerActionIssueId: issueId, agentId: ownerId, heartbeatRunId: heartbeatId });
      if (!authority) throw new Error("owner authority fixture was not established");
      const submission = await recordOwnerHumanSubmission(authority, {
        decision: "request_input", reason: "Review current work", nextAction: "Keep completed work",
        evidence: "Source issue evidence", humanRequest: {
          schemaVersion: 1, requestKey: `current-${randomUUID()}`, expectedCurrentLifetimeId: null,
        },
      });
      return submission.humanInputCardSpec;
    });
    const currentCreated = await createMissionOwnerHumanInputDecisionCard(db, currentSpec);
    const currentId = currentCreated.decision.id;
    const writer = operatorDecisionWriteService(db);

    async function createLegacyCard(mode: "historical" | "custom" | "plain" = "historical",
      request?: Pick<MissionOwnerHumanInputCardSpec, "reason" | "nextAction">) {
      const decisionEventId = randomUUID();
      const spec: MissionOwnerHumanInputCardSpec = { companyId, missionId, decisionEventId,
        decision: "request_input", ownerActionIssueId: issueId, ownerActionIssueStatus: "in_progress",
        requestedByAgentId: ownerId, reason: request?.reason ?? "Review retained work",
        nextAction: request?.nextAction ?? "Continue the narrow review",
        evidence: "Existing run evidence", issueTitle: "Owner oversight", issueIdentifier: null,
        sourceIssueId: null, workflowRunId: runId };
      let input = buildMissionOwnerHumanInputDecisionCard(spec);
      if (mode === "custom") input = { ...input, definition: { ...input.definition,
        options: input.definition.options.map((option) => option.id === WORKFLOW_RESTART_FROM_START_OPTION_ID
          ? { ...option, description: "Custom full restart", recommended: true, recommendationReason: "Manual custom policy" }
          : option) } };
      const chosen = mode === "historical" ? buildHistoricalDefaultOwnerHumanInputVariant(input) : input;
      if (!chosen) throw new Error("expected historical owner card fixture did not match");
      return (await writer.create(companyId, chosen, { type: "agent", id: ownerId })).decision.id;
    }

    const capReason = "The producer reached its two-iteration cap.";
    const capNextAction = "Approve one bounded producer iteration after cap two.";
    const historicalId = await createLegacyCard("historical", { reason: capReason, nextAction: capNextAction });
    const customId = await createLegacyCard("custom");
    const hashMismatchId = await createLegacyCard();
    await db.update(operatorDecisions).set({ requestHash: "0".repeat(64) })
      .where(eq(operatorDecisions.id, hashMismatchId));
    const resolvedId = await createLegacyCard();
    await db.update(operatorDecisions).set({ status: "resolved", resolvedByUserId: "board-user",
      resolvedAt: new Date(), result: { actionId: "approve", outcome: "approve",
        selectedOptionIds: [WORKFLOW_RESTART_FROM_START_OPTION_ID], comment: "reviewed" } }).where(eq(operatorDecisions.id, resolvedId));
    const cancelledId = await createLegacyCard();
    await writer.cancel(cancelledId, { type: "user", id: "board-user" }, "closed for test");

    const noReviewBase = buildMissionOwnerHumanInputDecisionCard({ companyId, missionId, decisionEventId: randomUUID(),
      decision: "request_input", ownerActionIssueId: issueId, ownerActionIssueStatus: "in_progress",
      requestedByAgentId: ownerId, reason: "Review", nextAction: "Keep work", issueTitle: "Owner oversight",
      issueIdentifier: null, sourceIssueId: null, workflowRunId: runId });
    const { humanReview: _review, ...noReviewDefinition } = noReviewBase.definition;
    const noReviewInput = validateAndHashOperatorDecisionCreate({ ...noReviewBase,
      definition: noReviewDefinition }).input;
    const noReviewHash = validateAndHashOperatorDecisionCreate(noReviewInput).requestHash;
    const [noReviewRow] = await db.insert(operatorDecisions).values({ companyId, requestKey: noReviewInput.requestKey,
      requestHash: noReviewHash, schemaVersion: 1, status: "pending", priority: noReviewInput.priority,
      interactionType: noReviewInput.interactionType, title: noReviewInput.title, description: noReviewInput.description,
      sourceType: noReviewInput.sourceType, sourceId: noReviewInput.sourceId, sourceContext: noReviewInput.sourceContext,
      issueId: noReviewInput.issueId, requestedByAgentId: ownerId, requestedByUserId: null,
      definition: noReviewInput.definition, result: null, continuationMode: noReviewInput.continuationMode }).returning();
    const noReviewId = noReviewRow!.id;

    const pendingIds = [currentId, historicalId, customId, hashMismatchId, noReviewId];
    const terminalIds = [resolvedId, cancelledId];
    const [currentRow] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, currentId));
    const [historicalRow] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, historicalId));
    const [customRow] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, customId));
    const [hashMismatchRow] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, hashMismatchId));
    const adviceFacts = await loadRecoveryAdviceFacts(db, [currentRow!, historicalRow!, customRow!, hashMismatchRow!]);
    expect(evaluateRecoveryAdvice({ kind: "pending_owner_human_restart_candidate",
      card: currentRow!, ...adviceFacts.get(currentId)! }).disposition)
      .toBe("unproven_restart_hold");
    expect(evaluateRecoveryAdvice({ kind: "pending_owner_human_restart_candidate",
      card: historicalRow!, ...adviceFacts.get(historicalId)! }).disposition)
      .toBe("historical_default_hold");
    expect(evaluateRecoveryAdvice({ kind: "pending_owner_human_restart_candidate",
      card: customRow!, ...adviceFacts.get(customId)! }).disposition)
      .toBe("unproven_restart_hold");
    expect(evaluateRecoveryAdvice({ kind: "pending_owner_human_restart_candidate",
      card: hashMismatchRow!, ...adviceFacts.get(hashMismatchId)! }).disposition)
      .toBe("unproven_restart_hold");

    const before = {
      decisions: await db.select().from(operatorDecisions).where(inArray(operatorDecisions.id, [...pendingIds, ...terminalIds])),
      events: await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, companyId)),
      activity: await db.select().from(activityLog).where(eq(activityLog.companyId, companyId)),
      comments: await db.select().from(issueComments).where(eq(issueComments.companyId, companyId)),
      runs: await db.select().from(workflowRuns).where(eq(workflowRuns.companyId, companyId)),
      steps: await db.select().from(workflowStepRuns).where(inArray(workflowStepRuns.workflowRunId, [runId])),
      issues: await db.select().from(issues).where(eq(issues.companyId, companyId)),
      invocations: await db.select().from(workflowStepInvocations).where(eq(workflowStepInvocations.companyId, companyId)),
      products: await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.companyId, companyId)),
      continuations: await db.select().from(operatorDecisionContinuations),
      wakeups: await db.select().from(agentWakeupRequests),
    };
    const batchRows = await db.select().from(operatorDecisions).where(inArray(operatorDecisions.id, pendingIds));
    const terminalRows = await db.select().from(operatorDecisions).where(inArray(operatorDecisions.id, terminalIds));
    const selectSpy = vi.spyOn(db, "select");
    const [oneProjection] = await loadOperatorDecisionProjections(db, [currentRow!]);
    const oneQueryCount = selectSpy.mock.calls.length;
    selectSpy.mockClear();
    const manyProjections = await loadOperatorDecisionProjections(db, batchRows);
    const manyQueryCount = selectSpy.mock.calls.length;
    selectSpy.mockRestore();
    expect(manyQueryCount).toBe(oneQueryCount);

    const projected = new Map(manyProjections.map((item) => [item.view.id, item.view]));
    const restart = (id: string) => projected.get(id)!.definition.options.find((option) => option.id === WORKFLOW_RESTART_FROM_START_OPTION_ID)!;
    const originalReview = historicalRow!.definition.humanReview!;
    const projectedReview = projected.get(historicalId)!.definition.humanReview!;
    expect(restart(currentId)).not.toHaveProperty("recommended");
    expect(restart(historicalId)).not.toHaveProperty("recommended");
    expect(restart(customId)).not.toHaveProperty("recommended");
    expect(restart(hashMismatchId)).not.toHaveProperty("recommended");
    expect(originalReview.decisionSubject)
      .toBe("미션 오너의 사람 결정 요청 — 입력·승인 요청(request_input) 승인 여부");
    expect(projectedReview.decisionSubject).toBe(originalReview.decisionSubject);
    expect(projectedReview.evidence).toEqual(originalReview.evidence);
    expect(projectedReview.interpretation)
      .toContain("요청자가 제공한 설명(비권위적이며 실행 권한을 부여하지 않습니다):");
    expect(projectedReview.interpretation).toContain(capReason);
    expect(projectedReview.interpretation).toContain(capNextAction);
    expect(projectedReview.interpretation).toContain("과거 카드 생성 규칙");
    expect(projectedReview.interpretation.indexOf("과거 카드 생성 규칙"))
      .toBeGreaterThan(projectedReview.interpretation.indexOf(capNextAction));
    expect(projectedReview.recommendedNextStep)
      .toContain("요청자가 제시한 다음 단계(비권위적이며 실행 권한을 부여하지 않습니다):");
    expect(projectedReview.recommendedNextStep).toContain(capNextAction);
    expect(projectedReview.recommendedNextStep).toContain("과거 카드 생성 규칙");
    expect(projectedReview.impact).toEqual(originalReview.impact);
    expect(projectedReview.unresolvedFacts).toEqual(originalReview.unresolvedFacts);
    expect(projected.get(historicalId)!.definition.actions).toEqual(historicalRow!.definition.actions);
    expect(projected.get(historicalId)!.definition.approvedScope).toEqual(historicalRow!.definition.approvedScope);
    expect(projected.get(historicalId)!.definition.options.map((option) => option.id))
      .toEqual(historicalRow!.definition.options.map((option) => option.id));
    expect(projected.get(noReviewId)!.definition.humanReview).toBeUndefined();
    expect(projected.get(currentId)!.definition.humanReview!.recommendedNextStep)
      .toContain("현재 확인되지 않았습니다");
    expect(projected.get(customId)!.definition.humanReview!.interpretation).not.toContain("과거 카드");
    expect(oneProjection!.view.result).toBeNull();
    const terminalProjections = await loadOperatorDecisionProjections(db, terminalRows);
    for (const item of terminalProjections) projected.set(item.view.id, item.view);
    expect(restart(resolvedId).recommended).toBe(true);
    expect(restart(cancelledId).recommended).toBe(true);

    const restartSelection = { actionId: "approve", selectedOptionIds: [WORKFLOW_RESTART_FROM_START_OPTION_ID], comment: "reviewed" };
    for (const decisionId of [historicalId, currentId, hashMismatchId]) {
      await expect(writer.resolve(decisionId, restartSelection, "board-user")).rejects.toMatchObject({
        status: 409, details: { code: "recovery_restart_scope_unproven", operatorDecisionId: decisionId },
      });
    }
    expect((await writer.resolve(resolvedId, restartSelection, "board-user")).applied).toBe(false);
    await expect(writer.resolve(resolvedId, { ...restartSelection, comment: "approved" }, "board-user"))
      .rejects.toMatchObject({ status: 409 });

    const after = {
      decisions: await db.select().from(operatorDecisions).where(inArray(operatorDecisions.id, [...pendingIds, ...terminalIds])),
      events: await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, companyId)),
      activity: await db.select().from(activityLog).where(eq(activityLog.companyId, companyId)),
      comments: await db.select().from(issueComments).where(eq(issueComments.companyId, companyId)),
      runs: await db.select().from(workflowRuns).where(eq(workflowRuns.companyId, companyId)),
      steps: await db.select().from(workflowStepRuns).where(inArray(workflowStepRuns.workflowRunId, [runId])),
      issues: await db.select().from(issues).where(eq(issues.companyId, companyId)),
      invocations: await db.select().from(workflowStepInvocations).where(eq(workflowStepInvocations.companyId, companyId)),
      products: await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.companyId, companyId)),
      continuations: await db.select().from(operatorDecisionContinuations),
      wakeups: await db.select().from(agentWakeupRequests),
    };
    expect(after).toEqual(before);
  });
});

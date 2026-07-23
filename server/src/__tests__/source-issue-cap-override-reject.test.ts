// server/src/__tests__/source-issue-cap-override-reject.test.ts
//
// [목적] cap-override rejection/wrong-evidence 계약 검증. stale verdict · wrong verdict(PASS) ·
//   non-official verdict(heartbeat_result) · wrong scope(other mission) · under-cap · marker 없음/불일치 와
//   함께 decision-authority 거부(missing/wrong-author/wrong-decision/stale decision/wrong-issue comment) 가
//   모두 report_only 가 되고 run/producer 가 변경되지 않는다(transcript/과거 verdict/producer evidence 불신).
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issues, missions, workflowTransitionEvents } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { dispatchSourceIssueNativeResume } from "../services/workflow/source-issue-native-resume.js";
import { buildQaCapKey } from "../services/workflow/source-issue-cap-override.js";
import { validateOwnerDecisionComment } from "../services/workflow/source-issue-cap-override-authority.js";
import { capOwnerAction, drainHeartbeatRuns, PRODUCER, QA, reloadRun, seedCapExhaustedRun, startCapOverrideTestDb, type SeedOpts } from "./helpers/cap-override-fixtures.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`skip cap-override-reject tests: ${support.reason ?? "unsupported host"}`);

describeEP("dispatchSourceIssueNativeResume cap-override rejection path (never trust transcript/stale verdict/producer evidence)", () => {
  let db!: Awaited<ReturnType<typeof startCapOverrideTestDb>>["db"];
  let testDb!: Awaited<ReturnType<typeof startCapOverrideTestDb>>;
  beforeAll(async () => { testDb = await startCapOverrideTestDb(); db = testDb.db; }, 60_000);
  // no afterEach row clearing — isolation is by randomUUID company scope (all queries company-scoped).
  afterAll(async () => { await drainHeartbeatRuns(db); await testDb.cleanup(); });

  const seed = (overrides: SeedOpts = {}) => seedCapExhaustedRun(db, overrides);
  const call = (s: Awaited<ReturnType<typeof seedCapExhaustedRun>>, ownerActionMissionId = s.missionId) =>
    dispatchSourceIssueNativeResume(db, { companyId: s.companyId, issueId: s.producerIssueId, allowBlockedIssue: true, ownerAction: { ...capOwnerAction(s), missionId: ownerActionMissionId } });

  it("STALE VERDICT: RC observed before producer completion → report_only", async () => {
    const s = await seed({ verdictObservedAt: new Date("2026-07-09T00:00:30.000Z") });
    const outcome = await call(s);
    expect(outcome.kind).toBe("report_only");
    if (outcome.kind === "report_only") expect(outcome.reason).toBe("cap_override_no_current_request_changes");
    expect((await reloadRun(db, s.workflowRunId)).status).toBe("failed");
  });
  it("WRONG VERDICT: latest official verdict is PASS → report_only", async () => {
    const s = await seed();
    await db.insert(workflowTransitionEvents).values({
      companyId: s.companyId, missionId: s.missionId, workflowRunId: s.workflowRunId, workflowStepRunId: s.qaStepRunId, issueId: s.qaIssueId, heartbeatRunId: s.heartbeatRunId,
      eventType: "workflow_validation_verdict", layer: "workflow_validation", verdict: "pass", decision: "pass", reason: "workflow_api", reasonCode: "workflow_api",
      createdAt: new Date("2026-07-10T00:08:00.000Z"), payload: { kind: "workflow_validation_verdict", verdict: "pass" },
    });
    const outcome = await call(s);
    expect(outcome.kind).toBe("report_only");
    if (outcome.kind === "report_only") expect(outcome.reason).toBe("cap_override_no_current_request_changes");
  });
  it("NON-OFFICIAL VERDICT: origin is heartbeat_result → report_only", async () => {
    const s = await seed({ verdictOrigin: "heartbeat_result" });
    const outcome = await call(s);
    expect(outcome.kind).toBe("report_only");
    if (outcome.kind === "report_only") expect(outcome.reason).toBe("cap_override_no_current_request_changes");
  });
  it("WRONG SCOPE: owner action from a different mission → report_only (wrong_scope)", async () => {
    const s = await seed();
    const otherMission = randomUUID();
    await db.insert(missions).values({ id: otherMission, companyId: s.companyId, ownerAgentId: s.ownerAgentId, title: "Other mission", status: "active" });
    const outcome = await call(s, otherMission);
    expect(outcome.kind).toBe("report_only");
    if (outcome.kind === "report_only") expect(outcome.reason).toBe("cap_override_wrong_scope");
  });
  it("UNDER CAP: producer iteration below maxIterations → report_only", async () => {
    const s = await seed({ producerIteration: 0 });
    const outcome = await call(s);
    expect(outcome.kind).toBe("report_only");
    if (outcome.kind === "report_only") expect(outcome.reason).toBe("cap_override_under_cap");
  });
  it("rejects owner actions without the qa-cap-key marker (grace auto-default description)", async () => {
    const s = await seed();
    await db.update(issues).set({ description: "auto-default retry_source_issue" }).where(eq(issues.id, s.ownerActionIssueId));
    const outcome = await call(s);
    expect(outcome.kind).toBe("report_only");
    if (outcome.kind === "report_only") expect(outcome.reason).toBe("cap_override_no_marker");
  });
  it("rejects a stale-generation qa-cap-key", async () => {
    const s = await seed();
    const staleKey = buildQaCapKey({ companyId: s.companyId, workflowRunId: s.workflowRunId, producerStepId: PRODUCER, qaStepId: QA, producerIteration: 0, producerCompletedAt: new Date("2026-07-10T00:00:00.000Z") });
    await db.update(issues).set({ description: `qa-cap-key:${staleKey}` }).where(eq(issues.id, s.ownerActionIssueId));
    const outcome = await call(s);
    expect(outcome.kind).toBe("report_only");
    if (outcome.kind === "report_only") expect(outcome.reason).toBe("cap_override_no_marker");
  });
  it("rejects a qa-cap-key bound to the wrong QA edge", async () => {
    const s = await seed();
    const wrongQaKey = buildQaCapKey({ companyId: s.companyId, workflowRunId: s.workflowRunId, producerStepId: PRODUCER, qaStepId: "qa-other", producerIteration: 1, producerCompletedAt: new Date("2026-07-10T00:00:00.000Z") });
    await db.update(issues).set({ description: `qa-cap-key:${wrongQaKey}` }).where(eq(issues.id, s.ownerActionIssueId));
    const outcome = await call(s);
    expect(outcome.kind).toBe("report_only");
    if (outcome.kind === "report_only") expect(outcome.reason).toBe("cap_override_no_marker");
  });

  // [authority] missing structured decision fails closed even if caller supplies a decision event identifier.
  it("rejects when the structured owner decision is absent", async () => {
    const s = await seed({ skipDecisionComment: true });
    const outcome = await dispatchSourceIssueNativeResume(db, { companyId: s.companyId, issueId: s.producerIssueId, allowBlockedIssue: true, ownerAction: capOwnerAction(s) });
    expect(outcome.kind).toBe("report_only");
    if (outcome.kind === "report_only") expect(outcome.reason).toBe("cap_override_no_marker");
    expect((await reloadRun(db, s.workflowRunId)).status).toBe("failed");
  });
  it("rejects a structured decision authored by a non-owner agent (fail-closed authority)", async () => {
    const s = await seed();
    await db.update(workflowTransitionEvents).set({ heartbeatRunId: s.heartbeatRunId }).where(and(
      eq(workflowTransitionEvents.companyId, s.companyId),
      eq(workflowTransitionEvents.eventType, "mission_owner_decision"),
    ));
    const outcome = await call(s);
    expect(outcome.kind).toBe("report_only");
    if (outcome.kind === "report_only") expect(outcome.reason).toBe("cap_override_no_marker");
  });
  it("rejects a structured decision whose decision is not retry_source_issue", async () => {
    const s = await seed({ decision: "reassign_source_issue" });
    const outcome = await call(s);
    expect(outcome.kind).toBe("report_only");
    if (outcome.kind === "report_only") expect(outcome.reason).toBe("cap_override_no_marker");
  });
  it("rejects a structured decision predating the current cap handoff (stale authority)", async () => {
    const s = await seed({ decisionCreatedAt: new Date("2026-07-08T00:00:00.000Z") });
    const outcome = await call(s);
    expect(outcome.kind).toBe("report_only");
    if (outcome.kind === "report_only") expect(outcome.reason).toBe("cap_override_no_marker");
  });
  it("returns the exact structured decision event identity", async () => {
    const s = await seed();
    const result = await validateOwnerDecisionComment(db, s.companyId, {
      decisionCommentId: s.ownerDecisionEventId,
      ownerActionIssueId: s.ownerActionIssueId,
      missionOwnerAgentId: s.ownerAgentId,
      producerCompletedAt: new Date("2026-07-10T00:00:00.000Z"),
      producerIssueId: s.producerIssueId,
      producerIdentifier: null,
    });
    expect(result).toEqual(expect.objectContaining({ commentId: s.decisionCommentId, eventId: s.ownerDecisionEventId }));
  });
  it("rejects a supplied decision event ID that does not match the latest structured event", async () => {
    const s = await seed();
    await expect(validateOwnerDecisionComment(db, s.companyId, {
      decisionCommentId: randomUUID(),
      ownerActionIssueId: s.ownerActionIssueId,
      missionOwnerAgentId: s.ownerAgentId,
      producerCompletedAt: new Date("2026-07-10T00:00:00.000Z"),
      producerIssueId: s.producerIssueId,
      producerIdentifier: null,
    })).resolves.toBeNull();
  });
  it("rejects a structured retry decision targeting a different source issue", async () => {
    const s = await seed();
    const wrongTarget = randomUUID();
    await db.update(workflowTransitionEvents).set({
      payload: { kind: "mission_owner_decision", ownerActionIssueId: s.ownerActionIssueId, sourceIssueId: s.producerIssueId, commentId: s.decisionCommentId, decision: "retry_source_issue", reworkTargetRef: wrongTarget },
    }).where(and(eq(workflowTransitionEvents.companyId, s.companyId), eq(workflowTransitionEvents.eventType, "mission_owner_decision")));
    const outcome = await call(s);
    expect(outcome.kind).toBe("report_only");
    if (outcome.kind === "report_only") expect(outcome.reason).toBe("cap_override_no_marker");
  });
  it("prefers structured Rework target over Source issue and rejects a mismatched producer target", async () => {
    const s = await seed();
    await db.update(workflowTransitionEvents).set({
      payload: { kind: "mission_owner_decision", ownerActionIssueId: s.ownerActionIssueId, sourceIssueId: s.producerIssueId, commentId: s.decisionCommentId, decision: "retry_source_issue", sourceIssueRef: s.producerIssueId, reworkTargetRef: randomUUID() },
    }).where(and(eq(workflowTransitionEvents.companyId, s.companyId), eq(workflowTransitionEvents.eventType, "mission_owner_decision")));
    const outcome = await call(s);
    expect(outcome.kind).toBe("report_only");
    if (outcome.kind === "report_only") expect(outcome.reason).toBe("cap_override_no_marker");
  });
  it("rejects a retry when a newer structured replan decision supersedes it on the owner-action issue", async () => {
    const s = await seed();
    await db.insert(workflowTransitionEvents).values({
      companyId: s.companyId, missionId: s.missionId, issueId: s.ownerActionIssueId, heartbeatRunId: s.ownerDecisionHeartbeatRunId,
      eventType: "mission_owner_decision", layer: "mission_owner_recovery", decision: "replan_mission", reason: "owner_recovery_api", reasonCode: "owner_recovery_api", createdAt: new Date("2026-07-10T00:40:00.000Z"),
      payload: { kind: "mission_owner_decision", source: "owner_recovery_api", ownerActionIssueId: s.ownerActionIssueId, sourceIssueId: s.producerIssueId, decision: "replan_mission" },
    });
    const outcome = await call(s);
    expect(outcome.kind).toBe("report_only");
    if (outcome.kind === "report_only") expect(outcome.reason).toBe("cap_override_no_marker");
  });

  it("fails closed when only a natural-language decision comment exists", async () => {
    const s = await seed();
    await db.delete(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, s.companyId),
      eq(workflowTransitionEvents.eventType, "mission_owner_decision"),
    ));
    await expect(validateOwnerDecisionComment(db, s.companyId, {
      decisionCommentId: s.ownerDecisionEventId,
      ownerActionIssueId: s.ownerActionIssueId,
      missionOwnerAgentId: s.ownerAgentId,
      producerCompletedAt: new Date("2026-07-10T00:00:00.000Z"),
      producerIssueId: s.producerIssueId,
      producerIdentifier: null,
    })).resolves.toBeNull();
  });
  it("matches the handoff branch qa-cap-key fixed vector", () => {
    expect(buildQaCapKey({ companyId: "11111111-1111-1111-1111-111111111111", workflowRunId: "22222222-2222-2222-2222-222222222222", producerStepId: "produce", qaStepId: "qa-validate", producerIteration: 3, producerCompletedAt: new Date("2026-07-10T00:00:00.000Z") })).toBe("32da8362a2cd11e6fd1124b9965a4670");
  });
});

// server/src/__tests__/source-issue-cap-override-reject.test.ts
//
// [목적] cap-override rejection/wrong-evidence 계약 검증. stale verdict · wrong verdict(PASS) ·
//   non-official verdict(heartbeat_result) · wrong scope(other mission) · under-cap · marker 없음/불일치 와
//   함께 decision-authority 거부(missing/wrong-author/wrong-decision/stale decision/wrong-issue comment) 가
//   모두 report_only 가 되고 run/producer 가 변경되지 않는다(transcript/과거 verdict/producer evidence 불신).
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueComments, issues, missions, workflowTransitionEvents } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { dispatchSourceIssueNativeResume } from "../services/workflow/source-issue-native-resume.js";
import { buildQaCapKey } from "../services/workflow/source-issue-cap-override.js";
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

  // [Gap 1] decision-authority rejection: authority is the real owner decision comment, not a marker alone.
  it("rejects when the owner decision comment is missing (no issue_comments row for the id)", async () => {
    const s = await seed({ skipDecisionComment: true });
    const outcome = await dispatchSourceIssueNativeResume(db, { companyId: s.companyId, issueId: s.producerIssueId, allowBlockedIssue: true, ownerAction: capOwnerAction(s) });
    expect(outcome.kind).toBe("report_only");
    if (outcome.kind === "report_only") expect(outcome.reason).toBe("cap_override_no_marker");
    expect((await reloadRun(db, s.workflowRunId)).status).toBe("failed");
  });
  it("rejects a decision comment authored by a non-owner agent (fail-closed authority)", async () => {
    const s = await seed();
    // re-author the existing decision comment to a non-owner (producer) agent.
    await db.update(issueComments).set({ authorAgentId: s.producerAgentId }).where(eq(issueComments.id, s.decisionCommentId));
    const outcome = await call(s);
    expect(outcome.kind).toBe("report_only");
    if (outcome.kind === "report_only") expect(outcome.reason).toBe("cap_override_no_marker");
  });
  it("rejects a decision comment whose decision is not retry_source_issue", async () => {
    const s = await seed({ decision: "reassign_source_issue" });
    const outcome = await call(s);
    expect(outcome.kind).toBe("report_only");
    if (outcome.kind === "report_only") expect(outcome.reason).toBe("cap_override_no_marker");
  });
  it("rejects a decision comment predating the current cap handoff (stale authority)", async () => {
    const s = await seed({ decisionCreatedAt: new Date("2026-07-08T00:00:00.000Z") });
    const outcome = await call(s);
    expect(outcome.kind).toBe("report_only");
    if (outcome.kind === "report_only") expect(outcome.reason).toBe("cap_override_no_marker");
  });
  it("rejects a decision comment that lives on a different issue than the owner-action issue", async () => {
    const s = await seed();
    const stray = randomUUID();
    await db.insert(issueComments).values({ id: stray, companyId: s.companyId, issueId: s.producerIssueId, authorAgentId: s.ownerAgentId, createdAt: new Date("2026-07-10T00:20:00.000Z"), body: "### Mission owner decision\nDecision: retry_source_issue\nReason: stray." });
    const outcome = await dispatchSourceIssueNativeResume(db, { companyId: s.companyId, issueId: s.producerIssueId, allowBlockedIssue: true, ownerAction: capOwnerAction(s, stray) });
    expect(outcome.kind).toBe("report_only");
    if (outcome.kind === "report_only") expect(outcome.reason).toBe("cap_override_no_marker");
  });
  it("rejects a retry decision whose Source issue target is a different issue (exact target binding)", async () => {
    const s = await seed();
    const wrongTarget = randomUUID();
    await db.update(issueComments).set({ body: `### Mission owner decision\nDecision: retry_source_issue\nSource issue: ${wrongTarget}\nReason: targets the wrong issue.` }).where(eq(issueComments.id, s.decisionCommentId));
    const outcome = await call(s);
    expect(outcome.kind).toBe("report_only");
    if (outcome.kind === "report_only") expect(outcome.reason).toBe("cap_override_no_marker");
  });
  it("prefers Rework target over Source issue and rejects a mismatched producer target", async () => {
    const s = await seed();
    await db.update(issueComments).set({ body: `### Mission owner decision\nDecision: retry_source_issue\nSource issue: ${s.producerIssueId}\nRework target: ${randomUUID()}\nReason: wrong explicit rework target.` }).where(eq(issueComments.id, s.decisionCommentId));
    const outcome = await call(s);
    expect(outcome.kind).toBe("report_only");
    if (outcome.kind === "report_only") expect(outcome.reason).toBe("cap_override_no_marker");
  });
  it("rejects a stale retry when a newer recognized decision (replan) supersedes it on the owner-action issue", async () => {
    const s = await seed();
    // newer decision comment (later createdAt) with a different decision → retry is no longer the latest recognized.
    await db.insert(issueComments).values({ companyId: s.companyId, issueId: s.ownerActionIssueId, authorAgentId: s.ownerAgentId, createdAt: new Date("2026-07-10T00:40:00.000Z"), body: "### Mission owner decision\nDecision: replan_mission\nSource issue: other\nReason: plan must change." });
    const outcome = await call(s);
    expect(outcome.kind).toBe("report_only");
    if (outcome.kind === "report_only") expect(outcome.reason).toBe("cap_override_no_marker");
  });

  it("matches the handoff branch qa-cap-key fixed vector", () => {
    expect(buildQaCapKey({ companyId: "11111111-1111-1111-1111-111111111111", workflowRunId: "22222222-2222-2222-2222-222222222222", producerStepId: "produce", qaStepId: "qa-validate", producerIteration: 3, producerCompletedAt: new Date("2026-07-10T00:00:00.000Z") })).toBe("32da8362a2cd11e6fd1124b9965a4670");
  });
});

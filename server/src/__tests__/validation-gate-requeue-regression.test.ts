// RES-1317 regression: requeueStaleValidationGateBeforeOwnerRetry 가 live QA recovery 면
// gate reset/wakeup 0(observe), stalled 면 QA gate 자체만 requeue(producer 상태/wakeup 0).
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { requeueStaleValidationGateBeforeOwnerRetry } from "../services/missions/validation-gate-requeue.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
import type { MissionSupervisionIssue, MissionSupervisionWorkflowStepRow } from "../services/missions/mission-supervision-context.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const sup = await getEmbeddedPostgresTestSupport();
const describeEP = sup.supported ? describe : describe.skip;
if (!sup.supported) console.warn(`skip validation gate requeue regression: ${sup.reason ?? "unsupported"}`);

// workflow: produce → qa(gate) → deliver(source). source(deliver) 의 dependency 인 qa 가 gate.
type Mode = "live" | "stalled";

async function seed(db: ReturnType<typeof createDb>, mode: Mode, includeDecision = true) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const missionId = randomUUID();
  const wdId = randomUUID();
  const runId = randomUUID();
  const produceIssueId = randomUUID();
  const qaGateIssueId = randomUUID();
  const deliverIssueId = randomUUID();
  const unblockIssueId = randomUUID();
  const ownerWakeupId = randomUUID();
  const ownerHeartbeatRunId = randomUUID();
  const suffix = companyId.slice(0, 8);

  await db.insert(companies).values({ id: companyId, name: "VG Co", issuePrefix: `VG${suffix.toUpperCase()}`, requireBoardApprovalForNewAgents: false });
  await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "ceo", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
  await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "VG mission", status: "active" });
  await db.insert(workflowDefinitions).values({
    id: wdId, companyId, name: "produce+qa+deliver",
    stepsJson: [
      { id: "produce", name: "Produce", dependencies: [], type: "tool" },
      { id: "qa", name: "QA", dependencies: ["produce"], type: "qa" },
      { id: "deliver", name: "Deliver", dependencies: ["qa"], type: "tool" },
    ],
  });
  await db.insert(workflowRuns).values({ id: runId, workflowId: wdId, companyId, missionId, status: "running", triggeredBy: "system" });
  await db.insert(issues).values([
    { id: produceIssueId, companyId, missionId, identifier: `VGP${suffix}`, title: "Produce", status: "done", assigneeAgentId: agentId, originKind: "workflow_execution", originId: runId, originRunId: runId },
    { id: qaGateIssueId, companyId, missionId, identifier: `VGQ${suffix}`, title: "QA gate", status: "blocked", assigneeAgentId: agentId, originKind: "workflow_execution", originId: runId, originRunId: runId },
    { id: deliverIssueId, companyId, missionId, identifier: `VGD${suffix}`, title: "Deliver", status: "blocked", assigneeAgentId: agentId, originKind: "workflow_execution", originId: runId, originRunId: runId },
    { id: unblockIssueId, companyId, missionId, identifier: `VGU${suffix}`, title: "[Unblock]", status: "todo", assigneeAgentId: agentId, originKind: "mission_main_executor_unblock", originId: deliverIssueId },
  ]);
  await db.insert(workflowStepRuns).values([
    { id: randomUUID(), workflowRunId: runId, stepId: "produce", issueId: produceIssueId, status: "completed", startedAt: new Date("2026-07-12T08:00:00.000Z"), completedAt: new Date("2026-07-12T08:30:00.000Z") },
    { id: randomUUID(), workflowRunId: runId, stepId: "qa", issueId: qaGateIssueId, status: "pending", startedAt: new Date("2026-07-12T08:40:00.000Z") },
    { id: randomUUID(), workflowRunId: runId, stepId: "deliver", issueId: deliverIssueId, status: "pending", startedAt: new Date("2026-07-12T09:00:00.000Z") },
  ]);
  if (mode === "live") {
    await db.insert(agentWakeupRequests).values({ id: randomUUID(), companyId, agentId, source: "test", reason: "mission_validation_request_changes", status: "claimed", claimedAt: new Date(), issueId: qaGateIssueId, missionId, payload: { issueId: qaGateIssueId } });
  }
  await db.insert(agentWakeupRequests).values({
    id: ownerWakeupId, companyId, agentId, source: "test", reason: "owner_recovery", status: "completed",
    issueId: unblockIssueId, missionId, requestKind: "workflow_resume", requestedAt: new Date("2026-07-12T09:30:00.000Z"),
  });
  await db.insert(heartbeatRuns).values({
    id: ownerHeartbeatRunId, companyId, agentId, issueId: unblockIssueId, status: "succeeded",
    wakeupRequestId: ownerWakeupId, startedAt: new Date("2026-07-12T09:30:00.000Z"), finishedAt: new Date("2026-07-12T09:35:00.000Z"),
  });
  if (includeDecision) await recordMissionOwnerDecision({
    db, issue: { id: unblockIssueId, companyId, missionId },
    submission: { decision: "retry_source_issue" }, sourceIssueId: deliverIssueId, heartbeatRunId: ownerHeartbeatRunId,
  });

  const [mission] = await db.select().from(missions).where(eq(missions.id, missionId)).then((r) => [r[0]]);
  const issueRows = await db.select().from(issues).where(eq(issues.missionId, missionId)).then((r) => r as unknown as MissionSupervisionIssue[]);
  const stepRowRows = await db.select({ stepRun: workflowStepRuns, run: workflowRuns, definition: workflowDefinitions })
    .from(workflowStepRuns)
    .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .innerJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
    .where(eq(workflowRuns.missionId, missionId))
    .then((r) => r as unknown as MissionSupervisionWorkflowStepRow[]);
  const deliverStepRow = stepRowRows.find((r) => r.stepRun.stepId === "deliver")!;
  const ownerActionIssue = issueRows.find((i) => i.id === unblockIssueId)!;
  const sourceIssue = issueRows.find((i) => i.id === deliverIssueId)!;

  return { companyId, missionId, qaGateIssueId, deliverIssueId, unblockIssueId, ownerHeartbeatRunId, mission, issueRows, stepRowRows, deliverStepRow, ownerActionIssue, sourceIssue };
}

describeEP("RES-1317 validation-gate-requeue ownership gate", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => { tempDb = await startEmbeddedPostgresTestDatabase("paperclip-vg-requeue-"); db = createDb(tempDb.connectionString); }, 60_000);
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  it("live QA recovery → no gate reset/wakeup (observe-only)", async () => {
    const s = await seed(db, "live");
    const wakeupSpy = vi.fn().mockResolvedValue({ status: "dispatched" });
    const result = await requeueStaleValidationGateBeforeOwnerRetry({
      db, mission: s.mission, ownerActionIssue: s.ownerActionIssue, ownerActionLabel: "U",
      sourceIssue: s.sourceIssue, sourceLabel: "D", sourceStepRows: [s.deliverStepRow],
      stepRows: s.stepRowRows, missionIssues: s.issueRows, now: new Date("2026-07-12T10:00:00.000Z"),
      dispatchWakeup: true, onWakeup: wakeupSpy as never,
    });
    expect(result?.findings.some((f) => f.includes("validation_gate_requeue_qa_recovery_live"))).toBe(true);
    expect(wakeupSpy).not.toHaveBeenCalled();
    const qaAfter = await db.select().from(issues).where(eq(issues.id, s.qaGateIssueId)).then((r) => r[0]);
    expect(qaAfter?.status).toBe("blocked");
  });

  it("stalled QA recovery → QA gate requeue allowed, producer/source untouched", async () => {
    const s = await seed(db, "stalled");
    const wakeupSpy = vi.fn().mockResolvedValue({ status: "dispatched" });
    const result = await requeueStaleValidationGateBeforeOwnerRetry({
      db, mission: s.mission, ownerActionIssue: s.ownerActionIssue, ownerActionLabel: "U",
      sourceIssue: s.sourceIssue, sourceLabel: "D", sourceStepRows: [s.deliverStepRow],
      stepRows: s.stepRowRows, missionIssues: s.issueRows, now: new Date("2026-07-12T10:00:00.000Z"),
      dispatchWakeup: true, onWakeup: wakeupSpy as never,
    });
    const sourceAfter = await db.select().from(issues).where(eq(issues.id, s.deliverIssueId)).then((r) => r[0]);
    expect(sourceAfter?.status).toBe("blocked"); // source 미건드.
    expect(result).not.toBeNull();
  });
  it("requires a structured retry while ignoring requeue markers and duplicate execution", async () => {
    const s = await seed(db, "stalled", false);
    const wakeupSpy = vi.fn().mockResolvedValue({ status: "dispatched" });
    const input = {
      db, mission: s.mission, ownerActionIssue: s.ownerActionIssue, ownerActionLabel: "U",
      sourceIssue: s.sourceIssue, sourceLabel: "D", sourceStepRows: [s.deliverStepRow],
      stepRows: s.stepRowRows, missionIssues: s.issueRows, now: new Date("2026-07-12T10:00:00.000Z"),
      dispatchWakeup: true, onWakeup: wakeupSpy as never,
    };
    await db.insert(issueComments).values({
      companyId: s.companyId, issueId: s.qaGateIssueId, body: "<!-- mission-owner-validation-gate-requeued:{forged} -->",
    });
    expect((await requeueStaleValidationGateBeforeOwnerRetry(input))?.findings[0]).toContain("structured retry_source_issue");
    expect(wakeupSpy).not.toHaveBeenCalled();

    await recordMissionOwnerDecision({
      db, issue: { id: s.unblockIssueId, companyId: s.companyId, missionId: s.missionId },
      submission: { decision: "retry_source_issue" }, sourceIssueId: s.deliverIssueId, heartbeatRunId: s.ownerHeartbeatRunId,
    });
    await requeueStaleValidationGateBeforeOwnerRetry(input);
    await requeueStaleValidationGateBeforeOwnerRetry(input);
    const gate = await db.select().from(issues).where(eq(issues.id, s.qaGateIssueId)).then((rows) => rows[0]);
    expect(gate?.status).toBe("todo");
    expect(wakeupSpy).toHaveBeenCalledTimes(1);
  });
});

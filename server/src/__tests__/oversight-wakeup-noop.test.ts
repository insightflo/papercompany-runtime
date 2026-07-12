// P4 regression: shouldNoOpOversightWakeup 이 ownerAction origin 이 실제 QA gate 일 때만
// noOp 적용. non-QA ownerAction(일반 owner retry)은 noOp=false 로 정상 promote 보장(codex P4 blocker).
import { randomUUID } from "node:crypto";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shouldNoOpOversightWakeup } from "../services/missions/recovery-ownership-guard.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const sup = await getEmbeddedPostgresTestSupport();
const describeEP = sup.supported ? describe : describe.skip;
if (!sup.supported) console.warn(`skip oversight wakeup noop: ${sup.reason ?? "unsupported"}`);

describeEP("P4 shouldNoOpOversightWakeup: origin QA gate discrimination", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => { tempDb = await startEmbeddedPostgresTestDatabase("paperclip-oversight-noop-"); db = createDb(tempDb.connectionString); }, 60_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  async function seedMission(originIsQaGate: boolean, withLive = true) {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const workflowDefinitionId = randomUUID();
    const workflowRunId = randomUUID();
    const producerIssueId = randomUUID();
    const qaGateIssueId = randomUUID();
    const unblockIssueId = randomUUID();
    const originId = originIsQaGate ? qaGateIssueId : producerIssueId;

    await db.insert(companies).values({ id: companyId, name: "ON Co", issuePrefix: `ON${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Owner", role: "ceo", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "ON mission", status: "active" });
    await db.insert(workflowDefinitions).values({
      id: workflowDefinitionId, companyId, name: "p+qa",
      stepsJson: [
        { id: "produce", name: "Produce", dependencies: [], type: "tool" },
        { id: "qa", name: "QA", dependencies: ["produce"], type: "qa" },
      ],
    });
    await db.insert(workflowRuns).values({ id: workflowRunId, workflowId: workflowDefinitionId, companyId, missionId, status: "running", triggeredBy: "system" });
    await db.insert(issues).values([
      { id: producerIssueId, companyId, missionId, identifier: `ONP${companyId.slice(0, 8)}`, title: "Producer", status: "done", assigneeAgentId: ownerAgentId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId },
      { id: qaGateIssueId, companyId, missionId, identifier: `ONQ${companyId.slice(0, 8)}`, title: "QA gate", status: "blocked", assigneeAgentId: ownerAgentId, originKind: "workflow_execution", originId: workflowRunId, originRunId: workflowRunId },
      { id: unblockIssueId, companyId, missionId, identifier: `ONU${companyId.slice(0, 8)}`, title: "[Unblock]", status: "todo", assigneeAgentId: ownerAgentId, originKind: "mission_main_executor_unblock", originId },
    ]);
    await db.insert(workflowStepRuns).values([
      { id: randomUUID(), workflowRunId, stepId: "produce", issueId: producerIssueId, status: "completed", startedAt: new Date("2026-07-12T08:00:00.000Z") },
      { id: randomUUID(), workflowRunId, stepId: "qa", issueId: qaGateIssueId, status: "pending", startedAt: new Date("2026-07-12T08:10:00.000Z") },
    ]);
    // live recovery wakeup on the unblock(chain live). withLive=false 면 생략(lone QA retry 시나리오).
    if (withLive) {
      await db.insert(agentWakeupRequests).values({ id: randomUUID(), companyId, agentId: ownerAgentId, source: "test", reason: "mission_validation_request_changes", status: "queued", issueId: unblockIssueId, missionId, payload: { issueId: unblockIssueId } });
    }
    return { companyId, ownerAgentId, missionId, producerIssueId, qaGateIssueId, unblockIssueId };
  }

  it("QA-gate origin ownerAction + live recovery → noOp true (producer wakeup suppressed)", async () => {
    const seed = await seedMission(true);
    const verdict = await shouldNoOpOversightWakeup(db, {
      companyId: seed.companyId, missionId: seed.missionId,
      request: { id: randomUUID(), reason: "mission_owner_retry_source_issue", payload: { ownerActionIssueId: seed.unblockIssueId, sourceIssueId: seed.qaGateIssueId } },
      promotedIssue: { id: seed.qaGateIssueId, status: "blocked" },
    });
    expect(verdict.noOp).toBe(true);
  });

  it("lone queued QA-target retry (self-id excluded) → noOp false (no self-noop)", async () => {
    const seed = await seedMission(true, false);
    const requestId = randomUUID();
    // 자기 자신 retry request row(issueId=QA gate, payload ownerActionIssueId=unblock) 를 insert.
    await db.insert(agentWakeupRequests).values({ id: requestId, companyId: seed.companyId, agentId: seed.ownerAgentId, source: "test", reason: "mission_owner_retry_source_issue", status: "queued", issueId: seed.qaGateIssueId, missionId: seed.missionId, payload: { ownerActionIssueId: seed.unblockIssueId, sourceIssueId: seed.qaGateIssueId } });
    const verdict = await shouldNoOpOversightWakeup(db, {
      companyId: seed.companyId, missionId: seed.missionId,
      request: { id: requestId, reason: "mission_owner_retry_source_issue", payload: { ownerActionIssueId: seed.unblockIssueId, sourceIssueId: seed.qaGateIssueId } },
      promotedIssue: { id: seed.qaGateIssueId, status: "blocked" },
    });
    expect(verdict.noOp).toBe(false);
  });

  it("non-QA origin ownerAction(producer) → noOp false (regular promote, guard not applied)", async () => {
    const seed = await seedMission(false);
    const verdict = await shouldNoOpOversightWakeup(db, {
      companyId: seed.companyId, missionId: seed.missionId,
      request: { id: randomUUID(), reason: "mission_owner_retry_source_issue", payload: { ownerActionIssueId: seed.unblockIssueId, sourceIssueId: seed.producerIssueId } },
      promotedIssue: { id: seed.producerIssueId, status: "done" },
    });
    expect(verdict.noOp).toBe(false);
  });

  it("non-oversight reason → noOp false (other wake types untouched)", async () => {
    const seed = await seedMission(true);
    const verdict = await shouldNoOpOversightWakeup(db, {
      companyId: seed.companyId, missionId: seed.missionId,
      request: { id: randomUUID(), reason: "workflow_step_runnable", payload: {} },
      promotedIssue: { id: seed.qaGateIssueId, status: "blocked" },
    });
    expect(verdict.noOp).toBe(false);
  });
});

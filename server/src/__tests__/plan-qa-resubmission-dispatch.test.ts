// [TEST] T8 resubmission 실행 연결: 실제 heartbeat admission 이 예약된 재제출 wake 를 수락하고
//   qualityAcceptance 원문을 기록하는지, 그리고 새 epoch 실행 시도가 소명 누락 문서를 전달받아
//   read/submit 을 수행한 뒤 게이트가 완성되는지를 실제 DB·스토리지·라우터로 증명한다.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import request from "supertest";
import { agentWakeupRequests, agents, heartbeatRuns, instanceSettings, issues } from "@paperclipai/db";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { ArtifactRef, QualityAgentActor } from "@paperclipai/shared";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { heartbeatService } from "../services/heartbeat.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import { issueService } from "../services/issues.js";
import {
  GATE_CHECK_ID, GATE_DECISION_HASH, readAndVerify, seedGateWorld, type GateWorld,
} from "./helpers/plan-qa-addendum.js";
import { planQaApiApp } from "./helpers/plan-qa-api.js";
import { createPlanQaResubmissionWakeupHandler } from "../services/missions/plan-qa-wakeup.js";
import { dispatchPendingPlanQaResubmission } from "../services/missions/plan-qa-resubmission.js";
import { planQaResubmissionWakeKey } from "../services/quality/native-wake.js";
import { readVerifiedPlanQaGate } from "../services/missions/plan-qa-verified-gate.js";

const executeSpy = vi.fn();
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: executeSpy })),
  runningProcesses: new Map(),
}));

function successfulAdapterResult() {
  return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, usage: null, provider: "test", model: "test-model", resultJson: null, runtimeServices: [] };
}

function dispatchInput(w: GateWorld, enqueue: unknown) {
  return {
    companyId: w.companyId, planQaIssueId: w.planQaIssueId, decisionHash: GATE_DECISION_HASH,
    missionId: w.missionId, enqueue,
  } as Parameters<typeof dispatchPendingPlanQaResubmission>[1];
}

function resubmitKey(w: GateWorld, attempt: number) {
  return planQaResubmissionWakeKey({ issueId: w.planQaIssueId, decisionHash: GATE_DECISION_HASH, generation: 1, attempt });
}

/** fixture 의 합성 시도를 종료해 실제 heartbeat 실행을 받을 준비를 한다. */
async function endFixtureAttempt(db: Db, w: GateWorld) {
  await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, w.runId));
  await db.update(issues).set({ status: "todo", checkoutRunId: null, executionRunId: null }).where(eq(issues.id, w.planQaIssueId));
  await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true } } }).where(eq(agents.id, w.reviewerAgentId));
  executeSpy.mockImplementation(async () => successfulAdapterResult());
}

async function wakeRowByIntentKey(db: Db, companyId: string, intentKey: string) {
  const [row] = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, intentKey),
  )).limit(1);
  return row ?? null;
}

describeQualityDb("PLAN-QA resubmission dispatch through real heartbeat", () => {
  let owned: QualityTestDb;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "quality-t8-redispatch-"));
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", root);
    owned = await createQualityTestDb();
    await owned.db.insert(instanceSettings).values({ singletonKey: "default", experimental: { enableHeartbeatFinalizationV1: true } })
      .onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { experimental: { enableHeartbeatFinalizationV1: true } } });
  }, 120_000);
  afterAll(async () => { if (owned?.db) await waitForHeartbeatExecutionsToDrain(owned.db); await owned?.close(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });

  it("records durable acceptance when a scheduled resubmission wake is admitted for a new run", async () => {
    const w = await seedGateWorld(owned.db);
    await readAndVerify(w, "pass", {});
    await endFixtureAttempt(owned.db, w);
    const handler = createPlanQaResubmissionWakeupHandler(heartbeatService(owned.db), { requestedByActorId: "t8-test" });
    expect(await dispatchPendingPlanQaResubmission(owned.db, dispatchInput(w, handler)))
      .toEqual({ requested: true, accepted: false });
    await waitForHeartbeatExecutionsToDrain(owned.db);
    const [run] = await owned.db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, w.companyId), eq(heartbeatRuns.issueId, w.planQaIssueId),
    )).orderBy(desc(heartbeatRuns.createdAt)).limit(1);
    expect(run?.id).not.toBe(w.runId);
    const wakeRow = await wakeRowByIntentKey(owned.db, w.companyId, resubmitKey(w, 1));
    expect(wakeRow?.runId).toBe(run?.id);
    expect(wakeRow?.qualityAcceptance).toMatchObject({
      intentKey: resubmitKey(w, 1), issueId: w.planQaIssueId, generation: 1, attempt: 1,
      agentId: w.reviewerAgentId, heartbeatRunId: run?.id,
    });
    expect((wakeRow?.qualityAcceptance as Record<string, unknown>).inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await dispatchPendingPlanQaResubmission(owned.db, dispatchInput(w, handler)))
      .toEqual({ requested: true, accepted: true });
  });

  it("writes no acceptance without a durable dispatch record (fail closed)", async () => {
    const w = await seedGateWorld(owned.db);
    await endFixtureAttempt(owned.db, w);
    const handler = createPlanQaResubmissionWakeupHandler(heartbeatService(owned.db), {});
    await handler({ companyId: w.companyId, agentId: w.reviewerAgentId, issueId: w.planQaIssueId, missionId: w.missionId, intentKey: resubmitKey(w, 3), attempt: 3 });
    await waitForHeartbeatExecutionsToDrain(owned.db);
    const wakeRow = await wakeRowByIntentKey(owned.db, w.companyId, resubmitKey(w, 3));
    expect(wakeRow).not.toBeNull();
    expect(wakeRow?.qualityAcceptance ?? null).toBeNull();
  });

  it("delivers the persisted missing-evidence action to a real new epoch attempt and completes after resubmission", async () => {
    const w = await seedGateWorld(owned.db);
    await endFixtureAttempt(owned.db, w);
    let invocation = 0;
    let run1Id = "";
    let run2Id = "";
    let epoch1 = 0;
    let epoch2 = 0;
    executeSpy.mockImplementation(async ({ runId }: { runId: string }) => {
      invocation += 1;
      const [current] = await owned.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(current?.status).toBe("running");
      expect(current?.executionEpoch).toEqual(expect.any(Number));
      const actor: QualityAgentActor = {
        agentId: w.reviewerAgentId, companyId: w.companyId,
        heartbeatRunId: runId, executionEpoch: current!.executionEpoch!,
      };
      if (invocation === 1) {
        run1Id = runId;
        epoch1 = actor.executionEpoch;
        await issueService(owned.db).checkout(w.planQaIssueId, w.reviewerAgentId, ["todo", "in_progress"], runId);
        const app = planQaApiApp(owned.db, w, { type: "agent", source: "agent_jwt", companyId: w.companyId, agentId: w.reviewerAgentId, runId });
        const missing = await request(app).post(`/api/issues/${w.planQaIssueId}/mission-plan-qa/verdict`)
          .send({ schemaVersion: 2, verdict: "pass", checks: [] }).expect(200);
        expect(missing.body).toMatchObject({ status: "missing_evidence", resubmission: { requested: true, accepted: false } });
        return successfulAdapterResult();
      }
      run2Id = runId;
      epoch2 = actor.executionEpoch;
      await issueService(owned.db).checkout(w.planQaIssueId, w.reviewerAgentId, ["blocked", "todo", "in_progress"], runId);
      const app = planQaApiApp(owned.db, w, { type: "agent", source: "agent_jwt", companyId: w.companyId, agentId: w.reviewerAgentId, runId });
      const base = `/api/issues/${w.planQaIssueId}/mission-plan-qa`;
      const input = await request(app).get(`${base}/input`).expect(200);
      expect(input.body.data.scope.heartbeatRunId).toBe(runId);
      expect(input.body.data.pendingResubmission.intentKey).toBe(resubmitKey(w, 1));
      expect(input.body.data.pendingResubmission.missingEvidence.status).toBe("missing_evidence");
      const read = await request(app).post(`${base}/read`).send({ checkId: GATE_CHECK_ID, pointers: ["/missionId"] }).expect(201);
      await request(app).post(`${base}/verdict`).send({
        schemaVersion: 2, verdict: "pass",
        checks: [{ checkId: GATE_CHECK_ID, status: "satisfied", readRef: read.body.data.readRef, evidence: [] }],
      }).expect(200);
      return successfulAdapterResult();
    });
    const heartbeat = heartbeatService(owned.db);
    const run = await heartbeat.invoke(w.reviewerAgentId, "assignment", { taskKey: `issue:${w.planQaIssueId}`, issueId: w.planQaIssueId, missionId: w.missionId }, "system", { actorType: "system", actorId: "test-suite" });
    expect(run).not.toBeNull();
    await waitForHeartbeatExecutionsToDrain(owned.db);
    expect((await heartbeat.getRun(run1Id))?.status).toBe("succeeded");
    expect((await heartbeat.getRun(run2Id))?.status).toBe("succeeded");
    expect(epoch2).toBeGreaterThan(epoch1);
    const wakeRow = await wakeRowByIntentKey(owned.db, w.companyId, resubmitKey(w, 1));
    expect(wakeRow?.qualityAcceptance).toMatchObject({ heartbeatRunId: run2Id, attempt: 1 });
    const [issue] = await owned.db.select().from(issues).where(eq(issues.id, w.planQaIssueId));
    expect(issue?.status).toBe("done");
    const marker = issue!.qualityPlanQaBinding as { manifestRef: ArtifactRef };
    const gate = await readVerifiedPlanQaGate(owned.db, {
      kind: "plan_qa", companyId: w.companyId, missionId: w.missionId, planArtifactId: w.planArtifactId,
      issueId: w.planQaIssueId, decisionHash: GATE_DECISION_HASH, manifestRef: marker.manifestRef,
      reviewGeneration: 1, heartbeatRunId: run2Id, executionEpoch: epoch2,
      workflow: { kind: "not_applicable", reason: "mission_plan_qa_issue" },
    });
    expect(gate).toEqual({ verdict: "pass", evidenceRefId: expect.any(String) });
  });
});

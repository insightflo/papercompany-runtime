// [TEST] T8 PLAN-QA addendum 완료 게이트: 신형(표식+활성 대상) 검토 이슈는 verified gate 영수증이
//   있어야만 완료된다. 표식이 있는데 명세가 사라지면 구형 any_issue_verdict fallback 을 쓰지 않는다.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, assets, createDb, heartbeatRuns, instanceSettings, issueAttachments, issues, missionPlanArtifacts } from "@paperclipai/db";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { heartbeatService } from "../services/heartbeat.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";
import { issueService } from "../services/issues.js";
import { recordMissionPlanQaVerdict } from "../services/missions/mission-plan-qa-verdicts.js";
import { GATE_CHECK_ID, GATE_DECISION_HASH, seedGateWorld, type GateWorld } from "./helpers/plan-qa-addendum.js";
import { buildPlanQaScope, readPlanQaCheck, verifyPlanQaSubmission } from "../services/missions/plan-qa-addendum-gate.js";

const executeSpy = vi.fn();
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: executeSpy })),
  runningProcesses: new Map(),
}));

function successfulAdapterResult() {
  return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, usage: null, provider: "test", model: "test-model", resultJson: null, runtimeServices: [] };
}

/** 신형 이슈에 gate 를 만든다(base v1 row 만 있는 상태와 대비용). */
async function passGate(w: GateWorld, status: "satisfied" | "defect" = "satisfied") {
  const scope = await buildPlanQaScope(w.db, { companyId: w.companyId, issueId: w.planQaIssueId, heartbeatRunId: w.runId, executionEpoch: w.actor.executionEpoch });
  const read = await readPlanQaCheck(w.db, w.actor, { issueId: w.planQaIssueId, checkId: GATE_CHECK_ID, pointers: ["/missionId"] });
  await recordMissionPlanQaVerdict({ db: w.db, companyId: w.companyId, missionId: w.missionId, planQaIssueId: w.planQaIssueId, decisionHash: GATE_DECISION_HASH, verdict: "pass", reviewedBy: { actorType: "agent", actorId: w.reviewerAgentId }, sourceRunId: w.runId });
  return verifyPlanQaSubmission(w.db, w.actor, { scope, schemaVersion: 2, checks: [{ checkId: GATE_CHECK_ID, status, readRef: read.readRef, evidence: [] }] });
}

describeQualityDb("PLAN-QA addendum completion gate", () => {
  let owned: QualityTestDb;
  let db: ReturnType<typeof createDb>;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "quality-t8-completion-"));
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", root);
    owned = await createQualityTestDb();
    db = owned.db;
  }, 120_000);
  afterAll(async () => { if (db) await waitForHeartbeatExecutionsToDrain(db); await owned?.close(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });

  it("blocks direct done on a strict pinned review with only a base verdict row", async () => {
    const w = await seedGateWorld(db);
    await recordMissionPlanQaVerdict({ db, companyId: w.companyId, missionId: w.missionId, planQaIssueId: w.planQaIssueId, decisionHash: GATE_DECISION_HASH, verdict: "pass", reviewedBy: { actorType: "agent", actorId: w.reviewerAgentId }, sourceRunId: w.runId });
    await expect(issueService(db).update(w.planQaIssueId, { status: "done" })).rejects.toMatchObject({ status: 422 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, w.planQaIssueId));
    expect(issue?.status).toBe("in_progress");
  });

  it("allows done after the strict verified gate records pass or request_changes", async () => {
    const passWorld = await seedGateWorld(db);
    await expect(passGate(passWorld)).resolves.toMatchObject({ status: "pass" });
    await expect(issueService(db).update(passWorld.planQaIssueId, { status: "done" })).resolves.toMatchObject({ status: "done" });

    const defectWorld = await seedGateWorld(db);
    await expect(passGate(defectWorld, "defect")).resolves.toMatchObject({ status: "request_changes" });
    await expect(issueService(db).update(defectWorld.planQaIssueId, { status: "done" })).resolves.toMatchObject({ status: "done" });
  });

  it("never falls back to any_issue_verdict on a marked review whose manifest disappeared", async () => {
    const w = await seedGateWorld(db);
    await recordMissionPlanQaVerdict({ db, companyId: w.companyId, missionId: w.missionId, planQaIssueId: w.planQaIssueId, decisionHash: GATE_DECISION_HASH, verdict: "pass", reviewedBy: { actorType: "agent", actorId: w.reviewerAgentId }, sourceRunId: w.runId });
    const attachments = await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, w.planQaIssueId));
    for (const attachment of attachments) {
      await db.delete(issueAttachments).where(eq(issueAttachments.id, attachment.id));
      await db.delete(assets).where(eq(assets.id, attachment.assetId));
    }
    await expect(issueService(db).update(w.planQaIssueId, { status: "done" })).rejects.toMatchObject({ status: 422 });
  });

  it("keeps the legacy verdict-row completion path for marked reviews without addendum targets", async () => {
    const w = await seedGateWorld(db, { policy: false });
    await recordMissionPlanQaVerdict({ db, companyId: w.companyId, missionId: w.missionId, planQaIssueId: w.planQaIssueId, decisionHash: GATE_DECISION_HASH, verdict: "pass", reviewedBy: { actorType: "agent", actorId: w.reviewerAgentId }, sourceRunId: w.runId });
    await expect(issueService(db).update(w.planQaIssueId, { status: "done" })).resolves.toMatchObject({ status: "done" });
  });

  it.each(["planQa", "ownerPlanDecision"])("blocks marked no-addendum completion when %s identity disappears", async (key) => {
    const w = await seedGateWorld(db, { policy: false });
    await recordMissionPlanQaVerdict({ db, companyId: w.companyId, missionId: w.missionId, planQaIssueId: w.planQaIssueId, decisionHash: GATE_DECISION_HASH, verdict: "pass", reviewedBy: { actorType: "agent", actorId: w.reviewerAgentId }, sourceRunId: w.runId });
    const [plan] = await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.id, w.planArtifactId));
    const refs = { ...plan!.refs };
    delete refs[key];
    await db.update(missionPlanArtifacts).set({ refs }).where(eq(missionPlanArtifacts.id, w.planArtifactId));
    await expect(issueService(db).update(w.planQaIssueId, { status: "done" })).rejects.toMatchObject({ status: 422 });
  });

  it("heartbeat auto-completion follows the same verified receipt", async () => {
    // Only this owned DB enables the native epoch-producing lifecycle; no runtime activation.
    await db.insert(instanceSettings).values({ singletonKey: "default", experimental: { enableHeartbeatFinalizationV1: true } })
      .onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { experimental: { enableHeartbeatFinalizationV1: true } } });
    for (const submission of ["base_only", "satisfied", "defect", "previous_pass"] as const) {
      const w = await seedGateWorld(db);
      if (submission === "previous_pass") await expect(passGate(w)).resolves.toMatchObject({ status: "pass" });
      // End only the fixture's synthetic attempt; retain it so stale-PASS rejection is exercised.
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, w.runId));
      await db.update(issues).set({ status: "todo", checkoutRunId: null, executionRunId: null }).where(eq(issues.id, w.planQaIssueId));
      await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true } } }).where(eq(agents.id, w.reviewerAgentId));
      executeSpy.mockImplementation(async ({ runId }: { runId: string }) => {
        const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        expect(current?.status).toBe("running");
        expect(current?.executionEpoch).toEqual(expect.any(Number));
        await issueService(db).checkout(w.planQaIssueId, w.reviewerAgentId, ["todo", "in_progress"], runId);
        const currentWorld = { ...w, runId, actor: { ...w.actor, heartbeatRunId: runId, executionEpoch: current!.executionEpoch! } };
        if (submission === "satisfied" || submission === "defect") {
          await expect(passGate(currentWorld, submission)).resolves.toMatchObject({ status: submission === "defect" ? "request_changes" : "pass" });
        } else if (submission === "base_only") {
          await recordMissionPlanQaVerdict({ db, companyId: w.companyId, missionId: w.missionId, planQaIssueId: w.planQaIssueId, decisionHash: GATE_DECISION_HASH, verdict: "pass", reviewedBy: { actorType: "agent", actorId: w.reviewerAgentId }, sourceRunId: runId });
        }
        return successfulAdapterResult();
      });
      const heartbeat = heartbeatService(db);
      const run = await heartbeat.invoke(w.reviewerAgentId, "assignment", { taskKey: `issue:${w.planQaIssueId}`, issueId: w.planQaIssueId, missionId: w.missionId }, "system", { actorType: "system", actorId: "test-suite" });
      expect(run).not.toBeNull();
      await waitForHeartbeatExecutionsToDrain(db);
      expect((await heartbeat.getRun(run!.id))?.status).toBe("succeeded");
      const [issue] = await db.select().from(issues).where(eq(issues.id, w.planQaIssueId));
      const completed = submission === "satisfied" || submission === "defect";
      expect(issue?.status).toBe(completed ? "done" : "blocked");
      if (completed) expect(issue?.completedAt).toBeInstanceOf(Date);
    }
  }, 120_000); // 4개의 실제 heartbeat E2E 사이클 — 결합 실행 시 기본 10s 를 초과할 수 있다.
});

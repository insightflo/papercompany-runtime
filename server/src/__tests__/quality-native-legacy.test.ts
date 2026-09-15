// server/src/__tests__/quality-native-legacy.test.ts
//
// [purpose] T3 레거시 보존 회귀:
//   1) 원본 완료/취소 mission 의 도메인 행이 정식 연결 생성 전후로 동일하다(원본 불변).
//   2) 일반(non-quality) DAG 경로는 기존 의미(이슈 생성 → 그 안에서 깨우기 → 이후 step 연결)를 유지한다.
//      — 깨우는 시점에 step 연결은 아직 커밋되지 않았다(관찰로 증명).
//   3) Quality 대상 DAG 는 issue+step 연결 commit → 깨우기 순서다.
//      — 깨우는 시점에 step 연결이 이미 커밋되어 있다(관찰로 증명).

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  heartbeatRuns,
  issueComments,
  issues,
  missions,
  missionAgents,
  missionPlanArtifacts,
  qualityActions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
  type Db,
} from "@paperclipai/db";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { seedQualityFixture, type QualityFixture } from "./helpers/quality-fixture.js";
import { hashContract } from "../services/quality/contract.js";
import { ensureCanonicalQualityExecution } from "../services/quality/native-records.js";
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";

type WakeObservation = { issueId: string; boundStepRunIdAtWake: string | null };
const wakeProbe = vi.hoisted(() => ({
  db: null as null | Db,
  observations: [] as WakeObservation[],
}));
vi.mock("../services/issue-assignment-wakeup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issue-assignment-wakeup.js")>();
  return {
    ...actual,
    queueIssueAssignmentWakeup: (input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0]) => {
      const db = wakeProbe.db;
      if (db && input.issue) {
        void db.select({ stepRunId: workflowStepRuns.id }).from(workflowStepRuns)
          .where(eq(workflowStepRuns.issueId, input.issue.id)).limit(1)
          .then(([row]) => { wakeProbe.observations.push({ issueId: input.issue!.id, boundStepRunIdAtWake: row?.stepRunId ?? null }); })
          .catch(() => {});
      }
      return actual.queueIssueAssignmentWakeup(input);
    },
  };
});

describeQualityDb("Quality canonical — legacy semantics preserved", () => {
  let owned: QualityTestDb;
  let f: QualityFixture;
  beforeAll(async () => {
    owned = await createQualityTestDb();
    f = await seedQualityFixture(owned.db);
    wakeProbe.db = owned.db;
  }, 120_000);
  afterAll(async () => { await owned?.close(); });

  it("keeps original completed and cancelled mission domain rows identical across canonical binding", async () => {
    const db = owned.db;
    const cancelledMissionId = randomUUID();
    await db.insert(missions).values({ id: cancelledMissionId, companyId: f.companyId, ownerAgentId: f.authorAgentId, title: "cancelled source", status: "cancelled", completedAt: new Date() });
    const [cancelledIssue] = await db.insert(issues).values({ companyId: f.companyId, missionId: cancelledMissionId, title: "cancelled source issue", status: "cancelled" }).returning();
    const [cancelledRun] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.authorAgentId, issueId: cancelledIssue!.id, executionEpoch: 1 }).returning();

    const snapshot = async () => {
      const ms = await db.select().from(missions).where(eq(missions.companyId, f.companyId));
      const missionIds = new Set(ms.map((m) => m.id));
      const ws = await db.select().from(workflowRuns).where(eq(workflowRuns.companyId, f.companyId));
      const runIds = new Set(ws.map((w) => w.id));
      return {
        ms,
        is: await db.select().from(issues).where(eq(issues.companyId, f.companyId)),
        ws,
        ss: (await db.select().from(workflowStepRuns)).filter((s) => runIds.has(s.workflowRunId)),
        cs: await db.select().from(issueComments).where(eq(issueComments.companyId, f.companyId)),
        hs: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)),
        ts: await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, f.companyId)),
        ps: await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.companyId, f.companyId)),
        as: (await db.select().from(missionAgents)).filter((a) => missionIds.has(a.missionId)),
      };
    };
    const before = await snapshot();

    // 1) qa_addendum 정식 생성 — 원본(완료 fixture mission, 취소 mission) 행은 불변.
    const binding = await ensureCanonicalQualityExecution(db, { companyId: f.companyId, actionId: f.actionId });
    // 2) 취소 원본을 가리키는 current_output 조치 — 원본 유지로 거절, 어떤 원본 행도 바뀌지 않는다.
    const target = { kind: "current_output" as const, source: { companyId: f.companyId, issueId: cancelledIssue!.id, heartbeatRunId: cancelledRun!.id, executionEpoch: 1, inputHash: "ab".repeat(32), mission: { kind: "mission" as const, id: cancelledMissionId }, workflow: { kind: "not_applicable" as const, reason: "not_a_workflow_source" as const } } };
    const effect = { kind: "repair_supported_output" as const, target };
    const cancelledActionId = randomUUID();
    await db.insert(qualityActions).values({
      id: cancelledActionId, companyId: f.companyId, groupId: f.groupId, kind: "current_output",
      occurrenceSetHash: "21".repeat(32), occurrenceIds: [], policyVersionId: f.policyVersionId, scopeVersion: 1,
      target, targetHash: hashContract(target), effect, effectHash: hashContract(effect),
      retryEnvelope: { intentKey: `legacy-${cancelledActionId.slice(0, 8)}`, effectHash: hashContract(effect), targetHash: hashContract(target), maxExecutorAttempts: 2, deadlineAt: new Date(Date.now() + 3_600_000).toISOString(), groupId: f.groupId, policyVersionId: f.policyVersionId, maxCumulativeCostCents: 100 },
      revision: 1, state: "created", intentKey: `legacy-${cancelledActionId.slice(0, 8)}`,
    });
    await expect(ensureCanonicalQualityExecution(db, { companyId: f.companyId, actionId: cancelledActionId })).rejects.toMatchObject({ status: 409, message: "quality_source_preserved" });

    const after = await snapshot();
    const keep = <T extends { id: string }>(rows: T[], old: T[]) => rows.filter((row) => old.some((o) => o.id === row.id));
    expect(after.ms.length).toBe(before.ms.length + 1); // 새 quality mission 만 추가
    expect(keep(after.ms, before.ms)).toEqual(before.ms);
    expect(keep(after.is, before.is)).toEqual(before.is);
    expect(keep(after.ws, before.ws)).toEqual(before.ws);
    expect(keep(after.ss, before.ss)).toEqual(before.ss);
    expect(keep(after.cs, before.cs)).toEqual(before.cs);
    expect(keep(after.hs, before.hs)).toEqual(before.hs);
    expect(keep(after.ts, before.ts)).toEqual(before.ts);
    expect(keep(after.ps, before.ps)).toEqual(before.ps);
    expect(keep(after.as, before.as)).toEqual(before.as);
    expect(binding.missionId).not.toBe(f.sourceMissionId);
    expect(binding.missionId).not.toBe(cancelledMissionId);
  });

  it("keeps the general DAG path: wake fires during issue creation, before the step binding commits", async () => {
    const db = owned.db;
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `LegacyCo-${companyId.slice(0, 8)}`, issuePrefix: `LG${companyId.slice(0, 4)}` });
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Legacy Agent", role: "worker", status: "idle", adapterType: "process", adapterConfig: {} });
    await db.insert(missions).values({ id: randomUUID(), companyId, ownerAgentId: agentId, title: "legacy general mission", status: "active" });
    const stepId = `legacy-step-${randomUUID().slice(0, 6)}`;
    const wfId = randomUUID();
    const runId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "legacy-general-wf", stepsJson: [{ id: stepId, name: "General step", agentId, dependencies: [] }] });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });
    await db.insert(workflowStepRuns).values({ workflowRunId: runId, stepId, status: "pending" });

    const observationsBefore = wakeProbe.observations.length;
    await syncWorkflowRunState(db, runId, "workflow_sync");

    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    expect(stepRun!.issueId).not.toBeNull();
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(wakes.length).toBeGreaterThan(0);
    const [issue] = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, stepRun!.issueId!)));
    expect(issue!.originKind).toBe("workflow_execution");
    // 기존 의미 보존: 깨우는 시점에는 아직 step 연결이 커밋돼 있지 않다.
    const observed = wakeProbe.observations.slice(observationsBefore).find((o) => o.issueId === stepRun!.issueId);
    expect(observed).toBeDefined();
    expect(observed!.boundStepRunIdAtWake).toBeNull();
  });

  it("binds quality DAG step issues before waking (binding committed at wake time)", async () => {
    const db = owned.db;
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `QDagCo-${companyId.slice(0, 8)}`, issuePrefix: `QD${companyId.slice(0, 4)}` });
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Quality DAG Agent", role: "worker", status: "idle", adapterType: "process", adapterConfig: {} });
    const missionId = randomUUID();
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "quality dag mission", status: "active" });
    const stepId = `quality-execute-${randomUUID().slice(0, 6)}`;
    const wfId = randomUUID();
    const runId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "quality-dag-wf", sourceKind: "quality", stepsJson: [{ id: stepId, name: "Quality execution", agentId, dependencies: [] }] });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, missionId, status: "running", triggeredBy: "quality" });
    await db.insert(workflowStepRuns).values({ workflowRunId: runId, stepId, status: "pending" });

    const observationsBefore = wakeProbe.observations.length;
    await syncWorkflowRunState(db, runId, "workflow_sync");

    const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const stepRun = rows.find((row) => row.stepId === stepId)!;
    expect(stepRun.issueId).not.toBeNull();
    const [issue] = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, stepRun.issueId!)));
    expect(issue!.originKind).toBe("workflow_execution");
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(wakes.length).toBeGreaterThan(0);
    // 새 계약: 깨우는 시점에 issue+step 연결이 이미 커밋돼 있다.
    const observed = wakeProbe.observations.slice(observationsBefore).find((o) => o.issueId === stepRun.issueId);
    expect(observed).toBeDefined();
    expect(observed!.boundStepRunIdAtWake).toBe(stepRun.id);
    const [activity] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.created")));
    expect(activity).toBeDefined();
  });
});

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, missionAgentRuntimes, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  LIFECYCLE_STEP_ID,
  readMissionSessionStatus,
  readPlanArtifactStatus,
  readRuntimeRow,
  seedLifecycleMissionGraph,
  simulateResumeApply,
} from "./helpers/mission-resume-lifecycle-fixture.js";

// [계약 C/D/E 전용 파일] ensure resume-context 재부트스트랩, resume 라이프사이클 연결,
// stale idle 경로의 표식 보존. DB/엔진은 실 PG — mock 없음.
import {
  ensureMissionAgentRuntime,
  reapStaleBusyMissionRuntimes,
  stopMissionRuntimesForMission,
} from "../services/missions/mission-runtime-manager.js";
import { ensureResumeMissionRuntimes } from "../services/workflow/resume/mission-lifecycle.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping mission resume runtime ensure tests: ${embeddedPostgresSupport.reason ?? "unsupported host"}`);
}

describeEP("mission resume runtime ensure (contracts C/D/E)", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  // RawSql — postgres-js 클라이언트 그 자체(db.$client)로 raw 시딩/스탬핑에만 사용한다.
  let rawSql: Db["$client"];
  const NOW = new Date("2026-09-10T01:00:00.000Z");

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mission-resume-ensure-");
    db = createDb(tempDb.connectionString);
    rawSql = db.$client;
  }, 60_000);
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  it("C: ensure with resumeContext on stopped row forces re-bootstrap and records the resume marker", async () => {
    const graph = await seedLifecycleMissionGraph(rawSql, { prefix: "mrl-ensure-resume", missionStatus: "active" });
    const requestId = randomUUID();
    await stopMissionRuntimesForMission(db, {
      companyId: graph.companyId,
      missionId: graph.missionId,
      reason: "mission.completed",
      onlyRuntimeIds: [graph.ownerRuntimeId],
    });

    const result = await ensureMissionAgentRuntime(db, {
      companyId: graph.companyId,
      missionId: graph.missionId,
      agentId: graph.ownerAgentId,
      adapterType: "process",
      workspaceKey: "default",
      resumeContext: { resumeRequestId: requestId },
    });

    expect(result.bootstrapRequired).toBe(true);
    expect(result.runtime.contextInjectedAt).toBeNull();
    expect(result.runtime.stateJson.resumeRequestId).toBe(requestId);
    expect(result.runtime.stateJson.bootstrapContextInjected).toBe(false);
  });

  it("C: ensure without resumeContext keeps reusing the stopped row's injected context", async () => {
    const graph = await seedLifecycleMissionGraph(rawSql, { prefix: "mrl-ensure-plain", missionStatus: "active" });
    await stopMissionRuntimesForMission(db, {
      companyId: graph.companyId,
      missionId: graph.missionId,
      reason: "mission.completed",
      onlyRuntimeIds: [graph.ownerRuntimeId],
    });
    const before = await readRuntimeRow(db, graph.ownerRuntimeId);

    const result = await ensureMissionAgentRuntime(db, {
      companyId: graph.companyId,
      missionId: graph.missionId,
      agentId: graph.ownerAgentId,
      adapterType: "process",
      workspaceKey: "default",
    });

    expect(result.bootstrapRequired).toBe(false);
    expect(result.runtime.contextInjectedAt).toEqual(before?.contextInjectedAt ?? null);
    expect(result.runtime.stateJson.resumeRequestId).toBeUndefined();
  });

  it("D: resume reactivation lifecycle ensures runtimes only for affected-step owners/assignees with resume context", async () => {
    const graph = await seedLifecycleMissionGraph(rawSql, { prefix: "mrl-lifecycle", missionStatus: "active" });
    const requestId = randomUUID();
    // owner 런타임은 stopped(pre-resume context) 상태 — assignee 런타임은 아직 없음.
    await stopMissionRuntimesForMission(db, {
      companyId: graph.companyId,
      missionId: graph.missionId,
      reason: "mission.completed",
      onlyRuntimeIds: [graph.ownerRuntimeId],
    });
    const stoppedOwnerRow = await readRuntimeRow(db, graph.ownerRuntimeId);
    expect(stoppedOwnerRow?.status).toBe("stopped");
    // apply 흔 재현: run/step 스탬프 + appliedGenerations 가 담긴 요청/실행 행(미션은 이미 active).
    await simulateResumeApply(db, graph, {
      requestId,
      requestState: "accepted",
      executionState: "completed",
      reactivateMission: false,
    });

    const result = await ensureResumeMissionRuntimes(db, {
      companyId: graph.companyId,
      missionId: graph.missionId,
      workflowRunId: graph.runId,
      resumeRequestId: requestId,
    });

    expect(result.runStampMatched).toBe(true);
    expect(result.affectedStepIds).toEqual([LIFECYCLE_STEP_ID]);
    expect([...result.ensuredAgentIds].sort()).toEqual([graph.assigneeAgentId, graph.ownerAgentId].sort());
    expect(await readRuntimeRow(db, graph.ownerRuntimeId)).toEqual(stoppedOwnerRow);
    const ownerRows = await db.select().from(missionAgentRuntimes)
      .where(eq(missionAgentRuntimes.agentId, graph.ownerAgentId));
    expect(ownerRows).toHaveLength(2);
    const ownerRow = ownerRows.find((row) => row.stateJson.resumeRequestId === requestId);
    const workspaceKey = `resume-runtime:${JSON.stringify(["default", requestId])}`;
    expect(ownerRow?.id).toBeDefined();
    expect(ownerRow?.id).not.toBe(graph.ownerRuntimeId);
    expect(ownerRow?.stateJson.resumeRequestId).toBe(requestId);
    expect(ownerRow?.contextInjectedAt).toBeNull();
    expect(ownerRow?.sessionId).toBeNull();
    expect(ownerRow?.workspaceKey).toBe(workspaceKey);
    expect(ownerRow?.status).toBe("busy");
    const assigneeRows = await db.select().from(missionAgentRuntimes)
      .where(eq(missionAgentRuntimes.agentId, graph.assigneeAgentId));
    expect(assigneeRows).toHaveLength(1);
    expect(assigneeRows[0]?.stateJson.resumeRequestId).toBe(requestId);
    expect(assigneeRows[0]?.workspaceKey).toBe(workspaceKey);
    // 세션/플랜 부활 없음.
    expect(await readMissionSessionStatus(db, graph.missionSessionId)).toBe("active");
    expect(await readPlanArtifactStatus(db, graph.planArtifactId)).toBe("active");
  });

  it("D: stale lifecycle call (mismatched resumeRequestId) ensures nothing", async () => {
    const graph = await seedLifecycleMissionGraph(rawSql, { prefix: "mrl-lifecycle-stale", missionStatus: "active" });
    const requestId = randomUUID();
    await simulateResumeApply(db, graph, {
      requestId,
      requestState: "accepted",
      executionState: "completed",
      reactivateMission: false,
    });
    await stopMissionRuntimesForMission(db, {
      companyId: graph.companyId,
      missionId: graph.missionId,
      reason: "mission.completed",
      onlyRuntimeIds: [graph.ownerRuntimeId],
    });
    const before = await readRuntimeRow(db, graph.ownerRuntimeId);

    const result = await ensureResumeMissionRuntimes(db, {
      companyId: graph.companyId,
      missionId: graph.missionId,
      workflowRunId: graph.runId,
      resumeRequestId: randomUUID(),
    });

    expect(result.runStampMatched).toBe(false);
    expect(result.ensuredAgentIds).toEqual([]);
    const after = await readRuntimeRow(db, graph.ownerRuntimeId);
    expect(after?.status).toBe("stopped");
    expect(after?.stateJson.resumeRequestId).toBeUndefined();
    expect(after?.contextInjectedAt).toEqual(before?.contextInjectedAt ?? null);
  });

  it("E: stale busy reaper (idle path) must not clear the resume epoch marker on marked runtime rows", async () => {
    const graph = await seedLifecycleMissionGraph(rawSql, { prefix: "mrl-reap-marker", missionStatus: "active" });
    const requestId = randomUUID();
    const oldUpdatedAt = new Date(NOW.getTime() - 10 * 60 * 1000);
    await db.update(missionAgentRuntimes).set({
      status: "busy",
      stateJson: { resumeRequestId: requestId, bootstrapContextInjected: true },
      updatedAt: oldUpdatedAt,
    }).where(eq(missionAgentRuntimes.id, graph.ownerRuntimeId));
    // 런 종료: busy 뒷받침 run 없음.
    await rawSql`UPDATE heartbeat_runs SET status = 'completed' WHERE id = ${graph.heartbeatRunId}`;

    const result = await reapStaleBusyMissionRuntimes(db, { now: NOW, graceMs: 60_000 });

    expect(result.reaped.map((row) => row.runtimeId)).toContain(graph.ownerRuntimeId);
    const after = await readRuntimeRow(db, graph.ownerRuntimeId);
    expect(after?.status).toBe("idle");
    expect(after?.stateJson.resumeRequestId).toBe(requestId);
    expect(after?.stateJson.busyReaper).toBeTruthy();
  });

  it("E: reaper leaves unmarked ordinary rows byte-identical (no marker injected)", async () => {
    const graph = await seedLifecycleMissionGraph(rawSql, { prefix: "mrl-reap-plain", missionStatus: "active" });
    const oldUpdatedAt = new Date(NOW.getTime() - 10 * 60 * 1000);
    await db.update(missionAgentRuntimes).set({
      status: "busy",
      stateJson: { bootstrapContextInjected: true },
      updatedAt: oldUpdatedAt,
    }).where(eq(missionAgentRuntimes.id, graph.ownerRuntimeId));
    await rawSql`UPDATE heartbeat_runs SET status = 'completed' WHERE id = ${graph.heartbeatRunId}`;

    await reapStaleBusyMissionRuntimes(db, { now: NOW, graceMs: 60_000 });

    const after = await readRuntimeRow(db, graph.ownerRuntimeId);
    expect(after?.status).toBe("idle");
    expect(after?.stateJson.resumeRequestId).toBeUndefined();
  });
});

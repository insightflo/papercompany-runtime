import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  readHeartbeatRunStatus,
  readIssueStatus,
  readMissionSessionStatus,
  readPlanArtifactStatus,
  readRuntimeRow,
  seedLifecycleMissionGraph,
  setMissionStatus,
  simulateResumeApply,
  type LifecycleMissionGraph,
} from "./helpers/mission-resume-lifecycle-fixture.js";

// [mock 경계] 외부 프로세스 kill/네트워크 seam 만 주입 double 로 대체하고 DB/엔진은 실 PG 를 쓴다.
const cancelHeartbeatRun = vi.fn(async () => undefined);
const completeOpenMissionOversightIfSettled = vi.fn(async () => undefined);

import { runMissionTerminalCleanup } from "../services/missions/terminal-cleanup-fence.js";
import { stopMissionRuntimesForMission } from "../services/missions/mission-runtime-manager.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping mission resume lifecycle tests: ${embeddedPostgresSupport.reason ?? "unsupported host"}`);
}

describeEP("mission resume lifecycle (terminal cleanup fence + resume runtime ensure)", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  // RawSql — postgres-js 클라이언트 그 자체(db.$client)로 raw 시딩에만 사용한다.
  let rawSql: Db["$client"];
  const NOW = new Date("2026-09-10T01:00:00.000Z");

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mission-resume-lifecycle-");
    db = createDb(tempDb.connectionString);
    rawSql = db.$client;
  }, 60_000);
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  function fenceInput(graph: LifecycleMissionGraph, status: "completed" | "cancelled" = "completed") {
    return {
      companyId: graph.companyId,
      missionId: graph.missionId,
      status,
      now: NOW,
      completedAt: NOW,
      missionSnapshot: { ownerAgentId: graph.ownerAgentId, completedAt: null },
      cancelHeartbeatRun,
      completeOpenMissionOversightIfSettled,
    };
  }

  beforeEach(() => {
    // [격리] 주입 double 호출 기록을 테스트 간에 초기화한다(외부 seam mock — DB는 실 PG).
    cancelHeartbeatRun.mockClear();
    completeOpenMissionOversightIfSettled.mockClear();
  });

  it("A: stale terminal cleanup aborts with zero writes after resume reactivation", async () => {
    const graph = await seedLifecycleMissionGraph(rawSql, { prefix: "mrl-abort" });
    await setMissionStatus(db, graph, "cancelled");
    const requestId = randomUUID();
    await simulateResumeApply(db, graph, {
      requestId,
      requestState: "pending_delivery",
      executionState: "queued",
      reactivateMission: true,
    });

    const result = await runMissionTerminalCleanup(db, fenceInput(graph, "cancelled"));

    expect(result.aborted).toBe(true);
    expect(result.reason).toBe("resume_reactivated");
    expect(result.stoppedRuntimeIds).toEqual([]);
    expect(await readIssueStatus(db, graph.issueId)).toBe("in_progress");
    expect(await readHeartbeatRunStatus(db, graph.heartbeatRunId)).toBe("running");
    const runtime = await readRuntimeRow(db, graph.ownerRuntimeId);
    expect(runtime?.status).toBe("busy");
    expect(runtime?.contextInjectedAt).not.toBeNull();
    expect(await readPlanArtifactStatus(db, graph.planArtifactId)).toBe("active");
    expect(await readMissionSessionStatus(db, graph.missionSessionId)).toBe("active");
    expect(cancelHeartbeatRun).not.toHaveBeenCalled();
    expect(completeOpenMissionOversightIfSettled).not.toHaveBeenCalled();
  });

  it("A: same-epoch historical accepted/running rows do not block fresh terminal cleanup", async () => {
    const graph = await seedLifecycleMissionGraph(rawSql, { prefix: "mrl-abort-rows" });
    await setMissionStatus(db, graph, "cancelled");
    const requestId = randomUUID();
    await simulateResumeApply(db, graph, {
      requestId,
      requestState: "accepted",
      executionState: "running",
      reactivateMission: false,
    });

    const result = await runMissionTerminalCleanup(db, fenceInput(graph, "cancelled"));
    expect(result).toEqual({ aborted: false, reason: null, stoppedRuntimeIds: [graph.ownerRuntimeId] });
    expect(await readIssueStatus(db, graph.issueId)).toBe("cancelled");
    expect(await readHeartbeatRunStatus(db, graph.heartbeatRunId)).toBe("cancelled");
    expect((await readRuntimeRow(db, graph.ownerRuntimeId))?.status).toBe("stopped");
    expect(await readPlanArtifactStatus(db, graph.planArtifactId)).toBe("archived");
    expect(await readMissionSessionStatus(db, graph.missionSessionId)).toBe("closed");
  });

  it("A: blocked/cancelled resume rows do not fence ordinary terminal cleanup", async () => {
    const graph = await seedLifecycleMissionGraph(rawSql, { prefix: "mrl-dead-rows" });
    await setMissionStatus(db, graph, "cancelled");
    const requestId = randomUUID();
    await simulateResumeApply(db, graph, {
      requestId,
      requestState: "cancelled",
      executionState: "completed",
      reactivateMission: false,
    });

    const result = await runMissionTerminalCleanup(db, fenceInput(graph, "cancelled"));
    expect(result).toEqual({ aborted: false, reason: null, stoppedRuntimeIds: [graph.ownerRuntimeId] });
    expect(await readIssueStatus(db, graph.issueId)).toBe("cancelled");
    expect(await readHeartbeatRunStatus(db, graph.heartbeatRunId)).toBe("cancelled");
    expect((await readRuntimeRow(db, graph.ownerRuntimeId))?.status).toBe("stopped");
    expect(await readPlanArtifactStatus(db, graph.planArtifactId)).toBe("archived");
    expect(await readMissionSessionStatus(db, graph.missionSessionId)).toBe("closed");
  });

  it("A: cleanup without any resume rows proceeds exactly as today (ordinary terminal mission)", async () => {
    const graph = await seedLifecycleMissionGraph(rawSql, { prefix: "mrl-ordinary" });
    await setMissionStatus(db, graph, "cancelled");

    const result = await runMissionTerminalCleanup(db, fenceInput(graph, "cancelled"));

    expect(result).toEqual({ aborted: false, reason: null, stoppedRuntimeIds: [graph.ownerRuntimeId] });
    expect(await readIssueStatus(db, graph.issueId)).toBe("cancelled");
    expect(await readHeartbeatRunStatus(db, graph.heartbeatRunId)).toBe("cancelled");
    const runtime = await readRuntimeRow(db, graph.ownerRuntimeId);
    expect(runtime?.status).toBe("stopped");
    expect(runtime?.stopReason).toBe("mission.cancelled");
    expect(await readPlanArtifactStatus(db, graph.planArtifactId)).toBe("archived");
    expect(await readMissionSessionStatus(db, graph.missionSessionId)).toBe("closed");
    expect(cancelHeartbeatRun).not.toHaveBeenCalled();
  });

  it("A: mission without any workflow run keeps today's direct path (no serialization scope)", async () => {
    const graph = await seedLifecycleMissionGraph(rawSql, { prefix: "mrl-norun" });
    await setMissionStatus(db, graph, "cancelled");
    await rawSql`DELETE FROM workflow_runs WHERE id = ${graph.runId}`;

    const result = await runMissionTerminalCleanup(db, fenceInput(graph, "cancelled"));

    expect(result).toEqual({ aborted: false, reason: null, stoppedRuntimeIds: [graph.ownerRuntimeId] });
    expect(await readIssueStatus(db, graph.issueId)).toBe("cancelled");
    expect((await readRuntimeRow(db, graph.ownerRuntimeId))?.status).toBe("stopped");
  });

  it("B: onlyRuntimeIds stops captured ids only; runtime created after capture is untouched", async () => {
    const graph = await seedLifecycleMissionGraph(rawSql, { prefix: "mrl-only-ids", missionStatus: "active" });
    // 캡처 이후 생성될 두 번째 런타임(raw SQL — ensure 은 터미널 미션 게이트가 있어 여기선 부적절).
    const secondRuntimeId = randomUUID();
    await rawSql`
      INSERT INTO mission_agent_runtimes (id, company_id, mission_id, agent_id, adapter_type, runtime_key, status)
      VALUES (
        ${secondRuntimeId}, ${graph.companyId}, ${graph.missionId}, ${graph.assigneeAgentId}, 'process',
        ${`company:${graph.companyId}|mission:${graph.missionId}|agent:${graph.assigneeAgentId}|adapter:process|workspace:default`},
        'busy'
      )
    `;
    const captured = [graph.ownerRuntimeId];

    const stoppedCount = await stopMissionRuntimesForMission(db, {
      companyId: graph.companyId,
      missionId: graph.missionId,
      reason: "mission.completed",
      onlyRuntimeIds: captured,
    });

    expect(stoppedCount).toBe(1);
    expect((await readRuntimeRow(db, graph.ownerRuntimeId))?.status).toBe("stopped");
    expect((await readRuntimeRow(db, secondRuntimeId))?.status).toBe("busy");
  });

  it("B: stale (already stopped) id in onlyRuntimeIds is skipped safely and not double-stopped", async () => {
    const graph = await seedLifecycleMissionGraph(rawSql, { prefix: "mrl-stale-id" });
    const stoppedFirst = await stopMissionRuntimesForMission(db, {
      companyId: graph.companyId,
      missionId: graph.missionId,
      reason: "manual-stop",
      onlyRuntimeIds: [graph.ownerRuntimeId],
    });
    expect(stoppedFirst).toBe(1);
    const stoppedRow = await readRuntimeRow(db, graph.ownerRuntimeId);
    expect(stoppedRow?.status).toBe("stopped");

    const stoppedAgain = await stopMissionRuntimesForMission(db, {
      companyId: graph.companyId,
      missionId: graph.missionId,
      reason: "mission.completed",
      onlyRuntimeIds: [graph.ownerRuntimeId],
    });

    expect(stoppedAgain).toBe(0);
    const reread = await readRuntimeRow(db, graph.ownerRuntimeId);
    expect(reread?.status).toBe("stopped");
    expect(reread?.stopReason).toBe("manual-stop");
    expect(reread?.stoppedAt).toEqual(stoppedRow?.stoppedAt);
  });
});

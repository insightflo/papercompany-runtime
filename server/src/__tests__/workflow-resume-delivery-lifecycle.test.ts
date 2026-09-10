import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, missionAgentRuntimes, workflowRuns, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  LIFECYCLE_STEP_ID,
  readMissionSessionStatus,
  readPlanArtifactStatus,
  readRuntimeRow,
  seedLifecycleMissionGraph,
  simulateResumeApply,
} from "./helpers/mission-resume-lifecycle-fixture.js";
import { loadDeliveryExecution, loadDeliveryRequest } from "./helpers/workflow-resume-delivery-fixture.js";

// External-effect mocks only (agent wakeups). Dispatcher/ensure/sync run on real embedded PG.
const { heartbeatWakeup } = vi.hoisted(() => ({ heartbeatWakeup: vi.fn() }));
vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return { ...actual, heartbeatService: () => ({ wakeup: heartbeatWakeup }) };
});
vi.mock("../services/issue-assignment-wakeup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issue-assignment-wakeup.js")>();
  return {
    ...actual,
    queueIssueAssignmentWakeup: (input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0]) =>
      actual.queueIssueAssignmentWakeup({ ...input, heartbeat: { wakeup: heartbeatWakeup } }),
  };
});

// [목적] Task6d 프로덕션 연결 회귀 — dispatchAcceptedResumeWork 의 성공 전달이
//   ensureResumeMissionRuntimes(dispatcher → mission-workflow-lifecycle seam)를 실제로
//   호출하는지 증명한다. 영향 스텝 수행자+오너만, resumeRequestId 표식 + 재부트스트랩 경로.
import { dispatchAcceptedResumeWork } from "../services/workflow/resume/dispatcher.js";
import { stopMissionRuntimesForMission } from "../services/missions/mission-runtime-manager.js";
import { captureExecutionDefinition } from "../services/workflow/execution-definition.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping resume delivery lifecycle tests: ${embeddedPostgresSupport.reason ?? "unsupported host"}`);
}

describeEP("workflow resume delivery × mission lifecycle (dispatcher-side runtime ensure)", () => {
  let db: Db;
  // RawSql — postgres-js 클라이언트 그 자체(db.$client)로 raw 시딩에만 사용한다.
  let rawSql: Db["$client"];
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const NOW = new Date("2026-09-12T01:00:00.000Z");

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wf-resume-delivery-lifecycle-");
    db = createDb(tempDb.connectionString);
    rawSql = db.$client;
  }, 60_000);
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  it("successful dispatch ensures runtimes only for affected-step assignee+owner with resume markers and re-bootstrap", async () => {
    const graph = await seedLifecycleMissionGraph(rawSql, { prefix: "wrdl-ensure" });
    // raw 시딩 run 을 생성 시점 형태로 되돌려 실제 캡처 경로를 통과시킨다 —
    // dispatch 의 loadExecutionDefinition 은 스냅샷 없는 resume run 을 거부한다.
    await db.update(workflowRuns).set({
      status: "pending",
      startedAt: null,
      metadata: { executionDefinitionVersion: 1 },
    }).where(eq(workflowRuns.id, graph.runId));
    await db.transaction(async (tx) => {
      await captureExecutionDefinition(tx, graph.runId);
    });
    await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, graph.runId));
    // ensure 금지 후보: 같은 미션의 "다른 run" 에서 같은 stepId 를 담당하는 수행자 —
    // 영향 스텝 조회는 이 요청의 run 으로 스코프되므로 런타임이 만들어지면 안 된다.
    const thirdAgentId = randomUUID();
    const thirdIssueId = randomUUID();
    const secondRunId = randomUUID();
    await rawSql`INSERT INTO agents (id, company_id, name)
      VALUES (${thirdAgentId}, ${graph.companyId}, ${"Third " + graph.missionId})`;
    await rawSql`INSERT INTO issues (id, company_id, mission_id, title, status, assignee_agent_id, created_by_agent_id)
      VALUES (${thirdIssueId}, ${graph.companyId}, ${graph.missionId}, ${"Unaffected issue"}, 'in_progress', ${thirdAgentId}, ${graph.ownerAgentId})`;
    await rawSql`INSERT INTO workflow_runs (id, workflow_id, company_id, mission_id, status, dispatch_authority_version, triggered_by)
      VALUES (${secondRunId}, ${graph.workflowId}, ${graph.companyId}, ${graph.missionId}, 'running', 1, 'manual')`;
    await rawSql`INSERT INTO workflow_step_runs (id, workflow_run_id, step_id, issue_id, status, execution_generation)
      VALUES (${randomUUID()}, ${secondRunId}, ${LIFECYCLE_STEP_ID}, ${thirdIssueId}, 'pending', 1)`;
    // pre-resume 터미널 흔적: 미션 completed 정리로 오너 런타임이 stopped 된 상태(계약 A 경로).
    await stopMissionRuntimesForMission(db, {
      companyId: graph.companyId,
      missionId: graph.missionId,
      reason: "mission.completed",
    });
    // apply 흔: run/step 스탬프 + pending_delivery 요청/실행 + 미션 재활성(active).
    const requestId = randomUUID();
    await simulateResumeApply(db, graph, {
      requestId,
      requestState: "pending_delivery",
      executionState: "queued",
      reactivateMission: true,
    });

    const result = await dispatchAcceptedResumeWork(db, { now: NOW });

    // 전달 자체는 완결 — ensure 연결이 delivery 를 막지 않는다(accept 커밋 이후 실행).
    expect(result.acceptedCount).toBe(1);
    expect(result.completedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    const request = await loadDeliveryRequest(rawSql, requestId);
    expect(request?.state).toBe("accepted");
    const execution = await loadDeliveryExecution(rawSql, requestId);
    expect(execution?.state).toBe("completed");
    expect(execution?.completed_at).not.toBeNull();

    // 오너 런타임: pre-resume stopped 행은 재사용 금지(불변) — 재부트스트랩은
    // 새 resume-runtime 행으로 수행한다(mission-resume-runtime-ensure 계약 C와 동일).
    const stoppedOwnerRow = await readRuntimeRow(db, graph.ownerRuntimeId);
    expect(stoppedOwnerRow?.status).toBe("stopped");
    expect(stoppedOwnerRow?.contextInjectedAt).not.toBeNull();
    const resumeWorkspaceKey = `resume-runtime:${JSON.stringify(["default", requestId])}`;
    const ownerRows = await db.select().from(missionAgentRuntimes).where(and(
      eq(missionAgentRuntimes.companyId, graph.companyId),
      eq(missionAgentRuntimes.agentId, graph.ownerAgentId),
    ));
    expect(ownerRows).toHaveLength(2);
    const resumeOwnerRow = ownerRows.find((row) => row.workspaceKey === resumeWorkspaceKey);
    expect(resumeOwnerRow).toBeDefined();
    expect(resumeOwnerRow?.status).toBe("busy");
    expect(resumeOwnerRow?.contextInjectedAt).toBeNull();
    expect(resumeOwnerRow?.stateJson.resumeRequestId).toBe(requestId);
    expect(resumeOwnerRow?.stateJson.bootstrapContextInjected).toBe(false);
    expect(resumeOwnerRow?.sessionId).toBeNull();
    // 수행자 런타임: resume 문맥으로 새 생성 — 표식 + bootstrap required.
    const assigneeRows = await db.select().from(missionAgentRuntimes).where(and(
      eq(missionAgentRuntimes.companyId, graph.companyId),
      eq(missionAgentRuntimes.agentId, graph.assigneeAgentId),
    ));
    expect(assigneeRows).toHaveLength(1);
    expect(assigneeRows[0]?.workspaceKey).toBe(resumeWorkspaceKey);
    expect(assigneeRows[0]?.stateJson.resumeRequestId).toBe(requestId);
    expect(assigneeRows[0]?.stateJson.bootstrapContextInjected).toBe(false);
    // ONLY 오너+영향 스텝 수행자: 타 run 수행자 런타임 없음. 미션 런타임은 3행
    // (pre-resume stopped 오너 1 + resume-runtime 오너/수행자 각 1).
    const thirdRows = await db.select().from(missionAgentRuntimes)
      .where(eq(missionAgentRuntimes.agentId, thirdAgentId));
    expect(thirdRows).toHaveLength(0);
    const missionRuntimeRows = await db.select().from(missionAgentRuntimes)
      .where(eq(missionAgentRuntimes.missionId, graph.missionId));
    expect(missionRuntimeRows).toHaveLength(3);
    expect(missionRuntimeRows.filter((row) => row.agentId === graph.ownerAgentId)).toHaveLength(2);
    expect(missionRuntimeRows.filter((row) => row.agentId === graph.assigneeAgentId)).toHaveLength(1);
    // 세션/플랜 부활 없음(계약 D 불변).
    expect(await readMissionSessionStatus(db, graph.missionSessionId)).toBe("active");
    expect(await readPlanArtifactStatus(db, graph.planArtifactId)).toBe("active");
  });
});

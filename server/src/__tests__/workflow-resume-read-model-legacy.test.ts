import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { readResumeExecutionHistory } from "../services/workflow/resume/read-model.js";
import {
  cleanupReadModelTables,
  readModelScope,
  seedReadModelGraph,
  seedReadModelIssue,
  seedReadModelStepRun,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-resume-read-model-fixture.js";

/**
 * [purpose] Task5c2b — legacy JSON-only history association discovery. Rows whose typed queue
 *   columns are all NULL but whose agent_wakeup_requests.payload / heartbeat_runs.context_snapshot
 *   top-level JSON string keys (missionId/workflowRunId/workflowStepRunId/issueId/taskId/taskKey)
 *   exactly reference scoped ids must be discovered by the public reader, with raw rows, statuses,
 *   generations and JSON preserved. Tests call public readResumeExecutionHistory only — real
 *   embedded Postgres, real INSERT seeds, no mocks.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEP("readResumeExecutionHistory — legacy JSON-only associations", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("resume-read-model-legacy-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = createDb(fixture.connectionString);
  }, 60_000);

  afterEach(async () => {
    await cleanupReadModelTables(db);
  });

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  /** typed 연관 컬럼은 명시적으로만 채운다(미지정 시 NULL). payload 는 그대로 INSERT. */
  async function insertLegacyWakeup(input: {
    companyId: string;
    agentId: string;
    payload: unknown;
    status?: string;
    generation?: number;
    typedMissionId?: string;
    typedWorkflowRunId?: string;
    typedStepRunId?: string;
    typedIssueId?: string;
  }): Promise<string> {
    const [row] = await db.insert(agentWakeupRequests).values({
      companyId: input.companyId,
      agentId: input.agentId,
      source: "legacy-json-test",
      reason: "legacy-json-test",
      status: input.status ?? "queued",
      payload: input.payload as Record<string, unknown> | null,
      ...(input.generation !== undefined ? { workflowExecutionGeneration: input.generation } : {}),
      ...(input.typedMissionId !== undefined ? { missionId: input.typedMissionId } : {}),
      ...(input.typedWorkflowRunId !== undefined ? { workflowRunId: input.typedWorkflowRunId } : {}),
      ...(input.typedStepRunId !== undefined ? { workflowStepRunId: input.typedStepRunId } : {}),
      ...(input.typedIssueId !== undefined ? { issueId: input.typedIssueId } : {}),
    }).returning();
    return row!.id;
  }

  /** typed 연관 컬럼은 명시적으로만 채운다(미지정 시 NULL). contextSnapshot 을 그대로 INSERT. */
  async function insertLegacyHeartbeat(input: {
    companyId: string;
    agentId: string;
    contextSnapshot: unknown;
    status?: string;
    generation?: number;
    typedStepRunId?: string;
    typedIssueId?: string;
    typedWakeupRequestId?: string;
  }): Promise<string> {
    const [row] = await db.insert(heartbeatRuns).values({
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status ?? "succeeded",
      contextSnapshot: input.contextSnapshot as Record<string, unknown> | null,
      ...(input.generation !== undefined ? { workflowExecutionGeneration: input.generation } : {}),
      ...(input.typedStepRunId !== undefined ? { workflowStepRunId: input.typedStepRunId } : {}),
      ...(input.typedIssueId !== undefined ? { issueId: input.typedIssueId } : {}),
      ...(input.typedWakeupRequestId !== undefined ? { wakeupRequestId: input.typedWakeupRequestId } : {}),
    }).returning();
    return row!.id;
  }

  /** frozen 2-step graph + mission-linked known issue + 전체 step run 행(1:1). */
  async function seedGraphWithIssueAndSteps() {
    const graph = await seedReadModelGraph(fixture.sql, db);
    const knownIssueId = await seedReadModelIssue(db, {
      companyId: graph.companyId, missionId: graph.missionId,
    });
    const stepRunIds: string[] = [];
    for (const stepId of graph.definitionStepIds) {
      stepRunIds.push(await seedReadModelStepRun(db, { runId: graph.runId, stepId }));
    }
    return { graph, knownIssueId, stepRunIds };
  }

  /** [Task5c2b-fix1] 공개 reader 호출은 전부 실제 REPEATABLE READ READ ONLY 트랜잭션 안에서 실행한다. */
  function readHistory(scope: Parameters<typeof readResumeExecutionHistory>[1]) {
    return db.transaction((tx) => readResumeExecutionHistory(tx, scope), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
  }

  const SIX_KEYS = ["missionId", "workflowRunId", "workflowStepRunId", "issueId", "taskId", "taskKey"] as const;

  /** 매트릭스용: key 하나만 담은 legacy JSON — 참조값은 scope 의 실제 id. */
  function legacyJsonFor(
    key: string,
    refs: { missionId: string; runId: string; stepRunId: string; issueId: string },
  ): Record<string, unknown> {
    switch (key) {
      case "missionId": return { missionId: refs.missionId };
      case "workflowRunId": return { workflowRunId: refs.runId };
      case "workflowStepRunId": return { workflowStepRunId: refs.stepRunId };
      case "issueId": return { issueId: refs.issueId };
      case "taskId": return { taskId: refs.issueId };
      default: return { taskKey: refs.issueId };
    }
  }

  it("discovers all six legacy JSON keys for wake and heartbeat rows with every typed association column NULL", async () => {
    const { graph, knownIssueId, stepRunIds } = await seedGraphWithIssueAndSteps();
    const refs = { missionId: graph.missionId, runId: graph.runId, stepRunId: stepRunIds[0]!, issueId: knownIssueId };
    const wakeIds: string[] = [];
    const heartbeatIds: string[] = [];
    for (const key of SIX_KEYS) {
      wakeIds.push(await insertLegacyWakeup({
        companyId: graph.companyId, agentId: graph.agentId, payload: legacyJsonFor(key, refs),
      }));
      heartbeatIds.push(await insertLegacyHeartbeat({
        companyId: graph.companyId, agentId: graph.agentId, contextSnapshot: legacyJsonFor(key, refs),
      }));
    }

    const result = await readHistory(readModelScope(graph, graph.definitionStepIds[0]!));

    // 정확한 기대 집합: JSON-only 행 전부 + 그 외 없음. reader 의 id ASC 실제 순서를 sort 로 가리지 않고 그대로 단정.
    expect(result.wakeups.map((row) => row.id)).toEqual([...wakeIds].sort());
    expect(result.heartbeats.map((row) => row.id)).toEqual([...heartbeatIds].sort());
    // full JSON 보존 — 각 행의 payload/contextSnapshot 이 변형 없이 그대로.
    SIX_KEYS.forEach((key, index) => {
      const wakeRow = result.wakeups.find((row) => row.id === wakeIds[index])!;
      expect(wakeRow.payload).toEqual(legacyJsonFor(key, refs));
      const heartbeatRow = result.heartbeats.find((row) => row.id === heartbeatIds[index])!;
      expect(heartbeatRow.contextSnapshot).toEqual(legacyJsonFor(key, refs));
    });
    // known issue 는 mission-linked 로 기존 경로에서도 반환된다.
    expect(result.issues.map((row) => row.id)).toEqual([knownIssueId]);
  }, 30_000);

  it("preserves generation 0 / prior generation / unknown terminal / active statuses and full JSON on legacy rows", async () => {
    const { graph } = await seedGraphWithIssueAndSteps();
    const gen0Wakeup = await insertLegacyWakeup({
      companyId: graph.companyId, agentId: graph.agentId, generation: 0,
      payload: { missionId: graph.missionId, note: "gen0", nested: { deep: [1, "two", null] } },
    });
    const priorHeartbeat = await insertLegacyHeartbeat({
      companyId: graph.companyId, agentId: graph.agentId, generation: 7,
      contextSnapshot: { missionId: graph.missionId, taskKey: "legacy-key", issueId: null, extra: { kept: true } },
    });
    const unknownTerminalHeartbeat = await insertLegacyHeartbeat({
      companyId: graph.companyId, agentId: graph.agentId, status: "mystery_terminal_unknown",
      contextSnapshot: { missionId: graph.missionId },
    });
    const activeHeartbeat = await insertLegacyHeartbeat({
      companyId: graph.companyId, agentId: graph.agentId, status: "running", generation: 2,
      contextSnapshot: { missionId: graph.missionId },
    });

    const result = await readHistory(readModelScope(graph, graph.definitionStepIds[0]!));

    expect(result.wakeups.map((row) => row.id)).toEqual([gen0Wakeup]);
    // actual 정렬을 숨기지 않는다 — reader 의 id ASC 순서를 그대로 단정하고, 기대 배열만 정렬한다.
    expect(result.heartbeats.map((row) => row.id))
      .toEqual([priorHeartbeat, unknownTerminalHeartbeat, activeHeartbeat].sort());
    // generation 0 은 falsy 취급되지 않고 raw 로 보존.
    const gen0Row = result.wakeups.find((row) => row.id === gen0Wakeup)!;
    expect(gen0Row.workflowExecutionGeneration).toBe(0);
    expect(gen0Row.status).toBe("queued");
    expect(gen0Row.payload).toEqual({ missionId: graph.missionId, note: "gen0", nested: { deep: [1, "two", null] } });
    const priorRow = result.heartbeats.find((row) => row.id === priorHeartbeat)!;
    expect(priorRow.workflowExecutionGeneration).toBe(7);
    expect(priorRow.contextSnapshot).toEqual({
      missionId: graph.missionId, taskKey: "legacy-key", issueId: null, extra: { kept: true },
    });
    // 미지 terminal status / 활성 status 도 필터 없이 raw 보존.
    expect(result.heartbeats.find((row) => row.id === unknownTerminalHeartbeat)!.status).toBe("mystery_terminal_unknown");
    expect(result.heartbeats.find((row) => row.id === activeHeartbeat)!.status).toBe("running");
  }, 30_000);

  it("links a heartbeat discovered only through a JSON-discovered wakeup via wakeupRequestId (no other association)", async () => {
    const { graph } = await seedGraphWithIssueAndSteps();
    const jsonOnlyWakeup = await insertLegacyWakeup({
      companyId: graph.companyId, agentId: graph.agentId, payload: { missionId: graph.missionId },
    });
    const linkedHeartbeat = await insertLegacyHeartbeat({
      companyId: graph.companyId, agentId: graph.agentId,
      contextSnapshot: null, typedWakeupRequestId: jsonOnlyWakeup,
    });

    const result = await readHistory(readModelScope(graph, graph.definitionStepIds[0]!));

    expect(result.wakeups.map((row) => row.id)).toEqual([jsonOnlyWakeup]);
    // 기존 코드 경로: JSON 으로 새로 발견된 wakeup id 가 wakeupRequestId 링크에 자동 참여.
    expect(result.heartbeats.map((row) => row.id)).toEqual([linkedHeartbeat]);
    expect(result.heartbeats[0]!.wakeupRequestId).toBe(jsonOnlyWakeup);
    expect(result.heartbeats[0]!.contextSnapshot).toBeNull();
  }, 30_000);
});

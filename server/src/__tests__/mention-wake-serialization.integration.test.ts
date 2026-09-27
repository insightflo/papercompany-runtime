import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentKbGrants,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  assets,
  companies,
  companySecrets,
  companySecretVersions,
  companySkills,
  costEvents,
  createDb,
  documents,
  documentRevisions,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueWorkProducts,
  issues,
  knowledgeBases,
  qualityReviewItems,
  toolDefinitions,
  workflowTransitionEvents,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// [mention-wake serialization] 코멘트-멘션 우회 깨움의 런 입장이 잠긴 경로와 같은
// 직렬화 객체(이슈 행 FOR UPDATE + withTxTimeout) 아래에서 실행되는지 검증한다.
// 어댑터 execute 는 영원히 이행되지 않는 프라미스로 묶는다 — 입장(admission) 단계의
// 런 생성/coalesce/체크아웃 여부만 검증 대상이고, 실행 사이드 이펙트(클로즈아웃 등)를
// 테스트에서 배제하기 위해서다. 타이밍 인위 조작은 하지 않고 실제 Promise.all 병렬
// 입장으로 경쟁을 유발한다.

const executeSpy = vi.fn();

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({
    supportsLocalAgentJwt: false,
    execute: executeSpy,
  })),
  runningProcesses: new Map(),
}));

import { heartbeatService } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

function readJson<T = Record<string, unknown>>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return (value ?? {}) as T;
}

describeDb("mention-wake admission serialization", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let companyId: string;
  let assigneeId: string;
  let mentionedId: string;
  let issueId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("mention-wake-serialization-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    executeSpy.mockImplementation(() => new Promise(() => {}));
  }, 60_000);
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });
  beforeEach(async () => {
    // 드레인: 광둥 실행(영구 헹 프라미스)을 실패 종결로 표시하고 뒤늦은 기록 흡수 창을 둔다.
    await db
      .update(heartbeatRuns)
      .set({ status: "failed", finishedAt: new Date(), error: "test-teardown-drain" })
      .where(inArray(heartbeatRuns.status, ["queued", "running"]));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await db.delete(activityLog);
    await db.delete(workflowTransitionEvents);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(executionWorkspaces);
    await db.delete(workspaceRuntimeServices);
    await db.delete(issueWorkProducts);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(qualityReviewItems);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentKbGrants);
    await db.delete(knowledgeBases);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(agentTaskSessions);
    await db.delete(agentRuntimeState);
    await db.delete(toolDefinitions);
    await db.delete(companySkills);
    await db.delete(assets);
    await db.delete(agents);
    await db.delete(companies);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Mention Co", issuePrefix: `M${companyId.slice(0, 4)}` });
    assigneeId = randomUUID();
    await db.insert(agents).values({ id: assigneeId, companyId, name: "Assignee Agent", status: "active" });
    mentionedId = randomUUID();
    await db.insert(agents).values({ id: mentionedId, companyId, name: "Mentioned Agent", status: "active" });
    issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Mention work",
      status: "open",
      assigneeAgentId: assigneeId,
    });
  });

  function mentionWake(commentId: string) {
    return {
      source: "automation" as const,
      triggerDetail: "system" as const,
      reason: "issue_comment_mentioned",
      payload: { issueId, commentId },
      requestedByActorType: "operator",
      requestedByActorId: "op-1",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId,
        wakeCommentId: commentId,
        wakeReason: "issue_comment_mentioned",
        source: "comment.mention",
      },
    };
  }

  function normalIssueWake() {
    return {
      source: "automation" as const,
      triggerDetail: "system" as const,
      reason: "issue_status_changed",
      payload: { issueId },
      requestedByActorType: "operator",
      requestedByActorId: "op-1",
      contextSnapshot: { issueId, source: "issue.status_change" },
    };
  }

  async function runsFor(agentId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.issueId, issueId)));
  }

  it("(a) 동일 이슈 멘션 깨움 2건 동시 입장 → 런 중복 없음(병합 또는 직렬화된 별개 세대)", async () => {
    const [first, second] = await Promise.all([
      heartbeat.wakeup(mentionedId, mentionWake("comment-1")),
      heartbeat.wakeup(mentionedId, mentionWake("comment-2")),
    ]);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    const runs = await runsFor(mentionedId);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs.length).toBeLessThanOrEqual(2);

    const generations = runs
      .map((run) => readJson(run.contextSnapshot).dispatchGeneration)
      .sort((a, b) => Number(a) - Number(b));
    // 직렬화 계약: 같은 앵커(에이전트+이슈)로 동시 입장한 런은 서로 다른 세대를 받는다.
    expect(new Set(generations).size).toBe(generations.length);

    if (runs.length === 1) {
      // 두 번째 깨움이 첫 런에 coalesce 된 경우: coalesced 원문 행이 첫 런에 묶여 있어야 한다.
      const coalescedRows = await db
        .select()
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, mentionedId),
          eq(agentWakeupRequests.status, "coalesced"),
        ));
      expect(coalescedRows.length).toBe(1);
      expect(coalescedRows[0]?.runId).toBe(runs[0]?.id);
    } else {
      // 직렬화된 2세대로 입장한 경우: 세대는 정확히 1, 2여야 한다(경쟁 중복 입장 금지).
      expect(generations).toEqual([1, 2]);
    }
  });

  it("(b) 멘션 × 일반 이슈 깨움 동시 입장 → 양쪽 정상, 이슈 체크아웃은 입장된 런 중 하나로만", async () => {
    const [, mentionRun] = await Promise.all([
      heartbeat.wakeup(assigneeId, normalIssueWake()),
      heartbeat.wakeup(mentionedId, mentionWake("comment-1")),
    ]);
    expect(mentionRun).not.toBeNull();

    // 멘션 쪽은 항상 정확히 1개의 런으로 입장한다.
    const mentionRuns = await runsFor(mentionedId);
    expect(mentionRuns.length).toBe(1);

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue).toBeTruthy();

    const assigneeRuns = await runsFor(assigneeId);
    const deferredRows = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.agentId, assigneeId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"),
      ));

    // 일반 깨움은 정확히 하나의 정상 경로를 밟는다: 실행권 확보(러닝 런) 또는 대기(deferred).
    expect(assigneeRuns.length + deferredRows.length).toBe(1);

    const admittedRunIds = new Set([mentionRuns[0]?.id, ...assigneeRuns.map((run) => run.id)]);
    expect(admittedRunIds.has(issue.executionRunId ?? "")).toBe(true);

    if (assigneeRuns.length === 1) {
      // 일반 깨움이 먼저 입장한 경우: 체크아웃+in_progress 는 일반 경로가 수행한다.
      expect(issue.executionRunId).toBe(assigneeRuns[0]?.id);
      expect(issue.status).toBe("in_progress");
      expect(issue.executionLockedAt).not.toBeNull();
    } else {
      // 멘션 런이 먼저 입장한 경우: 기존 정책대로 일반 깨움이 그 런을 채택해 대기한다(멘션 경로 자체는 체크아웃을 쓰지 않음).
      expect(issue.executionRunId).toBe(mentionRuns[0]?.id);
    }
  });

  it("(c) 멘션 런 입장은 issues.execution* 필드를 갱신하지 않는다", async () => {
    const run = await heartbeat.wakeup(mentionedId, mentionWake("comment-1"));
    expect(run).not.toBeNull();

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue).toBeTruthy();
    expect(issue.executionRunId).toBeNull();
    expect(issue.executionLockedAt).toBeNull();
    expect(issue.executionAgentNameKey).toBeNull();
    expect(issue.checkoutRunId).toBeNull();
    expect(issue.status).toBe("open");

    const [runRow] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    expect(runRow).toBeTruthy();
    const context = readJson(runRow!.contextSnapshot);
    expect(context.dispatchGeneration).toBe(1);
    expect(context.wakeReason).toBe("issue_comment_mentioned");
    expect(context.wakeCommentId).toBe("comment-1");

    const [wakeRow] = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.runId, run!.id)));
    expect(wakeRow).toBeTruthy();
    expect(wakeRow!.status).not.toBe("coalesced");
  });
});

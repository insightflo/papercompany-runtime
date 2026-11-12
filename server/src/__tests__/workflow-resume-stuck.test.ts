import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, heartbeatRuns, issues, workflowStepRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import {
  applySigner,
  resetReviewedPolicies,
  seedResumeApplyScenario,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
  type RawSql,
} from "./helpers/workflow-resume-apply-fixture.js";
import {
  isStepRunStuck,
  STUCK_INACTIVITY_THRESHOLD_MINUTES,
} from "../services/workflow/resume/preview-facts.js";
import type { ResumeWorkspaceMissionHistory } from "../services/workflow/resume/read-model-workspaces.js";
import { previewResume } from "../services/workflow/resume/preview.js";

/** [목적] 결함-4 수정 검증 — running 스텝의 'stuck' 판정(임계 무활동 + 종말 이력) 경계와
 *  fail-closed 가드, 그리고 stuck 만으로 살아있는 run 에서 resume preview 가 열리는지 증명. */

vi.mock("../services/workflow/resume/reviewed-policy.js", async () => {
  const helper = await import("./helpers/workflow-resume-apply-fixture.js");
  return { REVIEWED_RESUME_POLICIES: helper.TEST_REVIEWED_POLICIES };
});

const NOW = new Date("2026-09-08T01:00:00.000Z");
const THRESHOLD_MS = STUCK_INACTIVITY_THRESHOLD_MINUTES * 60_000;

type HbLike = { id: string; status: string; workflowStepRunId?: string | null; finishedAt?: Date | null; updatedAt?: Date };
type WakeLike = { id: string; status: string; workflowStepRunId?: string | null };

function historyOf(heartbeats: HbLike[], wakeups: WakeLike[] = []): ResumeWorkspaceMissionHistory {
  return { history: { heartbeats, wakeups } } as unknown as ResumeWorkspaceMissionHistory;
}

function runningRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "step-run-1",
    status: "running",
    dispatchOwnerWakeupRequestId: null as string | null,
    dispatchOwnerHeartbeatRunId: null as string | null,
    ...overrides,
  };
}

function boundHb(overrides: Partial<HbLike> = {}): HbLike {
  return {
    id: "hb-1",
    status: "failed",
    workflowStepRunId: "step-run-1",
    finishedAt: new Date(NOW.getTime() - THRESHOLD_MS - 60_000),
    updatedAt: new Date(NOW.getTime() - THRESHOLD_MS - 60_000),
    ...overrides,
  };
}

const stuck = (row: ReturnType<typeof runningRow>, heartbeats: HbLike[], wakeups: WakeLike[] = [], now = NOW) =>
  isStepRunStuck(row, historyOf(heartbeats, wakeups), { now });

describe("isStepRunStuck — threshold boundary", () => {
  it("is false below, false exactly at, true beyond the inactivity threshold", () => {
    const row = runningRow();
    const hb = (msAgo: number) => boundHb({ finishedAt: new Date(NOW.getTime() - msAgo) });
    expect(stuck(row, [hb(THRESHOLD_MS - 1)])).toBe(false);
    expect(stuck(row, [hb(THRESHOLD_MS)])).toBe(false);
    expect(stuck(row, [hb(THRESHOLD_MS + 1)])).toBe(true);
  });

  it("uses the latest bound heartbeat when several exist", () => {
    const row = runningRow();
    expect(stuck(row, [
      boundHb({ id: "hb-old", finishedAt: new Date(NOW.getTime() - 2 * THRESHOLD_MS) }),
      boundHb({ id: "hb-new", finishedAt: new Date(NOW.getTime() - 1000), status: "failed" }),
    ])).toBe(false);
  });

  it("falls back to updatedAt when finishedAt is null", () => {
    expect(stuck(runningRow(), [boundHb({ finishedAt: null })])).toBe(true);
  });
});

describe("isStepRunStuck — fail-closed guards", () => {
  it("is false for non-running statuses", () => {
    for (const status of ["pending", "failed", "skipped", "completed"]) {
      expect(stuck(runningRow({ status }), [boundHb()])).toBe(false);
    }
  });

  it("is false when no heartbeat is bound to the step run", () => {
    expect(stuck(runningRow(), [])).toBe(false);
    expect(stuck(runningRow(), [boundHb({ workflowStepRunId: "other-step" })])).toBe(false);
  });

  it("is false while any bound heartbeat is non-terminal", () => {
    for (const status of ["queued", "running", "claimed"]) {
      expect(stuck(runningRow(), [boundHb({ status })])).toBe(false);
    }
  });

  it("is false while a bound wakeup is live, and true when it is terminal", () => {
    expect(stuck(runningRow(), [boundHb()], [{ id: "w-1", status: "queued", workflowStepRunId: "step-run-1" }])).toBe(false);
    expect(stuck(runningRow(), [boundHb()], [{ id: "w-1", status: "failed", workflowStepRunId: "step-run-1" }])).toBe(true);
  });

  it("is false when owner refs point at live or unproven records", () => {
    // 오너 웨이크업 참조가 수집 집합에 없음 → 종말 증명 불가.
    expect(stuck(runningRow({ dispatchOwnerWakeupRequestId: "w-missing" }), [boundHb()])).toBe(false);
    // 오너 웨이크업 참조가 live.
    expect(stuck(
      runningRow({ dispatchOwnerWakeupRequestId: "w-live" }),
      [boundHb()],
      [{ id: "w-live", status: "claimed" }],
    )).toBe(false);
    // 오너 하트비트 참조가 수집 집합에 없음.
    expect(stuck(runningRow({ dispatchOwnerHeartbeatRunId: "hb-missing" }), [boundHb()])).toBe(false);
    // 오너 참조가 종말 → residue 일 뿐 stuck 판정을 막지 않는다.
    expect(stuck(
      runningRow({ dispatchOwnerWakeupRequestId: "w-dead", dispatchOwnerHeartbeatRunId: "hb-1" }),
      [boundHb()],
      [{ id: "w-dead", status: "cancelled" }],
    )).toBe(true);
  });
});

// ── embedded preview: run running + stuck step + dead issue refs → eligible ──

const describeEmbeddedPostgres = (await getEmbeddedPostgresTestSupport()).supported ? describe : describe.skip;

describeEmbeddedPostgres("resume preview — stuck running step", () => {
  let fixture: ExecutionDefinitionFixture;
  let db: Db;
  let sql: RawSql;

  beforeAll(async () => {
    fixture = await startExecutionDefinitionFixture("resume-stuck-");
    if (!fixture.supported) throw new Error(fixture.reason);
    db = fixture.db;
    sql = fixture.sql;
  }, 60_000);
  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });
  beforeEach(() => {
    resetReviewedPolicies();
  });

  it("opens preview for a run kept 'running' only by a stuck step; blocks again under threshold", async () => {
    const scenario = await seedResumeApplyScenario(db, sql, "stuck-run-", {
      missionStatus: "active",
      runStatus: "running",
    });
    const [issue] = await db.insert(issues).values({
      companyId: scenario.companyId,
      missionId: scenario.missionId,
      title: "Stuck step issue",
      status: "in_progress",
      assigneeAgentId: scenario.agentId,
    }).returning();
    const [wakeup] = await db.insert(agentWakeupRequests).values({
      companyId: scenario.companyId,
      agentId: scenario.agentId,
      source: "workflow.dispatch",
      status: "failed",
      workflowStepRunId: scenario.stepRunIds.redo,
    }).returning();
    const [hb] = await db.insert(heartbeatRuns).values({
      companyId: scenario.companyId,
      agentId: scenario.agentId,
      status: "failed",
      startedAt: new Date(NOW.getTime() - THRESHOLD_MS - 600_000),
      finishedAt: new Date(NOW.getTime() - THRESHOLD_MS - 300_000),
      error: "HTTP 429",
      issueId: issue!.id,
      workflowStepRunId: scenario.stepRunIds.redo,
    }).returning();
    await db.update(workflowStepRuns).set({
      status: "running",
      issueId: issue!.id,
      startedAt: new Date(NOW.getTime() - THRESHOLD_MS - 600_000),
      dispatchOwnerWakeupRequestId: wakeup!.id,
      dispatchOwnerHeartbeatRunId: hb!.id,
    }).where(eq(workflowStepRuns.id, scenario.stepRunIds.redo));

    const scope = {
      companyId: scenario.companyId,
      missionId: scenario.missionId,
      workflowRunId: scenario.runId,
      startStepId: "gate",
    };
    const eligible = await previewResume(db, scope, applySigner(NOW));
    expect(eligible.preview.eligible).toBe(true);
    expect(eligible.preview.token).toBeTruthy();

    // 임계 미만의 활동은 stuck 아님 — 같은 씨드에서 프리뷰는 다시 닫힌다.
    await db.update(heartbeatRuns).set({ finishedAt: new Date(NOW.getTime() - 60_000) })
      .where(eq(heartbeatRuns.id, hb!.id));
    const blocked = await previewResume(db, scope, applySigner(NOW));
    expect(blocked.preview.eligible).toBe(false);
    expect(blocked.preview.blockers.some((b) => b.code === "active_work" || b.code === "unsupported_status")).toBe(true);
  });
});

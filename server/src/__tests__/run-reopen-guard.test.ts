// [purpose] run-reopen-guard v1 (PR-2a) 통합 테스트 — 종결 run 재오픈 경로 차단을 임베디드 PG 로 검증한다.
//   1) 재계산 부활 차단(dag-engine)  2) 수동 resume 거부/CAS/권한버전 범프(workflow-store)
//   3) 이슈 없는 재시도 run 재오픈 CAS(retry-issue-less-manual)  4) 인스턴트 어드밴스 종결 no-op.
//   기존 테스트 파일은 수정하지 않는다.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  createDb,
  instanceSettings,
  issues,
  workflowStepRuns,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupTerminalBoundaryTables } from "./helpers/run-terminal-boundary-fixture.js";
import { seedBoundaryIntegrationRun } from "./helpers/run-terminal-boundary-integration-fixtures.js";
import {
  callIssueLessRetry,
  refusalsOf,
  runOf,
  setRunReopenGuardFlag,
} from "./helpers/run-reopen-guard-fixture.js";

// vi.hoisted: ESM 임포트 해석 중 mock factory 실행 — boundary integration 테스트와 동일 주입 패턴.
const { heartbeatWakeup, executeWorkflowRunMock } = vi.hoisted(() => ({
  heartbeatWakeup: vi.fn(),
  executeWorkflowRunMock: vi.fn(),
}));
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
// instant-advance 의 평가 대상만 교체한다. dag-engine 이 같은 모듈을 재노출하므로 나머지는 실제 구현 유지.
vi.mock("../services/workflow/workflow-run-execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/workflow/workflow-run-execution.js")>();
  return { ...actual, executeWorkflowRun: executeWorkflowRunMock };
});

import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import {
  configureInstantWorkflowAdvanceDb,
  reopenGuardJudgementForTests,
  requestInstantWorkflowAdvance,
  resetInstantWorkflowAdvanceForTests,
} from "../services/workflow/instant-advance.js";
import { resumeWorkflowRun } from "../services/workflow/workflow-store.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping run-reopen-guard integration tests: ${support.reason ?? "unsupported host"}`);
}

describeEP("run-reopen-guard v1", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("run-reopen-guard-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    heartbeatWakeup.mockReset();
    executeWorkflowRunMock.mockReset();
    resetInstantWorkflowAdvanceForTests();
    await db.delete(activityLog);
    await db.delete(instanceSettings);
    await cleanupTerminalBoundaryTables(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  describe("recompute revival (dag-engine)", () => {
    const seedFailedRunWithLiveStep = (runStatus: string) =>
      seedBoundaryIntegrationRun(db, {
        runStatus,
        steps: [
          { stepId: "produce", status: "completed" },
          { stepId: "review", status: "running" },
        ],
      });

    it("flag ON: failed run with a live step stays failed — sync deferred with audit, no revive", async () => {
      await setRunReopenGuardFlag(db, true);
      const world = await seedFailedRunWithLiveStep("failed");
      const seeded = await runOf(db, world.runId);

      const result = await syncWorkflowRunState(db, world.runId);

      expect(result.status).toBe("failed");
      const run = await runOf(db, world.runId);
      expect(run?.status).toBe("failed");
      // 무변경 증거 — 가드는 쓰기를 하지 않으므로 시드된 startedAt/completedAt 가 그대로다.
      expect(run?.startedAt?.toISOString()).toBe(seeded?.startedAt?.toISOString());
      expect(run?.completedAt).toBe(seeded?.completedAt ?? null);
      // [terminal-parent dispatch guard v1] 종결 부모 sync 는 시도 후 거부가 아니라 시도 자체가
      //   없다 — refusal 대신 보류(deferred) 감사 1건으로 계약을 기록한다.
      const deferred = (await db.select().from(activityLog).where(eq(activityLog.entityId, world.runId)))
        .filter((row) => row.action === "workflow_run.terminal_parent_sync_deferred");
      expect(deferred).toHaveLength(1);
      expect(await refusalsOf(db, world.runId)).toHaveLength(0);
      // 파생 변이 부재 — live review step 이 실행되지 않고(이슈 생성 없음), step 상태가 그대로다.
      const [reviewRow] = await db.select().from(workflowStepRuns)
        .where(eq(workflowStepRuns.id, world.stepRunIdsByStep.review!));
      expect(reviewRow?.status).toBe("running");
      expect(reviewRow?.issueId).toBeNull();
      expect(await db.select().from(issues).where(eq(issues.originRunId, world.runId))).toHaveLength(0);
    });

    it("flag OFF (legacy regression): the same recompute revives the run to running", async () => {
      await setRunReopenGuardFlag(db, false);
      const world = await seedFailedRunWithLiveStep("failed");

      const result = await syncWorkflowRunState(db, world.runId);

      expect(result.status).toBe("running");
      expect((await runOf(db, world.runId))?.status).toBe("running");
      expect(await refusalsOf(db, world.runId)).toHaveLength(0);
    });
  });

  describe("manual resume (workflow-store)", () => {
    it("flag ON: cancelled run → 409 not_allowed, zero side effects", async () => {
      await setRunReopenGuardFlag(db, true);
      const world = await seedBoundaryIntegrationRun(db, {
        runStatus: "cancelled",
        steps: [{ stepId: "a", status: "failed" }],
      });
      const before = await runOf(db, world.runId);

      await expect(resumeWorkflowRun(db, world.runId, world.companyId)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("workflow_run_resume_not_allowed: terminal status cancelled"),
      });

      const after = await runOf(db, world.runId);
      expect(after?.status).toBe("cancelled");
      expect(after?.dispatchAuthorityVersion).toBe(before?.dispatchAuthorityVersion);
      expect(after?.startedAt?.toISOString()).toBe(before?.startedAt?.toISOString());
    });

    it("flag ON: completed run → 409 not_allowed", async () => {
      await setRunReopenGuardFlag(db, true);
      const world = await seedBoundaryIntegrationRun(db, {
        runStatus: "completed",
        steps: [{ stepId: "a", status: "completed" }],
      });

      await expect(resumeWorkflowRun(db, world.runId, world.companyId)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("workflow_run_resume_not_allowed: terminal status completed"),
      });
    });

    it("flag ON: failed run resumes with authority bump; second resume also wins (running→running)", async () => {
      await setRunReopenGuardFlag(db, true);
      const world = await seedBoundaryIntegrationRun(db, {
        runStatus: "failed",
        steps: [{ stepId: "a", status: "failed" }],
      });

      expect(await resumeWorkflowRun(db, world.runId, world.companyId)).toMatchObject({ status: "running" });
      expect(await resumeWorkflowRun(db, world.runId, world.companyId)).toMatchObject({ status: "running" });
      expect((await runOf(db, world.runId))?.dispatchAuthorityVersion).toBe(2);
    });

    it("flag ON: pending run → deterministic 409 not_allowed (mislabeled conflict corrected)", async () => {
      await setRunReopenGuardFlag(db, true);
      const world = await seedBoundaryIntegrationRun(db, {
        runStatus: "pending",
        steps: [{ stepId: "a", status: "pending" }],
      });

      // pending 은 허용 집합 밖 비종결 — 재시도해도 같은 결과이므로 결정적 거부로 분류한다.
      await expect(resumeWorkflowRun(db, world.runId, world.companyId)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("workflow_run_resume_not_allowed"),
      });
      expect((await runOf(db, world.runId))?.status).toBe("pending");
    });

    it("flag OFF: cancelled run still resumes (legacy behavior)", async () => {
      await setRunReopenGuardFlag(db, false);
      const world = await seedBoundaryIntegrationRun(db, {
        runStatus: "cancelled",
        steps: [{ stepId: "a", status: "failed" }],
      });

      expect(await resumeWorkflowRun(db, world.runId, world.companyId)).toMatchObject({ status: "running" });
    });
  });

  describe("issue-less retry run reopen (retry-issue-less-manual)", () => {
    it("flag ON: cancelled run → null, run row untouched", async () => {
      await setRunReopenGuardFlag(db, true);
      const world = await seedBoundaryIntegrationRun(db, {
        runStatus: "cancelled",
        steps: [{ stepId: "tool-1", status: "failed" }],
      });
      const before = await runOf(db, world.runId);

      const result = await callIssueLessRetry(db, world, "cancelled");

      expect(result).toBeNull();
      const after = await runOf(db, world.runId);
      expect(after?.status).toBe("cancelled");
      expect(after?.dispatchAuthorityVersion).toBe(before?.dispatchAuthorityVersion);
    });

    it("flag ON: failed run reopens with version bump and the step reset stands", async () => {
      await setRunReopenGuardFlag(db, true);
      const world = await seedBoundaryIntegrationRun(db, {
        runStatus: "failed",
        steps: [{ stepId: "tool-1", status: "failed" }],
      });

      const result = await callIssueLessRetry(db, world, "running");

      expect(result?.stepRunId).toBe(world.stepRunIdsByStep["tool-1"]);
      const run = await runOf(db, world.runId);
      expect(run).toMatchObject({ status: "running", dispatchAuthorityVersion: 1 });
      const [stepRun] = await db.select().from(workflowStepRuns)
        .where(eq(workflowStepRuns.id, world.stepRunIdsByStep["tool-1"]!));
      expect(stepRun?.status).toBe("pending");
    });
  });

  describe("instant advance terminal no-op", () => {
    beforeEach(() => {
      process.env.PAPERCLIP_WORKFLOW_INSTANT_ADVANCE = "1";
    });
    afterEach(() => {
      delete process.env.PAPERCLIP_WORKFLOW_INSTANT_ADVANCE;
      configureInstantWorkflowAdvanceDb(null);
    });

    it("flag ON: terminal (failed) run is skipped — no evaluation, failed stays recoverable only via PR-2b path", async () => {
      await setRunReopenGuardFlag(db, true);
      const world = await seedBoundaryIntegrationRun(db, {
        runStatus: "failed",
        steps: [{ stepId: "a", status: "failed", issueStatus: "blocked" }],
      });
      configureInstantWorkflowAdvanceDb(db);
      expect(await reopenGuardJudgementForTests()).toBe(true);

      requestInstantWorkflowAdvance(world.runId);
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(executeWorkflowRunMock).not.toHaveBeenCalled();
      const run = await runOf(db, world.runId);
      expect(run).toMatchObject({ status: "failed", dispatchAuthorityVersion: 0 });
    });

    it("flag OFF: advance proceeds as before (legacy trigger path)", async () => {
      await setRunReopenGuardFlag(db, false);
      const world = await seedBoundaryIntegrationRun(db, {
        runStatus: "failed",
        steps: [{ stepId: "a", status: "failed" }],
      });
      executeWorkflowRunMock.mockResolvedValue({ runId: world.runId });
      configureInstantWorkflowAdvanceDb(db);
      expect(await reopenGuardJudgementForTests()).toBe(false);

      requestInstantWorkflowAdvance(world.runId);
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(executeWorkflowRunMock).toHaveBeenCalledTimes(1);
      expect(executeWorkflowRunMock).toHaveBeenCalledWith(db, world.runId);
    });
  });
});

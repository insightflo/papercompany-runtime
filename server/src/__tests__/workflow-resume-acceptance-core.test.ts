import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { workflowRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import {
  insertMutationCoreResumeExecution,
  insertMutationCoreResumeRequest,
  loadMutationCoreStepRun,
  seedMutationCoreGraph,
  seedMutationCoreStepRun,
  startMutationCoreFixture,
  type MutationCoreFixture,
} from "./helpers/workflow-resume-mutation-core-fixture.js";
import { captureHttpError } from "./helpers/workflow-execution-definition-fixture.js";
import { assertResumeAccepted } from "../services/workflow/resume/acceptance.js";

/**
 * [목적] Task6b resume 수락 가드(assertResumeAccepted)의 실DB 검증 (임베디드 PostgreSQL).
 *   legacy no-op, malformed resumeRequestId 거부, 요청/실행 scope·state·authorityVersion·
 *   generations 계약 위반 거부, 성공 경로(queued/running/completed), guard 무쓰기 증명.
 *   가드는 SELECT 만 수행하며 accepted row 가 실행/reset 을 만들지 않는다. lock manager 아님.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const NOW = new Date("2026-09-08T02:00:00.000Z");

describeEmbeddedPostgres("workflow resume acceptance guard", () => {
  let fixture: MutationCoreFixture;
  let db: Db;

  beforeAll(async () => {
    fixture = await startMutationCoreFixture("resume-acceptance-core-");
    if (!fixture.supported) throw new Error(fixture.reason);
    db = fixture.db;
  }, 60_000);
  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  const storageCounts = async () => (await fixture.sql`SELECT
    (SELECT count(*)::int FROM workflow_resume_requests) AS requests,
    (SELECT count(*)::int FROM workflow_resume_executions) AS executions`)[0] as Record<string, number>;

  const expectRejected = async (runId: string, expectedAuthorityVersion: number) => {
    const error = await captureHttpError(assertResumeAccepted(db, runId, expectedAuthorityVersion));
    expect(error.status).toBe(409);
    expect(error.message).toBe("resume_not_accepted");
    return error;
  };

  /** accepted 요청 1건 + 실행 1건 + 일치하는 step 을 가진 run. 파라미터로 계약 위반을 주입한다. */
  async function seedAcceptedGraph(executionState: string, overrides: {
    authorityVersion?: number;
    runAuthorityMetadata?: number | null;
    appliedGenerations?: Record<string, number>;
    executionGenerations?: Record<string, number>;
    requestState?: string;
    requestAcceptedAt?: Date | null;
    withExecution?: boolean;
    stepGeneration?: number;
    stepMetadata?: Record<string, unknown>;
    stepId?: string;
  } = {}) {
    const graph = await seedMutationCoreGraph(fixture.sql, "ACC");
    const requestId = randomUUID();
    const stepId = overrides.stepId ?? "resume-target";
    const appliedGenerations = overrides.appliedGenerations ?? { [stepId]: 4 };
    const runAuthority = overrides.runAuthorityMetadata === undefined ? 3 : overrides.runAuthorityMetadata;
    const metadata: Record<string, unknown> = runAuthority === null
      ? { resumeRequestId: requestId }
      : { resumeRequestId: requestId, resumeAuthorityVersion: runAuthority };
    await db.update(workflowRuns).set({ dispatchAuthorityVersion: 3, metadata })
      .where(eq(workflowRuns.id, graph.runId));
    await seedMutationCoreStepRun(db, {
      runId: graph.runId,
      stepId,
      values: {
        status: "pending",
        executionGeneration: overrides.stepGeneration ?? 4,
        metadata: overrides.stepMetadata ?? { resumeRequestId: requestId },
      },
    });
    await insertMutationCoreResumeRequest(db, {
      id: requestId,
      companyId: graph.companyId,
      missionId: graph.missionId,
      workflowRunId: graph.runId,
      state: overrides.requestState ?? "accepted",
      acceptedAt: overrides.requestAcceptedAt === undefined ? NOW : overrides.requestAcceptedAt,
      appliedGenerations,
    });
    if (overrides.withExecution !== false) {
      await insertMutationCoreResumeExecution(db, {
        requestId,
        companyId: graph.companyId,
        missionId: graph.missionId,
        workflowRunId: graph.runId,
        authorityVersion: overrides.authorityVersion ?? 3,
        generations: overrides.executionGenerations ?? appliedGenerations,
        state: executionState,
      });
    }
    return { graph, requestId, stepId, appliedGenerations };
  }

  it("treats a run without own resumeRequestId metadata as a legacy no-op", async () => {
    const graph = await seedMutationCoreGraph(fixture.sql, "LEGACY");
    const before = await storageCounts();
    await expect(assertResumeAccepted(db, graph.runId, 0)).resolves.toBeUndefined();
    expect(await storageCounts()).toEqual(before);
  });

  it("rejects a missing run with 404", async () => {
    const error = await captureHttpError(assertResumeAccepted(db, randomUUID(), 0));
    expect(error.status).toBe(404);
  });

  it("rejects malformed resumeRequestId values without legacy fallback", async () => {
    const graph = await seedMutationCoreGraph(fixture.sql, "MALFORM");
    for (const bad of [null, "", "not-a-uuid", 42]) {
      await db.update(workflowRuns).set({ metadata: { resumeRequestId: bad } })
        .where(eq(workflowRuns.id, graph.runId));
      await expectRejected(graph.runId, 0);
    }
  });

  it("rejects resumeAuthorityVersion that is missing or differs from run dispatch authority", async () => {
    const missing = await seedAcceptedGraph("queued", { runAuthorityMetadata: null });
    await expectRejected(missing.graph.runId, 3);
    const mismatched = await seedAcceptedGraph("queued", { runAuthorityMetadata: 4 });
    await expectRejected(mismatched.graph.runId, 3);
  });

  it("rejects when the resume request is missing or scoped to another mission/run", async () => {
    const dangling = await seedAcceptedGraph("queued", {});
    await fixture.sql`DELETE FROM workflow_resume_executions WHERE request_id = ${dangling.requestId}`;
    await fixture.sql`DELETE FROM workflow_resume_requests WHERE id = ${dangling.requestId}`;
    await expectRejected(dangling.graph.runId, 3);
    const foreign = await seedAcceptedGraph("queued", {});
    const foreignGraph = await seedMutationCoreGraph(fixture.sql, "ACC-F");
    await db.update(workflowRuns).set({
      dispatchAuthorityVersion: 3,
      metadata: { resumeRequestId: foreign.requestId, resumeAuthorityVersion: 3 },
    }).where(eq(workflowRuns.id, foreignGraph.runId));
    await expectRejected(foreignGraph.runId, 3);
  });

  it("rejects requests that are pending, blocked, cancelled or accepted without acceptedAt", async () => {
    for (const requestState of ["pending_delivery", "blocked", "cancelled"]) {
      const seeded = await seedAcceptedGraph("queued", { requestState, requestAcceptedAt: null });
      await expectRejected(seeded.graph.runId, 3);
    }
    const nullAccepted = await seedAcceptedGraph("queued", { requestState: "accepted", requestAcceptedAt: null });
    await expectRejected(nullAccepted.graph.runId, 3);
  });

  it("rejects an accepted request without an execution row", async () => {
    const seeded = await seedAcceptedGraph("queued", { withExecution: false });
    await expectRejected(seeded.graph.runId, 3);
  });

  it("rejects blocked and cancelled executions", async () => {
    for (const executionState of ["blocked", "cancelled"]) {
      const seeded = await seedAcceptedGraph(executionState, {});
      await expectRejected(seeded.graph.runId, 3);
    }
  });

  it("rejects authority version and generation record mismatches", async () => {
    const wrongExpected = await seedAcceptedGraph("queued", { authorityVersion: 3 });
    await expectRejected(wrongExpected.graph.runId, 2);
    const emptyApplied = await seedAcceptedGraph("queued", { appliedGenerations: {} });
    await expectRejected(emptyApplied.graph.runId, 3);
    const emptyGenerations = await seedAcceptedGraph("queued", { executionGenerations: {} });
    await expectRejected(emptyGenerations.graph.runId, 3);
    const differing = await seedAcceptedGraph("queued", { executionGenerations: { "resume-target": 5 } });
    await expectRejected(differing.graph.runId, 3);
    const negative = await seedAcceptedGraph("queued", { appliedGenerations: { "resume-target": -1 }, executionGenerations: { "resume-target": -1 } });
    await expectRejected(negative.graph.runId, 3);
    const unknownStep = await seedAcceptedGraph("queued", {
      appliedGenerations: { "resume-target": 4, ghost: 1 },
      executionGenerations: { "resume-target": 4, ghost: 1 },
    });
    await expectRejected(unknownStep.graph.runId, 3);
    const staleStep = await seedAcceptedGraph("queued", { stepGeneration: 8 });
    await expectRejected(staleStep.graph.runId, 3);
    const foreignOwner = await seedAcceptedGraph("queued", { stepMetadata: { resumeRequestId: randomUUID() } });
    await expectRejected(foreignOwner.graph.runId, 3);
  });

  it("accepts exact records for queued, running and completed executions and writes nothing", async () => {
    for (const executionState of ["queued", "running", "completed"]) {
      const seeded = await seedAcceptedGraph(executionState, {});
      const before = await storageCounts();
      const stepBefore = await loadMutationCoreStepRun(fixture.sql, (await fixture.sql`
        SELECT id FROM workflow_step_runs WHERE workflow_run_id = ${seeded.graph.runId}`)[0]!.id as string);
      await expect(assertResumeAccepted(db, seeded.graph.runId, 3)).resolves.toBeUndefined();
      expect(await storageCounts()).toEqual(before);
      expect(await loadMutationCoreStepRun(fixture.sql, stepBefore!.id as string)).toEqual(stepBefore);
    }
  });
});

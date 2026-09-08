import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { workflowStepRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import {
  loadMutationCoreStepRun,
  seedMutationCoreGraph,
  seedMutationCoreStepRun,
  startMutationCoreFixture,
  type MutationCoreFixture,
} from "./helpers/workflow-resume-mutation-core-fixture.js";
import { captureHttpError, sleep } from "./helpers/workflow-execution-definition-fixture.js";
import { withResumeSerialization } from "../services/workflow/resume/serialization.js";

/**
 * [목적] Task6a resume serialization(withResumeSerialization) 실DB 검증 (임베디드 PostgreSQL).
 *   scope 잠금(mission→run→steps, stepId/id 정렬), 분리 커넥션 lock 유지/해제(pg_stat_activity),
 *   callback throw 롤백, missing/crossscope notFound, UUID 사전 검증.
 *   step status CHECK 는 pending/running/completed/failed/skipped 만 허용하므로 검증에도
 *   실제 허용 status 만 사용한다. reset 계약 검증은 workflow-resume-mutation-core.test.ts,
 *   prototype-key 계약은 workflow-resume-generation-keys.test.ts 가 담당한다.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("workflow resume serialization core", () => {
  let fixture: MutationCoreFixture;
  let db: Db;

  beforeAll(async () => {
    fixture = await startMutationCoreFixture("resume-serialization-core-");
    if (!fixture.supported) throw new Error(fixture.reason);
    db = fixture.db;
  }, 60_000);
  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  it("serializes mission, run and steps ordered by stepId then id under one transaction", async () => {
    const graph = await seedMutationCoreGraph(fixture.sql, "SEQ");
    const twinA = await seedMutationCoreStepRun(db, { runId: graph.runId, stepId: "b" });
    const twinB = await seedMutationCoreStepRun(db, { runId: graph.runId, stepId: "b" });
    await seedMutationCoreStepRun(db, { runId: graph.runId, stepId: "c" });
    const first = await seedMutationCoreStepRun(db, { runId: graph.runId, stepId: "a", values: { status: "pending" } });
    // twin UUID 는 random 발생이므로 기대 순서도 동일한 lexical 정렬로 계산한다 (production .orderBy(stepId, id) 대응).
    const [twinLow, twinHigh] = [twinA.id, twinB.id].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    await withResumeSerialization(db, graph, async ({ mission, run, steps }) => {
      expect(mission).toMatchObject({ id: graph.missionId, companyId: graph.companyId });
      expect(run).toMatchObject({ id: graph.runId, companyId: graph.companyId, missionId: graph.missionId });
      expect(steps.map((step) => [step.stepId, step.id])).toEqual([
        ["a", first.id],
        ["b", twinLow],
        ["b", twinHigh],
        ["c", expect.any(String)],
      ]);
      expect(steps[0]!.status).toBe("pending");
      await steps; // caller-controlled tx 도 사용 가능 — 별도 검증은 아래 롤백 테스트에서 수행.
    });
    expect(await loadMutationCoreStepRun(fixture.sql, first.id)).toMatchObject({ status: "pending" });
  });

  it("rejects missing and cross-scope runs with 404 and invalid UUIDs with 400", async () => {
    const graph = await seedMutationCoreGraph(fixture.sql, "SCOPE");
    const missing = await captureHttpError(
      withResumeSerialization(db, { ...graph, runId: randomUUID() }, async () => undefined),
    );
    expect(missing.status).toBe(404);
    const foreignGraph = await seedMutationCoreGraph(fixture.sql, "SCOPE-F");
    const crossScope = await captureHttpError(withResumeSerialization(db, {
      companyId: graph.companyId,
      missionId: graph.missionId,
      runId: foreignGraph.runId,
    }, async () => undefined));
    expect(crossScope.status).toBe(404);
    const badUuid = await captureHttpError(withResumeSerialization(db, {
      companyId: "not-a-uuid",
      missionId: graph.missionId,
      runId: graph.runId,
    }, async () => undefined));
    expect(badUuid.status).toBe(400);
  });

  it("holds step locks against a second connection until the transaction commits", async () => {
    const graph = await seedMutationCoreGraph(fixture.sql, "LOCK");
    const step = await seedMutationCoreStepRun(db, { runId: graph.runId, stepId: "locked", values: { status: "failed" } });
    const other = fixture.openConnection();
    const observer = fixture.openRawConnection();
    try {
      let blockedUpdate: Promise<unknown> | null = null;
      await withResumeSerialization(db, graph, async () => {
        // status CHECK 허용값(pending)으로 외부 갱신 — 잠금 대기 자체를 검증한다.
        blockedUpdate = other.update(workflowStepRuns).set({ status: "pending" })
          .where(eq(workflowStepRuns.id, step.id));
        blockedUpdate.catch(() => {});
        const deadline = Date.now() + 10_000;
        let locked: Array<Record<string, unknown>> = [];
        while (Date.now() < deadline) {
          locked = await observer`
            SELECT a.pid FROM pg_stat_activity a
            WHERE a.datname = current_database()
              AND a.state = 'active' AND a.wait_event_type = 'Lock'
              AND a.query ILIKE '%update "workflow_step_runs"%'
              AND a.pid <> pg_backend_pid()`;
          if (locked.length > 0) break;
          await sleep(100);
        }
        expect(locked.length).toBeGreaterThan(0);
      });
      await blockedUpdate;
      expect(await loadMutationCoreStepRun(fixture.sql, step.id)).toMatchObject({ status: "pending" });
    } finally {
      await other.$client.end({ timeout: 5 }).catch(() => {});
      await observer.end({ timeout: 5 }).catch(() => {});
    }
  });

  it("rolls back serialization work when the callback throws", async () => {
    const graph = await seedMutationCoreGraph(fixture.sql, "RB");
    const step = await seedMutationCoreStepRun(db, { runId: graph.runId, stepId: "rb", values: { status: "failed", executionGeneration: 4 } });
    await expect(withResumeSerialization(db, graph, async ({ tx, steps }) => {
      // 유효한 status(pending)로 쓴 뒤 throw — 롤백이 status/generation 을 원복하는지 검증.
      await tx.update(workflowStepRuns).set({ status: "pending" }).where(eq(workflowStepRuns.id, steps[0]!.id));
      throw new Error("callback-failure");
    })).rejects.toThrow("callback-failure");
    expect(await loadMutationCoreStepRun(fixture.sql, step.id)).toMatchObject({
      status: "failed",
      execution_generation: 4,
    });
  });
});

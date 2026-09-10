import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import {
  applySigner,
  boardActor,
  loadApplyActivityRows,
  loadApplyRequestRows,
  loadApplyStepRun,
  resetReviewedPolicies,
  resumeApplyBody,
  seedResumeApplyScenario,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
  type RawSql,
  type ResumeApplyScenario,
} from "./helpers/workflow-resume-apply-fixture.js";
import { applyResume } from "../services/workflow/resume/apply.js";
import { previewResume } from "../services/workflow/resume/preview.js";
import type { ResumeSnapshotSigner } from "../services/workflow/resume/preview.js";

/**
 * [목적] Task6a apply 동시성 실DB 검증 — 분리 커넥션 + withResumeSerialization 잠금 하에서
 *   같은 키 동시 apply 는 한 건의 요청으로 수렴하고, 같은 preview 로 파생된 서로 다른 키는
 *   정확히 하나만 성공한다. sleep 기반 잠정 단언 없음 — 잠금 직렬화와 최종 행 상태로만 단언.
 *   reviewed-policy manifest 만 모듈 경계 fixture 로 주입한다(프로덕션 검토 증명 아님).
 */

vi.mock("../services/workflow/resume/reviewed-policy.js", async () => {
  const helper = await import("./helpers/workflow-resume-apply-fixture.js");
  return { REVIEWED_RESUME_POLICIES: helper.TEST_REVIEWED_POLICIES };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const NOW = new Date("2026-09-08T01:00:00.000Z");

describeEmbeddedPostgres("workflow resume apply concurrency", () => {
  let fixture: ExecutionDefinitionFixture;
  let db: Db;
  let sql: RawSql;
  let extraConnections: Db[];

  beforeAll(async () => {
    fixture = await startExecutionDefinitionFixture("resume-apply-conc-");
    if (!fixture.supported) throw new Error(fixture.reason);
    db = fixture.db;
    sql = fixture.sql;
    extraConnections = [];
  }, 60_000);
  afterAll(async () => {
    for (const connection of extraConnections) {
      await connection.$client.end({ timeout: 5 }).catch(() => {});
    }
    if (fixture?.supported) await fixture.cleanup();
  });
  beforeEach(() => {
    resetReviewedPolicies();
  });

  function openConnection(): Db {
    const connection = fixture.openConnection();
    extraConnections.push(connection);
    return connection;
  }

  async function eligiblePreview(scenario: ResumeApplyScenario, signer: ResumeSnapshotSigner) {
    const result = await previewResume(db, {
      companyId: scenario.companyId,
      missionId: scenario.missionId,
      workflowRunId: scenario.runId,
      startStepId: "gate",
    }, signer);
    expect(result.preview.eligible).toBe(true);
    return result;
  }

  it("converges concurrent same-key applies to exactly one request", async () => {
    const scenario = await seedResumeApplyScenario(db, sql, "conc-same-");
    const signer = applySigner(NOW);
    const preview = await eligiblePreview(scenario, signer);
    const body = resumeApplyBody(scenario, { token: preview.preview.token!, idempotencyKey: randomUUID() });
    const actor = boardActor(scenario.companyId);
    const outcomes = await Promise.allSettled([
      applyResume(openConnection(), actor, body, signer),
      applyResume(openConnection(), actor, body, signer),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    expect(fulfilled).toHaveLength(2);
    const [first, second] = fulfilled as Array<PromiseFulfilledResult<{ id: string }>>;
    expect(second!.value.id).toBe(first!.value.id);
    const requests = await loadApplyRequestRows(sql, scenario.runId);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.id).toBe(first!.value.id);
    expect(requests[0]!.state).toBe("pending_delivery");
    expect(await loadApplyActivityRows(sql, scenario.runId)).toHaveLength(1);
    expect((await loadApplyStepRun(sql, scenario.stepRunIds.gate))!.execution_generation).toBe(5);
    expect((await loadApplyStepRun(sql, scenario.stepRunIds.redo))!.execution_generation).toBe(3);
  });

  it("lets exactly one of concurrent different-key applies from the same preview succeed", async () => {
    const scenario = await seedResumeApplyScenario(db, sql, "conc-diff-");
    const signer = applySigner(NOW);
    const preview = await eligiblePreview(scenario, signer);
    const actor = boardActor(scenario.companyId);
    const outcomes = await Promise.allSettled([
      applyResume(openConnection(), actor, resumeApplyBody(scenario, { token: preview.preview.token!, idempotencyKey: randomUUID() }), signer),
      applyResume(openConnection(), actor, resumeApplyBody(scenario, { token: preview.preview.token!, idempotencyKey: randomUUID() }), signer),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const conflict = (rejected[0] as PromiseRejectedResult).reason as { status?: number; message?: string };
    expect(conflict.status).toBe(409);
    expect(conflict.message).toBe("resume_blocked");
    const winnerId = (fulfilled[0] as PromiseFulfilledResult<{ id: string }>).value.id;
    const requests = await loadApplyRequestRows(sql, scenario.runId);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.id).toBe(winnerId);
    expect(await loadApplyActivityRows(sql, scenario.runId)).toHaveLength(1);
    expect((await loadApplyStepRun(sql, scenario.stepRunIds.gate))!.execution_generation).toBe(5);
  });

  it("does not disclose an existing idempotency key across scopes", async () => {
    const scenarioA = await seedResumeApplyScenario(db, sql, "conc-scope-a-");
    const signer = applySigner(NOW);
    const previewA = await eligiblePreview(scenarioA, signer);
    const sharedKey = randomUUID();
    const appliedA = await applyResume(db, boardActor(scenarioA.companyId), resumeApplyBody(scenarioA, {
      token: previewA.preview.token!,
      idempotencyKey: sharedKey,
    }), signer);
    const scenarioB = await seedResumeApplyScenario(db, sql, "conc-scope-b-", {
      base: { companyId: scenarioA.companyId, agentId: scenarioA.agentId },
    });
    const previewB = await eligiblePreview(scenarioB, signer);
    const appliedB = await applyResume(db, boardActor(scenarioA.companyId), resumeApplyBody(scenarioB, {
      token: previewB.preview.token!,
      idempotencyKey: sharedKey,
    }), signer);
    expect(appliedB.id).not.toBe(appliedA.id);
    expect(appliedB.workflowRunId).toBe(scenarioB.runId);
    expect(appliedB).not.toMatchObject({ requestHash: appliedA.requestHash });
    const rowsA = await loadApplyRequestRows(sql, scenarioA.runId);
    const rowsB = await loadApplyRequestRows(sql, scenarioB.runId);
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    expect(rowsA[0]!.id).toBe(appliedA.id);
    expect(rowsB[0]!.id).toBe(appliedB.id);
  });
});

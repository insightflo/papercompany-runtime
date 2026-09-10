import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { missions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import {
  agentActor,
  applySigner,
  boardActor,
  captureHttpError,
  countApplyIssues,
  countApplyResumeExecutions,
  crossCompanyBoardActor,
  loadApplyActivityRows,
  loadApplyMissionRow,
  loadApplyRequestRows,
  loadApplyRunRow,
  loadApplyStepRun,
  loadApplyTransitionEvents,
  noneActor,
  resetReviewedPolicies,
  resumeApplyBody,
  seedResumeApplyScenario,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
  type RawSql,
  type ResumeApplyScenario,
} from "./helpers/workflow-resume-apply-fixture.js";
import { hashStructuredValue } from "../services/issue-execution-cards/hash.js";
import { applyResume } from "../services/workflow/resume/apply.js";
import { previewResume } from "../services/workflow/resume/preview.js";
import { hashSnapshotState } from "../services/workflow/resume/snapshot.js";

/** [목적] Task6a real atomic apply 실DB 검증 — 원자적 영속/replay/stale/blocked/auth/롤백.
 *  reviewed-policy manifest 만 모듈 경계 fixture 로 주입(프로덕션 검토 증명 아님), 나머지는 실제 모듈. */

vi.mock("../services/workflow/resume/reviewed-policy.js", async () => {
  const helper = await import("./helpers/workflow-resume-apply-fixture.js");
  return { REVIEWED_RESUME_POLICIES: helper.TEST_REVIEWED_POLICIES };
});

const describeEmbeddedPostgres = (await getEmbeddedPostgresTestSupport()).supported ? describe : describe.skip;
const NOW = new Date("2026-09-08T01:00:00.000Z");
const scopeOf = (scenario: ResumeApplyScenario) => ({
  companyId: scenario.companyId,
  missionId: scenario.missionId,
  workflowRunId: scenario.runId,
  startStepId: "gate",
});

describeEmbeddedPostgres("workflow resume apply", () => {
  let fixture: ExecutionDefinitionFixture;
  let db: Db;
  let sql: RawSql;

  beforeAll(async () => {
    fixture = await startExecutionDefinitionFixture("resume-apply-");
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

  async function eligiblePreview(scenario: ResumeApplyScenario, now = NOW) {
    const result = await previewResume(db, scopeOf(scenario), applySigner(now));
    expect(result.preview.eligible).toBe(true);
    expect(result.preview.token).toBeTruthy();
    return result;
  }

  it("applies real preview atomically: request+beforeState+audit+reset/authority, zero executions", async () => {
    const scenario = await seedResumeApplyScenario(db, sql, "apply-ok-");
    const preview = await eligiblePreview(scenario);
    expect(await countApplyIssues(sql, scenario.companyId)).toBe(0);
    const body = resumeApplyBody(scenario, { token: preview.preview.token! });
    const view = await applyResume(db, boardActor(scenario.companyId), body, applySigner(NOW));
    expect(view).toMatchObject({ workflowRunId: scenario.runId, state: "pending_delivery", code: null });
    expect(view.execution).toBeNull();

    const requests = await loadApplyRequestRows(sql, scenario.runId);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.id).toBe(view.id);
    expect(request.state).toBe("pending_delivery");
    expect(request.request_hash).toBe(hashStructuredValue(body));
    expect(request.snapshot_hash).toBe(hashSnapshotState(preview.state!));
    expect(request.definition_hash).toBe(scenario.definitionHash);
    expect(request.request_body).toEqual(body);
    expect(request.applied_generations).toEqual({ done: 1, gate: 5, redo: 3 });

    const before = request.before_state as Record<string, unknown>;
    const beforeSteps = before.steps as Array<Record<string, unknown>>;
    expect(beforeSteps.map((step) => step.stepId)).toEqual(["done", "gate", "redo"]);
    const beforeGate = beforeSteps.find((step) => step.stepId === "gate")!;
    expect(beforeGate).toMatchObject({ status: "pending", executionGeneration: 4, retryCount: 2 });
    expect((beforeGate.metadata as Record<string, unknown>).customNote).toBe("preserve-me");
    expect(before.run).toMatchObject({
      status: "failed",
      dispatchAuthorityVersion: 5,
      startedAt: "2026-09-07T09:00:00.000Z",
      metadata: { customKeeper: { nested: "value" } },
    });
    expect(before.mission).toMatchObject({ status: "completed", startedAt: "2026-09-07T08:00:00.000Z" });

    const activities = await loadApplyActivityRows(sql, scenario.runId);
    expect(activities).toHaveLength(1);
    const activity = activities[0]!;
    expect(activity).toMatchObject({
      actor_type: "user",
      actor_id: "user-apply-1",
      action: "workflow.resume_requested",
      entity_type: "workflow_run",
      company_id: scenario.companyId,
    });
    expect(activity.details).toMatchObject({
      requestId: view.id,
      startStepId: "gate",
      affectedStepIds: ["done", "gate", "redo"],
      reasonHash: hashStructuredValue(body.reason),
    });
    const serialized = JSON.stringify(activity);
    expect(serialized).not.toContain(body.snapshotToken.slice(0, 24));
    expect(serialized).not.toContain(body.reason);

    const gate = await loadApplyStepRun(sql, scenario.stepRunIds.gate);
    expect(gate).toMatchObject({
      status: "pending",
      execution_generation: 5,
      status_transition_version: 7,
      retry_count: 2,
      iteration_index: 3,
      started_at: null,
    });
    expect(gate!.metadata.customNote).toBe("preserve-me");
    expect(gate!.metadata.controlNodeError).toBeUndefined();
    expect(gate!.metadata.resumeRequestId).toBe(view.id);
    const redo = await loadApplyStepRun(sql, scenario.stepRunIds.redo);
    expect(redo).toMatchObject({
      status: "pending",
      execution_generation: 3,
      status_transition_version: 10,
      retry_count: 5,
      iteration_index: 1,
      original_status: "running",
      agent_name: "agent-x",
      dispatch_authority_kind: "wakeup",
    });
    expect(redo!.metadata.customLevel.deep.value).toBe(42);
    expect(await loadApplyStepRun(sql, scenario.stepRunIds.side)).toMatchObject({
      status: "completed",
      execution_generation: 7,
      status_transition_version: 8,
      metadata: { sideNote: "outside" },
    });

    const run = await loadApplyRunRow(sql, scenario.runId);
    expect(run!.status).toBe("running");
    expect(run!.completed_at).toBeNull();
    expect(run!.dispatch_authority_version).toBe(6);
    expect(new Date(run!.started_at as string).toISOString()).toBe("2026-09-07T09:00:00.000Z");
    expect(run!.metadata.customKeeper).toEqual({ nested: "value" });
    expect(run!.metadata).toMatchObject({ resumeRequestId: view.id, resumeAuthorityVersion: 6, resumeEpoch: 1 });
    const mission = await loadApplyMissionRow(sql, scenario.missionId);
    expect(mission).toMatchObject({ status: "active", completed_at: null });
    expect(new Date(mission!.started_at as string).toISOString()).toBe("2026-09-07T08:00:00.000Z");
    expect(await loadApplyTransitionEvents(sql, view.id)).toHaveLength(3);
    expect(await countApplyResumeExecutions(sql, view.id)).toBe(0);
    expect(await countApplyIssues(sql, scenario.companyId)).toBe(0);
  });

  it("replays same key+body after clock+6min; different reason conflicts even with expired token", async () => {
    const scenario = await seedResumeApplyScenario(db, sql, "apply-replay-");
    const expiredPreview = await previewResume(db, scopeOf(scenario), applySigner(new Date(NOW.getTime() - 6 * 60_000)));
    const preview = await eligiblePreview(scenario);
    const key = randomUUID();
    const body = resumeApplyBody(scenario, { token: preview.preview.token!, idempotencyKey: key });
    const first = await applyResume(db, boardActor(scenario.companyId), body, applySigner(NOW));
    const replaySigner = applySigner(new Date(NOW.getTime() + 6 * 60_000));
    const second = await applyResume(db, boardActor(scenario.companyId), body, replaySigner);
    expect(second.id).toBe(first.id);
    expect(await loadApplyRequestRows(sql, scenario.runId)).toHaveLength(1);
    expect(await loadApplyActivityRows(sql, scenario.runId)).toHaveLength(1);
    expect((await loadApplyStepRun(sql, scenario.stepRunIds.gate))!.execution_generation).toBe(5);

    const conflicting = resumeApplyBody(scenario, {
      token: expiredPreview.preview.token!,
      idempotencyKey: key,
      reason: "different reason",
    });
    const error = await captureHttpError(applyResume(db, boardActor(scenario.companyId), conflicting, applySigner(NOW)));
    expect(error).toMatchObject({ status: 409, message: "idempotency_conflict" });
    expect(await loadApplyRequestRows(sql, scenario.runId)).toHaveLength(1);
    expect(await loadApplyActivityRows(sql, scenario.runId)).toHaveLength(1);
  });

  it("rejects stale state, forged, wrong-scope, expired tokens with zero writes", async () => {
    const scenario = await seedResumeApplyScenario(db, sql, "apply-stale-");
    const stale = await eligiblePreview(scenario);
    await db.update(missions).set({ updatedAt: new Date("2026-09-07T10:00:00.000Z") })
      .where(eq(missions.id, scenario.missionId));
    const staleError = await captureHttpError(applyResume(db, boardActor(scenario.companyId), resumeApplyBody(scenario, { token: stale.preview.token! }), applySigner(NOW)));
    expect(staleError).toMatchObject({ status: 409, message: "stale_snapshot" });
    expect(await loadApplyRequestRows(sql, scenario.runId)).toHaveLength(0);
    expect((await loadApplyStepRun(sql, scenario.stepRunIds.gate))!.execution_generation).toBe(4);

    const fresh = await eligiblePreview(scenario);
    const forgedSigner = { key: Buffer.alloc(32, 7), now: () => NOW };
    const forgedError = await captureHttpError(applyResume(db, boardActor(scenario.companyId), resumeApplyBody(scenario, { token: fresh.preview.token! }), forgedSigner));
    expect(forgedError).toMatchObject({ status: 409, message: "stale_snapshot" });

    const wrongScopeError = await captureHttpError(applyResume(db, boardActor(scenario.companyId), resumeApplyBody(scenario, { token: fresh.preview.token!, startStepId: "redo" }), applySigner(NOW)));
    expect(wrongScopeError).toMatchObject({ status: 409, message: "stale_snapshot" });

    const expiredPreview = await previewResume(db, scopeOf(scenario), applySigner(new Date(NOW.getTime() - 6 * 60_000)));
    const expiredError = await catchApply(scenario, expiredPreview.preview.token!);
    expect(expiredError).toMatchObject({ status: 409, message: "stale_snapshot" });
    expect(await loadApplyRequestRows(sql, scenario.runId)).toHaveLength(0);
    expect((await loadApplyRunRow(sql, scenario.runId))!.dispatch_authority_version).toBe(5);
    expect(await loadApplyActivityRows(sql, scenario.runId)).toHaveLength(0);
  });

  function catchApply(scenario: ResumeApplyScenario, token: string, signer = applySigner(NOW)) {
    return captureHttpError(applyResume(db, boardActor(scenario.companyId), resumeApplyBody(scenario, { token }), signer));
  }

  it("rejects blocked preview with structured blockers and zero writes", async () => {
    const scenario = await seedResumeApplyScenario(db, sql, "apply-blocked-");
    const preview = await eligiblePreview(scenario);
    await db.update(workflowStepRuns).set({ metadata: { toolQueue: { status: "queued", queuedAt: "2026-09-07T09:39:00.000Z" } } })
      .where(eq(workflowStepRuns.id, scenario.stepRunIds.gate));
    const error = await catchApply(scenario, preview.preview.token!);
    expect(error).toMatchObject({ status: 409, message: "resume_blocked" });
    const blockers = (error.details as { blockers: Array<{ code: string }> }).blockers;
    expect(Array.isArray(blockers)).toBe(true);
    expect(blockers.some((blocker) => blocker.code === "active_work")).toBe(true);
    expect(await loadApplyRequestRows(sql, scenario.runId)).toHaveLength(0);
    expect((await loadApplyStepRun(sql, scenario.stepRunIds.gate))!.execution_generation).toBe(4);
    expect(await loadApplyActivityRows(sql, scenario.runId)).toHaveLength(0);
  });

  it("refuses agent/none/crosscompany actors even for replay", async () => {
    const scenario = await seedResumeApplyScenario(db, sql, "apply-auth-");
    const preview = await eligiblePreview(scenario);
    const body = resumeApplyBody(scenario, { token: preview.preview.token! });
    const first = await applyResume(db, boardActor(scenario.companyId), body, applySigner(NOW));
    expect((await captureHttpError(applyResume(db, noneActor(), body, applySigner(NOW)))).status).toBe(401);
    expect((await captureHttpError(applyResume(db, agentActor(scenario.companyId), body, applySigner(NOW)))).status).toBe(403);
    expect((await captureHttpError(applyResume(db, crossCompanyBoardActor(), body, applySigner(NOW)))).status).toBe(403);
    expect(await loadApplyRequestRows(sql, scenario.runId)).toHaveLength(1);
    expect(await loadApplyActivityRows(sql, scenario.runId)).toHaveLength(1);
    expect(first.state).toBe("pending_delivery");
  });

  it("rolls back request/reset/run/mission/authority when audit insert fails (real DB trigger)", async () => {
    const scenario = await seedResumeApplyScenario(db, sql, "apply-rollback-");
    const preview = await eligiblePreview(scenario);
    await sql`CREATE OR REPLACE FUNCTION apply_test_fail_activity() RETURNS trigger AS $fn$ BEGIN RAISE EXCEPTION 'apply-test: activity blocked'; END; $fn$ LANGUAGE plpgsql`;
    await sql`CREATE TRIGGER apply_test_block_activity BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION apply_test_fail_activity()`;
    try {
      await applyResume(db, boardActor(scenario.companyId), resumeApplyBody(scenario, { token: preview.preview.token! }), applySigner(NOW));
      expect.unreachable("applyResume must reject when the audit insert fails");
    } catch {
    }
    await sql`DROP TRIGGER apply_test_block_activity ON activity_log`;
    await sql`DROP FUNCTION apply_test_fail_activity()`;
    expect(await loadApplyRequestRows(sql, scenario.runId)).toHaveLength(0);
    expect(await loadApplyActivityRows(sql, scenario.runId)).toHaveLength(0);
    const gate = await loadApplyStepRun(sql, scenario.stepRunIds.gate);
    expect(gate).toMatchObject({ status: "pending", execution_generation: 4, status_transition_version: 6 });
    expect(gate!.metadata.resumeRequestId).toBeUndefined();
    const run = await loadApplyRunRow(sql, scenario.runId);
    expect(run).toMatchObject({ status: "failed", dispatch_authority_version: 5 });
    expect(run!.metadata.customKeeper).toEqual({ nested: "value" });
    expect(run!.metadata.resumeRequestId).toBeUndefined();
    const mission = await loadApplyMissionRow(sql, scenario.missionId);
    expect(mission).toMatchObject({ status: "completed" });
    expect(mission!.completed_at).not.toBeNull();
    const events = await sql`SELECT count(*)::int AS count FROM workflow_transition_events WHERE workflow_run_id = ${scenario.runId}`;
    expect((events[0] as { count: number }).count).toBe(0);
  });

  it("refuses when run dispatch authority version would overflow", async () => {
    const scenario = await seedResumeApplyScenario(db, sql, "apply-overflow-");
    await db.update(workflowRuns).set({ dispatchAuthorityVersion: 2147483647 })
      .where(eq(workflowRuns.id, scenario.runId));
    const preview = await eligiblePreview(scenario);
    const error = await catchApply(scenario, preview.preview.token!);
    expect(error).toMatchObject({ status: 409, message: "resume_authority_exhausted" });
    expect(await loadApplyRequestRows(sql, scenario.runId)).toHaveLength(0);
    expect(await loadApplyActivityRows(sql, scenario.runId)).toHaveLength(0);
  });
});

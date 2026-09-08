import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { workflowStepRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import {
  countFenceTransitionEvents,
  loadFenceStepRun,
  seedAcceptedResumeContract,
  seedFenceGraph,
  seedFenceIssue,
  seedFenceStepRun,
  setFenceRunMetadata,
  startFenceFixture,
  type FenceFixture,
} from "./helpers/workflow-resume-stale-fences-fixture.js";
import { completeWorkflowToolStepFromResult } from "../services/workflow/dag-engine.js";
import { resolveWorkflowExecutionLink } from "../services/heartbeat-finalization/workflow-link.js";

/**
 * [목적] Task6c stale-generation result fence (실DB) — contract A(tool result 완성) +
 *   contract B(finalization v1 off 에서도 resume run generation resolve).
 *   resume run 결과 수용은 정확한 dispatch 신원 + 세대 CAS 로 한 세대에만 수렴하고,
 *   ordinary run 은 byte-identical 이 회귀로 증명된다. mock DB/엔진 없음.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let fixture: FenceFixture;
let db: Db;

beforeAll(async () => {
  fixture = await startFenceFixture("resume-stale-fences-");
  if (!fixture.supported) throw new Error(fixture.reason);
  db = fixture.db;
}, 60_000);
afterAll(async () => {
  if (fixture?.supported) await fixture.cleanup();
});

/** resume stamp 가 부여된 진행 중 step run (generation/transitionVersion 1, dispatch D1). */
async function seedDispatchedResumeStepRun(graph: { runId: string }, requestIds: { resume: string; dispatch: string }) {
  return seedFenceStepRun(db, {
    runId: graph.runId,
    values: {
      status: "running",
      startedAt: new Date("2026-09-09T02:00:00.000Z"),
      executionGeneration: 1,
      statusTransitionVersion: 1,
      lastDispatchRequestId: requestIds.dispatch,
      metadata: { resumeRequestId: requestIds.resume },
    },
  });
}

describeEmbeddedPostgres("task6c stale fences — tool result completion (contract A)", () => {
  it("rejects a same-generation result with a different requestId on a resume run: snapshot returned, zero writes", async () => {
    const graph = await seedFenceGraph(db, "FENCE-A1", { runMetadata: { resumeRequestId: randomUUID() } });
    const ids = { resume: randomUUID(), dispatch: randomUUID() };
    const stepRun = await seedDispatchedResumeStepRun(graph, ids);

    const result = await completeWorkflowToolStepFromResult(db, {
      companyId: graph.companyId,
      stepRunId: stepRun.id,
      requestId: randomUUID(),
      success: true,
    });
    expect(result).not.toBeNull();
    expect(result!.stepRuns).toHaveLength(1);
    expect(result!.stepRuns[0]).toMatchObject({ id: stepRun.id, status: "running" });

    const after = await loadFenceStepRun(fixture.sql, stepRun.id);
    expect(after).toMatchObject({ status: "running", execution_generation: 1, status_transition_version: 1 });
    expect(after?.completed_at).toBeNull();
    expect(JSON.stringify(after?.metadata)).not.toContain("toolResult");
    expect(await countFenceTransitionEvents(fixture.sql, stepRun.id)).toBe(0);
  });

  it("rejects a requestId-absent result on a resume run, while an ordinary run without requestId still completes", async () => {
    const resumeGraph = await seedFenceGraph(db, "FENCE-A2", { runMetadata: { resumeRequestId: randomUUID() } });
    const resumeIds = { resume: randomUUID(), dispatch: randomUUID() };
    const resumeStep = await seedDispatchedResumeStepRun(resumeGraph, resumeIds);

    const rejected = await completeWorkflowToolStepFromResult(db, {
      companyId: resumeGraph.companyId,
      stepRunId: resumeStep.id,
      success: true,
    });
    expect(rejected!.stepRuns[0]).toMatchObject({ id: resumeStep.id, status: "running" });
    const afterReject = await loadFenceStepRun(fixture.sql, resumeStep.id);
    expect(afterReject).toMatchObject({ status: "running", execution_generation: 1 });
    expect(await countFenceTransitionEvents(fixture.sql, resumeStep.id)).toBe(0);

    // ordinary regression: stamp 없는 run 은 requestId-absent 결과로도 기존과 동일하게 완료된다.
    const ordinaryGraph = await seedFenceGraph(db, "FENCE-A2-ORD");
    const ordinaryStep = await seedFenceStepRun(db, {
      runId: ordinaryGraph.runId,
      values: {
        status: "running",
        startedAt: new Date("2026-09-09T02:00:00.000Z"),
        lastDispatchRequestId: resumeIds.dispatch,
      },
    });
    const completed = await completeWorkflowToolStepFromResult(db, {
      companyId: ordinaryGraph.companyId,
      stepRunId: ordinaryStep.id,
      success: true,
    });
    expect(completed!.stepRuns[0]).toMatchObject({ id: ordinaryStep.id, status: "completed" });
    const afterComplete = await loadFenceStepRun(fixture.sql, ordinaryStep.id);
    expect(afterComplete).toMatchObject({ status: "completed" });
    expect(JSON.stringify(afterComplete?.metadata)).toContain("toolResult");
  });

  it("drops a late result that arrives after a resume re-reset moved the step to a new generation", async () => {
    const graph = await seedFenceGraph(db, "FENCE-A3", { runMetadata: { resumeRequestId: randomUUID() } });
    const oldIds = { resume: randomUUID(), dispatch: randomUUID() };
    const stepRun = await seedDispatchedResumeStepRun(graph, oldIds);

    // re-reset(resume/apply resetForResume 와 동일한 stamp 규약): 새 세대로 이동.
    const newResume = randomUUID();
    await db.update(workflowStepRuns).set({
      status: "pending",
      startedAt: null,
      completedAt: null,
      lastDispatchRequestId: null,
      executionGeneration: 2,
      statusTransitionVersion: 2,
      metadata: { resumeRequestId: newResume },
    }).where(eq(workflowStepRuns.id, stepRun.id));
    await setFenceRunMetadata(db, graph.runId, { resumeRequestId: newResume });

    const late = await completeWorkflowToolStepFromResult(db, {
      companyId: graph.companyId,
      stepRunId: stepRun.id,
      requestId: oldIds.dispatch,
      success: true,
    });
    expect(late!.stepRuns[0]).toMatchObject({ id: stepRun.id, status: "pending" });
    const after = await loadFenceStepRun(fixture.sql, stepRun.id);
    expect(after).toMatchObject({
      status: "pending",
      execution_generation: 2,
      status_transition_version: 2,
    });
    expect(after?.completed_at).toBeNull();
    expect(await countFenceTransitionEvents(fixture.sql, stepRun.id)).toBe(0);
  });

  it("still completes a resume run result whose requestId matches the current dispatch exactly", async () => {
    const ids = { resume: randomUUID(), dispatch: randomUUID() };
    const graph = await seedFenceGraph(db, "FENCE-A4", { runMetadata: { resumeRequestId: ids.resume } });
    const stepRun = await seedDispatchedResumeStepRun(graph, ids);
    // production resume run 은 accepted durable contract 를 갖는다 — positive control 도 동일하게 시딩.
    await seedAcceptedResumeContract(db, {
      graph,
      resumeRequestId: ids.resume,
      authorityVersion: 1,
      appliedGenerations: { "fence-step": 1 },
    });

    const result = await completeWorkflowToolStepFromResult(db, {
      companyId: graph.companyId,
      stepRunId: stepRun.id,
      requestId: ids.dispatch,
      success: true,
    });
    expect(result!.stepRuns[0]).toMatchObject({ id: stepRun.id, status: "completed" });
    const after = await loadFenceStepRun(fixture.sql, stepRun.id);
    expect(after).toMatchObject({ status: "completed", execution_generation: 1 });
  });
});

describeEmbeddedPostgres("task6c stale fences — workflow link generation resolution (contract B)", () => {
  it("resolves the execution generation for a resume-linked run even with finalization v1 disabled", async () => {
    const graph = await seedFenceGraph(db, "FENCE-B1", { runMetadata: { resumeRequestId: randomUUID() } });
    const stepRun = await seedFenceStepRun(db, {
      runId: graph.runId,
      values: { status: "running", executionGeneration: 2, metadata: { resumeRequestId: randomUUID() } },
    });
    const issueId = await seedFenceIssue(db, { companyId: graph.companyId, missionId: graph.missionId });

    const link = await resolveWorkflowExecutionLink(db, {
      enabled: false,
      companyId: graph.companyId,
      issueId,
      workflowRunId: graph.runId,
      workflowStepRunId: stepRun.id,
    });
    expect(link).toMatchObject({
      workflowRunId: graph.runId,
      workflowStepRunId: stepRun.id,
      generation: 2,
    });

    // ordinary regression: stamp 없는 run 은 v1 off 에서 generation null (기존 동일).
    const ordinaryGraph = await seedFenceGraph(db, "FENCE-B1-ORD");
    const ordinaryStep = await seedFenceStepRun(db, { runId: ordinaryGraph.runId });
    const ordinaryLink = await resolveWorkflowExecutionLink(db, {
      enabled: false,
      companyId: ordinaryGraph.companyId,
      issueId: null,
      workflowRunId: ordinaryGraph.runId,
      workflowStepRunId: ordinaryStep.id,
    });
    expect(ordinaryLink).toMatchObject({ generation: null });
  });
});

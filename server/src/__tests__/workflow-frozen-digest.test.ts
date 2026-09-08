import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, missions, workflowRuns, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { captureHttpError } from "./helpers/workflow-execution-definition-fixture.js";
import {
  cleanupFrozenTables,
  corruptSnapshotSteps,
  createFrozenRun,
  editLiveDefinition,
  loadCapturedDefinition,
  markRunStatus,
  seedFrozenIssueStep,
  seedFrozenMissionGraph,
  seedWorkflowRun,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
  type RawSql,
} from "./helpers/workflow-frozen-mission-fixture.js";
import {
  captureWorkflowViewState,
  seedBlockedIssueWithSignal,
  seedFrozenWorkProductWithPath,
} from "./helpers/workflow-frozen-view-state.js";
import { buildMissionExecutionDigest } from "../services/missions/mission-execution-digest.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

// 세 번째 step 은 id 없이 캡처된다(생성 시 합성 id). digest 가 누락 id 를 안정적으로 렌더하는지 검증한다.
const CAPTURED_STEPS = [
  { id: "gather-sources", name: "Gather sources", agentId: "", type: "tool", tools: ["web.search"] },
  { id: "draft-brief", name: "Draft brief", agentId: "", dependencies: ["gather-sources"], toolNames: ["kb.lookup"] },
  {
    name: "QA gate",
    agentId: "",
    type: "qa",
    dependencies: ["draft-brief"],
    conditionalDependencies: [{ stepId: "draft-brief", when: "qa_request_changes", isBackEdge: true, maxIterations: 3 }],
  },
];

const LIVE_STEPS = [
  { id: "live-only-step", name: "Live replacement", agentId: "", dependencies: [] },
  { id: "draft-brief", name: "Live draft", agentId: "", dependencies: ["live-only-step"] },
];

describeEP("workflow frozen mission execution digest (buildMissionExecutionDigest renders the captured definition)", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;
  let sql: RawSql;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("frozen-mission-digest-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = createDb(fixture.connectionString);
    sql = fixture.sql;
  }, 60_000);

  afterEach(async () => {
    await cleanupFrozenTables(db);
  });

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  async function loadMissionRow(missionId: string) {
    const [mission] = await db.select().from(missions).where(eq(missions.id, missionId));
    return mission!;
  }

  it("renders captured name/step labels/deps/tools with current statuses; live-only edits never leak; stable across calls", async () => {
    const seed = await seedFrozenMissionGraph(sql, db, {
      issuePrefix: "FD" + randomUUID().slice(0, 4),
      name: "captured-digest-workflow",
      stepsJson: CAPTURED_STEPS,
    });
    const loaded = await loadCapturedDefinition(db, seed.runId);
    const qaStepId = loaded.steps.map((step) => step.id).find((id) => !CAPTURED_STEPS.some((step) => step.id === id))!;
    await markRunStatus(db, seed.runId, "running");
    const gather = await seedFrozenIssueStep(db, {
      companyId: seed.companyId,
      missionId: seed.missionId,
      runId: seed.runId,
      stepId: "gather-sources",
      title: "Gather issue",
      status: "running",
      startedAt: new Date("2026-08-03T08:00:00.000Z"),
    });
    await seedFrozenWorkProductWithPath(db, {
      companyId: seed.companyId,
      issueId: gather.issueId,
      title: "Digest artifact",
      url: "file:///tmp/digest-artifact.md",
      path: "/tmp/digest-artifact.md",
      updatedAt: new Date("2026-08-03T08:10:00.000Z"),
    });
    const blockedIssue = await seedBlockedIssueWithSignal(db, {
      companyId: seed.companyId,
      missionId: seed.missionId,
      identifier: "FD-1",
      commentBody: "Blocked on missing credentials — digest signal.",
      commentAt: new Date("2026-08-03T08:20:00.000Z"),
    });
    const mission = await loadMissionRow(seed.missionId);
    await editLiveDefinition(db, seed.workflowId, { name: "live-renamed-digest", stepsJson: LIVE_STEPS });
    const beforeReads = await captureWorkflowViewState(sql, seed.missionId);
    const text = (await buildMissionExecutionDigest(db, { mission, blockedIssue })).join("\n");
    expect(text).toContain(`Workflow run: captured-digest-workflow (${seed.runId}) status=running started=not_started completed=open`);
    expect(text).not.toContain("live-renamed-digest");
    expect(text).toContain("Step gather-sources (Gather sources) status=running");
    expect(text).toContain("tools=[web.search]");
    expect(text).toContain("Step draft-brief (Draft brief) status=pending deps=[gather-sources]");
    expect(text).toContain(`Step ${qaStepId} (QA gate) status=pending deps=[draft-brief]`);
    expect(text).toContain(`issue=${gather.issueId} issueStatus=in_progress`);
    expect(text).toContain(`Work product ${gather.issueId}: Digest artifact type=artifact status=active location=file:///tmp/digest-artifact.md`);
    expect(text).toContain("Latest blocker signal");
    expect(text).toContain("Blocked on missing credentials");
    expect(text).not.toContain("live-only-step");
    expect(text).not.toContain("Live replacement");

    const repeat = (await buildMissionExecutionDigest(db, { mission, blockedIssue })).join("\n");
    expect(repeat).toBe(text);
    expect(await captureWorkflowViewState(sql, seed.missionId)).toEqual(beforeReads);
  });

  it("binds multiple captured runs independently, honors limit 3 ordering, and appends orphan steps", async () => {
    const seed = await seedFrozenMissionGraph(sql, db, {
      issuePrefix: "FD" + randomUUID().slice(0, 4),
      name: "digest-oldest-name",
      stepsJson: [{ id: "oldest-step", name: "Oldest step", agentId: "", dependencies: [] }],
    });
    await editLiveDefinition(db, seed.workflowId, {
      name: "digest-renamed-name",
      stepsJson: [{ id: "renamed-step", name: "Renamed step", agentId: "", dependencies: [] }],
    });
    const run2 = await createFrozenRun(db, { workflowId: seed.workflowId, companyId: seed.companyId, missionId: seed.missionId });
    await editLiveDefinition(db, seed.workflowId, {
      name: "digest-live-current",
      stepsJson: [{ id: "live-current-step", name: "Live current step", agentId: "", dependencies: [] }],
    });
    const run3 = await seedWorkflowRun(sql, { workflowId: seed.workflowId, companyId: seed.companyId, missionId: seed.missionId });
    const run4 = await createFrozenRun(db, { workflowId: seed.workflowId, companyId: seed.companyId, missionId: seed.missionId });
    const createdAt = new Map([
      [seed.runId, new Date("2026-08-03T07:00:00.000Z")],
      [run2.id, new Date("2026-08-03T07:10:00.000Z")],
      [run3, new Date("2026-08-03T07:20:00.000Z")],
      [run4.id, new Date("2026-08-03T07:30:00.000Z")],
    ]);
    for (const [runId, at] of createdAt) {
      await db.update(workflowRuns).set({ createdAt: at }).where(eq(workflowRuns.id, runId));
    }
    await seedFrozenIssueStep(db, {
      companyId: seed.companyId,
      missionId: seed.missionId,
      runId: run4.id,
      stepId: "orphan-step",
      status: "failed",
    });
    const blockedIssue = await seedBlockedIssueWithSignal(db, {
      companyId: seed.companyId,
      missionId: seed.missionId,
      identifier: "FD-2",
      commentBody: "Digest limit signal.",
      commentAt: new Date("2026-08-03T07:40:00.000Z"),
    });
    const mission = await loadMissionRow(seed.missionId);

    const text = (await buildMissionExecutionDigest(db, { mission, blockedIssue })).join("\n");
    expect(text).toContain(`Workflow run: digest-live-current (${run4.id})`);
    expect(text).toContain(`Workflow run: digest-live-current (${run3})`);
    expect(text).toContain(`Workflow run: digest-renamed-name (${run2.id})`);
    expect(text).not.toContain(seed.runId);
    expect(text).not.toContain("digest-oldest-name");
    expect(text).not.toContain("Oldest step");
    expect(text).toContain("Step live-current-step (Live current step)");
    expect(text).toContain("Step renamed-step (Renamed step)");
    expect(text).toContain("Step orphan-step (orphan-step) status=failed");
  });

  it("rejects corrupt or missing expected snapshots with 422 and leaves every relevant row unchanged", async () => {
    const seed = await seedFrozenMissionGraph(sql, db, {
      issuePrefix: "FD" + randomUUID().slice(0, 4),
      name: "captured-digest-corrupt",
      stepsJson: CAPTURED_STEPS,
    });
    await markRunStatus(db, seed.runId, "running");
    const gather = await seedFrozenIssueStep(db, {
      companyId: seed.companyId,
      missionId: seed.missionId,
      runId: seed.runId,
      stepId: "gather-sources",
      status: "running",
    });
    await seedFrozenWorkProductWithPath(db, {
      companyId: seed.companyId,
      issueId: gather.issueId,
      title: "Digest artifact",
      url: "file:///tmp/digest-artifact.md",
      path: "/tmp/digest-artifact.md",
      updatedAt: new Date("2026-08-03T08:10:00.000Z"),
    });
    const blockedIssue = await seedBlockedIssueWithSignal(db, {
      companyId: seed.companyId,
      missionId: seed.missionId,
      identifier: "FD-3",
      commentBody: "Corrupt digest signal.",
      commentAt: new Date("2026-08-03T08:20:00.000Z"),
    });
    const mission = await loadMissionRow(seed.missionId);

    await corruptSnapshotSteps(sql, seed.runId);
    const before = await captureWorkflowViewState(sql, seed.missionId);
    const corruptError = await captureHttpError(buildMissionExecutionDigest(db, { mission, blockedIssue }));
    expect(corruptError.status).toBe(422);
    expect((corruptError.details as { reason?: string }).reason).toBe("hash_mismatch");
    expect(await captureWorkflowViewState(sql, seed.missionId)).toEqual(before);

    await sql`DELETE FROM workflow_run_definitions WHERE workflow_run_id = ${seed.runId}`;
    const beforeMissing = await captureWorkflowViewState(sql, seed.missionId);
    expect(beforeMissing.workflow_run_definitions).toEqual([]);
    const missingError = await captureHttpError(buildMissionExecutionDigest(db, { mission, blockedIssue }));
    expect(missingError.status).toBe(422);
    expect((missingError.details as { reason?: string }).reason).toBe("marked_run_without_snapshot");

    expect(await captureWorkflowViewState(sql, seed.missionId)).toEqual(beforeMissing);
  });
});

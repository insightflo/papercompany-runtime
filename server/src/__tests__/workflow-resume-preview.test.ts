import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import {
  canonicalPreviewDomain,
  captureHttpError,
  cleanupPreviewTables,
  expectDomainUnchanged,
  previewResume,
  previewScope,
  seedCompanyWithMission,
  seedPreviewGraph,
  seedPreviewIssue,
  seedPreviewResumeRequest,
  seedPreviewWorkProduct,
  seedWorkflowDefinition,
  seedReadModelHeartbeat,
  seedReadModelWakeup,
  seedWorkflowRun,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
  type PreviewGraph,
} from "./helpers/workflow-resume-preview-fixture.js";
import { seedReadModelStepRun } from "./helpers/workflow-resume-resource-fixture.js";

/**
 * [purpose] Task6a 실제 preview 서비스 테스트 — 실제 임베디드 PostgreSQL + 실제 frozen 캡처 +
 *   실제 REPEATABLE READ READ ONLY 트랜잭션. 검토 정책 레지스트리는 실제(비어 있음) 상태로
 *   fail-closed 를 검증한다. mock DB/loader/해시/토큰 없음, skip 없음.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

const AFFECTED_SEVEN_STEPS = [
  { id: "pv-root", name: "Root", agentId: "", dependencies: [] },
  { id: "pv-c1", name: "C1", agentId: "", dependencies: ["pv-root"] },
  { id: "pv-c2", name: "C2", agentId: "", dependencies: ["pv-c1"] },
  { id: "pv-c3", name: "C3", agentId: "", dependencies: ["pv-c2"] },
  { id: "pv-c4", name: "C4", agentId: "", dependencies: ["pv-c3"] },
  { id: "pv-c5", name: "C5", agentId: "", dependencies: ["pv-c4"] },
  { id: "pv-c6", name: "C6", agentId: "", dependencies: ["pv-c5"] },
  { id: "pv-branch-1", name: "B1", agentId: "", dependencies: [] },
  { id: "pv-branch-2", name: "B2", agentId: "", dependencies: ["pv-branch-1"] },
];

const BACKEDGE_STEPS = [
  { id: "pv-a", name: "A", agentId: "", dependencies: [] },
  {
    id: "pv-b", name: "B", agentId: "", dependencies: ["pv-a"],
    conditionalDependencies: [{ stepId: "pv-a", when: "failure", isBackEdge: true, maxIterations: 3 }],
  },
];

const CHAIN_STEPS = [
  { id: "pv-out", name: "Out", agentId: "", dependencies: [] },
  { id: "pv-mid", name: "Mid", agentId: "", dependencies: ["pv-out"] },
  { id: "pv-leaf", name: "Leaf", agentId: "", dependencies: ["pv-mid"] },
];

describeEP("previewResume — real embedded DB service", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("resume-preview-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = fixture.db;
  }, 60_000);

  afterEach(async () => {
    await cleanupPreviewTables(db);
  });

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  function signer() {
    return { key: Buffer.from("ab".repeat(32), "hex"), now: () => new Date("2024-06-01T12:00:00.000Z") };
  }

  async function stepRowOf(graph: PreviewGraph, stepId: string) {
    const rows = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, graph.runId));
    return rows.find((row) => row.stepId === stepId)!;
  }

  async function workflowIdOf(graph: PreviewGraph): Promise<string> {
    const [row] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, graph.runId));
    return row!.workflowId;
  }

  it("returns structured historical_definition_unproven with empty graph — no fake affected steps", async () => {
    const { companyId, missionId } = await seedCompanyWithMission(fixture.sql, "PVH" + randomUUID().slice(0, 6));
    const workflowId = await seedWorkflowDefinition(fixture.sql, {
      companyId, name: "preview-legacy", stepsJson: CHAIN_STEPS,
    });
    const legacyRunId = await seedWorkflowRun(fixture.sql, { workflowId, companyId, missionId });
    const result = await previewResume(db, {
      companyId, missionId, workflowRunId: legacyRunId, startStepId: "pv-out",
    }, signer());
    expect(result.state).toBeNull();
    expect(result.preview.eligible).toBe(false);
    expect(result.preview.definitionHash).toBeNull();
    expect(result.preview.affectedStepIds).toEqual([]);
    expect(result.preview.preservedStepIds).toEqual([]);
    expect(result.preview.token).toBeNull();
    expect(result.preview.expiresAt).toBeNull();
    expect(result.preview.blockers).toHaveLength(1);
    expect(result.preview.blockers[0]!.code).toBe("historical_definition_unproven");
  });

  it("selects exactly 7 affected steps and preserves unrelated skipped branches", async () => {
    const graph = await seedPreviewGraph(fixture.sql, db, { stepsJson: AFFECTED_SEVEN_STEPS });
    const before = await canonicalPreviewDomain(db);
    const result = await expectDomainUnchanged(db, before, () =>
      previewResume(db, previewScope(graph, "pv-root"), signer()));
    expect(result.preview.affectedStepIds).toEqual([
      "pv-c1", "pv-c2", "pv-c3", "pv-c4", "pv-c5", "pv-c6", "pv-root",
    ]);
    expect(result.preview.preservedStepIds).toEqual(["pv-branch-1", "pv-branch-2"]);
    expect(result.preview.blockers.map((blocker) => blocker.code)).toContain("external_effect_unknown");
    expect(result.preview.eligible).toBe(false);
    expect((await stepRowOf(graph, "pv-branch-1")).status).toBe("pending");
  });

  it("rejects conditional backedge graph as unsupported_graph", async () => {
    const graph = await seedPreviewGraph(fixture.sql, db, { stepsJson: BACKEDGE_STEPS });
    const result = await previewResume(db, previewScope(graph, "pv-a"), signer());
    expect(result.preview.blockers).toHaveLength(1);
    expect(result.preview.blockers[0]!.code).toBe("unsupported_graph");
    expect(result.preview.affectedStepIds).toEqual([]);
    expect(result.state).toBeNull();
    expect(result.preview.token).toBeNull();
  });

  it("rejects dynamic execution mode as unsupported_graph", async () => {
    const graph = await seedPreviewGraph(fixture.sql, db, {
      stepsJson: CHAIN_STEPS, executionMode: "dynamic_owner_plan",
    });
    const result = await previewResume(db, previewScope(graph), signer());
    expect(result.preview.blockers.map((blocker) => blocker.code)).toEqual(["unsupported_graph"]);
    expect(result.preview.eligible).toBe(false);
  });

  it("policy-missing complete root is not eligible — global external_effect_unknown, unsigned state", async () => {
    const graph = await seedPreviewGraph(fixture.sql, db, {
      stepsJson: [{ id: "pv-complete-root", name: "Complete root", agentId: "", type: "complete", dependencies: [] }],
    });
    const result = await previewResume(db, previewScope(graph), signer());
    expect(result.preview.blockers.map((blocker) => blocker.code)).toContain("external_effect_unknown");
    expect(result.preview.eligible).toBe(false);
    expect(result.preview.token).toBeNull();
    expect(result.preview.expiresAt).toBeNull();
    expect(result.preview.generationPossible).toBe(true);
    expect(result.state).not.toBeNull();
    expect(result.state!.steps).toHaveLength(1);
  });

  it("whole-mission sibling running run blocks with active_work; canonical domain unchanged", async () => {
    const graph = await seedPreviewGraph(fixture.sql, db, { stepsJson: CHAIN_STEPS });
    await seedWorkflowRun(fixture.sql, {
      workflowId: await workflowIdOf(graph),
      companyId: graph.companyId, missionId: graph.missionId, status: "running",
    });
    const before = await canonicalPreviewDomain(db);
    const result = await expectDomainUnchanged(db, before, () =>
      previewResume(db, previewScope(graph), signer()));
    expect(result.preview.blockers.filter((blocker) => blocker.code === "active_work").length).toBeGreaterThan(0);
  });

  it("whole-mission sibling step dispatch owner and toolQueue residue block", async () => {
    const graph = await seedPreviewGraph(fixture.sql, db, { stepsJson: CHAIN_STEPS });
    const sibling = await seedWorkflowRun(fixture.sql, {
      workflowId: await workflowIdOf(graph),
      companyId: graph.companyId, missionId: graph.missionId, status: "completed",
    });
    const siblingStepRowId = await seedReadModelStepRun(db, { runId: sibling, stepId: "sib-owner" });
    const ownerWakeupId = await seedReadModelWakeup(db, { companyId: graph.companyId, agentId: graph.agentId });
    const ownerHeartbeatId = await seedReadModelHeartbeat(db, { companyId: graph.companyId, agentId: graph.agentId });
    await db.update(workflowStepRuns).set({
      dispatchOwnerWakeupRequestId: ownerWakeupId,
      dispatchOwnerHeartbeatRunId: ownerHeartbeatId,
      metadata: { toolQueue: { status: "queued" } },
    }).where(eq(workflowStepRuns.id, siblingStepRowId));
    const result = await previewResume(db, previewScope(graph), signer());
    expect(result.preview.blockers.some((blocker) =>
      blocker.code === "active_work" && blocker.message.includes("소유권"))).toBe(true);
    expect(result.preview.blockers.some((blocker) =>
      blocker.code === "active_work" && blocker.message.includes("도구 큐"))).toBe(true);
  });

  it("outside predecessor completed with claimed metadata hash still yields missing_evidence; evidence stays empty", async () => {
    const graph = await seedPreviewGraph(fixture.sql, db, { stepsJson: CHAIN_STEPS });
    const issueId = await seedPreviewIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    const outRow = await stepRowOf(graph, "pv-out");
    await db.update(workflowStepRuns).set({ status: "completed", issueId }).where(eq(workflowStepRuns.id, outRow.id));
    await seedPreviewWorkProduct(db, {
      companyId: graph.companyId, issueId,
      metadata: { sha256: "9".repeat(64), storageMirror: "s3://claimed" },
    });
    const result = await previewResume(db, previewScope(graph, "pv-mid"), signer());
    expect(result.preview.affectedStepIds).toEqual(["pv-leaf", "pv-mid"]);
    const codes = result.preview.blockers.map((blocker) => blocker.code);
    expect(codes).toContain("missing_evidence");
    expect(codes).not.toContain("outside_predecessor_invalid");
    expect(result.preview.blockers.find((blocker) => blocker.code === "missing_evidence")!.detail).toEqual({ stepId: "pv-out" });
    expect(result.state!.evidence).toEqual([]);
    expect(result.preview.eligible).toBe(false);
  });

  it("budget exhausted blocks; invalid budget values report budget_unknown", async () => {
    const graph = await seedPreviewGraph(fixture.sql, db, { stepsJson: CHAIN_STEPS });
    await db.update(companies).set({ budgetMonthlyCents: 100, spentMonthlyCents: 100 }).where(eq(companies.id, graph.companyId));
    const exhausted = await previewResume(db, previewScope(graph), signer());
    expect(exhausted.preview.blockers.map((blocker) => blocker.code)).toContain("budget_exceeded");
    await db.update(companies).set({ spentMonthlyCents: -1 }).where(eq(companies.id, graph.companyId));
    const unknown = await previewResume(db, previewScope(graph), signer());
    expect(unknown.preview.blockers.map((blocker) => blocker.code)).toContain("budget_unknown");
  });

  it("pending_delivery request and queued execution block as active_work", async () => {
    const graph = await seedPreviewGraph(fixture.sql, db, { stepsJson: CHAIN_STEPS });
    await seedPreviewResumeRequest(db, {
      companyId: graph.companyId, missionId: graph.missionId, workflowRunId: graph.runId,
      withExecution: { state: "queued" },
    });
    const result = await previewResume(db, previewScope(graph), signer());
    expect(result.preview.blockers.some((blocker) =>
      blocker.code === "active_work" && blocker.message.includes("resume 요청"))).toBe(true);
    expect(result.preview.blockers.some((blocker) =>
      blocker.code === "active_work" && blocker.message.includes("재개 실행"))).toBe(true);
  });

  it("resumeEpoch valid value freezes into state; malformed value blocks as unsupported_status", async () => {
    const validGraph = await seedPreviewGraph(fixture.sql, db, {
      stepsJson: CHAIN_STEPS, runMetadata: { resumeEpoch: 7 },
    });
    const valid = await previewResume(db, previewScope(validGraph), signer());
    expect(valid.state!.resumeEpoch).toBe(7);
    const malformedGraph = await seedPreviewGraph(fixture.sql, db, {
      stepsJson: CHAIN_STEPS, runMetadata: { resumeEpoch: "bogus" },
    });
    const malformed = await previewResume(db, previewScope(malformedGraph), signer());
    expect(malformed.preview.blockers.some((blocker) =>
      blocker.code === "unsupported_status" && blocker.message.includes("resumeEpoch"))).toBe(true);
    expect(malformed.state!.resumeEpoch).toBe(0);
  });

  it("nonexistent scope is 404; malformed scope input is 400", async () => {
    const graph = await seedPreviewGraph(fixture.sql, db, { stepsJson: CHAIN_STEPS });
    const missing = await captureHttpError(previewResume(db, {
      ...previewScope(graph), missionId: randomUUID(),
    }, signer()));
    expect(missing.status).toBe(404);
    const invalid = await captureHttpError(previewResume(db, {
      ...previewScope(graph), startStepId: "",
    }, signer()));
    expect(invalid.status).toBe(400);
  });
});

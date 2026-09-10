import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { toolDefinitions, workflowStepRuns, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import {
  PREVIEW_NOW,
  cleanupPreviewTables,
  previewResume,
  previewScope,
  seedPreviewGraph,
  seedPreviewIssue,
  seedPreviewWorkProduct,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
  type PreviewGraph,
} from "./helpers/workflow-resume-preview-fixture.js";
import { hashStructuredValue } from "../services/issue-execution-cards/hash.js";
import { verifySnapshot } from "../services/workflow/resume/snapshot.js";
import type { ReviewedResumePolicy } from "../services/workflow/resume/reviewed-policy.js";

/**
 * [purpose] Task6a 검토 정책 매니페스트 결합 테스트. REVIEWED_RESUME_POLICIES 는 사람 검토
 *   결과의 컴파일 타임 불변 레지스트리라서 테스트 전용 주입은 production bypass 를 만들지 않고
 *   모듈 경계(vi.mock)에서만 immutable manifest 로 갈아낀다. 정책 해시 대조와 binding 검증은
 *   실제 DB registry 행과 실제 hashStructuredValue 로 실행된다 — 이 파일의 policy 는 fixture
 *   이지 production registry review 가 아니다(정책 배열을 채우는 것은 상위 슬라이스의 독립 검토
 *   절차다).
 */

const policyRegistry = vi.hoisted(() => ({ policies: [] as ReviewedResumePolicy[] }));

vi.mock("../services/workflow/resume/reviewed-policy.js", () => ({
  REVIEWED_RESUME_POLICIES: policyRegistry.policies,
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

const CHAIN_STEPS = [
  { id: "pv-out", name: "Out", agentId: "", dependencies: [] },
  { id: "pv-mid", name: "Mid", agentId: "", dependencies: ["pv-out"] },
  { id: "pv-leaf", name: "Leaf", agentId: "", dependencies: ["pv-mid"] },
];

const COMPLETE_ROOT = [{ id: "pv-complete-root", name: "Complete root", agentId: "", type: "complete", dependencies: [] }];

describeEP("previewResume — reviewed policy binding", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("resume-preview-policy-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = fixture.db;
  }, 60_000);

  afterEach(async () => {
    policyRegistry.policies.length = 0;
    await cleanupPreviewTables(db);
  });

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });

  function signer() {
    return { key: Buffer.from("cd".repeat(32), "hex"), now: () => PREVIEW_NOW };
  }

  function pushPolicy(graph: PreviewGraph, policy: Omit<ReviewedResumePolicy, "schemaVersion" | "companyId" | "definitionHash">): void {
    policyRegistry.policies.push({
      schemaVersion: 1,
      companyId: graph.companyId,
      definitionHash: graph.definitionHash,
      ...policy,
    });
  }

  it("eligible reviewed static graph with no outside inputs signs and verifies token", async () => {
    const graph = await seedPreviewGraph(fixture.sql, db, { stepsJson: COMPLETE_ROOT });
    pushPolicy(graph, {
      steps: { "pv-complete-root": { effect: "none", toolBindings: [] } },
      requiredGateStepIds: [],
      publicationStepIds: [],
      generationStepIds: [],
    });
    const result = await previewResume(db, previewScope(graph), signer());
    expect(result.preview.eligible).toBe(true);
    expect(result.preview.blockers).toEqual([]);
    expect(result.preview.generationPossible).toBe(false);
    expect(result.preview.token).not.toBeNull();
    expect(result.preview.expiresAt).toBe(new Date(PREVIEW_NOW.getTime() + 300_000).toISOString());
    const state = verifySnapshot(result.preview.token!, signer().key, PREVIEW_NOW);
    expect(state.scope).toEqual(previewScope(graph));
    expect(state.definitionHash).toBe(graph.definitionHash);
    expect(state.mission.status).toBe("active");
    expect(state.run.status).toBe("completed");
    expect(state.steps).toHaveLength(1);
    expect(state.steps[0]!.stepId).toBe("pv-complete-root");
    expect(state.steps[0]!.status).toBe("pending");
    expect(state.evidence).toEqual([]);
    expect(state.approvals).toEqual([]);
    expect(state.resumeEpoch).toBe(0);
    expect(state.factsHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("tool binding config change with same name fails binding resolution — step effect unknown", async () => {
    const graph = await seedPreviewGraph(fixture.sql, db, { stepsJson: COMPLETE_ROOT });
    const [toolRow] = await db.insert(toolDefinitions).values({
      companyId: graph.companyId,
      name: "resume-test-tool",
      adapterType: "builtin",
      adapterConfig: { token: "one" },
      inputSchema: { type: "object" },
    }).returning();
    const configHash = hashStructuredValue({
      name: toolRow!.name,
      enabled: toolRow!.enabled,
      adapterType: toolRow!.adapterType,
      adapterConfig: toolRow!.adapterConfig,
      inputSchema: toolRow!.inputSchema,
    });
    pushPolicy(graph, {
      steps: {
        "pv-complete-root": {
          effect: "read_only",
          toolBindings: [{ id: toolRow!.id, updatedAt: toolRow!.updatedAt.toISOString(), configHash }],
        },
      },
      requiredGateStepIds: [],
      publicationStepIds: [],
      generationStepIds: [],
    });
    const before = await previewResume(db, previewScope(graph), signer());
    expect(before.preview.eligible).toBe(true);
    // 같은 이름, 다른 adapterConfig — binding hash 대조가 실패해야 한다.
    await db.update(toolDefinitions).set({ adapterConfig: { token: "two" } }).where(eq(toolDefinitions.id, toolRow!.id));
    const after = await previewResume(db, previewScope(graph), signer());
    expect(after.preview.eligible).toBe(false);
    expect(after.preview.blockers.map((blocker) => blocker.code)).toEqual(["control_tool_effects_unverified"]);
    expect(after.preview.token).toBeNull();
  });

  it("outside predecessor with claimed metadata hash still yields only missing_evidence under reviewed policy", async () => {
    const graph = await seedPreviewGraph(fixture.sql, db, { stepsJson: CHAIN_STEPS });
    const issueId = await seedPreviewIssue(db, { companyId: graph.companyId, missionId: graph.missionId });
    const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, graph.runId));
    const outRow = stepRuns.find((row) => row.stepId === "pv-out")!;
    await db.update(workflowStepRuns).set({ status: "completed", issueId }).where(eq(workflowStepRuns.id, outRow.id));
    await seedPreviewWorkProduct(db, {
      companyId: graph.companyId, issueId,
      metadata: { sha256: "9".repeat(64), storageMirror: "s3://claimed" },
    });
    pushPolicy(graph, {
      steps: { "pv-mid": { effect: "none", toolBindings: [] }, "pv-leaf": { effect: "none", toolBindings: [] } },
      requiredGateStepIds: [],
      publicationStepIds: [],
      generationStepIds: [],
    });
    const result = await previewResume(db, previewScope(graph, "pv-mid"), signer());
    const codes = result.preview.blockers.map((blocker) => blocker.code);
    expect(codes).toEqual(["missing_evidence"]);
    expect(result.preview.eligible).toBe(false);
    expect(result.preview.token).toBeNull();
  });
});

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, workflowStepRuns, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import {
  PREVIEW_NOW,
  cleanupPreviewTables,
  previewResume,
  previewScope,
  seedPreviewGraph,
  startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture,
} from "./helpers/workflow-resume-preview-fixture.js";
import { verifySnapshot } from "../services/workflow/resume/snapshot.js";
import { verifyOutsidePredecessorArtifact } from "../services/workflow/resume/predecessor-artifact-evidence.js";
import type { ReviewedResumePolicy } from "../services/workflow/resume/reviewed-policy.js";

/**
 * [purpose] outside predecessor 내구 산출물 검증기(predecessor-artifact-evidence)의 단위
 *   계약과 preview 통합. 단위는 실제 임시 파일시스템에서 (계약/스코프/파일/해시) 4방향
 *   fail-closed 를 검증하고, 통합은 검증 통과 시 missing_evidence 해소·SnapshotState.evidence
 *   기록·토큰 서명까지 실제 임베디드 PostgreSQL 로 확인한다. policy 는 모듈 경계(vi.mock)
 *   fixture 로만 공급한다(production registry review 가 아니다).
 */

const policyRegistry = vi.hoisted(() => ({ policies: [] as ReviewedResumePolicy[] }));
vi.mock("../services/workflow/resume/reviewed-policy.js", () => ({
  REVIEWED_RESUME_POLICIES: policyRegistry.policies,
}));

const MISSION_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function stepRunWithToolResult(overrides: {
  artifactPath?: string;
  artifactSha256?: string;
  success?: boolean;
}): { id: string; stepId: string; metadata: unknown } {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    stepId: "pv-out-tool",
    metadata: {
      toolResult: {
        success: overrides.success ?? true,
        artifactPath: overrides.artifactPath ?? "",
        artifactSha256: overrides.artifactSha256 ?? "",
      },
    },
  };
}

describe("verifyOutsidePredecessorArtifact — 단위 계약(실제 파일시스템)", () => {
  let root: string;
  let stepDir: string;
  let artifactPath: string;
  const digest = sha256Text("{\"ok\":true,\"mode\":\"staged\"}\n");

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "resume-pred-evidence-"));
    stepDir = path.join(root, "missions", MISSION_ID, "runs", RUN_ID, "steps", "pv-out-tool");
    await mkdir(stepDir, { recursive: true });
    artifactPath = path.join(stepDir, "artifact.json");
    await writeFile(artifactPath, "{\"ok\":true,\"mode\":\"staged\"}\n", "utf8");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function verify(overrides: Parameters<typeof stepRunWithToolResult>[0], workProductRoot: string | null = root) {
    return verifyOutsidePredecessorArtifact({
      stepRun: stepRunWithToolResult(overrides),
      missionId: MISSION_ID,
      workflowRunId: RUN_ID,
      workProductRoot,
    });
  }

  it("기록 해시와 현재 파일 바이트가 일치하면 verified", async () => {
    await expect(verify({ artifactPath, artifactSha256: digest })).resolves.toEqual({
      kind: "verified",
      sha256: digest,
    });
  });

  it("회사 work product root 미설정은 root_unresolved", async () => {
    await expect(verify({ artifactPath, artifactSha256: digest }, null))
      .resolves.toEqual({ kind: "unverified", reason: "root_unresolved" });
  });

  it("toolResult 기록 부재는 no_tool_result", async () => {
    const result = await verifyOutsidePredecessorArtifact({
      stepRun: { id: "33333333-3333-4333-8333-333333333333", stepId: "pv-out-tool", metadata: {} },
      missionId: MISSION_ID, workflowRunId: RUN_ID, workProductRoot: root,
    });
    expect(result).toEqual({ kind: "unverified", reason: "no_tool_result" });
  });

  it("실패한 toolResult 는 tool_failed", async () => {
    await expect(verify({ artifactPath, artifactSha256: digest, success: false }))
      .resolves.toEqual({ kind: "unverified", reason: "tool_failed" });
  });

  it("artifactPath 기록 부재는 no_artifact_record, 잘못된 해시 형식은 invalid_hash", async () => {
    await expect(verify({ artifactSha256: digest }))
      .resolves.toEqual({ kind: "unverified", reason: "no_artifact_record" });
    await expect(verify({ artifactPath, artifactSha256: "not-a-hash" }))
      .resolves.toEqual({ kind: "unverified", reason: "invalid_hash" });
  });

  it("스텝 출력 디렉터리 밖 경로(형제 스텝/상위 디렉터리)는 path_out_of_scope", async () => {
    const sibling = path.join(root, "missions", MISSION_ID, "runs", RUN_ID, "steps", "other-step", "artifact.json");
    await expect(verify({ artifactPath: sibling, artifactSha256: digest }))
      .resolves.toEqual({ kind: "unverified", reason: "path_out_of_scope" });
    await expect(verify({ artifactPath: path.join(root, "elsewhere.json"), artifactSha256: digest }))
      .resolves.toEqual({ kind: "unverified", reason: "path_out_of_scope" });
  });

  it("파일 부재는 file_missing, 내용 변조는 hash_mismatch", async () => {
    const missing = path.join(stepDir, "missing.json");
    await expect(verify({ artifactPath: missing, artifactSha256: digest }))
      .resolves.toEqual({ kind: "unverified", reason: "file_missing" });
    await writeFile(path.join(stepDir, "tampered.json"), "{\"ok\":false}\n", "utf8");
    await expect(verify({ artifactPath: path.join(stepDir, "tampered.json"), artifactSha256: digest }))
      .resolves.toEqual({ kind: "unverified", reason: "hash_mismatch" });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEP("previewResume — outside predecessor 내구 산출물 검증 통합", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;
  let root: string;

  const TOOL_OUT_CHAIN = [
    { id: "pv-out-tool", name: "Out tool", agentId: "", type: "tool", toolName: "pv-evidence-tool", dependencies: [] },
    { id: "pv-mid", name: "Mid", agentId: "", dependencies: ["pv-out-tool"] },
  ];

  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("resume-pred-evidence-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = fixture.db;
    root = await mkdtemp(path.join(tmpdir(), "resume-pred-evidence-int-"));
  }, 60_000);

  afterEach(async () => {
    policyRegistry.policies.length = 0;
    await cleanupPreviewTables(db);
  });

  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  function signer() {
    return { key: Buffer.from("ab".repeat(32), "hex"), now: () => PREVIEW_NOW };
  }

  async function seedVerifiedOutsideTool(artifactSha256: string, content: string): Promise<{ graph: ReturnType<typeof previewScope> & { runId: string }; outRowId: string; artifactPath: string }> {
    const graph = await seedPreviewGraph(fixture.sql, db, { stepsJson: TOOL_OUT_CHAIN });
    await db.update(companies).set({ workProductRoot: root }).where(eq(companies.id, graph.companyId));
    const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, graph.runId));
    const outRow = stepRuns.find((row) => row.stepId === "pv-out-tool")!;
    const stepDir = path.join(root, "missions", graph.missionId, "runs", graph.runId, "steps", "pv-out-tool");
    await mkdir(stepDir, { recursive: true });
    const artifactPath = path.join(stepDir, "artifact.json");
    await writeFile(artifactPath, content, "utf8");
    await db.update(workflowStepRuns).set({
      status: "completed",
      metadata: { toolResult: { success: true, artifactPath, artifactSha256 } },
    }).where(eq(workflowStepRuns.id, outRow.id));
    policyRegistry.policies.push({
      schemaVersion: 1,
      companyId: graph.companyId,
      definitionHash: graph.definitionHash,
      steps: { "pv-mid": { effect: "none", toolBindings: [] } },
      requiredGateStepIds: [],
      publicationStepIds: [],
      generationStepIds: [],
    });
    return { graph: { companyId: graph.companyId, missionId: graph.missionId, runId: graph.runId }, outRowId: outRow.id, artifactPath };
  }

  it("검증 통과 outside 도구 스텝 — missing_evidence 해소, evidence 기록, 토큰 서명", async () => {
    const content = "{\"ok\":true,\"mode\":\"staged\"}\n";
    const seeded = await seedVerifiedOutsideTool(sha256Text(content), content);
    const result = await previewResume(db, {
      companyId: seeded.graph.companyId,
      missionId: seeded.graph.missionId,
      workflowRunId: seeded.graph.runId,
      startStepId: "pv-mid",
    }, signer());
    expect(result.preview.eligible).toBe(true);
    expect(result.preview.blockers).toEqual([]);
    expect(result.preview.token).not.toBeNull();
    const state = verifySnapshot(result.preview.token!, signer().key, PREVIEW_NOW);
    expect(state.evidence).toEqual([{ id: seeded.outRowId, sha256: sha256Text(content) }]);
  });

  it("파일 변조(해시 불일치) — missing_evidence 로 fail-closed, 토큰 없음", async () => {
    const seeded = await seedVerifiedOutsideTool(sha256Text("original"), "{\"ok\":false}\n");
    const result = await previewResume(db, {
      companyId: seeded.graph.companyId,
      missionId: seeded.graph.missionId,
      workflowRunId: seeded.graph.runId,
      startStepId: "pv-mid",
    }, signer());
    expect(result.preview.eligible).toBe(false);
    expect(result.preview.blockers.map((blocker) => blocker.code)).toEqual(["missing_evidence"]);
    expect(result.preview.token).toBeNull();
  });
});

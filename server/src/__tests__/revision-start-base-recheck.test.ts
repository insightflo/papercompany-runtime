// [Q7 시작시점 기준 재확인 — 행동 검사] 승인 시 활성 계획 refs 에 보존된 revisionDelta.base 스냅샷을
//   시작 경로(createAdmittedWorkflowRun → assertRevisionBoardStart → verifyRevisionDeltaBaseAtStart)에서
//   현재 기준 정의와 다시 대조한다: (a) 기준 불변 → 보드 시작 진행, (b) 승인 후 기준 변경·삭제 →
//   구조화 거절(workflow_revision_base_definition_changed)·실행 생성 0건, (c) 이중 시작은 여전히 최대
//   1개 실행. 변경안 없는 기존 계획은 재확인 대상이 아니다(회귀 대조군). 임베디드 DB 실제 행 사용(모의 없음).
import "./helpers/workflow-control-node-boundary.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, issues, missionPlanArtifacts, workflowDefinitions, workflowRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { board, seedWorld } from "./helpers/workflow-seed-world.js";
import { createAdmittedWorkflowRun } from "../services/workflow/agent-run-create.js";
import { recordMissionPlanQaVerdict } from "../services/missions/mission-plan-qa-verdicts.js";
import { computePaqoDefinitionHash } from "../services/workflow/paqo-definition-identity.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("revision-base-recheck-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "revision-base-recheck-"))); }, 60000);
afterAll(async () => { await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });

// 승인 시점의 revisionDelta(base 스냅샷 포함)를 활성 계획 refs 에 보존하고 PLAN-QA 통과까지 마친 수정 미션.
async function approvedDeltaWorld() {
  const f = await seedWorld(db, root);
  const templateSteps: unknown[] = [
    { id: "collect", name: "Collect", type: "agent", agentId: f.agentId, dependencies: [] },
    { id: "compose", name: "Compose", type: "agent", agentId: f.agentId, dependencies: ["collect"],
      workProductSelectors: { collect: { type: "document", title: "content.json" } } },
  ];
  const [baseTemplate] = await db.insert(workflowDefinitions).values({ companyId: f.companyId,
    name: `template-${f.revision.id}`, stepsJson: templateSteps }).returning();
  const snapshotHash = computePaqoDefinitionHash(templateSteps as Parameters<typeof computePaqoDefinitionHash>[0]);
  const [definition] = await db.insert(workflowDefinitions).values({ companyId: f.companyId, missionId: f.revision.id,
    name: "Revision", sourceKind: "paqo", definitionHash: "a".repeat(64), stepsJson: f.steps }).returning();
  const [qa] = await db.insert(issues).values({ companyId: f.companyId, missionId: f.revision.id, title: "QA", status: "done" }).returning();
  const hash = "b".repeat(64);
  const revisionDelta = { schemaVersion: "mission-revision-delta.v1", sourceWorkflowRunId: f.sourceRun.id,
    base: { workflowDefinitionId: baseTemplate!.id, snapshotHash },
    units: [{ unitId: "compose", operation: "modify", instructions: "요약 톤을 홍보용으로 바꿔라" }] };
  const storePlan = async (delta: Record<string, unknown> | null) => {
    await db.insert(missionPlanArtifacts).values({ companyId: f.companyId, missionId: f.revision.id, revision: 1,
      ownerAgentId: f.agentId, missionGoal: "report", refs: {
        ownerPlanDecision: { decisionHash: hash }, planQa: { issueId: qa!.id, decisionHash: hash },
        paqoWorkflow: { workflowDefinitionId: definition!.id, decisionHash: hash },
        ...(delta ? { revisionDelta: delta } : {}) } });
    await recordMissionPlanQaVerdict({ db, companyId: f.companyId, missionId: f.revision.id, planQaIssueId: qa!.id,
      decisionHash: hash, verdict: "pass", reviewedBy: { actorType: "user", actorId: "local-board" } });
  };
  return { ...f, baseTemplate: baseTemplate!, definition: definition!, snapshotHash, revisionDelta, storePlan };
}
const missionRuns = (missionId: string) => db.select().from(workflowRuns).where(eq(workflowRuns.missionId, missionId));

it("(a) unchanged base definition lets the board start proceed", async () => {
  const w = await approvedDeltaWorld();
  await w.storePlan(w.revisionDelta);
  const run = await createAdmittedWorkflowRun(db, { ...w.input, workflowId: w.definition.id, seedFromRun: undefined }, board);
  expect(run.missionId).toBe(w.revision.id);
  expect((await missionRuns(w.revision.id)).map(r => r.id)).toEqual([run.id]);
});

it.each(["mutated", "deleted"])("(b) %s base definition after approval refuses start with no run created", async mode => {
  const w = await approvedDeltaWorld();
  await w.storePlan(w.revisionDelta);
  if (mode === "mutated") await db.update(workflowDefinitions).set({ stepsJson: [{ id: "collect", name: "Collect v2",
    type: "agent", agentId: w.agentId, dependencies: [] }] }).where(eq(workflowDefinitions.id, w.baseTemplate.id));
  else await db.delete(workflowDefinitions).where(eq(workflowDefinitions.id, w.baseTemplate.id));
  const error = await createAdmittedWorkflowRun(db, { ...w.input, workflowId: w.definition.id, seedFromRun: undefined }, board)
    .then(() => null, (thrown: unknown) => thrown);
  expect(error).toMatchObject({ message: "workflow_revision_base_definition_changed", status: 409,
    details: { requiresReapproval: true, approvedSnapshotHash: w.snapshotHash } });
  expect(await missionRuns(w.revision.id)).toEqual([]);
});

it("legacy revision plan without a stored delta is not subject to the base recheck", async () => {
  const w = await approvedDeltaWorld();
  await w.storePlan(null);
  await db.update(workflowDefinitions).set({ stepsJson: [] }).where(eq(workflowDefinitions.id, w.baseTemplate.id));
  const run = await createAdmittedWorkflowRun(db, { ...w.input, workflowId: w.definition.id, seedFromRun: undefined }, board);
  expect(run.missionId).toBe(w.revision.id);
});

it("(c) double start still creates at most one run alongside the base recheck", async () => {
  const w = await approvedDeltaWorld();
  await w.storePlan(w.revisionDelta);
  const input = { ...w.input, workflowId: w.definition.id, seedFromRun: undefined };
  const results = await Promise.allSettled([
    createAdmittedWorkflowRun(db, input, board),
    createAdmittedWorkflowRun(db, input, board),
  ]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const rejected = results.filter(result => result.status === "rejected");
  expect(rejected).toHaveLength(1);
  expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ message: "workflow_revision_board_start_not_ready" });
  expect(await missionRuns(w.revision.id)).toHaveLength(1);
  await expect(createAdmittedWorkflowRun(db, input, board)).rejects.toThrow("workflow_revision_board_start_not_ready");
  expect(await missionRuns(w.revision.id)).toHaveLength(1);
});

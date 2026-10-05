// server/src/__tests__/mission-revision-tool-recheck.test.ts
//
// [Q7 시작 승인 도구 권한 재검사 — 행동 검사] 수정 미션 board 시작 승인(PLAN-QA pass) 이후,
//   실행 생성 직전(createAdmittedWorkflowRun 미션 트랜잭션 안)에 현재 정의 기준 도구 준비성을
//   engine 과 같은 검사·같은 오류로 다시 대조한다.
// RED) 승인 후 도구 정의 삭제 또는 담당 에이전트 grant 철회 → 생성이 기존 engine 오류 메시지 그대로
//   거절되고 workflowRuns 0건(미생성·롤백)이다 — '생성 시점 권한 재검사' 조건 증명.
// GREEN) 권한 보존 시 기존 admission·seed 물화(workflowRunSeeds 증거 행)가 그대로 성공하고 일반(비
//   seed) admission 도 성공한다 — '오탐 차단 없음' 증명. 실제 공개 경로·실제 격리 DB 사용(모의 없음).
import "./helpers/workflow-control-node-boundary.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentToolGrants, createDb, issues, missionPlanArtifacts, toolDefinitions, workflowDefinitions, workflowRunSeeds, workflowRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { board, seedWorld } from "./helpers/workflow-seed-world.js";
import { createAdmittedWorkflowRun } from "../services/workflow/agent-run-create.js";
import { recordMissionPlanQaVerdict } from "../services/missions/mission-plan-qa-verdicts.js";
import { setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("revision-tool-recheck-"); db = createDb(temp.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "revision-tool-recheck-")));
  // engine 경로와 동일한 준비성 조건: toolNames 스텝은 프로세스에 tool executor 가 설정돼 있어야 시작 가능하다.
  setWorkflowToolStepExecutor(async () => ({ accepted: true })); }, 60000);
afterAll(async () => { setWorkflowToolStepExecutor(null); await temp?.cleanup(); await rm(root, { recursive: true, force: true }); });

// 도구 스텝(agent 담당 + toolNames — PAQO/템플릿 관례)을 가진 paqo 수정 정의 + board 시작 승인까지 마친 세계.
async function approvedToolWorld() {
  const f = await seedWorld(db, root);
  const [tool] = await db.insert(toolDefinitions).values({ companyId: f.companyId, name: "recheck-tool",
    description: "recheck fixture", adapterType: "builtin", adapterConfig: { command: "true" } }).returning();
  await db.insert(agentToolGrants).values({ companyId: f.companyId, agentId: f.agentId, toolId: tool!.id, grantedBy: "local-board" });
  // engine/catalog 오류 라벨은 agentName(있으면) 우선 — 이름 라벨 기대 문구 유지용 선언(식별·판정은 agentId).
  const steps = [
    { id: "revision-write", sourceStepId: "write", name: "Write", type: "agent", agentId: f.agentId, agentName: "Writer", dependencies: [], graphWorkProductRequired: true },
    { id: "revision-check", name: "Check", type: "agent", agentId: f.agentId, agentName: "Writer", dependencies: ["revision-write"], toolNames: ["recheck-tool"] },
  ];
  const [definition] = await db.insert(workflowDefinitions).values({ companyId: f.companyId, missionId: f.revision.id,
    name: "Revision", sourceKind: "paqo", definitionHash: "a".repeat(64), stepsJson: steps }).returning();
  const [qa] = await db.insert(issues).values({ companyId: f.companyId, missionId: f.revision.id, title: "QA", status: "done" }).returning();
  const hash = "b".repeat(64);
  await db.insert(missionPlanArtifacts).values({ companyId: f.companyId, missionId: f.revision.id, revision: 1,
    ownerAgentId: f.agentId, missionGoal: "report", refs: { ownerPlanDecision: { decisionHash: hash },
      planQa: { issueId: qa!.id, decisionHash: hash }, paqoWorkflow: { workflowDefinitionId: definition!.id, decisionHash: hash } } });
  await recordMissionPlanQaVerdict({ db, companyId: f.companyId, missionId: f.revision.id, planQaIssueId: qa!.id,
    decisionHash: hash, verdict: "pass", reviewedBy: { actorType: "user", actorId: "local-board" } });
  const input = { companyId: f.companyId, workflowId: definition!.id, missionId: f.revision.id, triggeredBy: "board",
    seedFromRun: { sourceWorkflowRunId: f.sourceRun.id, stepIds: ["revision-write"] } };
  return { ...f, definition: definition!, tool: tool!, input,
    admit: () => createAdmittedWorkflowRun(db, input, board),
    missionRuns: () => db.select().from(workflowRuns).where(eq(workflowRuns.missionId, f.revision.id)) };
}

it.each(["tool-deleted", "grant-revoked"])
  ("(RED) 승인 후 %s 이면 생성 시점 재검사가 기존 engine 오류로 시작을 거절한다(실행 0건)", async mode => {
    const w = await approvedToolWorld();
    if (mode === "tool-deleted") await db.delete(toolDefinitions).where(eq(toolDefinitions.id, w.tool.id));
    else await db.delete(agentToolGrants).where(eq(agentToolGrants.toolId, w.tool.id));
    const error = await w.admit().then(() => null, (thrown: unknown) => thrown) as Error | null;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe(mode === "tool-deleted"
      ? 'Workflow tool "recheck-tool" is unavailable.'
      : 'Workflow tool "recheck-tool" is not granted to agent "Writer".');
    expect(await w.missionRuns()).toEqual([]);
  });

it("(GREEN) 권한 보존 시 기존 admission·seed 물화가 그대로 성공한다", async () => {
  const w = await approvedToolWorld();
  const run = await w.admit();
  expect(run.missionId).toBe(w.revision.id);
  const [seed] = await db.select().from(workflowRunSeeds).where(eq(workflowRunSeeds.targetRunId, run.id));
  expect(seed).toMatchObject({ companyId: w.companyId, sourceRunId: w.sourceRun.id, targetStepId: "revision-write", sourceStepId: "write" });
  expect((await w.missionRuns()).map(r => r.id)).toEqual([run.id]);
});

it("(GREEN) 일반(비 seed) admission 도 도구 권한 보존 시 그대로 성공한다", async () => {
  const w = await approvedToolWorld();
  const run = await createAdmittedWorkflowRun(db, { ...w.input, seedFromRun: undefined }, board);
  expect(run.missionId).toBe(w.revision.id);
  expect(await db.select().from(workflowRunSeeds).where(eq(workflowRunSeeds.companyId, w.companyId))).toEqual([]);
  expect((await w.missionRuns()).map(r => r.id)).toEqual([run.id]);
});

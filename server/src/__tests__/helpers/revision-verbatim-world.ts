// [수정 재사용 원문 복사 — Task 1 fixture] 검증된 실제 경로만 쓰는 격리 세계.
//   원본 실행: 무이슈 native-tool a1 → 에이전트 a2 완료(실제 입수 생산자+산출물), 중간 QA 실패
//   (실제 toolResult 실패 기록), 최종 QA 미실행. 원본 정의는 workflowService.createDefinition
//   (실제 저장 경로)로 만들어 저장시점 QA 합성이 a2 에 과거 QA back-edge 를 남긴다.
//   수정 실행 계획: a2 만 reuse 마커(신원 전용) → a1 은 클로저로 서버가 추가.
//   B = freshQA(과거 qa-inter ID 승계) → publish → verify(과거 qa-final ID 는 미션 최종 QA 승계).
import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { agents, agentToolGrants, companies, issues, missions, toolDefinitions, workflowDefinitions, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { admittedProducer } from "./admitted-producer.js";
import { workProductService } from "../../services/work-products.js";
import { workflowService } from "../../services/workflow/engine.js";
import { createWorkflowRun } from "../../services/workflow/workflow-store.js";
import { computePaqoDefinitionHash } from "../../services/workflow/paqo-definition-identity.js";
import { missionPlanArtifactService } from "../../services/mission-plan-artifacts.js";
import { submitMissionOwnerPlanDecision } from "../../services/missions/mission-plan-decision-agent-api.js";
import { recordMissionPlanQaVerdict } from "../../services/missions/mission-plan-qa-verdicts.js";
import { board } from "./workflow-seed-world.js";
import type { WorkflowStep } from "../../services/workflow/dag-engine.js";

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

export type VerbatimStep = WorkflowStep & Record<string, unknown>;

export async function registerVerbatimTool(db: Db, companyId: string, name: string) {
  const [tool] = await db.insert(toolDefinitions).values({
    companyId, name, description: "Verbatim fixture tool", adapterType: "builtin", adapterConfig: {}, enabled: true,
  }).returning();
  return tool!;
}

async function writeMissionFile(root: string, missionId: string, runId: string, stepId: string, file: string, bytes: Buffer) {
  const dir = path.join(root, "missions", missionId, "runs", runId, "steps", stepId);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, file);
  await writeFile(target, bytes);
  return { target, sha256: sha256(bytes) };
}

export async function verbatimWorld(db: Db, root: string, options: { a2ConditionalEdge?: boolean } = {}) {
  const companyId = randomUUID(), agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Verbatim", issuePrefix: randomUUID(), workProductRoot: root });
  await db.insert(agents).values({ id: agentId, companyId, name: "Writer", role: "operator", adapterType: "process" });
  for (const name of ["rv-collect", "rv-qa", "rv-publish", "rv-verify"]) await registerVerbatimTool(db, companyId, name);
  const grant = async (name: string) => {
    const [tool] = await db.select().from(toolDefinitions)
      .where(and(eq(toolDefinitions.companyId, companyId), eq(toolDefinitions.name, name))).limit(1);
    await db.insert(agentToolGrants).values({ companyId, agentId, toolId: tool!.id, grantedBy: "local-board" }).onConflictDoNothing();
  };
  for (const name of ["rv-publish", "rv-verify"]) await grant(name);

  // 원본 정의: a1(무이슈 native tool) → a2(에이전트), QA 는 issue-less tool(QA 판정·back-edge 합성 대상).
  //   a2ConditionalEdge: a2 가 dependencies 없이 조건부 성공 연결(when:"success")로만 a1 을 참조하는 변형.
  const a2Step: VerbatimStep = options.a2ConditionalEdge === true
    ? { id: "a2", name: "Write report", type: "agent", agentId, dependencies: [], graphWorkProductRequired: true,
        conditionalDependencies: [{ stepId: "a1", when: "success" }],
        toolArgs: { content: "{$steps.a1.workProductPath}" } }
    : { id: "a2", name: "Write report", type: "agent", agentId, dependencies: ["a1"], graphWorkProductRequired: true,
        toolArgs: { content: "{$steps.a1.workProductPath}" } };
  const sourceSteps: VerbatimStep[] = [
    { id: "a1", name: "Collect sources", type: "tool", agentId: "", dependencies: [], graphWorkProductRequired: false,
      toolNames: ["rv-collect"], toolArgs: { out: "collected.json" } },
    a2Step,
    { id: "qa-inter", name: "Intermediate QA", type: "tool", qaType: "content", agentId: "", dependencies: ["a2"],
      graphWorkProductRequired: false, toolNames: ["rv-qa"], toolArgs: { document: "{$steps.a2.workProductPath}" } },
    { id: "qa-final", name: "Final QA", type: "tool", qaType: "content", agentId: "", dependencies: ["qa-inter"],
      graphWorkProductRequired: false, toolNames: ["rv-qa"] },
  ];
  const definition = await workflowService.createDefinition(db, { companyId, name: "Verbatim source", steps: sourceSteps });
  const [storedSource] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, definition.id)).limit(1);
  const sourceSnapshot = storedSource!.stepsJson as VerbatimStep[]; // 실제 저장 경로가 남긴 정규형(합성 back-edge 포함)

  const [sourceMission] = await db.insert(missions).values({ companyId, ownerAgentId: agentId, title: "Source", status: "completed" }).returning();
  const sourceRun = await createWorkflowRun(db, { companyId, workflowId: definition.id, missionId: sourceMission.id, triggeredBy: "board" });
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, sourceRun.id));

  // a1: 무이슈 native tool 완료 — 실제 도구 산출물 기록(receipt-less toolResult + production-time digest).
  const a1File = await writeMissionFile(root, sourceMission.id, sourceRun.id, "a1", "collected.json", Buffer.from('{"sources":[]}'));
  const a1RequestId = `${sourceRun.id}:a1:1`;
  await db.insert(workflowStepRuns).values({ workflowRunId: sourceRun.id, stepId: "a1", status: "completed",
    issueId: null, lastDispatchRequestId: a1RequestId, startedAt: new Date(), completedAt: new Date(),
    metadata: { toolResult: { requestId: a1RequestId, success: true, artifactPath: a1File.target, artifactSha256: a1File.sha256 } } });

  // a2: 실제 입수 생산자 경로(이슈+승인 생산자+산출물 bytes+sha)로 완료.
  const [a2Issue] = await db.insert(issues).values({ companyId, missionId: sourceMission.id, title: "Write", status: "done" }).returning();
  const [a2Run] = await db.insert(workflowStepRuns).values({ workflowRunId: sourceRun.id, stepId: "a2",
    issueId: a2Issue.id, status: "running", startedAt: new Date() }).returning();
  const heartbeatId = randomUUID();
  await admittedProducer(db, { companyId, agentId, issueId: a2Issue.id, stepRunId: a2Run.id, heartbeatId });
  const a2File = await writeMissionFile(root, sourceMission.id, sourceRun.id, "a2", "content.json", Buffer.from('{"blocks":[]}'));
  await workProductService(db).createForIssue(a2Issue.id, companyId, { provider: "local_file", type: "document",
    title: "content.json", status: "active", createdByRunId: heartbeatId,
    metadata: { path: a2File.target, sha256: a2File.sha256 } });
  await db.update(workflowStepRuns).set({ status: "completed", completedAt: new Date() }).where(eq(workflowStepRuns.id, a2Run.id));

  // 중간 QA 실패(실제 toolResult 실패 기록 — 반복실패 가드의 증거 원천), 최종 QA 는 미실행.
  const qaFailRequestId = `${sourceRun.id}:qa-inter:1`;
  await db.insert(workflowStepRuns).values({ workflowRunId: sourceRun.id, stepId: "qa-inter", status: "failed",
    issueId: null, lastDispatchRequestId: qaFailRequestId, startedAt: new Date(),
    metadata: { toolResult: { requestId: qaFailRequestId, success: false, error: "fixture content rejection" } } });
  await db.update(workflowRuns).set({ status: "failed" }).where(eq(workflowRuns.id, sourceRun.id));

  const [revision] = await db.insert(missions).values({ companyId, ownerAgentId: agentId, title: "Revision", status: "active",
    sourceMissionId: sourceMission.id, sourceWorkflowRunId: sourceRun.id }).returning();
  const [planning] = await db.insert(issues).values({ companyId, missionId: revision.id, title: "PLAN",
    originKind: "mission_main_executor_plan", status: "todo", assigneeAgentId: agentId }).returning();
  await missionPlanArtifactService(db).createInitialMissionPlan({ companyId, missionId: revision.id,
    refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
  const snapshotHash = computePaqoDefinitionHash(sourceSnapshot as Parameters<typeof computePaqoDefinitionHash>[0]);

  const unit = (id: string, title: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id, title, selectionState: "selected", reason: "revision plan unit", assigneeAgentId: agentId,
    sourceRef: { type: "mission_plan_unit", id }, ...extra });
  const authoredUnits = (): Record<string, unknown>[] => [
    { id: "a2", sourceStepId: "a2" }, // A: 신원 전용(구성은 서버가 원본 실행에서 복사)
    unit("qa-inter", "Fresh QA", { type: "qa", qaType: "editorial", sourceStepId: "qa-inter", dependencies: ["a2"] }),
    unit("publish", "Publish report", { toolNames: ["rv-publish"], dependencies: ["qa-inter", "a2"],
      workProductSelectors: { a2: { type: "document", title: "content.json" } },
      toolArgs: { content: "{$steps.a2.workProductPath}" } }),
    unit("verify", "Verify publication", { toolNames: ["rv-verify"], dependencies: ["publish"],
      toolArgs: { review: "{$steps.publish.workProductPath}" } }),
  ];
  const decision = (units: Record<string, unknown>[] = authoredUnits(), revisionDelta: unknown = {
    schemaVersion: "mission-revision-delta.v1", sourceWorkflowRunId: sourceRun.id,
    base: { workflowDefinitionId: definition.id, snapshotHash }, units: deltaUnits(),
  }) =>
    ({ missionId: revision.id, missionGoal: "Report revision", selectedPlanTemplateIds: [], selectedExecutionUnits: units,
      ruleRefs: [], kbRefs: [], requiredInputs: [], successCriteria: [], steps: [], revisionDelta,
      assessment: { objectiveRestatement: "Report revision", availableAssetsReviewed: ["source"],
        assetEvaluation: ["source"], gaps: [], researchPerformed: [] } });

  function deltaUnits(): Array<Record<string, unknown>> {
    return [
      { unitId: "a2", operation: "reuse", sourceStepId: "a2" },
      { unitId: "qa-inter", operation: "add", sourceStepId: "qa-inter" },
      { unitId: "publish", operation: "add" },
      { unitId: "verify", operation: "add" },
    ];
  }

  return {
    companyId, agentId, root, sourceMission, sourceRun, revision, planning, definition,
    sourceSnapshot, snapshotHash, a2File, a1File,
    authoredUnits, deltaUnits, decision,
    submit: (d: Record<string, unknown> = decision()) => submitMissionOwnerPlanDecision({
      db, issue: planning!, actor: { actorType: "agent", actorId: agentId }, decision: d }) as unknown as Promise<Record<string, unknown>>,
    approve: async (result: Record<string, unknown>) => recordMissionPlanQaVerdict({ db, companyId,
      missionId: revision.id, planQaIssueId: result.planQaIssueId as string, decisionHash: result.decisionHash as string,
      verdict: "pass", reviewedBy: { actorType: "user", actorId: "local-board" } }),
    admitStepIds: ["a1", "a2"] as const,
    board,
  };
}

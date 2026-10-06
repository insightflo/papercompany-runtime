// [슬라이스1 공통 fixture] 수정 미션 슬라이스1(R1/R2/R3/R5) 테스트용 격리 세계.
// 공개 제출 경로(submitMissionOwnerPlanDecision → recordMissionOwnerPlanDecisionSubmission
// → 검증/PLAN-QA/물화)만 사용하고 검증기·물화기·외부 도구는 모사하지 않는다.
// 버전 있는 수정 변경안 계약 방향은 이 파일과 테스트에서 한 번만 고정한다(구현은 후속 production work):
//   decision.revisionDelta = {
//     schemaVersion: "mission-revision-delta.v1",
//     sourceWorkflowRunId: 원본 실행(근거),
//     base: { workflowDefinitionId, snapshotHash }: 명시적으로 선택한 현재 템플릿 근거,
//     units: [{ unitId, operation: reuse|rerun|modify|add|clone|blocked, templateStepId?,
//              sourceStepId?, instructions?, interpretedInputs?, requiredInputs? }],
//     capabilityRequirements?: [{ unitId, requiredOutcomeId, toolName, capability }] }
// clone의 templateStepId는 새 유닛을 만드는 재료이며 sourceStepId/재사용 승인이 아니다.
import { and, eq } from "drizzle-orm";
import { agentToolGrants, issues, toolDefinitions, workflowDefinitions, type Db } from "@paperclipai/db";
import { seedWorld } from "./workflow-seed-world.js";
import { legacyHtmlManualContract, legacyHtmlManualPublicationContract } from "./legacy-html-manual.js";
import { buildPaqoWorkflowSteps } from "../../services/mission-owner-plan-decisions.js";
import { computePaqoDefinitionHash } from "../../services/workflow/paqo-definition-identity.js";
import { missionPlanArtifactService } from "../../services/mission-plan-artifacts.js";
import { submitMissionOwnerPlanDecision } from "../../services/missions/mission-plan-decision-agent-api.js";
import { recordMissionPlanQaVerdict } from "../../services/missions/mission-plan-qa-verdicts.js";

export type Slice1SubmitResult = Record<string, unknown>;
export type Slice1Step = { id: string; type?: string; sourceStepId?: string; toolNames?: string[];
  toolArgs?: unknown; workProductSelectors?: Record<string, unknown>; dependencies?: string[] };

export const documentSelector = (title: string) => ({ type: "document" as const, title });
export const slice1PublicationContract = () => legacyHtmlManualPublicationContract("publish.mjs");
export const slice1VerifyContract = () =>
  ({ ...legacyHtmlManualContract("verify.mjs"), role: "publication-verify" as const, consumerParams: { receipt: "qaResultPath" } });
export const diagnosticsOf = (result: Slice1SubmitResult) =>
  (Array.isArray(result.diagnostics) ? result.diagnostics : []) as Array<{ code: string; message: string }>;

export async function registerSlice1Tool(db: Db, companyId: string, name: string,
  adapterConfig: Record<string, unknown>, enabled = true) {
  const [tool] = await db.insert(toolDefinitions).values({ companyId, name, adapterType: "builtin", adapterConfig, enabled }).returning();
  return tool!;
}
export async function grantSlice1Tool(db: Db, companyId: string, agentId: string, toolId: string) {
  await db.insert(agentToolGrants).values({ companyId, agentId, toolId, grantedBy: "local-board" });
}

export const slice1Unit = (agentId: string, id: string, title: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ id, title, selectionState: "selected", reason: "revision plan unit", assigneeAgentId: agentId,
    sourceRef: { type: "mission_plan_unit", id }, ...extra });

export const slice1Decision = (missionId: string, units: Record<string, unknown>[], revisionDelta?: unknown): Record<string, unknown> =>
  ({ missionId, missionGoal: "Report revision", selectedPlanTemplateIds: [], selectedExecutionUnits: units,
    ruleRefs: [], kbRefs: [], requiredInputs: [], successCriteria: [], steps: [],
    ...(revisionDelta === undefined ? {} : { revisionDelta }),
    assessment: { objectiveRestatement: "Report revision", availableAssetsReviewed: ["source"],
      assetEvaluation: ["source"], gaps: [], researchPerformed: [] } });

export async function activePlanRefs(db: Db, companyId: string, missionId: string) {
  const plan = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
  return plan!.refs as Record<string, unknown>;
}
export async function findPaqoDefinition(db: Db, companyId: string, missionId: string) {
  const [row] = await db.select().from(workflowDefinitions).where(and(eq(workflowDefinitions.companyId, companyId),
    eq(workflowDefinitions.missionId, missionId), eq(workflowDefinitions.sourceKind, "paqo")));
  return row ?? null;
}
export const paqoDefinitionSteps = async (db: Db, companyId: string, missionId: string) =>
  ((await findPaqoDefinition(db, companyId, missionId))?.stepsJson ?? []) as unknown as Slice1Step[];
export const openPlanQaIssueIds = async (db: Db, missionId: string) => (await db.select({ id: issues.id }).from(issues)
  .where(and(eq(issues.missionId, missionId), eq(issues.originKind, "mission_plan_qa")))).map(row => row.id);

export async function slice1World(db: Db, root: string, sourceUnits: Record<string, unknown>[],
  currentTemplateSteps: (agentId: string) => unknown[]) {
  const sourceDraft = { missionGoal: "Report", successCriteria: [], steps: [], refs: { selectedExecutionUnits: sourceUnits } };
  const f = await seedWorld(db, root, mission => buildPaqoWorkflowSteps(sourceDraft as never, mission));
  // 커스텀 frozen 그래프는 f.steps(기본 그래프)가 아니라 결정론적 재빌드/w.sourceStep.stepId 로 식별한다.
  const source = buildPaqoWorkflowSteps(sourceDraft as never, f.sourceMission) as unknown as Slice1Step[];
  const templateSteps = currentTemplateSteps(f.agentId);
  const [currentTemplate] = await db.insert(workflowDefinitions).values({ companyId: f.companyId,
    name: `current-${f.revision.id}`, stepsJson: templateSteps }).returning();
  const [planning] = await db.insert(issues).values({ companyId: f.companyId, missionId: f.revision.id, title: "PLAN",
    originKind: "mission_main_executor_plan", status: "todo", assigneeAgentId: f.agentId }).returning();
  await missionPlanArtifactService(db).createInitialMissionPlan({ companyId: f.companyId, missionId: f.revision.id,
    refs: {}, requiredInputs: [], successCriteria: [], steps: [] });
  // 기준 스냅샷 해시는 서버 정규형(computePaqoDefinitionHash — 키 순서 무관)을 그대로 쓴다.
  // jsonb 저장은 객체 키 순서를 바꾸므로 삽입 순서 JSON.stringify 바이트는 서버에서 재현할 수 없다.
  const snapshotHash = computePaqoDefinitionHash(templateSteps as Parameters<typeof computePaqoDefinitionHash>[0]);
  return {
    ...f, source, currentTemplate: currentTemplate!, planning: planning!, snapshotHash,
    delta: (units: Array<Record<string, unknown> & { unitId: string }>, extra: Record<string, unknown> = {}) =>
      ({ schemaVersion: "mission-revision-delta.v1", sourceWorkflowRunId: f.sourceRun.id,
        base: { workflowDefinitionId: currentTemplate!.id, snapshotHash }, units, ...extra }),
    submit: (decision: Record<string, unknown>): Promise<Slice1SubmitResult> =>
      submitMissionOwnerPlanDecision({ db, issue: planning!, actor: { actorType: "agent", actorId: f.agentId }, decision }) as unknown as Promise<Slice1SubmitResult>,
    approve: (result: Slice1SubmitResult) => recordMissionPlanQaVerdict({ db, companyId: f.companyId,
      missionId: f.revision.id, planQaIssueId: result.planQaIssueId as string, decisionHash: result.decisionHash as string,
      verdict: "pass", reviewedBy: { actorType: "user", actorId: "local-board" } }),
  };
}

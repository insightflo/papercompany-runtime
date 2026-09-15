import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agents, companies, heartbeatRuns, issues, missionPlanArtifacts, missionPlanQaVerdicts,
  missionPlanTemplates, missions, qualityPolicyVersions, workflowDefinitions, type Db,
} from "@paperclipai/db";
import type { AddendumCheck, CheckResult, QualityAgentActor } from "@paperclipai/shared";
import { ensurePlanQaReviewIssue } from "../../services/missions/plan-qa-reviewer-assignment.js";
import { recordMissionPlanQaVerdict } from "../../services/missions/mission-plan-qa-verdicts.js";
import {
  buildPlanQaScope, readPlanQaCheck, verifyPlanQaSubmission,
} from "../../services/missions/plan-qa-addendum-gate.js";

const sha = (body: string) => createHash("sha256").update(body).digest("hex");
export const GATE_DECISION_HASH = "c".repeat(64);
const TEMPLATE_BODY = "Gate template body";
export const GATE_CHECK_ID = "check-add";

export type GateWorld = {
  db: Db;
  companyId: string; missionId: string; planArtifactId: string; planningIssueId: string;
  reviewerAgentId: string; ownerAgentId: string; templateId: string; sourceWorkflowId: string;
  planQaIssueId: string; runId: string;
  actor: QualityAgentActor;
};

/** strict 세계: 선택+정책 대상+base 일치 템플릿 1개, 적용 추가 검사 1개(check-add). */
export async function seedGateWorld(db: Db, options?: { policy?: boolean; extraChecks?: AddendumCheck[]; extraTemplateId?: string; maxEvidenceResubmissions?: number }): Promise<GateWorld> {
  const companyId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Gate Co", issuePrefix: `GT${companyId.slice(0, 4)}` });
  const ownerAgentId = randomUUID();
  const reviewerAgentId = randomUUID();
  await db.insert(agents).values([
    { id: ownerAgentId, companyId, name: "Gate Owner", role: "operator", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: false } }, permissions: {} },
    { id: reviewerAgentId, companyId, name: "Gate Reviewer", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: false } }, permissions: {} },
  ]);
  const missionId = randomUUID();
  await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Gate mission", description: "desc", status: "active" });
  const planningIssueId = randomUUID();
  await db.insert(issues).values({ id: planningIssueId, companyId, missionId, title: "Planning", originKind: "mission_main_executor_plan", status: "todo" });
  const sourceWorkflowId = randomUUID();
  await db.insert(workflowDefinitions).values({ id: sourceWorkflowId, companyId, name: "Gate Source", stepsJson: [{ id: "scout", name: "Scout", dependencies: [] }] });
  const templateId = randomUUID();
  await db.insert(missionPlanTemplates).values({ id: templateId, companyId, key: "tpl-gate", name: "Gate", selectionDescription: "Gate", instructions: TEMPLATE_BODY, origin: "company_custom", enabled: true });
  if (options?.extraTemplateId) await db.insert(missionPlanTemplates).values({ id: options.extraTemplateId, companyId, key: "tpl-extra", name: "Unselected", selectionDescription: "other", instructions: "other", origin: "company_custom", enabled: true });
  if (options?.policy !== false) {
    const now = new Date();
    await db.insert(qualityPolicyVersions).values({
      companyId, version: 1,
      definition: {
        targets: [{ companyId, templateId, baseHash: sha(TEMPLATE_BODY), required: [{
          checkId: GATE_CHECK_ID,
          requirementRefs: [{ attachmentId: randomUUID(), sha256: "10".repeat(32) }],
          applicability: { op: "always" }, expectedEvidenceKinds: ["read"], instructions: "추가 검사 지시",
        }, ...(options?.extraChecks ?? [])] }],
        authorAgentIds: [randomUUID()], verifierAgentIds: [randomUUID()], allowedToolIds: [],
        reviewerUserIds: ["quality-reviewer-1"], rollbackUserIds: ["quality-rollback-1"],
        requirementSourceRefs: [{ attachmentId: randomUUID(), sha256: "11".repeat(32) }],
        caseOracleRefs: [{ attachmentId: randomUUID(), sha256: "12".repeat(32) }],
        nativeOwnership: "native-active-plugin-disabled",
        maxActions: 5, maxCandidatesPerAction: 2, maxEvaluationsPerCandidate: 2, maxOuterCycles: 2,
        maxEvidenceResubmissions: options?.maxEvidenceResubmissions ?? 2, maxExecutionAttempts: 4, maxCostCentsPerGroup: 100, maxCostCentsPerPeriod: 1000,
        maxElapsedSeconds: 3600, decisionTtlSeconds: 900, observationSeconds: 86_400, reconcileBatchSize: 10,
        periodStart: now.toISOString(), periodEnd: new Date(now.getTime() + 86_400_000).toISOString(),
      },
      approvedByUserId: "quality-reviewer-1", approvedAt: now, enabledAt: now,
    });
  }
  const [plan] = await db.insert(missionPlanArtifacts).values({
    companyId, missionId, ownerAgentId: ownerAgentId, revision: 1, missionGoal: "Gate goal",
    refs: {
      schemaVersion: 3,
      selectedExecutionUnits: [{ id: "unit-1", kind: "workflow_definition_step", title: "Run scout", selectionState: "selected", reason: "r", sourceRef: { type: "workflow_definition_step", id: sourceWorkflowId, stepId: "scout" } }],
      planTemplates: { selectionSource: "explicit", items: [{ id: templateId, key: "tpl-gate", contentHash: sha(TEMPLATE_BODY) }] },
      ownerPlanDecision: { decisionHash: GATE_DECISION_HASH },
    },
    requiredInputs: [], successCriteria: [], steps: [],
  }).returning({ id: missionPlanArtifacts.id });
  const bound = await ensurePlanQaReviewIssue({
    db, companyId, missionId, missionTitle: "Gate mission", missionDescription: "desc",
    planningIssueId, decisionHash: GATE_DECISION_HASH, missionGoal: "Gate goal",
    preferredReviewerAgentId: reviewerAgentId, enqueuePlanQaWakeup: async () => {}, planArtifactId: plan!.id,
  });
  const runId = await checkoutReviewer(db, { companyId, issueId: bound.id, reviewerAgentId, executionEpoch: 1 });
  return {
    db, companyId, missionId, planArtifactId: plan!.id, planningIssueId, reviewerAgentId, ownerAgentId,
    templateId, sourceWorkflowId, planQaIssueId: bound.id, runId,
    actor: { agentId: reviewerAgentId, companyId, heartbeatRunId: runId, executionEpoch: 1 },
  };
}

export async function checkoutReviewer(db: Db, input: { companyId: string; issueId: string; reviewerAgentId: string; executionEpoch: number; runId?: string }): Promise<string> {
  const runId = input.runId ?? randomUUID();
  await db.insert(heartbeatRuns).values({ id: runId, companyId: input.companyId, agentId: input.reviewerAgentId, issueId: input.issueId, status: "running", executionEpoch: input.executionEpoch, startedAt: new Date() });
  await db.update(issues).set({ status: "in_progress", assigneeAgentId: input.reviewerAgentId, checkoutRunId: runId, executionRunId: runId }).where(eq(issues.id, input.issueId));
  return runId;
}

/** base 판정 기록 + 검사 read + strict v2 검증까지 한 번에 수행한다. */
export async function readAndVerify(
  w: GateWorld,
  base: "pass" | "request_changes",
  statuses: Partial<Record<string, CheckResult["status"]>>,
  options?: { runId?: string; executionEpoch?: number },
): Promise<Awaited<ReturnType<typeof verifyPlanQaSubmission>>> {
  const actor: QualityAgentActor = options?.runId
    ? { ...w.actor, heartbeatRunId: options.runId, executionEpoch: options.executionEpoch ?? 1 }
    : w.actor;
  const scope = await buildPlanQaScope(w.db, { companyId: w.companyId, issueId: w.planQaIssueId, heartbeatRunId: actor.heartbeatRunId, executionEpoch: actor.executionEpoch });
  const read = await readPlanQaCheck(w.db, actor, { issueId: w.planQaIssueId, checkId: GATE_CHECK_ID, pointers: ["/missionId"] });
  await recordMissionPlanQaVerdict({
    db: w.db, companyId: w.companyId, missionId: w.missionId, planQaIssueId: w.planQaIssueId,
    decisionHash: GATE_DECISION_HASH, verdict: base, reviewedBy: { actorType: "agent", actorId: actor.agentId },
    sourceRunId: actor.heartbeatRunId,
  });
  const checks: CheckResult[] = Object.entries(statuses).map(([checkId, status]) => ({ checkId, status: status!, readRef: read.readRef, evidence: [] }));
  return verifyPlanQaSubmission(w.db, actor, { scope, schemaVersion: 2, checks });
}

// server/src/services/quality/native-records.ts
//
// [purpose] T3 정식 mission/run/issue↔조치 연결 원자 생성. 두 조치 종류를 먼저 분기한다.
//   - qa_addendum: 새 mission/agents/oversight/plan artifact + 불변 native 정의/run + 첫 단계/
//     담당 issue/counter/labels + action binding + 감사 행을 한 트랜잭션에 만든다.
//   - current_output: 새 실행을 만들지 않고 원본 정식 실행·현재 producer/QA binding 을
//     검증해 연결한다. terminal 원본은 원본 유지로 거절한다(쓰기 없음).
// [ordering] §3.3 고정: 정책 사용량 → group → action 잠금 → 승인/effect 확인 → 기존 binding
//   정확한 join 재조회 → 새 기록 → CAS binding → 감사 행. zero-row CAS 면 전체 rollback.
// [boundary] 깨우기·trigger()·working.md 준비는 이 트랜잭션 밖(커밋 전 이벤트·파일·깨우기 금지).
//   원본 mission ID/parentRunId 를 새 실행 소유 연결로 쓰지 않는다.

import { randomUUID } from "node:crypto";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  missions,
  qualityActionGroups,
  qualityActions,
  qualityPolicyUsage,
  qualityPolicyVersions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  qualityEffectSchema,
  qualityKeySchema,
  qualityPolicySchema,
  retryEnvelopeSchema,
  qualityTargetSchema,
  type NativeBinding,
  type QualityKey,
  type SourceAttempt,
} from "@paperclipai/shared";
import { conflict, HttpError, notFound } from "../../errors.js";
import { instanceSettingsService } from "../instance-settings.js";
import { createIssueRecord } from "../issue-create-records.js";
import { insertActivityRecord } from "../activity-log-records.js";
import { missionPlanArtifactService } from "../mission-plan-artifacts.js";
import { addMissionAgentRecord, createMissionRecord } from "../missions/mission-create-records.js";
import { bindWorkflowStepIssueRecord, createWorkflowStepRunRecord, verifyCanonicalBindingJoin } from "../workflow/workflow-step-issue-records.js";
import type { WorkflowStep } from "../workflow/dag-engine.js";
import { loadLatestQaRemediations } from "../workflow/validation-verdict-ledger.js";
import { hashContract, parseEvidence } from "./contract.js";
import { assertPolicyTargets, type QualityTx } from "./targets.js";
import { verifySourceAttempt } from "./evidence-verifier.js";
import {
  buildQualityExecutionSteps,
  findOrCreateImmutableQualityWorkflowDefinition,
  QUALITY_EXECUTE_STEP_ID,
  reverifyQualityDefinitionForRun,
} from "./native-definition.js";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function ensureCanonicalQualityExecution(db: Db, key: QualityKey): Promise<NativeBinding> {
  return db.transaction(tx => createCanonicalQualityExecutionInTransaction(tx, key));
}

export async function createCanonicalQualityExecutionInTransaction(tx: Tx, key: QualityKey): Promise<NativeBinding> {
  const parsed = parseEvidence(qualityKeySchema, key);
  // 잠금 순서에 필요한 최소 사전 읽기(잠금 없음) → §3.3 순서로 잠근다.
  const [pre] = await tx.select({ groupId: qualityActions.groupId, policyVersionId: qualityActions.policyVersionId })
    .from(qualityActions).where(and(eq(qualityActions.companyId, parsed.companyId), eq(qualityActions.id, parsed.actionId)));
  if (!pre) throw notFound("quality_action_not_found");
  await tx.select({ id: qualityPolicyUsage.id }).from(qualityPolicyUsage)
    .where(and(eq(qualityPolicyUsage.companyId, parsed.companyId), eq(qualityPolicyUsage.policyVersionId, pre.policyVersionId)))
    .orderBy(asc(qualityPolicyUsage.windowStart), asc(qualityPolicyUsage.id)).for("update");
  const [group] = await tx.select({ id: qualityActionGroups.id }).from(qualityActionGroups)
    .where(and(eq(qualityActionGroups.companyId, parsed.companyId), eq(qualityActionGroups.id, pre.groupId))).for("update");
  if (!group) throw notFound("quality_group_not_found");
  const [action] = await tx.select().from(qualityActions)
    .where(and(eq(qualityActions.companyId, parsed.companyId), eq(qualityActions.id, parsed.actionId))).for("update");
  if (!action) throw notFound("quality_action_not_found");

  // 현재 승인/effect 확인: 고정 계약 무결성 + 취소 여부 + 정책 활성·기간.
  const target = parseEvidence(qualityTargetSchema, action.target);
  const effect = parseEvidence(qualityEffectSchema, action.effect);
  const envelope = parseEvidence(retryEnvelopeSchema, action.retryEnvelope);
  if (hashContract(target) !== action.targetHash || hashContract(effect) !== action.effectHash
    || envelope.targetHash !== action.targetHash || envelope.effectHash !== action.effectHash
    || envelope.intentKey !== action.intentKey || envelope.groupId !== action.groupId || envelope.policyVersionId !== action.policyVersionId) {
    throw conflict("quality_action_contract_mismatch");
  }
  if (action.cancelRequestedAt) throw conflict("quality_action_cancelled");
  const [policyRow] = await tx.select().from(qualityPolicyVersions)
    .where(and(eq(qualityPolicyVersions.companyId, parsed.companyId), eq(qualityPolicyVersions.id, action.policyVersionId))).for("share");
  if (!policyRow || !policyRow.approvedAt || !policyRow.enabledAt || policyRow.disabledAt) throw conflict("quality_policy_inactive");
  const policy = parseEvidence(qualityPolicySchema, policyRow.definition);
  const now = new Date();
  if (now < new Date(policy.periodStart) || now >= new Date(policy.periodEnd)) throw conflict("quality_policy_outside_period");

  // 기존 binding 재사용: join 재조회 + 원본 재검증(qa_addendum=불변 정의 해시, current_output=원본 시도 — 교체/terminal 전환은 재전달 시점에도 거부, §10.2).
  if (action.canonicalBinding) {
    const binding = action.canonicalBinding;
    if (action.kind === "qa_addendum") {
      await reverifyQualityDefinitionForRun(tx, { companyId: parsed.companyId, workflowRunId: binding.workflowRunId });
    } else if (action.kind === "current_output") {
      await reverifyCurrentOutputSource(tx, parsed.companyId, action.target);
    }
    await verifyCanonicalBindingJoin(tx, binding);
    return binding;
  }

  return action.kind === "qa_addendum"
    ? await createAddendumBinding(tx, { key: parsed, action: { ...action, target, effect, retryEnvelope: envelope, policyVersionId: action.policyVersionId }, policy })
    : await bindCurrentOutputExecution(tx, { key: parsed, action: { ...action, target, effect, policyVersionId: action.policyVersionId } });
}

type LockedAction = { id: string; companyId: string; policyVersionId: string; intentKey: string; target: ReturnType<typeof qualityTargetSchema.parse>; effect: ReturnType<typeof qualityEffectSchema.parse>; retryEnvelope?: ReturnType<typeof retryEnvelopeSchema.parse> };

async function createAddendumBinding(tx: Tx, input: { key: QualityKey; action: LockedAction; policy: ReturnType<typeof qualityPolicySchema.parse> }): Promise<NativeBinding> {
  const { key, action, policy } = input;
  if (action.target.kind !== "qa_addendum") throw conflict("quality_action_kind_mismatch");
  await assertPolicyTargets(tx, key.companyId, policy);
  const ownerAgentId = policy.authorAgentIds[0]!;
  const [owner] = await tx.select({ id: agents.id, status: agents.status }).from(agents)
    .where(and(eq(agents.companyId, key.companyId), eq(agents.id, ownerAgentId))).for("share");
  if (!owner || !["active", "idle", "running"].includes(owner.status)) throw conflict("quality_policy_agent_unavailable");

  const isolatedWorkspacesEnabled = (await instanceSettingsService(tx as unknown as Db).getExperimental()).enableIsolatedWorkspaces;
  const title = `Quality addendum execution ${action.intentKey}`;
  const mission = await createMissionRecord(tx, {
    companyId: key.companyId, ownerAgentId, title,
    description: `Created automatically for quality action: ${action.intentKey}`,
    projectId: null, goalId: null, status: "active",
  });
  await addMissionAgentRecord(tx, { missionId: mission.id, agentId: ownerAgentId, role: "executor" });
  for (const verifierAgentId of policy.verifierAgentIds) {
    await addMissionAgentRecord(tx, { missionId: mission.id, agentId: verifierAgentId, role: "reviewer", skipDuplicate: true });
  }
  const oversight = await createIssueRecord(tx, key.companyId, {
    assigneeAgentId: ownerAgentId, missionId: mission.id,
    title: `[OVERSIGHT] ${title}`,
    description: "Monitor the fixed quality execution and keep it within the approved policy.",
    originKind: "mission_main_executor_oversight", priority: "medium", status: "todo",
  }, isolatedWorkspacesEnabled);
  await missionPlanArtifactService(tx as unknown as Db).createInitialMissionPlan({
    companyId: key.companyId, missionId: mission.id,
    refs: { qualityActionId: action.id, intentKey: action.intentKey, oversightIssueId: oversight.id },
    assumptions: [], requiredInputs: [], risks: [],
    successCriteria: [
      { description: "The execution stays inside the approved policy limits." },
      { description: "Completion is decided only by structured verification evidence." },
    ],
    steps: [{ id: QUALITY_EXECUTE_STEP_ID, title: "Quality execution", status: "planned", intendedRole: "mission_owner" }],
  });

  const steps = buildQualityExecutionSteps({ actionIntentKey: action.intentKey, ownerAgentId, target: action.target, policy });
  const definition = await findOrCreateImmutableQualityWorkflowDefinition(tx, { companyId: key.companyId, missionId: mission.id, steps });
  const [run] = await tx.insert(workflowRuns).values({
    id: randomUUID(), companyId: key.companyId, workflowId: definition.id, missionId: mission.id,
    status: "pending", triggeredBy: "quality",
    metadata: { qualityActionId: action.id, intentKey: action.intentKey, policyVersionId: action.policyVersionId },
  }).returning();
  const stepRun = await createWorkflowStepRunRecord(tx, {
    workflowRunId: run!.id, stepId: QUALITY_EXECUTE_STEP_ID,
    metadata: { qualityActionId: action.id },
  });
  const stepIssue = await createIssueRecord(tx, key.companyId, {
    title: steps[0]!.name!, description: steps[0]!.description ?? null,
    status: "todo", assigneeAgentId: ownerAgentId, missionId: mission.id,
    originKind: "workflow_execution", originId: run!.id, originRunId: run!.id, labelIds: [],
  }, isolatedWorkspacesEnabled);
  await bindWorkflowStepIssueRecord(tx, { companyId: key.companyId, stepRunId: stepRun.id, issueId: stepIssue.id });

  return finalizeBinding(tx, {
    companyId: key.companyId, actionId: action.id,
    missionId: mission.id, workflowRunId: run!.id, stepRunId: stepRun.id, issueId: stepIssue.id,
    details: { definitionHash: definition.definitionHash },
  });
}

/** current_output: 원본 정식 실행·QA binding 검증 후 연결. terminal 원본은 원본 유지로 거절. */
async function bindCurrentOutputExecution(tx: Tx, input: { key: QualityKey; action: LockedAction }): Promise<NativeBinding> {
  const { key, action } = input;
  const source = await reverifyCurrentOutputSource(tx, key.companyId, action.target);
  if (source.mission.kind !== "mission" || source.workflow.kind !== "workflow_step") throw conflict("quality_current_output_binding_unavailable");
  // 현재 producer/QA binding: 같은 실행 안의 QA step verdict 가 schema-검증 remediation 을
  // 가지고 있어야 한다(loadLatestQaRemediations — 구조화 계약만, 문장 아님).
  const verdicts = await tx.select({ issueId: workflowTransitionEvents.issueId, stepRunId: workflowTransitionEvents.workflowStepRunId })
    .from(workflowTransitionEvents)
    .where(and(
      eq(workflowTransitionEvents.companyId, key.companyId),
      eq(workflowTransitionEvents.workflowRunId, source.workflow.runId),
      eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
      eq(workflowTransitionEvents.verdict, "request_changes"),
      isNotNull(workflowTransitionEvents.heartbeatRunId),
    ))
    .orderBy(asc(workflowTransitionEvents.createdAt), asc(workflowTransitionEvents.id));
  let qaBinding: { stepRunId: string; issueId: string } | null = null;
  for (const verdict of verdicts) {
    if (!verdict.issueId || !verdict.stepRunId || verdict.stepRunId === source.workflow.stepRunId) continue;
    const loaded = await loadLatestQaRemediations({ db: tx as unknown as Db, companyId: key.companyId, issueId: verdict.issueId });
    if (loaded && loaded.workflowStepRunId === verdict.stepRunId) {
      qaBinding = { stepRunId: verdict.stepRunId, issueId: verdict.issueId };
      break;
    }
  }
  if (!qaBinding) throw conflict("quality_current_output_binding_unavailable");
  const [qaStep] = await tx.select({ id: workflowStepRuns.id, issueId: workflowStepRuns.issueId })
    .from(workflowStepRuns).where(and(eq(workflowStepRuns.id, qaBinding.stepRunId), eq(workflowStepRuns.workflowRunId, source.workflow.runId))).for("share");
  if (!qaStep || qaStep.issueId !== qaBinding.issueId) throw conflict("quality_current_output_binding_unavailable");

  return finalizeBinding(tx, {
    companyId: key.companyId, actionId: action.id,
    missionId: source.mission.id, workflowRunId: source.workflow.runId,
    stepRunId: qaBinding.stepRunId, issueId: qaBinding.issueId,
    details: { kind: "current_output" },
  });
}

const TERMINAL_MISSION = new Set(["completed", "cancelled"]);
const TERMINAL_RUN = new Set(["completed", "cancelled", "aborted", "failed", "timed-out"]);

/** current_output 원본 검증(최초 binding·재전달 공통 기준): terminal 원본은 원본 유지로 먼저 거절(§4)하고, 승인 원본 시도가 DB 와 정확히 일치해야 한다(A→B 교체 실패, §10.2). */
async function reverifyCurrentOutputSource(tx: Tx, companyId: string, rawTarget: unknown): Promise<SourceAttempt> {
  const target = parseEvidence(qualityTargetSchema, rawTarget);
  if (target.kind !== "current_output") throw conflict("quality_action_kind_mismatch");
  const source = target.source;
  const [missionRow] = source.mission.kind === "mission"
    ? await tx.select({ status: missions.status }).from(missions).where(and(eq(missions.companyId, companyId), eq(missions.id, source.mission.id))).for("share")
    : [undefined];
  const [runRow] = source.workflow.kind === "workflow_step"
    ? await tx.select({ status: workflowRuns.status }).from(workflowRuns).where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.id, source.workflow.runId))).for("share")
    : [undefined];
  if ((missionRow && TERMINAL_MISSION.has(missionRow.status)) || (runRow && TERMINAL_RUN.has(runRow.status ?? ""))) throw conflict("quality_source_preserved");
  if (source.mission.kind !== "mission" || source.workflow.kind !== "workflow_step") throw conflict("quality_current_output_binding_unavailable");
  try { await verifySourceAttempt(tx, companyId, source); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("quality_")) throw conflict("quality_current_output_binding_unavailable");
    throw error;
  }
  return source;
}

/** CAS binding(0행이면 재조회, join 실패면 rollback) + 감사 행. 원본 상태는 건드리지 않는다. */
async function finalizeBinding(tx: Tx, input: {
  companyId: string; actionId: string; missionId: string; workflowRunId: string; stepRunId: string; issueId: string; details: Record<string, unknown>;
}): Promise<NativeBinding> {
  const binding: NativeBinding = {
    companyId: input.companyId, actionId: input.actionId, missionId: input.missionId,
    workflowRunId: input.workflowRunId, stepRunId: input.stepRunId, issueId: input.issueId,
  };
  const rows = await tx.update(qualityActions).set({ canonicalBinding: binding, state: "bound", updatedAt: new Date() })
    .where(and(eq(qualityActions.companyId, input.companyId), eq(qualityActions.id, input.actionId), isNull(qualityActions.canonicalBinding)))
    .returning({ id: qualityActions.id });
  if (rows.length === 0) {
    // 동시 커밋 승자가 있다: 같은 조치의 저장 binding 을 정확한 join 으로 재조회해 반환.
    const [settled] = await tx.select({ canonicalBinding: qualityActions.canonicalBinding }).from(qualityActions)
      .where(and(eq(qualityActions.companyId, input.companyId), eq(qualityActions.id, input.actionId)));
    if (!settled?.canonicalBinding) throw conflict("quality_canonical_binding_conflict");
    await verifyCanonicalBindingJoin(tx, settled.canonicalBinding);
    return settled.canonicalBinding;
  }
  await verifyCanonicalBindingJoin(tx, binding);
  await insertActivityRecord(tx as unknown as Db, {
    companyId: input.companyId, actorType: "system", actorId: "quality",
    action: "quality.canonical_execution_bound", entityType: "quality_action", entityId: input.actionId,
    details: { missionId: input.missionId, workflowRunId: input.workflowRunId, stepRunId: input.stepRunId, issueId: input.issueId, ...input.details },
  });
  return binding;
}

export type { QualityTx };

/**
 * [T3 Quality DAG 계약] 이슈 생성+step 연결을 한 트랜잭션으로 commit 하고 그 후 깨우기 부작용을 적용한다.
 * 동시 sync 가 이미 연결했다면(CAS conflict) 그 경로가 깨웠으므로 스킵한다. createStepIssue 는
 * dag-engine 의 생성 함수를 주입받아 생성 로직의 단일점을 유지한다.
 */
export async function syncQualityStepIssueCommitBeforeWake(
  db: Db,
  context: { run: typeof workflowRuns.$inferSelect; definition: typeof workflowDefinitions.$inferSelect; step: WorkflowStep; stepRunId: string },
  createStepIssue: (input: {
    db: Db; run: typeof workflowRuns.$inferSelect; definition: typeof workflowDefinitions.$inferSelect; step: WorkflowStep;
    deferredSideEffectsDb: Db; captureDeferredSideEffects: (apply: () => Promise<void>) => void;
  }) => Promise<string | null>,
): Promise<void> {
  let deferredWake: (() => Promise<void>) | null = null;
  let boundIssueId: string | null = null;
  try {
    boundIssueId = await db.transaction(async (tx) => {
      const issueId = await createStepIssue({
        db: tx as unknown as Db, run: context.run, definition: context.definition, step: context.step,
        deferredSideEffectsDb: db, captureDeferredSideEffects: (apply) => { deferredWake = apply; },
      });
      if (!issueId) return null;
      await bindWorkflowStepIssueRecord(tx as unknown as Db, { companyId: context.run.companyId, stepRunId: context.stepRunId, issueId });
      return issueId;
    });
  } catch (error) {
    if (error instanceof HttpError && error.message === "quality_step_issue_binding_conflict") return;
    throw error;
  }
  if (boundIssueId) await deferredWake!();
}

import { and, eq, inArray } from "drizzle-orm";
import { companies, issueWorkProducts, workflowResumeExecutions, workflowResumeRequests, type Db } from "@paperclipai/db";
import { ZodError } from "zod";
import { badRequest, HttpError, notFound } from "../../../errors.js";
import type { ResumePreview as PublicResumePreview } from "@paperclipai/shared/types/workflow-resume";
import type { WorkflowStep } from "../dag-engine.js";
import { checkStepEligibility } from "./eligibility.js";
import { forwardReachable } from "./graph.js";
import { buildGraphNodes, kindOf } from "./preview-graph.js";
import { projectResumePreview } from "./public-views.js";
import type { ResumeExecutionHistoryScope } from "./read-model.js";
import {
  readResumeMissionWorkspaceHistory,
  type ResumeWorkspaceMissionHistory,
} from "./read-model-workspaces.js";
import {
  budgetBlockers,
  buildSnapshotState,
  recordedCheckerBlockers,
  stepFactsFor,
  wholeMissionBlockers,
  type ResumePreviewBlocker,
  type SnapshotStateFacts,
} from "./preview-facts.js";
import {
  effectForStep,
  generationPossible,
  loadResumedPolicy,
} from "./preview-policy.js";
import { signSnapshot } from "./snapshot.js";
import { snapshotScopeSchema, type SnapshotState } from "./snapshot-state.js";

/**
 * [파일 목적] Task6a SELECT-only resume preview 서비스 — 실제 REPEATABLE READ READ ONLY 트랜잭션
 *   안에서 whole-mission 이력·검토 정책·예산·기록 checker 근거로 SnapshotState/HMAC 토큰 조립.
 * [명시적 한계 — 이 preview 는 목표 인수가 아니다] 외부 predecessor 내구 산출물 검증기가 미연결이라
 *   모든 outside predecessor 에 missing_evidence, evidence 는 항상 [](metadata 해시/agent JSON 을
 *   검증으로 인정하지 않는다 — 미완성 통합). REVIEWED_RESUME_POLICIES 미검토 시 external_effect_unknown
 *   fail-closed. apply/dispatcher 와 POST route 는 이후 슬라이스다. Catch 는 알려진 오류만 — DB 실패를
 *   광역 마스킹하지 않는다. scope 부재 404, 잘못된 입력 400.
 */

const SNAPSHOT_TTL_MS = 300_000;

const ELIGIBILITY_MESSAGES: Readonly<Record<string, string>> = {
  unsupported_status: "스텝 상태가 재개 대상이 아닙니다",
  active_work: "스텝에 활성 실행/소유권이 남아 있습니다",
  executed_step: "스텝이 이미 실행 흔적을 가지고 있어 재개 대상이 아닙니다",
  external_effect_unknown: "스텝의 외부 효과가 검토되지 않아 확정할 수 없습니다",
  control_tool_effects_unverified: "제어 스텝의 도구 효과가 검증되지 않았습니다",
};

export interface ResumePreview {
  schemaVersion: 1;
  scope: ResumeExecutionHistoryScope;
  definitionHash: string | null;
  eligible: boolean;
  blockers: ResumePreviewBlocker[];
  affectedStepIds: string[];
  preservedStepIds: string[];
  generationPossible: boolean;
  token: string | null;
  expiresAt: string | null;
}

export interface ResumePreviewResult {
  preview: ResumePreview;
  publicPreview: PublicResumePreview;
  state: SnapshotState | null;
}

export interface ResumeSnapshotSigner {
  key: Buffer;
  now(): Date;
}

/** 실제 REPEATABLE READ READ ONLY 트랜잭션으로 preview 를 조립한다(쓰기 불가 세션). */
export function previewResume(
  db: Db,
  scope: ResumeExecutionHistoryScope,
  signer: ResumeSnapshotSigner,
): Promise<ResumePreviewResult> {
  return db.transaction(
    (tx) => assembleResumePreview(tx, scope, signer),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

function blockedPreview(
  scope: ResumeExecutionHistoryScope,
  blockers: ResumePreviewBlocker[],
  definitionHash: string | null,
): ResumePreviewResult {
  return previewResult({
    schemaVersion: 1, scope, definitionHash, eligible: false, blockers,
    affectedStepIds: [], preservedStepIds: [], generationPossible: true,
    token: null, expiresAt: null,
  }, [], null, "unknown");
}

function previewResult(
  preview: ResumePreview,
  frozenSteps: WorkflowStep[],
  state: SnapshotState | null,
  budget: PublicResumePreview["budget"],
): ResumePreviewResult {
  return { preview, state, publicPreview: projectResumePreview({ preview, frozenSteps, state, budget }) };
}

function previewBlocker(code: string, message: string, detail: Record<string, unknown>): ResumePreviewBlocker {
  return { code, message, detail };
}

/** 트랜잭션을 시작하지 않는 조립 본체 — upcoming locked apply 재검증에서 재사용한다. */
export async function assembleResumePreview(
  tx: Pick<Db, "select">,
  scope: ResumeExecutionHistoryScope,
  signer: ResumeSnapshotSigner,
): Promise<ResumePreviewResult> {
  let validated: ResumeExecutionHistoryScope;
  try {
    validated = snapshotScopeSchema.parse(scope);
  } catch (error) {
    if (error instanceof ZodError) throw badRequest("Invalid resume scope");
    throw error;
  }

  let history: ResumeWorkspaceMissionHistory;
  try {
    history = await readResumeMissionWorkspaceHistory(tx, validated);
  } catch (error) {
    if (error instanceof HttpError && error.message === "historical_definition_unproven") {
      return blockedPreview(validated, [previewBlocker("historical_definition_unproven",
        "실행 시점의 불변 실행정의 스냅샷이 없어 재개 근거를 확정할 수 없습니다", {})], null);
    }
    throw error;
  }
  const definition = history.selected.definition;
  if (definition.executionMode !== "static_dag") {
    return blockedPreview(validated, [previewBlocker("unsupported_graph",
      "동적 실행 모드는 재개 그래프로 지원하지 않습니다", { executionMode: definition.executionMode })],
      definition.definitionHash);
  }
  const frozenSteps = definition.steps;
  let affected: string[];
  try {
    affected = forwardReachable(buildGraphNodes(frozenSteps), validated.startStepId);
  } catch (error) {
    if (error instanceof Error && error.message === "unsupported_graph") {
      return blockedPreview(validated, [previewBlocker("unsupported_graph",
        "정의 그래프가 정적 DAG 요건(사이클/미지 간선)을 충족하지 않습니다", {})], definition.definitionHash);
    }
    throw error;
  }
  const affectedSet = new Set(affected);
  const preserved = frozenSteps.map((step) => step.id).filter((stepId) => !affectedSet.has(stepId)).sort();

  const [company] = await tx.select().from(companies)
    .where(eq(companies.id, validated.companyId)).limit(1);
  if (!company) throw notFound("Company not found");
  const companyBudgetBlockers = budgetBlockers(company);
  const budget = companyBudgetBlockers.some((blocker) => blocker.code === "budget_unknown") ? "unknown" : "verified";

  const policyView = await loadResumedPolicy(tx, validated.companyId, definition.definitionHash);
  const requestRows = await tx.select().from(workflowResumeRequests)
    .where(and(
      eq(workflowResumeRequests.companyId, validated.companyId),
      eq(workflowResumeRequests.missionId, validated.missionId),
    )).orderBy(workflowResumeRequests.id);
  const executionRows = await tx.select().from(workflowResumeExecutions)
    .where(and(
      eq(workflowResumeExecutions.companyId, validated.companyId),
      eq(workflowResumeExecutions.missionId, validated.missionId),
    )).orderBy(workflowResumeExecutions.id);

  const frozenById = new Map(frozenSteps.map((step) => [step.id, step]));
  const stepRowByStepId = new Map(history.selected.steps.map((row) => [row.stepId, row]));

  // outside predecessor = affected 바깥에서 affected 로 들어오는 진입(union dependencies).
  const outside = new Set<string>();
  for (const stepId of affected) {
    const step = frozenById.get(stepId)!;
    for (const dep of step.dependencies ?? []) if (!affectedSet.has(dep)) outside.add(dep);
    for (const edge of step.conditionalDependencies ?? []) if (!affectedSet.has(edge.stepId)) outside.add(edge.stepId);
  }

  const productIssueIds = [...new Set([
    ...history.selected.steps.map((row) => row.issueId),
    ...[...outside].map((stepId) => stepRowByStepId.get(stepId)?.issueId ?? null),
  ].filter((id): id is string => id !== null))].sort();
  const workProducts = productIssueIds.length === 0 ? [] : await tx.select().from(issueWorkProducts)
    .where(and(
      eq(issueWorkProducts.companyId, validated.companyId),
      inArray(issueWorkProducts.issueId, productIssueIds),
    )).orderBy(issueWorkProducts.id);
  const issueIdsWithProducts = new Set(workProducts.map((row) => row.issueId));

  const blockers: ResumePreviewBlocker[] = [
    ...wholeMissionBlockers(history, requestRows, executionRows),
    ...recordedCheckerBlockers(history),
    ...companyBudgetBlockers,
  ];
  if (policyView.policyMissing) {
    blockers.push(previewBlocker("external_effect_unknown",
      "검토된 resume 정책 매니페스트가 없어 도구 효과/publication 매핑을 확정할 수 없습니다", {}));
  }
  if (policyView.policy !== null) {
    const bypassed = policyView.policy.requiredGateStepIds.filter((stepId) => !affectedSet.has(stepId));
    if (bypassed.length > 0) {
      blockers.push(previewBlocker("required_gate_bypass",
        "필수 게이트 스텝이 재개 대상 집합에 없습니다(이전 승인 함축 금지)", { stepIds: bypassed.sort() }));
    }
  }

  for (const stepId of affected) {
    const frozen = frozenById.get(stepId)!;
    const kind = kindOf(frozen);
    if (kind === null) {
      blockers.push(previewBlocker("unsupported_graph", "지원하지 않는 step 유형입니다", { stepId }));
      continue;
    }
    const row = stepRowByStepId.get(stepId)!;
    const facts = stepFactsFor(row, kind, effectForStep(frozen, policyView), history);
    if (row.issueId !== null && issueIdsWithProducts.has(row.issueId)) facts.hasExternalResult = true;
    const perStep = checkStepEligibility(facts);
    if (perStep !== null) {
      blockers.push(previewBlocker(perStep, ELIGIBILITY_MESSAGES[perStep] ?? "스텝이 재개 요건을 충족하지 않습니다", { stepId }));
    }
  }

  for (const stepId of [...outside].sort()) {
    const row = stepRowByStepId.get(stepId);
    if (!row || row.status !== "completed") {
      blockers.push(previewBlocker("outside_predecessor_invalid",
        "재개 대상 밖 선행 스텝이 완료 상태가 아닙니다", { stepId }));
    }
    // [명시적 미완성 통합] 내구 검증기 미연결 — 근거 유무와 무관하게 항상 missing_evidence.
    blockers.push(previewBlocker("missing_evidence", "선행 스텝의 내구 산출물이 아직 검증되지 않았습니다", { stepId }));
  }

  const facts: SnapshotStateFacts = {
    company, workProducts, requests: requestRows, executions: executionRows,
    registryRows: policyView.registryRows, policy: policyView.policy,
  };
  const state = buildSnapshotState(history, validated, affected, facts, blockers);

  if (blockers.length > 0) {
    return previewResult({
      schemaVersion: 1, scope: validated, definitionHash: definition.definitionHash,
      eligible: false, blockers, affectedStepIds: affected, preservedStepIds: preserved,
      generationPossible: generationPossible(policyView.policy, affected),
      token: null, expiresAt: null,
    }, frozenSteps, state, budget);
  }

  const now = signer.now();
  const token = signSnapshot(state, signer.key, now);
  return previewResult({
    schemaVersion: 1, scope: validated, definitionHash: definition.definitionHash,
    eligible: true, blockers: [], affectedStepIds: affected, preservedStepIds: preserved,
    generationPossible: generationPossible(policyView.policy, affected),
    token, expiresAt: new Date(now.getTime() + SNAPSHOT_TTL_MS).toISOString(),
  }, frozenSteps, state, budget);
}


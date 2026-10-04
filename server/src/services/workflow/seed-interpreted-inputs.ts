// server/src/services/workflow/seed-interpreted-inputs.ts
//
// [수정 변경맵 Q11 — 실제 해석 입력 무효화] seed 승인의 설정 해시는 선언된 toolArgs 토큰까지 같으면
// 통과한다. 그러나 tool-step-args.ts 는 실행 시점에 {$steps.*}/{$runMetadata.*}/{$childInputs.*} 토큰을
// 실제 기록(생산 산출물·run metadata)으로 해석하므로 같은 토큰 설정과 다른 실제 값이 가능하다.
// (1) 승인 때 같은 해석 기계(resolveWorkflowToolStepArgs·selectOfficialWorkProduct)로 소비 스텝의 실제
// 인자값을 원본 run 좌표에서 렌더해 증거에 바인딩하고, (2) 실행 시점 핀(workflowStepOutputBindings)이
// 가리키던 산출물과 지금 해석이 어긋나거나 run metadata 실제 값이 다르면, 의존관계로 유도한 영향
// 집합(서버 계산)과 함께 구조적 사유(workflow_seed_interpreted_input_mismatch)로 재사용을 거절한다.
// 토큰 리터럴은 tool-step-args.ts 와 동일하게 유지하고 prose 는 절대 파싱하지 않는다.
// 토큰 없는 스텝은 기존 게이트 그대로다(완화 없음).
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { issueWorkProducts, workflowRuns, workflowStepOutputBindings, type Db } from "@paperclipai/db";
import { workProductSelectorsSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { hashStructuredValue } from "../issue-execution-cards/hash.js";
import { resolveWorkProductLocalFilePath } from "../work-products.js";
import { resolveEdges } from "./control-flow/edge-condition.js";
import { resolveWorkflowToolStepArgs, stringifyWorkflowRunMetadataValue } from "./tool-step-args.js";
import { selectOfficialWorkProduct } from "./workproduct-selector.js";
import { seedError } from "./workflow-seed-evidence.js";
import type { RevisionStep } from "./revision-step-config.js";

const STEP_ARTIFACT_TOKEN = /\{\$steps\.([A-Za-z0-9_-]+)\.(workProductPath|workProductDir|siblingAssetsDir)\}/g;
const RUN_METADATA_TOKEN = /\{\$runMetadata\.([A-Za-z0-9_]+)\}/g;
const CHILD_INPUTS_TOKEN = /\{\$childInputs\.([A-Za-z0-9_]+)\}/g;

export const INTERPRETED_INPUT_BINDING_VERSION = "workflow.seed.interpreted-inputs.v1";

export type SeedInterpretedInputBinding = {
  schemaVersion: typeof INTERPRETED_INPUT_BINDING_VERSION;
  argsDigest: string;
  references: Array<{ stepId: string; workProductId: string; path: string }>;
  metadataValues: Record<string, string>;
};

type SeedRun = typeof workflowRuns.$inferSelect;

function scanTokens(value: unknown, refs: Set<string>, metadataKeys: Map<string, "run" | "child">) {
  if (typeof value === "string") {
    for (const match of value.matchAll(STEP_ARTIFACT_TOKEN)) if (match[1]) refs.add(match[1]);
    for (const match of value.matchAll(RUN_METADATA_TOKEN)) if (match[1]) metadataKeys.set(match[1], "run");
    for (const match of value.matchAll(CHILD_INPUTS_TOKEN)) if (match[1]) metadataKeys.set(match[1], "child");
  } else if (Array.isArray(value)) {
    for (const item of value) scanTokens(item, refs, metadataKeys);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) scanTokens(item, refs, metadataKeys);
  }
}

export function seedInterpretedInputUsage(step: { toolArgs?: unknown }) {
  const refs = new Set<string>(), metadataKeys = new Map<string, "run" | "child">();
  scanTokens(step.toolArgs ?? {}, refs, metadataKeys);
  return { refs, metadataKeys };
}

export function hasSeedInterpretedInputTokens(step: { toolArgs?: unknown }) {
  const { refs, metadataKeys } = seedInterpretedInputUsage(step);
  return refs.size > 0 || metadataKeys.size > 0;
}

/** 서버가 의존관계로 유도한 영향 집합(대상 정의 좌표): 원점 스텝 + 요청 seed 중 그 하류만. 독립 분기 제외. */
export function seedImpactStepIds(targetSteps: RevisionStep[], requestedStepIds: string[], originStepId: string): string[] {
  const requested = new Set(requestedIds), affected = new Set([originStepId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const step of targetSteps) {
      if (affected.has(step.id) || !requested.has(step.id)) continue;
      if (resolveEdges(step).some(edge => !edge.isBackEdge && affected.has(edge.stepId))) { affected.add(step.id); grew = true; }
    }
  }
  return [...affected].sort();
}

function childInputsBag(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const bag = metadata?.workflowChildInputs;
  return bag && typeof bag === "object" && !Array.isArray(bag) ? bag as Record<string, unknown> : {};
}

function renderSourceArgs(db: Db, sourceRun: SeedRun, sourceStep: RevisionStep, sourceSteps: RevisionStep[]) {
  return resolveWorkflowToolStepArgs({ db, run: { id: sourceRun.id, companyId: sourceRun.companyId,
    runDate: sourceRun.runDate, metadata: sourceRun.metadata }, step: sourceStep, workflowSteps: sourceSteps });
}

export async function bindSeedInterpretedInputs(db: Db, input: {
  companyId: string; sourceRun: SeedRun; targetRun: SeedRun; sourceStep: RevisionStep; sourceSteps: RevisionStep[];
  sourceStepRunId: string; targetStepId: string; requestedStepIds: string[]; targetSteps: RevisionStep[];
}): Promise<SeedInterpretedInputBinding> {
  const { refs, metadataKeys } = seedInterpretedInputUsage(input.sourceStep);
  const refuse = (detail: Record<string, unknown>): never => { throw seedError("interpreted_input_mismatch", {
    stepId: input.targetStepId, affectedStepIds: seedImpactStepIds(input.targetSteps, input.requestedStepIds,
      input.targetStepId), ...detail }); };
  // 원본 해석 재현 실패 자체가 실제 입력 증명 실패다 — 느슨한 통과가 아니라 구조적 거절로 닫는다.
  const rendered = await renderSourceArgs(db, input.sourceRun, input.sourceStep, input.sourceSteps)
    .catch((error: unknown) => { refuse({ phase: "admission_render",
      cause: error instanceof Error ? error.message : String(error) }); });
  // 실행 시점 실제 소비 기록: 이 소비 스텝런에 핀된 참조별 산출물(workflowStepOutputBindings).
  const pins = refs.size === 0 ? [] : await db.select({ referencedStepId: workflowStepOutputBindings.referencedStepId,
    workProductId: workflowStepOutputBindings.workProductId }).from(workflowStepOutputBindings)
    .where(and(eq(workflowStepOutputBindings.companyId, input.companyId),
      eq(workflowStepOutputBindings.workflowRunId, input.sourceRun.id),
      eq(workflowStepOutputBindings.consumerStepRunId, input.sourceStepRunId)));
  const selectors = workProductSelectorsSchema.parse((input.sourceStep as { workProductSelectors?: unknown }).workProductSelectors ?? {});
  const references: SeedInterpretedInputBinding["references"] = [];
  for (const stepId of [...refs].sort()) {
    // 선언 selector 참조는 렌더와 같은 선택 경로(selectOfficialWorkProduct)로 실제 산출물을 특정한다.
    const selected = selectors[stepId] ? await selectOfficialWorkProduct(db, { companyId: input.companyId,
      workflowRunId: input.sourceRun.id, stepId, selector: selectors[stepId] }) : null;
    const pin = pins.find(p => p.referencedStepId === stepId) ?? null;
    // 실행 핀이 있지만 선언 selector 가 없으면 실제 값 대조 근거가 없다 — 완화가 아니라 보수적 거절.
    if (pin && !selectors[stepId]) refuse({ phase: "admission_pin", referencedStepId: stepId, cause: "untyped_reference_pin_incomparable" });
    if (pin) {
      const [pinned] = await db.select().from(issueWorkProducts).where(and(eq(issueWorkProducts.id, pin.workProductId),
        eq(issueWorkProducts.companyId, input.companyId)));
      const pinnedPath = pinned ? resolveWorkProductLocalFilePath(pinned) : null;
      if (!pinned || !pinnedPath) refuse({ phase: "admission_pin", referencedStepId: stepId, cause: "pinned_product_unavailable" });
      // 같은 토큰 설정인데 실행 시점 실제 산출물과 지금 해석이 다르다(예: 생산자 기록 교체) — 재사용 거절.
      if (selected && selected.product.id !== pin.workProductId) refuse({ phase: "admission_pin", referencedStepId: stepId,
        cause: "selection_moved_off_pinned_product", pinnedWorkProductId: pin.workProductId, selectedWorkProductId: selected.product.id });
      references.push({ stepId, workProductId: pin.workProductId, path: path.resolve(pinnedPath!) });
    } else if (selected) {
      references.push({ stepId, workProductId: selected.product.id, path: path.resolve(selected.file) });
    }
    // 핀·selector 어느 기록도 없는 참조는 바인딩·물화 재검증(argsDigest)으로만 보호한다(게이트 완화 없음).
  }
  // run metadata/childInputs 실제 값: 실행 기록(원본 run metadata)과 대상 run 재실행 해석값이 같아야 한다.
  const sourceMetadata = input.sourceRun.metadata ?? {}, targetMetadata = input.targetRun.metadata ?? {};
  const sourceChild = childInputsBag(sourceMetadata), targetChild = childInputsBag(targetMetadata);
  const metadataValues: Record<string, string> = {};
  for (const [key, kind] of [...metadataKeys.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sourceBag = kind === "child" ? sourceChild : sourceMetadata;
    const targetBag = kind === "child" ? targetChild : targetMetadata;
    const sourceValue = stringifyWorkflowRunMetadataValue(sourceBag[key]);
    const targetValue = stringifyWorkflowRunMetadataValue(targetBag[key]);
    if (sourceValue === null) refuse({ phase: "admission_metadata", metadataKey: key, cause: "source_value_missing" });
    if (targetValue !== sourceValue) refuse({ phase: "admission_metadata", metadataKey: key, cause: "value_changed",
      sourceValue, targetValue: targetValue ?? null });
    metadataValues[`${kind === "child" ? "childInputs" : "runMetadata"}:${key}`] = sourceValue;
  }
  return { schemaVersion: INTERPRETED_INPUT_BINDING_VERSION, argsDigest: hashStructuredValue(rendered), references, metadataValues };
}

/** 물화 재검증: 승인 때 바인딩한 실제 해석값과 지금 재렌더한 원본 좌표 값이 어긋나면 해당 seed 만 거절. */
export async function verifySeedInterpretedInputs(db: Db, input: {
  companyId: string; targetStepId: string; binding: SeedInterpretedInputBinding;
  sourceRun: SeedRun; sourceStep: RevisionStep; sourceSteps: RevisionStep[];
}) {
  const mismatch = (detail: Record<string, unknown>): never => { throw seedError("interpreted_input_mismatch", {
    stepId: input.targetStepId, affectedStepIds: [input.targetStepId], ...detail }); };
  const rendered = await renderSourceArgs(db, input.sourceRun, input.sourceStep, input.sourceSteps)
    .catch((error: unknown) => { mismatch({ phase: "materialization_render",
      cause: error instanceof Error ? error.message : String(error) }); });
  if (hashStructuredValue(rendered) !== input.binding.argsDigest) mismatch({ phase: "materialization_render" });
  const selectors = workProductSelectorsSchema.parse((input.sourceStep as { workProductSelectors?: unknown }).workProductSelectors ?? {});
  for (const bound of input.binding.references) {
    const selected = selectors[bound.stepId] ? await selectOfficialWorkProduct(db, { companyId: input.companyId,
      workflowRunId: input.sourceRun.id, stepId: bound.stepId, selector: selectors[bound.stepId] }) : null;
    if (!selected || selected.product.id !== bound.workProductId || path.resolve(selected.file) !== bound.path) {
      mismatch({ phase: "materialization_reference", referencedStepId: bound.stepId });
    }
  }
}

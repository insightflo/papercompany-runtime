// server/src/services/workflow/seed-interpreted-inputs.ts
//
// [수정 변경맵 Q11 — 실제 해석 입력 무효화] seed 승인의 설정 해시는 선언된 toolArgs 토큰까지 같으면
// 통과한다. 그러나 tool-step-args.ts 는 실행 시점에 {$steps.*}/{$runMetadata.*}/{$childInputs.*} 토큰과
// run 좌표 토큰({$runDate}/{$date}/{$runMonth}/{$workflowRunId})을 실제 기록(생산 산출물·run metadata·
// run 레코드)으로 해석하므로 같은 토큰 설정과 다른 실제 값이 가능하다.
// (1) 승인 때 같은 해석 기계(resolveWorkflowToolStepArgs·selectOfficialWorkProduct)로 소비 스텝의 실제
// 인자값을 원본 run 좌표에서 렌더해 증거에 바인딩하고, 원본·대상 양쪽 실제값이 다르면 의존관계로 유도한
// 영향 집합(서버 계산)과 함께 구조적 사유(workflow_seed_interpreted_input_mismatch)로 재사용을 거절한다.
// (2) 물화/소비 재검증은 원본 재렌더·재선택에 더해 대상(현재 실행) 재확인을 수행한다 — 바인딩한 실제값을
// 현재 대상 run 레코드에서 다시 해석해 대조하고, 대상 스텝 인자를 현재 기록으로 재렌더해 argsDigest 와
// 대조한다(어긋나면 해당 seed 만 거절).
// metadataKeys 는 run/child namespace('run:<key>'/'child:<key>')로 구분해 같은 이름 키의 충돌·은폐를
// 막는다. native tool 스텝도 동일한 게이트를 통과한다(!toolArtifact 예외 없음 — 토큰 없는 스텝은 기존
// 게이트 그대로, 완화 없음). 토큰 리터럴은 tool-step-args.ts 와 동일하게 유지하고 prose 는 절대 파싱하지 않는다.
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { issueWorkProducts, workflowStepOutputBindings, type Db } from "@paperclipai/db";
import { workProductSelectorsSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { hashStructuredValue } from "../issue-execution-cards/hash.js";
import { resolveWorkProductLocalFilePath } from "../work-products.js";
import { resolveEdges } from "./control-flow/edge-condition.js";
import { renderWorkflowToolStepArgsWithResolvedValues, resolveWorkflowToolStepArgs, runMonthFromRunDate,
  stringifyWorkflowRunMetadataValue } from "./tool-step-args.js";
import { selectOfficialWorkProduct } from "./workproduct-selector.js";
import { seedError } from "./workflow-seed-evidence.js";
import type { RevisionStep } from "./revision-step-config.js";

const STEP_ARTIFACT_TOKEN = /\{\$steps\.([A-Za-z0-9_-]+)\.(workProductPath|workProductDir|siblingAssetsDir)\}/g;
const RUN_METADATA_TOKEN = /\{\$runMetadata\.([A-Za-z0-9_]+)\}/g;
const CHILD_INPUTS_TOKEN = /\{\$childInputs\.([A-Za-z0-9_]+)\}/g;
// [토큰 커버리지] tool-step-args.ts renderTemplates 가 실행 시 해석하는 run 좌표 토큰 — 같은 정규식 계열.
const RUN_COORDINATE_TOKEN = /\{\$(runDate|date|runMonth|workflowRunId)\}/g;

export const INTERPRETED_INPUT_BINDING_VERSION = "workflow.seed.interpreted-inputs.v1";

export type SeedRunCoordinateToken = "runDate" | "date" | "runMonth" | "workflowRunId";

export type SeedInterpretedInputBinding = {
  schemaVersion: typeof INTERPRETED_INPUT_BINDING_VERSION;
  argsDigest: string;
  references: Array<{ stepId: string; workProductId: string; path: string }>;
  metadataValues: Record<string, string>;
  runCoordinateValues: Record<string, string>;
};

// bind/verify 가 실제로 읽는 run 좌표만 요구한다(드리즐 원본 row 와 매핑된 WorkflowRun 양쪽 호환).
type SeedRun = { id: string; companyId: string; runDate?: string | null; metadata?: Record<string, unknown> | null };

function scanTokens(value: unknown, refs: Set<string>, metadataKeys: Map<string, "run" | "child">,
  runCoordinateTokens: Set<SeedRunCoordinateToken>) {
  if (typeof value === "string") {
    for (const match of value.matchAll(STEP_ARTIFACT_TOKEN)) if (match[1]) refs.add(match[1]);
    // namespace 구분 키('run:<key>'/'child:<key>')로 저장한다 — 같은 이름 키가 한쪽 namespace 를 덮어쓰지 않는다.
    for (const match of value.matchAll(RUN_METADATA_TOKEN)) if (match[1]) metadataKeys.set(`run:${match[1]}`, "run");
    for (const match of value.matchAll(CHILD_INPUTS_TOKEN)) if (match[1]) metadataKeys.set(`child:${match[1]}`, "child");
    for (const match of value.matchAll(RUN_COORDINATE_TOKEN)) if (match[1]) runCoordinateTokens.add(match[1] as SeedRunCoordinateToken);
  } else if (Array.isArray(value)) {
    for (const item of value) scanTokens(item, refs, metadataKeys, runCoordinateTokens);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) scanTokens(item, refs, metadataKeys, runCoordinateTokens);
  }
}

export function seedInterpretedInputUsage(step: { toolArgs?: unknown }) {
  const refs = new Set<string>(), metadataKeys = new Map<string, "run" | "child">(),
    runCoordinateTokens = new Set<SeedRunCoordinateToken>();
  scanTokens(step.toolArgs ?? {}, refs, metadataKeys, runCoordinateTokens);
  return { refs, metadataKeys, runCoordinateTokens };
}

export function hasSeedInterpretedInputTokens(step: { toolArgs?: unknown }) {
  const { refs, metadataKeys, runCoordinateTokens } = seedInterpretedInputUsage(step);
  return refs.size > 0 || metadataKeys.size > 0 || runCoordinateTokens.size > 0;
}

/** 서버가 의존관계로 유도한 영향 집합(대상 정의 좌표): 원점 스텝 + 요청 seed 중 그 하류만. 독립 분기 제외. */
export function seedImpactStepIds(targetSteps: RevisionStep[], requestedStepIds: string[], originStepId: string): string[] {
  const requested = new Set(requestedStepIds), affected = new Set([originStepId]);
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

/** tool-step-args.ts renderTemplates 과 동일한 해석으로 run 좌표 토큰의 실제값을 계산한다
 *  ({$runMonth} 는 runDate 파싱 실패 시 렌더러처럼 토큰 리터럴이 그대로 남는다). */
export function seedRunCoordinateActualValue(token: SeedRunCoordinateToken, run: SeedRun): string {
  if (token === "workflowRunId") return run.id;
  const runDate = run.runDate ?? "";
  if (token === "runMonth") return runMonthFromRunDate(runDate) ?? "{$runMonth}";
  return runDate;
}

export async function bindSeedInterpretedInputs(db: Db, input: {
  companyId: string; sourceRun: SeedRun; targetRun: SeedRun; sourceStep: RevisionStep; sourceSteps: RevisionStep[];
  sourceStepRunId: string; targetStepId: string; requestedStepIds: string[]; targetSteps: RevisionStep[];
}): Promise<SeedInterpretedInputBinding> {
  const { refs, metadataKeys, runCoordinateTokens } = seedInterpretedInputUsage(input.sourceStep);
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
  for (const [namespacedKey, kind] of [...metadataKeys.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const key = namespacedKey.slice(kind === "child" ? "child:".length : "run:".length);
    const sourceBag = kind === "child" ? sourceChild : sourceMetadata;
    const targetBag = kind === "child" ? targetChild : targetMetadata;
    const sourceValue = stringifyWorkflowRunMetadataValue(sourceBag[key]);
    const targetValue = stringifyWorkflowRunMetadataValue(targetBag[key]);
    if (sourceValue === null || targetValue !== sourceValue) refuse({ phase: "admission_metadata", metadataKey: key,
      cause: sourceValue === null ? "source_value_missing" : "value_changed",
      sourceValue, targetValue: targetValue ?? null });
    if (sourceValue !== null) metadataValues[`${kind === "child" ? "childInputs" : "runMetadata"}:${key}`] = sourceValue;
  }
  // run 좌표 토큰 실제값({$runDate}/{$date}/{$runMonth}/{$workflowRunId}): 원본과 대상의 현재 레코드 해석값이
  // 같아야 한다. workflowRunId 는 실행마다 다르므로 이 토큰을 쓴 스텝의 seed 재사용은 항상 거절된다.
  const runCoordinateValues: Record<string, string> = {};
  for (const token of [...runCoordinateTokens].sort()) {
    const sourceValue = seedRunCoordinateActualValue(token, input.sourceRun);
    const targetValue = seedRunCoordinateActualValue(token, input.targetRun);
    if (targetValue !== sourceValue) refuse({ phase: "admission_run_coordinate", token,
      cause: "value_changed", sourceValue, targetValue });
    runCoordinateValues[token] = sourceValue;
  }
  return { schemaVersion: INTERPRETED_INPUT_BINDING_VERSION, argsDigest: hashStructuredValue(rendered), references, metadataValues, runCoordinateValues };
}

/** 물화 재검증: (1) 원본 좌표 재렌더·재선택, (2) 대상(현재 실행) 레코드 실제값 재확인·대상 재렌더 —
 *  어긋나면 해당 seed 만 거절한다. */
export async function verifySeedInterpretedInputs(db: Db, input: {
  companyId: string; targetStepId: string; binding: SeedInterpretedInputBinding;
  sourceRun: SeedRun; sourceStep: RevisionStep; sourceSteps: RevisionStep[];
  targetRun: SeedRun; targetStep: RevisionStep; targetSteps: RevisionStep[];
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
  // [대상(현재 실행) 재확인] 승인 때 바인딩한 실제값을 현재 대상 run 레코드에서 다시 해석해 대조한다.
  // 원본만 재렌더하면 잡히지 않는, 승인 이후 대상 run 레코드(metadata·runDate) 변경이 여기서 닫힌다.
  const targetMetadata = input.targetRun.metadata ?? {}, targetChild = childInputsBag(targetMetadata);
  for (const [storedKey, boundValue] of Object.entries(input.binding.metadataValues)) {
    const child = storedKey.startsWith("childInputs:");
    const key = storedKey.slice(child ? "childInputs:".length : "runMetadata:".length);
    const targetValue = stringifyWorkflowRunMetadataValue((child ? targetChild : targetMetadata)[key]);
    if (targetValue !== boundValue) mismatch({ phase: "materialization_metadata", metadataKey: storedKey,
      cause: targetValue === null ? "target_value_missing" : "value_changed", boundValue, targetValue });
  }
  for (const [token, boundValue] of Object.entries(input.binding.runCoordinateValues)) {
    const targetValue = seedRunCoordinateActualValue(token as SeedRunCoordinateToken, input.targetRun);
    if (targetValue !== boundValue) mismatch({ phase: "materialization_run_coordinate", token,
      cause: "value_changed", boundValue, targetValue });
  }
  // [대상 재렌더] 대상 스텝의 해석 인자를 현재 대상 run 기록으로 재렌더해 승인 바인딩의 argsDigest 와
  // 대조한다. steps 참조는 승인 때 바인딩되어 위에서 원본측 재검증을 통과한 실제 산출물 경로로 해석한다 —
  // 물화 직전에는 대상 스텝런 행이 아직 없어 체인 조회가 불가능하기 때문이다. 바인딩되지 않은 참조가 섞여
  // 있으면 이 대조는 생략하고 해당 참조는 기존대로 원본측 argsDigest 재렌더로만 보호한다(완화 없음).
  const { refs: targetRefs } = seedInterpretedInputUsage(input.targetStep);
  const sourceStepIdOf = new Map(input.targetSteps.map(step => [step.id, step.sourceStepId ?? step.id]));
  const boundPaths = new Map<string, string>();
  let renderable = true;
  for (const targetRef of targetRefs) {
    const bound = input.binding.references.find(reference =>
      reference.stepId === (sourceStepIdOf.get(targetRef) ?? targetRef));
    if (!bound) { renderable = false; break; }
    boundPaths.set(targetRef, bound.path);
  }
  if (renderable) {
    let targetRendered: unknown;
    try {
      targetRendered = renderWorkflowToolStepArgsWithResolvedValues({ args: input.targetStep.toolArgs ?? {},
        runDate: input.targetRun.runDate ?? "", runId: input.targetRun.id, pathsByStepId: boundPaths,
        runMetadata: targetMetadata });
    } catch (error: unknown) {
      mismatch({ phase: "materialization_target_render",
        cause: error instanceof Error ? error.message : String(error) });
    }
    if (hashStructuredValue(targetRendered) !== input.binding.argsDigest) mismatch({ phase: "materialization_target_render" });
  }
}

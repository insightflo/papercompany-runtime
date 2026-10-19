import path from "node:path";
import { withSelectedInputTransaction } from "./selected-input-transaction.js";
import { resolveSelectedPaths } from "./workproduct-selector.js";
import { resolveToolResultPaths } from "./artifact-step-result.js";
import { and, desc, eq, inArray, not } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, issueWorkProducts, workflowStepOutputBindings, workflowStepRuns } from "@paperclipai/db";
import { resolveWorkProductLocalFilePath } from "../work-products.js";
import { assertPinnedProductConsumable } from "./workproduct-pinned-path.js";
import {
  pinWorkProductForStep,
} from "./workflow-output-binding.js";
import { isWorkProductBindingEnabled } from "./run-reopen-guard-flag.js";
import { isWorkProductSelectorRejectEnabled } from "./workproduct-selector-reject-flag.js";
import { findWorkflowSeed } from "./workflow-seed-evidence.js";
import { collectAncestorStepIds, collectArtifactReferences, type WorkflowArtifactReferenceStep } from "./step-artifact-references.js";
import { renderWorkflowToolStepArgsWithResolvedValues } from "./tool-step-template-render.js";
export {
  stringifyWorkflowRunMetadataValue,
  renderWorkflowToolStepArgsWithResolvedValues,
  stripShellEscapeResidue,
  runMonthFromRunDate,
} from "./tool-step-template-render.js";
type WorkflowArgStep = WorkflowArtifactReferenceStep & {
  workProductSelectors?: unknown;
  toolArtifactContract?: unknown;
};

type WorkflowArgRun = {
  id: string;
  companyId: string;
  runDate?: string | null;
  metadata?: Record<string, unknown> | null;
};

export const resolveWorkflowToolStepArgs = withSelectedInputTransaction(async (input: {
  db: Db;
  run: WorkflowArgRun;
  step: WorkflowArgStep;
  workflowSteps: WorkflowArgStep[];
  consumerStepRunId?: string | null;
}): Promise<unknown> => {
  const args = input.step.toolArgs ?? {};
  const runMetadata = input.run.metadata ?? {};
  const references = collectArtifactReferences(args);
  if (references.size === 0) {
    return renderWorkflowToolStepArgsWithResolvedValues({
      args, runDate: input.run.runDate ?? "", runId: input.run.id, pathsByStepId: new Map(), runMetadata,
    });
  }

  const ancestors = collectAncestorStepIds(input.step.id, input.workflowSteps);
  for (const stepId of references) {
    if (!ancestors.has(stepId)) {
      throw new Error(`Workflow tool step "${input.step.id}" may only reference ancestor workProducts; "${stepId}" is not an ancestor.`);
    }
  }

  const pathsByStepId = new Map<string, string>();
  const pinByStepRun = input.consumerStepRunId
    ? Boolean(input.step.workProductSelectors) || await isWorkProductBindingEnabled(input.db)
    : false;
  // [의도적 예외 명시 — 봇 bug·medium] condition-tool-source(IF condition source)와
  //   workflow-child-dispatch-precheck(사전 렌더) 호출부는 소비 스텝런 신원이 없어 핀이
  //   생략된다 — 이 단계(스테이지 A)는 스텝런 신원이 있는 tool-step dispatch 경로에만 핀한다.
  //   두 경로의 핀 지원은 신원 연결 설계 후 후속 PR 로 확장한다(플래그 JSDoc 참조).
  const pinIds = new Map<string, string>();
  // [소비 하드닝 4단계] 핀 대상 산출물의 type/title — 거부 스니펫이 “무엇이 핀되었는가”를 지시하게.
  const pinnedTargets = new Map<string, { type: string | null; title: string | null }>();
  if (pinByStepRun) {
    // [봇 performance·medium 교정] 참조별 select 대신 한 번의 inArray 조회로 핀 맵을 만든다.
    const pinnedRows = await input.db
      .select({
        referencedStepId: workflowStepOutputBindings.referencedStepId,
        workProductId: workflowStepOutputBindings.workProductId,
        provider: issueWorkProducts.provider,
        metadata: issueWorkProducts.metadata,
        url: issueWorkProducts.url,
        type: issueWorkProducts.type,
        title: issueWorkProducts.title,
      })
      .from(workflowStepOutputBindings)
      .leftJoin(issueWorkProducts, eq(workflowStepOutputBindings.workProductId, issueWorkProducts.id))
      .where(and(
        eq(workflowStepOutputBindings.companyId, input.run.companyId),
        eq(workflowStepOutputBindings.workflowRunId, input.run.id),
        eq(workflowStepOutputBindings.consumerStepRunId, input.consumerStepRunId!),
        inArray(workflowStepOutputBindings.referencedStepId, Array.from(references)),
      ));
    for (const pinned of pinnedRows) {
      pinIds.set(pinned.referencedStepId, pinned.workProductId);
      pinnedTargets.set(pinned.referencedStepId, { type: pinned.type, title: pinned.title });
      pathsByStepId.set(
        pinned.referencedStepId,
        assertPinnedProductConsumable(pinned),
      );
    }
  }
  const selected = await resolveSelectedPaths(input.db, { companyId: input.run.companyId, workflowRunId: input.run.id,
    selectors: input.step.workProductSelectors, references, pins: pinIds });
  // [소비 하드닍 4단계] selector 없는 참조 중 시드 없음(=레거시 폴백/핀 소비 대상)을 분류한다.
  // 분류는 resolveSelectedPaths 와 동일하게 findWorkflowSeed 를 재사용한다 — 시드가 존재하면
  // (tool-output 은 resolveToolResultPaths, 비 tool-output 은 위 explicit_selector_required)
  // 감사·거부 대상이 아니다. selector 있음·시드 있음 경로는 이 분류에도 영향받지 않는다.
  const declaredSelectors = input.step.workProductSelectors as Record<string, unknown> | undefined;
  const selectorlessSeedless = new Set<string>();
  for (const stepId of references) {
    if (declaredSelectors?.[stepId] !== undefined) continue;
    if (await findWorkflowSeed(input.db, { companyId: input.run.companyId, workflowRunId: input.run.id, stepId })) continue;
    selectorlessSeedless.add(stepId);
  }
  const allProducts = await input.db
    .select({
      id: issueWorkProducts.id,
      stepId: workflowStepRuns.stepId,
      provider: issueWorkProducts.provider,
      metadata: issueWorkProducts.metadata,
      url: issueWorkProducts.url,
      externalId: issueWorkProducts.externalId,
      type: issueWorkProducts.type,
      title: issueWorkProducts.title,
    })
    .from(workflowStepRuns)
    .innerJoin(issueWorkProducts, eq(workflowStepRuns.issueId, issueWorkProducts.issueId))
    .where(and(
      eq(workflowStepRuns.workflowRunId, input.run.id),
      inArray(workflowStepRuns.stepId, Array.from(references)),
      eq(issueWorkProducts.companyId, input.run.companyId),
      not(eq(issueWorkProducts.status, "archived")),
    ))
    .orderBy(desc(issueWorkProducts.isPrimary), desc(issueWorkProducts.updatedAt), desc(issueWorkProducts.id));
  const products = [...allProducts.filter(p => !selected.has(p.stepId)),
    ...Array.from(selected, ([stepId, value]) => ({ ...value.product, stepId }))];
  // [소비 하드닝 4단계] 폴백이 실제로 소비할 첫 산출물(스텝별, 로컬 경로 해석 가능한 최상위
  // 후보) — 핀 생성 이전에 게이트가 “무엇이 폴백으로 소비되는가”를 판정하기 위한 미러다.
  const fallbackTarget = new Map<string, (typeof products)[number]>();
  for (const product of products) {
    if (fallbackTarget.has(product.stepId) || pathsByStepId.has(product.stepId)) continue;
    if (product.provider !== "local" && product.provider !== "local_file") continue;
    if (!resolveWorkProductLocalFilePath(product)) continue;
    fallbackTarget.set(product.stepId, product);
  }
  // [소비 하드닝 4단계 — 플래그 게이트 거부] selector 없음+시드 없음 참조의 새 폴백 해석과
  // selector 없는 기존 핀 소비를 핀 생성/경로 해석 이전에 명시 거부한다(부분 핀 잔존 방지).
  // 거부 에러는 기존 디스패치 실패 지속 경로(persistFailedToolDispatch)를 자연히 탄다.
  if (selectorlessSeedless.size > 0 && await isWorkProductSelectorRejectEnabled(input.db, input.run.companyId)) {
    const affected = Array.from(selectorlessSeedless).filter(id => pinIds.has(id) || fallbackTarget.has(id));
    if (affected.length > 0) {
      const snippet = JSON.stringify(Object.fromEntries(affected.map(stepId => {
        const pinned = pinnedTargets.get(stepId);
        const fallback = fallbackTarget.get(stepId);
        return [stepId, { type: pinned?.type ?? fallback?.type ?? "<type>", title: pinned?.title ?? fallback?.title ?? "<title>" }];
      })));
      throw new Error(`workproduct_selector_required: step "${input.step.id}" consumes ancestor work products without a selector; add to workProductSelectors: ${snippet}`);
    }
  }
  const pinCandidates: typeof products = [];
  const candidateStepIds = new Set<string>();
  for (const product of products) {
    if (candidateStepIds.has(product.stepId)) continue;
    if (pathsByStepId.has(product.stepId)) continue; // 이미 핀된 참조는 재핀 대상 아니다
    if (product.provider !== "local" && product.provider !== "local_file") continue;
    if (!resolveWorkProductLocalFilePath(product)) continue;
    candidateStepIds.add(product.stepId);
    pinCandidates.push(product);
  }
  const pinResults = pinByStepRun
    ? await Promise.all(pinCandidates
      .map((product) => pinWorkProductForStep(input.db, {
        companyId: input.run.companyId,
        workflowRunId: input.run.id,
        consumerStepRunId: input.consumerStepRunId!,
        referencedStepId: product.stepId,
        workProductId: product.id, sourceExecutionGeneration: selected.get(product.stepId)?.producer.executionGeneration,
      }).then((result) => ({ product, result }))))
    : [];
  // [소비 하드닝 4단계 — 플래그 OFF 감사] selector 없음+시드 없음 참조가 새 폴백 핀을 만들 때만
  // activity_log 1건. 이미 핀된 재해석(already_pinned)·selector/시드 있는 핀·핀 생성이 없는
  // 경로(pinByStepRun=false)는 기록하지 않는다(2026-10-17 계획 명시 선택).
  for (const { product, result } of pinResults) {
    if (result.kind !== "pinned" || !selectorlessSeedless.has(product.stepId)) continue;
    await input.db.insert(activityLog).values({
      companyId: input.run.companyId,
      actorType: "system",
      actorId: "workproduct-fallback-observer",
      action: "workflow.workproduct_fallback_pin",
      entityType: "workflow_step_run",
      entityId: input.consumerStepRunId!,
      details: {
        schemaVersion: "workflow.workproduct-fallback-pin.v1",
        workflowRunId: input.run.id,
        consumerStepRunId: input.consumerStepRunId,
        referencedStepId: product.stepId,
        workProductId: product.id,
        type: product.type,
        title: product.title,
      },
    });
  }
  for (const product of products) {
    if (pathsByStepId.has(product.stepId)) continue;
    if (product.provider !== "local" && product.provider !== "local_file") continue;
    const localPath = resolveWorkProductLocalFilePath(product);
    if (localPath) pathsByStepId.set(product.stepId, path.resolve(localPath));
  }
  for (const { product, result } of pinResults) {
    if (result.kind !== "already_pinned") continue;
    if (result.workProductId === product.id) continue;
    if (selected.has(product.stepId)) throw new Error("workproduct_selector_pin_conflict");
    let pinnedRow = (await input.db
      .select({ provider: issueWorkProducts.provider, metadata: issueWorkProducts.metadata, url: issueWorkProducts.url })
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.id, result.workProductId))
      .limit(1))[0] ?? null;
    if (!pinnedRow) {
      // [봇 bug·medium 교정 — 일시/영구 구분] 재조회 사이 cascade 삭제로 핀과 산출물이
      //   함께 사라졌을 수 있다(분리 스냅숏 경합). 핀을 1회 재시도해 새 산출물로 다시
      //   맺어본다 — 여전히 소실이면 그때만 영구 식별 오류로 분류한다.
      const retry = await pinWorkProductForStep(input.db, {
        companyId: input.run.companyId,
        workflowRunId: input.run.id,
        consumerStepRunId: input.consumerStepRunId!,
        referencedStepId: product.stepId,
        workProductId: product.id,
      });
      if (retry.kind === "pinned") continue; // 이번 해석(product)이 그대로 핀됨 — 맵 유지
      pinnedRow = (await input.db
        .select({ provider: issueWorkProducts.provider, metadata: issueWorkProducts.metadata, url: issueWorkProducts.url })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.id, retry.workProductId))
        .limit(1))[0] ?? null;
      if (!pinnedRow) {
        throw new Error(`workproduct_binding_target_missing: ${product.stepId} → ${retry.workProductId}`);
      }
    }
    pathsByStepId.set(
      product.stepId,
      assertPinnedProductConsumable({
        referencedStepId: product.stepId,
        workProductId: result.workProductId,
        provider: pinnedRow.provider,
        metadata: pinnedRow.metadata,
        url: pinnedRow.url,
      }),
    );
  }

  await resolveToolResultPaths(input, Array.from(references).filter(id => !pathsByStepId.has(id)), pathsByStepId);
  for (const stepId of references) {
    if (!pathsByStepId.has(stepId)) {
      throw new Error(`Workflow tool step "${input.step.id}" could not resolve an active local workProduct for ancestor step "${stepId}".`);
    }
  }

  return renderWorkflowToolStepArgsWithResolvedValues({
    args, runDate: input.run.runDate ?? "", runId: input.run.id, pathsByStepId, runMetadata,
  });
});

import path from "node:path";
import { and, desc, eq, inArray, not } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts, workflowStepOutputBindings, workflowStepRuns } from "@paperclipai/db";
import { resolveWorkProductLocalFilePath } from "../work-products.js";
import type { IssueWorkProduct } from "@paperclipai/shared";
import {
  pinWorkProductForStep,
} from "./workflow-output-binding.js";
import { isWorkProductBindingEnabled } from "./run-reopen-guard-flag.js";

type WorkflowArgStep = {
  id: string;
  dependencies?: string[];
  dependsOn?: string[];
  toolArgs?: unknown;
};

type WorkflowArgRun = {
  id: string;
  companyId: string;
  runDate?: string | null;
  metadata?: Record<string, unknown> | null;
};

const STEP_ARTIFACT_TOKEN = /\{\$steps\.([A-Za-z0-9_-]+)\.(workProductPath|workProductDir|siblingAssetsDir)\}/g;
const RUN_METADATA_TOKEN = /\{\$runMetadata\.([A-Za-z0-9_]+)\}/g;
/**
 * [workflow child fix P2-9] 자식 run 입력 토큰 — 부모 workflow 스텝 inputs 가
 * 자식 run metadata.workflowChildInputs 에 저장되고, 자식의 tool 스텝이
 * {$childInputs.<key>} 로 개별 소비한다. 미지 키는 토큰 잔존 → 기존 strict
 * fail-closed(ANY_UNRESOLVED_TOKEN_RE) 가 dispatch 를 거부한다.
 */
const CHILD_INPUTS_TOKEN = /\{\$childInputs\.([A-Za-z0-9_]+)\}/g;
/** 렌더 후 잔존 검출용(fail-closed) — 유효 문자셋 밖의 키(customer-id 등)도 포괄한다(fix3 P2-6). */
const UNRESOLVED_CHILD_INPUTS_TOKEN = /\{\$childInputs\.[^}]*\}/u;

/**
 * 문자열이 아닌 run metadata 값을 템플릿 치환 문자열로 변환.
 * undefined(키 부재와 동급)는 null을 반환해 호출자가 토큰을 유지하게 한다.
 */
export function stringifyWorkflowRunMetadataValue(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value === "string") return value;
  const json = JSON.stringify(value);
  return typeof json === "string" ? json : null;
}


/** [봇 maintainability·medium 교정] 핀 대상 검증의 단일 출처 — 사전 로드 루프와
 *  already_pinned 재조회 루프가 같은 식별 오류 의미론을 공유한다. */
function assertPinnedProductConsumable(input: {
  referencedStepId: string;
  workProductId: string;
  provider: string | null;
  metadata: unknown;
  url: string | null;
}): string {
  // [구조 호환] resolveWorkProductLocalFilePath 는 IssueWorkProduct 의 url/metadata 만 읽는다.
  const fileRef = { url: input.url, metadata: input.metadata } as Pick<IssueWorkProduct, "url" | "metadata">;
  void fileRef;
  if (!input.provider) {
    throw new Error(`workproduct_binding_target_missing: ${input.referencedStepId} → ${input.workProductId}`);
  }
  if (input.provider !== "local" && input.provider !== "local_file") {
    throw new Error(`workproduct_binding_target_invalid: ${input.referencedStepId} → ${input.workProductId} (provider ${input.provider})`);
  }
  const pinnedPath = resolveWorkProductLocalFilePath(fileRef);
  if (!pinnedPath) {
    throw new Error(`workproduct_binding_target_invalid: ${input.referencedStepId} → ${input.workProductId} (unresolvable path)`);
  }
  return path.resolve(pinnedPath);
}

export async function resolveWorkflowToolStepArgs(input: {
  db: Db;
  run: WorkflowArgRun;
  step: WorkflowArgStep;
  workflowSteps: WorkflowArgStep[];
  consumerStepRunId?: string | null;
}): Promise<unknown> {
  const args = input.step.toolArgs ?? {};
  const runMetadata = input.run.metadata ?? {};
  const references = collectArtifactReferences(args);
  if (references.size === 0) {
    return renderChecked(args, input.run.runDate ?? "", input.run.id, new Map(), runMetadata);
  }

  const ancestors = collectAncestorStepIds(input.step.id, input.workflowSteps);
  for (const stepId of references) {
    if (!ancestors.has(stepId)) {
      throw new Error(`Workflow tool step "${input.step.id}" may only reference ancestor workProducts; "${stepId}" is not an ancestor.`);
    }
  }

  const pathsByStepId = new Map<string, string>();
  const pinByStepRun = input.consumerStepRunId
    ? await isWorkProductBindingEnabled(input.db)
    : false;
  // [의도적 예외 명시 — 봇 bug·medium] condition-tool-source(IF condition source)와
  //   workflow-child-dispatch-precheck(사전 렌더) 호출부는 소비 스텝런 신원이 없어 핀이
  //   생략된다 — 이 단계(스테이지 A)는 스텝런 신원이 있는 tool-step dispatch 경로에만 핀한다.
  //   두 경로의 핀 지원은 신원 연결 설계 후 후속 PR 로 확장한다(플래그 JSDoc 참조).
  if (pinByStepRun) {
    // [봇 performance·medium 교정] 참조별 select 대신 한 번의 inArray 조회로 핀 맵을 만든다.
    const pinnedRows = await input.db
      .select({
        referencedStepId: workflowStepOutputBindings.referencedStepId,
        workProductId: workflowStepOutputBindings.workProductId,
        provider: issueWorkProducts.provider,
        metadata: issueWorkProducts.metadata,
        url: issueWorkProducts.url,
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
      // 핀이 존재하면 그것이 이 참조의 유일한 해석이다 — 소비 불가능하면 조용히 최신
      //   대표로 재해석하지 않고 식별 오류로 실패한다(archived 는 여전히 읽는다).
      pathsByStepId.set(
        pinned.referencedStepId,
        assertPinnedProductConsumable(pinned),
      );
    }
  }
  const products = await input.db
    .select({
      id: issueWorkProducts.id,
      stepId: workflowStepRuns.stepId,
      provider: issueWorkProducts.provider,
      metadata: issueWorkProducts.metadata,
      url: issueWorkProducts.url,
      externalId: issueWorkProducts.externalId,
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
  // [봇 bug·medium 교정] (a) 핀 삽입은 병렬로, (b) already_pinned 이 떠도 결과를 버리지
  //   않는다 — DB 핀이 이 참조의 유일한 해석이므로, 방금 해석한 것과 다르면 핀된 산출물
  //   경로로 맵을 되돌린다(제3자 동시 핀이 이긴 경우의 정합성). 핀 대상이 소실/무효면
  //   위 핀 로드 경로와 동일한 식별 오류로 실패한다.
  // [봇 bug·medium 교정] 참조별 핀 대상은 정렬 순 첫 행(대표/최신 — 비핀 폴백 루프와 동일
  //   해석) 하나로 한정한다 — 같은 유니크 키에 여러 insert 가 경합하면 승자가 비결정적이
  //   되고 낡은/비대표 산출물이 영구히 핀될 수 있다.
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
        workProductId: product.id,
      }).then((result) => ({ product, result }))))
    : [];
  for (const product of products) {
    if (pathsByStepId.has(product.stepId)) continue;
    if (product.provider !== "local" && product.provider !== "local_file") continue;
    const localPath = resolveWorkProductLocalFilePath(product);
    if (localPath) pathsByStepId.set(product.stepId, path.resolve(localPath));
  }
  for (const { product, result } of pinResults) {
    if (result.kind !== "already_pinned") continue;
    if (result.workProductId === product.id) continue;
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

  // [의도적 예외 — 봇 bug·medium 문서화] 네이티브 폴백(스텝 metadata.toolResult.artifactPath)은
  //   issue_work_products 행을 거치지 않아 work_product_id 가 없다 — 이 단계 핀 대상이 아니다.
  //   세대 CAS(PR-3)가 이 경로의 낡은 결과를 이미 차단한다. 행 기반 핀 확장은 후속 설계.
  // 네이티브 tool 스텝 폴백: issue 없이 실행된 스텝은 위 조인에 걸리지 않는다.
  // 툴 실행기가 기록한 스텝 런 metadata.toolResult.artifactPath(구조화 DB 레코드)를
  // 그대로 사용한다. 최신 완료 런 우선 — 재시도 시 metadata가 덮어쓰기된 최신 값 유지.
  const unresolvedStepIds = Array.from(references).filter((stepId) => !pathsByStepId.has(stepId));
  if (unresolvedStepIds.length > 0) {
    const stepRunRows = await input.db
      .select({ stepId: workflowStepRuns.stepId, metadata: workflowStepRuns.metadata })
      .from(workflowStepRuns)
      .where(and(
        eq(workflowStepRuns.workflowRunId, input.run.id),
        inArray(workflowStepRuns.stepId, unresolvedStepIds),
      ))
      .orderBy(desc(workflowStepRuns.completedAt), desc(workflowStepRuns.id));
    for (const row of stepRunRows) {
      if (pathsByStepId.has(row.stepId)) continue;
      const toolResult = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>).toolResult
        : null;
      const artifactPath = toolResult && typeof toolResult === "object" && !Array.isArray(toolResult)
        ? (toolResult as Record<string, unknown>).artifactPath
        : null;
      if (typeof artifactPath === "string" && artifactPath.trim().length > 0) {
        pathsByStepId.set(row.stepId, path.resolve(artifactPath.trim()));
      }
    }
  }
  for (const stepId of references) {
    if (!pathsByStepId.has(stepId)) {
      throw new Error(`Workflow tool step "${input.step.id}" could not resolve an active local workProduct for ancestor step "${stepId}".`);
    }
  }

  return renderChecked(args, input.run.runDate ?? "", input.run.id, pathsByStepId, runMetadata);
}

/**
 * [fix2 P2-7] 렌더 후 미해결 {$childInputs.*} 토큰은 fail-closed — enqueue/실행 이전에
 * 구조화 실패(throw)로 마감된다. 도구 실행기가 알 수 없는 자식 입력 토큰을 받는 일은 없다.
 */
function renderChecked(value: unknown, runDate: string, runId: string, pathsByStepId: Map<string, string>, runMetadata: Record<string, unknown>): unknown {
  const rendered = renderTemplates(value, runDate, runId, pathsByStepId, runMetadata);
  const serialized = JSON.stringify(rendered ?? "");
  const unresolved = UNRESOLVED_CHILD_INPUTS_TOKEN.exec(serialized);
  if (unresolved) {
    throw new Error(
      `Unresolved {$childInputs} token in tool args: ${unresolved[0]}`
      + " (child input keys must be declared on the parent workflow step inputs)",
    );
  }
  return rendered;
}

function collectArtifactReferences(value: unknown, result = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(STEP_ARTIFACT_TOKEN)) {
      if (match[1]) result.add(match[1]);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectArtifactReferences(item, result);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectArtifactReferences(item, result);
  }
  return result;
}

function collectAncestorStepIds(currentStepId: string, steps: WorkflowArgStep[]): Set<string> {
  const dependencies = new Map(steps.map((step) => [step.id, step.dependencies ?? step.dependsOn ?? []]));
  const ancestors = new Set<string>();
  const visit = (stepId: string) => {
    for (const dependencyId of dependencies.get(stepId) ?? []) {
      if (ancestors.has(dependencyId)) continue;
      ancestors.add(dependencyId);
      visit(dependencyId);
    }
  };
  visit(currentStepId);
  return ancestors;
}

/**
 * [arg hygiene — 2026-09-02] bash ANSI-C 이스케이프 잔여 정화.
 * 오너/에이전트가 셸 오류 메시지에서 복사한 경로가 `$'/srv/...'` 또는 `$/srv/...` 형태로
 * 인자에 섞여 들어오면 도구가 존재하지 않는 경로(`$/...`)를 열다 실패한다(2026-08-29/31
 * enqueue-naver-publish 오염 2건, 25.6분 현수). `$/`·`$'`로 시작하는 문자열 값은
 * 정상 경로/값으로 존재할 수 없으므로 선행 `$`를 제거한다.
 */
export function stripShellEscapeResidue(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.startsWith("$/") || value.startsWith("$'")) return value.slice(1);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => stripShellEscapeResidue(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = stripShellEscapeResidue(entry);
    }
    return out;
  }
  return value;
}

/**
 * [runMonth — 2026-09-03] runDate(YYYY-MM-DD)에서 월 폴더용 YYYYMM 추출.
 * 파싱 실패 시 null — 렌더러는 원문 토큰을 그대로 둔다(렌더 실패보다 눈에 보이는 실패).
 */
export function runMonthFromRunDate(runDate: string): string | null {
  const match = /^(\d{4})-(\d{2})/.exec(runDate);
  return match ? `${match[1]}${match[2]}` : null;
}

function renderTemplates(value: unknown, runDate: string, runId: string, pathsByStepId: Map<string, string>, runMetadata: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    return stripShellEscapeResidue(value
      .replaceAll("{$runDate}", runDate)
      .replaceAll("{$date}", runDate)
      .replaceAll("{$workflowRunId}", runId)
      .replaceAll("{$runMonth}", runMonthFromRunDate(runDate) ?? "{$runMonth}")
      .replace(STEP_ARTIFACT_TOKEN, (token, stepId: string, field: string) => {
        const workProductPath = pathsByStepId.get(stepId);
        if (!workProductPath) return token;
        if (field === "workProductPath") return workProductPath;
        if (field === "siblingAssetsDir") return path.join(path.dirname(workProductPath), "assets");
        return path.dirname(workProductPath);
      })
      .replace(RUN_METADATA_TOKEN, (token, key: string) => {
        if (!Object.prototype.hasOwnProperty.call(runMetadata, key)) return token;
        const rendered = stringifyWorkflowRunMetadataValue(runMetadata[key]);
        return rendered === null ? token : rendered;
      })
      .replace(CHILD_INPUTS_TOKEN, (token, key: string) => {
        const childInputs = runMetadata.workflowChildInputs;
        if (!childInputs || typeof childInputs !== "object" || Array.isArray(childInputs)) return token;
        const bag = childInputs as Record<string, unknown>;
        if (!Object.prototype.hasOwnProperty.call(bag, key)) return token;
        const rendered = stringifyWorkflowRunMetadataValue(bag[key]);
        return rendered === null ? token : rendered;
      }));
  }
  if (Array.isArray(value)) return value.map((item) => renderTemplates(item, runDate, runId, pathsByStepId, runMetadata));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderTemplates(item, runDate, runId, pathsByStepId, runMetadata)]));
  }
  return value;
}

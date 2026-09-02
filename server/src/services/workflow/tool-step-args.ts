import path from "node:path";
import { and, desc, eq, inArray, not } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts, workflowStepRuns } from "@paperclipai/db";
import { resolveWorkProductLocalFilePath } from "../work-products.js";

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
 * 문자열이 아닌 run metadata 값을 템플릿 치환 문자열로 변환.
 * undefined(키 부재와 동급)는 null을 반환해 호출자가 토큰을 유지하게 한다.
 */
export function stringifyWorkflowRunMetadataValue(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value === "string") return value;
  const json = JSON.stringify(value);
  return typeof json === "string" ? json : null;
}

export async function resolveWorkflowToolStepArgs(input: {
  db: Db;
  run: WorkflowArgRun;
  step: WorkflowArgStep;
  workflowSteps: WorkflowArgStep[];
}): Promise<unknown> {
  const args = input.step.toolArgs ?? {};
  const runMetadata = input.run.metadata ?? {};
  const references = collectArtifactReferences(args);
  if (references.size === 0) return renderTemplates(args, input.run.runDate ?? "", new Map(), runMetadata);

  const ancestors = collectAncestorStepIds(input.step.id, input.workflowSteps);
  for (const stepId of references) {
    if (!ancestors.has(stepId)) {
      throw new Error(`Workflow tool step "${input.step.id}" may only reference ancestor workProducts; "${stepId}" is not an ancestor.`);
    }
  }

  const products = await input.db
    .select({
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

  const pathsByStepId = new Map<string, string>();
  for (const product of products) {
    if (pathsByStepId.has(product.stepId)) continue;
    if (product.provider !== "local" && product.provider !== "local_file") continue;
    const localPath = resolveWorkProductLocalFilePath(product);
    if (localPath) pathsByStepId.set(product.stepId, path.resolve(localPath));
  }

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

  return renderTemplates(args, input.run.runDate ?? "", pathsByStepId, runMetadata);
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

function renderTemplates(value: unknown, runDate: string, pathsByStepId: Map<string, string>, runMetadata: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    return stripShellEscapeResidue(value
      .replaceAll("{$runDate}", runDate)
      .replaceAll("{$date}", runDate)
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
      }));
  }
  if (Array.isArray(value)) return value.map((item) => renderTemplates(item, runDate, pathsByStepId, runMetadata));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderTemplates(item, runDate, pathsByStepId, runMetadata)]));
  }
  return value;
}

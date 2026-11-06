import { dependencyToolEvidence } from "./dependency-tool-evidence.js";
import path from "node:path";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { Db, IssueExecutionCardJson, workflowDefinitions, workflowRuns } from "@paperclipai/db";
import { issueWorkProducts, issues, missionPlanArtifacts, missions, workflowStepRuns } from "@paperclipai/db";
import { renderWorkflowRunTextTemplate } from "./dag-run-text-template.js";
import { buildWorkflowApiCloseoutLines, buildStepContractDescriptionLines, buildDependencyStepContractLines } from "./dag-contract-description.js";
import { issueService } from "../issues.js";
import { heartbeatService } from "../heartbeat.js";
import { applyWorkflowIssueCreatedSideEffects as applyIssueCreatedSideEffects } from "./replacement-agent-delivery.js";
import { uniqueIssueRowsByIssueId } from "./workflow-step-issue-records.js";
import { resolveWorkflowStepAssigneeAgentId } from "./workflow-step-wake.js";
import { isQaLikeStep } from "../missions/supervision-helpers.js";
import { writeQaRubricMarkdown } from "./qa-rubric.js";
import { resolveEdges } from "./control-flow/edge-condition.js";
import { loadDownstreamQaCapAcceptanceContext } from "./control-flow/qa-cap-acceptance-context.js";
import { resolveMissionWorkProductPaths } from "../work-products/output-paths.js";
import { resolveWorkProductLocalFilePath } from "../work-products.js";
import { buildArtifactOutputDirectoryLines, buildWorkProductRegistrationContractLines } from "../work-products/artifact-registration-instructions.js";
import { upsertWorkflowIssueExecutionCard } from "../issue-execution-cards/workflow-upsert.js";
import { evaluateSemanticStructuralReadiness, renderStructuralGateCoverageLines } from "./control-flow/structural-semantic-readiness.js";
import { buildCompanyWorkflowExecutionSteps } from './company-execution-steps.js';
import type { WorkflowStep } from "./dag-engine.js";

export function collectGateValidatedProducerStepIds(
  directDependencyStepIds: string[],
  workflowStepsById: Map<string, WorkflowStep>,
): Map<string, string[]> {
  const producerStepIdsByGateStepId = new Map<string, string[]>();

  const collectProducerSteps = (stepId: string, visited: Set<string>): string[] => {
    if (visited.has(stepId)) return [];
    const step = workflowStepsById.get(stepId);
    if (!step) return [];
    if (step.graphWorkProductRequired === true) return [stepId];
    const nextVisited = new Set(visited);
    nextVisited.add(stepId);
    return Array.from(new Set(step.dependencies.flatMap((dependencyStepId) => (
      collectProducerSteps(dependencyStepId, nextVisited)
    ))));
  };

  for (const dependencyStepId of directDependencyStepIds) {
    const dependencyStep = workflowStepsById.get(dependencyStepId);
    if (!dependencyStep || dependencyStep.graphWorkProductRequired === true || dependencyStep.dependencies.length === 0) {
      continue;
    }
    const producerStepIds = Array.from(new Set(dependencyStep.dependencies.flatMap((upstreamStepId) => (
      collectProducerSteps(upstreamStepId, new Set([dependencyStepId]))
    ))));
    if (producerStepIds.length > 0) {
      producerStepIdsByGateStepId.set(dependencyStepId, producerStepIds);
    }
  }

  return producerStepIdsByGateStepId;
}

export async function createWorkflowStepIssue(input: {
  db: Db;
  run: typeof workflowRuns.$inferSelect;
  definition: typeof workflowDefinitions.$inferSelect;
  step: WorkflowStep;
  /** [Task5a2a] 캡처된 실행 steps(loader 결과) — 로컬 builder 로 다시 정규화하지 않는다. 미지정 시 정의 기반 재구성(T3 quality 내부 경로). */
  steps?: WorkflowStep[];
  /** [T3 Quality DAG 계약] 지정하면 생성 부작용(깨우기·로그)을 미루고 apply 클로저를 호출자에게 넘긴다(연결 commit 후 apply). sideEffectsDb 는 커밋 뒤 부작용에 쓸 연결이다. */
  deferredSideEffectsDb?: Db;
  captureDeferredSideEffects?: (apply: () => Promise<void>) => void;
}): Promise<string | null> {
  const issueSvc = issueService(input.db);

  const executionSteps = input.steps ?? await buildCompanyWorkflowExecutionSteps(input.db, input.definition);
  const structuralReadiness = await evaluateSemanticStructuralReadiness({
    db: input.db,
    companyId: input.run.companyId,
    workflowRunId: input.run.id,
    step: input.step,
    steps: executionSteps,
  });
  if (!structuralReadiness.ready) return null;
  const structuralGateCoverageLines = renderStructuralGateCoverageLines(structuralReadiness.coverage);

  const assigneeAgentId = await resolveWorkflowStepAssigneeAgentId(input.db, input.run.companyId, input.step);
  const workflowStepsById = new Map(
    executionSteps.map((step) => [step.id, step]),
  );
  const gateProducerStepIdsByGateStepId = collectGateValidatedProducerStepIds(
    input.step.dependencies,
    workflowStepsById,
  );
  const gateValidatedProducerStepIds = Array.from(new Set(
    Array.from(gateProducerStepIdsByGateStepId.values()).flatMap((stepIds) => stepIds),
  )).filter((stepId) => !input.step.dependencies.includes(stepId));
  const sortByStepIds = <T extends { stepId: string }>(rows: T[], stepIds: string[]): T[] => {
    const order = new Map(stepIds.map((stepId, index) => [stepId, index]));
    return rows.sort((a, b) => (order.get(a.stepId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.stepId) ?? Number.MAX_SAFE_INTEGER));
  };
  const queryIssueRowsForStepIds = async (stepIds: string[]) => {
    if (stepIds.length === 0) return [];
    const rows = await input.db
      .select({
        stepId: workflowStepRuns.stepId,
        issueId: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        description: issues.description,
      })
      .from(workflowStepRuns)
      .innerJoin(issues, eq(workflowStepRuns.issueId, issues.id))
      .where(and(
        eq(workflowStepRuns.workflowRunId, input.run.id),
        inArray(workflowStepRuns.stepId, stepIds),
      ));
    return sortByStepIds(rows, stepIds);
  };
  const dependencyIssueRows = await queryIssueRowsForStepIds(input.step.dependencies);
  const gateValidatedProducerIssueRows = await queryIssueRowsForStepIds(gateValidatedProducerStepIds);
  const artifactLookupIssueRows = uniqueIssueRowsByIssueId([
    ...dependencyIssueRows,
    ...gateValidatedProducerIssueRows,
  ]);
  const dependencyWorkProductRows = artifactLookupIssueRows.length > 0
    ? await input.db
      .select({
        id: issueWorkProducts.id,
        issueId: issueWorkProducts.issueId,
        title: issueWorkProducts.title,
        type: issueWorkProducts.type,
        provider: issueWorkProducts.provider,
        url: issueWorkProducts.url,
        externalId: issueWorkProducts.externalId,
        metadata: issueWorkProducts.metadata,
        status: issueWorkProducts.status,
      })
      .from(issueWorkProducts)
      .where(and(
        eq(issueWorkProducts.companyId, input.run.companyId),
        inArray(issueWorkProducts.issueId, artifactLookupIssueRows.map((row) => row.issueId)),
        ne(issueWorkProducts.status, "archived"),
      ))
    : [];
  const dependencyWorkProductsByIssueId = new Map<string, typeof dependencyWorkProductRows>();
  for (const product of dependencyWorkProductRows) {
    const products = dependencyWorkProductsByIssueId.get(product.issueId) ?? [];
    products.push(product);
    dependencyWorkProductsByIssueId.set(product.issueId, products);
  }
  const dependencyIssueRowsByIssueId = new Map(
    artifactLookupIssueRows.map((row) => [row.issueId, row]),
  );
  const dependencyWorkProductEvidenceRefs: IssueExecutionCardJson["evidenceRefs"] =
    dependencyWorkProductRows.flatMap((product) => {
      if (product.provider !== "local" && product.provider !== "local_file") return [];
      const localPath = resolveWorkProductLocalFilePath(product);
      if (!localPath) return [];
      const dependencyIssue = dependencyIssueRowsByIssueId.get(product.issueId);
      return [{
        type: "dependency_work_product",
        id: product.id,
        path: localPath,
        description: dependencyIssue
          ? `Registered workProduct from workflow step ${dependencyIssue.stepId}`
          : "Registered dependency workProduct",
      }];
    });
  const dependencyToolArtifactEvidenceRefs = await dependencyToolEvidence(input.db, {
    companyId: input.run.companyId, runId: input.run.id, stepIds: input.step.dependencies,
  });
  const dependencyToolArtifactLines = dependencyToolArtifactEvidenceRefs.map((artifact) =>
    `- ${artifact.description}: ${artifact.path}`,
  );
  const dependencyEvidenceRefs = [
    ...dependencyWorkProductEvidenceRefs,
    ...dependencyToolArtifactEvidenceRefs,
  ];
  // [structured artifact authority] downstream execution recognizes dependency deliverables ONLY via
  //   formally registered workProducts (DB) or machine-produced native tool-result metadata above.
  //   producer-declared `[ARTIFACT]:` markers in issue descriptions/comments/run output are NOT
  //   registration authority and must not satisfy the dependency work-product gate.
  const dependencyHasWorkProduct = (row: { issueId: string }) =>
    (dependencyWorkProductsByIssueId.get(row.issueId) ?? []).length > 0;
  const renderWorkProductSummary = (product: typeof dependencyWorkProductRows[number]) => {
    const artifactRef = product.url ?? product.externalId ?? (
      product.metadata ? JSON.stringify(product.metadata) : "no artifact ref"
    );
    return `${product.title} [${product.type}/${product.status}] ${artifactRef}`;
  };
  const renderArtifactInputLines = (row: {
    issueId: string;
    stepId: string;
    identifier: string | null;
    status: string;
    title: string;
  }) => {
    const label = row.identifier ?? row.issueId;
    const products = dependencyWorkProductsByIssueId.get(row.issueId) ?? [];
    const lines: string[] = [
      `- ${row.stepId}: ${label} (${row.status}) — ${row.title}`,
    ];
    if (products.length > 0) {
      lines.push(`  workProducts: ${products.map(renderWorkProductSummary).join("; ")}`);
    } else {
      lines.push("  workProducts: none registered");
    }
    return lines;
  };
  const dependencyIssueLines = dependencyIssueRows.flatMap((row) => {
    const label = row.identifier ?? row.issueId;
    const products = dependencyWorkProductsByIssueId.get(row.issueId) ?? [];
    const gateProducerStepIds = gateProducerStepIdsByGateStepId.get(row.stepId) ?? [];
    const lines: string[] = [
      `- ${row.stepId}: ${label} (${row.status}) — ${row.title}`,
    ];
    if (products.length > 0) {
      lines.push(`  workProducts: ${products.map(renderWorkProductSummary).join("; ")}`);
    } else if (gateProducerStepIds.length > 0) {
      lines.push(`  gate dependency passed without its own workProduct; use validated upstream workProducts below: ${gateProducerStepIds.join(", ")}`);
    } else {
      lines.push("  workProducts: none registered");
    }
    return lines;
  });
  const validatedUpstreamWorkProductLines = gateValidatedProducerIssueRows.flatMap((row) => {
    const gateStepIds = Array.from(gateProducerStepIdsByGateStepId.entries())
      .filter(([, producerStepIds]) => producerStepIds.includes(row.stepId))
      .map(([gateStepId]) => gateStepId);
    return [
      ...renderArtifactInputLines(row),
      gateStepIds.length > 0 ? `  checkedByGates: ${gateStepIds.join(", ")}` : null,
    ].filter((line) => line !== null);
  });
  const gateStepIds = new Set(gateProducerStepIdsByGateStepId.keys());
  const missingDirectDependencyWorkProductLines = dependencyIssueRows
    .filter((row) => workflowStepsById.get(row.stepId)?.graphWorkProductRequired === true)
    .filter((row) => !dependencyHasWorkProduct(row))
    .filter((row) => !gateStepIds.has(row.stepId))
    .map((row) => `- ${row.stepId}: ${row.identifier ?? row.issueId} has no registered dependency workProduct.`);
  const missingGateValidatedProducerWorkProductLines = gateValidatedProducerIssueRows
    .filter((row) => !dependencyHasWorkProduct(row))
    .map((row) => `- ${row.stepId}: ${row.identifier ?? row.issueId} has no registered dependency workProduct.`);
  const missingDependencyWorkProductLines = [
    ...missingDirectDependencyWorkProductLines,
    ...missingGateValidatedProducerWorkProductLines,
  ];

  const stepName = renderWorkflowRunTextTemplate(input.step.name.trim(), input.run);
  const title = stepName || renderWorkflowRunTextTemplate(input.definition.name, input.run);
  const missionProject = input.run.missionId
    ? await input.db
      .select({ projectId: missions.projectId })
      .from(missions)
      .where(eq(missions.id, input.run.missionId))
      .limit(1)
      .then((rows) => rows[0] ?? null)
    : null;
  const projectId = missionProject?.projectId ?? input.definition.projectId ?? null;
  const workProductPaths = await resolveMissionWorkProductPaths(input.db, {
    companyId: input.run.companyId,
    missionId: input.run.missionId ?? null,
    projectId,
    workflowRunId: input.run.id,
    stepId: input.step.id,
  });
  const requiresWorkProduct = input.step.graphWorkProductRequired === true;
  const renderedStepDescription = input.step.description?.trim()
    ? renderWorkflowRunTextTemplate(input.step.description.trim(), input.run)
    : null;
  const requiresVerdict = !requiresWorkProduct && isQaLikeStep(input.step);
  const qaRubricPath = requiresVerdict && workProductPaths?.stepOutputDir
    ? path.join(workProductPaths.stepOutputDir, "qa-rubric.md")
    : null;
  if (qaRubricPath) {
    // [AREA: Mission Quality Contract] mission goal/title/description 조회(active plan missionGoal 우선 → title+desc fallback).
    let missionGoalForRubric: string | null = null;
    let missionTitleForRubric: string | null = null;
    let missionDescriptionForRubric: string | null = null;
    if (input.run.missionId) {
      const [missionRow] = await input.db
        .select({ title: missions.title, description: missions.description })
        .from(missions)
        .where(and(eq(missions.companyId, input.run.companyId), eq(missions.id, input.run.missionId)))
        .limit(1);
      missionTitleForRubric = missionRow?.title ?? null;
      missionDescriptionForRubric = (missionRow?.description as string | null) ?? null;
      const [activePlanRow] = await input.db
        .select({ missionGoal: missionPlanArtifacts.missionGoal })
        .from(missionPlanArtifacts)
        .where(and(
          eq(missionPlanArtifacts.companyId, input.run.companyId),
          eq(missionPlanArtifacts.missionId, input.run.missionId),
          eq(missionPlanArtifacts.status, "active"),
        ))
        .orderBy(desc(missionPlanArtifacts.revision))
        .limit(1);
      missionGoalForRubric = (activePlanRow?.missionGoal as string | null) ?? null;
    }
    await writeQaRubricMarkdown({
      filePath: qaRubricPath,
      run: input.run,
      definition: input.definition,
      step: input.step,
      renderedStepDescription,
      dependencyIssueLines,
      dependencyContractLines: buildDependencyStepContractLines({
        dependencyRows: dependencyIssueRows,
        workflowStepsById,
      }),
      missingDependencyWorkProductLines,
      missionGoal: missionGoalForRubric,
      missionTitle: missionTitleForRubric,
      missionDescription: missionDescriptionForRubric,
      structuralGateCoverageLines,
    });
  }
  const description = [
    ...(requiresWorkProduct && workProductPaths?.stepOutputDir
      ? buildArtifactOutputDirectoryLines({ outputDir: workProductPaths.stepOutputDir })
      : []),
    requiresWorkProduct && workProductPaths ? "" : null,
    qaRubricPath ? "QA grading rubric:" : null,
    qaRubricPath ? `- ${qaRubricPath}` : null,
    qaRubricPath ? "- Read the rubric file before judging the dependency workProducts. Do not invent extra criteria in the issue body." : null,
    qaRubricPath ? "- Submit the official verdict via the Workflow API closeout below; `REQUEST_CHANGES` requires one findings entry per blocking defect." : null,
    qaRubricPath ? null : renderedStepDescription,
    ...buildStepContractDescriptionLines({ contract: input.step.contract, run: input.run }),
    ...structuralGateCoverageLines,
    "",
    "Workflow execution boundary:",
    `- workflowRunId: ${input.run.id}`,
    `- workflowDefinitionId: ${input.definition.id}`,
    `- missionId: ${input.run.missionId ?? "none"}`,
    `- stepId: ${input.step.id}`,
    `- dependencyStepIds: ${JSON.stringify(input.step.dependencies)}`,
    dependencyIssueLines.length > 0 ? "Dependency issue inputs:" : null,
    ...dependencyIssueLines,
    dependencyToolArtifactLines.length > 0 ? "Dependency tool artifacts:" : null,
    ...dependencyToolArtifactLines,
    validatedUpstreamWorkProductLines.length > 0 ? "Validated upstream workProducts:" : null,
    ...validatedUpstreamWorkProductLines,
    missingDependencyWorkProductLines.length > 0 ? "Dependency workProduct hard-stop:" : null,
    ...missingDependencyWorkProductLines,
    missingDependencyWorkProductLines.length > 0
      ? "- Registered dependency workProducts above are the only official upstream artifacts. Do not infer dependency deliverables from guessed filesystem paths, sibling run folders, old dates, or unrelated comments."
      : null,
    missingDependencyWorkProductLines.length > 0
      ? "- If this step needs that dependency deliverable for validation, synthesis, build, publish, or approval, stop and leave a blocker/REQUEST_CHANGES naming the missing dependency workProduct instead of producing a guessed result."
      : null,
    "- Treat issue ids from other missions or workflow runs as out of scope, even when their titles are similar.",
    "",
    ...buildWorkflowApiCloseoutLines({ requiresWorkProduct, requiresVerdict }),
    "",
    ...(requiresWorkProduct ? buildWorkProductRegistrationContractLines() : []),
    !requiresWorkProduct ? "- For QA/validator steps, validate dependency issue workProducts above; do not require a QA issue to have its own workProduct unless QA creates a separate deliverable." : null,
  ].filter((line) => line !== null).join("\n");

  // [idempotency] 같은 run + 같은 STEP 의 기존 workflow_execution issue 가 살아있으면
  // (cancelled 제외) 재사용. step 실패→재시도/Unblock 시 createWorkflowStepIssue 가 매번 새
  // issue 를 찍어 signal/sector/narrative 가 처음부터 반복되는 것(가즈아 gazua-morning
  // CMPA-5415→5419→5424→5427→5430 반복) 을 막는다. done/blocked issue 도 재사용 — 이후
  // dispatch 의 wake/skip 이 상태를 판단한다(이미 done 이면 재실행 안 함).
  // [B: same-title step collision] title 만으로 재사용하면 같은 run 안에서 서로 다른 stepId 가
  // 같은 title(예: 두 개의 "[QA] Verify mission result") 을 쓰는 경우 둘 다 같은 issue 를
  // 가리키게 되어 verdict/validation 바인딩이 깨진다. 반드시 workflowStepRuns.stepId 로
  // exact step 매칭을 해야 한다. stepRun.issueId 는 첫 생성 시점엔 null 이므로(생성 후
  // update 로 연결), 같은 run + 같은 stepId 의 다른 stepRun 이 이미 issue 를 갖고 있으면
  // 그 issue 를 재사용한다. 같은-title legacy issue(step 매칭 불가) 는 재사용하지 않는다.
  const reusable = await input.db
    .select({
      id: issues.id,
      status: issues.status,
      description: issues.description,
      assigneeAgentId: issues.assigneeAgentId,
      projectId: issues.projectId,
      missionId: issues.missionId,
    })
    .from(workflowStepRuns)
    .innerJoin(issues, eq(issues.id, workflowStepRuns.issueId))
    .where(and(
      eq(workflowStepRuns.workflowRunId, input.run.id),
      eq(workflowStepRuns.stepId, input.step.id),
      eq(issues.originRunId, input.run.id),
      eq(issues.originKind, "workflow_execution"),
      ne(issues.status, "cancelled"),
    ))
    .orderBy(desc(workflowStepRuns.iterationIndex), desc(workflowStepRuns.startedAt))
    .limit(1);
  if (reusable.length > 0) {
    const reusableIssue = reusable[0];
    if (reusableIssue) {
      await upsertWorkflowIssueExecutionCard({
        db: input.db,
        companyId: input.run.companyId,
        issueId: reusableIssue.id,
        title,
        description: reusableIssue.description ?? description,
        assigneeAgentId: reusableIssue.assigneeAgentId,
        projectId: reusableIssue.projectId,
        missionId: reusableIssue.missionId,
        workflowDefinitionId: input.definition.id,
        workflowRunId: input.run.id,
        step: input.step,
        stepOutputDir: workProductPaths?.stepOutputDir ?? null,
        qaRubricPath,
        evidenceRefs: dependencyEvidenceRefs,
      });
      return reusableIssue.id;
    }
  }

  const autoApproveTools = input.step.autoApproveTools === true;
  const createdIssue = await issueSvc.create(input.run.companyId, {
    title,
    description,
    status: "todo",
    assigneeAgentId,
    projectId,
    missionId: input.run.missionId ?? null,
    originKind: "workflow_execution",
    originId: input.run.id,
    originRunId: input.run.id,
    ...(autoApproveTools
      ? { assigneeAdapterOverrides: { adapterConfig: { autoApproveTools: true } } }
      : {}),
  });

  const executionCardRow = await upsertWorkflowIssueExecutionCard({
    db: input.db,
    companyId: input.run.companyId,
    issueId: createdIssue.id,
    title,
    description,
    assigneeAgentId,
    projectId,
    missionId: input.run.missionId ?? null,
    workflowDefinitionId: input.definition.id,
    workflowRunId: input.run.id,
    step: input.step,
    stepOutputDir: workProductPaths?.stepOutputDir ?? null,
    qaRubricPath,
    evidenceRefs: dependencyEvidenceRefs,
  });

  // [qa-cap acceptance] inject predecessor cap-accepted nonblocking limitations so a freshly
  //   created downstream issue carries them in both execution payload and contextSnapshot.
  const capAcceptanceContext = await loadDownstreamQaCapAcceptanceContext({
    db: input.db,
    workflowRunId: input.run.id,
    predecessorStepIds: resolveEdges(input.step).filter((e) => e.isBackEdge !== true).map((e) => e.stepId),
  });
  const capAcceptancePayload = capAcceptanceContext.accepted.length > 0
    ? { acceptedQaLimitations: capAcceptanceContext }
    : {};

  const sideEffectsDb = input.deferredSideEffectsDb ?? input.db;
  const applyCreatedSideEffects = () => applyIssueCreatedSideEffects({
    db: sideEffectsDb,
    heartbeat: heartbeatService(sideEffectsDb),
    issue: createdIssue,
    actor: {
      actorType: "system",
      actorId: `workflow:${input.definition.id}`,
    },
    contextSource: "workflow.dispatch",
    payload: {
      ...(input.run.missionId ? { missionId: input.run.missionId } : {}),
      workflowRunId: input.run.id,
      workflowDefinitionId: input.definition.id,
      workflowStepId: input.step.id,
      issueExecutionCardId: executionCardRow.id,
      issueExecutionCardHash: executionCardRow.contentHash,
      ...capAcceptancePayload,
    },
    contextSnapshot: {
      taskId: createdIssue.id,
      ...(input.run.missionId ? { missionId: input.run.missionId } : {}),
      workflowRunId: input.run.id,
      workflowDefinitionId: input.definition.id,
      workflowStepId: input.step.id,
      stepId: input.step.id,
      paperclipIssueExecutionCard: executionCardRow.cardJson,
      paperclipIssueExecutionCardId: executionCardRow.id,
      paperclipIssueExecutionCardHash: executionCardRow.contentHash,
      ...capAcceptancePayload,
    },
    waitForWakeCompletion: true,
  });
  // [T3] 지정 시 부작용 apply 를 호출자에게 넘긴다(연결 commit 후), 아니면 기존대로 즉시 적용.
  if (input.captureDeferredSideEffects) input.captureDeferredSideEffects(applyCreatedSideEffects);
  else await applyCreatedSideEffects();

  return createdIssue.id;
}

import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issueComments, issueWorkProducts, issues, workflowStepRuns } from "@paperclipai/db";
import type { WorkflowVerdictFinding } from "@paperclipai/shared/validators/workflow-agent-api";
import type { WorkflowExecutionContext, WorkflowStep } from "./dag-engine.js";
import { logActivity } from "../activity-log.js";
import { checkDependencyFreshness } from "./control-flow/structural-completion.js";
import { loadWorkflowApiFindings } from "./validation-verdict-ledger.js";
import { wakeExistingWorkflowStepIssue } from "./workflow-step-wake.js";

type ValidationIssueState = Pick<typeof issues.$inferSelect,
  "id" | "companyId" | "status" | "startedAt" | "completedAt" | "cancelledAt" | "title" | "originKind">;

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function commentOnValidationRecheckQueued(input: {
  db: Db;
  companyId: string;
  issueId: string;
  workflowRunId: string;
  step: WorkflowStep;
  priorFindings?: readonly WorkflowVerdictFinding[];
}): Promise<void> {
  const dependencyStepIds = input.step.dependencies;
  const dependencyRows = dependencyStepIds.length > 0
    ? await input.db
      .select({
        stepId: workflowStepRuns.stepId,
        issueId: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
      })
      .from(workflowStepRuns)
      .innerJoin(issues, eq(workflowStepRuns.issueId, issues.id))
      .where(and(
        eq(workflowStepRuns.workflowRunId, input.workflowRunId),
        inArray(workflowStepRuns.stepId, dependencyStepIds),
      ))
    : [];

  const order = new Map(dependencyStepIds.map((stepId, index) => [stepId, index]));
  dependencyRows.sort((a, b) => (order.get(a.stepId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.stepId) ?? Number.MAX_SAFE_INTEGER));

  const workProductRows = dependencyRows.length > 0
    ? await input.db
      .select({
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
      .where(inArray(issueWorkProducts.issueId, dependencyRows.map((row) => row.issueId)))
    : [];

  const workProductsByIssueId = new Map<string, typeof workProductRows>();
  for (const product of workProductRows) {
    const products = workProductsByIssueId.get(product.issueId) ?? [];
    products.push(product);
    workProductsByIssueId.set(product.issueId, products);
  }

  const renderWorkProductSummary = (product: typeof workProductRows[number]) => {
    const metadata = normalizeRecord(product.metadata);
    const metadataPath = typeof metadata.path === "string" ? metadata.path : null;
    const artifactRef = metadataPath ?? product.url ?? product.externalId ?? (
      product.metadata ? JSON.stringify(product.metadata) : "no artifact ref"
    );
    return `${product.title} [${product.type}/${product.status}] ${artifactRef}`;
  };

  const dependencyIssueLines = dependencyRows.flatMap((row) => {
    const products = workProductsByIssueId.get(row.issueId) ?? [];
    const lines = [
      `- ${row.stepId}: ${row.identifier ?? row.issueId} (${row.status}) — ${row.title}`,
    ];
    if (products.length > 0) {
      lines.push(`  workProducts: ${products.map(renderWorkProductSummary).join("; ")}`);
    } else {
      lines.push("  workProducts: none registered");
    }
    return lines;
  });

  const missingWorkProductLines = dependencyRows
    .filter((row) => (workProductsByIssueId.get(row.issueId) ?? []).length === 0)
    .map((row) => `- ${row.stepId}: ${row.identifier ?? row.issueId} has no registered dependency workProduct.`);

  await input.db.insert(issueComments).values({
    companyId: input.companyId,
    issueId: input.issueId,
    body: [
      "### Workflow validation recheck\nA validation recheck was requested because the dependency artifacts changed. Next action: inspect the updated inputs and the next official verdict; this request does not confirm a new review result.",
      "",
      "The producer/dependency completed after the previous REQUEST_CHANGES verdict.",
      "Re-run this validation using the current dependency workProducts below.",
      "",
      `- workflowRunId: ${input.workflowRunId}`,
      `- stepId: ${input.step.id}`,
      `- dependencyStepIds: ${JSON.stringify(dependencyStepIds)}`,
      "",
      ...(input.priorFindings && input.priorFindings.length > 0
        ? [
          "**Verify these previous REQUEST_CHANGES findings FIRST**, then continue the full checklist:",
          ...input.priorFindings.map((finding) => `- [${finding.layer}] ${finding.id}: ${finding.summary}`),
          "",
        ]
        : []),
      "Current dependency issue inputs:",
      ...(dependencyIssueLines.length > 0 ? dependencyIssueLines : ["- No dependency issue inputs are registered for this step."]),
      ...(missingWorkProductLines.length > 0
        ? [
            "",
            "Missing dependency hard-stop:",
            ...missingWorkProductLines,
            "- If this validation needs a missing dependency deliverable, submit `REQUEST_CHANGES` with a findings entry naming the missing workProduct.",
          ]
        : []),
    ].join("\n"),
  });
}

// [Patch 3 recheck idempotency] validation issue 별 latest succeeded heartbeat finishedAt.
//   syncStepRunsFromIssueState 가 같은 producer generation 에 대해 중복 실행 요청을 만들지 않도록 한다:
//   "이미 recheck heartbeat 가 producer 최종 완료 이후에 성공했다면 재요청 금지" 판정 재료.
//   A1 RES-424 사례: 재실행 run 은 succeeded 였으나 explicit PASS verdict 가 없어 latestValidationVerdict
//   가 구 REQUEST_CHANGES 에 머물 → 이후 sync 마다 QA 실행 요청이 반복되던 stale duplicate.
async function loadLatestSucceededHeartbeatAt(db: Db, issueIds: string[]): Promise<Map<string, Date>> {
  const latest = new Map<string, Date>();
  if (issueIds.length === 0) return latest;
  const rows = await db
    .select({ issueId: heartbeatRuns.issueId, finishedAt: heartbeatRuns.finishedAt, createdAt: heartbeatRuns.createdAt })
    .from(heartbeatRuns)
    .where(and(inArray(heartbeatRuns.issueId, issueIds), eq(heartbeatRuns.status, "succeeded")))
    .orderBy(desc(heartbeatRuns.finishedAt), desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id));
  for (const row of rows) {
    if (!row.issueId) continue;
    if (latest.has(row.issueId)) continue; // desc 정렬 → 첫 행이 최신
    const at = row.finishedAt ?? row.createdAt;
    if (at) latest.set(row.issueId, at);
  }
  return latest;
}

export async function recheckValidationStepIssues(input: {
  db: Db;
  stepRuns: (typeof workflowStepRuns.$inferSelect)[];
  stepById: Map<string, WorkflowStep>;
  issueById: Map<string, ValidationIssueState>;
  validationCandidateIssueIds: string[];
  latestValidationVerdictByIssueId: Map<string, { verdict: "pass" | "request_changes" | null; observedAt: Date | null }>;
  context?: WorkflowExecutionContext;
}, callbacks: {
  isValidationGateCandidate: (input: {
    issueTitle?: string | null;
    issueOriginKind?: string | null;
    step?: WorkflowStep | null;
  }) => boolean;
  collectGateValidatedProducerStepIds: (stepIds: string[], stepById: Map<string, WorkflowStep>) => Map<string, string[]>;
}): Promise<void> {
  const { db, stepRuns, stepById, issueById, validationCandidateIssueIds, latestValidationVerdictByIssueId, context } = input;
  const { isValidationGateCandidate, collectGateValidatedProducerStepIds } = callbacks;
  // [Patch 3] validation-recheck idempotency: 각 validation issue 의 latest succeeded heartbeat 시각.
  const latestSucceededHeartbeatByIssueId = await loadLatestSucceededHeartbeatAt(db, validationCandidateIssueIds);

  const stepRunByStepId = new Map(stepRuns.map((stepRun) => [stepRun.stepId, stepRun]));
  for (const stepRun of stepRuns) {
    if (!stepRun.issueId) continue;
    const issue = issueById.get(stepRun.issueId);
    if (!issue || (issue.status !== "blocked" && issue.status !== "done")) continue;
    const step = stepById.get(stepRun.stepId);
    if (!step || step.dependencies.length === 0) continue;
    if (!isValidationGateCandidate({ issueTitle: issue.title, issueOriginKind: issue.originKind, step })) continue;

    const latestVerdict = latestValidationVerdictByIssueId.get(issue.id);
    if (latestVerdict?.verdict !== "request_changes" || !latestVerdict.observedAt) continue;

    // [Hybrid QA] Tolerate issue-less structural tool gate dependencies (extracted).
    const depCheck = checkDependencyFreshness(step.dependencies, stepRunByStepId, issueById);
    if (!depCheck.allFound || !depCheck.allDone) continue;
    if (depCheck.maxCompletedAt === 0) continue;
    // [Transitive producer freshness] A reworked producer can sit 2+ hops above
    //   the QA step (producer → intermediate QA/gate → semantic QA). Direct-dep
    //   freshness then never advances after a producer rework and the recheck is
    //   skipped forever — the QA re-fire chain dead-ends silently and the run
    //   finalizes failed (gazua-evening 2026-08-20: producer gen2 completed 09:22,
    //   direct-dep max stayed 09:04 < RC verdict 09:11 → owner-action stall).
    //   Include gate-validated producers' completion times so a reworked producer
    //   generation re-arms the recheck regardless of DAG topology.
    let freshnessMaxCompletedAt = depCheck.maxCompletedAt;
    for (const producerStepIds of collectGateValidatedProducerStepIds(step.dependencies, stepById).values()) {
      for (const producerStepId of producerStepIds) {
        const producerRun = stepRunByStepId.get(producerStepId);
        if (!producerRun) continue;
        const producerIssue = producerRun.issueId ? issueById.get(producerRun.issueId) : undefined;
        const producerCompletedMs = producerIssue
          ? (producerIssue.completedAt?.getTime() ?? 0)
          : (producerRun.completedAt?.getTime() ?? 0);
        if (producerCompletedMs > freshnessMaxCompletedAt) freshnessMaxCompletedAt = producerCompletedMs;
      }
    }
    if (freshnessMaxCompletedAt <= latestVerdict.observedAt.getTime()) continue;
    // [Patch 3 recheck idempotency] 같은 producer generation 에 대해 validation 이 이미 재실행됐으면
    //   중복 실행 요청을 만들지 않는다. producer 최종 완료(dependencyMaxCompletedAt) 이후에 succeeded heartbeat 가
    //   한 번이라도 있으면 이미 이 generation 산출물을 recheck 한 것 — explicit verdict 유무와 무관하게 duplicate
    //   request 를 끊는다. 이후 producer 가 다시 rework 되면 dependencyMaxCompletedAt 이 더 뒤로 갱신돼 재요청이 허용된다.
    const dependencyMaxCompletedAt = freshnessMaxCompletedAt;
    const latestRecheckAt = latestSucceededHeartbeatByIssueId.get(issue.id);
    if (latestRecheckAt && latestRecheckAt.getTime() >= dependencyMaxCompletedAt) continue;

    if (!context) continue;
    // [recheck priority] Load the structured findings from the latest REQUEST_CHANGES
    //   so the re-check can verify the previous fixes FIRST, then run the full
    //   checklist. Machine contract only (workflow_api findings payload); absent
    //   findings (legacy verdicts) degrade to the previous behavior.
    let priorFindings: readonly WorkflowVerdictFinding[] | undefined;
    try {
      priorFindings = await loadWorkflowApiFindings({
        db,
        companyId: issue.companyId,
        issueId: issue.id,
        workflowRunId: stepRun.workflowRunId,
        workflowStepRunId: stepRun.id,
      }) ?? undefined;
    } catch {
      priorFindings = undefined;
    }
    // [Hybrid QA] Force fresh session on semantic QA recheck so stale verdict/session
    //   state is not reused after a new producer generation.
    const queued = await wakeExistingWorkflowStepIssue({
      db,
      run: context.run,
      definition: context.definition,
      step,
      stepRunId: stepRun.id,
      stepRunMetadata: stepRun.metadata,
      issueId: issue.id,
      allowCompletedIssue: true,
      allowBlockedIssue: true,
      forceFreshSession: true,
      priorFindings,
    });
    if (!queued) continue;

    const [updatedIssue] = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        status: issues.status,
        startedAt: issues.startedAt,
        completedAt: issues.completedAt,
        cancelledAt: issues.cancelledAt,
        title: issues.title,
        originKind: issues.originKind,
      })
      .from(issues)
      .where(eq(issues.id, issue.id))
      .limit(1);
    if (updatedIssue) issueById.set(updatedIssue.id, updatedIssue);
    await commentOnValidationRecheckQueued({
      db,
      companyId: issue.companyId,
      issueId: issue.id,
      workflowRunId: stepRun.workflowRunId,
      step,
      ...(priorFindings && priorFindings.length > 0 ? { priorFindings } : {}),
    });
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: "workflow:validation-recheck",
      action: "workflow.validation_recheck_queued",
      entityType: "issue",
      entityId: issue.id,
      details: {
        workflowRunId: stepRun.workflowRunId,
        workflowStepRunId: stepRun.id,
        stepId: step.id,
        dependencyStepIds: step.dependencies,
        reason: "dependency_completed_after_request_changes",
        requestChangesObservedAt: latestVerdict.observedAt.toISOString(),
      },
    });
  }
}

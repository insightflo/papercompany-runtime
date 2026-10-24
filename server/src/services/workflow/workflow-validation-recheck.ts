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

// A successful execution suppresses duplicate requests only if it STARTED after the
// current producer completed. A late finish of an older input is not a recheck.
// Retain the latest start across all successes: an older A can finish after B's recheck.
// This is request deduplication only, never an official verdict or correction consumption.
async function loadLatestSucceededHeartbeatStartedAt(db: Db, issueIds: string[]): Promise<Map<string, Date>> {
  const latest = new Map<string, Date>();
  if (issueIds.length === 0) return latest;
  const rows = await db
    .select({ issueId: heartbeatRuns.issueId, startedAt: heartbeatRuns.startedAt })
    .from(heartbeatRuns)
    .where(and(inArray(heartbeatRuns.issueId, issueIds), eq(heartbeatRuns.status, "succeeded")))
    .orderBy(desc(heartbeatRuns.startedAt), desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id));
  for (const row of rows) {
    if (!row.issueId || !row.startedAt || latest.has(row.issueId)) continue;
    latest.set(row.issueId, row.startedAt);
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
  // Successful START evidence is only a duplicate-request fence, not a current-input verdict.
  const latestSucceededHeartbeatByIssueId = await loadLatestSucceededHeartbeatStartedAt(db, validationCandidateIssueIds);

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
    // Preserve same-generation request deduplication only for a success started at/after
    // producer completion. An A execution finishing late cannot suppress the B request.
    // A later producer completion re-arms the request; official QA still needs its own proof.
    const dependencyMaxCompletedAt = freshnessMaxCompletedAt;
    const latestRecheckStartedAt = latestSucceededHeartbeatByIssueId.get(issue.id);
    if (latestRecheckStartedAt && latestRecheckStartedAt.getTime() >= dependencyMaxCompletedAt) continue;

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

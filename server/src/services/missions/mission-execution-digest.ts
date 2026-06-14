import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issueComments,
  issueWorkProducts,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";

type DigestWorkflowStep = {
  id: string;
  name: string;
  dependencies: string[];
  toolNames?: string[];
};

function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactDigestText(value: string, maxLength = 240): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  return compacted.length > maxLength ? `${compacted.slice(0, maxLength - 1)}...` : compacted;
}

function issueDigestLabel(issue: { id: string; identifier: string | null }): string {
  return issue.identifier ?? issue.id;
}

function metadataDigestPath(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null;
  const direct = asTrimmedString(metadata.path)
    ?? asTrimmedString(metadata.filePath)
    ?? asTrimmedString(metadata.artifactPath)
    ?? asTrimmedString(metadata.obsidianPath)
    ?? asTrimmedString(metadata.outputPath);
  if (direct) return direct;
  const artifact = isRecord(metadata.artifact) ? metadata.artifact : null;
  return artifact
    ? asTrimmedString(artifact.path)
      ?? asTrimmedString(artifact.filePath)
      ?? asTrimmedString(artifact.artifactPath)
    : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function normalizeWorkflowStepsForDigest(rawSteps: unknown): DigestWorkflowStep[] {
  if (!Array.isArray(rawSteps)) return [];
  return rawSteps.map((rawStep) => {
    const step = isRecord(rawStep) ? rawStep : {};
    const rawId = asTrimmedString(step.id);
    const id = rawId ?? crypto.randomUUID();
    return {
      id,
      name: asTrimmedString(step.name) ?? asTrimmedString(step.title) ?? rawId ?? "Untitled step",
      dependencies: asStringArray(step.dependencies).length > 0
        ? asStringArray(step.dependencies)
        : asStringArray(step.dependsOn),
      toolNames: [
        ...asStringArray(step.toolNames),
        ...asStringArray(step.tools),
        ...(asTrimmedString(step.toolName) ? [asTrimmedString(step.toolName)!] : []),
      ],
    };
  });
}

const MISSION_WORKFLOW_STEP_STATUSES = new Set([
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
]);

function normalizeMissionWorkflowStepStatus(status: string): "pending" | "running" | "completed" | "failed" | "skipped" {
  return MISSION_WORKFLOW_STEP_STATUSES.has(status) ? status as "pending" | "running" | "completed" | "failed" | "skipped" : "pending";
}

export async function buildMissionExecutionDigest(
  db: Db,
  input: {
    mission: Pick<typeof missions.$inferSelect, "id" | "companyId" | "description">;
    blockedIssue: Pick<typeof issues.$inferSelect, "id" | "identifier" | "status" | "assigneeAgentId">;
  },
): Promise<string[]> {
  const { mission, blockedIssue } = input;
  const lines: string[] = [];
  lines.push(`Mission description: ${mission.description ? compactDigestText(mission.description, 320) : "(none)"}`);
  lines.push(`Blocked source: ${issueDigestLabel(blockedIssue)} status=${blockedIssue.status} assignee=${blockedIssue.assigneeAgentId ?? "unassigned"}`);

  const runRows = await db
    .select({
      run: workflowRuns,
      workflowName: workflowDefinitions.name,
      workflowSteps: workflowDefinitions.stepsJson,
    })
    .from(workflowRuns)
    .innerJoin(workflowDefinitions, eq(workflowRuns.workflowId, workflowDefinitions.id))
    .where(and(eq(workflowRuns.companyId, mission.companyId), eq(workflowRuns.missionId, mission.id)))
    .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
    .limit(3);
  if (runRows.length === 0) {
    lines.push("Workflow runs: none linked to this mission.");
  }

  const runIds = runRows.map((row) => row.run.id);
  const stepRunRows = runIds.length
    ? await db.select().from(workflowStepRuns).where(inArray(workflowStepRuns.workflowRunId, runIds))
    : [];
  const stepIssueIds = Array.from(new Set(stepRunRows.map((stepRun) => stepRun.issueId).filter((issueId): issueId is string => Boolean(issueId))));
  const stepIssues = stepIssueIds.length
    ? await db
        .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
        .from(issues)
        .where(inArray(issues.id, stepIssueIds))
    : [];
  const stepIssueById = new Map(stepIssues.map((issue) => [issue.id, issue]));
  const stepRunsByRunId = new Map<string, Array<typeof workflowStepRuns.$inferSelect>>();
  for (const stepRun of stepRunRows) {
    const entries = stepRunsByRunId.get(stepRun.workflowRunId) ?? [];
    entries.push(stepRun);
    stepRunsByRunId.set(stepRun.workflowRunId, entries);
  }

  for (const { run, workflowName, workflowSteps } of runRows) {
    const startedAt = run.startedAt ? run.startedAt.toISOString() : "not_started";
    const completedAt = run.completedAt ? run.completedAt.toISOString() : "open";
    const definitionSteps = normalizeWorkflowStepsForDigest(workflowSteps);
    const definitionStepOrder = new Map(definitionSteps.map((step, index) => [step.id, index]));
    const rawStepRuns = [...(stepRunsByRunId.get(run.id) ?? [])].sort((left, right) => {
      const leftIndex = definitionStepOrder.get(left.stepId) ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = definitionStepOrder.get(right.stepId) ?? Number.MAX_SAFE_INTEGER;
      return leftIndex - rightIndex || left.stepId.localeCompare(right.stepId);
    });
    const stepRunByStepId = new Map(rawStepRuns.map((stepRun) => [stepRun.stepId, stepRun]));
    const steps = definitionSteps.map((step) => {
      const stepRun = stepRunByStepId.get(step.id);
      const toolNames = Array.isArray(step.toolNames)
        ? step.toolNames.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : [];
      return {
        stepId: step.id,
        name: step.name,
        dependencies: [...step.dependencies],
        toolNames,
        status: normalizeMissionWorkflowStepStatus(stepRun?.status ?? "pending"),
        issueId: stepRun?.issueId ?? null,
        issue: stepRun?.issueId ? stepIssueById.get(stepRun.issueId) ?? null : null,
      };
    });
    const knownStepIds = new Set(definitionSteps.map((step) => step.id));
    for (const stepRun of rawStepRuns) {
      if (knownStepIds.has(stepRun.stepId)) continue;
      steps.push({
        stepId: stepRun.stepId,
        name: stepRun.stepId,
        dependencies: [],
        toolNames: [],
        status: normalizeMissionWorkflowStepStatus(stepRun.status),
        issueId: stepRun.issueId,
        issue: stepRun.issueId ? stepIssueById.get(stepRun.issueId) ?? null : null,
      });
    }

    lines.push(`Workflow run: ${workflowName ?? run.workflowId} (${run.id}) status=${run.status} started=${startedAt} completed=${completedAt}`);
    const remainingSteps = steps
      .filter((step) => !["completed", "done"].includes(step.status))
      .map((step) => `${step.stepId}:${step.status}`);
    lines.push(`Remaining workflow steps: ${remainingSteps.length ? remainingSteps.join(", ") : "none"}`);
    for (const step of steps.slice(0, 12)) {
      const issuePart = step.issue
        ? ` issue=${issueDigestLabel(step.issue)} issueStatus=${step.issue.status}`
        : step.issueId
          ? ` issue=${step.issueId}`
          : "";
      const dependencyPart = step.dependencies.length ? ` deps=[${step.dependencies.join(",")}]` : "";
      const toolPart = step.toolNames.length ? ` tools=[${step.toolNames.join(",")}]` : "";
      lines.push(`Step ${step.stepId} (${step.name}) status=${step.status}${issuePart}${dependencyPart}${toolPart}`);
    }
    if (steps.length > 12) {
      lines.push(`Step list truncated: ${steps.length - 12} additional steps omitted.`);
    }
  }

  const missionIssueRows = await db
    .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
    .from(issues)
    .where(eq(issues.missionId, mission.id))
    .orderBy(asc(issues.createdAt), asc(issues.id));
  const missionIssueIds = missionIssueRows.map((issue) => issue.id);
  if (missionIssueIds.length > 0) {
    const issueById = new Map(missionIssueRows.map((issue) => [issue.id, issue]));
    const workProducts = await db
      .select()
      .from(issueWorkProducts)
      .where(inArray(issueWorkProducts.issueId, missionIssueIds))
      .orderBy(desc(issueWorkProducts.updatedAt), desc(issueWorkProducts.createdAt), desc(issueWorkProducts.id))
      .limit(6);
    for (const product of workProducts) {
      const sourceIssue = issueById.get(product.issueId);
      const productPath = metadataDigestPath(product.metadata ?? undefined);
      const location = product.url ?? productPath;
      lines.push([
        `Work product ${sourceIssue ? issueDigestLabel(sourceIssue) : product.issueId}:`,
        `${product.title} type=${product.type} status=${product.status}`,
        location ? `location=${location}` : null,
      ].filter(Boolean).join(" "));
    }
  }

  const latestComments = await db
    .select({ body: issueComments.body, createdAt: issueComments.createdAt })
    .from(issueComments)
    .where(eq(issueComments.issueId, blockedIssue.id))
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
    .limit(3);
  for (const comment of latestComments) {
    lines.push(`Latest blocker signal ${comment.createdAt.toISOString()}: ${compactDigestText(comment.body, 360)}`);
  }

  return lines.slice(0, 48);
}

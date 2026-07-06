import path from "node:path";
import type { Db } from "@paperclipai/db";
import { issues, issueWorkProducts } from "@paperclipai/db";
import { and, eq, ne } from "drizzle-orm";
import type {
  WorkflowArtifactRegister,
  WorkflowIssueComplete,
  WorkflowVerdictSubmit,
} from "@paperclipai/shared/validators/workflow-agent-api";
import { notFound, unprocessable } from "../../errors.js";
import { issueService } from "../issues.js";
import { toIssueWorkProduct, workProductService } from "../work-products.js";
import { isPathInsideOrEqual, resolveMissionWorkProductPaths } from "../work-products/output-paths.js";
import { workflowService } from "./engine.js";
import { recordWorkflowValidationVerdict } from "./validation-verdict-ledger.js";

type IssueRow = typeof issues.$inferSelect;

export type WorkflowApiIssue = Pick<
  IssueRow,
  "id" | "companyId" | "missionId" | "projectId" | "originKind" | "title" | "startedAt"
>;

export type WorkflowApiActor = {
  readonly actorType: "agent" | "user";
  readonly actorId: string;
  readonly agentId: string | null;
  readonly runId: string | null;
};

function artifactTitle(input: WorkflowArtifactRegister): string {
  return input.title?.trim() || path.basename(input.path.trim()) || "Workflow artifact";
}

async function findExistingWorkflowArtifact(input: {
  readonly db: Db;
  readonly issue: WorkflowApiIssue;
  readonly artifactPath: string;
}) {
  const row = await input.db
    .select()
    .from(issueWorkProducts)
    .where(and(
      eq(issueWorkProducts.companyId, input.issue.companyId),
      eq(issueWorkProducts.issueId, input.issue.id),
      eq(issueWorkProducts.provider, "local_file"),
      eq(issueWorkProducts.externalId, input.artifactPath),
      ne(issueWorkProducts.status, "archived"),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row ? toIssueWorkProduct(row) : null;
}

async function assertWorkflowArtifactPath(input: {
  readonly db: Db;
  readonly issue: WorkflowApiIssue;
  readonly artifactPath: string;
}) {
  const paths = await resolveMissionWorkProductPaths(input.db, {
    companyId: input.issue.companyId,
    projectId: input.issue.projectId,
    missionId: input.issue.missionId,
  });
  if (!paths) return;
  if (!isPathInsideOrEqual(input.artifactPath, paths.missionOutputDir)) {
    throw unprocessable("Workflow artifact path must be inside this mission's workProduct output directory");
  }
}

export async function registerWorkflowArtifact(input: {
  readonly db: Db;
  readonly issue: WorkflowApiIssue;
  readonly actor: WorkflowApiActor;
  readonly data: WorkflowArtifactRegister;
}) {
  const artifactPath = input.data.path.trim();
  if (!path.isAbsolute(artifactPath)) {
    throw unprocessable("Workflow artifact path must be an absolute local path");
  }
  await assertWorkflowArtifactPath({ db: input.db, issue: input.issue, artifactPath });

  const existing = await findExistingWorkflowArtifact({ db: input.db, issue: input.issue, artifactPath });
  if (existing) return existing;

  const product = await workProductService(input.db).createForIssue(input.issue.id, input.issue.companyId, {
    projectId: input.issue.projectId ?? null,
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: input.data.type,
    provider: "local_file",
    externalId: artifactPath,
    title: artifactTitle(input.data),
    url: null,
    status: "active",
    reviewState: "none",
    isPrimary: input.data.isPrimary,
    healthStatus: "unknown",
    summary: input.data.summary ?? null,
    metadata: {
      path: artifactPath,
      registeredVia: "workflow_api",
      registeredByRunId: input.actor.runId,
    },
    createdByRunId: input.actor.runId,
  });
  if (!product) {
    throw unprocessable("Workflow artifact path must point to an existing local file");
  }
  await workflowService.syncRunStatusForIssue(input.db, input.issue.id);
  return product;
}

export async function submitWorkflowVerdict(input: {
  readonly db: Db;
  readonly issue: WorkflowApiIssue;
  readonly actor: WorkflowApiActor;
  readonly data: WorkflowVerdictSubmit;
}) {
  const result = await recordWorkflowValidationVerdict({
    db: input.db,
    issue: input.issue,
    verdict: input.data.verdict,
    source: "workflow_api",
    actorAgentId: input.actor.agentId,
    heartbeatRunId: input.actor.runId,
    sourceText: input.data.reason ?? input.data.verdict,
  });
  if (!result.isCandidate) {
    throw unprocessable("Workflow verdict API can only be used on workflow QA or validation issues");
  }
  if (!result.satisfied) {
    throw unprocessable("Workflow verdict ledger was not recorded");
  }
  await workflowService.syncRunStatusForIssue(input.db, input.issue.id);
  return result;
}

export async function completeWorkflowIssue(input: {
  readonly db: Db;
  readonly issue: WorkflowApiIssue;
  readonly actor: WorkflowApiActor;
  readonly data: WorkflowIssueComplete;
}) {
  const svc = issueService(input.db);
  const comment = input.data.comment?.trim();
  if (comment) {
    await svc.addComment(input.issue.id, comment, {
      agentId: input.actor.agentId ?? undefined,
      userId: input.actor.actorType === "user" ? input.actor.actorId : undefined,
    });
  }
  const updated = await svc.update(input.issue.id, { status: "done" });
  if (!updated) throw notFound("Issue not found");
  await workflowService.syncRunStatusForIssue(input.db, input.issue.id);
  return updated;
}

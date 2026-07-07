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

type WorkflowPreviewUrlRegister = {
  readonly type: "preview_url";
  readonly url: string;
  readonly title?: string;
  readonly externalId?: string;
  readonly expectedTitle?: string;
  readonly contentMarker?: string;
  readonly marker?: string;
  readonly topic?: string;
  readonly summary?: string | null;
  readonly isPrimary: boolean;
};

type WorkflowLocalArtifactRegister = {
  readonly path: string;
  readonly title?: string;
  readonly type: "artifact" | "document";
  readonly summary?: string | null;
  readonly isPrimary: boolean;
};

function isPreviewUrlRegister(data: WorkflowArtifactRegister): data is WorkflowPreviewUrlRegister {
  return data.type === "preview_url";
}

function isLocalArtifactRegister(data: WorkflowArtifactRegister): data is WorkflowLocalArtifactRegister {
  return "path" in data;
}

function artifactTitle(input: WorkflowLocalArtifactRegister): string {
  return input.title?.trim() || path.basename(input.path.trim()) || "Workflow artifact";
}

function parsePreviewUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw unprocessable("Workflow preview_url must use an HTTP(S) URL");
  }
  return url;
}

function previewUrlProvider(url: URL) {
  return url.hostname === "manual-onboarding.pages.dev" ? "manual_onboarding" : "public_url";
}

function previewUrlTitle(input: WorkflowPreviewUrlRegister, url: URL) {
  return input.title?.trim() || path.basename(url.pathname) || url.hostname;
}

function previewUrlMetadata(input: WorkflowPreviewUrlRegister, runId: string | null) {
  return {
    registeredVia: "workflow_api",
    registeredByRunId: runId,
    deliveryReadback: { required: true, source: "workflow_preview_url" },
    ...(input.expectedTitle ? { expectedTitle: input.expectedTitle } : {}),
    ...(input.contentMarker ? { contentMarker: input.contentMarker } : {}),
    ...(input.marker ? { marker: input.marker } : {}),
    ...(input.topic ? { topic: input.topic } : {}),
  };
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

async function findExistingWorkflowPreviewUrl(input: {
  readonly db: Db;
  readonly issue: WorkflowApiIssue;
  readonly url: string;
}) {
  const row = await input.db
    .select()
    .from(issueWorkProducts)
    .where(and(
      eq(issueWorkProducts.companyId, input.issue.companyId),
      eq(issueWorkProducts.issueId, input.issue.id),
      eq(issueWorkProducts.type, "preview_url"),
      eq(issueWorkProducts.url, input.url),
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
  if (isPreviewUrlRegister(input.data)) {
    const url = parsePreviewUrl(input.data.url);
    const existing = await findExistingWorkflowPreviewUrl({ db: input.db, issue: input.issue, url: url.toString() });
    if (existing) return existing;

    const product = await workProductService(input.db).createForIssue(input.issue.id, input.issue.companyId, {
      projectId: input.issue.projectId ?? null,
      executionWorkspaceId: null,
      runtimeServiceId: null,
      type: "preview_url",
      provider: previewUrlProvider(url),
      externalId: input.data.externalId ?? url.toString(),
      title: previewUrlTitle(input.data, url),
      url: url.toString(),
      status: "active",
      reviewState: "none",
      isPrimary: input.data.isPrimary,
      healthStatus: "unknown",
      summary: input.data.summary ?? null,
      metadata: previewUrlMetadata(input.data, input.actor.runId),
      createdByRunId: input.actor.runId,
    });
    if (!product) {
      throw unprocessable("Workflow preview_url workProduct could not be registered");
    }
    await workflowService.syncRunStatusForIssue(input.db, input.issue.id);
    return product;
  }

  if (!isLocalArtifactRegister(input.data)) {
    throw unprocessable("Workflow artifact registration requires a path or preview_url");
  }

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
    throw unprocessable("Workflow verdict API can only be used on workflow execution issues linked to a workflow step run");
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

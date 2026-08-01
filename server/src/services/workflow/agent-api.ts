import path from "node:path";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns, issues, issueWorkProducts } from "@paperclipai/db";
import { and, count, eq, inArray, ne } from "drizzle-orm";
import type {
  WorkflowArtifactRegister,
  WorkflowIssueComplete,
  WorkflowVerdictSubmit,
} from "@paperclipai/shared/validators/workflow-agent-api";
import { conflict, notFound, unprocessable } from "../../errors.js";
import { issueService } from "../issues.js";
import { toIssueWorkProduct, workProductService } from "../work-products.js";
import { isPathInsideOrEqual, resolveMissionWorkProductPaths } from "../work-products/output-paths.js";
import { workflowService } from "./engine.js";
import { canonicalLocalArtifactTitle, reconcileExistingLocalArtifactTitle } from "./local-artifact-title.js";
import { recordWorkflowValidationVerdict } from "./validation-verdict-ledger.js";
import { reconcileRecoveredWorkflowStep } from "../missions/recovery-closeout.js";
import { logger } from "../../middleware/logger.js";

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

export type WorkflowApiDelegation = {
  readonly kind: "mission_owner_unblock_source";
  readonly issueId: string;
  readonly identifier: string | null;
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

function delegationMetadata(delegation: WorkflowApiDelegation | null | undefined) {
  if (!delegation) return {};
  return {
    delegatedWorkflowApi: delegation.kind,
    delegatedFromIssueId: delegation.issueId,
    delegatedFromIssueIdentifier: delegation.identifier,
  };
}

function previewUrlMetadata(input: WorkflowPreviewUrlRegister, runId: string | null, delegation?: WorkflowApiDelegation | null) {
  return {
    registeredVia: "workflow_api",
    registeredByRunId: runId,
    ...delegationMetadata(delegation),
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

export async function assertWorkflowArtifactPath(input: {
  readonly db: Db;
  readonly issue: WorkflowApiIssue;
  readonly artifactPath: string;
  readonly delegation?: WorkflowApiDelegation | null;
}) {
  if (input.delegation?.kind === "mission_owner_unblock_source") return;
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
  readonly delegation?: WorkflowApiDelegation | null;
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
      metadata: previewUrlMetadata(input.data, input.actor.runId, input.delegation),
      createdByRunId: input.actor.runId,
    });
    if (!product) {
      throw unprocessable("Workflow preview_url workProduct could not be registered");
    }
    await workflowService.syncRunStatusForIssue(input.db, input.issue.id, "workflow_agent_api");
    return product;
  }

  if (!isLocalArtifactRegister(input.data)) {
    throw unprocessable("Workflow artifact registration requires a path or preview_url");
  }

  const artifactPath = input.data.path.trim();
  if (!path.isAbsolute(artifactPath)) {
    throw unprocessable("Workflow artifact path must be an absolute local path");
  }
  await assertWorkflowArtifactPath({ db: input.db, issue: input.issue, artifactPath, delegation: input.delegation });

  const existing = await findExistingWorkflowArtifact({ db: input.db, issue: input.issue, artifactPath });
  if (existing) return reconcileExistingLocalArtifactTitle(input.db, existing, artifactPath);

  const product = await workProductService(input.db).createForIssue(input.issue.id, input.issue.companyId, {
    projectId: input.issue.projectId ?? null,
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: input.data.type,
    provider: "local_file",
    externalId: artifactPath,
    title: canonicalLocalArtifactTitle(artifactPath),
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
      ...delegationMetadata(input.delegation),
    },
    createdByRunId: input.actor.runId,
  });
  if (!product) {
    throw unprocessable("Workflow artifact path must point to an existing local file");
  }
  await workflowService.syncRunStatusForIssue(input.db, input.issue.id, "workflow_agent_api");
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
    // [qa-cap acceptance] 공식 request_changes body 만 nonblockingAcceptance 를 carry 한다(schema refine 보장).
    nonblockingAcceptance: input.data.nonblockingAcceptance ?? null,
  });
  if (!result.isCandidate) {
    throw unprocessable("Workflow verdict API can only be used on workflow execution issues linked to a workflow step run");
  }
  if (!result.satisfied) {
    throw unprocessable("Workflow verdict ledger was not recorded");
  }
  // [P5 recovery closeout] official QA PASS via the structured verdict API → guarded producer failed-step
  //   closeout. reconcileRecoveredWorkflowStep reads the durable workflow_validation_verdict event itself
  //   (no text/stdout parsing) and only mutates when evidence is current-generation; missionId-gated.
  if (result.verdict === "pass" && input.issue.missionId) {
    try {
      const closeout = await reconcileRecoveredWorkflowStep(input.db, {
        companyId: input.issue.companyId,
        missionId: input.issue.missionId,
        qaGateIssueId: input.issue.id,
        source: "workflow_api_qa_pass",
      });
      if ("reconciled" in closeout && closeout.reconciled) {
        await workflowService.syncRunStatusForIssue(input.db, input.issue.id, "workflow_agent_api");
      }
    } catch (err) {
      logger.warn({ err, issueId: input.issue.id }, "recovery closeout failed after workflow verdict");
    }
  }
  await workflowService.syncRunStatusForIssue(input.db, input.issue.id, "workflow_agent_api");
  return result;
}

// [QA rework closeout guard] 이 run이 rework 계약을 가진 run인지(시작 시 contextSnapshot에
//   paperclipWorkflowReworkContract.kind=workflow_qa_rework 가 있었는지) 확인.
export async function isWorkflowReworkRun(db: Db, runId: string): Promise<boolean> {
  const [run] = await db
    .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .limit(1);
  if (!run?.contextSnapshot) return false;
  const ctx = run.contextSnapshot as Record<string, unknown>;
  const contract = typeof ctx.paperclipWorkflowReworkContract === "object" && ctx.paperclipWorkflowReworkContract !== null
    ? (ctx.paperclipWorkflowReworkContract as Record<string, unknown>)
    : null;
  return contract?.kind === "workflow_qa_rework";
}

// [QA rework closeout guard] 이 run이 관측 가능한 진행(artifact 등록 또는 댓글 side-effect)을 남겼는지
//   activity_log.runId exact proof로 확인. honest-guard와 동일 원칙.
export async function runMadeObservableProgress(db: Db, runId: string): Promise<boolean> {
  const [row] = await db
    .select({ n: count() })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.runId, runId),
        inArray(activityLog.action, ["issue.workflow_artifact_registered", "issue.comment_added"]),
      ),
    );
  return Number(row?.n ?? 0) > 0;
}

export async function completeWorkflowIssue(input: {
  readonly db: Db;
  readonly issue: WorkflowApiIssue;
  readonly actor: WorkflowApiActor;
  readonly data: WorkflowIssueComplete;
}) {
  // [QA rework closeout guard] rework run이 관측 가능한 진행 없이 complete 시도하면 차단
  //   (producer가 rework 무시하고 complete 하는 GAZ-265 사고 방지). 진행 증거 = 이 run의 artifact 등록/댓글.
  const reworkRunId = input.actor.runId;
  if (reworkRunId) {
    if (await isWorkflowReworkRun(input.db, reworkRunId) && !(await runMadeObservableProgress(input.db, reworkRunId))) {
      throw conflict(
        "QA rework run made no observable progress; resolve the REQUEST_CHANGES and update or register the artifact before completing the workflow issue.",
      );
    }
  }
  const svc = issueService(input.db);
  const comment = input.data.comment?.trim();
  if (comment) {
    await svc.addComment(input.issue.id, comment, {
      agentId: input.actor.agentId ?? undefined,
      userId: input.actor.actorType === "user" ? input.actor.actorId : undefined,
    });
  }
  const updated = await svc.update(input.issue.id, {
    status: "done",
    workflowSyncSource: "workflow_agent_api",
  });
  if (!updated) throw notFound("Issue not found");
  await workflowService.syncRunStatusForIssue(input.db, input.issue.id, "workflow_agent_api");
  return updated;
}

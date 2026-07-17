import path from "node:path";
import type { Db } from "@paperclipai/db";
import { workflowStepRuns } from "@paperclipai/db";
import type { WorkflowArtifactRegister } from "@paperclipai/shared/validators/workflow-agent-api";
import { desc, eq } from "drizzle-orm";
import { unprocessable } from "../../errors.js";
import { createCompanyWorkProductStorageService } from "../company-work-product-storage.js";
import { secretService } from "../secrets.js";
import { workProductService } from "../work-products.js";
import {
  assertWorkflowArtifactPath,
  registerWorkflowArtifact,
  type WorkflowApiActor,
  type WorkflowApiDelegation,
  type WorkflowApiIssue,
} from "./agent-api.js";
import {
  mirrorRegisteredWorkflowArtifactToCompanyStorage,
  type WorkflowArtifactMirrorDeps,
} from "./artifact-mirror.js";

export async function registerWorkflowArtifactWithStorage(input: {
  readonly db: Db;
  readonly issue: WorkflowApiIssue;
  readonly actor: WorkflowApiActor;
  readonly data: WorkflowArtifactRegister;
  readonly delegation?: WorkflowApiDelegation | null;
  readonly artifactMirrorDeps?: WorkflowArtifactMirrorDeps;
}) {
  if (!("path" in input.data)) return registerWorkflowArtifact(input);

  const artifactPath = input.data.path.trim();
  if (!path.isAbsolute(artifactPath)) {
    throw unprocessable("Workflow artifact path must be an absolute local path");
  }

  const storage = await createCompanyWorkProductStorageService(input.db).get(input.issue.companyId);
  if (storage.provider === "local_disk") return registerWorkflowArtifact(input);

  await assertWorkflowArtifactPath({
    db: input.db,
    issue: input.issue,
    artifactPath,
    delegation: input.delegation,
  });
  const stepRun = await input.db
    .select({ workflowRunId: workflowStepRuns.workflowRunId, stepId: workflowStepRuns.stepId })
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.issueId, input.issue.id))
    .orderBy(desc(workflowStepRuns.startedAt), desc(workflowStepRuns.completedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const storageMirror = await mirrorRegisteredWorkflowArtifactToCompanyStorage(
    storage,
    {
      companyId: input.issue.companyId,
      workflowRunId: stepRun?.workflowRunId ?? null,
      stepId: stepRun?.stepId ?? null,
      artifactPath,
    },
    input.artifactMirrorDeps ?? { resolveSecretValue: secretService(input.db).resolveSecretValue },
  );

  const product = await registerWorkflowArtifact(input);
  if (!storageMirror) return product;
  return await workProductService(input.db).update(product.id, {
    metadata: { ...(product.metadata ?? {}), storageMirror },
  }) ?? product;
}

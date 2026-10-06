import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, issueWorkProducts, workflowRuns, workflowStepRuns, workflowStepOutputBindings, type Db } from "@paperclipai/db";
import { toolArtifactReceiptSchema, workProductProducerSchema, type ToolArtifactReceipt,
  workProductProducerRebindMarkerSchema } from "@paperclipai/shared/validators/workflow-artifact";
import type { WorkflowQaRebindExpectedDigests } from "@paperclipai/shared/validators/workflow-qa-rebind";
import { hashStructuredValue } from "../issue-execution-cards/hash.js";
import { resolveWorkProductLocalFilePath } from "../work-products.js";
import { producerAttempt } from "../work-products/producer-attempt.js";
import { workProductProducerMismatches } from "./workproduct-producer-comparison.js";
import { loadExecutionDefinition, type DbOrTx, type LoadedExecutionDefinition } from "./execution-definition.js";
import { resolveMissionWorkProductPaths } from "../work-products/output-paths.js";
import { selectArtifactValues } from "@paperclipai/shared/validators/artifact-contract";
import { readCompletedSourceArtifactAttempt } from "./artifact-contract-runtime.js";
import { captureArtifactRoot, digest, readArtifactBytes } from "./artifact-files.js";
import { readObject } from "./core-tool-context.js";
import { adaptPublication, expectedPublicationId } from "./publication-result.js";

export type QaRebindCandidateScope = { companyId: string; workflowRunId: string; consumerStepRunId: string };
export async function readQaRebindContext(db: DbOrTx, scope: QaRebindCandidateScope) {
  const rows = await db.select({ run: workflowRuns, step: workflowStepRuns }).from(workflowRuns)
    .innerJoin(workflowStepRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id)).where(and(
      eq(workflowRuns.companyId, scope.companyId), eq(workflowRuns.id, scope.workflowRunId)));
  const consumer = rows.find(r => r.step.id === scope.consumerStepRunId);
  if (!consumer) return null;
  const { run, step } = consumer;
  let execution: LoadedExecutionDefinition | undefined;
  try { execution = await loadExecutionDefinition(db, run.id, { requireHistorical: true }); } catch { /* fail closed below */ }
  const definition = execution?.steps.find(s => s.id === step.stepId);
  const declared = readObject(readObject(definition).toolArtifactContract);
  let frozen;
  try { frozen = readCompletedSourceArtifactAttempt(step.metadata.artifactExecution, step); } catch { /* absent freeze is not authority */ }
  const role = frozen?.contract.role ?? declared.role;
  const args = readObject(readObject(step.metadata.toolInvocation).args);
  const receiptParam = frozen?.contract.consumerParams?.receipt;
  const requestedPath = receiptParam ? args[receiptParam] : undefined;
  const ancestors = new Set<string>();
  const visit = (id: string) => {
    if (ancestors.has(id)) return;
    ancestors.add(id);
    for (const dep of execution?.steps.find(s => s.id === id)?.dependencies ?? []) visit(dep);
  };
  for (const dep of definition?.dependencies ?? []) visit(dep);
  const sources = rows.filter(({ step: s }) => {
    const parsed = toolArtifactReceiptSchema.safeParse(s.metadata.toolArtifactReceipt);
    return parsed.success && parsed.data.role === "qa" && (typeof requestedPath === "string"
      ? path.join(parsed.data.outputRoot, parsed.data.relativePath) === requestedPath : ancestors.has(s.stepId));
  });
  const qa = sources.length === 1 ? sources[0].step : null;
  const parsed = toolArtifactReceiptSchema.safeParse(qa?.metadata.toolArtifactReceipt);
  const receipt = parsed.success ? parsed.data : null;
  const expectedDigests = receipt ? receiptDigests(receipt) : null;
  const bundleDigest = hashStructuredValue(expectedDigests ?? { schemaVersion: "workflow.qa-rebind-evidence-gap.v1",
    consumerStepRunId: step.id, requestId: step.lastDispatchRequestId });
  return { run, step, rows, definition, execution, frozen, role, args, qa, receipt, expectedDigests, bundleDigest };
}
export type QaRebindContext = NonNullable<Awaited<ReturnType<typeof readQaRebindContext>>>;

function receiptDigests(r: ToolArtifactReceipt): WorkflowQaRebindExpectedDigests {
  const sorted = (items: ToolArtifactReceipt["input"]["assetManifest"]) => [...items].sort((a, b) => a.fileName.localeCompare(b.fileName));
  return { workProductId: r.input.workProductId, sha256: r.input.sha256, byteSize: r.input.byteSize,
    assetManifest: sorted(r.input.assetManifest), htmlManifest: r.input.htmlManifest ?? null,
    ancillaryManifest: sorted(r.input.ancillaryManifest ?? []), qaReceiptSha256: r.sha256,
    contractHash: r.schemaVersion === "workflow.tool-artifact.v2" ? r.contractHash : null,
    qaConfigHash: r.schemaVersion === "workflow.tool-artifact.v2" ? r.qaConfigHash : null };
}

/** Publication-verify and any unproven publication target are blocked BEFORE QA eligibility. */
export async function publicationFence(db: Db, c: QaRebindContext): Promise<"publication_unproven" | "published_same_qa" | null> {
  if (c.role === "publication-verify") return "publication_unproven";
  if (c.role !== "publication") return null;
  const config = c.frozen?.contract.publication;
  if (!config?.identity || !config.audience || !config.command || !config.commandKeySeparator) return "publication_unproven";
  let target;
  try {
    const paths = c.run.missionId ? await resolveMissionWorkProductPaths(db, { companyId: c.run.companyId,
      missionId: c.run.missionId, workflowRunId: c.run.id }) : null;
    target = await expectedPublicationId(c.args, paths?.runOutputDir, config.identity);
  } catch { return "publication_unproven"; }
  if (!target) return "publication_unproven";
  const stored = readObject(c.step.metadata.toolResult);
  if (stored.success === true || stored.data !== undefined && readObject(stored.data).schemaVersion !== undefined) {
    try {
      const { artifactPath, ...data } = readObject(stored.data);
      if (typeof artifactPath !== "string" || !path.isAbsolute(artifactPath)
        || path.basename(artifactPath) !== c.frozen!.contract.resultFileName) return "publication_unproven";
      const root = await captureArtifactRoot(path.dirname(artifactPath));
      const raw: unknown = JSON.parse((await readArtifactBytes(root, path.basename(artifactPath), 1024 * 1024)).toString("utf8"));
      if (!isDeepStrictEqual(raw, data)) return "publication_unproven";
      const result = adaptPublication(data, c.frozen!.contract);
      const audience = c.args[config.audience.parameter] === config.audience.privateValue
        ? config.audience.privateResult : config.audience.defaultResult;
      const bindingsOk = (config.bindings ?? []).every(b => b.optional && c.args[b.parameter] === undefined
        || isDeepStrictEqual(selectArtifactValues(data, [b.resultPointer]), [c.args[b.parameter]]));
      if (result.cms.contentId !== target || result.cms.audience !== audience || result.publicUrl !== result.cms.publicUrl
        || result.command !== config.command || !bindingsOk
        || result.scope.executionGeneration !== c.frozen!.executionGeneration
        || result.scope.retryCount !== c.step.retryCount || result.scope.iterationIndex !== c.step.iterationIndex
        || result.scope.companyId !== c.run.companyId || result.scope.workflowRunId !== c.run.id
        || result.scope.missionId !== c.run.missionId || result.scope.stepRunId !== c.step.id
        || result.scope.stepId !== c.step.stepId || result.scope.requestId !== c.step.lastDispatchRequestId
        || result.id !== target || result.inputDigest.qaSha256 !== c.receipt?.sha256
        || result.inputDigest.sha256 !== c.receipt?.input.sha256) return "publication_unproven";
      // Never automatically repeat a publication already bound to this QA result.
      return "published_same_qa";
    } catch { return "publication_unproven"; }
  }
  return null;
}

/** Reprove the original producer attempt, tolerating ONLY a forward generation change. */
export async function producerFence(db: Db, c: QaRebindContext): Promise<"producer_unproven" | "producer_bytes_mismatch" | null> {
  const r = c.receipt!;
  const bindings = await db.select({ binding: workflowStepOutputBindings }).from(workflowStepOutputBindings)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepOutputBindings.workflowRunId)).where(and(
      eq(workflowRuns.companyId, c.run.companyId), eq(workflowRuns.id, c.run.id),
      eq(workflowStepOutputBindings.companyId, c.run.companyId),
      eq(workflowStepOutputBindings.consumerStepRunId, c.qa!.id), eq(workflowStepOutputBindings.workProductId, r.input.workProductId)));
  if (bindings.length !== 1) return "producer_unproven";
  const s = c.rows.find(({ step }) => step.stepId === bindings[0].binding.referencedStepId)?.step;
  const [product] = await db.select().from(issueWorkProducts).where(and(
    eq(issueWorkProducts.companyId, c.run.companyId), eq(issueWorkProducts.id, r.input.workProductId)));
  const p = workProductProducerSchema.safeParse(product?.metadata?.workflowProducer);
  if (!s || s.status !== "completed" || !s.issueId || !product || product.issueId !== s.issueId || !p.success
    || !isDeepStrictEqual(p.data, r.input.producer) || p.data.executionGeneration > s.executionGeneration
    || product.sourceExecutionGeneration !== p.data.executionGeneration
    || workProductProducerMismatches(p.data, { companyId: c.run.companyId, workflowRunId: c.run.id, run: c.run, step: s, product })
      .some(field => field !== "executionGeneration" && field !== "sourceExecutionGeneration")) return "producer_unproven";
  const file = resolveWorkProductLocalFilePath(product);
  if (file !== r.input.path || !["local", "local_file"].includes(product.provider)) return "producer_unproven";
  const [heartbeat] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, c.run.companyId), eq(heartbeatRuns.id, p.data.heartbeatRunId)));
  if (!heartbeat || heartbeat.issueId !== s.issueId || heartbeat.workflowStepRunId !== s.id
    || heartbeat.workflowExecutionGeneration !== p.data.executionGeneration) return "producer_unproven";
  try {
    const attempt = await producerAttempt(db, heartbeat, { ...s, executionGeneration: p.data.executionGeneration });
    if (attempt.retryCount !== p.data.retryCount || attempt.iterationIndex !== p.data.iterationIndex) return "producer_unproven";
  } catch { return "producer_unproven"; }
  // The real selector checks the original ONLY when a rebind marker exists.
  if (product.metadata?.workflowProducerRebind !== undefined) {
    const marker = workProductProducerRebindMarkerSchema.safeParse(product.metadata.workflowProducerRebind);
    if (!marker.success || marker.data.fromGeneration !== p.data.executionGeneration
      || marker.data.fromHeartbeatRunId !== p.data.heartbeatRunId) return "producer_unproven";
    try {
      const root = await captureArtifactRoot(path.dirname(file));
      const bytes = await readArtifactBytes(root, path.basename(file), 8 * 1024 * 1024);
      if (digest(bytes) !== marker.data.sha256 || bytes.length !== marker.data.byteSize) return "producer_bytes_mismatch";
    } catch { return "producer_bytes_mismatch"; }
  }
  return null;
}

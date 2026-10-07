import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, eq, ne } from "drizzle-orm";
import { heartbeatRuns, issueWorkProducts, type Db } from "@paperclipai/db";
import { workProductProducerRebindMarkerSchema, workProductProducerSchema,
  type WorkProductSelectors } from "@paperclipai/shared/validators/workflow-artifact";
import { badRequest, conflict } from "../../errors.js";
import { resolveWorkProductLocalFilePath } from "../work-products.js";
import { producerAttempt } from "../work-products/producer-attempt.js";
import { appendWorkflowAuthorityTransition } from "./authority/transitions.js";
import { workProductProducerMismatches } from "./workproduct-producer-comparison.js";
import { lockProducerRebindScope } from "./producer-rebind-locks.js";

export type ProducerProvenanceRebindResult =
  | { status: "rebound"; productId: string; producerStepRunId: string; fromGeneration: number; reboundAtGeneration: number; sha256: string; byteSize: number }
  | { status: "already_rebound"; productId: string; fromGeneration: number };
export type ProducerRebindInput = {
  companyId: string; workflowRunId: string; producerStepId: string; productId: string;
  actor: { actorType: string; actorId: string }; now?: Date; expected?: { sha256: string; byteSize: number };
};
export type AutomaticRebindSelection = { selector: WorkProductSelectors[string]; pinnedId?: string };

/** Shared board/system proof. System issuance runs ONLY after the consuming transaction releases its locks. */
export async function issueProducerRebind(db: Db, input: ProducerRebindInput,
  automatic?: AutomaticRebindSelection): Promise<ProducerProvenanceRebindResult> {
  const now = input.now ?? new Date();
  return db.transaction(async tx => {
    const { run, rows } = await lockProducerRebindScope(tx as unknown as Db, input.companyId, input.workflowRunId, !automatic);
    const step = rows.find(row => row.stepId === input.producerStepId);
    if (!step) throw badRequest("producer rebind producer step run not found");
    if (step.status !== "completed" || step.issueId == null) throw conflict("producer_rebind_producer_not_completed");
    if (automatic) {
      // Recheck selector cardinality under parent UPDATE locks: registrations hold SHARE on these parents.
      const products = await tx.select().from(issueWorkProducts).where(and(
        eq(issueWorkProducts.companyId, input.companyId), eq(issueWorkProducts.issueId, step.issueId),
        eq(issueWorkProducts.type, automatic.selector.type), eq(issueWorkProducts.title, automatic.selector.title),
        automatic.pinnedId ? eq(issueWorkProducts.id, automatic.pinnedId) : ne(issueWorkProducts.status, "archived"),
      )).orderBy(issueWorkProducts.id).for("update");
      if (products.length !== 1 || products[0].id !== input.productId) throw conflict("producer_rebind_selection_changed");
    }
    const [product] = await tx.select().from(issueWorkProducts)
      .where(and(eq(issueWorkProducts.id, input.productId), eq(issueWorkProducts.companyId, input.companyId))).for("update");
    if (!product || product.companyId !== input.companyId || product.issueId !== step.issueId) {
      throw badRequest("producer rebind work product not on producer issue");
    }
    if (product.status === "archived" || (automatic && product.status !== "active")) throw conflict("producer_rebind_product_archived");
    const parsed = workProductProducerSchema.safeParse(product.metadata?.workflowProducer);
    if (!parsed.success) throw conflict("producer_rebind_provenance_missing");
    const p = parsed.data;
    const existingMarker = workProductProducerRebindMarkerSchema.safeParse(product.metadata?.workflowProducerRebind);
    if (existingMarker.success && existingMarker.data.fromGeneration === p.executionGeneration
      && existingMarker.data.fromHeartbeatRunId === p.heartbeatRunId) {
      if (input.expected && (existingMarker.data.sha256 !== input.expected.sha256
        || existingMarker.data.byteSize !== input.expected.byteSize)) throw conflict("producer_rebind_bytes_changed");
      return { status: "already_rebound", productId: product.id, fromGeneration: p.executionGeneration };
    }
    const mismatches = workProductProducerMismatches(p, { companyId: input.companyId, workflowRunId: run.id, run, step, product });
    const generationOnly = mismatches.length > 0
      && mismatches.every(field => field === "executionGeneration" || field === "sourceExecutionGeneration");
    if (!generationOnly) throw conflict("producer_rebind_not_generation_only");
    if (p.executionGeneration >= step.executionGeneration) throw conflict("producer_rebind_not_stale");
    const [heartbeat] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, p.heartbeatRunId), eq(heartbeatRuns.companyId, input.companyId)));
    if (!heartbeat || heartbeat.companyId !== p.companyId || heartbeat.issueId !== step.issueId
      || heartbeat.workflowStepRunId !== step.id) throw conflict("producer_rebind_heartbeat_unlinked");
    if (heartbeat.workflowExecutionGeneration !== p.executionGeneration) throw conflict("producer_rebind_heartbeat_generation_mismatch");
    let attempt: { retryCount: number; iterationIndex: number };
    try { attempt = await producerAttempt(tx, heartbeat, { ...step, executionGeneration: p.executionGeneration }); }
    catch { throw conflict("producer_rebind_attempt_unproven"); }
    if (attempt.retryCount !== p.retryCount || attempt.iterationIndex !== p.iterationIndex) throw conflict("producer_rebind_attempt_mismatch");
    const file = resolveWorkProductLocalFilePath(product);
    if (!file || !["local", "local_file"].includes(product.provider)) throw conflict("producer_rebind_product_not_local");
    let bytes: Buffer;
    try { bytes = await readFile(file); } catch { throw conflict("producer_rebind_file_unreadable"); }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (input.expected && (sha256 !== input.expected.sha256 || bytes.byteLength !== input.expected.byteSize)) throw conflict("producer_rebind_bytes_changed");
    if (automatic && p.sha256 !== undefined && (sha256 !== p.sha256 || bytes.byteLength !== p.byteSize)) {
      throw conflict("producer_rebind_bytes_changed");
    }
    const marker = {
      schemaVersion: "workflow.work-product-producer-rebind.v1" as const,
      fromGeneration: p.executionGeneration, reboundAtGeneration: step.executionGeneration, fromHeartbeatRunId: p.heartbeatRunId,
      sha256, byteSize: bytes.byteLength, reboundAt: now.toISOString(), reboundBy: input.actor,
      reason: automatic ? "automatic_producer_provenance_rebind" : "board_producer_provenance_rebind",
      authorityIdempotencyKey: `producer-provenance-rebind:${product.id}:${p.executionGeneration}`,
    };
    await tx.update(issueWorkProducts).set({ metadata: { ...(product.metadata ?? {}), workflowProducerRebind: marker }, updatedAt: now })
      .where(and(eq(issueWorkProducts.id, product.id), eq(issueWorkProducts.companyId, input.companyId)));
    await appendWorkflowAuthorityTransition(tx, {
      companyId: input.companyId, workflowRunId: run.id, workflowStepRunId: step.id, issueId: step.issueId,
      heartbeatRunId: p.heartbeatRunId, executionGeneration: step.executionGeneration,
      reason: marker.reason, idempotencyKey: marker.authorityIdempotencyKey,
      payload: { version: 1, transition: "producer_provenance_rebound", productId: product.id,
        producerStepRunId: step.id, fromGeneration: marker.fromGeneration, reboundAtGeneration: marker.reboundAtGeneration,
        sha256, byteSize: marker.byteSize, reboundBy: marker.reboundBy },
    });
    return { status: "rebound", productId: product.id, producerStepRunId: step.id,
      fromGeneration: marker.fromGeneration, reboundAtGeneration: marker.reboundAtGeneration, sha256, byteSize: marker.byteSize };
  });
}

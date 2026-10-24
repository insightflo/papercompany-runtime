import { activityLog, issueWorkProducts, type Db } from "@paperclipai/db";
import { workProductProducerSchema } from "@paperclipai/shared/validators/workflow-artifact";
import type { registeredProducer } from "./producer-provenance.js";
import type { ProductionSeal } from "./producer-seal.js";

type Product = typeof issueWorkProducts.$inferSelect;
type Producer = Awaited<ReturnType<typeof registeredProducer>>;

/** Only the locked, persisted producer seal can supply the previous byte hash. */
function previousHash(product?: Product): string | null {
  if (!product) return null;
  const parsed = workProductProducerSchema.safeParse(product.metadata?.workflowProducer);
  if (!parsed.success || parsed.data.companyId !== product.companyId
    || parsed.data.heartbeatRunId !== product.createdByRunId) return null;
  return parsed.data.sha256 ?? null;
}

/** Called by the official writer in its transaction, after admission and the product write.
 * The seal is the existing descriptor measurement, never a caller-supplied metadata hash.
 * Freeze the admitted attempt here so later generations cannot rewrite historical attribution.
 */
export async function recordWorkProductProgress(tx: Pick<Db, "insert">, product: Product,
  producer: Producer, seal: ProductionSeal | null, previous?: Product): Promise<void> {
  if (!seal || producer?.schemaVersion !== "workflow.work-product-producer.v1"
    || producer.companyId !== product.companyId || producer.heartbeatRunId !== product.createdByRunId) return;
  const previousSha256 = previousHash(previous);
  const created = previous === undefined;
  const contentChanged = created || (previousSha256 !== null && previousSha256 !== seal.sha256);
  await tx.insert(activityLog).values({
    companyId: product.companyId, actorType: "system", actorId: "work-product-progress",
    action: "issue.work_product_progress_accepted", entityType: "issue_work_product", entityId: product.id,
    runId: producer.heartbeatRunId,
    details: { progressEvidence: {
      schemaVersion: 1, companyId: product.companyId, issueId: product.issueId,
      runId: producer.heartbeatRunId, workProductId: product.id,
      workflowAttempt: { ...producer },
      previousSha256, newSha256: seal.sha256, byteSize: seal.byteSize, created, contentChanged,
    } },
  });
}

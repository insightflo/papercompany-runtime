import { and, eq } from "drizzle-orm";
import { issueWorkProducts, workflowStepOutputBindings, type Db } from "@paperclipai/db";
import { findWorkflowSeed } from "./workflow-seed-evidence.js";
import { lockProducerSelection } from "../work-products/producer-selection-lock.js";
import { selectOfficialWorkProduct } from "./workproduct-selector.js";
import { workProductSelectorsSchema } from "@paperclipai/shared/validators/workflow-artifact";

export interface OutputBindingPinInput {
  companyId: string;
  workflowRunId: string;
  consumerStepRunId: string;
  referencedStepId: string;
  workProductId: string;
  sourceExecutionGeneration?: number;
}

export async function pinWorkProductForStep(
  db: Db,
  input: OutputBindingPinInput,
): Promise<{ kind: "pinned" } | { kind: "already_pinned"; workProductId: string }> {
  const scope = { companyId: input.companyId, workflowRunId: input.workflowRunId, stepId: input.referencedStepId };
  if (!await findWorkflowSeed(db, scope)) return insertPin(db, input);
  return db.transaction(async tx => {
    const locked = await lockProducerSelection(tx, { ...scope, stepIds: [input.referencedStepId],
      stepRunIds: [input.consumerStepRunId] }, "update");
    if (!locked.run || !locked.steps.some(s => s.id === input.consumerStepRunId)) throw new Error("seed_binding_scope_mismatch");
    const [product] = await tx.select().from(issueWorkProducts).where(and(
      eq(issueWorkProducts.id, input.workProductId), eq(issueWorkProducts.companyId, input.companyId)));
    if (!product) throw new Error("seed_binding_product_missing");
    const selector = workProductSelectorsSchema.parse({ [scope.stepId]: { type: product.type, title: product.title } })[scope.stepId];
    await selectOfficialWorkProduct(tx as unknown as Db, { ...scope, pinnedId: product.id, selector });
    return insertPin(tx as unknown as Db, input);
  });
}

async function insertPin(db: Db, input: OutputBindingPinInput): Promise<{ kind: "pinned" } | { kind: "already_pinned"; workProductId: string }> {
  // 선-insert 후-조회로 충돌을 한 문장에서 처리한다. 충돌 시 기존 핀을 다시 읽고,
  // 새 산출물로 덮어쓰지 않는다. 이 불변식이 소비 시점 재해석을 차단한다.
  const inserted = await db
    .insert(workflowStepOutputBindings)
    .values({
      companyId: input.companyId,
      workflowRunId: input.workflowRunId,
      consumerStepRunId: input.consumerStepRunId,
      referencedStepId: input.referencedStepId,
      workProductId: input.workProductId,
      sourceExecutionGeneration: input.sourceExecutionGeneration,
    })
    .onConflictDoNothing()
    .returning({ id: workflowStepOutputBindings.id });
  if (inserted.length > 0) return { kind: "pinned" };

  const existing = await db
    .select({ workProductId: workflowStepOutputBindings.workProductId })
    .from(workflowStepOutputBindings)
    .where(
      and(
        eq(workflowStepOutputBindings.companyId, input.companyId),
        eq(workflowStepOutputBindings.workflowRunId, input.workflowRunId),
        eq(workflowStepOutputBindings.consumerStepRunId, input.consumerStepRunId),
        eq(workflowStepOutputBindings.referencedStepId, input.referencedStepId),
      ),
    )
    .limit(1);
  const existingWorkProductId = existing[0]?.workProductId;
  if (!existingWorkProductId) {
    throw new Error("output binding conflict resolved without an existing pin");
  }
  return { kind: "already_pinned", workProductId: existingWorkProductId };
}

export async function getPinnedWorkProduct(
  db: Db,
  input: {
    companyId: string;
    workflowRunId: string;
    consumerStepRunId: string;
    referencedStepId: string;
  },
) {
  const [row] = await db
    .select({
      workProductId: issueWorkProducts.id,
      provider: issueWorkProducts.provider,
      externalId: issueWorkProducts.externalId,
      url: issueWorkProducts.url,
      metadata: issueWorkProducts.metadata,
    })
    .from(workflowStepOutputBindings)
    .innerJoin(issueWorkProducts, eq(workflowStepOutputBindings.workProductId, issueWorkProducts.id))
    .where(
      and(
        eq(workflowStepOutputBindings.companyId, input.companyId),
        eq(workflowStepOutputBindings.workflowRunId, input.workflowRunId),
        eq(workflowStepOutputBindings.consumerStepRunId, input.consumerStepRunId),
        eq(workflowStepOutputBindings.referencedStepId, input.referencedStepId),
      ),
    )
    .limit(1);
  return row ?? null;
}

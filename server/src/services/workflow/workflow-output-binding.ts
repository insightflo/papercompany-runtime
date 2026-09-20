import { and, eq } from "drizzle-orm";
import { issueWorkProducts, workflowStepOutputBindings, type Db } from "@paperclipai/db";

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

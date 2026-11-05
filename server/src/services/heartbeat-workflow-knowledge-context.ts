import type { Db } from "@paperclipai/db";
import { knowledgeService } from "./knowledge/base.js";

export type WorkflowStepKnowledgeContext = {
  workflowRunId: string;
  workflowId: string;
  stepId: string;
  stepName: string;
  knowledgeBaseIds: string[];
  entries: Array<{
    id: string;
    name: string;
    type: string;
    source: string;
    tokenCount: number;
    content: string;
    error?: string;
  }>;
};

export function buildWorkflowKnowledgeQuery(input: {
  issueTitle: string | null;
  issueDescription: string | null;
  note: string | null;
  taskKey: string | null;
  stepName: string;
}) {
  return [
    input.stepName ? `Workflow step: ${input.stepName}` : null,
    input.issueTitle ? `Issue title: ${input.issueTitle}` : null,
    input.issueDescription ? `Issue description: ${input.issueDescription}` : null,
    input.note ? `Operator note: ${input.note}` : null,
    input.taskKey ? `Task key: ${input.taskKey}` : null,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
}

export async function resolveWorkflowStepKnowledgeContext(input: {
  db: Db;
  companyId: string;
  agentId: string;
  issueId: string | null;
  taskKey: string | null;
  issueTitle: string | null;
  issueDescription: string | null;
  note: string | null;
}): Promise<WorkflowStepKnowledgeContext | null> {
  if (!input.issueId) return null;

  const { workflowService } = await import("./workflow/engine.js");
  const contract = await workflowService.getStepExecutionContractForIssue(input.db, input.issueId);
  if (!contract || contract.knowledgeBaseIds.length === 0) return null;

  const accessibleKnowledgeBases = await knowledgeService.listAccessible(
    input.db,
    input.agentId,
    input.companyId,
  );
  const knowledgeBaseById = new Map(accessibleKnowledgeBases.map((knowledgeBase) => [knowledgeBase.id, knowledgeBase]));
  const missingKnowledgeBaseIds = contract.knowledgeBaseIds.filter((knowledgeBaseId) => !knowledgeBaseById.has(knowledgeBaseId));

  if (missingKnowledgeBaseIds.length > 0) {
    throw Object.assign(
      new Error(
        `Workflow step "${contract.stepName}" has an invalid knowledge contract (missing or inaccessible KBs: ${missingKnowledgeBaseIds.join(", ")})`,
      ),
      {
        code: "workflow_step_kb_contract_invalid",
      },
    );
  }

  const query = buildWorkflowKnowledgeQuery({
    issueTitle: input.issueTitle,
    issueDescription: input.issueDescription,
    note: input.note,
    taskKey: input.taskKey,
    stepName: contract.stepName,
  });

  const entries = await Promise.all(
    contract.knowledgeBaseIds.map(async (knowledgeBaseId) => {
      const knowledgeBase = knowledgeBaseById.get(knowledgeBaseId)!;
      const retrieval = await knowledgeService.retrieve(input.db, {
        kbId: knowledgeBaseId,
        agentId: input.agentId,
        query,
        maxTokens: knowledgeBase.maxTokenBudget,
      });

      return {
        id: knowledgeBase.id,
        name: knowledgeBase.name,
        type: knowledgeBase.type,
        source: retrieval.source,
        tokenCount: retrieval.tokenCount,
        content: retrieval.content,
        ...(retrieval.error ? { error: retrieval.error } : {}),
      };
    }),
  );

  return {
    workflowRunId: contract.workflowRunId,
    workflowId: contract.workflowId,
    stepId: contract.stepId,
    stepName: contract.stepName,
    knowledgeBaseIds: contract.knowledgeBaseIds,
    entries,
  };
}

import { worktreeRules, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { knowledgeService } from "./knowledge/base.js";
import { buildWorkflowKnowledgeQuery, type WorkflowStepKnowledgeContext } from "./heartbeat-workflow-knowledge-context.js";

type MaintenanceGuidanceContext = {
  version: 1;
  rules: Array<{
    id: string;
    name: string;
    severity: string;
    action: string;
    message: string;
    excerpt: string;
  }>;
  knowledge: Array<{
    id: string;
    name: string;
    type: string;
    source: string;
    tokenCount: number;
    content: string;
    error?: string;
  }>;
};

export async function resolveMaintenanceGuidanceContext(input: {
  db: Db;
  companyId: string;
  agentId: string;
  workflowStepKnowledgeContext: WorkflowStepKnowledgeContext | null;
  issueTitle: string | null;
  issueDescription: string | null;
  note: string | null;
  taskKey: string | null;
}): Promise<MaintenanceGuidanceContext | null> {
  const rows = await input.db
    .select()
    .from(worktreeRules)
    .where(and(eq(worktreeRules.companyId, input.companyId), eq(worktreeRules.enabled, true)));

  const severityRank: Record<string, number> = { MUST: 0, SHOULD: 1, MAY: 2 };
  const rules = rows
    .slice()
    .sort((a, b) => (severityRank[a.severity] ?? 99) - (severityRank[b.severity] ?? 99) || a.name.localeCompare(b.name))
    .slice(0, 10)
    .map((row) => ({
      id: row.id,
      name: row.name,
      severity: row.severity,
      action: row.action,
      message: row.message,
      excerpt: row.message || `${row.severity} ${row.action}`,
    }));

  const workflowStepKnowledge = input.workflowStepKnowledgeContext?.entries ?? [];
  const workflowStepKnowledgeIds = new Set(workflowStepKnowledge.map((entry) => entry.id));
  const accessibleKnowledgeBases = await knowledgeService.listAccessible(input.db, input.agentId, input.companyId);
  const query = buildWorkflowKnowledgeQuery({
    issueTitle: input.issueTitle,
    issueDescription: input.issueDescription,
    note: input.note,
    taskKey: input.taskKey,
    stepName: "Maintenance guidance",
  });
  const fallbackKnowledge = await Promise.all(
    accessibleKnowledgeBases
      .filter((knowledgeBase) => !workflowStepKnowledgeIds.has(knowledgeBase.id))
      .slice(0, 3)
      .map(async (knowledgeBase) => {
        const retrieval = await knowledgeService.retrieve(input.db, {
          kbId: knowledgeBase.id,
          agentId: input.agentId,
          query,
          maxTokens: Math.min(knowledgeBase.maxTokenBudget, 500),
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
  const knowledge = [...workflowStepKnowledge, ...fallbackKnowledge];
  if (rules.length === 0 && knowledge.length === 0) return null;

  return {
    version: 1,
    rules,
    knowledge,
  };
}

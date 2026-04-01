/**
 * Knowledge Base Service Types
 *
 * Defines interfaces for knowledge base management and retrieval.
 */

/**
 * Knowledge base types.
 */
export type KnowledgeBaseType = "static" | "rag" | "ontology";

/**
 * Knowledge base configuration based on type.
 */
export type KnowledgeBaseConfig =
  | { type: "static"; content: string }
  | { type: "rag"; mcpServerId: string; collectionName?: string }
  | { type: "ontology"; graphId: string };

/**
 * A knowledge base stores information for agent retrieval.
 */
export interface KnowledgeBase {
  id: string;
  companyId: string;
  name: string;
  type: KnowledgeBaseType;
  description: string;
  maxTokenBudget: number;
  config: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Input to create a new knowledge base.
 */
export interface CreateKnowledgeBaseInput {
  companyId: string;
  name: string;
  type: KnowledgeBaseType;
  description?: string;
  maxTokenBudget?: number;
  config: Record<string, unknown>;
}

/**
 * Agent knowledge base grant.
 */
export interface AgentKbGrant {
  id: string;
  agentId: string;
  kbId: string;
  grantedBy: string;
  createdAt: Date;
}

/**
 * Input to grant knowledge base access to an agent.
 */
export interface GrantAgentKbInput {
  agentId: string;
  kbId: string;
  grantedBy: string;
}

/**
 * Knowledge retrieval request.
 */
export interface KbRetrievalRequest {
  kbId: string;
  query: string;
  agentId: string;
  maxTokens?: number;
}

/**
 * Knowledge retrieval result.
 */
export interface KbRetrievalResult {
  content: string;
  tokenCount: number;
  source: string;
  error?: string;
}

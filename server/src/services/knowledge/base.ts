/**
 * Knowledge Base Service
 *
 * Main service interface for knowledge base operations.
 * Provides CRUD for knowledge bases and retrieval interfaces.
 */

import type { Db } from "../../packages/db/src/client.js";
import { kbStore } from "./kb-store.js";
import type {
  KnowledgeBase,
  CreateKnowledgeBaseInput,
  AgentKbGrant,
  GrantAgentKbInput,
  KbRetrievalRequest,
  KbRetrievalResult,
} from "./types.js";

/**
 * Estimate token count for text content (rough estimate: ~4 chars per token).
 */
function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Knowledge base service.
 */
export const knowledgeService = {
  /**
   * Create a new knowledge base.
   */
  async create(db: Db, input: CreateKnowledgeBaseInput): Promise<KnowledgeBase> {
    return kbStore.createKnowledgeBase(db, input);
  },

  /**
   * Get a knowledge base by ID.
   */
  async getById(db: Db, id: string): Promise<KnowledgeBase | null> {
    return kbStore.getKnowledgeBaseById(db, id);
  },

  /**
   * Get a knowledge base by name.
   */
  async getByName(db: Db, companyId: string, name: string): Promise<KnowledgeBase | null> {
    return kbStore.getKnowledgeBaseByName(db, companyId, name);
  },

  /**
   * List knowledge bases for a company.
   */
  async list(db: Db, companyId: string): Promise<KnowledgeBase[]> {
    return kbStore.listKnowledgeBases(db, companyId);
  },

  /**
   * Update a knowledge base.
   */
  async update(
    db: Db,
    id: string,
    updates: Partial<Omit<KnowledgeBase, "id" | "createdAt" | "updatedAt">>,
  ): Promise<KnowledgeBase | null> {
    return kbStore.updateKnowledgeBase(db, id, updates);
  },

  /**
   * Delete a knowledge base.
   */
  async delete(db: Db, id: string): Promise<boolean> {
    return kbStore.deleteKnowledgeBase(db, id);
  },

  /**
   * Grant an agent access to a knowledge base.
   */
  async grantAccess(db: Db, input: GrantAgentKbInput): Promise<AgentKbGrant> {
    return kbStore.grantAgentAccess(db, input);
  },

  /**
   * Revoke an agent's access to a knowledge base.
   */
  async revokeAccess(db: Db, agentId: string, kbId: string): Promise<boolean> {
    return kbStore.revokeAgentAccess(db, agentId, kbId);
  },

  /**
   * List knowledge bases accessible to an agent.
   */
  async listAccessible(db: Db, agentId: string, companyId: string): Promise<KnowledgeBase[]> {
    return kbStore.listAccessibleKnowledgeBases(db, agentId, companyId);
  },

  /**
   * Retrieve knowledge from a knowledge base.
   * This is a simplified implementation - actual RAG/ontology would call external services.
   */
  async retrieve(db: Db, request: KbRetrievalRequest): Promise<KbRetrievalResult> {
    const kb = await kbStore.getKnowledgeBaseById(db, request.kbId);
    if (!kb) {
      return {
        content: "",
        tokenCount: 0,
        source: "",
        error: "Knowledge base not found",
      };
    }

    const maxTokens = request.maxTokens ?? kb.maxTokenBudget;

    switch (kb.type) {
      case "static": {
        const content = (kb.config.content as string) ?? "";
        const tokens = estimateTokenCount(content);

        if (tokens > maxTokens) {
          // Truncate to max tokens
          const truncatedLength = maxTokens * 4;
          return {
            content: content.substring(0, truncatedLength),
            tokenCount: maxTokens,
            source: kb.name,
          };
        }

        return {
          content,
          tokenCount: tokens,
          source: kb.name,
        };
      }

      case "rag": {
        // Placeholder for RAG retrieval - would call MCP server
        return {
          content: `[RAG retrieval for KB "${kb.name}" - query: ${request.query}]`,
          tokenCount: estimateTokenCount(request.query),
          source: kb.name,
          error: "RAG not yet implemented",
        };
      }

      case "ontology": {
        // Placeholder for ontology retrieval
        return {
          content: `[Ontology retrieval for KB "${kb.name}" - query: ${request.query}]`,
          tokenCount: estimateTokenCount(request.query),
          source: kb.name,
          error: "Ontology not yet implemented",
        };
      }

      default:
        return {
          content: "",
          tokenCount: 0,
          source: "",
          error: "Unknown knowledge base type",
        };
    }
  },
};

// Re-export types
export type {
  KnowledgeBase,
  CreateKnowledgeBaseInput,
  AgentKbGrant,
  GrantAgentKbInput,
  KbRetrievalRequest,
  KbRetrievalResult,
};

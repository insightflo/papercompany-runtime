/**
 * Knowledge Base Service
 *
 * Main service interface for knowledge base operations.
 * Provides CRUD for knowledge bases and retrieval interfaces.
 */

import type { Db } from "@paperclipai/db";
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

type RetrievalDocument = {
  id: string;
  title: string | null;
  content: string;
};

function trimToTokenBudget(text: string, maxTokens: number) {
  const trimmedText = text.trim();
  const tokenCount = estimateTokenCount(trimmedText);
  if (tokenCount <= maxTokens) {
    return {
      content: trimmedText,
      tokenCount,
    };
  }

  const truncatedLength = Math.max(0, maxTokens * 4);
  return {
    content: trimmedText.slice(0, truncatedLength).trimEnd(),
    tokenCount: maxTokens,
  };
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function readDocumentContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "";

  const record = value as Record<string, unknown>;
  return [
    record.content,
    record.text,
    record.body,
    record.markdown,
    record.summary,
    record.description,
  ]
    .map(readString)
    .find((candidate) => candidate.length > 0) ?? "";
}

function readDocumentTitle(value: unknown, fallback: string | null = null) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;

  const record = value as Record<string, unknown>;
  return [
    record.title,
    record.name,
    record.label,
    record.path,
    record.id,
  ]
    .map(readString)
    .find((candidate) => candidate.length > 0) ?? fallback;
}

function pushDocument(target: RetrievalDocument[], value: unknown, fallbackId: string, fallbackTitle: string | null = null) {
  const content = readDocumentContent(value);
  if (!content) return;

  target.push({
    id: readString((value as { id?: unknown } | null)?.id) || fallbackId,
    title: readDocumentTitle(value, fallbackTitle),
    content,
  });
}

function collectConfigDocuments(config: Record<string, unknown>): RetrievalDocument[] {
  const documents: RetrievalDocument[] = [];
  const collections: Array<[string, unknown]> = [
    ["documents", config.documents],
    ["passages", config.passages],
    ["chunks", config.chunks],
    ["entries", config.entries],
    ["nodes", config.nodes],
    ["entities", config.entities],
    ["edges", config.edges],
    ["triples", config.triples],
  ];

  for (const [label, value] of collections) {
    if (!Array.isArray(value)) continue;
    value.forEach((entry, index) => pushDocument(documents, entry, `${label}-${index + 1}`, `${label}-${index + 1}`));
  }

  if (documents.length === 0) {
    pushDocument(documents, config, "config-root", readString(config.name) || null);
  }
  if (documents.length === 0) {
    const content = readString(config.content);
    if (content.length > 0) {
      documents.push({
        id: "content",
        title: "content",
        content,
      });
    }
  }

  return documents;
}

function tokenizeQuery(query: string) {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    ),
  );
}

function scoreDocument(doc: RetrievalDocument, query: string, queryTokens: string[]) {
  const haystack = `${doc.title ?? ""}\n${doc.content}`.toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();
  const tokenMatches = queryTokens.reduce((count, token) => {
    return count + (haystack.includes(token) ? 1 : 0);
  }, 0);
  const phraseBonus = normalizedQuery.length > 0 && haystack.includes(normalizedQuery) ? 3 : 0;
  const titleBonus =
    doc.title && queryTokens.some((token) => doc.title!.toLowerCase().includes(token))
      ? 1
      : 0;

  return tokenMatches + phraseBonus + titleBonus;
}

function buildRetrievalContent(documents: RetrievalDocument[], maxTokens: number) {
  const sections: string[] = [];
  let budget = maxTokens;

  for (const document of documents) {
    if (budget <= 0) break;
    const header = document.title ? `# ${document.title}` : `# ${document.id}`;
    const section = `${header}\n${document.content}`.trim();
    const trimmed = trimToTokenBudget(section, budget);
    if (!trimmed.content) continue;
    sections.push(trimmed.content);
    budget -= trimmed.tokenCount;
  }

  return trimToTokenBudget(sections.join("\n\n"), maxTokens);
}

function retrieveFromConfig(config: Record<string, unknown>, query: string, maxTokens: number) {
  const documents = collectConfigDocuments(config);
  if (documents.length === 0) {
    return {
      content: "",
      tokenCount: 0,
      error: "Knowledge base corpus is empty",
    };
  }

  const queryTokens = tokenizeQuery(query);
  const ranked = documents
    .map((document) => ({
      document,
      score: scoreDocument(document, query, queryTokens),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.document.id.localeCompare(right.document.id);
    });

  const selected = ranked
    .filter((entry) => entry.score > 0)
    .slice(0, 3)
    .map((entry) => entry.document);
  const fallbackSelection =
    selected.length > 0 ? selected : ranked.slice(0, 2).map((entry) => entry.document);
  const retrieval = buildRetrievalContent(fallbackSelection, maxTokens);

  return {
    content: retrieval.content,
    tokenCount: retrieval.tokenCount,
    error: retrieval.content.length > 0 ? undefined : "Knowledge base corpus is empty",
  };
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

    const accessibleKnowledgeBases = await kbStore.listAccessibleKnowledgeBases(
      db,
      request.agentId,
      kb.companyId,
    );
    if (!accessibleKnowledgeBases.some((candidate) => candidate.id === kb.id)) {
      return {
        content: "",
        tokenCount: 0,
        source: kb.name,
        error: "Knowledge base not accessible",
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
        const retrieval = retrieveFromConfig(kb.config, request.query, maxTokens);
        return {
          content: retrieval.content,
          tokenCount: retrieval.tokenCount,
          source: kb.name,
          ...(retrieval.error ? { error: retrieval.error } : {}),
        };
      }

      case "ontology": {
        const retrieval = retrieveFromConfig(kb.config, request.query, maxTokens);
        return {
          content: retrieval.content,
          tokenCount: retrieval.tokenCount,
          source: kb.name,
          ...(retrieval.error ? { error: retrieval.error } : {}),
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

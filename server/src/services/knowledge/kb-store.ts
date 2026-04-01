/**
 * Knowledge Base Store
 *
 * Database access layer for knowledge bases and agent grants.
 * Replaces plugin entity storage with direct Drizzle ORM queries.
 */

import type { Db } from "../../packages/db/src/client.js";
import { knowledgeBases, agentKbGrants, agents } from "../../packages/db/src/schema/index.js";
import { eq, and, desc, sql } from "drizzle-orm";
import type {
  KnowledgeBase,
  CreateKnowledgeBaseInput,
  AgentKbGrant,
  GrantAgentKbInput,
} from "./types.js";

/**
 * Knowledge base store service.
 */
export const kbStore = {
  /**
   * Create a new knowledge base.
   */
  async createKnowledgeBase(
    db: Db,
    input: CreateKnowledgeBaseInput,
  ): Promise<KnowledgeBase> {
    const id = crypto.randomUUID();
    const now = new Date();

    await db.insert(knowledgeBases).values({
      id,
      companyId: input.companyId,
      name: input.name,
      type: input.type,
      description: input.description ?? "",
      maxTokenBudget: input.maxTokenBudget ?? 4096,
      configJson: input.config,
      createdAt: now,
      updatedAt: now,
    });

    return this.getKnowledgeBaseById(db, id) as Promise<KnowledgeBase>;
  },

  /**
   * Get a knowledge base by ID.
   */
  async getKnowledgeBaseById(db: Db, id: string): Promise<KnowledgeBase | null> {
    const result = await db
      .select()
      .from(knowledgeBases)
      .where(eq(knowledgeBases.id, id))
      .limit(1);

    if (!result[0]) return null;
    return {
      id: result[0].id,
      companyId: result[0].companyId,
      name: result[0].name,
      type: result[0].type as "static" | "rag" | "ontology",
      description: result[0].description,
      maxTokenBudget: result[0].maxTokenBudget,
      config: result[0].configJson as Record<string, unknown>,
      createdAt: result[0].createdAt,
      updatedAt: result[0].updatedAt,
    };
  },

  /**
   * Get a knowledge base by name and company.
   */
  async getKnowledgeBaseByName(
    db: Db,
    companyId: string,
    name: string,
  ): Promise<KnowledgeBase | null> {
    const result = await db
      .select()
      .from(knowledgeBases)
      .where(
        and(
          eq(knowledgeBases.companyId, companyId),
          eq(knowledgeBases.name, name),
        ),
      )
      .limit(1);

    if (!result[0]) return null;
    return {
      id: result[0].id,
      companyId: result[0].companyId,
      name: result[0].name,
      type: result[0].type as "static" | "rag" | "ontology",
      description: result[0].description,
      maxTokenBudget: result[0].maxTokenBudget,
      config: result[0].configJson as Record<string, unknown>,
      createdAt: result[0].createdAt,
      updatedAt: result[0].updatedAt,
    };
  },

  /**
   * List knowledge bases for a company.
   */
  async listKnowledgeBases(
    db: Db,
    companyId: string,
  ): Promise<KnowledgeBase[]> {
    const results = await db
      .select()
      .from(knowledgeBases)
      .where(eq(knowledgeBases.companyId, companyId))
      .orderBy(desc(knowledgeBases.createdAt));

    return results.map((kb) => ({
      id: kb.id,
      companyId: kb.companyId,
      name: kb.name,
      type: kb.type as "static" | "rag" | "ontology",
      description: kb.description,
      maxTokenBudget: kb.maxTokenBudget,
      config: kb.configJson as Record<string, unknown>,
      createdAt: kb.createdAt,
      updatedAt: kb.updatedAt,
    }));
  },

  /**
   * Update a knowledge base.
   */
  async updateKnowledgeBase(
    db: Db,
    id: string,
    updates: Partial<Omit<KnowledgeBase, "id" | "createdAt" | "updatedAt">>,
  ): Promise<KnowledgeBase | null> {
    await db
      .update(knowledgeBases)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(knowledgeBases.id, id));

    return this.getKnowledgeBaseById(db, id);
  },

  /**
   * Delete a knowledge base.
   */
  async deleteKnowledgeBase(db: Db, id: string): Promise<boolean> {
    const result = await db
      .delete(knowledgeBases)
      .where(eq(knowledgeBases.id, id));

    return (result.rowCount ?? 0) > 0;
  },

  /**
   * Grant knowledge base access to an agent.
   */
  async grantAgentAccess(
    db: Db,
    input: GrantAgentKbInput,
  ): Promise<AgentKbGrant> {
    // Check if grant already exists
    const existing = await db
      .select()
      .from(agentKbGrants)
      .where(
        and(
          eq(agentKbGrants.agentId, input.agentId),
          eq(agentKbGrants.kbId, input.kbId),
        ),
      )
      .limit(1);

    if (existing[0]) {
      return existing[0] as AgentKbGrant;
    }

    const id = crypto.randomUUID();
    await db.insert(agentKbGrants).values({
      id,
      agentId: input.agentId,
      kbId: input.kbId,
      grantedBy: input.grantedBy,
      createdAt: new Date(),
    });

    const result = await db
      .select()
      .from(agentKbGrants)
      .where(eq(agentKbGrants.id, id))
      .limit(1);

    return result[0] as AgentKbGrant;
  },

  /**
   * Revoke agent access to a knowledge base.
   */
  async revokeAgentAccess(db: Db, agentId: string, kbId: string): Promise<boolean> {
    const result = await db
      .delete(agentKbGrants)
      .where(
        and(
          eq(agentKbGrants.agentId, agentId),
          eq(agentKbGrants.kbId, kbId),
        ),
      );

    return (result.rowCount ?? 0) > 0;
  },

  /**
   * List knowledge bases accessible to an agent.
   */
  async listAccessibleKnowledgeBases(
    db: Db,
    agentId: string,
    companyId: string,
  ): Promise<KnowledgeBase[]> {
    const results = await db
      .select({
        id: knowledgeBases.id,
        companyId: knowledgeBases.companyId,
        name: knowledgeBases.name,
        type: knowledgeBases.type,
        description: knowledgeBases.description,
        maxTokenBudget: knowledgeBases.maxTokenBudget,
        configJson: knowledgeBases.configJson,
        createdAt: knowledgeBases.createdAt,
        updatedAt: knowledgeBases.updatedAt,
      })
      .from(knowledgeBases)
      .innerJoin(agentKbGrants, eq(agentKbGrants.kbId, knowledgeBases.id))
      .where(eq(agentKbGrants.agentId, agentId))
      .orderBy(desc(knowledgeBases.createdAt));

    return results.map((kb) => ({
      id: kb.id,
      companyId: kb.companyId,
      name: kb.name,
      type: kb.type as "static" | "rag" | "ontology",
      description: kb.description,
      maxTokenBudget: kb.maxTokenBudget,
      config: kb.configJson as Record<string, unknown>,
      createdAt: kb.createdAt,
      updatedAt: kb.updatedAt,
    }));
  },
};

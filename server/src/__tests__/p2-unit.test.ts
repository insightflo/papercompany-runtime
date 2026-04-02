/**
 * P2-T7: Unit tests for DAG validation, tool dispatch, and KB retrieval.
 *
 * All tests are pure unit tests — no real DB, no network.
 * External dependencies are mocked with vi.fn().
 */

import { describe, it, expect, vi } from "vitest";

// Mock @paperclipai/db to prevent the postgres transitive import from breaking vitest
vi.mock("@paperclipai/db", () => ({
  workflowDefinitions: {},
  workflowRuns: {},
  workflowStepRuns: {},
  issues: {},
  toolDefinitions: {},
  toolAuditLog: {},
  agents: {},
  knowledgeBases: {},
  agentKbGrants: {},
}));

import { validateDag } from "../services/workflow/dag-engine.js";
import { toolService } from "../services/tools/registry.js";
import { knowledgeService } from "../services/knowledge/base.js";
import type { WorkflowStep } from "../services/workflow/dag-engine.js";
import type { KnowledgeBase } from "../services/knowledge/types.js";

// ---------------------------------------------------------------------------
// Minimal mock DB factory
// Each test can override individual query methods as needed.
// ---------------------------------------------------------------------------

function makeMockDb() {
  const mockResult = {
    where: vi.fn(),
    limit: vi.fn(),
    orderBy: vi.fn(),
  };
  // Make chainable
  mockResult.where.mockReturnValue(mockResult);
  mockResult.limit.mockReturnValue(mockResult);
  mockResult.orderBy.mockReturnValue(mockResult);

  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue(mockResult),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue({ rowCount: 1 }),
    }),
    _mockResult: mockResult,
  };
}

// ---------------------------------------------------------------------------
// DAG Validation
// ---------------------------------------------------------------------------

describe("validateDag", () => {
  it("accepts a valid linear DAG with no cycles", () => {
    const steps: WorkflowStep[] = [
      { id: "a", name: "Step A", agentId: "agent-1", dependencies: [] },
      { id: "b", name: "Step B", agentId: "agent-1", dependencies: ["a"] },
      { id: "c", name: "Step C", agentId: "agent-1", dependencies: ["b"] },
    ];

    const result = validateDag(steps);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts a valid diamond-shaped DAG", () => {
    const steps: WorkflowStep[] = [
      { id: "start", name: "Start", agentId: "agent-1", dependencies: [] },
      { id: "left", name: "Left",  agentId: "agent-1", dependencies: ["start"] },
      { id: "right", name: "Right", agentId: "agent-1", dependencies: ["start"] },
      { id: "end", name: "End", agentId: "agent-1", dependencies: ["left", "right"] },
    ];

    const result = validateDag(steps);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("detects a simple two-node cycle (a → b → a)", () => {
    const steps: WorkflowStep[] = [
      { id: "a", name: "Step A", agentId: "agent-1", dependencies: ["b"] },
      { id: "b", name: "Step B", agentId: "agent-1", dependencies: ["a"] },
    ];

    const result = validateDag(steps);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /cycle/i.test(e))).toBe(true);
  });

  it("detects a three-node cycle", () => {
    const steps: WorkflowStep[] = [
      { id: "a", name: "A", agentId: "x", dependencies: ["c"] },
      { id: "b", name: "B", agentId: "x", dependencies: ["a"] },
      { id: "c", name: "C", agentId: "x", dependencies: ["b"] },
    ];

    const result = validateDag(steps);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /cycle/i.test(e))).toBe(true);
  });

  it("rejects a step that references a non-existent dependency", () => {
    const steps: WorkflowStep[] = [
      { id: "a", name: "A", agentId: "x", dependencies: [] },
      { id: "b", name: "B", agentId: "x", dependencies: ["does-not-exist"] },
    ];

    const result = validateDag(steps);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /does-not-exist/.test(e))).toBe(true);
  });

  it("rejects duplicate step IDs", () => {
    const steps: WorkflowStep[] = [
      { id: "a", name: "A1", agentId: "x", dependencies: [] },
      { id: "a", name: "A2", agentId: "x", dependencies: [] },
    ];

    const result = validateDag(steps);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /duplicate/i.test(e))).toBe(true);
  });

  it("returns valid with empty warnings for an empty DAG", () => {
    const result = validateDag([]);

    // An empty workflow is considered valid (nothing to violate)
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("reports an error when all steps have dependencies (no entry points)", () => {
    const steps: WorkflowStep[] = [
      { id: "a", name: "A", agentId: "x", dependencies: ["b"] },
      { id: "b", name: "B", agentId: "x", dependencies: ["a"] },
    ];

    const result = validateDag(steps);

    // Either a cycle or no-entry-point error must be raised
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tool dispatch (toolService.getDefinitionById / checkInvocation)
// ---------------------------------------------------------------------------

describe("toolService.getDefinitionById", () => {
  it("returns the tool when found in the DB", async () => {
    const db = makeMockDb() as any;
    const fakeTool = {
      id: "tool-123",
      companyId: "co-1",
      name: "search",
      description: "web search",
      inputSchema: {},
      adapterType: "builtin",
      adapterConfig: {},
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // .select().from().where().limit() → resolves to [fakeTool]
    db._mockResult.limit.mockResolvedValueOnce([fakeTool]);

    const result = await toolService.getDefinitionById(db, "tool-123");

    expect(result).toEqual(fakeTool);
  });

  it("returns null when no tool matches the id", async () => {
    const db = makeMockDb() as any;
    db._mockResult.limit.mockResolvedValueOnce([]);

    const result = await toolService.getDefinitionById(db, "unknown-id");

    expect(result).toBeNull();
  });
});

describe("toolService.checkInvocation", () => {
  const baseContext = {
    companyId: "co-1",
    issueId: "issue-1",
    agentId: "agent-1",
    toolName: "search",
    args: { q: "hello" },
  };

  it("returns allowed=false with reason when tool is not found", async () => {
    const db = makeMockDb() as any;
    // getDefinitionByName → empty result
    db._mockResult.limit.mockResolvedValueOnce([]);

    const result = await toolService.checkInvocation(db, baseContext);

    expect(result.allowed).toBe(false);
    expect(result.blockedReason).toMatch(/not found/i);
  });

  it("returns allowed=false when tool is disabled", async () => {
    const db = makeMockDb() as any;
    const disabledTool = {
      id: "t-1",
      companyId: "co-1",
      name: "search",
      description: "",
      inputSchema: {},
      adapterType: "builtin",
      adapterConfig: {},
      enabled: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    db._mockResult.limit.mockResolvedValueOnce([disabledTool]);

    const result = await toolService.checkInvocation(db, baseContext);

    expect(result.allowed).toBe(false);
    expect(result.blockedReason).toMatch(/disabled/i);
  });

  it("returns allowed=true for an enabled tool with no worktree constraint", async () => {
    const db = makeMockDb() as any;
    const enabledTool = {
      id: "t-2",
      companyId: "co-1",
      name: "search",
      description: "",
      inputSchema: {},
      adapterType: "builtin",
      adapterConfig: {},
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    // First call: getDefinitionByName
    db._mockResult.limit.mockResolvedValueOnce([enabledTool]);
    // Second call (logInvocation → insert): just resolve
    const insertValuesMock = vi.fn().mockResolvedValue(undefined);
    db.insert.mockReturnValue({ values: insertValuesMock });

    const result = await toolService.checkInvocation(db, baseContext);

    expect(result.allowed).toBe(true);
    expect(result.blockedReason).toBeUndefined();
  });

  it("blocks with MUST tier worktree constraint and logs blocked_must", async () => {
    const db = makeMockDb() as any;
    const enabledTool = {
      id: "t-3",
      companyId: "co-1",
      name: "search",
      description: "",
      inputSchema: {},
      adapterType: "builtin",
      adapterConfig: {},
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    db._mockResult.limit.mockResolvedValueOnce([enabledTool]);

    const insertValuesMock = vi.fn().mockResolvedValue(undefined);
    db.insert.mockReturnValue({ values: insertValuesMock });

    const ctx = {
      ...baseContext,
      worktreeCheck: {
        allowed: false,
        tier: "MUST" as const,
        violatedRuleId: "rule-1",
        message: "No writes outside worktree",
      },
    };

    const result = await toolService.checkInvocation(db, ctx);

    expect(result.allowed).toBe(false);
    expect(result.blockedReason).toMatch(/worktree/i);
    // Audit log must have been written
    expect(insertValuesMock).toHaveBeenCalled();
    const loggedEntry = insertValuesMock.mock.calls[0]?.[0];
    expect(loggedEntry?.result).toBe("blocked_must");
  });
});

// ---------------------------------------------------------------------------
// KB retrieval (knowledgeService.getById / retrieve)
// ---------------------------------------------------------------------------

describe("knowledgeService.getById", () => {
  it("delegates to kbStore and returns the mapped KB", async () => {
    const db = makeMockDb() as any;
    const fakeRow = {
      id: "kb-1",
      companyId: "co-1",
      name: "Policy Docs",
      type: "static",
      description: "Company policy",
      maxTokenBudget: 4096,
      configJson: { content: "Welcome to PaperCo." },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    db._mockResult.limit.mockResolvedValueOnce([fakeRow]);

    const result = await knowledgeService.getById(db, "kb-1");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("kb-1");
    expect(result!.name).toBe("Policy Docs");
    expect(result!.config).toEqual({ content: "Welcome to PaperCo." });
  });

  it("returns null when the KB does not exist", async () => {
    const db = makeMockDb() as any;
    db._mockResult.limit.mockResolvedValueOnce([]);

    const result = await knowledgeService.getById(db, "no-such-kb");

    expect(result).toBeNull();
  });
});

describe("knowledgeService.retrieve", () => {
  function makeKb(overrides: Partial<KnowledgeBase> = {}): KnowledgeBase {
    return {
      id: "kb-1",
      companyId: "co-1",
      name: "Test KB",
      type: "static",
      description: "",
      maxTokenBudget: 4096,
      config: { content: "Hello, world." },
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  it("returns error result when KB is not found", async () => {
    const db = makeMockDb() as any;
    // kbStore.getKnowledgeBaseById → null (empty array result)
    db._mockResult.limit.mockResolvedValueOnce([]);

    const result = await knowledgeService.retrieve(db, {
      kbId: "missing",
      query: "test",
      agentId: "agent-1",
    });

    expect(result.error).toMatch(/not found/i);
    expect(result.content).toBe("");
  });

  it("returns static content for a static KB", async () => {
    const db = makeMockDb() as any;
    const kb = makeKb({ config: { content: "Static content here." } });
    const fakeRow = {
      id: kb.id,
      companyId: kb.companyId,
      name: kb.name,
      type: kb.type,
      description: kb.description,
      maxTokenBudget: kb.maxTokenBudget,
      configJson: kb.config,
      createdAt: kb.createdAt,
      updatedAt: kb.updatedAt,
    };
    db._mockResult.limit.mockResolvedValueOnce([fakeRow]);

    const result = await knowledgeService.retrieve(db, {
      kbId: "kb-1",
      query: "anything",
      agentId: "agent-1",
    });

    expect(result.error).toBeUndefined();
    expect(result.content).toBe("Static content here.");
    expect(result.source).toBe("Test KB");
    expect(result.tokenCount).toBeGreaterThan(0);
  });

  it("truncates static content when it exceeds maxTokens", async () => {
    const db = makeMockDb() as any;
    // 100 chars / 4 chars-per-token = 25 tokens; we'll cap at 5 tokens = 20 chars
    const longContent = "x".repeat(100);
    const fakeRow = {
      id: "kb-1",
      companyId: "co-1",
      name: "Big KB",
      type: "static",
      description: "",
      maxTokenBudget: 4096,
      configJson: { content: longContent },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    db._mockResult.limit.mockResolvedValueOnce([fakeRow]);

    const result = await knowledgeService.retrieve(db, {
      kbId: "kb-1",
      query: "q",
      agentId: "agent-1",
      maxTokens: 5,
    });

    // 5 tokens * 4 chars = 20 chars
    expect(result.content.length).toBeLessThanOrEqual(20);
    expect(result.tokenCount).toBe(5);
  });

  it("returns partial error for RAG KB (not yet implemented)", async () => {
    const db = makeMockDb() as any;
    const fakeRow = {
      id: "kb-rag",
      companyId: "co-1",
      name: "RAG KB",
      type: "rag",
      description: "",
      maxTokenBudget: 4096,
      configJson: { mcpServerId: "mcp-1" },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    db._mockResult.limit.mockResolvedValueOnce([fakeRow]);

    const result = await knowledgeService.retrieve(db, {
      kbId: "kb-rag",
      query: "find policy",
      agentId: "agent-1",
    });

    // RAG returns partial content with an error note
    expect(result.error).toBeTruthy();
    expect(result.content).toContain("find policy");
  });

  it("searches by query: retrieve uses the query string in RAG response content", async () => {
    const db = makeMockDb() as any;
    const fakeRow = {
      id: "kb-rag-2",
      companyId: "co-1",
      name: "Search KB",
      type: "rag",
      description: "",
      maxTokenBudget: 4096,
      configJson: { mcpServerId: "mcp-2" },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    db._mockResult.limit.mockResolvedValueOnce([fakeRow]);

    const result = await knowledgeService.retrieve(db, {
      kbId: "kb-rag-2",
      query: "quarterly revenue targets",
      agentId: "agent-1",
    });

    expect(result.content).toContain("quarterly revenue targets");
  });
});

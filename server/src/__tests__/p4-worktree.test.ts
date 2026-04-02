/**
 * P4-T10 — Worktree MUST/SHOULD/MAY integration tests + predicate fuzz
 *
 * Tests:
 * - checkAction() MUST violation → throws WorktreeViolation
 * - checkAction() no matching rule → no throw
 * - checkAction() SHOULD match → no throw, logger.warn called
 * - checkAction() MAY match → no throw, no warn
 * - evaluatePredicate() operator fuzz: $eq, $ne, $in, $notIn, $contains, $startsWith, $endsWith
 * - requireMaintenanceCompany middleware: business-company → 403 on /maintenance/* routes
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @paperclipai/db to prevent the postgres transitive import from breaking vitest
vi.mock("@paperclipai/db", () => ({
  worktreeRules: {},
  companies: {},
}));

import {
  WorktreeHarness,
  WorktreeViolation,
  type WorktreeContext,
} from "../services/worktree/harness.js";
import { evaluatePredicate } from "../services/worktree/predicate-eval.js";
import { requireMaintenanceCompany } from "../middleware/company-kind-gate.js";
import type { Request, Response, NextFunction } from "express";

// ---------------------------------------------------------------------------
// Module mocks — must be at top level (vi.mock is hoisted)
// ---------------------------------------------------------------------------

// Mock logger to prevent pino transport startup and allow spy assertions
vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock metrics to avoid prom-client registry side effects
vi.mock("../routes/metrics.js", () => ({
  worktreeCheckActionLatency: { observe: vi.fn() },
  missionSessionEvents: { inc: vi.fn() },
  httpRequestDuration: { observe: vi.fn() },
  httpRequestTotal: { inc: vi.fn() },
  activeMissionSessions: { set: vi.fn() },
  missionsByStatus: { set: vi.fn() },
  workflowRunsByStatus: { set: vi.fn() },
  activeHeartbeatRuns: { set: vi.fn() },
  worktreeRulesBySeverity: { set: vi.fn() },
  srbDeliveriesByStatus: { set: vi.fn() },
  schedulerDueToWakeupLatency: { observe: vi.fn() },
  srbWebhookDeliveries: { inc: vi.fn() },
  metricsMiddleware: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
  metricsRoutes: vi.fn(),
  register: { metrics: vi.fn(), contentType: "text/plain", getMetricsAsJSON: vi.fn() },
}));

// Mock @opentelemetry/api so withSpan is a transparent pass-through
vi.mock("../lib/tracer.js", () => ({
  tracer: {},
  withSpan: vi.fn(
    async (_name: string, _attrs: unknown, fn: (span: unknown) => Promise<unknown>) =>
      fn({ setAttribute: vi.fn() }),
  ),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal drizzle-style mock DB whose `.select().from().where()` chain
 * resolves to the provided rows array.
 */
function buildDbWithRules(rules: unknown[]) {
  const whereStub = vi.fn().mockResolvedValue(rules);
  const fromStub = vi.fn(() => ({ where: whereStub }));
  const selectStub = vi.fn(() => ({ from: fromStub }));
  return { select: selectStub } as unknown as import("@paperclipai/db").Db;
}

const BASE_CTX: WorktreeContext = {
  companyId: "company-a",
  agentId: "agent-1",
  tool: "file-write",
  args: { path: "/etc/passwd" },
};

function makeRule(
  severity: "MUST" | "SHOULD" | "MAY",
  predicate: Record<string, unknown>,
  overrides: Partial<{
    id: string;
    name: string;
    message: string;
    decisionMap: Record<string, string>;
  }> = {},
) {
  return {
    id: overrides.id ?? "rule-1",
    name: overrides.name ?? `${severity} rule`,
    severity,
    predicate,
    decisionMap: overrides.decisionMap ?? {},
    message: overrides.message ?? `${severity} violation`,
    enabled: true,
  };
}

// ---------------------------------------------------------------------------
// checkAction — tier enforcement
// ---------------------------------------------------------------------------

describe("WorktreeHarness.checkAction — tier enforcement", () => {
  let loggerMod: { logger: { warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> } };

  beforeEach(async () => {
    vi.clearAllMocks();
    loggerMod = await import("../middleware/logger.js") as unknown as typeof loggerMod;
  });

  it("MUST tier: matching rule throws WorktreeViolation", async () => {
    // Rule matches when tool === "file-write"
    const rule = makeRule("MUST", { tool: { $eq: "file-write" } });
    const db = buildDbWithRules([rule]);
    const harness = new WorktreeHarness(db);

    await expect(harness.checkAction(BASE_CTX)).rejects.toBeInstanceOf(WorktreeViolation);
  });

  it("MUST tier: WorktreeViolation carries ruleId and severity", async () => {
    const rule = makeRule("MUST", { tool: { $eq: "file-write" } }, { id: "must-rule-99" });
    const db = buildDbWithRules([rule]);
    const harness = new WorktreeHarness(db);

    const caught = await harness.checkAction(BASE_CTX).catch((e) => e);
    expect(caught).toBeInstanceOf(WorktreeViolation);
    expect((caught as WorktreeViolation).ruleId).toBe("must-rule-99");
    expect((caught as WorktreeViolation).severity).toBe("MUST");
    expect((caught as WorktreeViolation).context).toBe(BASE_CTX);
  });

  it("MUST tier: no matching rule → no throw", async () => {
    // Rule matches tool "shell-exec" — but context has "file-write"
    const rule = makeRule("MUST", { tool: { $eq: "shell-exec" } });
    const db = buildDbWithRules([rule]);
    const harness = new WorktreeHarness(db);

    await expect(harness.checkAction(BASE_CTX)).resolves.toBeUndefined();
  });

  it("MUST tier: empty rule set → no throw", async () => {
    const db = buildDbWithRules([]);
    const harness = new WorktreeHarness(db);

    await expect(harness.checkAction(BASE_CTX)).resolves.toBeUndefined();
  });

  it("SHOULD tier: matching rule → no throw, logger.warn called", async () => {
    const rule = makeRule("SHOULD", { tool: { $eq: "file-write" } });
    const db = buildDbWithRules([rule]);
    const harness = new WorktreeHarness(db);

    await expect(harness.checkAction(BASE_CTX)).resolves.toBeUndefined();
    expect(loggerMod.logger.warn).toHaveBeenCalledOnce();

    const warnArg = vi.mocked(loggerMod.logger.warn).mock.calls[0][0] as Record<string, unknown>;
    expect(warnArg.msg).toBe("Worktree SHOULD violation");
    expect(warnArg.ruleId).toBe("rule-1");
  });

  it("SHOULD tier: non-matching rule → no warn, no throw", async () => {
    const rule = makeRule("SHOULD", { tool: { $eq: "shell-exec" } });
    const db = buildDbWithRules([rule]);
    const harness = new WorktreeHarness(db);

    await expect(harness.checkAction(BASE_CTX)).resolves.toBeUndefined();
    expect(loggerMod.logger.warn).not.toHaveBeenCalled();
  });

  it("MAY tier: matching rule → no throw, no warn", async () => {
    const rule = makeRule("MAY", { tool: { $eq: "file-write" } });
    const db = buildDbWithRules([rule]);
    const harness = new WorktreeHarness(db);

    await expect(harness.checkAction(BASE_CTX)).resolves.toBeUndefined();
    expect(loggerMod.logger.warn).not.toHaveBeenCalled();
  });

  it("decisionMap overrides base severity: SHOULD rule with MUST override for tool → throws", async () => {
    const rule = makeRule(
      "SHOULD",
      { tool: { $eq: "file-write" } },
      { decisionMap: { "file-write": "MUST" } },
    );
    const db = buildDbWithRules([rule]);
    const harness = new WorktreeHarness(db);

    await expect(harness.checkAction(BASE_CTX)).rejects.toBeInstanceOf(WorktreeViolation);
  });

  it("decisionMap overrides base severity: MUST rule with MAY override → no throw", async () => {
    const rule = makeRule(
      "MUST",
      { tool: { $eq: "file-write" } },
      { decisionMap: { "file-write": "MAY" } },
    );
    const db = buildDbWithRules([rule]);
    const harness = new WorktreeHarness(db);

    await expect(harness.checkAction(BASE_CTX)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// evaluatePredicate — operator fuzz
// ---------------------------------------------------------------------------

describe("evaluatePredicate — operator fuzz", () => {
  const ctx = {
    tool: "file-write",
    filePath: "/home/user/docs/report.pdf",
    companyId: "co-123",
    count: 5,
  };

  describe("$eq", () => {
    it("matches equal string", () => {
      expect(evaluatePredicate({ tool: { $eq: "file-write" } }, ctx).matches).toBe(true);
    });
    it("does not match different string", () => {
      expect(evaluatePredicate({ tool: { $eq: "shell-exec" } }, ctx).matches).toBe(false);
    });
    it("matches null field when $eq null", () => {
      expect(evaluatePredicate({ missing: { $eq: null } }, ctx).matches).toBe(true);
    });
  });

  describe("$ne", () => {
    it("matches when value differs", () => {
      expect(evaluatePredicate({ tool: { $ne: "shell-exec" } }, ctx).matches).toBe(true);
    });
    it("does not match when value is equal", () => {
      expect(evaluatePredicate({ tool: { $ne: "file-write" } }, ctx).matches).toBe(false);
    });
  });

  describe("$in", () => {
    it("matches when value is in array", () => {
      expect(evaluatePredicate({ tool: { $in: ["file-write", "shell-exec"] } }, ctx).matches).toBe(true);
    });
    it("does not match when value is absent from array", () => {
      expect(evaluatePredicate({ tool: { $in: ["shell-exec", "http-fetch"] } }, ctx).matches).toBe(false);
    });
    it("returns error when operand is not an array", () => {
      const result = evaluatePredicate({ tool: { $in: "file-write" as unknown as string[] } }, ctx);
      expect(result.matches).toBe(false);
      expect(result.error).toContain("$in requires array");
    });
  });

  describe("$notIn", () => {
    it("matches when value is absent from array", () => {
      expect(evaluatePredicate({ tool: { $notIn: ["shell-exec", "http-fetch"] } }, ctx).matches).toBe(true);
    });
    it("does not match when value is in array", () => {
      expect(evaluatePredicate({ tool: { $notIn: ["file-write", "shell-exec"] } }, ctx).matches).toBe(false);
    });
  });

  describe("$contains", () => {
    it("matches substring", () => {
      expect(evaluatePredicate({ filePath: { $contains: "docs" } }, ctx).matches).toBe(true);
    });
    it("does not match absent substring", () => {
      expect(evaluatePredicate({ filePath: { $contains: "etc" } }, ctx).matches).toBe(false);
    });
    it("returns error when field is not string", () => {
      const result = evaluatePredicate({ count: { $contains: "5" } }, ctx);
      expect(result.matches).toBe(false);
      expect(result.error).toContain("$contains requires strings");
    });
  });

  describe("$startsWith", () => {
    it("matches prefix", () => {
      expect(evaluatePredicate({ filePath: { $startsWith: "/home" } }, ctx).matches).toBe(true);
    });
    it("does not match wrong prefix", () => {
      expect(evaluatePredicate({ filePath: { $startsWith: "/etc" } }, ctx).matches).toBe(false);
    });
    it("returns error when field is not string", () => {
      const result = evaluatePredicate({ count: { $startsWith: "5" } }, ctx);
      expect(result.matches).toBe(false);
      expect(result.error).toContain("$startsWith requires strings");
    });
  });

  describe("$endsWith", () => {
    it("matches suffix", () => {
      expect(evaluatePredicate({ filePath: { $endsWith: ".pdf" } }, ctx).matches).toBe(true);
    });
    it("does not match wrong suffix", () => {
      expect(evaluatePredicate({ filePath: { $endsWith: ".txt" } }, ctx).matches).toBe(false);
    });
    it("returns error when field is not string", () => {
      const result = evaluatePredicate({ count: { $endsWith: "5" } }, ctx);
      expect(result.matches).toBe(false);
      expect(result.error).toContain("$endsWith requires strings");
    });
  });

  describe("compound predicates (AND semantics)", () => {
    it("all conditions met → matches", () => {
      const result = evaluatePredicate(
        {
          tool: { $eq: "file-write" },
          filePath: { $startsWith: "/home" },
        },
        ctx,
      );
      expect(result.matches).toBe(true);
    });

    it("one condition fails → no match", () => {
      const result = evaluatePredicate(
        {
          tool: { $eq: "file-write" },
          filePath: { $startsWith: "/etc" },
        },
        ctx,
      );
      expect(result.matches).toBe(false);
    });
  });

  describe("primitive shorthand (treated as $eq)", () => {
    it("string primitive matches equal value", () => {
      expect(evaluatePredicate({ tool: "file-write" }, ctx).matches).toBe(true);
    });
    it("string primitive does not match different value", () => {
      expect(evaluatePredicate({ tool: "shell-exec" }, ctx).matches).toBe(false);
    });
    it("number primitive matches equal number", () => {
      expect(evaluatePredicate({ count: 5 }, ctx).matches).toBe(true);
    });
  });

  describe("nested dot-notation paths", () => {
    it("resolves nested field", () => {
      const nested = { agent: { role: "engineer" }, tool: "file-write" };
      expect(evaluatePredicate({ "agent.role": { $eq: "engineer" } }, nested).matches).toBe(true);
    });

    it("missing nested path resolves to undefined (eq null → match)", () => {
      const nested = { tool: "file-write" };
      expect(evaluatePredicate({ "agent.role": { $eq: null } }, nested).matches).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// requireMaintenanceCompany — business-company JWT → 403
// ---------------------------------------------------------------------------

describe("requireMaintenanceCompany middleware", () => {
  function buildDbForKind(companyKind: string | undefined) {
    const limitStub = vi.fn().mockResolvedValue(
      companyKind !== undefined ? [{ companyKind }] : [],
    );
    const whereStub = vi.fn(() => ({ limit: limitStub }));
    const fromStub = vi.fn(() => ({ where: whereStub }));
    const selectStub = vi.fn(() => ({ from: fromStub }));
    return { select: selectStub } as unknown as import("@paperclipai/db").Db;
  }

  function makeReq(companyId: string): Request {
    return {
      params: { companyId },
    } as unknown as Request;
  }

  it("business company_kind → calls next with 403 HttpError", async () => {
    const db = buildDbForKind("business");
    const middleware = requireMaintenanceCompany(db);
    const req = makeReq("co-biz-1");
    const next = vi.fn();

    await middleware(req, {} as Response, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    const err = next.mock.calls[0][0] as { status: number };
    expect(err).toBeDefined();
    expect(err.status).toBe(403);
  });

  it("maintenance company_kind → calls next with no error", async () => {
    const db = buildDbForKind("maintenance");
    const middleware = requireMaintenanceCompany(db);
    const req = makeReq("co-maint-1");
    const next = vi.fn();

    await middleware(req, {} as Response, next as NextFunction);

    expect(next).toHaveBeenCalledWith();
    expect(next.mock.calls[0].length).toBe(0);
  });

  it("custom maintenanceKind option respected", async () => {
    const db = buildDbForKind("staging");
    const middleware = requireMaintenanceCompany(db, { maintenanceKind: "staging" });
    const req = makeReq("co-staging-1");
    const next = vi.fn();

    await middleware(req, {} as Response, next as NextFunction);

    expect(next).toHaveBeenCalledWith();
    expect(next.mock.calls[0].length).toBe(0);
  });

  it("no companyId in params → passes through without DB query", async () => {
    const db = buildDbForKind("business");
    const middleware = requireMaintenanceCompany(db);
    const req = { params: {} } as unknown as Request;
    const next = vi.fn();

    await middleware(req, {} as Response, next as NextFunction);

    expect(next).toHaveBeenCalledWith();
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });

  it("company not found → calls next with 403 (kind is undefined → not maintenance)", async () => {
    const db = buildDbForKind(undefined);
    const middleware = requireMaintenanceCompany(db);
    const req = makeReq("co-ghost-1");
    const next = vi.fn();

    await middleware(req, {} as Response, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
    const err = next.mock.calls[0][0] as { status: number };
    expect(err.status).toBe(403);
  });
});

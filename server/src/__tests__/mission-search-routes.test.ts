import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { missionSearchRoutes } from "../routes/mission-search.js";

/**
 * Focused regression for the agent-authenticated missionSearch route.
 * Covers the contract the live A1 test depends on:
 *   - agent-owned run + allowed workProduct scope => 200
 *   - repo scope not in allowedSearchScopes => 403
 *   - wrong agent => 403
 * Permissions are read from the run's contextSnapshot (the authoritative,
 * already-resolved object), so no execution-card DB walk is exercised here.
 */

interface RunRow {
  id: string;
  agentId: string;
  companyId: string;
  issueId: string;
  contextSnapshot: Record<string, unknown>;
}

function makeRunRow(allowedSearchScopes: string[], dependencyFiles: string[] = ["/repo/out/evidence.json"]): RunRow {
  return {
    id: "run-1",
    agentId: "agent-1",
    companyId: "company-1",
    issueId: "issue-1",
    contextSnapshot: {
      paperclipRuntimeSearchPaths: {
        version: 1,
        workingDirectory: "/repo",
        outputDirectory: "/repo/out",
        dependencyFiles,
        dependencyDirectories: ["/repo/out"],
        allowedSearchScopes,
      },
      paperclipWorkspace: { source: "project_primary", workspaceId: "ws-1", cwd: "/repo" },
    },
  };
}

function createApp(options: { actor?: Record<string, unknown>; runRow?: RunRow | null } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = (options.actor ?? {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      companyIds: ["company-1"],
      source: "api-key",
    }) as never;
    next();
  });

  const runRow = options.runRow === undefined ? makeRunRow(["workProduct", "missionOutput"]) : options.runRow;
  const query = {
    from: vi.fn(() => query),
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(() => Promise.resolve(runRow ? [runRow] : [])),
  };
  const db = { select: vi.fn(() => query) };

  app.use("/api", missionSearchRoutes(db as never));
  app.use(errorHandler);
  return app;
}

const runContext = { agentId: "agent-1", runId: "run-1", companyId: "company-1" };

describe("POST /api/agents/me/mission-search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 for an agent-owned run with an allowed workProduct scope", async () => {
    const res = await request(createApp())
      .post("/api/agents/me/mission-search")
      .send({ scope: "workProduct", query: "evidence", runContext });

    expect(res.status).toBe(200);
    expect(res.body.allowed).toBe(true);
    expect(res.body.scope).toBe("workProduct");
    expect(res.body.result.scope).toBe("workProduct");
    expect(res.body.result.files).toContain("/repo/out/evidence.json");
  });

  it("matches multiple declared workProducts via a space-separated query (OR)", async () => {
    // Regression: a query like "qa-rubric.md report.md" must not be treated as
    // a single phrase. Each declared filename matching ANY token is returned.
    const runRow = makeRunRow(
      ["workProduct", "missionOutput"],
      ["/repo/qa-rubric.md", "/repo/report.md", "/repo/unrelated.txt"],
    );
    const res = await request(createApp({ runRow }))
      .post("/api/agents/me/mission-search")
      .send({ scope: "workProduct", query: "qa-rubric.md report.md", runContext });

    expect(res.status).toBe(200);
    expect(res.body.result.files).toEqual(
      expect.arrayContaining(["/repo/qa-rubric.md", "/repo/report.md"]),
    );
    expect(res.body.result.files).not.toContain("/repo/unrelated.txt");
  });

  it("lists every workProduct when the query is empty (discovery)", async () => {
    const runRow = makeRunRow(
      ["workProduct"],
      ["/repo/a.md", "/repo/b.md"],
    );
    const res = await request(createApp({ runRow }))
      .post("/api/agents/me/mission-search")
      .send({ scope: "workProduct", query: "", runContext });

    expect(res.status).toBe(200);
    expect(res.body.result.files).toEqual(expect.arrayContaining(["/repo/a.md", "/repo/b.md"]));
  });

  it("returns 403 when repo is not in allowedSearchScopes", async () => {
    const res = await request(createApp())
      .post("/api/agents/me/mission-search")
      .send({ scope: "repo", query: "TODO", runContext });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("repo");
    expect(res.body.allowedScopes).toEqual(["workProduct", "missionOutput"]);
  });

  it("returns 403 when the caller is a different agent", async () => {
    const res = await request(
      createApp({
        actor: {
          type: "agent",
          agentId: "agent-2",
          companyId: "company-1",
          companyIds: ["company-1"],
          source: "api-key",
        },
      }),
    )
      .post("/api/agents/me/mission-search")
      .send({ scope: "workProduct", runContext });

    expect(res.status).toBe(403);
  });

  it("returns 404 when the run does not exist for the given context", async () => {
    const res = await request(createApp({ runRow: null }))
      .post("/api/agents/me/mission-search")
      .send({ scope: "workProduct", runContext });

    expect(res.status).toBe(404);
  });
});

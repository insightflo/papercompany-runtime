import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { executeHttpWorkflowTool } from "../services/workflow/http-tool-adapter.js";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import {
  agentToolGrants,
  agents,
  companies,
  createDb,
  missions,
  toolDefinitions,
  workflowDefinitions,
  workflowRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const ADAPTER_CONFIG = {
  url: "https://n8n.example.test/webhook/daily-tech-scout",
  method: "POST",
  timeoutMs: 120_000,
  auth: {
    type: "header",
    headerName: "X-Papercompany-Webhook-Key",
    secretId: "secret-1",
    version: "latest",
  },
  response: {
    resultField: "result",
    artifactField: "artifact",
    artifactFileName: "raw-tech-scout.json",
    artifactPathResultField: "rawPath",
  },
};

const RESULT = {
  ok: true,
  date: "2026-07-14",
  source: "https://trendshift.io/",
  collected_at: "2026-07-14T05:00:00.000Z",
  count: 1,
  repos: [{ rank: 1, full_name: "owner/repo", readme_excerpt: "short" }],
  nextAction: "Use rawPath for the report evidence.",
};

const ARTIFACT = {
  ok: true,
  date: "2026-07-14",
  source: "https://trendshift.io/",
  collected_at: "2026-07-14T05:00:00.000Z",
  count: 1,
  repos: [{ rank: 1, full_name: "owner/repo", readme_excerpt: "full readme" }],
};

const SECRET_VALUE = "test-webhook-secret";

function makeFetchResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

type FetchLike = typeof fetch;

function makeStepDir(): string {
  return mkdtempSync(join(tmpdir(), "http-tool-step-"));
}

describe("http workflow tool adapter artifacts", () => {
  const stepDirs: string[] = [];

  afterEach(() => {
    while (stepDirs.length) {
      const dir = stepDirs.pop()!;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  function deps(overrides: { fetchImpl?: FetchLike } = {}) {
    return {
      fetchImpl: (overrides.fetchImpl ?? vi.fn(async () => makeFetchResponse(200, { result: RESULT, artifact: ARTIFACT }))) as FetchLike,
      resolveSecretValue: vi.fn(async () => SECRET_VALUE) as unknown as (companyId: string, secretId: string, version: number | "latest") => Promise<string>,
    };
  }

  it("persists the raw artifact atomically and injects an absolute rawPath", async () => {
    const stepDir = makeStepDir();
    stepDirs.push(stepDir);
    const fetchImpl = vi.fn(async () => makeFetchResponse(200, { result: RESULT, artifact: ARTIFACT })) as unknown as FetchLike;

    const result = await executeHttpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "daily-tech-scout",
        parameters: { limit: 2 },
        requestId: "request-artifact",
        stepOutputDir: stepDir,
        adapterConfig: ADAPTER_CONFIG,
      },
      deps({ fetchImpl }),
    );

    expect(result.status).toBe(200);
    const rawPath = join(stepDir, "raw-tech-scout.json");
    expect(isAbsolute(rawPath)).toBe(true);
    expect(result.body.data).toEqual({ ...RESULT, rawPath });
    expect(JSON.parse(result.body.content ?? "")).toEqual(result.body.data);
    expect(existsSync(rawPath)).toBe(true);
    expect(JSON.parse(readFileSync(rawPath, "utf8"))).toEqual(ARTIFACT);
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  it("rejects a path-traversal artifact filename as invalid configuration", async () => {
    const result = await executeHttpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "daily-tech-scout",
        parameters: { limit: 1 },
        requestId: "request-1",
        stepOutputDir: makeStepDir(),
        adapterConfig: {
          ...ADAPTER_CONFIG,
          response: { ...ADAPTER_CONFIG.response, artifactFileName: "../escape.json" },
        },
      },
      deps(),
    );
    expect(result.status).toBe(422);
  });

  it("fails rather than dropping the artifact when no step output directory exists", async () => {
    const fetchImpl = vi.fn(async () => makeFetchResponse(200, { result: RESULT, artifact: ARTIFACT })) as unknown as FetchLike;
    const result = await executeHttpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "daily-tech-scout",
        parameters: { limit: 1 },
        requestId: "request-no-dir",
        stepOutputDir: null,
        adapterConfig: ADAPTER_CONFIG,
      },
      deps({ fetchImpl }),
    );
    expect(result.status).toBe(500);
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });
});

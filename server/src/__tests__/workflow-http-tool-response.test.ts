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

describe("http workflow tool adapter transport", () => {
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

  function defaultDeps(overrides: { fetchImpl?: FetchLike; resolveSecretValue?: (companyId: string, secretId: string, version: number | "latest") => Promise<string> } = {}) {
    return {
      fetchImpl: (overrides.fetchImpl ?? vi.fn(async () => makeFetchResponse(200, { result: RESULT, artifact: ARTIFACT }))) as FetchLike,
      resolveSecretValue: overrides.resolveSecretValue ?? (vi.fn(async () => SECRET_VALUE) as unknown as (companyId: string, secretId: string, version: number | "latest") => Promise<string>),
    };
  }
  it("strips the resolved secret from a remote diagnostic that echoes it back", async () => {
    const fetchImpl = vi.fn(async () => makeFetchResponse(500, `server saw header ${SECRET_VALUE} and rejected`)) as unknown as FetchLike;
    const result = await executeHttpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "daily-tech-scout",
        parameters: { limit: 1 },
        requestId: "request-leak",
        stepOutputDir: null,
        adapterConfig: ADAPTER_CONFIG,
      },
      defaultDeps({ fetchImpl }),
    );
    expect(result.status).toBe(500);
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  it("redacts a secret before truncating a remote diagnostic", async () => {
    const fetchImpl = vi.fn(async () => makeFetchResponse(
      500,
      `${"x".repeat(995)}${SECRET_VALUE} tail`,
    )) as unknown as FetchLike;
    const result = await executeHttpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "daily-tech-scout",
        parameters: {},
        requestId: "request-boundary",
        stepOutputDir: null,
        adapterConfig: ADAPTER_CONFIG,
      },
      defaultDeps({ fetchImpl }),
    );
    expect(result.status).toBe(500);
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE.slice(0, 5));
  });

  it("returns 500 with bounded diagnostics for a remote server error", async () => {
    const longBody = "x".repeat(5_000);
    const fetchImpl = vi.fn(async () => makeFetchResponse(500, longBody)) as unknown as FetchLike;
    const result = await executeHttpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "daily-tech-scout",
        parameters: { limit: 1 },
        requestId: "request-9",
        stepOutputDir: null,
        adapterConfig: ADAPTER_CONFIG,
      },
      defaultDeps({ fetchImpl }),
    );
    expect(result.status).toBe(500);
    const errorText = result.body.error ?? "";
    expect(errorText.length).toBeLessThanOrEqual(1_000 + 200);
    expect(errorText).not.toContain(SECRET_VALUE);
  });

  it("returns 500 for a request timeout without leaking the secret", async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    }) as unknown as FetchLike;
    const result = await executeHttpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "daily-tech-scout",
        parameters: { limit: 1 },
        requestId: "request-timeout",
        stepOutputDir: null,
        adapterConfig: ADAPTER_CONFIG,
      },
      defaultDeps({ fetchImpl }),
    );
    expect(result.status).toBe(500);
    expect(result.body.error ?? "").toContain("timed out");
    expect(result.body.error ?? "").toContain("request-timeout");
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  it("returns 500 for a non-JSON response", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/html" }),
      json: async () => {
        throw new Error("Unexpected token <");
      },
      text: async () => "<html>not json</html>",
    })) as unknown as FetchLike;
    const result = await executeHttpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "daily-tech-scout",
        parameters: { limit: 1 },
        requestId: "request-1",
        stepOutputDir: null,
        adapterConfig: ADAPTER_CONFIG,
      },
      defaultDeps({ fetchImpl }),
    );
    expect(result.status).toBe(500);
  });

  it("returns 500 when the response envelope is missing the result field", async () => {
    const fetchImpl = vi.fn(async () => makeFetchResponse(200, { artifact: ARTIFACT })) as unknown as FetchLike;
    const result = await executeHttpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "daily-tech-scout",
        parameters: { limit: 1 },
        requestId: "request-1",
        stepOutputDir: null,
        adapterConfig: ADAPTER_CONFIG,
      },
      defaultDeps({ fetchImpl }),
    );
    expect(result.status).toBe(500);
  });

  it("returns 500 when the response envelope is missing the artifact field", async () => {
    const fetchImpl = vi.fn(async () => makeFetchResponse(200, { result: RESULT })) as unknown as FetchLike;
    const result = await executeHttpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "daily-tech-scout",
        parameters: { limit: 1 },
        requestId: "request-1",
        stepOutputDir: null,
        adapterConfig: ADAPTER_CONFIG,
      },
      defaultDeps({ fetchImpl }),
    );
    expect(result.status).toBe(500);
  });
});

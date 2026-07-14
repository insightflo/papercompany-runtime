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

  it("posts the tool parameters with header auth and request id, returning the result", async () => {
    const fetchImpl = vi.fn(async () => makeFetchResponse(200, { result: RESULT, artifact: ARTIFACT })) as unknown as FetchLike;
    const stepDir = makeStepDir();
    stepDirs.push(stepDir);

    const result = await executeHttpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "daily-tech-scout",
        parameters: { limit: 25 },
        requestId: "request-123",
        stepOutputDir: stepDir,
        adapterConfig: ADAPTER_CONFIG,
      },
      defaultDeps({ fetchImpl }),
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      ADAPTER_CONFIG.url,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "Accept": "application/json",
          "X-Papercompany-Webhook-Key": SECRET_VALUE,
          "X-Papercompany-Request-Id": "request-123",
        }),
        body: JSON.stringify({ limit: 25 }),
      }),
    );
    expect(result.status).toBe(200);
    expect(result.body.data).toEqual({ ...RESULT, rawPath: expect.any(String) });
    expect(JSON.parse(result.body.content ?? "")).toEqual(result.body.data);
    expect(result.body.tool).toBe("daily-tech-scout");
    expect(result.body.source).toBe("core");
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  it("rejects a missing url with 422", async () => {
    const result = await executeHttpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "daily-tech-scout",
        parameters: { limit: 1 },
        requestId: "request-1",
        stepOutputDir: null,
        adapterConfig: { ...ADAPTER_CONFIG, url: "" },
      },
      defaultDeps(),
    );
    expect(result.status).toBe(422);
  });

  it("rejects a non-https url with 422", async () => {
    const result = await executeHttpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "daily-tech-scout",
        parameters: { limit: 1 },
        requestId: "request-1",
        stepOutputDir: null,
        adapterConfig: { ...ADAPTER_CONFIG, url: "http://insecure.example.test/webhook" },
      },
      defaultDeps(),
    );
    expect(result.status).toBe(422);
  });

  it("rejects a malformed https url with 422", async () => {
    const result = await executeHttpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "daily-tech-scout",
        parameters: {},
        requestId: "request-1",
        stepOutputDir: null,
        adapterConfig: { ...ADAPTER_CONFIG, url: "https://" },
      },
      defaultDeps(),
    );
    expect(result.status).toBe(422);
  });

  it("rejects a non-POST method with 422", async () => {
    const result = await executeHttpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "daily-tech-scout",
        parameters: { limit: 1 },
        requestId: "request-1",
        stepOutputDir: null,
        adapterConfig: { ...ADAPTER_CONFIG, method: "GET" },
      },
      defaultDeps(),
    );
    expect(result.status).toBe(422);
  });

  it("rejects an invalid header auth config with 422", async () => {
    const result = await executeHttpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "daily-tech-scout",
        parameters: { limit: 1 },
        requestId: "request-1",
        stepOutputDir: null,
        adapterConfig: { ...ADAPTER_CONFIG, auth: { type: "header", headerName: "X-Key", version: "latest" } },
      },
      defaultDeps(),
    );
    expect(result.status).toBe(422);
  });

  it("returns 403 without leaking the secret when the company secret cannot be resolved", async () => {
    const resolveSecretValue = vi.fn(async () => {
      throw new Error("Secret not found in company");
    });
    const result = await executeHttpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "daily-tech-scout",
        parameters: { limit: 1 },
        requestId: "request-1",
        stepOutputDir: null,
        adapterConfig: ADAPTER_CONFIG,
      },
      defaultDeps({ resolveSecretValue: resolveSecretValue as never }),
    );
    expect(result.status).toBe(403);
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  it("returns 403 and omits the remote body for an authenticated rejection", async () => {
    const fetchImpl = vi.fn(async () => makeFetchResponse(401, { error: "bad header " + SECRET_VALUE })) as unknown as FetchLike;
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
    expect(result.status).toBe(403);
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(result)).not.toContain("bad header");
  });

});

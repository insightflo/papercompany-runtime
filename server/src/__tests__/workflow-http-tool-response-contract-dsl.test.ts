/**
 * [purpose] Slice-3 (A+C): the assertion DSL extension — kind "boolean" and dotted-path
 *   field access — makes the ACTUAL collect-tech-blog-posts response contract
 *   expressible: [{ok equals true},{noNewPosts boolean},{stateToken.version equals 1}].
 *   Part C pins the exact production §5.1 shape: success envelope passes with artifact
 *   passthrough + server-inserted rawPath; the ok:false failure envelope is rejected.
 *   Non-regression: the existing kinds (equals/positiveNumber/existingFile) keep working.
 * [red] Today these configs are rejected at CONFIG level (422 invalid response
 *   configuration) or violate on flat-field lookup — all expectation-bearing tests fail.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeHttpWorkflowTool } from "../services/workflow/http-tool-adapter.js";

const SECRET_VALUE = "test-webhook-secret";
const stepDirs: string[] = [];
afterEach(() => {
  while (stepDirs.length) {
    const dir = stepDirs.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

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
  const dir = mkdtempSync(join(tmpdir(), "http-tool-dsl-"));
  stepDirs.push(dir);
  return dir;
}

function depsFor(body: Record<string, unknown>) {
  const fetchImpl = vi.fn(async () => makeFetchResponse(200, body)) as unknown as FetchLike;
  return {
    fetchImpl,
    resolveSecretValue: vi.fn(async () => SECRET_VALUE) as unknown as (
      companyId: string, secretId: string, version: number | "latest",
    ) => Promise<string>,
  };
}

function collectConfig(): Record<string, unknown> {
  // Exact production response contract of tool_definitions row collect-tech-blog-posts
  // (company ff3e3efd…): resultField/artifactField BOTH "result" (the result object is
  // the artifact), artifactFileName tech-blog-collect.json, artifactPathResultField rawPath.
  return {
    url: "https://n8n.example.test/webhook/papercompany/tech-blog-collect",
    method: "POST",
    timeoutMs: 300_000,
    auth: {
      type: "header",
      headerName: "X-Papercompany-Webhook-Key",
      secretId: "secret-1",
      version: "latest",
    },
    response: {
      resultField: "result",
      artifactField: "result",
      artifactFileName: "tech-blog-collect.json",
      artifactPathResultField: "rawPath",
    },
  };
}

const COLLECT_ASSERTIONS = [
  { field: "ok", equals: true },
  { field: "noNewPosts", type: "boolean" },
  { field: "stateToken.version", equals: 1 },
];

const COLLECT_RESULT = {
  ok: true,
  collectedAt: "2026-09-13T05:00:00.000Z",
  sourcesChecked: 17,
  noNewPosts: false,
  candidateCount: 2,
  rejectedByCap: 0,
  posts: [{ postId: "naver-d2::x", sourceKey: "naver-d2", title: "t", url: "https://x.test", text: "본문", lang: "ko" }],
  stateToken: { version: 1, watermarks: { "naver-d2": "w1" }, processedIds: ["naver-d2::x"] },
};

async function runCollect(resultBody: Record<string, unknown>, assertions: unknown = COLLECT_ASSERTIONS) {
  const stepDir = makeStepDir();
  return {
    stepDir,
    result: await executeHttpWorkflowTool(
      {
        companyId: "company-1",
        toolName: "collect-tech-blog-posts",
        parameters: {},
        requestId: "req-dsl",
        stepOutputDir: stepDir,
        adapterConfig: { ...collectConfig(), response: { ...(collectConfig().response as object), assertions } },
      },
      depsFor({ result: resultBody }),
    ),
  };
}

describe("assertion DSL: boolean kind + dotted paths (collect-tech-blog-posts contract)", () => {
  it("accepts the §5.1 success envelope, persists the artifact, and inserts rawPath", async () => {
    const { stepDir, result } = await runCollect(COLLECT_RESULT);
    expect(result.status).toBe(200);
    const artifactPath = join(stepDir, "tech-blog-collect.json");
    expect(existsSync(artifactPath)).toBe(true);
    expect(JSON.parse(readFileSync(artifactPath, "utf8"))).toEqual(COLLECT_RESULT);
    expect((result.body.data as Record<string, unknown>).rawPath).toBe(artifactPath);
    expect((result.body.data as Record<string, unknown>).noNewPosts).toBe(false);
  });

  it("rejects a wrong-typed noNewPosts (string) with a contract violation (500), not config 422", async () => {
    const { result } = await runCollect({ ...COLLECT_RESULT, noNewPosts: "false" });
    expect(result.status).toBe(500);
    expect(result.body.error).toMatch(/noNewPosts.*boolean|boolean.*noNewPosts/);
  });

  it("rejects a wrong stateToken.version (dotted equals 2) with a contract violation", async () => {
    const { result } = await runCollect({ ...COLLECT_RESULT, stateToken: { ...COLLECT_RESULT.stateToken, version: 2 } });
    expect(result.status).toBe(500);
    expect(result.body.error).toMatch(/stateToken\.version/);
  });

  it("rejects a missing stateToken (dotted path absent) with a contract violation", async () => {
    const { result } = await runCollect({ ok: true, noNewPosts: true });
    expect(result.status).toBe(500);
    expect(result.body.error).toMatch(/stateToken\.version/);
  });

  it("rejects the ok:false failure envelope (equals true violated)", async () => {
    const { result } = await runCollect({ ok: false, error: { stage: "collect", message: "source down" } });
    expect(result.status).toBe(500);
    expect(result.body.error).toMatch(/ok/);
  });

  it("non-regression: existing kinds (equals/positiveNumber/existingFile) still enforce", async () => {
    const stepDir = makeStepDir();
    const staged = join(stepDir, "video.mp4");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(staged, "x".repeat(16));
    const config = {
      url: "https://n8n.example.test/webhook/papercompany/stage-youtube-video",
      method: "POST",
      auth: { type: "header", headerName: "X-Papercompany-Webhook-Key", secretId: "secret-1", version: "latest" },
      response: {
        resultField: "result",
        artifactField: "artifact",
        artifactFileName: "youtube-video-staging.json",
        artifactPathResultField: "rawPath",
        assertions: [
          { field: "ok", equals: true },
          { field: "bytes", type: "positiveNumber" },
          { field: "stagedPath", type: "existingFile" },
        ],
      },
    };
    const deps = depsFor({ result: { ok: true, bytes: 16, stagedPath: staged }, artifact: { raw: true } });
    const pass = await executeHttpWorkflowTool(
      { companyId: "company-1", toolName: "stage-youtube-video", parameters: {}, requestId: "req-nr",
        stepOutputDir: stepDir, adapterConfig: config }, deps);
    expect(pass.status).toBe(200);
    const fail = await executeHttpWorkflowTool(
      { companyId: "company-1", toolName: "stage-youtube-video", parameters: {}, requestId: "req-nr2",
        stepOutputDir: stepDir, adapterConfig: config },
      depsFor({ result: { ok: true, bytes: null, stagedPath: staged }, artifact: { raw: true } }));
    expect(fail.status).toBe(500);
  });
});

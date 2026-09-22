import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { executeHtmlPreflightTool } from "../services/judgment/html-preflight-executor.js";

const outputDirs: string[] = [];

async function newOutputDir() {
  const dir = await mkdtemp(join(tmpdir(), "html-preflight-"));
  outputDirs.push(dir);
  return dir;
}

// 운영 레이아웃(.../runs/<runId>/steps/<stepId>)과 동일한 중첩 구조 — 루트 퇴화 없이 포함 관계 검증 가능.
async function newStepOutputDir() {
  const runRoot = await newOutputDir();
  const stepOutputDir = join(runRoot, "runs", "run-1", "steps", "step-1");
  await mkdir(stepOutputDir, { recursive: true });
  return { runRoot, stepOutputDir };
}

afterEach(async () => {
  await Promise.all(outputDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function execute(parameters: unknown, context: { workflowRunId?: string | null; stepId?: string | null; stepOutputDir?: string | null } = {}) {
  return executeHtmlPreflightTool({
    db: {} as Db,
    companyId: randomUUID(),
    toolName: "html-preflight",
    parameters,
    requestId: randomUUID(),
    workflowRunId: context.workflowRunId ?? null,
    stepRunId: context.workflowRunId ? randomUUID() : null,
    stepId: context.stepId ?? null,
    stepOutputDir: context.stepOutputDir ?? null,
  });
}

describe("html-preflight core workflow tool executor", () => {
  it("persists a durable structured result and returns it in the step body", async () => {
    const stepOutputDir = await newOutputDir();
    const result = await execute(
      { document: "<!doctype html><html><body><p>Hello structural preflight</p></body></html>" },
      { workflowRunId: randomUUID(), stepId: "preflight", stepOutputDir },
    );

    expect(result.status).toBe(200);
    expect(result.artifactPath).toBe(join(stepOutputDir, "html-preflight-result.json"));
    expect(result.body.tool).toBe("html-preflight");
    expect(result.body.source).toBe("core");
    expect(result.body.data).toMatchObject({
      ok: true,
      findings: [],
      stats: { docChars: 74, textChars: 24, nodeCount: expect.any(Number) },
      artifactPath: join(stepOutputDir, "html-preflight-result.json"),
    });
    await expect(readFile(result.artifactPath!, "utf8")).resolves.toContain("\"ok\":true");
  });

  it("reads a workflow-bound document path and persists the same structured contract", async () => {
    const { runRoot, stepOutputDir } = await newStepOutputDir();
    const documentPath = join(stepOutputDir, "index.html");
    await writeFile(documentPath, "<html><body>  </body></html>", "utf8");
    const result = await execute(
      { documentPath },
      { workflowRunId: randomUUID(), stepId: "preflight", stepOutputDir },
    );

    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({
      ok: false,
      findings: ["near_empty_text_content: visibleTextChars=0 (<20)"],
      stats: { docChars: 28, textChars: 0, nodeCount: expect.any(Number) },
    });
    const artifact = JSON.parse(await readFile(result.artifactPath!, "utf8")) as Record<string, unknown>;
    expect(artifact.ok).toBe(false);
    expect(artifact.scope).toContain("not an HTML validator");
  });

  it("returns a structured defect instead of throwing for odd inline input", async () => {
    const result = await execute({ document: 42 });

    expect(result.status).toBe(200);
    expect(result.body.data).toEqual({
      ok: false,
      findings: ["input_type_mismatch: document must be a string"],
      stats: { docChars: 0, textChars: 0, nodeCount: 0 },
      scope: expect.stringContaining("not an HTML validator"),
    });
    expect(result.artifactPath).toBeUndefined();
  });

  it("does not read documentPath outside workflow step context", async () => {
    const result = await execute({ documentPath: "/etc/hosts" });

    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({
      ok: false,
      findings: ["document_path_requires_workflow_context"],
    });
  });

  it("rejects documentPath that escapes the workflow run root", async () => {
    const { runRoot, stepOutputDir } = await newStepOutputDir();
    const outsidePath = join(runRoot, "outside-secret.txt");
    await writeFile(outsidePath, "<html><body>must not be read</body></html>", "utf8");
    const result = await execute(
      { documentPath: outsidePath },
      { workflowRunId: randomUUID(), stepId: "preflight", stepOutputDir },
    );

    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({
      ok: false,
      findings: ["document_path_outside_run_root"],
    });
    expect(await readFile(result.artifactPath!, "utf8")).toContain("document_path_outside_run_root");
  });

  it("refuses documentPath when the run root degenerates to the filesystem root", async () => {
    const stepOutputDir = await newOutputDir();
    const result = await execute(
      { documentPath: "/etc/hosts" },
      { workflowRunId: randomUUID(), stepId: "preflight", stepOutputDir },
    );

    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({
      ok: false,
      findings: ["document_path_outside_run_root"],
    });
  });

  it("rejects oversized inline documents with a structured finding", async () => {
    const result = await execute({ document: "<html><body>" + "x".repeat(2_000_001) + "</body></html>" });

    expect(result.status).toBe(200);
    expect(result.body.data.findings[0]).toContain("document_too_large");
    expect(result.body.data.ok).toBe(false);
  });
});

/**
 * [purpose] Write-time artifact-path validation for completeWorkflowToolStepFromResult:
 *   a completion that carries a non-empty artifact-path candidate (artifactPath,
 *   data.rawPath, data.artifactPath) which is NOT absolute must be REJECTED with a
 *   structured error before any metadata write — never silently stored (the canonical
 *   reader drops relative paths today, while data.rawPath keeps them and the issue-less
 *   IF fallback later resolves them against the server cwd = wrong-file risk).
 * [controls] Absolute candidates and path-free completions keep today's accepted behavior.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies, createDb, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { setupWorkflow } from "./helpers/workflow-step-retry-fixtures.js";
import {
  completeWorkflowToolStepFromResult,
  setWorkflowToolStepExecutor,
  syncWorkflowRunState,
} from "../services/workflow/dag-engine.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip relative-artifact tests: ${support.reason ?? "unsupported"}`);

describeEP("completeWorkflowToolStepFromResult rejects relative artifact paths", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("artifact-guard-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `ArtifactGuardCo-${randomUUID().slice(0, 6)}`, status: "active" });
  }, 60_000);

  afterEach(async () => {
    setWorkflowToolStepExecutor(null);
    await db.delete(workflowTransitionEvents);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
  });
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  async function dispatchToolStep(): Promise<{ runId: string; stepRunId: string; requestId: string }> {
    const stepId = `tool-${randomUUID().slice(0, 6)}`;
    const { runId } = await setupWorkflow(db, companyId, [
      { id: stepId, type: "tool", toolNames: ["t"] },
    ]);
    setWorkflowToolStepExecutor(() => Promise.resolve({ accepted: true }));
    await syncWorkflowRunState(db, runId);
    const [stepRun] = await db.select().from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.workflowRunId, runId), eq(workflowStepRuns.stepId, stepId)));
    expect(stepRun?.lastDispatchRequestId).toBeTypeOf("string");
    return { runId, stepRunId: stepRun.id, requestId: stepRun.lastDispatchRequestId! };
  }

  async function readToolResult(stepRunId: string): Promise<Record<string, unknown> | null | undefined> {
    const [row] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    const metadata = row?.metadata as Record<string, unknown> | null | undefined;
    return (metadata?.toolResult as Record<string, unknown> | undefined) ?? null;
  }

  it("rejects a completion whose artifactPath input is relative (no write)", async () => {
    const { stepRunId, requestId } = await dispatchToolStep();
    await expect(completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId, requestId, success: true,
      artifactPath: "relative/dir/tech-blog-collect.json",
    })).rejects.toThrow(/artifact path is not absolute/);
    expect(await readToolResult(stepRunId)).toBeNull();
  });

  it("rejects a completion whose data.rawPath is relative (no write)", async () => {
    const { stepRunId, requestId } = await dispatchToolStep();
    await expect(completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId, requestId, success: true,
      data: { ok: true, rawPath: "relative/raw.json" },
    })).rejects.toThrow(/artifact path is not absolute/);
    expect(await readToolResult(stepRunId)).toBeNull();
  });

  it("rejects a completion whose data.artifactPath is relative (no write)", async () => {
    const { stepRunId, requestId } = await dispatchToolStep();
    await expect(completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId, requestId, success: true,
      data: { artifactPath: "out/other.json" },
    })).rejects.toThrow(/artifact path is not absolute/);
    expect(await readToolResult(stepRunId)).toBeNull();
  });

  it("still accepts an absolute artifactPath and stores the canonicalized form", async () => {
    const { stepRunId, requestId } = await dispatchToolStep();
    const result = await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId, requestId, success: true,
      artifactPath: "/tmp/absolute/dir/tech-blog-collect.json",
    });
    expect(result?.status).toBe("completed");
    const toolResult = await readToolResult(stepRunId);
    expect(toolResult?.artifactPath).toBe("/tmp/absolute/dir/tech-blog-collect.json");
    expect(toolResult?.success).toBe(true);
  });

  it("still accepts a completion with no path fields at all", async () => {
    const { stepRunId, requestId } = await dispatchToolStep();
    const result = await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId, requestId, success: true, stdout: "done",
    });
    expect(result?.status).toBe("completed");
    const toolResult = await readToolResult(stepRunId);
    expect(toolResult).not.toBeNull();
    expect("artifactPath" in (toolResult as Record<string, unknown>)).toBe(false);
  });
});

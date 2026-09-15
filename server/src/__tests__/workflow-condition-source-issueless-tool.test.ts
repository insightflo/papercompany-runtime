/**
 * [purpose] Regression coverage for the A1-preserved issue-less tool-step
 *   artifact fallback in selectAttemptWorkProduct: completed workflow tool steps
 *   without an issue store their machine-produced artifact path in step-run
 *   metadata (toolResult.artifactPath / toolResult.data.rawPath) and IF
 *   conditions must resolve them, while wrong-scope or absent paths stay
 *   fail-closed. The legacy issue-backed selection flow is guarded too.
 * [provenance] Paths read here are written only by the workflow tool runtime
 *   (completeWorkflowToolStepFromResult) — structured machine records, never
 *   agent prose. Run/company ownership is enforced upstream by the attempt
 *   SELECT (workflowRuns.id + companyId); see callers-trace evidence.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import {
  createProducerStep,
  createResolverRun,
  RESOLVER_TOPOLOGY,
  sourceOf,
  startResolverFixture,
  TempFileRegistry,
  attachWorkProduct,
  type ResolverFixture,
} from "./helpers/workflow-if-source-resolver-fixture.js";
import {
  resolveWorkflowConditionSources,
  workflowConditionSourceKey,
} from "../services/workflow/control-flow/condition-source-resolver.js";
import { workflowStepRuns } from "@paperclipai/db";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const ERR_PREFIX = "Workflow IF condition failed:";

/** Issue-less completed tool step carrying a machine toolResult in metadata. */
async function insertIssuelessToolStep(
  fixture: ResolverFixture,
  opts: { runId: string; stepId?: string; metadata: Record<string, unknown>; completedAt?: Date },
): Promise<void> {
  const startedAt = opts.completedAt ?? new Date();
  await fixture.db.insert(workflowStepRuns).values({
    workflowRunId: opts.runId,
    stepId: opts.stepId ?? "producer",
    issueId: null,
    status: "completed",
    startedAt,
    completedAt: opts.completedAt ?? startedAt,
    metadata: opts.metadata,
  });
}

describeEmbeddedPostgres("workflow condition source: issue-less tool-step artifacts", () => {
  let fixture!: ResolverFixture;
  let tmp!: TempFileRegistry;

  beforeAll(async () => {
    fixture = await startResolverFixture();
    tmp = new TempFileRegistry();
  }, 60_000);
  afterAll(async () => {
    tmp.cleanup();
    await fixture.cleanup();
  });
  afterEach(() => {
    tmp.cleanup();
    tmp = new TempFileRegistry();
  });

  function resolve(runId: string, sources: ReturnType<typeof sourceOf>[]) {
    return resolveWorkflowConditionSources({
      db: fixture.db,
      run: { id: runId, companyId: fixture.companyId },
      ifStep: { id: "if-1", dependencies: ["validator"] },
      workflowSteps: RESOLVER_TOPOLOGY,
      sources,
    });
  }

  it("resolves an issue-less tool step via toolResult.artifactPath", async () => {
    const runId = await createResolverRun(fixture);
    const artifact = tmp.tmp("topic-decision.json", JSON.stringify({ status: "selected" }));
    await insertIssuelessToolStep(fixture, {
      runId,
      metadata: { toolResult: { success: true, artifactPath: artifact, completedAt: new Date().toISOString() } },
    });
    const map = await resolve(runId, [sourceOf("producer")]);
    expect(map.get(workflowConditionSourceKey(sourceOf("producer")))).toEqual({ status: "selected" });
  });

  it("resolves an issue-less tool step via toolResult.data.rawPath fallback", async () => {
    const runId = await createResolverRun(fixture);
    const artifact = tmp.tmp("topic-decision.json", JSON.stringify({ status: "raw" }));
    await insertIssuelessToolStep(fixture, {
      runId,
      metadata: { toolResult: { success: true, data: { rawPath: artifact } } },
    });
    const map = await resolve(runId, [sourceOf("producer")]);
    expect(map.get(workflowConditionSourceKey(sourceOf("producer")))).toEqual({ status: "raw" });
  });

  it("resolves an issue-less tool step via top-level metadata.artifactPath (legacy shape)", async () => {
    const runId = await createResolverRun(fixture);
    const artifact = tmp.tmp("topic-decision.json", JSON.stringify({ status: "legacy-top" }));
    await insertIssuelessToolStep(fixture, { runId, metadata: { artifactPath: artifact } });
    const map = await resolve(runId, [sourceOf("producer")]);
    expect(map.get(workflowConditionSourceKey(sourceOf("producer")))).toEqual({ status: "legacy-top" });
  });

  it("fails closed when the artifact path does not end with the requested title (wrong scope)", async () => {
    const runId = await createResolverRun(fixture);
    const other = tmp.tmp("some-other-artifact.json", JSON.stringify({ status: "nope" }));
    await insertIssuelessToolStep(fixture, {
      runId,
      metadata: { toolResult: { success: true, artifactPath: other } },
    });
    await expect(resolve(runId, [sourceOf("producer")])).rejects.toThrow(ERR_PREFIX);
  });

  it("fails closed when an issue-less step has no artifact path in metadata", async () => {
    const runId = await createResolverRun(fixture);
    await insertIssuelessToolStep(fixture, { runId, metadata: { toolResult: { success: true } } });
    await expect(resolve(runId, [sourceOf("producer")])).rejects.toThrow(ERR_PREFIX);
  });

  it("does not read an issue-less artifact from a different workflow run", async () => {
    const otherRunId = await createResolverRun(fixture);
    const runId = await createResolverRun(fixture);
    const artifact = tmp.tmp("topic-decision.json", JSON.stringify({ status: "other-run" }));
    await insertIssuelessToolStep(fixture, {
      runId: otherRunId,
      stepId: "producer",
      metadata: { toolResult: { success: true, artifactPath: artifact } },
    });
    await expect(resolve(runId, [sourceOf("producer")])).rejects.toThrow(ERR_PREFIX);
  });

  it("keeps the legacy issue-backed selection flow working", async () => {
    const runId = await createResolverRun(fixture);
    const issueId = await createProducerStep(fixture, { runId, stepId: "producer" });
    await attachWorkProduct(fixture, tmp, { issueId, title: "topic-decision.json", content: JSON.stringify({ status: "issue-backed" }) });
    const map = await resolve(runId, [sourceOf("producer")]);
    expect(map.get(workflowConditionSourceKey(sourceOf("producer")))).toEqual({ status: "issue-backed" });
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
} from "./helpers/embedded-postgres.js";
import {
  attachWorkProduct,
  createFixtureCompany,
  createProducerStep,
  createResolverRun,
  RESOLVER_TOPOLOGY,
  sourceOf,
  startResolverFixture,
  TempFileRegistry,
  type ResolverFixture,
} from "./helpers/workflow-if-source-resolver-fixture.js";
import {
  resolveWorkflowConditionSources,
  workflowConditionSourceKey,
} from "../services/workflow/control-flow/condition-source-resolver.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const ERR_PREFIX = "Workflow IF condition failed:";

describeEmbeddedPostgres("workflow condition source resolver", () => {
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

  async function producerRun(stepId = "producer", startedAt?: Date): Promise<{ runId: string; issueId: string }> {
    const runId = await createResolverRun(fixture);
    const issueId = await createProducerStep(fixture, { runId, stepId, startedAt });
    return { runId, issueId };
  }

  it("resolves an ancestor producer work product and returns parsed JSON", async () => {
    const { runId, issueId } = await producerRun();
    await attachWorkProduct(fixture, tmp, { issueId, title: "topic-decision.json", content: JSON.stringify({ status: "selected" }) });
    const map = await resolve(runId, [sourceOf("producer")]);
    expect(map.get(workflowConditionSourceKey(sourceOf("producer")))).toEqual({ status: "selected" });
  });

  it("rejects a source step that is not a forward ancestor", async () => {
    const { runId, issueId } = await producerRun("unrelated");
    await attachWorkProduct(fixture, tmp, { issueId, title: "topic-decision.json", content: "{}" });
    await expect(resolve(runId, [sourceOf("unrelated")])).rejects.toThrow(ERR_PREFIX);
  });

  it("does not match work products from a different run", async () => {
    const runId = await createResolverRun(fixture);
    const other = await producerRun();
    await attachWorkProduct(fixture, tmp, { issueId: other.issueId, title: "topic-decision.json", content: "{}" });
    await expect(resolve(runId, [sourceOf("producer")])).rejects.toThrow(ERR_PREFIX);
  });

  it("does not match work products from a different company", async () => {
    const { runId, issueId } = await producerRun();
    const otherCompany = "11111111-1111-4111-8111-111111111111";
    await createFixtureCompany(fixture, { id: otherCompany, name: "Other Co" });
    await attachWorkProduct(fixture, tmp, { issueId, title: "topic-decision.json", content: "{}", companyId: otherCompany });
    await expect(resolve(runId, [sourceOf("producer")])).rejects.toThrow(ERR_PREFIX);
  });

  it("ignores archived products", async () => {
    const { runId, issueId } = await producerRun();
    await attachWorkProduct(fixture, tmp, { issueId, title: "topic-decision.json", content: "{}", status: "archived" });
    await expect(resolve(runId, [sourceOf("producer")])).rejects.toThrow(ERR_PREFIX);
  });

  it("requires the exact configured work-product title", async () => {
    const { runId, issueId } = await producerRun();
    await attachWorkProduct(fixture, tmp, { issueId, title: "other.json", content: "{}" });
    await expect(resolve(runId, [sourceOf("producer")])).rejects.toThrow(ERR_PREFIX);
  });

  it("ignores non-local providers without an absolute local path", async () => {
    const { runId, issueId } = await producerRun();
    await attachWorkProduct(fixture, tmp, { issueId, title: "topic-decision.json", content: "{}", provider: "s3" });
    await expect(resolve(runId, [sourceOf("producer")])).rejects.toThrow(ERR_PREFIX);
  });

  it("prefers a primary candidate over a non-primary one", async () => {
    const { runId, issueId } = await producerRun();
    await attachWorkProduct(fixture, tmp, { issueId, title: "topic-decision.json", content: JSON.stringify({ status: "non-primary" }) });
    await attachWorkProduct(fixture, tmp, { issueId, title: "topic-decision.json", content: JSON.stringify({ status: "primary" }), isPrimary: true });
    const map = await resolve(runId, [sourceOf("producer")]);
    expect(map.get(workflowConditionSourceKey(sourceOf("producer")))).toEqual({ status: "primary" });
  });

  it("among same-primary candidates the newer updatedAt wins", async () => {
    const startedAt = new Date("2026-07-20T10:00:00Z");
    const { runId, issueId } = await producerRun("producer", startedAt);
    await attachWorkProduct(fixture, tmp, { issueId, title: "topic-decision.json", content: JSON.stringify({ status: "older" }), updatedAt: new Date("2026-07-20T10:15:00Z") });
    await attachWorkProduct(fixture, tmp, { issueId, title: "topic-decision.json", content: JSON.stringify({ status: "newer" }), updatedAt: new Date("2026-07-20T10:45:00Z") });
    const map = await resolve(runId, [sourceOf("producer")]);
    expect(map.get(workflowConditionSourceKey(sourceOf("producer")))).toEqual({ status: "newer" });
  });

  it("rejects ambiguity when two candidates share isPrimary and updatedAt (equal rank)", async () => {
    const startedAt = new Date("2026-07-20T10:00:00Z");
    const sameTime = new Date("2026-07-20T10:30:00Z");
    const { runId, issueId } = await producerRun("producer", startedAt);
    await attachWorkProduct(fixture, tmp, { issueId, title: "topic-decision.json", content: JSON.stringify({ status: "a" }), updatedAt: sameTime });
    await attachWorkProduct(fixture, tmp, { issueId, title: "topic-decision.json", content: JSON.stringify({ status: "b" }), updatedAt: sameTime });
    await expect(resolve(runId, [sourceOf("producer")])).rejects.toThrow(ERR_PREFIX);
  });

  it("ignores stale prior-attempt artifacts and picks the current one", async () => {
    const startedAt = new Date("2026-07-20T10:00:00Z");
    const { runId, issueId } = await producerRun("producer", startedAt);
    await attachWorkProduct(fixture, tmp, { issueId, title: "topic-decision.json", content: JSON.stringify({ status: "stale" }), updatedAt: new Date("2026-07-20T09:00:00Z") });
    await attachWorkProduct(fixture, tmp, { issueId, title: "topic-decision.json", content: JSON.stringify({ status: "current" }), updatedAt: new Date("2026-07-20T10:30:00Z") });
    const map = await resolve(runId, [sourceOf("producer")]);
    expect(map.get(workflowConditionSourceKey(sourceOf("producer")))).toEqual({ status: "current" });
  });

  it("rejects when only stale prior-attempt artifacts exist", async () => {
    const startedAt = new Date("2026-07-20T10:00:00Z");
    const { runId, issueId } = await producerRun("producer", startedAt);
    await attachWorkProduct(fixture, tmp, { issueId, title: "topic-decision.json", content: "{}", updatedAt: new Date("2026-07-20T09:00:00Z") });
    await expect(resolve(runId, [sourceOf("producer")])).rejects.toThrow(ERR_PREFIX);
  });
  it("fails closed when the completed producer has no attempt startedAt", async () => {
    const { runId, issueId } = await producerRun("producer", null);
    await attachWorkProduct(fixture, tmp, { issueId, title: "topic-decision.json", content: JSON.stringify({ status: "selected" }) });
    await expect(resolve(runId, [sourceOf("producer")])).rejects.toThrow(ERR_PREFIX);
  });

  it("rejects a file at or larger than 1 MiB before parsing (bounded read cap)", async () => {
    const { runId, issueId } = await producerRun();
    const big = "{\"" + "x".repeat(64) + "\":" + " ".repeat(1024 * 1024) + "}";
    await attachWorkProduct(fixture, tmp, { issueId, title: "topic-decision.json", content: big });
    await expect(resolve(runId, [sourceOf("producer")])).rejects.toThrow(ERR_PREFIX);
  });

  it("rejects invalid JSON", async () => {
    const { runId, issueId } = await producerRun();
    await attachWorkProduct(fixture, tmp, { issueId, title: "topic-decision.json", content: "{not json" });
    await expect(resolve(runId, [sourceOf("producer")])).rejects.toThrow(ERR_PREFIX);
  });

  it("rejects invalid UTF-8 content (fatal decoder)", async () => {
    const { runId, issueId } = await producerRun();
    await attachWorkProduct(fixture, tmp, { issueId, title: "topic-decision.json", content: Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d]) });
    await expect(resolve(runId, [sourceOf("producer")])).rejects.toThrow(ERR_PREFIX);
  });

  it("rejects a missing file path", async () => {
    const { runId, issueId } = await producerRun();
    await attachWorkProduct(fixture, tmp, { issueId, title: "topic-decision.json", filePath: "/definitely/does/not/exist/topic-decision.json" });
    await expect(resolve(runId, [sourceOf("producer")])).rejects.toThrow(ERR_PREFIX);
  });

  it("does not log raw work-product content on failure", async () => {
    const { runId, issueId } = await producerRun();
    const secret = "SUPER-SECRET-TOKEN";
    await attachWorkProduct(fixture, tmp, { issueId, title: "topic-decision.json", content: "{not json " + secret });
    let message = "";
    try {
      await resolve(runId, [sourceOf("producer")]);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message.startsWith(ERR_PREFIX)).toBe(true);
    expect(message).not.toContain(secret);
  });
});

describeEmbeddedPostgres("workflow condition source resolver — tool_json sources", () => {
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

  const toolSource = (overrides: Partial<{ kind: "tool_json"; stepId: string; toolName: string; parameters: Record<string, unknown>; path: string }> = {}) => ({
    kind: "tool_json" as const,
    stepId: "producer",
    toolName: "shorts-storage-list",
    parameters: { action: "list", prefix: "shorts/runs/r1/clips/" },
    path: "$.count",
    ...overrides,
  });

  async function producerRun(): Promise<{ runId: string; issueId: string }> {
    const runId = await createResolverRun(fixture);
    const issueId = await createProducerStep(fixture, { runId, stepId: "producer" });
    return { runId, issueId };
  }

  it("resolves a tool_json source through the injected executor", async () => {
    const { runId } = await producerRun();
    const executor = vi.fn().mockResolvedValue({ count: 22, total_bytes: 123456 });
    const map = await resolveWorkflowConditionSources({
      db: fixture.db,
      run: { id: runId, companyId: fixture.companyId },
      ifStep: { id: "if-1", dependencies: ["validator"] },
      workflowSteps: RESOLVER_TOPOLOGY,
      sources: [toolSource()],
      resolveToolJsonSource: executor,
    });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0]![0].toolName).toBe("shorts-storage-list");
    expect(map.get(workflowConditionSourceKey(toolSource()))).toEqual({ count: 22, total_bytes: 123456 });
  });

  it("rejects a tool source whose stepId is not a forward ancestor", async () => {
    const { runId } = await producerRun();
    const executor = vi.fn().mockResolvedValue({ count: 1 });
    await expect(resolveWorkflowConditionSources({
      db: fixture.db,
      run: { id: runId, companyId: fixture.companyId },
      ifStep: { id: "if-1", dependencies: ["validator"] },
      workflowSteps: RESOLVER_TOPOLOGY,
      sources: [toolSource({ stepId: "unrelated" })],
      resolveToolJsonSource: executor,
    })).rejects.toThrow(ERR_PREFIX);
    expect(executor).not.toHaveBeenCalled();
  });

  it("fails closed when no tool executor is injected", async () => {
    const { runId } = await producerRun();
    await expect(resolveWorkflowConditionSources({
      db: fixture.db,
      run: { id: runId, companyId: fixture.companyId },
      ifStep: { id: "if-1", dependencies: ["validator"] },
      workflowSteps: RESOLVER_TOPOLOGY,
      sources: [toolSource()],
    })).rejects.toThrow(ERR_PREFIX);
  });

  it("deduplicates equal tool sources into a single executor call", async () => {
    const { runId } = await producerRun();
    const executor = vi.fn().mockResolvedValue({ count: 5 });
    const map = await resolveWorkflowConditionSources({
      db: fixture.db,
      run: { id: runId, companyId: fixture.companyId },
      ifStep: { id: "if-1", dependencies: ["validator"] },
      workflowSteps: RESOLVER_TOPOLOGY,
      sources: [toolSource(), toolSource({ path: "$.total_bytes" })],
      resolveToolJsonSource: executor,
    });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(map.get(workflowConditionSourceKey(toolSource()))).toEqual({ count: 5 });
    expect(map.get(workflowConditionSourceKey(toolSource({ path: "$.total_bytes" })))).toEqual({ count: 5 });
  });

  it("treats distinct parameters as distinct tool calls", async () => {
    const { runId } = await producerRun();
    const executor = vi.fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 2 });
    const map = await resolveWorkflowConditionSources({
      db: fixture.db,
      run: { id: runId, companyId: fixture.companyId },
      ifStep: { id: "if-1", dependencies: ["validator"] },
      workflowSteps: RESOLVER_TOPOLOGY,
      sources: [
        toolSource({ parameters: { action: "list", prefix: "shorts/runs/r1/clips/" } }),
        toolSource({ parameters: { action: "list", prefix: "shorts/runs/r2/clips/" } }),
      ],
      resolveToolJsonSource: executor,
    });
    expect(executor).toHaveBeenCalledTimes(2);
    expect(map.get(workflowConditionSourceKey(toolSource({ parameters: { action: "list", prefix: "shorts/runs/r1/clips/" } })))).toEqual({ count: 1 });
    expect(map.get(workflowConditionSourceKey(toolSource({ parameters: { action: "list", prefix: "shorts/runs/r2/clips/" } })))).toEqual({ count: 2 });
  });
});

// server/src/__tests__/rework-producer-context.test.ts
//
// [purpose] Source-to-retry tests for native workflow QA rework handoff.
//   Proves: (1) producer's own active workProducts + original instruction are
//   present in the rework context, (2) upstream dependency artifacts stay
//   separate, (3) foreign-company products cannot leak, (4) the contract still
//   triggers fresh-session rotation.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  createDb,
  issueWorkProducts,
  issues,
  missions,
  agents,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  buildWorkflowReworkContract,
  readWorkflowReworkContract,
  renderWorkflowReworkComment,
} from "../services/workflow/control-flow/rework-contract.js";
import {
  loadProducerOwnReworkContext,
  loadProducerDependencyArtifacts,
} from "../services/workflow/control-flow/rework-producer-context.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skip rework-producer-context tests: ${support.reason ?? "unsupported"}`);
}

type StepRun = typeof workflowStepRuns.$inferSelect;

async function seedCompany(db: Db, name: string): Promise<string> {
  const id = randomUUID();
  await db.insert(companies).values({
    id,
    name,
    issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  return id;
}

async function seedAgent(db: Db, companyId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(agents).values({
    id, companyId, name: `agent-${id.slice(0, 4)}`,
    role: "writer", status: "active",
    adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
  });
  return id;
}

async function seedIssue(db: Db, companyId: string, over: Partial<typeof issues.$inferInsert> = {}): Promise<string> {
  const [row] = await db.insert(issues).values({
    companyId,
    title: over.title ?? "test issue",
    status: over.status ?? "todo",
    ...over,
  }).returning({ id: issues.id });
  return row!.id;
}

async function seedWorkProduct(db: Db, companyId: string, issueId: string, over: Partial<typeof issueWorkProducts.$inferInsert>): Promise<void> {
  await db.insert(issueWorkProducts).values({
    companyId,
    issueId,
    type: over.type ?? "file",
    provider: over.provider ?? "local",
    title: over.title ?? "test-product",
    status: over.status ?? "active",
    url: over.url,
    externalId: over.externalId,
    metadata: over.metadata,
  });
}

describeDb("loadProducerOwnReworkContext (source-to-retry handoff)", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  let companyA: string;
  let companyB: string;
  let producerIssueA: string;
  let producerIssueB: string;
  const producerInstruction = "Build the dashboard HTML report with top-25 crypto table and risk-off markers.";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rework-ctx-");
    db = createDb(tempDb.connectionString);

    companyA = await seedCompany(db, "Rework Context Co A");
    companyB = await seedCompany(db, "Rework Context Co B");
    const agentA = await seedAgent(db, companyA);

    // Producer issue in company A with an instruction + active work products.
    producerIssueA = await seedIssue(db, companyA, {
      title: "produce-dashboard",
      description: producerInstruction,
      status: "in_progress",
      assigneeAgentId: agentA,
    });
    await seedWorkProduct(db, companyA, producerIssueA, {
      title: "dashboard-v1",
      url: "/srv/projects/dash/reports/dashboard.html",
      status: "active",
    });
    await seedWorkProduct(db, companyA, producerIssueA, {
      title: "dashboard-data",
      metadata: { path: "/srv/projects/dash/data.json" },
      status: "active",
    });
    // Inactive product should be excluded.
    await seedWorkProduct(db, companyA, producerIssueA, {
      title: "dashboard-draft",
      url: "/srv/projects/dash/draft.html",
      status: "superseded",
    });

    // Foreign company B producer issue + work products.
    producerIssueB = await seedIssue(db, companyB, {
      title: "produce-report-b",
      description: "Foreign company B secret instruction.",
      status: "in_progress",
    });
    await seedWorkProduct(db, companyB, producerIssueB, {
      title: "foreign-secret-product",
      url: "/srv/projects/secret/leaked.html",
      status: "active",
    });
  }, 60_000);

  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  it("returns the producer issue's own original instruction and active workProducts", async () => {
    const ctx = await loadProducerOwnReworkContext({ db, companyId: companyA, producerIssueId: producerIssueA });
    expect(ctx.instruction).toContain("dashboard HTML report");
    expect(ctx.instruction).toContain("produce-dashboard");
    expect(ctx.workProducts.length).toBe(2);
    expect(ctx.workProducts.some((wp) => wp.title === "dashboard-v1" && wp.ref.includes("dashboard.html"))).toBe(true);
    expect(ctx.workProducts.some((wp) => wp.title === "dashboard-data" && wp.ref.includes("data.json"))).toBe(true);
  });

  it("excludes inactive (superseded) workProducts", async () => {
    const ctx = await loadProducerOwnReworkContext({ db, companyId: companyA, producerIssueId: producerIssueA });
    expect(ctx.workProducts.every((wp) => !wp.title.includes("draft"))).toBe(true);
  });

  it("foreign-company products cannot leak into company A's context", async () => {
    const ctx = await loadProducerOwnReworkContext({ db, companyId: companyA, producerIssueId: producerIssueA });
    expect(ctx.workProducts.every((wp) => !wp.ref.includes("secret") && !wp.ref.includes("leaked"))).toBe(true);
    expect(ctx.instruction).not.toContain("Foreign company B");
  });

  it("returns empty results when companyId does not match the issue owner", async () => {
    // Querying company A's issue with company B's companyId → nothing returned.
    const ctx = await loadProducerOwnReworkContext({ db, companyId: companyB, producerIssueId: producerIssueA });
    expect(ctx.instruction).toBeNull();
    expect(ctx.workProducts).toEqual([]);
  });

  it("returns null instruction and empty products when producerIssueId is null", async () => {
    const ctx = await loadProducerOwnReworkContext({ db, companyId: companyA, producerIssueId: null });
    expect(ctx.instruction).toBeNull();
    expect(ctx.workProducts).toEqual([]);
  });

  it("extracts metadata path variants (filePath, artifactPath, outputPath)", async () => {
    const issueId = await seedIssue(db, companyA, { title: "meta-paths-issue", description: "desc", status: "todo" });
    await seedWorkProduct(db, companyA, issueId, { title: "fp", metadata: { filePath: "/out/fp.html" }, status: "active" });
    await seedWorkProduct(db, companyA, issueId, { title: "ap", metadata: { artifactPath: "/out/ap.html" }, status: "active" });
    await seedWorkProduct(db, companyA, issueId, { title: "op", metadata: { outputPath: "/out/op.html" }, status: "active" });
    const ctx = await loadProducerOwnReworkContext({ db, companyId: companyA, producerIssueId: issueId });
    expect(ctx.workProducts.length).toBe(3);
    expect(ctx.workProducts.some((wp) => wp.ref === "/out/fp.html")).toBe(true);
    expect(ctx.workProducts.some((wp) => wp.ref === "/out/ap.html")).toBe(true);
    expect(ctx.workProducts.some((wp) => wp.ref === "/out/op.html")).toBe(true);
  });

  it("returns empty when workflowRunId does not match the producer stepRun", async () => {
    const wrongRunId = randomUUID();
    const ctx = await loadProducerOwnReworkContext({
      db, companyId: companyA, producerIssueId: producerIssueA,
      workflowRunId: wrongRunId, producerStepId: "nonexistent-step",
    });
    expect(ctx.instruction).toBeNull();
    expect(ctx.workProducts).toEqual([]);
  });
});

describeDb("loadProducerDependencyArtifacts (upstream stays separate)", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyA: string;
  let upstreamIssueId: string;
  let stepRunMap: Map<string, StepRun>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rework-dep-");
    db = createDb(tempDb.connectionString);
    companyA = await seedCompany(db, "Rework Dep Co");

    upstreamIssueId = await seedIssue(db, companyA, { title: "upstream-collect", status: "done" });
    await seedWorkProduct(db, companyA, upstreamIssueId, {
      title: "sources.json",
      url: "/srv/projects/dash/sources.json",
      status: "active",
    });

    // Minimal step-run map: only issueId is read by the loader.
    const wfId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: wfId, companyId: companyA, name: "wf", stepsJson: [] });
    const [run] = await db.insert(workflowRuns).values({
      workflowId: wfId, companyId: companyA, triggeredBy: "system", status: "running",
    }).returning();
    const [sr] = await db.insert(workflowStepRuns).values({
      workflowRunId: run.id, companyId: companyA, stepId: "collect", issueId: upstreamIssueId, status: "completed",
    }).returning();
    stepRunMap = new Map<string, StepRun>([["collect", sr]]);
  }, 60_000);

  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  it("returns upstream dependency artifacts as a separate section", async () => {
    const dep = await loadProducerDependencyArtifacts({
      db, companyId: companyA, stepRunMap,
      producerStep: { dependencies: ["collect"] },
    });
    expect(dep).not.toBeNull();
    expect(dep!).toContain("collect");
    expect(dep!).toContain("sources.json");
    expect(dep!).toContain("upstream artifacts");
  });

  it("company-scoped: foreign company gets nothing", async () => {
    const companyB = await seedCompany(db, "Foreign Co");
    const dep = await loadProducerDependencyArtifacts({
      db, companyId: companyB, stepRunMap,
      producerStep: { dependencies: ["collect"] },
    });
    // The section is returned (lists steps) but the foreign product ref is absent.
    expect(dep).toBeNull();
  });

  it("returns null when producer has no dependencies", async () => {
    const dep = await loadProducerDependencyArtifacts({
      db, companyId: companyA, stepRunMap,
      producerStep: { dependencies: [] },
    });
    expect(dep).toBeNull();
  });
});

describe("WorkflowReworkContract with producer-own fields (pure)", () => {
  it("buildWorkflowReworkContract includes instruction and workProducts", () => {
    const contract = buildWorkflowReworkContract({
      producerStepId: "produce",
      qaFeedbacks: [{ qaStepId: "qa", qaIssueId: null, feedback: "REQUEST_CHANGES: fix X" }],
      currentIteration: 0,
      maxIterations: 2,
      producerIssueInstruction: "Build the thing.",
      producerWorkProducts: [{ title: "v1", ref: "/path/v1" }],
      dependencyArtifacts: "- upstream: /path/upstream",
    });
    expect(contract.producerIssueInstruction).toBe("Build the thing.");
    expect(contract.producerWorkProducts).toEqual([{ title: "v1", ref: "/path/v1" }]);
    expect(contract.dependencyArtifacts).toBe("- upstream: /path/upstream");
  });

  it("renderWorkflowReworkComment shows own products and instruction, keeps upstream separate", () => {
    const contract = buildWorkflowReworkContract({
      producerStepId: "produce",
      qaFeedbacks: [{ qaStepId: "qa", qaIssueId: null, feedback: "REQUEST_CHANGES: fix X" }],
      currentIteration: 0,
      maxIterations: 2,
      producerIssueInstruction: "Original task: produce report.",
      producerWorkProducts: [{ title: "report-v1", ref: "/out/report.html" }],
      dependencyArtifacts: "### Current upstream artifacts\n- collect: sources.json → /src.json",
    });
    const comment = renderWorkflowReworkComment(contract);

    // Own instruction present.
    expect(comment).toContain("Original producer issue instruction");
    expect(comment).toContain("Original task: produce report.");
    // Own work products present and distinct from upstream.
    expect(comment).toContain("Prior work products registered on this issue");
    expect(comment).toContain("report-v1 → /out/report.html");
    // Upstream stays in its own section.
    expect(comment).toContain("Current upstream artifacts");
    expect(comment).toContain("sources.json → /src.json");
    // QA feedback present.
    expect(comment).toContain("REQUEST_CHANGES: fix X");
  });

  it("readWorkflowReworkContract round-trips producer-own fields", () => {
    const contract = buildWorkflowReworkContract({
      producerStepId: "produce",
      qaFeedbacks: [{ qaStepId: "qa", qaIssueId: "Q-1", feedback: "fix" }],
      currentIteration: 1,
      maxIterations: 3,
      producerIssueInstruction: "Do the thing.",
      producerWorkProducts: [{ title: "p1", ref: "/r1" }, { title: "p2", ref: "/r2" }],
    });
    const restored = readWorkflowReworkContract(contract);
    expect(restored).not.toBeNull();
    expect(restored!.producerIssueInstruction).toBe("Do the thing.");
    expect(restored!.producerWorkProducts).toEqual([
      { title: "p1", ref: "/r1" },
      { title: "p2", ref: "/r2" },
    ]);
  });

  it("readWorkflowReworkContract tolerates missing producer-own fields (backward compat)", () => {
    const legacy = {
      kind: "workflow_qa_rework",
      producerStepId: "produce",
      iterationLabel: "1/2",
      qaFeedbacks: [{ qaStepId: "qa", qaIssueId: null, feedback: "fix" }],
      dependencyArtifacts: null,
      requiredActions: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const restored = readWorkflowReworkContract(legacy);
    expect(restored).not.toBeNull();
    expect(restored!.producerIssueInstruction).toBeNull();
    expect(restored!.producerWorkProducts).toEqual([]);
  });

  it("the contract still carries kind=workflow_qa_rework so fresh-session rotation fires", () => {
    const contract = buildWorkflowReworkContract({
      producerStepId: "produce",
      qaFeedbacks: [{ qaStepId: "qa", qaIssueId: null, feedback: "fix" }],
      currentIteration: 0,
      maxIterations: 2,
      producerIssueInstruction: "task",
      producerWorkProducts: [{ title: "p", ref: "/r" }],
    });
    expect(contract.kind).toBe("workflow_qa_rework");
  });
});

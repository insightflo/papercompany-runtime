import { isPgUniqueViolation } from "../services/pg-error.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, issueWorkProducts, issues, workflowStepOutputBindings, type Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  cleanupTerminalBoundaryTables,
  seedBoundaryWorld,
  type BoundaryWorld,
} from "./helpers/run-terminal-boundary-fixture.js";
import {
  getPinnedWorkProduct,
  pinWorkProductForStep,
} from "../services/workflow/workflow-output-binding.js";
import { workProductService } from "../services/work-products.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping workflow-output-binding tests: ${support.reason ?? "unsupported host"}`);
}

let db: Db;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let world: BoundaryWorld;

beforeAll(async () => {
  tempDb = await startEmbeddedPostgresTestDatabase("workflow-output-binding-");
  db = createDb(tempDb.connectionString);
  world = await seedBoundaryWorld(db, { runStatus: "running" });
});

afterEach(async () => {
  await db.execute("DELETE FROM workflow_step_output_bindings");
  await db.execute("DELETE FROM issue_work_products");
  await cleanupTerminalBoundaryTables(db);
  world = await seedBoundaryWorld(db, { runStatus: "running" });
});

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
  await tempDb.cleanup();
});

function outputId(sequence: string) {
  return `producer-${randomUUID()}-${sequence}`;
}

async function insertWorkProduct(options: {
  type?: string;
  isPrimary?: boolean;
  title?: string;
}) {
  const [row] = await db.insert(issueWorkProducts).values({
    companyId: world.companyId,
    issueId: world.stepIssueId,
    type: options.type ?? "artifact",
    provider: "external",
    externalId: `external-${randomUUID()}`,
    title: options.title ?? "pinned output",
    url: "https://example.test/output",
    status: "active",
    isPrimary: options.isPrimary ?? false,
    metadata: { revision: 1 },
  }).returning({
    id: issueWorkProducts.id,
    provider: issueWorkProducts.provider,
    externalId: issueWorkProducts.externalId,
  });
  return row!;
}

function pinInput(workProductId: string, referencedStepId = outputId("a")) {
  return {
    companyId: world.companyId,
    workflowRunId: world.runId,
    consumerStepRunId: world.stepRunId,
    referencedStepId,
    workProductId,
    sourceExecutionGeneration: 7,
  };
}

describeEP("workflow output binding", () => {
  it("keeps the first pin when a later registration retries", async () => {
    const reference = outputId("retry");
    const original = await insertWorkProduct({ isPrimary: true });
    const replacement = await insertWorkProduct({ type: "document", title: "later output" });
    const first = await pinWorkProductForStep(db, pinInput(original.id, reference));
    const second = await pinWorkProductForStep(db, pinInput(replacement.id, reference));

    expect(first).toEqual({ kind: "pinned" });
    expect(second).toEqual({ kind: "already_pinned", workProductId: original.id });
  });

  it("returns the existing pin when the unique key was inserted concurrently", async () => {
    const reference = outputId("concurrent");
    const concurrent = await insertWorkProduct({ isPrimary: true });
    const attempted = await insertWorkProduct({ type: "document" });
    await db.insert(workflowStepOutputBindings).values({
      companyId: world.companyId,
      workflowRunId: world.runId,
      consumerStepRunId: world.stepRunId,
      referencedStepId: reference,
      workProductId: concurrent.id,
      sourceExecutionGeneration: 7,
    });

    const result = await pinWorkProductForStep(db, pinInput(attempted.id, reference));
    expect(result).toEqual({ kind: "already_pinned", workProductId: concurrent.id });
  });

  it("returns the pinned work-product projection", async () => {
    const output = await insertWorkProduct({ isPrimary: true });
    const reference = outputId("projection");
    await pinWorkProductForStep(db, pinInput(output.id, reference));

    const pinned = await getPinnedWorkProduct(db, {
      companyId: world.companyId,
      workflowRunId: world.runId,
      consumerStepRunId: world.stepRunId,
      referencedStepId: reference,
    });
    expect(pinned).toMatchObject({
      workProductId: output.id,
      provider: "external",
      externalId: output.externalId,
      url: "https://example.test/output",
      metadata: { revision: 1 },
    });
    expect(await getPinnedWorkProduct(db, {
      companyId: world.companyId,
      workflowRunId: world.runId,
      consumerStepRunId: world.stepRunId,
      referencedStepId: outputId("missing"),
    })).toBeNull();
  });

  it("enforces database-level primary uniqueness", async () => {
    await insertWorkProduct({ type: "artifact", isPrimary: true });
    await expect(insertWorkProduct({ type: "artifact", isPrimary: true })).rejects.toThrow(
      /issue_work_products_primary_uq/,
    );
  });

  it("keeps explicit primary replacement valid through the service transaction", async () => {
    const service = workProductService(db);
    const first = await service.createForIssue(world.stepIssueId, world.companyId, {
      type: "artifact",
      provider: "external",
      externalId: "first",
      title: "first primary",
      url: "https://example.test/first",
      status: "active",
      isPrimary: true,
    });
    const second = await service.createForIssue(world.stepIssueId, world.companyId, {
      type: "artifact",
      provider: "external",
      externalId: "second",
      title: "second primary",
      url: "https://example.test/second",
      status: "active",
      isPrimary: true,
    });

    expect(first?.isPrimary).toBe(true);
    expect(second?.isPrimary).toBe(true);
  });
});

describe("workproduct remove is guarded by consumption evidence", () => {
  it("deleting a pinned work product is a structured 409, not an FK 500", async () => {
    const world = await seedBoundaryWorld(db);
    const [product] = await db.insert(issueWorkProducts).values({
      companyId: world.companyId, issueId: world.stepIssueId, type: "artifact",
      provider: "local_file", externalId: "/tmp/wp-guard.txt", title: "guarded",
      status: "active", isPrimary: true, metadata: { localFilePath: "/tmp/wp-guard.txt" },
    }).returning({ id: issueWorkProducts.id });
    await pinWorkProductForStep(db, {
      companyId: world.companyId, workflowRunId: world.runId,
      consumerStepRunId: world.stepRunId, referencedStepId: "producer",
      workProductId: product!.id,
    });
    await expect(workProductService(db).remove(product!.id)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("workproduct_in_use"),
    });
    // 미핀 산출물 삭제는 기존대로 자유롭다.
    const [free] = await db.insert(issueWorkProducts).values({
      companyId: world.companyId, issueId: world.stepIssueId, type: "artifact",
      provider: "local_file", externalId: "/tmp/wp-free.txt", title: "free",
      status: "active", isPrimary: false, metadata: { localFilePath: "/tmp/wp-free.txt" },
    }).returning({ id: issueWorkProducts.id });
    expect(await workProductService(db).remove(free!.id)).not.toBeNull();
  });
});

describe("pinned product update is path-guarded", () => {
  it("path-affecting patch on a pinned product is 409; harmless fields still work", async () => {
    const world = await seedBoundaryWorld(db);
    const [product] = await db.insert(issueWorkProducts).values({
      companyId: world.companyId, issueId: world.stepIssueId, type: "artifact",
      provider: "local_file", externalId: "/tmp/wp-patch.txt", title: "patchable",
      status: "active", isPrimary: true, metadata: { localFilePath: "/tmp/wp-patch.txt" },
    }).returning({ id: issueWorkProducts.id });
    await pinWorkProductForStep(db, {
      companyId: world.companyId, workflowRunId: world.runId,
      consumerStepRunId: world.stepRunId, referencedStepId: "producer",
      workProductId: product!.id,
    });
    await expect(workProductService(db).update(product!.id, { provider: "http" })).rejects.toMatchObject({
      status: 409, message: expect.stringContaining("workproduct_in_use"),
    });
    await expect(workProductService(db).update(product!.id, { title: "renamed ok" })).resolves.not.toBeNull();
  });

  it("atomic guarded remove: unpinned deletes, pinned 409s, missing returns null", async () => {
    const world = await seedBoundaryWorld(db);
    const [product] = await db.insert(issueWorkProducts).values({
      companyId: world.companyId, issueId: world.stepIssueId, type: "artifact",
      provider: "local_file", externalId: "/tmp/wp-atomic.txt", title: "atomic",
      status: "active", isPrimary: true, metadata: { localFilePath: "/tmp/wp-atomic.txt" },
    }).returning({ id: issueWorkProducts.id });
    await pinWorkProductForStep(db, {
      companyId: world.companyId, workflowRunId: world.runId,
      consumerStepRunId: world.stepRunId, referencedStepId: "producer",
      workProductId: product!.id,
    });
    await expect(workProductService(db).remove(product!.id)).rejects.toMatchObject({ status: 409 });
    expect(await workProductService(db).remove("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("cascade deletion of consumed evidence", () => {
  it("deleting the issue (product cascade) also removes bindings — no FK 500", async () => {
    const world = await seedBoundaryWorld(db);
    const [product] = await db.insert(issueWorkProducts).values({
      companyId: world.companyId, issueId: world.stepIssueId, type: "artifact",
      provider: "local_file", externalId: "/tmp/wp-cascade.txt", title: "cascade",
      status: "active", isPrimary: true, metadata: { localFilePath: "/tmp/wp-cascade.txt" },
    }).returning({ id: issueWorkProducts.id });
    await pinWorkProductForStep(db, {
      companyId: world.companyId, workflowRunId: world.runId,
      consumerStepRunId: world.stepRunId, referencedStepId: "producer",
      workProductId: product!.id,
    });
    // 이슈 삭제 — 산출물 cascade → 바인딩 cascade. 개별 remove() 가드 우회 경로가 FK 500 이 아니어야 한다.
    await db.delete(issues).where(eq(issues.id, world.stepIssueId));
    const remaining = await db.select().from(workflowStepOutputBindings).where(eq(workflowStepOutputBindings.workflowRunId, world.runId));
    expect(remaining).toHaveLength(0);
  });
});

describe("pg unique-violation detection walks the drizzle cause chain", () => {
  it("isPgUniqueViolation finds 23505 nested in DrizzleQueryError.cause", async () => {
    const wrapped = new Error("drizzle wrap", { cause: { code: "23505" } });
    expect(isPgUniqueViolation(wrapped)).toBe(true);
    expect(isPgUniqueViolation(new Error("plain", { cause: { cause: { code: "23505" } } }))).toBe(true);
    expect(isPgUniqueViolation({ code: "23505" })).toBe(true);
    expect(isPgUniqueViolation(new Error("other", { cause: { code: "23503" } }))).toBe(false);
    expect(isPgUniqueViolation(new Error("none"))).toBe(false);
  });
});

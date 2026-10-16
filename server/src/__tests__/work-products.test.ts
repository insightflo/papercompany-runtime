import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueWorkProducts,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  resolveWorkProductBrowserOpenTarget,
  resolveWorkProductLocalFilePath,
  resolveWorkProductOpenTarget,
  workProductService,
} from "../services/work-products.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { admittedProducer } from "./helpers/admitted-producer.js";

function createWorkProductRow(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date("2026-03-17T00:00:00.000Z");
  return {
    id: "work-product-1",
    companyId: "company-1",
    projectId: "project-1",
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "pull_request",
    provider: "github",
    externalId: null,
    title: "PR 1",
    url: "https://example.com/pr/1",
    status: "open",
    reviewState: "draft",
    isPrimary: true,
    healthStatus: "unknown",
    summary: null,
    metadata: null,
    createdByRunId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Ordinary-issue identity query mock for createForIssue: the resume fence
 * (assertIssueResumeScopeIdentity) runs select(fields).from(workflowStepRuns)
 * .innerJoin(workflowRuns, ...).where(...) on the service db and must resolve to no rows
 * for an ordinary issue. The mock asserts the guard queried the service db; the production
 * guard itself is neither replaced nor weakened. Transaction behavior stays explicit.
 */
function ordinaryIssueIdentityDb(transaction: ReturnType<typeof vi.fn>) {
  const where = vi.fn(async () => [] as unknown[]);
  const innerJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ innerJoin }));
  const select = vi.fn(() => ({ from }));
  return { db: { select, transaction } as any, select, from, innerJoin, where };
}

describe("workProductService", () => {
  it("resolves local file work products to their metadata path", () => {
    const target = resolveWorkProductOpenTarget(createWorkProductRow({
      type: "document",
      provider: "local",
      metadata: { path: "/tmp/report.html" },
      url: null,
    }) as any);

    expect(target).toEqual({ kind: "path", value: "/tmp/report.html" });
  });

  it("resolves URL work products to their URL", () => {
    const target = resolveWorkProductOpenTarget(createWorkProductRow({
      provider: "paperclip",
      url: "https://example.com/report.html",
      metadata: null,
    }) as any);

    expect(target).toEqual({ kind: "url", value: "https://example.com/report.html" });
  });

  it("rejects local work products without an absolute metadata path", () => {
    const target = resolveWorkProductOpenTarget(createWorkProductRow({
      type: "document",
      provider: "local",
      metadata: { path: "relative/report.html" },
      url: null,
    }) as any);

    expect(target).toBeNull();
  });

  it("resolves file URL work products to a local path", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paperclip-work-product-open-"));
    const reportPath = path.join(dir, "report.html");
    writeFileSync(reportPath, "<h1>report</h1>\n", "utf8");

    try {
      const result = resolveWorkProductLocalFilePath(createWorkProductRow({
        type: "document",
        provider: "local",
        metadata: null,
        url: pathToFileURL(reportPath).toString(),
      }) as any);

      expect(result).toBe(reportPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an API content URL for local files when opening in a browser", () => {
    const target = resolveWorkProductBrowserOpenTarget(createWorkProductRow({
      id: "work-product-1",
      type: "document",
      provider: "local",
      metadata: { path: "/tmp/report.html" },
      url: null,
    }) as any);

    expect(target).toEqual({ kind: "url", value: "/api/work-products/work-product-1/content" });
  });

  it("keeps HTTP URLs as browser-open targets", () => {
    const target = resolveWorkProductBrowserOpenTarget(createWorkProductRow({
      id: "work-product-1",
      provider: "paperclip",
      metadata: null,
      url: "https://example.com/report.html",
    }) as any);

    expect(target).toEqual({ kind: "url", value: "https://example.com/report.html" });
  });

  it("uses a transaction when creating a new primary work product", async () => {
    const updatedWhere = vi.fn(async () => undefined);
    const updateSet = vi.fn(() => ({ where: updatedWhere }));
    const txUpdate = vi.fn(() => ({ set: updateSet }));

    const insertedRow = createWorkProductRow();
    const insertReturning = vi.fn(async () => [insertedRow]);
    const insertValues = vi.fn(() => ({ returning: insertReturning }));
    const txInsert = vi.fn(() => ({ values: insertValues }));

    const tx = {
      update: txUpdate,
      insert: txInsert,
    };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => await callback(tx));
    const guard = ordinaryIssueIdentityDb(transaction);

    const svc = workProductService(guard.db);
    const result = await svc.createForIssue("issue-1", "company-1", {
      type: "pull_request",
      provider: "github",
      title: "PR 1",
      status: "open",
      reviewState: "draft",
      isPrimary: true,
    });

    expect(guard.select).toHaveBeenCalledTimes(1);
    expect(guard.from).toHaveBeenCalledTimes(1);
    expect(guard.innerJoin).toHaveBeenCalledTimes(1);
    expect(guard.where).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(txInsert).toHaveBeenCalledTimes(1);
    expect(result?.id).toBe("work-product-1");
  });

  it("rejects local document work products whose metadata path does not exist", async () => {
    const transaction = vi.fn();
    const svc = workProductService({ transaction } as any);

    const result = await svc.createForIssue("issue-1", "company-1", {
      type: "document",
      provider: "local",
      title: "Missing report",
      status: "active",
      reviewState: "none",
      isPrimary: true,
      metadata: { path: "/tmp/paperclip-missing-report.md" },
    });

    expect(result).toBeNull();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("accepts local document work products when metadata path exists", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paperclip-work-product-"));
    const reportPath = path.join(dir, "report.md");
    writeFileSync(reportPath, "# report\n", "utf8");

    try {
      const updatedWhere = vi.fn(async () => undefined);
      const updateSet = vi.fn(() => ({ where: updatedWhere }));
      const txUpdate = vi.fn(() => ({ set: updateSet }));

      const insertedRow = createWorkProductRow({
        type: "document",
        provider: "local",
        metadata: { path: reportPath },
      });
      const insertReturning = vi.fn(async () => [insertedRow]);
      const insertValues = vi.fn(() => ({ returning: insertReturning }));
      const txInsert = vi.fn(() => ({ values: insertValues }));

      const tx = {
        update: txUpdate,
        insert: txInsert,
      };
      const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => await callback(tx));
      const guard = ordinaryIssueIdentityDb(transaction);
      const svc = workProductService(guard.db);

      const result = await svc.createForIssue("issue-1", "company-1", {
        type: "document",
        provider: "local",
        title: "Report",
        status: "active",
        reviewState: "none",
        isPrimary: true,
        metadata: { path: reportPath },
      });

      expect(result?.metadata).toEqual({ path: reportPath });
      expect(guard.select).toHaveBeenCalledTimes(1);
      expect(guard.where).toHaveBeenCalledTimes(1);
      expect(transaction).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses a transaction when promoting an existing work product to primary", async () => {
    const existingRow = createWorkProductRow({ isPrimary: false });

    const selectWhere = vi.fn(async () => [existingRow]);
    const selectFrom = vi.fn(() => ({ where: selectWhere }));
    const txSelect = vi.fn(() => ({ from: selectFrom }));

    const updateReturning = vi
      .fn()
      .mockResolvedValue([createWorkProductRow({ reviewState: "ready_for_review" })]);
    const updateWhere = vi.fn(() => ({ returning: updateReturning }));
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const txUpdate = vi.fn(() => ({ set: updateSet }));

    const tx = {
      select: txSelect,
      update: txUpdate,
    };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => await callback(tx));

    const svc = workProductService({ transaction } as any);
    const result = await svc.update("work-product-1", {
      isPrimary: true,
      reviewState: "ready_for_review",
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txSelect).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledTimes(2);
    expect(result?.reviewState).toBe("ready_for_review");
  });
});

// [산출물 소비 하드닝 2a — 등록 대표(isPrimary) 규칙] 실DB 검증: 미지정 isPrimary 해석은
//   "호출자 명시 > ① 계약 부합 승격(실행 정의 selector 정확 지목) > ② 빈 이슈 첫 등록만 > false"다.
//   종전 "타입별 첫 등록=대표" 해석은 폐기 — 혼합 타입 이슈의 두 번째 타입 첫 산출물은 더 이상 대표가 아니다.
const embeddedSupport = await getEmbeddedPostgresTestSupport();
const describeEmbedded = embeddedSupport.supported ? describe : describe.skip;
if (!embeddedSupport.supported) console.warn(`skip work product primary rules: ${embeddedSupport.reason ?? "unsupported"}`);

describeEmbedded("work product registration representative rules (createForIssue isPrimary interpretation)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let tmpRoot: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("wp-primary-rules-");
    db = createDb(tempDb.connectionString);
    tmpRoot = mkdtempSync(path.join(tmpdir(), "wp-primary-rules-"));
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** Producer heartbeat 세계: write(producer) → consume(selector) 실행 정의 + 실제 승인 heartbeat. */
  async function registrationWorld(options?: {
    selectors?: Record<string, { type: string; title: string }> | null;
    runMetadata?: Record<string, unknown>;
  }) {
    const companyId = randomUUID(), workflowId = randomUUID(), runId = randomUUID(), issueId = randomUUID();
    const agentId = randomUUID(), producerStepRunId = randomUUID(), consumerStepRunId = randomUUID(), heartbeatId = randomUUID();
    const selectors = options?.selectors === undefined
      ? { write: { type: "document", title: "content.json" } }
      : options.selectors;
    await db.insert(companies).values({ id: companyId, name: "Primary rules", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Writer" });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Primary rules", stepsJson: [
      { id: "write", name: "Write", dependencies: [] },
      { id: "consume", name: "Consume", dependencies: ["write"], toolArgs: { content: "{$steps.write.workProductPath}" },
        ...(selectors ? { workProductSelectors: selectors } : {}) },
    ] });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId, status: "running", triggeredBy: "board",
      ...(options?.runMetadata ? { metadata: options.runMetadata } : {}) });
    await db.insert(issues).values({ id: issueId, companyId, title: "Write report" });
    await db.insert(workflowStepRuns).values([
      { id: producerStepRunId, workflowRunId: runId, stepId: "write", issueId, status: "completed", executionGeneration: 3 },
      { id: consumerStepRunId, workflowRunId: runId, stepId: "consume", status: "pending" },
    ]);
    await admittedProducer(db, { companyId, agentId, issueId, stepRunId: producerStepRunId, heartbeatId });
    return { companyId, issueId, runId, heartbeatId };
  }

  /** createForIssue 자동 등록(isPrimary 생략 가능) — 실제 로컬 파일로 봉인까지 실경로. */
  async function register(world: Awaited<ReturnType<typeof registrationWorld>>,
    input: { type: "document" | "artifact"; title: string; isPrimary?: boolean }) {
    const file = path.join(tmpRoot, `${input.title}-${randomUUID()}`);
    writeFileSync(file, `fixture:${input.title}`, "utf8");
    return workProductService(db).createForIssue(world.issueId, world.companyId, {
      provider: "local_file", type: input.type, title: input.title, status: "active",
      createdByRunId: world.heartbeatId, metadata: { path: file },
      ...(input.isPrimary === undefined ? {} : { isPrimary: input.isPrimary }),
    });
  }

  /** 이슈에 미리 존재하던 산출물(producer 경로 밖 직접 insert). */
  async function seedProduct(companyId: string, issueId: string, input: { type: string; title: string; isPrimary: boolean }) {
    const [row] = await db.insert(issueWorkProducts).values({
      companyId, issueId, type: input.type, provider: "custom", title: input.title,
      status: "active", isPrimary: input.isPrimary,
    }).returning();
    return row!;
  }

  async function promotionAudits(companyId: string) {
    return db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.action, "workflow.workproduct_contract_promotion"),
    ));
  }

  it("(a) contract match promotes the registration, demotes the same-type primary, and writes exactly one audit row", async () => {
    const world = await registrationWorld();
    const legacy = await seedProduct(world.companyId, world.issueId, { type: "document", title: "legacy.json", isPrimary: true });
    const product = await register(world, { type: "document", title: "content.json" });
    expect(product?.isPrimary).toBe(true);
    const [legacyAfter] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, legacy.id));
    expect(legacyAfter.isPrimary).toBe(false);
    const audits = await promotionAudits(world.companyId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: "system", actorId: "workproduct-contract-promotion",
      entityType: "issue_work_product", entityId: product!.id,
      details: { schemaVersion: "workflow.workproduct-contract-promotion.v1", producerStepId: "write",
        workflowRunId: world.runId, selector: { type: "document", title: "content.json" } } });
  });

  it("(b) explicit isPrimary:false stays non-primary even when the contract matches", async () => {
    const world = await registrationWorld();
    const product = await register(world, { type: "document", title: "content.json", isPrimary: false });
    expect(product?.isPrimary).toBe(false);
    expect(await promotionAudits(world.companyId)).toHaveLength(0);
  });

  it("(c) empty-issue first registration is primary; a second type's first product is NOT (type-agnostic empty check)", async () => {
    const world = await registrationWorld({ selectors: null });
    const first = await register(world, { type: "document", title: "content.json" });
    expect(first?.isPrimary).toBe(true);
    // 구 규칙(타입별 첫 등록=대표)과 반대 — 혼합 이슈의 artifact 첫 산출물은 대표가 아니다.
    const second = await register(world, { type: "artifact", title: "cover.png" });
    expect(second?.isPrimary).toBe(false);
    const [firstAfter] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, first!.id));
    expect(firstAfter.isPrimary).toBe(true);
    expect(await promotionAudits(world.companyId)).toHaveLength(0);
  });

  it("(d) a non-matching auto registration on a non-empty issue is never primary", async () => {
    const world = await registrationWorld();
    const artifact = await seedProduct(world.companyId, world.issueId, { type: "artifact", title: "cover.png", isPrimary: true });
    const product = await register(world, { type: "document", title: "draft.md" });
    expect(product?.isPrimary).toBe(false);
    const [artifactAfter] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, artifact.id));
    expect(artifactAfter.isPrimary).toBe(true);
    expect(await promotionAudits(world.companyId)).toHaveLength(0);
  });

  it("(e) delegated registrations are excluded from contract promotion (mirror semantics preserved)", async () => {
    const companyId = randomUUID(), ownerAgentId = randomUUID(), missionId = randomUUID();
    const sourceIssueId = randomUUID(), unblockIssueId = randomUUID(), delegatedHeartbeatId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Delegated", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Owner", status: "active" });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Delegated rescue", status: "active" });
    await db.insert(issues).values([
      { id: sourceIssueId, companyId, missionId, title: "Report", originKind: "workflow_execution", status: "done" },
      { id: unblockIssueId, companyId, missionId, title: "Unblock", originKind: "mission_main_executor_unblock",
        originId: sourceIssueId, assigneeAgentId: ownerAgentId, status: "in_progress" },
    ]);
    await db.insert(heartbeatRuns).values({ id: delegatedHeartbeatId, companyId, agentId: ownerAgentId,
      issueId: unblockIssueId, status: "succeeded" });
    await db.update(issues).set({ checkoutRunId: delegatedHeartbeatId }).where(eq(issues.id, unblockIssueId));
    // 원본 미러 대상 이슈는 이미 비어 있지 않다 → ②도 거짓. 위임 생산자는 run/step 신원이 없어 ① 대상도 아니다.
    await seedProduct(companyId, sourceIssueId, { type: "artifact", title: "existing.png", isPrimary: true });
    const product = await workProductService(db).createForIssue(sourceIssueId, companyId, {
      provider: "custom", type: "document", title: "content.json", status: "active",
      createdByRunId: delegatedHeartbeatId, metadata: {},
    }, { kind: "mission_owner_unblock_source", issueId: unblockIssueId });
    expect(product?.isPrimary).toBe(false);
    expect(await promotionAudits(companyId)).toHaveLength(0);
  });

  it("(f) execution definition load failure is a non-match, never a registration failure", async () => {
    // marked run without snapshot → loadExecutionDefinition throws historical_unproven → ① 미부합.
    const world = await registrationWorld({ runMetadata: { executionDefinitionVersion: 1 } });
    await seedProduct(world.companyId, world.issueId, { type: "artifact", title: "cover.png", isPrimary: true });
    const product = await register(world, { type: "document", title: "content.json" });
    expect(product).toBeTruthy();
    expect(product?.isPrimary).toBe(false);
    expect(await promotionAudits(world.companyId)).toHaveLength(0);
  });

  it("(g) savepoint 23505 recovery keeps auto registration successful under a racing same-type primary", async () => {
    const world = await registrationWorld({ selectors: null });
    const racingPrimary = db.transaction(async (tx2) => {
      await tx2.insert(issueWorkProducts).values({ companyId: world.companyId, issueId: world.issueId,
        type: "document", provider: "custom", title: "race.json", status: "active", isPrimary: true });
      // 미커밋 unique 엔트리를 500ms 동안 붙잡아 등록 트랜잭션의 대표 INSERT 를 정확히 충돌시킨다.
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    // 예열된 풀에서 경합 트랜잭션이 먼저 INSERT 에 도달하도록 출발 우선권을 준다(결정론화).
    await new Promise((resolve) => setTimeout(resolve, 250));
    const product = await register(world, { type: "document", title: "content.json" });
    await racingPrimary;
    expect(product).toBeTruthy();
    expect(product?.isPrimary).toBe(false);
    const primaries = await db.select().from(issueWorkProducts).where(and(
      eq(issueWorkProducts.companyId, world.companyId), eq(issueWorkProducts.issueId, world.issueId),
      eq(issueWorkProducts.isPrimary, true)));
    expect(primaries.map((row) => row.title)).toEqual(["race.json"]);
  });
});

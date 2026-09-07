// @vitest-environment node
// [workflow-child cycle B §10] CHECK 패리티 테스트 — workflow_runs_child_start_lease_pair_ck.
//   (1) getTableConfig(workflowRuns).checks 에 실제 drizzle check() 로 등록된 제약이 보인다(스키마↔마이그레이션 패리티).
//   (2) 실제 마이그레이션된 disposable embedded PG 에서 paired-null / token+lease 쌍은 수용되고,
//       반쪽 짝(half-pair) 두 순열은 23514 로 거부된다.
//   (3) (workflow_run_id, step_id) 유일 인덱스 — 단일 insert 수용, 중복 insert 는 23505 거부.
import { randomUUID } from "node:crypto";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  configureWorkflowChildFixtures,
  createCompanyFixture,
  insertDefinition,
} from "./helpers/workflow-child-fixtures.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres schema tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("workflow_runs_child_start_lease_pair_ck — getTableConfig parity", () => {
  it("exposes the compiled pair predicate on the drizzle table config", () => {
    const checks = getTableConfig(workflowRuns).checks;
    const pairCk = checks.find((candidate) => candidate.name === "workflow_runs_child_start_lease_pair_ck");
    expect(pairCk).toBeDefined();
    const rendered = new PgDialect().sqlToQuery(pairCk!.value).sql.toLowerCase();
    expect(rendered).toContain("child_start_token");
    expect(rendered).toContain("child_start_lease_expires_at");
    expect(rendered).toContain("is null");
    expect(rendered).toContain("=");
  });
});

describeEmbeddedPostgres("workflow_runs_child_start_lease_pair_ck — migrated disposable DB", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let workflowId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-child-fix5-schema-");
    db = createDb(tempDb.connectionString);
    configureWorkflowChildFixtures(db);
    companyId = await createCompanyFixture("SchemaPair");
    workflowId = await insertDefinition({ companyId, name: "pair-workflow", steps: [] });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertRunWithPair(values: { token: string | null; lease: Date | null }): Promise<"ok" | { code: string }> {
    try {
      await db.insert(workflowRuns).values({
        id: randomUUID(),
        workflowId,
        companyId,
        status: "running",
        triggeredBy: "board",
        ...(values.token ? { childStartToken: values.token } : {}),
        ...(values.lease ? { childStartLeaseExpiresAt: values.lease } : {}),
      });
      return "ok";
    } catch (error) {
      return { code: (error as { code?: string }).code ?? "unknown" };
    }
  }

  async function insertStepRun(runId: string, stepId: string): Promise<"ok" | { code: string }> {
    try {
      await db.insert(workflowStepRuns).values({
        id: randomUUID(),
        workflowRunId: runId,
        stepId,
        status: "pending",
      });
      return "ok";
    } catch (error) {
      return { code: (error as { code?: string }).code ?? "unknown" };
    }
  }

  it("accepts the paired null arm (no token, no lease)", async () => {
    expect(await insertRunWithPair({ token: null, lease: null })).toBe("ok");
  });

  it("accepts the paired present arm (token + lease together)", async () => {
    expect(await insertRunWithPair({ token: randomUUID(), lease: new Date(Date.now() + 60_000) })).toBe("ok");
  });

  it("rejects token without lease (half-pair) with 23514", async () => {
    expect(await insertRunWithPair({ token: randomUUID(), lease: null })).toEqual({ code: "23514" });
  });

  it("rejects lease without token (half-pair) with 23514", async () => {
    expect(await insertRunWithPair({ token: null, lease: new Date(Date.now() + 60_000) })).toEqual({ code: "23514" });
  });

  it("rejects duplicate (workflow_run_id, step_id) with 23505 while single inserts are accepted", async () => {
    const runId = randomUUID();
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      companyId,
      status: "running",
      triggeredBy: "board",
    });
    expect(await insertStepRun(runId, "a")).toBe("ok");
    expect(await insertStepRun(runId, "a")).toEqual({ code: "23505" });
    expect(await insertStepRun(runId, "b")).toBe("ok");
  });
});

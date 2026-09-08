// @vitest-environment node
// [workflow-child fix5 — schema] descope v1 마이그레이션 0101 ↔ Drizzle 패리티 + 엄격 제약
//   커버리지(설계 §2/§6). (1) getTableConfig CHECK/partial unique 패리티, (2) 마이그레이션된
//   disposable PG 에서 state/generation CHECK 위반 거부, (3) deferred 트리거가 claimed 커밋을
//   롤백(link 후 커밋은 수용), (4) nonnull child_run_id 부분 유일 인덱스, (5) 정의 archive/삭제
//   가드 트리거(활성 invocation 중 거부, 정산 후 archive 성공). 전부 실제 SQL 로 검증한다.
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb, workflowDefinitions, workflowRuns, workflowStepInvocations, workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  childStep,
  configureWorkflowChildFixtures,
  createCompanyFixture,
  insertDefinition,
  insertRunWithWorkflowStepRun,
  insertStepRunForRun,
} from "./helpers/workflow-child-fixtures.js";
import { insertLinkedInvocation, insertTombstoneInvocation } from "./helpers/workflow-child-invocation-fixtures.js";

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

describe("workflow_step_invocations — getTableConfig parity (state/generation/child unique)", () => {
  it("exposes the state and generation CHECKs on the drizzle table config", () => {
    const checks = getTableConfig(workflowStepInvocations).checks;
    const stateCk = checks.find((candidate) => candidate.name === "workflow_step_invocations_state_ck");
    const genCk = checks.find((candidate) => candidate.name === "workflow_step_invocations_generation_one_ck");
    expect(stateCk).toBeDefined();
    expect(genCk).toBeDefined();
    const stateSql = new PgDialect().sqlToQuery(stateCk!.value).sql.toLowerCase();
    expect(stateSql).toContain("claimed");
    expect(stateSql).toContain("linked");
    expect(new PgDialect().sqlToQuery(genCk!.value).sql.toLowerCase()).toContain("= 1");
  });

  it("exposes the partial unique index on nonnull child_run_id", () => {
    const index = getTableConfig(workflowStepInvocations).indexes
      .find((candidate) => candidate.config.name === "workflow_step_invocations_child_run_id_uq");
    expect(index).toBeDefined();
    expect(index!.config.unique).toBe(true);
    const where = new PgDialect().sqlToQuery(index!.config.where!).sql.toLowerCase();
    expect(where).toContain("child_run_id");
    expect(where).toContain("is not null");
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

describeEmbeddedPostgres("workflow_step_invocations — migrated DB strict invariants + definition guards", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let workflowId!: string;
  let runId!: string;
  let stepRunId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-child-fix5-invocations-");
    db = createDb(tempDb.connectionString);
    configureWorkflowChildFixtures(db);
    companyId = await createCompanyFixture("Invocations");
    workflowId = await insertDefinition({ companyId, name: "invocation-parent", steps: [childStep(randomUUID())] });
    ({ runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId }));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** CHECK/부분 유일 인덱스 경계 — 23514/23505 가 명시적으로 테스트되는 경계다(설계 §6 R). */
  async function insertInvocationRow(values: {
    state: string; generation: number; parentStepRunId?: string; childRunId?: string | null;
    targetWorkflowId?: string;
  }): Promise<"ok" | { code: string }> {
    try {
      await db.insert(workflowStepInvocations).values({
        companyId,
        parentStepRunId: values.parentStepRunId ?? stepRunId,
        childRunId: values.childRunId ?? null,
        state: values.state,
        generation: values.generation,
        targetWorkflowId: values.targetWorkflowId ?? workflowId,
      });
      return "ok";
    } catch (error) {
      return { code: (error as { code?: string }).code ?? "unknown" };
    }
  }

  it("rejects state outside claimed/linked and generation != 1 with 23514 (CHECK boundary)", async () => {
    expect(await insertInvocationRow({ state: "bogus", generation: 1 })).toEqual({ code: "23514" });
    expect(await insertInvocationRow({ state: "linked", generation: 2 })).toEqual({ code: "23514" });
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(0);
  });

  it("deferred trigger rolls back a commit that leaves an invocation claimed", async () => {
    const claimedStepRunId = await insertStepRunForRun({ runId, stepId: "claimed-tx" });
    const failure = await db.transaction(async (tx) => {
      await tx.insert(workflowStepInvocations).values({
        companyId, parentStepRunId: claimedStepRunId, childRunId: null, state: "claimed", generation: 1, targetWorkflowId: workflowId,
      });
    }).then(() => null, (error: { code?: string; message?: string }) => error);
    expect(failure?.code).toBe("23514");
    expect(String(failure?.message)).toContain("workflow_step_invocation_committed_non_linked");
    // 롤백 증명 — claimed 행은 커밋되지 않았다(구성 상태는 트랜잭션 로컬만 가능).
    expect(await db.select().from(workflowStepInvocations).where(eq(workflowStepInvocations.parentStepRunId, claimedStepRunId))).toHaveLength(0);
  });

  it("claimed → linked inside one transaction commits (construction is transaction-local only)", async () => {
    const constructionStepRunId = await insertStepRunForRun({ runId, stepId: "construct-tx" });
    const childRunId = randomUUID();
    const invocationId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(workflowStepInvocations).values({
        id: invocationId, companyId, parentStepRunId: constructionStepRunId, childRunId: null, state: "claimed", generation: 1, targetWorkflowId: workflowId,
      });
      await tx.insert(workflowRuns).values({
        id: childRunId, workflowId, companyId, status: "pending",
        triggeredBy: "workflow-step", triggerSource: "workflow",
        parentRunId: runId, parentStepRunId: constructionStepRunId, rootRunId: runId,
      });
      await tx.update(workflowStepInvocations).set({ state: "linked", childRunId })
        .where(eq(workflowStepInvocations.id, invocationId));
    });
    const [row] = await db.select().from(workflowStepInvocations)
      .where(eq(workflowStepInvocations.parentStepRunId, constructionStepRunId));
    expect(row?.state).toBe("linked");
    expect(row?.childRunId).toBe(childRunId);
  });

  it("partial unique index rejects a second invocation on the same nonnull child_run_id (23505); NULL tombstones are exempt", async () => {
    const first = await insertLinkedInvocation(db, {
      companyId, parentRunId: runId, parentStepRunId: stepRunId, childWorkflowId: workflowId, stepId: "dup-a",
    });
    const secondStepRunId = await insertStepRunForRun({ runId, stepId: "dup-b" });
    await expect(db.insert(workflowStepInvocations).values({
      companyId, parentStepRunId: secondStepRunId, childRunId: first.childRunId, state: "linked", generation: 1, targetWorkflowId: workflowId,
    })).rejects.toMatchObject({ code: "23505" });
    const thirdStepRunId = await insertStepRunForRun({ runId, stepId: "dup-c" });
    await insertTombstoneInvocation(db, { companyId, parentStepRunId: secondStepRunId, targetWorkflowId: workflowId });
    await insertTombstoneInvocation(db, { companyId, parentStepRunId: thirdStepRunId, targetWorkflowId: workflowId });
    // 이 테스트가 만든 3행만 센다(공유 DB — 선행 테스트의 construct-tx 행 제외).
    const rows = await db.select().from(workflowStepInvocations)
      .where(inArray(workflowStepInvocations.parentStepRunId, [stepRunId, secondStepRunId, thirdStepRunId]));
    expect(rows).toHaveLength(3);
  });

  it("definition guard triggers block archive UPDATE and physical DELETE while active; archive succeeds after settlement", async () => {
    const guardCompanyId = await createCompanyFixture("Defn Guard");
    const childDefId = await insertDefinition({
      companyId: guardCompanyId, name: "guard-child",
      steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
    });
    const parentDefId = await insertDefinition({ companyId: guardCompanyId, name: "guard-parent", steps: [childStep(childDefId)] });
    const { runId: guardRunId, stepRunId: guardStepRunId } = await insertRunWithWorkflowStepRun({ companyId: guardCompanyId, workflowId: parentDefId });
    const identity = await insertLinkedInvocation(db, {
      companyId: guardCompanyId, parentRunId: guardRunId, parentStepRunId: guardStepRunId, childWorkflowId: childDefId,
    });
    // 활성 invocation(pending 부모 스텝 + linked pending 자식) — 부모/대상 정의 모두 거부(23514).
    await expect(db.execute(sql`update workflow_definitions set status = 'archived' where id = ${parentDefId}`))
      .rejects.toMatchObject({ code: "23514" });
    await expect(db.execute(sql`update workflow_definitions set status = 'archived' where id = ${childDefId}`))
      .rejects.toMatchObject({ code: "23514" });
    await expect(db.execute(sql`delete from workflow_definitions where id = ${parentDefId}`))
      .rejects.toMatchObject({ code: "23514" });
    await expect(db.execute(sql`delete from workflow_definitions where id = ${childDefId}`))
      .rejects.toMatchObject({ code: "23514" });
    expect((await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, parentDefId)))[0]?.status).toBe("active");
    // 정산 — 자식 삭제(FK set null → tombstone) + 부모 스텝 완료.
    await db.delete(workflowRuns).where(eq(workflowRuns.id, identity.childRunId));
    await db.update(workflowStepRuns).set({ status: "completed" }).where(eq(workflowStepRuns.id, guardStepRunId));
    await db.execute(sql`update workflow_definitions set status = 'archived' where id = ${parentDefId}`);
    await db.execute(sql`update workflow_definitions set status = 'archived' where id = ${childDefId}`);
    const definitions = await db.select({ id: workflowDefinitions.id, status: workflowDefinitions.status }).from(workflowDefinitions);
    expect(definitions.find((d) => d.id === parentDefId)?.status).toBe("archived");
    expect(definitions.find((d) => d.id === childDefId)?.status).toBe("archived");
  });

  it("guard-passing physical DELETE actually removes the row (BEFORE DELETE must return OLD)", async () => {
    // 회귀 방지: guard 통과 후 DELETE 가 조용히 0행으로 무시되면(트리거가 NULL/NEW 반환 시)
    // 정정 소유자의 물리 삭제 계약이 깨진다. 삭제가 실제로 반영됨을 단언한다.
    const deleteCompanyId = await createCompanyFixture("Defn Delete");
    const deletableDefId = await insertDefinition({
      companyId: deleteCompanyId, name: "deletable-def",
      steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
    });
    const result = await db.execute(sql`delete from workflow_definitions where id = ${deletableDefId} returning id`);
    expect(result.length).toBe(1);
    expect((await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, deletableDefId)))).toHaveLength(0);
  });
});

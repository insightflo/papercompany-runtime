import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  workflowDefinitions,
  workflowRuns,
  type Db,
} from "@paperclipai/db";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

function errorCode(error: unknown): string {
  const typed = error as { code?: string; cause?: unknown };
  return typed.code ?? (typed.cause ? errorCode(typed.cause) : "unknown");
}

async function expectCode(promise: Promise<unknown>, code: string) {
  let caught: string | null = null;
  try {
    await promise;
  } catch (error) {
    caught = errorCode(error);
  }
  expect(caught, `expected rejection with ${code}`).toBe(code);
}

/**
 * [TS하드닝 #1 DB절반 2026-11-09] 마이그레이션 0130 회귀 시험.
 * workflow_runs.status 도메인 CHECK 제약이 (a) pg_constraint 에 검증된
 * (convalidated) 상태로 존재하고 (b) 무효 상태값 쓰기를 저장 계층에서 실제로
 * 거부하는지 고정한다. 제약 도메인은 0046 인라인 CHECK와 동일한 5값 —
 * 0130은 그 제약을 DROP → ADD NOT VALID → VALIDATE 로 정규화한다.
 * heartbeat_runs 절반은 운영 실측에 후보집 밖 값('done' 1건)이 있어 중단 —
 * c5-candidate-backups/reboot-1107/db-check-report.md 참조.
 */
describeDb("workflow_runs status CHECK constraint (migration 0130)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;
  let companyId: string;
  let definitionId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wf-run-status-ck-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    definitionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "CK Co", issuePrefix: "CK" });
    await db.insert(workflowDefinitions).values({
      id: definitionId,
      companyId,
      name: "status-check-def",
    });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("declares a validated workflow_runs_status_check constraint", async () => {
    const rows = await db.execute(sql`
      SELECT conname, convalidated, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = 'workflow_runs'::regclass AND conname = 'workflow_runs_status_check'
    `);
    const row = rows[0] as { conname: string; convalidated: boolean; def: string } | undefined;
    expect(row?.conname).toBe("workflow_runs_status_check");
    expect(row?.convalidated).toBe(true);
    for (const status of ["pending", "running", "completed", "failed", "cancelled"]) {
      expect(row?.def).toContain(`'${status}'`);
    }
  });

  it("accepts every status in the declared domain", async () => {
    for (const status of ["pending", "running", "completed", "failed", "cancelled"]) {
      const [run] = await db
        .insert(workflowRuns)
        .values({ companyId, workflowId: definitionId, triggeredBy: "test", status })
        .returning();
      expect(run.status).toBe(status);
    }
  });

  it("rejects an invalid status on INSERT (SQLSTATE 23514)", async () => {
    await expectCode(
      db.insert(workflowRuns).values({
        companyId,
        workflowId: definitionId,
        triggeredBy: "test",
        status: "bogus_status",
      }),
      "23514",
    );
  });

  it("rejects an invalid status on UPDATE (SQLSTATE 23514)", async () => {
    const [run] = await db
      .insert(workflowRuns)
      .values({ companyId, workflowId: definitionId, triggeredBy: "test", status: "pending" })
      .returning();
    await expectCode(
      db.execute(sql`UPDATE workflow_runs SET status = 'not_a_status' WHERE id = ${run.id}`),
      "23514",
    );
    const [unchanged] = await db
      .select({ status: workflowRuns.status })
      .from(workflowRuns)
      .where(sql`${workflowRuns.id} = ${run.id}`);
    expect(unchanged.status).toBe("pending");
  });
});

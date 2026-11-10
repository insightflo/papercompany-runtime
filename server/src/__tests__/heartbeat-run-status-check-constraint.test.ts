import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  heartbeatRuns,
  startEmbeddedPostgresTestDatabase,
  type Db,
} from "@paperclipai/db";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../packages/db/src/migrations/", import.meta.url),
);
const ORPHAN_RUN_ID = "2a1b9e3c-480f-41dd-8c3c-22df24d3ef74";
const HEARTBEAT_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const;

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
 * 0131 마이그레이션 파일의 문장을 저널 실행기와 같은 규칙
 * (--\> statement-breakpoint 분할)으로 읽어 돌려준다. 시드를 넣기 위해
 * 실제 파일 내용을 재실행하는 방식이라 파일이 바뀌면 시험도 함께 검증한다.
 */
function migrationStatements(): string[] {
  const file = readdirSync(MIGRATIONS_DIR).find((name) => /^0131_.*\.sql$/.test(name));
  expect(file, "0131 migration file").toBeTruthy();
  return readFileSync(`${MIGRATIONS_DIR}${file}`, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function replayMigration(db: Db) {
  await db.transaction(async (tx) => {
    for (const statement of migrationStatements()) {
      await tx.execute(sql.raw(statement));
    }
  });
}

/**
 * [TS하드닝 #1 DB CHECK 2차 2026-11-10] 마이그레이션 0131 회귀 시험.
 * heartbeat_runs.status 도메인 CHECK 제약(6값, HEARTBEAT_RUN_STATUSES 와 동일)이
 * (a) pg_constraint 에 convalidated 상태로 존재하고 (b) 도메인 밖 쓰기를 저장
 * 계층에서 거부하는지 고정한다. 0131 은 제약 전에 고아 'done' 1행(A1 실측
 * 2a1b9e3c…, hbdone-report §5)을 다중 가드 UPDATE 로 'succeeded' 정정하는
 * 데이터 정정을 포함하므로, 그 정정·VALIDATE 순서를 실제 파일 재실행으로 검증한다.
 * (a)·(b) 경로 시험은 제약을 먼저 내린 뒤 실제 파일을 재실행하므로 it 선언
 * 순서대로 실행되는 전제에 의존한다(파일 내 순차 실행).
 */
describeDb("heartbeat_runs status CHECK constraint (migration 0131)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-hb-run-status-ck-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "CK Co", issuePrefix: "HK" });
    await db.insert(agents).values({ id: agentId, companyId, name: "CK Agent" });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("declares a validated heartbeat_runs_status_check constraint", async () => {
    const rows = await db.execute(sql`
      SELECT conname, convalidated, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = 'heartbeat_runs'::regclass AND conname = 'heartbeat_runs_status_check'
    `);
    const row = rows[0] as { conname: string; convalidated: boolean; def: string } | undefined;
    expect(row?.conname).toBe("heartbeat_runs_status_check");
    expect(row?.convalidated).toBe(true);
    for (const status of HEARTBEAT_STATUSES) {
      expect(row?.def).toContain(`'${status}'`);
    }
  });

  it("accepts every status in the declared domain", async () => {
    for (const status of HEARTBEAT_STATUSES) {
      const [run] = await db
        .insert(heartbeatRuns)
        .values({ companyId, agentId, status })
        .returning();
      expect(run.status).toBe(status);
    }
  });

  it("rejects an invalid status on INSERT (SQLSTATE 23514)", async () => {
    await expectCode(
      db.insert(heartbeatRuns).values({ companyId, agentId, status: "bogus_status" }),
      "23514",
    );
  });

  it("rejects an invalid status on UPDATE (SQLSTATE 23514)", async () => {
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "queued" })
      .returning();
    await expectCode(
      db.execute(sql`UPDATE heartbeat_runs SET status = 'not_a_status' WHERE id = ${run.id}`),
      "23514",
    );
    const [unchanged] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.id} = ${run.id}`);
    expect(unchanged.status).toBe("queued");
  });

  it("corrects the guarded orphan row to 'succeeded', then validates", async () => {
    // (a) 경로: 0131 이전 상태(제약 없음 + 'done' 고아 행)를 재현하고 실제 파일을 재실행.
    await db.execute(
      sql`ALTER TABLE heartbeat_runs DROP CONSTRAINT heartbeat_runs_status_check`,
    );
    await db.execute(sql`
      INSERT INTO heartbeat_runs
        (id, company_id, agent_id, status, finalization_version,
         settled_at, finished_at, updated_at, exit_code)
      VALUES (
        ${ORPHAN_RUN_ID}::uuid, ${companyId}::uuid, ${agentId}::uuid, 'done', 2,
        '2026-09-12 20:04:30.937325+00'::timestamptz,
        '2026-09-12 20:04:30.937325+00'::timestamptz,
        '2026-09-12 20:04:11.291+00'::timestamptz, 143)
    `);

    await replayMigration(db);

    const rows = await db.execute(sql`
      SELECT status, finalization_version, exit_code,
             (settled_at AT TIME ZONE 'UTC')::text AS settled_at_txt,
             (finished_at AT TIME ZONE 'UTC')::text AS finished_at_txt,
             (updated_at AT TIME ZONE 'UTC')::text AS updated_at_txt
      FROM heartbeat_runs WHERE id = ${ORPHAN_RUN_ID}::uuid
    `);
    const row = rows[0] as Record<string, unknown> | undefined;
    expect(row?.status).toBe("succeeded");
    // 정정 UPDATE 는 status 만 바꾼다 — 관측 시각·부수 필드는 보존.
    expect(row?.updated_at_txt).toBe("2026-09-12 20:04:11.291");
    expect(row?.settled_at_txt).toBe("2026-09-12 20:04:30.937325");
    expect(row?.finished_at_txt).toBe("2026-09-12 20:04:30.937325");
    expect(row?.finalization_version).toBe(2);
    expect(row?.exit_code).toBe(143);

    const constraint = await db.execute(sql`
      SELECT convalidated FROM pg_constraint
      WHERE conname = 'heartbeat_runs_status_check'
    `);
    expect((constraint[0] as { convalidated: boolean }).convalidated).toBe(true);
  });

  it("fails VALIDATE and rolls back when a guard-mismatched out-of-domain row exists", async () => {
    // (b) 경로: 가드에 맞지 않는 다른 'done' 행(다른 id·updated_at)이 있으면
    // 정정 UPDATE 는 0행만 치고 VALIDATE 가 23514 로 멈춘다. 저널 실행기는 파일
    // 전체를 한 트랜잭션으로 묶으므로 롤백 뒤 제약·정정 흔적이 없어야 한다.
    await db.execute(
      sql`ALTER TABLE heartbeat_runs DROP CONSTRAINT heartbeat_runs_status_check`,
    );
    const strayId = randomUUID();
    await db.execute(sql`
      INSERT INTO heartbeat_runs (id, company_id, agent_id, status, finalization_version, updated_at)
      VALUES (${strayId}::uuid, ${companyId}::uuid, ${agentId}::uuid, 'done', 2,
              '2026-01-01 00:00:00+00'::timestamptz)
    `);

    await expectCode(replayMigration(db), "23514");

    const stray = await db.execute(
      sql`SELECT status FROM heartbeat_runs WHERE id = ${strayId}::uuid`,
    );
    expect((stray[0] as { status: string }).status).toBe("done");
    const constraint = await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_constraint
      WHERE conname = 'heartbeat_runs_status_check'
    `);
    expect((constraint[0] as { n: number }).n).toBe(0);
    // 정리: 남은 'done' 행을 지우고 제약을 원래 상태로 되돌린다(이 it 을 마지막에 둔다).
    await db.execute(sql`DELETE FROM heartbeat_runs WHERE id = ${strayId}::uuid`);
    await db.execute(sql`
      ALTER TABLE heartbeat_runs ADD CONSTRAINT heartbeat_runs_status_check
      CHECK (status IN ('queued','running','succeeded','failed','cancelled','timed_out'))
    `);
  });
});

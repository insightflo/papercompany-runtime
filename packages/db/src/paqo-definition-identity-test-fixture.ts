import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import { startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

export type PaqoDefinitionIdentityDatabase = {
  connectionString: string;
  apply0092(): Promise<void>;
  reset0092HistoryOnly(): Promise<void>;
  cleanup(): Promise<void>;
};

export const MIGRATION_0092 = "0092_paqo_workflow_definition_identity.sql";

const C1 = "10000000-0000-0000-0000-000000000001";
const A1 = "20000000-0000-0000-0000-000000000001";
const M1 = "30000000-0000-0000-0000-000000000001";
const M2 = "30000000-0000-0000-0000-000000000002";
const D1 = "40000000-0000-0000-0000-000000000001";
const D2 = "40000000-0000-0000-0000-000000000002";
const D3 = "40000000-0000-0000-0000-000000000003";
const D4 = "40000000-0000-0000-0000-000000000004";
const D5 = "40000000-0000-0000-0000-000000000005";

export const PAQO_IDS = { C1, A1, M1, M2, D1, D2, D3, D4, D5 } as const;

async function migrationHash(): Promise<string | null> {
  try {
    const content = await readFile(new URL(`./migrations/${MIGRATION_0092}`, import.meta.url));
    return createHash("sha256").update(content).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function remove0092History(sql: ReturnType<typeof postgres>, hash: string | null): Promise<void> {
  if (!hash) return;
  const rows = await sql<{ schemaName: string }[]>`
    SELECT n.nspname AS "schemaName"
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = '__drizzle_migrations' AND c.relkind = 'r'
  `;
  const schemaName = rows.find((row) => row.schemaName === "drizzle")?.schemaName ?? rows[0]?.schemaName;
  if (!schemaName) throw new Error("Embedded migration history table not found.");
  const quotedSchema = `"${schemaName.replaceAll('"', '""')}"`;
  await sql.unsafe(`DELETE FROM ${quotedSchema}."__drizzle_migrations" WHERE hash = $1`, [hash]);
}

async function restoreLegacyShape(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql.unsafe("DROP INDEX IF EXISTS workflow_definitions_paqo_identity_uq");
  await sql.unsafe("ALTER TABLE workflow_definitions DROP CONSTRAINT IF EXISTS workflow_definitions_mission_id_missions_id_fk");
  await sql.unsafe("ALTER TABLE workflow_definitions DROP COLUMN IF EXISTS mission_id");
  await sql.unsafe("ALTER TABLE workflow_definitions DROP COLUMN IF EXISTS definition_hash");
}

export async function seedPaqoDefinitionRows(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql`
    INSERT INTO companies (id, name, issue_prefix)
    VALUES (${C1}, 'Paqo Identity Co', 'PQI')
  `;
  await sql`
    INSERT INTO agents (id, company_id, name)
    VALUES (${A1}, ${C1}, 'Paqo Owner Agent')
  `;
  await sql`
    INSERT INTO missions (id, company_id, owner_agent_id, title)
    VALUES (${M1}, ${C1}, ${A1}, 'Mission One'), (${M2}, ${C1}, ${A1}, 'Mission Two')
  `;
  await sql`
    INSERT INTO workflow_definitions (id, company_id, name, source, source_kind)
    VALUES
      (${D1}, ${C1}, 'PAQO WBS: single-mission goal', 'native', 'workflow'),
      (${D2}, ${C1}, 'PAQO WBS: two runs one goal', 'native', 'workflow'),
      (${D3}, ${C1}, 'PAQO WBS: explicit kind probe', 'native', 'paqo'),
      (${D4}, ${C1}, 'Regular reporting workflow', 'native', 'workflow'),
      (${D5}, ${C1}, 'PAQO WBS: guard target', 'native', 'workflow')
  `;
  await sql`
    INSERT INTO workflow_runs (id, workflow_id, company_id, mission_id, status, triggered_by)
    VALUES
      ('50000000-0000-0000-0000-000000000001', ${D1}, ${C1}, ${M1}, 'completed', 'agent'),
      ('50000000-0000-0000-0000-000000000002', ${D2}, ${C1}, ${M1}, 'completed', 'agent'),
      ('50000000-0000-0000-0000-000000000003', ${D2}, ${C1}, ${M1}, 'failed', 'agent'),
      ('50000000-0000-0000-0000-000000000004', ${D3}, ${C1}, ${M2}, 'completed', 'agent'),
      ('50000000-0000-0000-0000-000000000005', ${D4}, ${C1}, ${M1}, 'completed', 'user'),
      ('50000000-0000-0000-0000-000000000006', ${D5}, ${C1}, ${M1}, 'completed', 'agent')
  `;
}
export async function startPaqoDefinitionIdentityDatabase(
  testName: string,
): Promise<PaqoDefinitionIdentityDatabase> {
  const database = await startEmbeddedPostgresTestDatabase(testName);
  const hash = await migrationHash();
  const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
  try {
    await remove0092History(sql, hash);
    await restoreLegacyShape(sql);
    await seedPaqoDefinitionRows(sql);
  } catch (error) {
    await sql.end().catch(() => {});
    await database.cleanup();
    throw error;
  }
  await sql.end();
  return {
    connectionString: database.connectionString,
    apply0092: () => applyPendingMigrations(database.connectionString),
    reset0092HistoryOnly: async () => {
      const historySql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      try {
        await remove0092History(historySql, await migrationHash());
      } finally {
        await historySql.end();
      }
    },
    cleanup: database.cleanup,
  };
}

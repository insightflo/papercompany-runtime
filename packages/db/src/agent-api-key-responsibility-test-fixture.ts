import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import { startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

export type LegacyResponsibilityDatabase = {
  connectionString: string;
  apply0087(): Promise<void>;
  reset0087HistoryOnly(): Promise<void>;
  cleanup(): Promise<void>;
};

const C1 = "10000000-0000-0000-0000-000000000001";
const C2 = "10000000-0000-0000-0000-000000000002";
const A1 = "20000000-0000-0000-0000-000000000001";
const KEYS = [
  "30000000-0000-0000-0000-000000000001",
  "30000000-0000-0000-0000-000000000002",
  "30000000-0000-0000-0000-000000000003",
  "30000000-0000-0000-0000-000000000004",
  "30000000-0000-0000-0000-000000000005",
  "30000000-0000-0000-0000-000000000006",
  "30000000-0000-0000-0000-000000000007",
  "30000000-0000-0000-0000-000000000008",
  "30000000-0000-0000-0000-000000000009",
  "30000000-0000-0000-0000-000000000010",
] as const;
const [K_DIRECT, K_JOIN, K_DUPLICATE, K_NONE, K_MISSING, K_FOREIGN, K_SUSPENDED, K_ADMIN, K_CONFLICT, K_REVOKED] = KEYS;
const U_DIRECT = "u-direct";
const U_JOIN = "u-join";
const U_DUPLICATE = "u-duplicate";
const U_FOREIGN = "u-foreign";
const U_SUSPENDED = "u-suspended";
const U_CONFLICT_A = "u-conflict-a";
const U_CONFLICT_B = "u-conflict-b";
const U_ADMIN = "unrelated-admin";
const I_JOIN = "40000000-0000-0000-0000-000000000001";
const I_DUPLICATE = "40000000-0000-0000-0000-000000000002";
const J_JOIN = "50000000-0000-0000-0000-000000000001";
const J_DUPLICATE = "50000000-0000-0000-0000-000000000002";
const MIGRATION = "0087_agent_api_keys_responsibility_scope.sql";
const MUST_NOT_LEAK = "MUST-NOT-LEAK";
const secret = (suffix: string) => `${MUST_NOT_LEAK}-${suffix}`;

async function migrationHash(): Promise<string> {
  const content = await readFile(new URL(`./migrations/${MIGRATION}`, import.meta.url));
  return createHash("sha256").update(content).digest("hex");
}

async function remove0087History(sql: ReturnType<typeof postgres>, hash: string): Promise<void> {
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
  await sql.unsafe("DROP INDEX IF EXISTS agent_api_keys_responsible_user_idx");
  await sql.unsafe("ALTER TABLE agent_api_keys DROP CONSTRAINT IF EXISTS agent_api_keys_responsible_user_id_user_id_fk");
  await sql.unsafe("ALTER TABLE agent_api_keys DROP COLUMN IF EXISTS scope_config");
  await sql.unsafe("ALTER TABLE agent_api_keys DROP COLUMN IF EXISTS responsible_user_id");
}

async function seedLegacyRows(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql`
    INSERT INTO companies (id, name, issue_prefix)
    VALUES (${C1}, 'Responsibility One', 'RSP'), (${C2}, 'Responsibility Foreign', 'RSF')
  `;
  await sql`
    INSERT INTO agents (id, company_id, name)
    VALUES (${A1}, ${C1}, 'Responsibility Agent')
  `;
  await sql`
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES
      (${U_DIRECT}, 'Direct', 'direct@example.com', true, now(), now()),
      (${U_JOIN}, 'Join', 'join@example.com', true, now(), now()),
      (${U_DUPLICATE}, 'Duplicate', 'duplicate@example.com', true, now(), now()),
      (${U_FOREIGN}, 'Foreign', 'foreign@example.com', true, now(), now()),
      (${U_SUSPENDED}, 'Suspended', 'suspended@example.com', true, now(), now()),
      (${U_CONFLICT_A}, 'Conflict A', 'conflict-a@example.com', true, now(), now()),
      (${U_CONFLICT_B}, 'Conflict B', 'conflict-b@example.com', true, now(), now()),
      (${U_ADMIN}, 'Unrelated administrator', 'admin@example.com', true, now(), now())
  `;
  await sql`
    INSERT INTO company_memberships (company_id, principal_type, principal_id, status)
    VALUES
      (${C1}, 'user', ${U_DIRECT}, 'active'), (${C1}, 'user', ${U_JOIN}, 'active'),
      (${C1}, 'user', ${U_DUPLICATE}, 'active'), (${C2}, 'user', ${U_FOREIGN}, 'active'),
      (${C1}, 'user', ${U_SUSPENDED}, 'suspended'), (${C1}, 'user', ${U_CONFLICT_A}, 'active'),
      (${C1}, 'user', ${U_CONFLICT_B}, 'active')
  `;
  await sql`INSERT INTO instance_user_roles (user_id, role) VALUES (${U_ADMIN}, 'instance_admin')`;
  await sql`
    INSERT INTO agent_api_keys (id, agent_id, company_id, name, key_hash, revoked_at)
    VALUES
      (${K_DIRECT}, ${A1}, ${C1}, 'Direct', ${secret("key-direct")}, null),
      (${K_JOIN}, ${A1}, ${C1}, 'Join', ${secret("key-join")}, null),
      (${K_DUPLICATE}, ${A1}, ${C1}, 'Duplicate', ${secret("key-duplicate")}, null),
      (${K_NONE}, ${A1}, ${C1}, 'No provenance', ${secret("key-none")}, null),
      (${K_MISSING}, ${A1}, ${C1}, 'Missing user', ${secret("key-missing")}, null),
      (${K_FOREIGN}, ${A1}, ${C1}, 'Foreign membership', ${secret("key-foreign")}, null),
      (${K_SUSPENDED}, ${A1}, ${C1}, 'Suspended membership', ${secret("key-suspended")}, null),
      (${K_ADMIN}, ${A1}, ${C1}, 'Unrelated administrator', ${secret("key-admin")}, null),
      (${K_CONFLICT}, ${A1}, ${C1}, 'Conflicting users', ${secret("key-conflict")}, null),
      (${K_REVOKED}, ${A1}, ${C1}, 'Already revoked', ${secret("key-revoked")}, now())
  `;
  await sql`
    INSERT INTO activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, details)
    VALUES
      (${C1}, 'user', ${U_DIRECT}, 'agent.key_created', 'agent', ${A1}, ${sql.json({ keyId: K_DIRECT })}),
      (${C1}, 'user', ${U_DUPLICATE}, 'agent.key_created', 'agent', ${A1}, ${sql.json({ keyId: K_DUPLICATE })}),
      (${C1}, 'user', 'missing-user', 'agent.key_created', 'agent', ${A1}, ${sql.json({ keyId: K_MISSING })}),
      (${C1}, 'user', ${U_FOREIGN}, 'agent.key_created', 'agent', ${A1}, ${sql.json({ keyId: K_FOREIGN })}),
      (${C1}, 'user', ${U_SUSPENDED}, 'agent.key_created', 'agent', ${A1}, ${sql.json({ keyId: K_SUSPENDED })}),
      (${C1}, 'user', ${U_DIRECT}, 'agent.key_created', 'agent', ${A1}, ${sql.json({ keyId: K_ADMIN })}),
      (${C1}, 'user', ${U_CONFLICT_A}, 'agent.key_created', 'agent', ${A1}, ${sql.json({ keyId: K_CONFLICT })}),
      (${C1}, 'user', ${U_CONFLICT_B}, 'agent.key_created', 'agent', ${A1}, ${sql.json({ keyId: K_CONFLICT })})
  `;
  await sql`
    INSERT INTO invites (id, company_id, token_hash, expires_at)
    VALUES (${I_JOIN}, ${C1}, ${secret("invite-join")}, now() + interval '1 day'),
      (${I_DUPLICATE}, ${C1}, ${secret("invite-duplicate")}, now() + interval '1 day')
  `;
  await sql`
    INSERT INTO join_requests (
      id, invite_id, company_id, request_type, status, request_ip,
      claim_secret_hash, claim_secret_consumed_at, created_agent_id, approved_by_user_id, approved_at
    ) VALUES
      (${J_JOIN}, ${I_JOIN}, ${C1}, 'agent', 'approved', '127.0.0.1', ${secret("claim-join")}, now(), ${A1}, ${U_JOIN}, now()),
      (${J_DUPLICATE}, ${I_DUPLICATE}, ${C1}, 'agent', 'approved', '127.0.0.1', ${secret("claim-duplicate")}, now(), ${A1}, ${U_DUPLICATE}, now())
  `;
  await sql`
    INSERT INTO activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, details)
    VALUES
      (${C1}, 'user', 'claimant-join', 'agent_api_key.claimed', 'agent_api_key', ${K_JOIN}, ${sql.json({ agentId: A1, joinRequestId: J_JOIN })}),
      (${C1}, 'user', ${U_JOIN}, 'join.approved', 'join_request', ${J_JOIN}, ${sql.json({})}),
      (${C1}, 'user', 'claimant-duplicate', 'agent_api_key.claimed', 'agent_api_key', ${K_DUPLICATE}, ${sql.json({ agentId: A1, joinRequestId: J_DUPLICATE })}),
      (${C1}, 'user', ${U_DUPLICATE}, 'join.approved', 'join_request', ${J_DUPLICATE}, ${sql.json({})})
  `;
}

export async function startLegacyResponsibilityDatabase(testName: string): Promise<LegacyResponsibilityDatabase> {
  const database = await startEmbeddedPostgresTestDatabase(testName);
  const hash = await migrationHash();
  const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
  try {
    await remove0087History(sql, hash);
    await restoreLegacyShape(sql);
    await seedLegacyRows(sql);
  } catch (error) {
    await sql.end().catch(() => {});
    await database.cleanup();
    throw error;
  }
  await sql.end();
  return {
    connectionString: database.connectionString,
    apply0087: () => applyPendingMigrations(database.connectionString),
    reset0087HistoryOnly: async () => {
      const historySql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      try { await remove0087History(historySql, hash); } finally { await historySql.end(); }
    },
    cleanup: database.cleanup,
  };
}

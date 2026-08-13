import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  AGENT_API_KEY_RESPONSIBILITY_MIGRATION,
  AGENT_API_KEY_RESPONSIBILITY_REPORT_ACTION,
  previewAgentApiKeyResponsibilityReport,
  readStoredAgentApiKeyResponsibilityReceipt,
} from "./agent-api-key-responsibility-report.js";
import { startLegacyResponsibilityDatabase } from "./agent-api-key-responsibility-test-fixture.js";

const C1 = "10000000-0000-0000-0000-000000000001";
const A1 = "20000000-0000-0000-0000-000000000001";
const K = {
  direct: "30000000-0000-0000-0000-000000000001",
  join: "30000000-0000-0000-0000-000000000002",
  duplicate: "30000000-0000-0000-0000-000000000003",
  none: "30000000-0000-0000-0000-000000000004",
  missing: "30000000-0000-0000-0000-000000000005",
  foreign: "30000000-0000-0000-0000-000000000006",
  suspended: "30000000-0000-0000-0000-000000000007",
  admin: "30000000-0000-0000-0000-000000000008",
  conflict: "30000000-0000-0000-0000-000000000009",
  revoked: "30000000-0000-0000-0000-000000000010",
} as const;
const U = { direct: "u-direct", join: "u-join", duplicate: "u-duplicate", conflictA: "u-conflict-a", conflictB: "u-conflict-b", admin: "unrelated-admin" } as const;
const REPORT = AGENT_API_KEY_RESPONSIBILITY_REPORT_ACTION;
const AUDIT = "agent_api_key.revoked_by_responsibility_migration";
const MUST_NOT_LEAK = "MUST-NOT-LEAK";
const forbidden = /secret-|key_hash|keyHash|claimSecret|authorization|cookie|session|postgres:\/\//i;

async function migrationHash(): Promise<string> {
  const file = await readFile(new URL("./migrations/0087_agent_api_keys_responsibility_scope.sql", import.meta.url));
  return createHash("sha256").update(file).digest("hex");
}
function comparable(report: { mode: string; generatedAt: string; [key: string]: unknown }) {
  const { mode: _mode, generatedAt: _generatedAt, ...rest } = report;
  return rest;
}

describe("migration 0087 agent API-key responsibility", () => {
  let database: Awaited<ReturnType<typeof startLegacyResponsibilityDatabase>>;
  let sql: ReturnType<typeof postgres>;
  let preview: Awaited<ReturnType<typeof previewAgentApiKeyResponsibilityReport>>;

  beforeAll(async () => {
    database = await startLegacyResponsibilityDatabase("agent-key-responsibility-migration-");
    sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    await sql`
      INSERT INTO activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, details)
      VALUES (${C1}, 'user', ${U.admin}, 'join.approved', 'join_request', '50000000-0000-0000-0000-000000000001', ${sql.json({ unrelated: true })})
    `;
    preview = await previewAgentApiKeyResponsibilityReport(database.connectionString);
    await database.apply0087();
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await database?.cleanup();
  });

  it("backfills exact provenance, deduplicates candidates, revokes unresolved keys, and preserves revoked keys", async () => {
    const stored = await readStoredAgentApiKeyResponsibilityReceipt(database.connectionString);
    const byKey = new Map(stored.keys.map((key) => [key.keyId, key]));
    expect(byKey.get(K.direct)).toMatchObject({ decision: "backfill", resolvedUserId: U.direct });
    expect(byKey.get(K.join)).toMatchObject({ decision: "backfill", resolvedUserId: U.join });
    expect(byKey.get(K.duplicate)).toMatchObject({ decision: "backfill", resolvedUserId: U.duplicate, candidates: [{ userId: U.duplicate }] });
    expect(byKey.get(K.none)).toMatchObject({ decision: "revoke", reasonCodes: ["no_provenance"], candidates: [] });
    expect(byKey.get(K.missing)?.candidates).toEqual([{ userId: "missing-user", sources: ["direct_key_created"], eligible: false, eligibilityReasonCodes: ["user_not_found"] }]);
    expect(byKey.get(K.foreign)?.candidates[0]).toMatchObject({ userId: "u-foreign", eligible: false, eligibilityReasonCodes: ["company_membership_missing"] });
    expect(byKey.get(K.suspended)?.candidates[0]).toMatchObject({ userId: "u-suspended", eligible: false, eligibilityReasonCodes: ["company_membership_inactive"] });
    expect(byKey.get(K.admin)).toMatchObject({ decision: "backfill", resolvedUserId: U.direct, candidates: [{ userId: U.direct }] });
    expect(byKey.get(K.admin)?.candidates.some((candidate) => candidate.userId === U.admin)).toBe(false);
    expect(byKey.get(K.conflict)).toMatchObject({ decision: "revoke", reasonCodes: ["conflicting_eligible_candidates"], candidates: [{ userId: U.conflictA }, { userId: U.conflictB }] });
    expect(byKey.get(K.revoked)).toMatchObject({ decision: "preserve_revoked", resolvedUserId: null, requiresOperatorAction: false });
    expect(comparable(stored)).toEqual(comparable(preview));
    expect((await sql<{ responsible: string | null }[]>`SELECT responsible_user_id responsible FROM agent_api_keys WHERE id = ${K.direct}`)[0]?.responsible).toBe(U.direct);
    expect((await sql<{ responsible: string | null }[]>`SELECT responsible_user_id responsible FROM agent_api_keys WHERE id = ${K.join}`)[0]?.responsible).toBe(U.join);
    expect((await sql<{ responsible: string | null }[]>`SELECT responsible_user_id responsible FROM agent_api_keys WHERE id = ${K.duplicate}`)[0]?.responsible).toBe(U.duplicate);

    const details = await sql<{ text: string }[]>`SELECT details::text FROM activity_log WHERE action IN (${REPORT}, ${AUDIT})`;
    expect(details).toHaveLength(15);
    expect(details.map((row) => row.text).join("\n")).not.toContain(MUST_NOT_LEAK);
    expect(details.map((row) => row.text).join("\n")).not.toMatch(forbidden);
    const reportRows = await sql<{ companyId: string; actorType: string; actorId: string; action: string; entityType: string; entityId: string; agentId: string }[]>`SELECT company_id::text "companyId", actor_type "actorType", actor_id "actorId", action, entity_type "entityType", entity_id "entityId", agent_id::text "agentId" FROM activity_log WHERE action = ${REPORT} ORDER BY entity_id`;
    const auditRows = await sql<{ companyId: string; actorType: string; actorId: string; action: string; entityType: string; entityId: string; agentId: string }[]>`SELECT company_id::text "companyId", actor_type "actorType", actor_id "actorId", action, entity_type "entityType", entity_id "entityId", agent_id::text "agentId" FROM activity_log WHERE action = ${AUDIT} ORDER BY entity_id`;
    expect(reportRows).toHaveLength(10);
    expect(reportRows.every((row) => row.companyId === C1 && row.actorType === "system" && row.actorId === `migration:${AGENT_API_KEY_RESPONSIBILITY_MIGRATION}` && row.action === REPORT && row.entityType === "agent_api_key" && row.agentId === A1)).toBe(true);
    expect(new Set(reportRows.map((row) => row.entityId))).toEqual(new Set(Object.values(K)));
    expect(auditRows).toHaveLength(5);
    expect(auditRows.every((row) => row.companyId === C1 && row.actorType === "system" && row.actorId === `migration:${AGENT_API_KEY_RESPONSIBILITY_MIGRATION}` && row.action === AUDIT && row.entityType === "agent_api_key" && row.agentId === A1)).toBe(true);
    expect(new Set(auditRows.map((row) => row.entityId))).toEqual(new Set([K.none, K.missing, K.foreign, K.suspended, K.conflict]));
    expect((await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM agent_api_keys WHERE revoked_at IS NULL AND responsible_user_id IS NULL`)[0]?.count).toBe(0);
    expect((await sql<{ responsible: string | null; revoked: string | null }[]>`SELECT responsible_user_id responsible, revoked_at revoked FROM agent_api_keys WHERE id = ${K.revoked}`)[0]).toMatchObject({ responsible: null });
    expect((await sql<{ revoked: string | null }[]>`SELECT revoked_at revoked FROM agent_api_keys WHERE id = ${K.revoked}`)[0]?.revoked).not.toBeNull();
  });

  it("does not select an unrelated administrator and keeps a bound key unchanged on replay", async () => {
    const before = await sql<{ responsible: string | null; revoked: string | null }[]>`SELECT responsible_user_id responsible, revoked_at revoked FROM agent_api_keys WHERE id = ${K.direct}`;
    await sql`UPDATE agent_api_keys SET responsible_user_id = ${U.join} WHERE id = ${K.direct}`;
    await database.reset0087HistoryOnly();
    await database.apply0087();
    const after = await sql<{ responsible: string | null; revoked: string | null }[]>`SELECT responsible_user_id responsible, revoked_at revoked FROM agent_api_keys WHERE id = ${K.direct}`;
    expect(before[0]?.revoked).toBe(after[0]?.revoked);
    expect(after[0]?.responsible).toBe(U.join);
    expect((await sql<{ count: number }[]>`SELECT count(*)::int count FROM activity_log WHERE action = ${REPORT} AND entity_id = ${K.direct}`)[0]?.count).toBe(1);
  });

  it("does not stage an already-bound key when its prior report is absent", async () => {
    const isolated = await startLegacyResponsibilityDatabase("agent-key-responsibility-bound-replay-");
    const isolatedSql = postgres(isolated.connectionString, { max: 1, onnotice: () => {} });
    try {
      await isolated.apply0087();
      await isolatedSql`UPDATE agent_api_keys SET responsible_user_id = ${U.join} WHERE id = ${K.direct}`;
      await isolatedSql`DELETE FROM activity_log WHERE action = ${REPORT} AND entity_id = ${K.direct}`;
      await isolated.reset0087HistoryOnly();
      await isolated.apply0087();
      expect((await isolatedSql<{ responsible: string | null }[]>`SELECT responsible_user_id responsible FROM agent_api_keys WHERE id = ${K.direct}`)[0]?.responsible).toBe(U.join);
      expect((await isolatedSql<{ count: number }[]>`SELECT count(*)::int count FROM activity_log WHERE action = ${REPORT} AND entity_id = ${K.direct}`)[0]?.count).toBe(0);
    } finally {
      await isolatedSql.end();
      await isolated.cleanup();
    }
  }, 120_000);

  it("rolls back DDL, mutation, reports, audit, and history when report insertion fails", async () => {
    const isolated = await startLegacyResponsibilityDatabase("agent-key-responsibility-rollback-");
    const isolatedSql = postgres(isolated.connectionString, { max: 1, onnotice: () => {} });
    try {
      await isolatedSql.unsafe(`CREATE FUNCTION paperclip_test_0087_report_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = '${REPORT}' THEN RAISE EXCEPTION 'task-4 report failure'; END IF; RETURN NEW; END; $$`);
      await isolatedSql.unsafe("CREATE TRIGGER paperclip_test_0087_report_failure_trigger BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION paperclip_test_0087_report_failure()");
      await expect(isolated.apply0087()).rejects.toThrow("task-4 report failure");
      expect((await isolatedSql<{ count: number }[]>`SELECT count(*)::int count FROM information_schema.columns WHERE table_name = 'agent_api_keys' AND column_name IN ('responsible_user_id', 'scope_config')`)[0]?.count).toBe(0);
      expect((await isolatedSql<{ count: number }[]>`SELECT count(*)::int count FROM agent_api_keys WHERE revoked_at IS NOT NULL`)[0]?.count).toBe(1);
      expect((await isolatedSql<{ count: number }[]>`SELECT count(*)::int count FROM activity_log WHERE action IN (${REPORT}, ${AUDIT})`)[0]?.count).toBe(0);
      const hash = await migrationHash();
      expect((await isolatedSql<{ count: number }[]>`SELECT count(*)::int count FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`)[0]?.count).toBe(0);
    } finally {
      await isolatedSql.unsafe("DROP TRIGGER IF EXISTS paperclip_test_0087_report_failure_trigger ON activity_log");
      await isolatedSql.unsafe("DROP FUNCTION IF EXISTS paperclip_test_0087_report_failure()");
      await isolatedSql.end();
      await isolated.cleanup();
    }
  }, 120_000);

  it("serializes concurrent public migration calls and remains data-idempotent", async () => {
    const isolated = await startLegacyResponsibilityDatabase("agent-key-responsibility-concurrent-");
    const isolatedSql = postgres(isolated.connectionString, { max: 1, onnotice: () => {} });
    try {
      await Promise.all([isolated.apply0087(), isolated.apply0087()]);
      const reportCount = await isolatedSql<{ count: number }[]>`SELECT count(*)::int count FROM activity_log WHERE action = ${REPORT}`;
      const auditCount = await isolatedSql<{ count: number }[]>`SELECT count(*)::int count FROM activity_log WHERE action = ${AUDIT}`;
      const historyCount = await isolatedSql<{ count: number }[]>`SELECT count(*)::int count FROM drizzle.__drizzle_migrations WHERE hash = ${(await migrationHash())}`;
      console.log(`0087 history rows observed by concurrent runner: ${historyCount[0]?.count ?? 0}`);
      expect(reportCount[0]?.count).toBe(10);
      expect(auditCount[0]?.count).toBe(5);
      expect((await isolatedSql<{ count: number }[]>`SELECT count(*)::int count FROM agent_api_keys WHERE revoked_at IS NULL AND responsible_user_id IS NULL`)[0]?.count).toBe(0);
      const before = await isolatedSql<{ id: string; responsible: string | null; revoked: string | null }[]>`SELECT id, responsible_user_id responsible, revoked_at revoked FROM agent_api_keys ORDER BY id`;
      await isolated.reset0087HistoryOnly();
      await isolated.apply0087();
      const after = await isolatedSql<{ id: string; responsible: string | null; revoked: string | null }[]>`SELECT id, responsible_user_id responsible, revoked_at revoked FROM agent_api_keys ORDER BY id`;
      expect(after).toEqual(before);
      expect((await isolatedSql<{ count: number }[]>`SELECT count(*)::int count FROM activity_log WHERE action = ${REPORT}`)[0]?.count).toBe(10);
      expect((await isolatedSql<{ count: number }[]>`SELECT count(*)::int count FROM activity_log WHERE action = ${AUDIT}`)[0]?.count).toBe(5);
    } finally {
      await isolatedSql.end();
      await isolated.cleanup();
    }
  }, 180_000);
});

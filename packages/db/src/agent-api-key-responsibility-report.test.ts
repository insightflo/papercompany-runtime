import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  AgentApiKeyResponsibilityReceiptNotFoundError,
  buildAgentApiKeyResponsibilityReport,
  exportAgentApiKeyResponsibilityReport,
  previewAgentApiKeyResponsibilityReport,
  readStoredAgentApiKeyResponsibilityReceipt,
  setAgentApiKeyResponsibilityPostgresFactoryForTests,
} from "./agent-api-key-responsibility-report.js";
import { runAgentApiKeyResponsibilityReportCli } from "./agent-api-key-responsibility-report-cli.js";
import { startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const C1 = "10000000-0000-0000-0000-000000000001";
const C2 = "10000000-0000-0000-0000-000000000002";
const A1 = "20000000-0000-0000-0000-000000000001";
const K1 = "30000000-0000-0000-0000-000000000001";
const K2 = "30000000-0000-0000-0000-000000000002";
const K3 = "30000000-0000-0000-0000-000000000003";
const K4 = "30000000-0000-0000-0000-000000000004";
const K5 = "30000000-0000-0000-0000-000000000005";
const K6 = "30000000-0000-0000-0000-000000000006";
const K7 = "30000000-0000-0000-0000-000000000007";
const K8 = "30000000-0000-0000-0000-000000000008";
const K9 = "30000000-0000-0000-0000-000000000009";
const K10 = "30000000-0000-0000-0000-000000000010";
const K11 = "30000000-0000-0000-0000-000000000011";
const K12 = "30000000-0000-0000-0000-000000000012";
const K13 = "30000000-0000-0000-0000-000000000013";
const I1 = "40000000-0000-0000-0000-000000000001";
const I2 = "40000000-0000-0000-0000-000000000002";
const I3 = "40000000-0000-0000-0000-000000000003";
const I4 = "40000000-0000-0000-0000-000000000004";
const I5 = "40000000-0000-0000-0000-000000000005";
const J1 = "50000000-0000-0000-0000-000000000001";
const J2 = "50000000-0000-0000-0000-000000000002";
const J3 = "50000000-0000-0000-0000-000000000003";
const J4 = "50000000-0000-0000-0000-000000000004";
const J5 = "50000000-0000-0000-0000-000000000005";

describe("pure responsibility report aggregation", () => {
  it("normalizes evidence, eligibility, decisions, sorting, and summaries", () => {
    const report = buildAgentApiKeyResponsibilityReport(
      [
        { keyId: "k4", companyId: "c2", agentId: "a", keyName: "revoked", revoked: true },
        { keyId: "k3", companyId: "c1", agentId: "a", keyName: "conflict", userId: "z", source: "direct_key_created", userExists: true, activeCompanyMembership: true, instanceAdmin: false },
        { keyId: "k1", companyId: "c1", agentId: "a", keyName: "dedup", userId: "u", source: "join_claim", userExists: true, activeCompanyMembership: true, instanceAdmin: false },
        { keyId: "k2", companyId: "c1", agentId: "a", keyName: "none" },
        { keyId: "k3", companyId: "c1", agentId: "a", keyName: "conflict", userId: "a", source: "join_claim", userExists: true, activeCompanyMembership: false, instanceAdmin: true },
        { keyId: "k1", companyId: "c1", agentId: "a", keyName: "dedup", userId: "u", source: "direct_key_created", userExists: true, activeCompanyMembership: true, instanceAdmin: false },
        { keyId: "k5", companyId: "c3", agentId: "a", keyName: "ineligible", userId: "missing", source: "direct_key_created", userExists: false, activeCompanyMembership: false, instanceAdmin: false },
        { keyId: "k5", companyId: "c3", agentId: "a", keyName: "ineligible", userId: "foreign", source: "join_claim", userExists: true, activeCompanyMembership: false, instanceAdmin: false },
        { keyId: "k5", companyId: "c3", agentId: "a", keyName: "ineligible", userId: "suspended", source: "direct_key_created", userExists: true, companyMembershipExists: true, activeCompanyMembership: false, instanceAdmin: false },
      ],
      "preview",
      "2026-08-12T00:00:00.000Z",
    );

    expect(report.keys.map((key) => key.keyId)).toEqual(["k1", "k2", "k3", "k4", "k5"]);
    expect(report.keys[0]).toMatchObject({
      decision: "backfill", reasonCodes: ["exactly_one_eligible_candidate"], resolvedUserId: "u",
      candidates: [{ userId: "u", sources: ["direct_key_created", "join_claim"], eligible: true, eligibilityReasonCodes: ["active_company_membership"] }],
    });
    expect(report.keys[1]).toMatchObject({ decision: "revoke", reasonCodes: ["no_provenance"], candidates: [], requiresOperatorAction: true });
    expect(report.keys[2]).toMatchObject({ decision: "revoke", reasonCodes: ["conflicting_eligible_candidates"], resolvedUserId: null });
    expect(report.keys[2]?.candidates.map((candidate) => candidate.userId)).toEqual(["a", "z"]);
    expect(report.keys[3]).toMatchObject({ decision: "preserve_revoked", reasonCodes: ["already_revoked"], requiresOperatorAction: false });
    expect(report.keys[4]?.candidates).toEqual([
      { userId: "foreign", sources: ["join_claim"], eligible: false, eligibilityReasonCodes: ["company_membership_missing"] },
      { userId: "missing", sources: ["direct_key_created"], eligible: false, eligibilityReasonCodes: ["user_not_found"] },
      { userId: "suspended", sources: ["direct_key_created"], eligible: false, eligibilityReasonCodes: ["company_membership_inactive"] },
    ]);
    expect(report.summary).toEqual({ totalKeys: 5, backfillCount: 1, revokeCount: 3, preserveRevokedCount: 1, requiresOperatorActionCount: 3 });
  });
});

describe("deterministic code-unit ordering", () => {
  it("orders keys and candidates by explicit code-unit lexical order", () => {
    const report = buildAgentApiKeyResponsibilityReport([
      { keyId: "a", companyId: "a", agentId: "a", keyName: "a", userId: "a", source: "direct_key_created", userExists: true, activeCompanyMembership: true },
      { keyId: "Z", companyId: "a", agentId: "a", keyName: "Z" },
      { keyId: "a", companyId: "a", agentId: "a", keyName: "a", userId: "Z", source: "join_claim", userExists: true, activeCompanyMembership: true },
    ], "preview", "2026-08-12T00:00:00.000Z");
    expect(report.keys.map((key) => key.keyId)).toEqual(["Z", "a"]);
    expect(report.keys[1]?.candidates.map((candidate) => candidate.userId)).toEqual(["Z", "a"]);
  });
});

describe("disposable database reporter", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-key-report-");
    sql = postgres(database.connectionString, { max: 1 });
    await sql`insert into companies (id, name, issue_prefix) values (${C1}, 'One', 'ONE'), (${C2}, 'Two', 'TWO')`;
    await sql`insert into agents (id, company_id, name) values (${A1}, ${C1}, 'Agent')`;
    await sql`insert into agent_api_keys (id, agent_id, company_id, name, key_hash, revoked_at) values
      (${K1}, ${A1}, ${C1}, 'Direct', 'MUST-NOT-LEAK', null), (${K2}, ${A1}, ${C1}, 'Join', 'hash-two', null),
      (${K3}, ${A1}, ${C1}, 'No provenance', 'hash-three', null), (${K4}, ${A1}, ${C1}, 'Revoked', 'hash-four', now()),
      (${K5}, ${A1}, ${C1}, 'Missing', 'hash-five', null), (${K6}, ${A1}, ${C1}, 'Foreign', 'hash-six', null),
      (${K7}, ${A1}, ${C1}, 'Suspended', 'hash-seven', null), (${K8}, ${A1}, ${C1}, 'Instance admin', 'hash-eight', null),
      (${K9}, ${A1}, ${C1}, 'Conflict', 'hash-nine', null), (${K10}, ${A1}, ${C1}, 'Rejected status', 'hash-ten', null),
      (${K11}, ${A1}, ${C1}, 'Missing approval time', 'hash-eleven', null),
      (${K12}, ${A1}, ${C1}, 'Missing consumption', 'hash-twelve', null),
      (${K13}, ${A1}, ${C1}, 'Wrong approval actor', 'hash-thirteen', null)`;
    await sql`insert into "user" (id, name, email, email_verified, created_at, updated_at) values
      ('u-direct', 'Direct', 'direct@example.com', true, now(), now()), ('u-join', 'Join', 'join@example.com', true, now(), now()),
      ('admin-unrelated', 'Admin', 'admin@example.com', true, now(), now()), ('foreign-sql', 'Foreign', 'foreign@example.com', true, now(), now()),
      ('suspended-sql', 'Suspended', 'suspended@example.com', true, now(), now()), ('instance-admin-sql', 'Instance admin', 'instance@example.com', true, now(), now())`;
    await sql`insert into company_memberships (company_id, principal_type, principal_id, status) values
      (${C1}, 'user', 'u-direct', 'active'), (${C1}, 'user', 'u-join', 'active'), (${C1}, 'user', 'suspended-sql', 'suspended'),
      (${C2}, 'user', 'foreign-sql', 'active')`;
    await sql`insert into instance_user_roles (user_id, role) values ('admin-unrelated', 'instance_admin'), ('instance-admin-sql', 'instance_admin')`;
    await sql`insert into activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, details) values
      (${C1}, 'user', 'u-direct', 'agent.key_created', 'agent', ${A1}, jsonb_build_object('keyId', ${K1}::text)),
      (${C1}, 'user', 'u-direct', 'agent.key_created', 'agent', ${A1}, jsonb_build_object('keyId', 'malformed-not-uuid')),
      (${C1}, 'user', 'missing-sql', 'agent.key_created', 'agent', ${A1}, jsonb_build_object('keyId', ${K5}::text)),
      (${C1}, 'user', 'foreign-sql', 'agent.key_created', 'agent', ${A1}, jsonb_build_object('keyId', ${K6}::text)),
      (${C1}, 'user', 'suspended-sql', 'agent.key_created', 'agent', ${A1}, jsonb_build_object('keyId', ${K7}::text)),
      (${C1}, 'user', 'instance-admin-sql', 'agent.key_created', 'agent', ${A1}, jsonb_build_object('keyId', ${K8}::text)),
      (${C1}, 'user', 'u-direct', 'agent.key_created', 'agent', ${A1}, jsonb_build_object('keyId', ${K9}::text)),
      (${C1}, 'user', 'u-join', 'agent.key_created', 'agent', ${A1}, jsonb_build_object('keyId', ${K9}::text))`;
    await sql`insert into invites (id, company_id, token_hash, expires_at) values
      (${I1}, ${C1}, 'claim-secret-hash-MUST-NOT-LEAK', now() + interval '1 day'), (${I2}, ${C1}, 'rejected-status-secret', now() + interval '1 day'),
      (${I3}, ${C1}, 'missing-approved-at-secret', now() + interval '1 day'), (${I4}, ${C1}, 'missing-consumed-secret', now() + interval '1 day'),
      (${I5}, ${C1}, 'wrong-approval-actor-secret', now() + interval '1 day')`;
    await sql`insert into join_requests (id, invite_id, company_id, request_type, status, request_ip, requesting_user_id, claim_secret_hash, claim_secret_consumed_at, created_agent_id, approved_by_user_id, approved_at)
      values (${J1}, ${I1}, ${C1}, 'agent', 'approved', '127.0.0.1', 'u-join', 'MUST-NOT-LEAK', now(), ${A1}, 'u-join', now()),
      (${J2}, ${I2}, ${C1}, 'agent', 'rejected', '127.0.0.1', 'u-join', 'rejected', now(), ${A1}, 'u-join', now()),
      (${J3}, ${I3}, ${C1}, 'agent', 'approved', '127.0.0.1', 'u-join', 'missing-approved-at', now(), ${A1}, 'u-join', null),
      (${J4}, ${I4}, ${C1}, 'agent', 'approved', '127.0.0.1', 'u-join', 'missing-consumed', null, ${A1}, 'u-join', now()),
      (${J5}, ${I5}, ${C1}, 'agent', 'approved', '127.0.0.1', 'u-join', 'wrong-approval-actor', now(), ${A1}, 'u-join', now())`;
    await sql`insert into activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, details) values
      (${C1}, 'user', 'u-join', 'agent_api_key.claimed', 'agent_api_key', ${K2}, jsonb_build_object('agentId', ${A1}::text, 'joinRequestId', ${J1}::text)),
      (${C1}, 'user', 'u-join', 'join.approved', 'join_request', ${J1}, '{}'::jsonb),
      (${C1}, 'user', 'u-join', 'agent_api_key.claimed', 'agent_api_key', ${K10}, jsonb_build_object('agentId', ${A1}::text, 'joinRequestId', ${J2}::text)),
      (${C1}, 'user', 'u-join', 'agent_api_key.claimed', 'agent_api_key', ${K11}, jsonb_build_object('agentId', ${A1}::text, 'joinRequestId', ${J3}::text)),
      (${C1}, 'user', 'u-join', 'agent_api_key.claimed', 'agent_api_key', ${K12}, jsonb_build_object('agentId', ${A1}::text, 'joinRequestId', ${J4}::text)),
      (${C1}, 'user', 'u-join', 'agent_api_key.claimed', 'agent_api_key', ${K13}, jsonb_build_object('agentId', ${A1}::text, 'joinRequestId', ${J5}::text)),
      (${C1}, 'user', 'u-join', 'join.approved', 'join_request', ${J2}, '{}'::jsonb),
      (${C1}, 'user', 'u-join', 'join.approved', 'join_request', ${J3}, '{}'::jsonb),
      (${C1}, 'user', 'u-join', 'join.approved', 'join_request', ${J4}, '{}'::jsonb),
      (${C1}, 'user', 'admin-unrelated', 'join.approved', 'join_request', ${J5}, '{}'::jsonb)`;
  }, 60_000);

  beforeEach(async () => {
    await sql`delete from activity_log where action like 'agent_api_key.responsibility_migration_reported%'`;
  });

  afterAll(async () => {
    await sql?.end();
    await database?.cleanup();
  });

  it("previews exact direct/join provenance deterministically without secret fields", async () => {
    const first = await previewAgentApiKeyResponsibilityReport(database.connectionString);
    const second = await previewAgentApiKeyResponsibilityReport(database.connectionString);
    expect({ ...first, generatedAt: undefined }).toEqual({ ...second, generatedAt: undefined });
    expect(first.keys.map(({ keyId, decision }) => [keyId, decision])).toEqual([
      [K1, "backfill"], [K2, "backfill"], [K3, "revoke"], [K4, "preserve_revoked"],
      [K5, "revoke"], [K6, "revoke"], [K7, "revoke"], [K8, "backfill"], [K9, "revoke"],
      [K10, "revoke"], [K11, "revoke"], [K12, "revoke"], [K13, "revoke"],
    ]);
    expect(first.keys[2]).toMatchObject({ reasonCodes: ["no_provenance"], candidates: [] });
    expect(JSON.stringify(first)).not.toMatch(/MUST-NOT-LEAK|keyHash|claimSecret|authorization|session|postgres:\/\//i);
  });

  it("uses real SQL eligibility and rejects every non-approved join variant", async () => {
    const first = await previewAgentApiKeyResponsibilityReport(database.connectionString);
    const byId = new Map(first.keys.map((key) => [key.keyId, key]));
    expect(byId.get(K5)).toMatchObject({ decision: "revoke", reasonCodes: ["no_eligible_candidate"], candidates: [{ userId: "missing-sql", eligible: false, eligibilityReasonCodes: ["user_not_found"] }] });
    expect(byId.get(K6)).toMatchObject({ candidates: [{ userId: "foreign-sql", eligible: false, eligibilityReasonCodes: ["company_membership_missing"] }] });
    expect(byId.get(K7)).toMatchObject({ candidates: [{ userId: "suspended-sql", eligible: false, eligibilityReasonCodes: ["company_membership_inactive"] }] });
    expect(byId.get(K8)).toMatchObject({ decision: "backfill", resolvedUserId: "instance-admin-sql", candidates: [{ userId: "instance-admin-sql", eligible: true, eligibilityReasonCodes: ["company_membership_missing", "instance_admin"] }] });
    expect(byId.get(K9)).toMatchObject({ decision: "revoke", reasonCodes: ["conflicting_eligible_candidates"] });
    expect(byId.get(K9)?.candidates.map((candidate) => candidate.userId)).toEqual(["u-direct", "u-join"]);
    for (const keyId of [K10, K11, K12, K13]) expect(byId.get(keyId)).toMatchObject({ decision: "revoke", reasonCodes: ["no_provenance"], candidates: [] });
  });

  it("falls back only when no exact stored receipt exists", async () => {
    const details = { schemaVersion: 1, migration: "0087_agent_api_keys_responsibility_scope", generatedAt: "2026-08-12T00:00:00.000Z", key: {} };
    await sql`insert into activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, details) values
      (${C1}, 'system', 'migration:wrong', 'agent_api_key.responsibility_migration_reported', 'agent_api_key', ${K1}, ${sql.json(details)}),
      (${C1}, 'system', 'migration:0087_agent_api_keys_responsibility_scope', 'agent_api_key.responsibility_migration_reported_wrong', 'agent_api_key', ${K1}, ${sql.json(details)})`;
    await expect(readStoredAgentApiKeyResponsibilityReceipt(database.connectionString)).rejects.toBeInstanceOf(AgentApiKeyResponsibilityReceiptNotFoundError);
    expect((await exportAgentApiKeyResponsibilityReport(database.connectionString, "auto")).mode).toBe("preview");
  });

  it("rejects malformed details, unsupported schema, and wrong migration without auto fallback", async () => {
    const insert = await sql`insert into activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, details) values
      (${C1}, 'system', 'migration:0087_agent_api_keys_responsibility_scope', 'agent_api_key.responsibility_migration_reported', 'agent_api_key', ${K1}, ${sql.json({})}) returning id`;
    const malformed = [
      {},
      { schemaVersion: 2, migration: "0087_agent_api_keys_responsibility_scope", generatedAt: "2026-08-12T00:00:00.000Z", key: {} },
      { schemaVersion: 1, migration: "wrong", generatedAt: "2026-08-12T00:00:00.000Z", key: {} },
    ];
    for (const details of malformed) {
      await sql`update activity_log set details = ${sql.json(details)} where id = ${insert[0]!.id}`;
      await expect(readStoredAgentApiKeyResponsibilityReceipt(database.connectionString)).rejects.toThrow(/malformed stored responsibility receipt/i);
    }
    await expect(exportAgentApiKeyResponsibilityReport(database.connectionString, "auto")).rejects.toThrow(/malformed stored responsibility receipt/i);
  });

  it("validates and aggregates exact stored receipts", async () => {
    const details = {
      schemaVersion: 1, migration: "0087_agent_api_keys_responsibility_scope", generatedAt: "2026-08-12T00:00:00.000Z",
      key: { keyId: K1, companyId: C1, agentId: A1, keyName: "Direct", decision: "revoke", reasonCodes: ["conflicting_eligible_candidates"], candidates: [
        { userId: "Z", sources: ["direct_key_created", "join_claim"], eligible: true, eligibilityReasonCodes: ["active_company_membership"] },
        { userId: "a", sources: ["direct_key_created"], eligible: true, eligibilityReasonCodes: ["active_company_membership"] },
      ], resolvedUserId: null, requiresOperatorAction: true },
    };
    await sql`insert into activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id, agent_id, details) values
      (${C1}, 'system', 'migration:0087_agent_api_keys_responsibility_scope', 'agent_api_key.responsibility_migration_reported', 'agent_api_key', ${K1}, ${A1}, ${sql.json(details)})`;
    const report = await readStoredAgentApiKeyResponsibilityReceipt(database.connectionString);
    expect(report).toMatchObject({ mode: "stored", generatedAt: details.generatedAt, summary: { totalKeys: 1, revokeCount: 1 }, keys: [details.key] });
    expect(report.keys[0]?.candidates.map((candidate) => candidate.userId)).toEqual(["Z", "a"]);
    expect(JSON.stringify(report)).not.toMatch(/MUST-NOT-LEAK|keyHash|claimSecret|authorization|session|postgres:\/\//i);
  });
});

describe("report CLI", () => {
  it("accepts only supported modes, emits JSON only on stdout, sanitizes errors, and always stops", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let stops = 0;
    const connectionString = "postgres://user:secret@db.example/private";
    const base = {
      resolveConnection: async () => ({ connectionString, source: "test", stop: async () => { stops += 1; } }),
      writeStdout: (value: string) => stdout.push(value),
      writeStderr: (value: string) => stderr.push(value),
    };
    const report = buildAgentApiKeyResponsibilityReport([], "preview", "2026-08-12T00:00:00.000Z");
    expect(await runAgentApiKeyResponsibilityReportCli(["--mode", "preview"], { ...base, exportReport: async (_url, mode) => { expect(mode).toBe("preview"); return report; } })).toBe(0);
    expect(stdout).toEqual([`${JSON.stringify(report, null, 2)}\n`]);
    expect(stderr).toEqual([]);
    expect(stops).toBe(1);

    stdout.length = 0;
    expect(await runAgentApiKeyResponsibilityReportCli([], { ...base, exportReport: async (_url, mode) => { expect(mode).toBe("auto"); return report; } })).toBe(0);
    expect(stdout).toEqual([`${JSON.stringify(report, null, 2)}\n`]);
    expect(stops).toBe(2);

    stdout.length = 0;
    expect(await runAgentApiKeyResponsibilityReportCli(["--mode", "stored"], { ...base, exportReport: async () => { throw new Error(`failed ${connectionString} MUST-NOT-LEAK`); } })).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).not.toContain(connectionString);
    expect(stderr.join("")).not.toContain("MUST-NOT-LEAK");
    expect(stops).toBe(3);

    expect(await runAgentApiKeyResponsibilityReportCli(["--mode", "invalid"], { ...base, exportReport: async () => report })).toBe(1);
    expect(stops).toBe(3);
  });
});

describe("reporter database boundary", () => {
  it("suppresses notices on both readers and propagates database errors, including default auto", async () => {
    const error = new Error("database failure");
    const options: Array<{ onnotice?: unknown }> = [];
    const originalLog = console.log;
    const logs: unknown[][] = [];
    console.log = (...args: unknown[]) => logs.push(args);
    const fakeFactory = ((_: string, connectionOptions: { onnotice?: unknown }) => {
      options.push(connectionOptions);
      if (typeof connectionOptions.onnotice === "function") (connectionOptions.onnotice as (notice: unknown) => void)({ message: "notice" });
      return { begin: async () => { throw error; }, end: async () => {} } as unknown as ReturnType<typeof postgres>;
    }) as unknown as typeof postgres;
    const restore = setAgentApiKeyResponsibilityPostgresFactoryForTests(fakeFactory);
    try {
      await expect(exportAgentApiKeyResponsibilityReport("postgres://test", "preview")).rejects.toBe(error);
      await expect(exportAgentApiKeyResponsibilityReport("postgres://test", "stored")).rejects.toBe(error);
      await expect(exportAgentApiKeyResponsibilityReport("postgres://test")).rejects.toBe(error);
      expect(options).toHaveLength(3);
      expect(options.every((value) => typeof value.onnotice === "function")).toBe(true);
      expect(logs).toEqual([]);
    } finally {
      restore();
      console.log = originalLog;
    }
  });
});

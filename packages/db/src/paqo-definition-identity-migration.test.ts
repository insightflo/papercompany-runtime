import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";
import { PAQO_IDS, startPaqoDefinitionIdentityDatabase } from "./paqo-definition-identity-test-fixture.js";

const { C1, M1, M2, D1, D2, D3, D4, D5 } = PAQO_IDS;
const D5_RUN = "50000000-0000-0000-0000-000000000006";
const HASH_A = "paqo-hash-aaaa";
const HASH_B = "paqo-hash-bbbb";

describe("migration 0092 PAQO workflow definition identity", () => {
  describe("fresh embedded database", () => {
    it(
      "bootstraps mission_id, definition_hash, FK, and the partial unique index",
      async () => {
        const database = await startEmbeddedPostgresTestDatabase("paqo-identity-fresh-");
        const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
        try {
          const columns = await sql<{ column_name: string; is_nullable: string }[]>`
            SELECT column_name, is_nullable FROM information_schema.columns
            WHERE table_name = 'workflow_definitions' AND column_name IN ('mission_id', 'definition_hash')
          `;
          expect(new Map(columns.map((row) => [row.column_name, row.is_nullable]))).toEqual(
            new Map([
              ["mission_id", "YES"],
              ["definition_hash", "YES"],
            ]),
          );
          const fk = await sql<{ ref_table: string; delete_rule: string }[]>`
            SELECT confrelid::regclass::text ref_table, confdeltype::text delete_rule
            FROM pg_constraint WHERE conname = 'workflow_definitions_mission_id_missions_id_fk'
          `;
          expect(fk[0]?.ref_table).toBe("missions");
          // pg confdeltype: 'a'=NO ACTION, 'r'=RESTRICT, 'c'=CASCADE, 'n'=SET NULL, 'd'=SET DEFAULT
          expect(fk[0]?.delete_rule).toBe("n");
          const index = await sql<{ indexdef: string }[]>`
            SELECT indexdef FROM pg_indexes WHERE indexname = 'workflow_definitions_paqo_identity_uq'
          `;
          expect(index[0]?.indexdef).toContain("CREATE UNIQUE INDEX");
          expect(index[0]?.indexdef).toContain("WHERE");
        } finally {
          await sql.end();
          await database.cleanup();
        }
      },
      120_000,
    );
  });

  describe("guarded legacy backfill", () => {
    let database: Awaited<ReturnType<typeof startPaqoDefinitionIdentityDatabase>>;
    let sql: ReturnType<typeof postgres>;

    beforeAll(async () => {
      database = await startPaqoDefinitionIdentityDatabase("paqo-identity-backfill-");
      sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      await database.apply0092();
    }, 120_000);

    afterAll(async () => {
      await sql?.end();
      await database?.cleanup();
    });

    it("backfills mission_id for every PAQO-named legacy definition and leaves definition_hash null", async () => {
      const rows = await sql<{ id: string; mission_id: string | null; definition_hash: string | null }[]>`
        SELECT id, mission_id::text, definition_hash FROM workflow_definitions ORDER BY id
      `;
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(D1)).toMatchObject({ mission_id: M1, definition_hash: null });
      expect(byId.get(D2)).toMatchObject({ mission_id: M1, definition_hash: null });
      expect(byId.get(D3)).toMatchObject({ mission_id: M2, definition_hash: null });
      expect(byId.get(D4)).toMatchObject({ mission_id: null, definition_hash: null });
      expect((await sql<{ count: number }[]>`SELECT count(*)::int count FROM workflow_definitions WHERE name LIKE 'PAQO WBS:%' AND mission_id IS NULL`)[0]?.count).toBe(0);
    });

    it("enforces the partial unique index only for paqo rows with non-null identity", async () => {
      await sql`
        INSERT INTO workflow_definitions (id, company_id, name, source, source_kind, mission_id, definition_hash)
        VALUES ('60000000-0000-0000-0000-000000000001', ${C1}, 'PAQO WBS: immutable one', 'native', 'paqo', ${M1}, ${HASH_A})
      `;
      await expect(sql`
        INSERT INTO workflow_definitions (id, company_id, name, source, source_kind, mission_id, definition_hash)
        VALUES ('60000000-0000-0000-0000-000000000002', ${C1}, 'PAQO WBS: immutable duplicate', 'native', 'paqo', ${M1}, ${HASH_A})
      `).rejects.toThrow(/workflow_definitions_paqo_identity_uq|unique/i);
      await sql`
        INSERT INTO workflow_definitions (id, company_id, name, source, source_kind, mission_id, definition_hash)
        VALUES ('60000000-0000-0000-0000-000000000003', ${C1}, 'PAQO WBS: null hash sibling', 'native', 'paqo', ${M1}, NULL)
      `;
      await sql`
        INSERT INTO workflow_definitions (id, company_id, name, source, source_kind, mission_id, definition_hash)
        VALUES ('60000000-0000-0000-0000-000000000004', ${C1}, 'PAQO WBS: null hash sibling two', 'native', 'paqo', ${M1}, NULL)
      `;
      await sql`
        INSERT INTO workflow_definitions (id, company_id, name, source, source_kind, mission_id, definition_hash)
        VALUES ('60000000-0000-0000-0000-000000000005', ${C1}, 'PAQO WBS: other mission same hash', 'native', 'paqo', ${M2}, ${HASH_A})
      `;
      await sql`
        INSERT INTO workflow_definitions (id, company_id, name, source, source_kind, mission_id, definition_hash)
        VALUES ('60000000-0000-0000-0000-000000000006', ${C1}, 'PAQO WBS: same mission other hash', 'native', 'paqo', ${M1}, ${HASH_B})
      `;
      await sql`
        INSERT INTO workflow_definitions (id, company_id, name, source, source_kind, mission_id, definition_hash)
        VALUES ('60000000-0000-0000-0000-000000000007', ${C1}, 'PAQO WBS: workflow kind duplicate', 'native', 'workflow', ${M1}, ${HASH_A})
      `;
    });

    it("records history and replays without changing backfilled data", async () => {
      await sql`DELETE FROM workflow_definitions WHERE id::text LIKE '60000000-%'`;
      const before = await sql<{ id: string; mission_id: string | null }[]>`
        SELECT id, mission_id::text mission_id FROM workflow_definitions ORDER BY id
      `;
      await database.reset0092HistoryOnly();
      await database.apply0092();
      const after = await sql<{ id: string; mission_id: string | null }[]>`
        SELECT id, mission_id::text mission_id FROM workflow_definitions ORDER BY id
      `;
      expect(after).toEqual(before);
    });

    it("nulls mission_id when the referenced mission is deleted", async () => {
      await sql`DELETE FROM missions WHERE id = ${M2}`;
      expect(
        (await sql<{ mission_id: string | null }[]>`SELECT mission_id::text mission_id FROM workflow_definitions WHERE id = ${D3}`)[0]?.mission_id,
      ).toBeNull();
    });
  });

  describe("guard failures roll back the migration atomically", () => {
    let database: Awaited<ReturnType<typeof startPaqoDefinitionIdentityDatabase>>;
    let sql: ReturnType<typeof postgres>;

    beforeAll(async () => {
      database = await startPaqoDefinitionIdentityDatabase("paqo-identity-guard-");
      sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    }, 120_000);

    afterAll(async () => {
      await sql?.end();
      await database?.cleanup();
    });

    async function legacyColumnsPresent(): Promise<boolean> {
      const rows = await sql<{ count: number }[]>`
        SELECT count(*)::int count FROM information_schema.columns
        WHERE table_name = 'workflow_definitions' AND column_name IN ('mission_id', 'definition_hash')
      `;
      return (rows[0]?.count ?? 0) === 0;
    }

    it("fails on a zero-run PAQO definition and leaves no schema or history trace", async () => {
      await sql`DELETE FROM workflow_runs WHERE id = ${D5_RUN}`;
      await expect(database.apply0092()).rejects.toThrow(/0092.*exactly one distinct/i);
      expect(await legacyColumnsPresent()).toBe(true);
      expect(
        (await sql<{ count: number }[]>`SELECT count(*)::int count FROM pg_indexes WHERE indexname = 'workflow_definitions_paqo_identity_uq'`)[0]?.count,
      ).toBe(0);
    });

    it("fails when every run of a PAQO definition has a null mission", async () => {
      await sql`
        INSERT INTO workflow_runs (id, workflow_id, company_id, mission_id, status, triggered_by)
        VALUES ('70000000-0000-0000-0000-000000000001', ${D5}, ${C1}, NULL, 'completed', 'agent')
      `;
      await expect(database.apply0092()).rejects.toThrow(/0092.*exactly one distinct/i);
      expect(await legacyColumnsPresent()).toBe(true);
    });

    it("fails when a PAQO definition resolves to two distinct missions", async () => {
      await sql`UPDATE workflow_runs SET mission_id = ${M1} WHERE id = '70000000-0000-0000-0000-000000000001'`;
      await sql`
        INSERT INTO workflow_runs (id, workflow_id, company_id, mission_id, status, triggered_by)
        VALUES ('70000000-0000-0000-0000-000000000002', ${D5}, ${C1}, ${M2}, 'completed', 'agent')
      `;
      await expect(database.apply0092()).rejects.toThrow(/0092.*exactly one distinct/i);
      expect(await legacyColumnsPresent()).toBe(true);
    });

    it("succeeds and backfills once the ambiguity is removed", async () => {
      await sql`DELETE FROM workflow_runs WHERE id = '70000000-0000-0000-0000-000000000002'`;
      await database.apply0092();
      expect(
        (await sql<{ mission_id: string | null }[]>`SELECT mission_id::text mission_id FROM workflow_definitions WHERE id = ${D5}`)[0]?.mission_id,
      ).toBe(M1);
      expect(
        (await sql<{ count: number }[]>`SELECT count(*)::int count FROM workflow_definitions WHERE name LIKE 'PAQO WBS:%' AND mission_id IS NULL`)[0]?.count,
      ).toBe(0);
    });
  });
});

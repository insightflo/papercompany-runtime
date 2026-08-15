import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import {
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type Db,
} from "@paperclipai/db";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("0091 env split migration", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-0091-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values([
      { id: "10000000-0000-0000-0000-000000000001", name: "Mig Co", issuePrefix: "MG" },
      { id: "10000000-0000-0000-0000-000000000002", name: "Mig Co 2", issuePrefix: "M2" },
      { id: "10000000-0000-0000-0000-000000000003", name: "Mig Co 3", issuePrefix: "M3" },
    ]);
    await db.execute(sql`
      INSERT INTO agents (id, company_id, name, adapter_type, adapter_config, agent_config) VALUES
        ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Mixed',
         'codex_local',
         '{"model": "gpt-5", "env": {"CODEX_HOME": "/codex", "HOME": "/h", "PATH": "/bin", "PAPERCLIP_API_URL": "https://a", "INFLO": "x"}}'::jsonb,
         '{}'::jsonb),
        ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'IntentOnly',
         'claude_local',
         '{"model": "opus", "env": {"ANTHROPIC_API_KEY": "sk-1"}}'::jsonb,
         '{}'::jsonb),
        ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003', 'EngineOnly',
         'codex_local',
         '{"model": "gpt-5", "env": {"CODEX_HOME": "/codex"}}'::jsonb,
         '{}'::jsonb),
        ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'Collision',
         'claude_local',
         '{"model": "opus", "env": {"KEY": "from-adapter", "ONLY_ADAPTER": "a", "HOME": "/h"}}'::jsonb,
         '{"env": {"KEY": "from-agent"}, "cwd": "/work"}'::jsonb),
        ('20000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', 'NoEnv',
         'claude_local',
         '{"model": "opus"}'::jsonb,
         '{"cwd": "/work"}'::jsonb)
    `);
    const migration = await readFile(
      fileURLToPath(new URL("../../../packages/db/src/migrations/0091_agent_env_split.sql", import.meta.url)),
      "utf8",
    );
    await db.execute(sql.raw(migration));
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function fetchAgent(id: string) {
    const rows = await db.execute(
      sql`SELECT adapter_config, agent_config FROM agents WHERE id = ${id}`,
    );
    return rows[0] as { adapter_config: unknown; agent_config: unknown } | undefined;
  }

  it("moves intent entries into agent_config.env and keeps engine entries in adapter_config.env", async () => {
    const row = await fetchAgent("20000000-0000-0000-0000-000000000001");
    expect(row?.adapter_config).toEqual({
      model: "gpt-5",
      env: { CODEX_HOME: "/codex", HOME: "/h", PATH: "/bin" },
    });
    expect(row?.agent_config).toEqual({
      env: { PAPERCLIP_API_URL: "https://a", INFLO: "x" },
    });
  });

  it("removes adapter_config.env entirely when no engine entries remain", async () => {
    const row = await fetchAgent("20000000-0000-0000-0000-000000000002");
    expect(row?.adapter_config).toEqual({ model: "opus" });
    expect(row?.agent_config).toEqual({ env: { ANTHROPIC_API_KEY: "sk-1" } });
  });

  it("keeps engine-only env in adapter_config and leaves agent_config without env", async () => {
    const row = await fetchAgent("20000000-0000-0000-0000-000000000003");
    expect(row?.adapter_config).toEqual({ model: "gpt-5", env: { CODEX_HOME: "/codex" } });
    expect(row?.agent_config).toEqual({});
  });

  it("env-key merges into existing agent_config.env with the existing entry winning", async () => {
    const row = await fetchAgent("20000000-0000-0000-0000-000000000004");
    expect(row?.adapter_config).toEqual({ model: "opus", env: { HOME: "/h" } });
    expect(row?.agent_config).toEqual({
      cwd: "/work",
      env: { KEY: "from-agent", ONLY_ADAPTER: "a" },
    });
  });

  it("leaves rows without env untouched", async () => {
    const row = await fetchAgent("20000000-0000-0000-0000-000000000005");
    expect(row?.adapter_config).toEqual({ model: "opus" });
    expect(row?.agent_config).toEqual({ cwd: "/work" });
  });
});

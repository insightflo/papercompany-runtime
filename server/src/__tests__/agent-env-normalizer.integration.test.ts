import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping agent env normalizer integration tests: ${support.reason ?? "unsupported environment"}`);
}

describeDb("agentService env split normalizer", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-env-normalizer-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Env Co ${companyId.slice(0, 8)}`,
      issuePrefix: `EV${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return companyId;
  }

  async function fetchAgent(agentId: string) {
    return db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0] ?? null);
  }

  it("create: env-key merges explicit agentConfig.env over intent env from adapterConfig", async () => {
    const svc = agentService(db);
    const companyId = await seedCompany();

    const created = await svc.create(companyId, {
      name: "Explicit Env Agent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: { env: { KEY: "from-adapter", ENGINE_ONLY: "gone", HOME: "/h" } },
      agentConfig: { env: { KEY: "from-explicit", OTHER: "kept" } },
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const row = await fetchAgent(created.id);
    expect(row?.adapterConfig).toEqual({ env: { HOME: "/h" } });
    expect(row?.agentConfig).toEqual({ env: { KEY: "from-explicit", OTHER: "kept", ENGINE_ONLY: "gone" } });
  });

  it("update (a): an env-bearing adapterConfig is authoritative for both env halves and propagates deletions", async () => {
    const svc = agentService(db);
    const companyId = await seedCompany();

    const created = await svc.create(companyId, {
      name: "Env Authoritative",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {
        model: "claude-opus-4-6",
        env: { HOME: "/home", CODEX_HOME: "/codex", KEY: "old", OTHER: "keep" },
      },
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    // Incoming env drops KEY, keeps OTHER, and swaps the engine half.
    await svc.update(created.id, {
      adapterConfig: {
        model: "claude-opus-4-6",
        env: { HOME: "/new-home", OTHER: "keep" },
      },
    });

    const row = await fetchAgent(created.id);
    expect(row?.adapterConfig).toEqual({ model: "claude-opus-4-6", env: { HOME: "/new-home" } });
    expect(row?.agentConfig).toEqual({ env: { OTHER: "keep" } });
  });

  it("update (a): an env-bearing patch with no intent entries removes agentConfig.env", async () => {
    const svc = agentService(db);
    const companyId = await seedCompany();

    const created = await svc.create(companyId, {
      name: "Env Clear",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: { model: "claude-opus-4-6", env: { KEY: "v", HOME: "/h" } },
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    await svc.update(created.id, {
      adapterConfig: { model: "claude-opus-4-6", env: { HOME: "/h" } },
    });

    const row = await fetchAgent(created.id);
    expect(row?.adapterConfig).toEqual({ model: "claude-opus-4-6", env: { HOME: "/h" } });
    expect(row?.agentConfig).toEqual({});
  });

  it("update (b): adapterType switch without env drops engine env and preserves intent env", async () => {
    const svc = agentService(db);
    const companyId = await seedCompany();

    const created = await svc.create(companyId, {
      name: "Env Switch",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {
        model: "gpt-5",
        env: { CODEX_HOME: "/codex", HOME: "/h", PAPERCLIP_API_URL: "https://api.example" },
      },
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    await svc.update(created.id, {
      adapterType: "claude_local",
      adapterConfig: { model: "claude-opus-4-6" },
    });

    const row = await fetchAgent(created.id);
    expect(row?.adapterConfig).toEqual({ model: "claude-opus-4-6" });
    expect(row?.agentConfig).toEqual({ env: { PAPERCLIP_API_URL: "https://api.example" } });
  });

  it("update (b): same adapterType without env leaves both env halves untouched", async () => {
    const svc = agentService(db);
    const companyId = await seedCompany();

    const created = await svc.create(companyId, {
      name: "Env Untouched",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5", env: { CODEX_HOME: "/codex", KEY: "v" } },
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    await svc.update(created.id, { adapterConfig: { model: "gpt-5-codex" } });

    const row = await fetchAgent(created.id);
    expect(row?.adapterConfig).toEqual({ model: "gpt-5-codex", env: { CODEX_HOME: "/codex" } });
    expect(row?.agentConfig).toEqual({ env: { KEY: "v" } });
  });

  it("update (c): explicit agentConfig restores verbatim (rollback path)", async () => {
    const svc = agentService(db);
    const companyId = await seedCompany();

    const created = await svc.create(companyId, {
      name: "Rollback Agent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: { model: "claude-opus-4-6", env: { KEY: "new", HOME: "/h" } },
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    await svc.update(created.id, {
      adapterConfig: { model: "claude-opus-4-6", env: { KEY: "new", HOME: "/h" } },
      agentConfig: { env: { KEY: "old" }, cwd: "/old-work" },
    });

    const row = await fetchAgent(created.id);
    expect(row?.adapterConfig).toEqual({ model: "claude-opus-4-6", env: { HOME: "/h" } });
    expect(row?.agentConfig).toEqual({ env: { KEY: "old" }, cwd: "/old-work" });
  });
});

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
  console.warn(`Skipping agent config normalizer integration tests: ${support.reason ?? "unsupported environment"}`);
}

const ALL_AGENT_KEYS = {
  cwd: "/work",
  instructionsFilePath: "/tmp/AGENTS.md",
  instructionsBundleMode: "managed",
  instructionsRootPath: "/tmp/instructions",
  instructionsEntryFile: "AGENTS.md",
  promptTemplate: "You are an agent.",
  bootstrapPromptTemplate: "Bootstrap.",
  paperclipSkillSync: { desiredSkills: ["paperclip"] },
  agentsMdPath: "/tmp/agents.md",
};

describeDb("agentService config normalizer", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-config-normalizer-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Normalizer Co ${companyId.slice(0, 8)}`,
      issuePrefix: `NC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return companyId;
  }

  async function fetchAgent(agentId: string) {
    return db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0] ?? null);
  }

  it("create: splits the 9 agent keys into agentConfig and persists only engine keys in adapterConfig", async () => {
    const svc = agentService(db);
    const companyId = await seedCompany();

    const created = await svc.create(companyId, {
      name: "Split Agent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {
        ...ALL_AGENT_KEYS,
        model: "claude-opus-4-6",
        command: "/usr/local/bin/claude",
        env: { KEY: "v" },
      },
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const row = await fetchAgent(created.id);
    expect(row?.adapterConfig).toEqual({
      model: "claude-opus-4-6",
      command: "/usr/local/bin/claude",
      env: { KEY: "v" },
    });
    expect(row?.agentConfig).toEqual(ALL_AGENT_KEYS);
  });

  it("update with engine-only adapterConfig preserves existing agentConfig (adapter switch)", async () => {
    const svc = agentService(db);
    const companyId = await seedCompany();

    const created = await svc.create(companyId, {
      name: "Switch Agent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: { ...ALL_AGENT_KEYS, model: "claude-opus-4-6" },
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const updated = await svc.update(created.id, {
      adapterType: "codex_local",
      adapterConfig: {
        model: "gpt-5",
        dangerouslyBypassApprovalsAndSandbox: true,
      },
    });
    expect(updated).not.toBeNull();

    const row = await fetchAgent(created.id);
    expect(row?.adapterConfig).toEqual({
      model: "gpt-5",
      dangerouslyBypassApprovalsAndSandbox: true,
    });
    expect(row?.agentConfig).toEqual(ALL_AGENT_KEYS);
  });

  it("update with an agent-level key lands it in agentConfig and removes it from adapterConfig", async () => {
    const svc = agentService(db);
    const companyId = await seedCompany();

    const created = await svc.create(companyId, {
      name: "Edit Agent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: { model: "claude-opus-4-6" },
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    await svc.update(created.id, {
      adapterConfig: { model: "claude-opus-4-6", cwd: "/new-work" },
    });

    const row = await fetchAgent(created.id);
    expect(row?.adapterConfig).toEqual({ model: "claude-opus-4-6" });
    expect(row?.agentConfig).toEqual({ cwd: "/new-work" });
  });

  it("update with an agent-level key treats the incoming merged config as authoritative for deletions", async () => {
    const svc = agentService(db);
    const companyId = await seedCompany();

    const created = await svc.create(companyId, {
      name: "Delete Agent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {
        model: "claude-opus-4-6",
        cwd: "/work",
        promptTemplate: "Old prompt.",
        paperclipSkillSync: { desiredSkills: ["paperclip"] },
      },
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    // Mirrors clearLegacyPromptTemplate: the RMW helper deletes promptTemplate
    // from the merged config and persists the remainder.
    await svc.update(created.id, {
      adapterConfig: {
        model: "claude-opus-4-6",
        cwd: "/work",
        paperclipSkillSync: { desiredSkills: ["paperclip"] },
      },
    });

    const row = await fetchAgent(created.id);
    expect(row?.adapterConfig).toEqual({ model: "claude-opus-4-6" });
    expect(row?.agentConfig).toEqual({
      cwd: "/work",
      paperclipSkillSync: { desiredSkills: ["paperclip"] },
    });
  });

  it("update without adapterConfig leaves both config columns untouched", async () => {
    const svc = agentService(db);
    const companyId = await seedCompany();

    const created = await svc.create(companyId, {
      name: "Rename Agent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: { ...ALL_AGENT_KEYS, model: "claude-opus-4-6" },
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    await svc.update(created.id, { title: "Renamed" });

    const row = await fetchAgent(created.id);
    expect(row?.title).toBe("Renamed");
    expect(row?.adapterConfig).toEqual({ model: "claude-opus-4-6" });
    expect(row?.agentConfig).toEqual(ALL_AGENT_KEYS);
  });
});

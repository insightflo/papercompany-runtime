import { randomUUID } from "node:crypto";
import {
  agentToolGrants,
  agents,
  companies,
  createDb,
  toolDefinitions,
} from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  listCompanyExecutionCandidates,
  formatCandidateRosterLines,
  candidateRosterFingerprint,
} from "../services/missions/mission-execution-candidates.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const sup = await getEmbeddedPostgresTestSupport();
const describeEP = sup.supported ? describe : describe.skip;
if (!sup.supported) console.warn(`skip mission-execution-candidates: ${sup.reason ?? "unsupported"}`);

describeEP("mission-execution-candidates", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => { tempDb = await startEmbeddedPostgresTestDatabase("paperclip-candidates-"); db = createDb(tempDb.connectionString); }, 60_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  async function seed() {
    const companyId = randomUUID();
    const workerId = randomUUID();
    const liaisonId = randomUUID();
    const toolId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cand Co", issuePrefix: `CD${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: workerId, companyId, name: "Synthesis Editor", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: liaisonId, companyId, name: "Hermes Operations Manager", role: "general", status: "active", adapterType: "hermes_local", adapterConfig: {}, runtimeConfig: { operatingMode: "chief_of_staff_liaison" }, permissions: {} },
    ]);
    await db.insert(toolDefinitions).values({
      id: toolId,
      companyId,
      name: "manual-onboarding-publish",
      description: "Publish a manual onboarding entry.",
      adapterType: "builtin",
      adapterConfig: {},
      enabled: true,
    });
    await db.insert(agentToolGrants).values({ id: randomUUID(), companyId, agentId: workerId, toolId, grantedBy: "test" });
    return { companyId, workerId, liaisonId, toolName: "manual-onboarding-publish" };
  }

  it("listCompanyExecutionCandidates excludes liaison, includes enabled granted toolNames", async () => {
    const s = await seed();
    const candidates = await listCompanyExecutionCandidates(db, s.companyId);
    const ids = candidates.map((c) => c.agentId);
    expect(ids).toContain(s.workerId);
    expect(ids).not.toContain(s.liaisonId);
    const worker = candidates.find((c) => c.agentId === s.workerId)!;
    expect(worker.toolNames).toEqual([s.toolName]);
  });

  it("formatCandidateRosterLines includes toolNames + skills + owner marker", () => {
    const lines = formatCandidateRosterLines(
      [{ agentId: "a1", name: "Editor", role: "engineer", capabilities: null, desiredSkillKeys: ["research"], toolNames: ["publish-tool"] }],
      "a1",
    );
    expect(lines[0]).toContain("tools=publish-tool");
    expect(lines[0]).toContain("skills=research");
    expect(lines[0]).toContain("[mission owner]");
  });

  it("candidateRosterFingerprint stays stable for the same roster and changes with prompt-relevant authority", () => {
    const base = [{ agentId: "a1", name: "n", role: "r", capabilities: null, desiredSkillKeys: [], toolNames: ["t1"] }];
    const fp1 = candidateRosterFingerprint(base);
    const fp2 = candidateRosterFingerprint([{ agentId: "a1", name: "n", role: "r", capabilities: null, desiredSkillKeys: [], toolNames: ["t1"] }]);
    const fpChanged = candidateRosterFingerprint([{ agentId: "a1", name: "n", role: "r", capabilities: null, desiredSkillKeys: [], toolNames: ["t2"] }]);
    const roleChanged = candidateRosterFingerprint([{ agentId: "a1", name: "n", role: "reviewer", capabilities: null, desiredSkillKeys: [], toolNames: ["t1"] }]);
    expect(fp1).toBe(fp2);
    expect(fp1).not.toBe(fpChanged);
    expect(fp1).not.toBe(roleChanged);
  });
});

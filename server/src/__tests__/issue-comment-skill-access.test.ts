import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readPaperclipRuntimeSkillEntries } from "@paperclipai/adapter-utils/server-utils";
import { ensurePiSkillsInjected } from "../../../packages/adapters/pi-local/src/server/execute.js";
import { ensureCodexSkillsInjected } from "@paperclipai/adapter-codex-local/server";
import { readLocalSkillImportFromDirectory } from "../services/company-skills.js";
import { evaluateContextBudgetPreflight } from "../services/context-budget-preflight.js";

// Missing distribution, wrong required/key metadata, or broken injection must fail here.
describe("bundled im-human runtime access", () => {
  it("keeps the reference within the unchanged 200-token startup budget", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "issue-comment-budget-"));
    try {
      const instructionsFilePath = path.join(root, "AGENTS.md");
      await fs.writeFile(instructionsFilePath, "Be concise.\n");
      const result = await evaluateContextBudgetPreflight({
        runtimeConfig: { heartbeat: { contextBudgetPreflight: { maxEstimatedTokens: 200 } } },
        adapterConfig: {
          promptTemplate: "Follow the paperclip heartbeat.",
          bootstrapPromptTemplate: "Bootstrap once.", instructionsFilePath,
        },
        context: { issueId: "issue-1" }, hasResumableSession: false,
        adapterType: "codex_local",
        agent: { id: "agent-1", companyId: "company-1", name: "Agent One", role: "engineer" },
        runId: "run-1", cwd: root,
      });
      expect(result).toMatchObject({ blocked: false, reason: null });
      expect(result.estimate.instructionsChars).toBeGreaterThan(0);
      expect(result.estimate.renderedBootstrapPromptChars).toBeGreaterThan(0);
      console.info(`200-token budget proof: ${JSON.stringify(result)}`);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("discovers, imports and reads the actual bundled skill through isolated Pi and Codex homes", async () => {
    const moduleDir = path.resolve("packages/adapters/pi-local/src/server");
    const entries = await readPaperclipRuntimeSkillEntries({}, moduleDir);
    const skill = entries.find((entry) => entry.key === "paperclipai/paperclip/im-human");
    expect(skill).toMatchObject({ runtimeName: "im-human", required: true });
    if (!skill) throw new Error("Bundled im-human is unavailable");
    expect(skill.source).toBe(path.resolve("skills/im-human"));
    const imported = await readLocalSkillImportFromDirectory("isolated-company", skill.source, {
      metadata: { sourceKind: "paperclip_bundled" },
    });
    expect(imported.key).toBe("paperclipai/paperclip/im-human");
    expect(imported.metadata).toMatchObject({ sourceKind: "paperclip_bundled" });
    const configured = await readPaperclipRuntimeSkillEntries({ paperclipRuntimeSkills: [skill] }, moduleDir);
    expect(configured).toEqual([skill]);

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "issue-comment-skill-access-"));
    try {
      const piHome = path.join(root, "pi-skills");
      const codexHome = path.join(root, "codex-skills");
      await ensurePiSkillsInjected(async () => {}, piHome, configured, [skill.key]);
      await ensureCodexSkillsInjected(async () => {}, { skillsHome: codexHome, skillsEntries: configured });
      const source = await fs.readFile(path.join(skill.source, "SKILL.md"), "utf8");
      for (const home of [piHome, codexHome]) {
        const target = path.join(home, "im-human", "SKILL.md");
        expect(await fs.readFile(target, "utf8")).toBe(source);
        expect(await fs.realpath(target)).toBe(await fs.realpath(path.join(skill.source, "SKILL.md")));
        console.info(`im-human readback: ${target} -> ${await fs.realpath(target)}`);
      }
      // Preserve the old meaningful readability contracts in the on-demand detail,
      // rather than keeping them in every prompt. This does not prove LLM compliance.
      for (const rule of [
        "status → reason/impact → next action → necessary evidence",
        "A request or queued wakeup is not proof of execution",
        "readable label plus the original identifier",
        "easy Korean honorific prose",
        "never use comment prose as execution authority",
      ]) expect(source).toContain(rule);
      expect(source).toContain("company language");
      expect(source).toContain("machine markers, IDs, links, code, JSON, quoted evidence");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

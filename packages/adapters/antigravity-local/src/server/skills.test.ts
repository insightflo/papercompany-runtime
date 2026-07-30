import { describe, expect, it } from "vitest";
import type { AdapterSkillContext } from "@paperclipai/adapter-utils";
import {
  buildAntigravitySkillPrompt,
  listAntigravitySkills,
  resolveAntigravitySkillPrompt,
  syncAntigravitySkills,
} from "./skills.js";

function ctxWith(config: Record<string, unknown>): AdapterSkillContext {
  return {
    agentId: "agent-1",
    companyId: "company-1",
    adapterType: "antigravity_local",
    config,
  };
}

const SKILL_CONFIG: Record<string, unknown> = {
  paperclipRuntimeSkills: [
    {
      key: "paperclipai/paperclip/paperclip",
      runtimeName: "paperclip",
      source: "/srv/skills/paperclip",
      required: true,
      requiredReason: "Bundled Paperclip skills are always available.",
    },
    {
      key: "paperclipai/paperclip/research",
      runtimeName: "research",
      source: "/srv/skills/research",
      required: false,
    },
    {
      key: "paperclipai/paperclip/scout",
      runtimeName: "scout",
      source: "/srv/skills/scout",
      required: false,
    },
  ],
  paperclipSkillSync: { desiredSkills: ["research"] },
};

describe("buildAntigravitySkillPrompt", () => {
  it("returns an empty string when no skills are selected", () => {
    expect(buildAntigravitySkillPrompt([])).toBe("");
  });

  it("emits an on-demand catalog pointing at each selected SKILL.md", () => {
    const prompt = buildAntigravitySkillPrompt([
      { key: "paperclipai/paperclip/research", runtimeName: "research", source: "/srv/skills/research" },
    ]);
    expect(prompt).toContain("## Papercompany skills");
    expect(prompt).toContain("- paperclipai/paperclip/research: /srv/skills/research/SKILL.md");
    expect(prompt).toMatch(/not automatically loaded/i);
    expect(prompt).toMatch(/do not read unrelated skills/i);
  });

  it("lists every selected entry and nothing else", () => {
    const prompt = buildAntigravitySkillPrompt([
      { key: "a/b/one", runtimeName: "one", source: "/s/one" },
      { key: "a/b/two", runtimeName: "two", source: "/s/two" },
    ]);
    expect(prompt).toContain("/s/one/SKILL.md");
    expect(prompt).toContain("/s/two/SKILL.md");
    expect(prompt).not.toContain("/s/three/SKILL.md");
  });
});

describe("resolveAntigravitySkillPrompt", () => {
  it("only includes desired (selected + required) skills, never unselected ones", async () => {
    const prompt = await resolveAntigravitySkillPrompt(SKILL_CONFIG);
    // Required paperclip + selected research are included; scout is not.
    expect(prompt).toContain("/srv/skills/paperclip/SKILL.md");
    expect(prompt).toContain("/srv/skills/research/SKILL.md");
    expect(prompt).not.toContain("/srv/skills/scout/SKILL.md");
  });

  it("returns an empty prompt when no skills are desired", async () => {
    const unselectedOnly = {
      paperclipRuntimeSkills: [
        { key: "a/b/scout", runtimeName: "scout", source: "/srv/skills/scout", required: false },
      ],
      paperclipSkillSync: { desiredSkills: [] },
    };
    expect(await resolveAntigravitySkillPrompt(unselectedOnly)).toBe("");
  });
});

describe("listAntigravitySkills", () => {
  it("reports an ephemeral, supported snapshot that preserves desired resolution", async () => {
    const snapshot = await listAntigravitySkills(ctxWith(SKILL_CONFIG));

    expect(snapshot.adapterType).toBe("antigravity_local");
    expect(snapshot.supported).toBe(true);
    expect(snapshot.mode).toBe("ephemeral");
    // Required skill is always desired; explicit selection adds research; scout stays unselected.
    expect(snapshot.desiredSkills).toEqual([
      "paperclipai/paperclip/paperclip",
      "paperclipai/paperclip/research",
    ]);

    const byKey = new Map(snapshot.entries.map((entry) => [entry.key, entry]));
    expect(snapshot.entries).toHaveLength(3);

    const paperclip = byKey.get("paperclipai/paperclip/paperclip");
    expect(paperclip?.desired).toBe(true);
    expect(paperclip?.state).toBe("configured");
    expect(paperclip?.origin).toBe("paperclip_required");
    expect(paperclip?.required).toBe(true);

    const research = byKey.get("paperclipai/paperclip/research");
    expect(research?.desired).toBe(true);
    expect(research?.state).toBe("configured");
    expect(research?.origin).toBe("company_managed");

    const scout = byKey.get("paperclipai/paperclip/scout");
    expect(scout?.desired).toBe(false);
    expect(scout?.state).toBe("available");
  });

  it("never materializes into a shared global skills directory", async () => {
    const snapshot = await listAntigravitySkills(ctxWith(SKILL_CONFIG));
    expect(snapshot.entries.every((entry) => entry.targetPath === null)).toBe(true);
    expect(snapshot.warnings.join("\n")).toMatch(/no shared global skills directory is modified/i);
  });
});

describe("syncAntigravitySkills", () => {
  it("ignores the requested list and recomputes selection from the agent config", async () => {
    // Requesting the unselected scout must NOT make it desired; selection is
    // durable on the config and delivered per-run, with no directory mutation.
    const snapshot = await syncAntigravitySkills(
      ctxWith(SKILL_CONFIG),
      ["paperclipai/paperclip/scout"],
    );

    expect(snapshot.mode).toBe("ephemeral");
    expect(snapshot.desiredSkills).toEqual([
      "paperclipai/paperclip/paperclip",
      "paperclipai/paperclip/research",
    ]);
    const scout = snapshot.entries.find((entry) => entry.key === "paperclipai/paperclip/scout");
    expect(scout?.desired).toBe(false);
    expect(scout?.state).toBe("available");
  });
});

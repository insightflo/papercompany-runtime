import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { registerCompanyPortabilityImportCases } from "./helpers/company-portability-import-cases.js";
import { companySvc, agentSvc, accessSvc, projectSvc, issueSvc, companySkillSvc, assetSvc, agentInstructionsSvc, asTextFile, paperclipKey } from "./helpers/company-portability-fixtures.js";


vi.mock("../services/companies.js", () => ({
  companyService: () => companySvc,
}));

vi.mock("../services/agents.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/agents.js")>();
  return {
    ...actual,
    agentService: () => agentSvc,
  };
});

vi.mock("../services/access.js", () => ({
  accessService: () => accessSvc,
}));

vi.mock("../services/projects.js", () => ({
  projectService: () => projectSvc,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => issueSvc,
}));

vi.mock("../services/company-skills.js", () => ({
  companySkillService: () => companySkillSvc,
}));

vi.mock("../services/assets.js", () => ({
  assetService: () => assetSvc,
}));

vi.mock("../services/agent-instructions.js", () => ({
  agentInstructionsService: () => agentInstructionsSvc,
}));

vi.mock("../routes/org-chart-svg.js", () => ({
  renderOrgChartPng: vi.fn(async () => Buffer.from("png")),
}));

const { companyPortabilityService, parseGitHubSourceUrl } = await import("../services/company-portability.js");


describe("company portability", () => {

  it("parses canonical GitHub import URLs with explicit ref and package path", () => {
    expect(
      parseGitHubSourceUrl("https://github.com/paperclipai/companies?ref=feature%2Fdemo&path=gstack"),
    ).toEqual({
      owner: "paperclipai",
      repo: "companies",
      ref: "feature/demo",
      basePath: "gstack",
      companyPath: "gstack/COMPANY.md",
    });
  });

  it("parses canonical GitHub import URLs with explicit companyPath", () => {
    expect(
      parseGitHubSourceUrl(
        "https://github.com/paperclipai/companies?ref=abc123&companyPath=gstack%2FCOMPANY.md",
      ),
    ).toEqual({
      owner: "paperclipai",
      repo: "companies",
      ref: "abc123",
      basePath: "gstack",
      companyPath: "gstack/COMPANY.md",
    });
  });

  it("exports referenced skills as stubs by default with sanitized Paperclip extension data", async () => {
    const portability = companyPortabilityService({} as any);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
    });

    expect(asTextFile(exported.files["COMPANY.md"])).toContain('name: "Paperclip"');
    expect(asTextFile(exported.files["COMPANY.md"])).toContain('schema: "agentcompanies/v1"');
    expect(asTextFile(exported.files["agents/claudecoder/AGENTS.md"])).toContain("You are ClaudeCoder.");
    expect(asTextFile(exported.files["agents/claudecoder/AGENTS.md"])).toContain("skills:");
    expect(asTextFile(exported.files["agents/claudecoder/AGENTS.md"])).toContain(`- "${paperclipKey}"`);
    expect(asTextFile(exported.files["agents/cmo/AGENTS.md"])).not.toContain("skills:");
    expect(asTextFile(exported.files["skills/paperclipai/paperclip/paperclip/SKILL.md"])).toContain("metadata:");
    expect(asTextFile(exported.files["skills/paperclipai/paperclip/paperclip/SKILL.md"])).toContain('kind: "github-dir"');
    expect(exported.files["skills/paperclipai/paperclip/paperclip/references/api.md"]).toBeUndefined();
    expect(asTextFile(exported.files["skills/company/PAP/company-playbook/SKILL.md"])).toContain("# Company Playbook");
    expect(asTextFile(exported.files["skills/company/PAP/company-playbook/references/checklist.md"])).toContain("# Checklist");

    const extension = asTextFile(exported.files[".paperclip.yaml"]);
    expect(extension).toContain('schema: "paperclip/v1"');
    expect(extension).not.toContain("promptTemplate");
    expect(extension).not.toContain("instructionsFilePath");
    expect(extension).not.toContain("agentsMdPath");
    expect(extension).not.toContain("cwd");
    expect(extension).not.toContain("command:");
    expect(extension).not.toContain("secretId");
    expect(extension).not.toContain('type: "secret_ref"');
    expect(extension).toContain("inputs:");
    expect(extension).toContain("ANTHROPIC_API_KEY:");
    expect(extension).toContain('requirement: "optional"');
    expect(extension).toContain('default: ""');
    expect(extension).not.toContain("paperclipSkillSync");
    expect(extension).not.toContain("PATH:");
    expect(extension).not.toContain("requireBoardApprovalForNewAgents: true");
    expect(extension).not.toContain("budgetMonthlyCents: 0");
    expect(exported.warnings).toContain("Agent claudecoder command /Users/dotta/.local/bin/claude was omitted from export because it is system-dependent.");
    expect(exported.warnings).toContain("Agent claudecoder PATH override was omitted from export because it is system-dependent.");
  });

  it("expands referenced skills when requested", async () => {
    const portability = companyPortabilityService({} as any);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
      expandReferencedSkills: true,
    });

    expect(asTextFile(exported.files["skills/paperclipai/paperclip/paperclip/SKILL.md"])).toContain("# Paperclip");
    expect(asTextFile(exported.files["skills/paperclipai/paperclip/paperclip/SKILL.md"])).toContain("metadata:");
    expect(asTextFile(exported.files["skills/paperclipai/paperclip/paperclip/references/api.md"])).toContain("# API");
  });

  it("keeps exporting a stored skill whose SKILL.md has malformed YAML and warns", async () => {
    const portability = companyPortabilityService({} as any);
    const malformed = "---\nname: paperclip\nskills: [plan\n---\n\n# Paperclip\n";
    const previousReadFile = companySkillSvc.readFile.getMockImplementation();
    companySkillSvc.readFile.mockImplementation(async (companyId: string, skillId: string, relativePath: string) => {
      const detail = await previousReadFile?.(companyId, skillId, relativePath);
      if (detail && skillId === "skill-1" && relativePath === "SKILL.md") {
        return { ...detail, content: malformed };
      }
      return detail;
    });

    try {
      const exported = await portability.exportBundle("company-1", {
        include: {
          company: true,
          agents: true,
          projects: false,
          issues: false,
        },
        expandReferencedSkills: true,
      });

      expect(asTextFile(exported.files[`skills/${paperclipKey}/SKILL.md`])).toBe(malformed);
      expect(exported.warnings).toEqual(expect.arrayContaining([
        expect.stringContaining(`Skill ${paperclipKey} SKILL.md has invalid YAML frontmatter`),
      ]));
    } finally {
      companySkillSvc.readFile.mockImplementation(previousReadFile);
    }
  });

  it("exports only selected skills when skills filter is provided", async () => {
    const portability = companyPortabilityService({} as any);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
      skills: ["company-playbook"],
    });

    expect(exported.files["skills/company/PAP/company-playbook/SKILL.md"]).toBeDefined();
    expect(asTextFile(exported.files["skills/company/PAP/company-playbook/SKILL.md"])).toContain("# Company Playbook");
    expect(exported.files["skills/paperclipai/paperclip/paperclip/SKILL.md"]).toBeUndefined();
  });

  it("warns and exports all skills when skills filter matches nothing", async () => {
    const portability = companyPortabilityService({} as any);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
      skills: ["nonexistent-skill"],
    });

    expect(exported.warnings).toContainEqual(expect.stringContaining("nonexistent-skill"));
    expect(exported.files["skills/company/PAP/company-playbook/SKILL.md"]).toBeDefined();
    expect(exported.files["skills/paperclipai/paperclip/paperclip/SKILL.md"]).toBeDefined();
  });

  it("exports the company logo into images/ and references it from .paperclip.yaml", async () => {
    const storage = {
      getObject: vi.fn().mockResolvedValue({
        stream: Readable.from([Buffer.from("png-bytes")]),
      }),
    };
    companySvc.getById.mockResolvedValue({
      id: "company-1",
      name: "Paperclip",
      description: null,
      issuePrefix: "PAP",
      brandColor: "#5c5fff",
      logoAssetId: "logo-1",
      logoUrl: "/api/assets/logo-1/content",
      requireBoardApprovalForNewAgents: true,
    });
    assetSvc.getById.mockResolvedValue({
      id: "logo-1",
      companyId: "company-1",
      objectKey: "assets/companies/logo-1",
      contentType: "image/png",
      originalFilename: "logo.png",
    });

    const portability = companyPortabilityService({} as any, storage as any);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: false,
        projects: false,
        issues: false,
      },
    });

    expect(storage.getObject).toHaveBeenCalledWith("company-1", "assets/companies/logo-1");
    expect(exported.files["images/company-logo.png"]).toEqual({
      encoding: "base64",
      data: Buffer.from("png-bytes").toString("base64"),
      contentType: "image/png",
    });
    expect(exported.files[".paperclip.yaml"]).toContain('logoPath: "images/company-logo.png"');
  });

  it("exports duplicate skill slugs into readable namespaced paths", async () => {
    const portability = companyPortabilityService({} as any);

    companySkillSvc.readFile.mockImplementation(async (_companyId: string, skillId: string, relativePath: string) => {
      if (skillId === "skill-local") {
        return {
          skillId,
          path: relativePath,
          kind: "skill",
          content: "---\nname: release-changelog\n---\n\n# Local Release Changelog\n",
          language: "markdown",
          markdown: true,
          editable: true,
        };
      }

      return {
        skillId,
        path: relativePath,
        kind: "skill",
        content: "---\nname: release-changelog\n---\n\n# Bundled Release Changelog\n",
        language: "markdown",
        markdown: true,
        editable: false,
      };
    });

    companySkillSvc.listFull.mockResolvedValue([
      {
        id: "skill-local",
        companyId: "company-1",
        key: "local/36dfd631da/release-changelog",
        slug: "release-changelog",
        name: "release-changelog",
        description: "Local release changelog skill",
        markdown: "---\nname: release-changelog\n---\n\n# Local Release Changelog\n",
        sourceType: "local_path",
        sourceLocator: "/tmp/release-changelog",
        sourceRef: null,
        trustLevel: "markdown_only",
        compatibility: "compatible",
        fileInventory: [{ path: "SKILL.md", kind: "skill" }],
        metadata: {
          sourceKind: "local_path",
        },
      },
      {
        id: "skill-paperclip",
        companyId: "company-1",
        key: "paperclipai/paperclip/release-changelog",
        slug: "release-changelog",
        name: "release-changelog",
        description: "Bundled release changelog skill",
        markdown: "---\nname: release-changelog\n---\n\n# Bundled Release Changelog\n",
        sourceType: "github",
        sourceLocator: "https://github.com/paperclipai/paperclip/tree/master/skills/release-changelog",
        sourceRef: "0123456789abcdef0123456789abcdef01234567",
        trustLevel: "markdown_only",
        compatibility: "compatible",
        fileInventory: [{ path: "SKILL.md", kind: "skill" }],
        metadata: {
          sourceKind: "paperclip_bundled",
          owner: "paperclipai",
          repo: "paperclip",
          ref: "0123456789abcdef0123456789abcdef01234567",
          trackingRef: "master",
          repoSkillDir: "skills/release-changelog",
        },
      },
    ]);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
    });

    expect(asTextFile(exported.files["skills/local/release-changelog/SKILL.md"])).toContain("# Local Release Changelog");
    expect(asTextFile(exported.files["skills/paperclipai/paperclip/release-changelog/SKILL.md"])).toContain("metadata:");
    expect(asTextFile(exported.files["skills/paperclipai/paperclip/release-changelog/SKILL.md"])).toContain("paperclipai/paperclip/release-changelog");
  });

  it("builds export previews without tasks by default", async () => {
    const portability = companyPortabilityService({} as any);

    projectSvc.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Launch",
        urlKey: "launch",
        description: "Ship it",
        leadAgentId: "agent-1",
        targetDate: null,
        color: null,
        status: "planned",
        executionWorkspacePolicy: null,
        archivedAt: null,
      },
    ]);
    issueSvc.list.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Write launch task",
        description: "Task body",
        projectId: "project-1",
        assigneeAgentId: "agent-1",
        status: "todo",
        priority: "medium",
        labelIds: [],
        billingCode: null,
        executionWorkspaceSettings: null,
        assigneeAdapterOverrides: null,
      },
    ]);

    const preview = await portability.previewExport("company-1", {
      include: {
        company: true,
        agents: true,
        projects: true,
      },
    });

    expect(preview.counts.issues).toBe(0);
    expect(preview.fileInventory.some((entry) => entry.path.startsWith("tasks/"))).toBe(false);
  });

  it("reads env inputs back from .paperclip.yaml during preview import", async () => {
    const portability = companyPortabilityService({} as any);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
    });

    const preview = await portability.previewImport({
      source: {
        type: "inline",
        rootPath: exported.rootPath,
        files: exported.files,
      },
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
      target: {
        mode: "new_company",
        newCompanyName: "Imported Paperclip",
      },
      agents: "all",
      collisionStrategy: "rename",
    });

    expect(preview.errors).toEqual([]);
    expect(preview.envInputs).toEqual([
      {
        key: "ANTHROPIC_API_KEY",
        description: "Provide ANTHROPIC_API_KEY for agent claudecoder",
        agentSlug: "claudecoder",
        kind: "secret",
        requirement: "optional",
        defaultValue: "",
        portability: "portable",
      },
      {
        key: "GH_TOKEN",
        description: "Provide GH_TOKEN for agent claudecoder",
        agentSlug: "claudecoder",
        kind: "secret",
        requirement: "optional",
        defaultValue: "",
        portability: "portable",
      },
    ]);
  });

  it("extracts env inputs from both config columns (agentConfig.env included)", async () => {
    const portability = companyPortabilityService({} as any);

    agentSvc.list.mockResolvedValue([
      {
        id: "agent-env-split",
        name: "EnvSplit",
        status: "idle",
        role: "engineer",
        title: null,
        icon: "code",
        reportsTo: null,
        capabilities: null,
        adapterType: "claude_local",
        adapterConfig: {
          model: "claude-opus-4-6",
          env: {
            HOME: { type: "plain", value: "/engine-home" },
            ENGINE_KEY: { type: "plain", value: "engine-value" },
          },
        },
        agentConfig: {
          env: {
            AGENT_KEY: { type: "plain", value: "agent-value" },
          },
        },
        runtimeConfig: {},
        budgetMonthlyCents: 0,
        permissions: {},
        metadata: null,
      },
    ]);
    projectSvc.list.mockResolvedValue([]);
    issueSvc.list.mockResolvedValue([]);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
    });

    const envInputKeys = (exported.manifest.envInputs ?? []).map((entry) => entry.key);
    expect(envInputKeys).toContain("AGENT_KEY");
    expect(envInputKeys).toContain("ENGINE_KEY");
    expect(envInputKeys).toContain("HOME");
  });

  registerCompanyPortabilityImportCases({
    companyPortabilityService,
  });
});

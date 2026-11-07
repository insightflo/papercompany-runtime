// Service mock handles, export helper and default beforeEach fixture moved out of
// company-portability.test.ts (T16d, file <=1000 lines). Bodies are verbatim; the hook is
// registered once per test file from this module, before the caller's own describe runs.
import { beforeEach, expect, vi } from "vitest";
import type { CompanyPortabilityFileEntry } from "@paperclipai/shared";

export const companySvc = {
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};

export const agentSvc = {
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};

export const accessSvc = {
  ensureMembership: vi.fn(),
  listActiveUserMemberships: vi.fn(),
  copyActiveUserMemberships: vi.fn(),
  setPrincipalPermission: vi.fn(),
};

export const projectSvc = {
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};

export const issueSvc = {
  list: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  create: vi.fn(),
};

export const companySkillSvc = {
  list: vi.fn(),
  listFull: vi.fn(),
  readFile: vi.fn(),
  importPackageFiles: vi.fn(),
};

export const assetSvc = {
  getById: vi.fn(),
  create: vi.fn(),
};

export const agentInstructionsSvc = {
  exportFiles: vi.fn(),
  materializeManagedBundle: vi.fn(),
};

export function asTextFile(entry: CompanyPortabilityFileEntry | undefined) {
  expect(typeof entry).toBe("string");
  return typeof entry === "string" ? entry : "";
}

  export const paperclipKey = "paperclipai/paperclip/paperclip";
  export const companyPlaybookKey = "company/company-1/company-playbook";

  beforeEach(() => {
    vi.clearAllMocks();
    companySvc.getById.mockResolvedValue({
      id: "company-1",
      name: "Paperclip",
      description: null,
      issuePrefix: "PAP",
      brandColor: "#5c5fff",
      logoAssetId: null,
      logoUrl: null,
      requireBoardApprovalForNewAgents: true,
    });
    agentSvc.list.mockResolvedValue([
      {
        id: "agent-1",
        name: "ClaudeCoder",
        status: "idle",
        role: "engineer",
        title: "Software Engineer",
        icon: "code",
        reportsTo: null,
        capabilities: "Writes code",
        adapterType: "claude_local",
        adapterConfig: {
          promptTemplate: "You are ClaudeCoder.",
          paperclipSkillSync: {
            desiredSkills: [paperclipKey],
          },
          instructionsFilePath: "/tmp/ignored.md",
          cwd: "/tmp/ignored",
          agentsMdPath: "/tmp/agents.md",
          command: "/Users/dotta/.local/bin/claude",
          model: "claude-opus-4-6",
          env: {
            ANTHROPIC_API_KEY: {
              type: "secret_ref",
              secretId: "secret-1",
              version: "latest",
            },
            GH_TOKEN: {
              type: "secret_ref",
              secretId: "secret-2",
              version: "latest",
            },
            PATH: {
              type: "plain",
              value: "/usr/bin:/bin",
            },
          },
        },
        runtimeConfig: {
          heartbeat: {
            intervalSec: 3600,
          },
        },
        budgetMonthlyCents: 0,
        permissions: {
          canCreateAgents: false,
        },
        metadata: null,
      },
      {
        id: "agent-2",
        name: "CMO",
        status: "idle",
        role: "cmo",
        title: "Chief Marketing Officer",
        icon: "globe",
        reportsTo: null,
        capabilities: "Owns marketing",
        adapterType: "claude_local",
        adapterConfig: {
          promptTemplate: "You are CMO.",
        },
        runtimeConfig: {
          heartbeat: {
            intervalSec: 3600,
          },
        },
        budgetMonthlyCents: 0,
        permissions: {
          canCreateAgents: false,
        },
        metadata: null,
      },
    ]);
    projectSvc.list.mockResolvedValue([]);
    issueSvc.list.mockResolvedValue([]);
    issueSvc.getById.mockResolvedValue(null);
    issueSvc.getByIdentifier.mockResolvedValue(null);
    const companySkills = [
      {
        id: "skill-1",
        companyId: "company-1",
        key: paperclipKey,
        slug: "paperclip",
        name: "paperclip",
        description: "Paperclip coordination skill",
        markdown: "---\nname: paperclip\ndescription: Paperclip coordination skill\n---\n\n# Paperclip\n",
        sourceType: "github",
        sourceLocator: "https://github.com/paperclipai/paperclip/tree/master/skills/paperclip",
        sourceRef: "0123456789abcdef0123456789abcdef01234567",
        trustLevel: "markdown_only",
        compatibility: "compatible",
        fileInventory: [
          { path: "SKILL.md", kind: "skill" },
          { path: "references/api.md", kind: "reference" },
        ],
        metadata: {
          sourceKind: "github",
          owner: "paperclipai",
          repo: "paperclip",
          ref: "0123456789abcdef0123456789abcdef01234567",
          trackingRef: "master",
          repoSkillDir: "skills/paperclip",
        },
      },
      {
        id: "skill-2",
        companyId: "company-1",
        key: companyPlaybookKey,
        slug: "company-playbook",
        name: "company-playbook",
        description: "Internal company skill",
        markdown: "---\nname: company-playbook\ndescription: Internal company skill\n---\n\n# Company Playbook\n",
        sourceType: "local_path",
        sourceLocator: "/tmp/company-playbook",
        sourceRef: null,
        trustLevel: "markdown_only",
        compatibility: "compatible",
        fileInventory: [
          { path: "SKILL.md", kind: "skill" },
          { path: "references/checklist.md", kind: "reference" },
        ],
        metadata: {
          sourceKind: "local_path",
        },
      },
    ];
    companySkillSvc.list.mockResolvedValue(companySkills);
    companySkillSvc.listFull.mockResolvedValue(companySkills);
    companySkillSvc.readFile.mockImplementation(async (_companyId: string, skillId: string, relativePath: string) => {
      if (skillId === "skill-2") {
        return {
          skillId,
          path: relativePath,
          kind: relativePath === "SKILL.md" ? "skill" : "reference",
          content: relativePath === "SKILL.md"
            ? "---\nname: company-playbook\ndescription: Internal company skill\n---\n\n# Company Playbook\n"
            : "# Checklist\n",
          language: "markdown",
          markdown: true,
          editable: true,
        };
      }

      return {
        skillId,
        path: relativePath,
        kind: relativePath === "SKILL.md" ? "skill" : "reference",
        content: relativePath === "SKILL.md"
          ? "---\nname: paperclip\ndescription: Paperclip coordination skill\n---\n\n# Paperclip\n"
          : "# API\n",
        language: "markdown",
        markdown: true,
        editable: false,
      };
    });
    companySkillSvc.importPackageFiles.mockResolvedValue([]);
    assetSvc.getById.mockReset();
    assetSvc.getById.mockResolvedValue(null);
    assetSvc.create.mockReset();
    accessSvc.setPrincipalPermission.mockResolvedValue(undefined);
    assetSvc.create.mockResolvedValue({
      id: "asset-created",
    });
    accessSvc.listActiveUserMemberships.mockResolvedValue([
      {
        id: "membership-1",
        companyId: "company-1",
        principalType: "user",
        principalId: "user-1",
        membershipRole: "owner",
        status: "active",
      },
    ]);
    accessSvc.copyActiveUserMemberships.mockResolvedValue([]);
    agentInstructionsSvc.exportFiles.mockImplementation(async (agent: { name: string }) => ({
      files: { "AGENTS.md": agent.name === "CMO" ? "You are CMO." : "You are ClaudeCoder." },
      entryFile: "AGENTS.md",
      warnings: [],
    }));
    agentInstructionsSvc.materializeManagedBundle.mockImplementation(async (agent: { adapterConfig: Record<string, unknown> }) => ({
      bundle: null,
      adapterConfig: {
        ...agent.adapterConfig,
        instructionsBundleMode: "managed",
        instructionsRootPath: `/tmp/${agent.id}`,
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: `/tmp/${agent.id}/AGENTS.md`,
      },
    }));
  });

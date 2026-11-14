// Company portability import cases moved out of company-portability.test.ts
// (T16d, file <=1000 lines).
// Slice: vendor-neutral import, secret env names, packaged skills/logo, memberships and selected-file cases (13-20).
// Case bodies are moved verbatim: the describe-scoped db connection, service handle and fixture
// helpers are injected by the caller so the suite lifecycle stays in one place.
import { expect, it, vi } from "vitest";
import { companySvc, agentSvc, accessSvc, projectSvc, companySkillSvc, assetSvc, agentInstructionsSvc, asTextFile, paperclipKey } from "./company-portability-fixtures.js";

export function registerCompanyPortabilityImportCases(deps: {
  companyPortabilityService: typeof import("../../services/company-portability.js").companyPortabilityService;
}) {
  const { companyPortabilityService } = deps;

  it("imports a vendor-neutral package without .paperclip.yaml", async () => {
    const portability = companyPortabilityService({} as any);

    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
    });
    accessSvc.ensureMembership.mockResolvedValue(undefined);
    agentSvc.create.mockResolvedValue({
      id: "agent-created",
      name: "ClaudeCoder",
    });

    const preview = await portability.previewImport({
      source: {
        type: "inline",
        rootPath: "paperclip-demo",
        files: {
          "COMPANY.md": [
            "---",
            'schema: "agentcompanies/v1"',
            'name: "Imported Paperclip"',
            'description: "Portable company package"',
            "---",
            "",
            "# Imported Paperclip",
            "",
          ].join("\n"),
          "agents/claudecoder/AGENTS.md": [
            "---",
            'name: "ClaudeCoder"',
            'title: "Software Engineer"',
            "---",
            "",
            "# ClaudeCoder",
            "",
            "You write code.",
            "",
          ].join("\n"),
        },
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
    expect(preview.manifest.company?.name).toBe("Imported Paperclip");
    expect(preview.manifest.agents).toEqual([
      expect.objectContaining({
        slug: "claudecoder",
        name: "ClaudeCoder",
        adapterType: "process",
      }),
    ]);
    expect(preview.envInputs).toEqual([]);

    await portability.importBundle({
      source: {
        type: "inline",
        rootPath: "paperclip-demo",
        files: {
          "COMPANY.md": [
            "---",
            'schema: "agentcompanies/v1"',
            'name: "Imported Paperclip"',
            'description: "Portable company package"',
            "---",
            "",
            "# Imported Paperclip",
            "",
          ].join("\n"),
          "agents/claudecoder/AGENTS.md": [
            "---",
            'name: "ClaudeCoder"',
            'title: "Software Engineer"',
            "---",
            "",
            "# ClaudeCoder",
            "",
            "You write code.",
            "",
          ].join("\n"),
        },
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
    }, "user-1");

    expect(companySvc.create).toHaveBeenCalledWith(expect.objectContaining({
      name: "Imported Paperclip",
      description: "Portable company package",
    }));
    expect(agentSvc.create).toHaveBeenCalledWith("company-imported", expect.objectContaining({
      name: "ClaudeCoder",
      adapterType: "process",
    }));
  });

  it("treats no-separator auth and api key env names as secrets during export", async () => {
    const portability = companyPortabilityService({} as any);

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
          env: {
            APIKEY: {
              type: "plain",
              value: "sk-plain-api",
            },
            GITHUBAUTH: {
              type: "plain",
              value: "gh-auth-token",
            },
            PRIVATEKEY: {
              type: "plain",
              value: "private-key-value",
            },
          },
        },
        runtimeConfig: {},
        budgetMonthlyCents: 0,
        permissions: {},
        metadata: null,
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

    const extension = asTextFile(exported.files[".paperclip.yaml"]);
    expect(extension).toContain("APIKEY:");
    expect(extension).toContain("GITHUBAUTH:");
    expect(extension).toContain("PRIVATEKEY:");
    expect(extension).not.toContain("sk-plain-api");
    expect(extension).not.toContain("gh-auth-token");
    expect(extension).not.toContain("private-key-value");
    expect(extension).toContain('kind: "secret"');
  });

  it("imports packaged skills and restores desired skill refs on agents", async () => {
    const portability = companyPortabilityService({} as any);

    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
    });
    accessSvc.ensureMembership.mockResolvedValue(undefined);
    agentSvc.create.mockResolvedValue({
      id: "agent-created",
      name: "ClaudeCoder",
    });

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
    });

    agentSvc.list.mockResolvedValue([]);

    await portability.importBundle({
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
    }, "user-1");

    const textOnlyFiles = Object.fromEntries(Object.entries(exported.files).filter(([, v]) => typeof v === "string"));
    expect(companySkillSvc.importPackageFiles).toHaveBeenCalledWith("company-imported", textOnlyFiles, {
      onConflict: "replace",
    });
    expect(agentSvc.create).toHaveBeenCalledWith("company-imported", expect.objectContaining({
      adapterConfig: expect.objectContaining({
        paperclipSkillSync: {
          desiredSkills: [paperclipKey],
        },
      }),
    }));
  });

  it("keeps agent-level keys out of the portable adapterConfig so the normalizer routes them into agentConfig on import", async () => {
    const portability = companyPortabilityService({} as any);

    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
    });
    accessSvc.ensureMembership.mockResolvedValue(undefined);
    agentSvc.create.mockResolvedValue({
      id: "agent-created",
      name: "ClaudeCoder",
    });

    // Post-P2 source shape: agent keys live in agentConfig, engine keys in adapterConfig.
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
          model: "claude-opus-4-6",
          command: "/Users/dotta/.local/bin/claude",
        },
        agentConfig: {
          cwd: "/work",
          agentsMdPath: "/work/AGENTS.md",
          paperclipSkillSync: { desiredSkills: [paperclipKey] },
        },
        runtimeConfig: {},
        budgetMonthlyCents: 0,
        permissions: { canCreateAgents: false },
        metadata: null,
      },
    ]);
    agentInstructionsSvc.exportFiles.mockResolvedValue({
      files: { "AGENTS.md": "You are ClaudeCoder." },
      entryFile: "AGENTS.md",
      warnings: [],
    });

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
    });
    const extension = asTextFile(exported.files[".paperclip.yaml"]);
    expect(extension).not.toContain("cwd");
    expect(extension).not.toContain("agentsMdPath");

    agentSvc.list.mockResolvedValue([]);
    await portability.importBundle({
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
    }, "user-1");

    const createCall = agentSvc.create.mock.calls.find((call) => (call[1] as { name?: string })?.name === "ClaudeCoder");
    expect(createCall).toBeDefined();
    expect(createCall![1]).toMatchObject({
      adapterType: "claude_local",
      adapterConfig: {
        model: "claude-opus-4-6",
      },
    });
    // Agent-level keys must not leak through the portable adapterConfig
    // (paperclipSkillSync is re-written by import itself and routed into
    // agentConfig by the persistence normalizer at create time).
    const persistedAdapterConfig = (createCall![1] as { adapterConfig: Record<string, unknown> }).adapterConfig;
    expect(persistedAdapterConfig).not.toMatchObject({
      cwd: expect.anything(),
      agentsMdPath: expect.anything(),
      promptTemplate: expect.anything(),
      instructionsFilePath: expect.anything(),
      instructionsBundleMode: expect.anything(),
      instructionsRootPath: expect.anything(),
      instructionsEntryFile: expect.anything(),
      bootstrapPromptTemplate: expect.anything(),
    });
  });

  it("imports a packaged company logo and attaches it to the target company", async () => {
    const storage = {
      putFile: vi.fn().mockResolvedValue({
        provider: "local_disk",
        objectKey: "assets/companies/imported-logo",
        contentType: "image/png",
        byteSize: 9,
        sha256: "logo-sha",
        originalFilename: "company-logo.png",
      }),
    };
    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
      logoAssetId: null,
    });
    companySvc.update.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
      logoAssetId: "asset-created",
    });
    agentSvc.create.mockResolvedValue({
      id: "agent-created",
      name: "ClaudeCoder",
    });

    const portability = companyPortabilityService({} as any, storage as any);
    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
    });

    exported.files["images/company-logo.png"] = {
      encoding: "base64",
      data: Buffer.from("png-bytes").toString("base64"),
      contentType: "image/png",
    };
    exported.files[".paperclip.yaml"] = `${exported.files[".paperclip.yaml"]}`.replace(
      'brandColor: "#5c5fff"\n',
      'brandColor: "#5c5fff"\n  logoPath: "images/company-logo.png"\n',
    );

    agentSvc.list.mockResolvedValue([]);

    await portability.importBundle({
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
    }, "user-1");

    expect(storage.putFile).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-imported",
      namespace: "assets/companies",
      originalFilename: "company-logo.png",
      contentType: "image/png",
      body: Buffer.from("png-bytes"),
    }));
    expect(assetSvc.create).toHaveBeenCalledWith("company-imported", expect.objectContaining({
      objectKey: "assets/companies/imported-logo",
      contentType: "image/png",
      createdByUserId: "user-1",
    }));
    expect(companySvc.update).toHaveBeenCalledWith("company-imported", {
      logoAssetId: "asset-created",
    });
  });

  it("copies source company memberships for safe new-company imports", async () => {
    const portability = companyPortabilityService({} as any);

    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
    });
    agentSvc.create.mockResolvedValue({
      id: "agent-created",
      name: "ClaudeCoder",
    });

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
    });

    agentSvc.list.mockResolvedValue([]);

    await portability.importBundle({
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
    }, null, {
      mode: "agent_safe",
      sourceCompanyId: "company-1",
    });

    expect(accessSvc.listActiveUserMemberships).toHaveBeenCalledWith("company-1");
    expect(accessSvc.copyActiveUserMemberships).toHaveBeenCalledWith("company-1", "company-imported");
    expect(accessSvc.ensureMembership).not.toHaveBeenCalledWith("company-imported", "user", expect.anything(), "owner", "active");
    const textOnlyFiles = Object.fromEntries(Object.entries(exported.files).filter(([, v]) => typeof v === "string"));
    expect(companySkillSvc.importPackageFiles).toHaveBeenCalledWith("company-imported", textOnlyFiles, {
      onConflict: "rename",
    });
  });

  it("imports only selected files and leaves unchecked company metadata alone", async () => {
    const portability = companyPortabilityService({} as any);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
    });

    agentSvc.list.mockResolvedValue([]);
    projectSvc.list.mockResolvedValue([]);
    companySvc.getById.mockResolvedValue({
      id: "company-1",
      name: "Paperclip",
      description: "Existing company",
      brandColor: "#123456",
      requireBoardApprovalForNewAgents: false,
    });
    agentSvc.create.mockResolvedValue({
      id: "agent-cmo",
      name: "CMO",
    });

    const result = await portability.importBundle({
      source: {
        type: "inline",
        rootPath: exported.rootPath,
        files: exported.files,
      },
      include: {
        company: true,
        agents: true,
        projects: true,
        issues: true,
      },
      selectedFiles: ["agents/cmo/AGENTS.md"],
      target: {
        mode: "existing_company",
        companyId: "company-1",
      },
      agents: "all",
      collisionStrategy: "rename",
    }, "user-1");

    expect(companySvc.update).not.toHaveBeenCalled();
    expect(companySkillSvc.importPackageFiles).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        "COMPANY.md": expect.any(String),
        "agents/cmo/AGENTS.md": expect.any(String),
      }),
      {
        onConflict: "replace",
      },
    );
    expect(companySkillSvc.importPackageFiles).toHaveBeenCalledWith(
      "company-1",
      expect.not.objectContaining({
        "agents/claudecoder/AGENTS.md": expect.any(String),
      }),
      {
        onConflict: "replace",
      },
    );
    expect(agentSvc.create).toHaveBeenCalledTimes(1);
    expect(agentSvc.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
      name: "CMO",
    }));
    expect(result.company.action).toBe("unchanged");
    expect(result.agents).toEqual([
      {
        slug: "cmo",
        id: "agent-cmo",
        action: "created",
        name: "CMO",
        reason: null,
      },
    ]);
  });

  it("applies adapter overrides while keeping imported AGENTS content implicit", async () => {
    const portability = companyPortabilityService({} as any);

    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
    });
    accessSvc.ensureMembership.mockResolvedValue(undefined);
    agentSvc.create.mockResolvedValue({
      id: "agent-created",
      name: "ClaudeCoder",
    });

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: false,
        issues: false,
      },
    });

    agentSvc.list.mockResolvedValue([]);

    await portability.importBundle({
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
      adapterOverrides: {
        claudecoder: {
          adapterType: "codex_local",
          adapterConfig: {
            dangerouslyBypassApprovalsAndSandbox: true,
            instructionsFilePath: "/tmp/should-not-survive.md",
          },
        },
      },
    }, "user-1");

    expect(agentSvc.create).toHaveBeenCalledWith("company-imported", expect.objectContaining({
      adapterType: "codex_local",
      adapterConfig: expect.objectContaining({
        dangerouslyBypassApprovalsAndSandbox: true,
      }),
    }));
    expect(agentSvc.create).toHaveBeenCalledWith("company-imported", expect.objectContaining({
      adapterConfig: expect.not.objectContaining({
        instructionsFilePath: expect.anything(),
        promptTemplate: expect.anything(),
      }),
    }));
    expect(agentInstructionsSvc.materializeManagedBundle).toHaveBeenCalledWith(
      expect.objectContaining({ name: "ClaudeCoder" }),
      expect.objectContaining({
        "AGENTS.md": expect.stringContaining("You are ClaudeCoder."),
      }),
      expect.objectContaining({
        clearLegacyPromptTemplate: true,
        replaceExisting: true,
      }),
    );
  });

  it("previews import of an exported package whose skill SKILL.md has malformed YAML instead of failing", async () => {
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
      expect(preview.warnings).toEqual(expect.arrayContaining([
        expect.stringContaining(`Company package file skills/${paperclipKey}/SKILL.md has invalid YAML frontmatter`),
      ]));
    } finally {
      companySkillSvc.readFile.mockImplementation(previousReadFile);
    }
  });
}

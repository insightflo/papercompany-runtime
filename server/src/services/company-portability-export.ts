import type {
  CompanyPortabilityExport,
  CompanyPortabilityFileEntry,
  CompanyPortabilityExportPreviewResult,
  CompanyPortabilityExportResult,
  CompanyPortabilityManifest,
} from "@paperclipai/shared";
import { deriveProjectUrlKey, normalizeAgentUrlKey } from "@paperclipai/shared";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { notFound } from "../errors.js";
import { mergeAgentConfig } from "./agents.js";
import { generateReadme } from "./company-export-readme.js";
import { renderOrgChartPng, type OrgNode } from "../routes/org-chart-svg.js";
import { issueService } from "./issues.js";
import { projectService } from "./projects.js";
import { isPlainRecord, stripEmptyValues, buildMarkdown, buildYamlFile } from "./company-portability-yaml.js";
import {
  classifyPortableFileKind,
  toSafeSlug,
  uniqueSlug,
  normalizeInclude,
} from "./company-portability-naming.js";
import {
  isAbsoluteCommand,
  extractPortableEnvInputs,
  dedupeEnvInputs,
  buildEnvInputMap,
} from "./company-portability-env-inputs.js";
import {
  normalizePortablePath,
  resolveCompanyLogoExtension,
  bufferToPortableBinaryFile,
  streamToBuffer,
} from "./company-portability-files.js";
import { filterExportFiles } from "./company-portability-extension-filter.js";
import {
  COMPANY_LOGO_FILE_NAME,
  RUNTIME_DEFAULT_RULES,
  ADAPTER_DEFAULT_RULES_BY_TYPE,
  asString,
  pruneDefaultLikeValue,
} from "./company-portability-normalize.js";
import {
  normalizeSkillSlug,
  normalizeSkillKey,
  buildSkillExportDirMap,
} from "./company-portability-skill-export.js";
import {
  shouldReferenceSkillOnExport,
  buildReferencedSkillMarkdown,
  withSkillSourceMetadata,
} from "./company-portability-skill-source.js";
import { normalizePortableConfig } from "./company-portability-package-helpers.js";
import { buildManifestFromPackageFiles } from "./company-portability-package-manifest.js";
import type { Db } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { agentInstructionsService } from "./agent-instructions.js";
import { agentService } from "./agents.js";
import { assetService } from "./assets.js";
import { companySkillService } from "./company-skills.js";
import { companyService } from "./companies.js";

export type PortabilityExportDeps = {
  agents: ReturnType<typeof agentService>;
  assetRecords: ReturnType<typeof assetService>;
  companies: ReturnType<typeof companyService>;
  companySkills: ReturnType<typeof companySkillService>;
  db: Db;
  instructions: ReturnType<typeof agentInstructionsService>;
  storage: StorageService | undefined;
};

/** Build OrgNode tree from manifest agent list (slug + reportsToSlug). */
function buildOrgTreeFromManifest(agents: CompanyPortabilityManifest["agents"]): OrgNode[] {
  const ROLE_LABELS: Record<string, string> = {
    ceo: "Chief Executive", cto: "Technology", cmo: "Marketing",
    cfo: "Finance", coo: "Operations", vp: "VP", manager: "Manager",
    engineer: "Engineer", agent: "Agent",
  };
  const bySlug = new Map(agents.map((a) => [a.slug, a]));
  const childrenOf = new Map<string | null, typeof agents>();
  for (const a of agents) {
    const parent = a.reportsToSlug ?? null;
    const list = childrenOf.get(parent) ?? [];
    list.push(a);
    childrenOf.set(parent, list);
  }
  const build = (parentSlug: string | null): OrgNode[] => {
    const members = childrenOf.get(parentSlug) ?? [];
    return members.map((m) => ({
      id: m.slug,
      name: m.name,
      role: ROLE_LABELS[m.role] ?? m.role,
      status: "active",
      reports: build(m.slug),
    }));
  };
  // Find roots: agents whose reportsToSlug is null or points to a non-existent slug
  const roots = agents.filter((a) => !a.reportsToSlug || !bySlug.has(a.reportsToSlug));
  const rootSlugs = new Set(roots.map((r) => r.slug));
  // Start from null parent, but also include orphans
  const tree = build(null);
  for (const root of roots) {
    if (root.reportsToSlug && !bySlug.has(root.reportsToSlug)) {
      // Orphan root (parent slug doesn't exist)
      tree.push({
        id: root.slug,
        name: root.name,
        role: ROLE_LABELS[root.role] ?? root.role,
        status: "active",
        reports: build(root.slug),
      });
    }
  }
  return tree;
}

export async function exportBundle(
  deps: PortabilityExportDeps,
  companyId: string,
  input: CompanyPortabilityExport,
): Promise<CompanyPortabilityExportResult> {
  const { agents, assetRecords, companies, companySkills, db, instructions, storage } = deps;
  const include = normalizeInclude({
    ...input.include,
    agents: input.agents && input.agents.length > 0 ? true : input.include?.agents,
    projects: input.projects && input.projects.length > 0 ? true : input.include?.projects,
    issues:
      (input.issues && input.issues.length > 0) || (input.projectIssues && input.projectIssues.length > 0)
        ? true
        : input.include?.issues,
    skills: input.skills && input.skills.length > 0 ? true : input.include?.skills,
  });
  const company = await companies.getById(companyId);
  if (!company) throw notFound("Company not found");

  const files: Record<string, CompanyPortabilityFileEntry> = {};
  const warnings: string[] = [];
  const envInputs: CompanyPortabilityManifest["envInputs"] = [];
  const rootPath = normalizeAgentUrlKey(company.name) ?? "company-package";
  let companyLogoPath: string | null = null;

  const allAgentRows = include.agents ? await agents.list(companyId, { includeTerminated: true }) : [];
  const liveAgentRows = allAgentRows.filter((agent) => agent.status !== "terminated");
  const companySkillRows = include.skills || include.agents ? await companySkills.listFull(companyId) : [];
  if (include.agents) {
    const skipped = allAgentRows.length - liveAgentRows.length;
    if (skipped > 0) {
      warnings.push(`Skipped ${skipped} terminated agent${skipped === 1 ? "" : "s"} from export.`);
    }
  }

  const agentByReference = new Map<string, typeof liveAgentRows[number]>();
  for (const agent of liveAgentRows) {
    agentByReference.set(agent.id, agent);
    agentByReference.set(agent.name, agent);
    const normalizedName = normalizeAgentUrlKey(agent.name);
    if (normalizedName) {
      agentByReference.set(normalizedName, agent);
    }
  }

  const selectedAgents = new Map<string, typeof liveAgentRows[number]>();
  for (const selector of input.agents ?? []) {
    const trimmed = selector.trim();
    if (!trimmed) continue;
    const normalized = normalizeAgentUrlKey(trimmed) ?? trimmed;
    const match = agentByReference.get(trimmed) ?? agentByReference.get(normalized);
    if (!match) {
      warnings.push(`Agent selector "${selector}" was not found and was skipped.`);
      continue;
    }
    selectedAgents.set(match.id, match);
  }

  if (include.agents && selectedAgents.size === 0) {
    for (const agent of liveAgentRows) {
      selectedAgents.set(agent.id, agent);
    }
  }

  const agentRows = Array.from(selectedAgents.values())
    .sort((left, right) => left.name.localeCompare(right.name));

  const usedSlugs = new Set<string>();
  const idToSlug = new Map<string, string>();
  for (const agent of agentRows) {
    const baseSlug = toSafeSlug(agent.name, "agent");
    const slug = uniqueSlug(baseSlug, usedSlugs);
    idToSlug.set(agent.id, slug);
  }

  const projectsSvc = projectService(db);
  const issuesSvc = issueService(db);
  const allProjectsRaw = include.projects || include.issues ? await projectsSvc.list(companyId) : [];
  const allProjects = allProjectsRaw.filter((project) => !project.archivedAt);
  const projectById = new Map(allProjects.map((project) => [project.id, project]));
  const projectByReference = new Map<string, typeof allProjects[number]>();
  for (const project of allProjects) {
    projectByReference.set(project.id, project);
    projectByReference.set(project.urlKey, project);
  }

  const selectedProjects = new Map<string, typeof allProjects[number]>();
  const normalizeProjectSelector = (selector: string) => selector.trim().toLowerCase();
  for (const selector of input.projects ?? []) {
    const match = projectByReference.get(selector) ?? projectByReference.get(normalizeProjectSelector(selector));
    if (!match) {
      warnings.push(`Project selector "${selector}" was not found and was skipped.`);
      continue;
    }
    selectedProjects.set(match.id, match);
  }

  const selectedIssues = new Map<string, Awaited<ReturnType<typeof issuesSvc.getById>>>();
  const resolveIssueBySelector = async (selector: string) => {
    const trimmed = selector.trim();
    if (!trimmed) return null;
    return trimmed.includes("-")
      ? issuesSvc.getByIdentifier(trimmed)
      : issuesSvc.getById(trimmed);
  };
  for (const selector of input.issues ?? []) {
    const issue = await resolveIssueBySelector(selector);
    if (!issue || issue.companyId !== companyId) {
      warnings.push(`Issue selector "${selector}" was not found and was skipped.`);
      continue;
    }
    selectedIssues.set(issue.id, issue);
    if (issue.projectId) {
      const parentProject = projectById.get(issue.projectId);
      if (parentProject) selectedProjects.set(parentProject.id, parentProject);
    }
  }

  for (const selector of input.projectIssues ?? []) {
    const match = projectByReference.get(selector) ?? projectByReference.get(normalizeProjectSelector(selector));
    if (!match) {
      warnings.push(`Project-issues selector "${selector}" was not found and was skipped.`);
      continue;
    }
    selectedProjects.set(match.id, match);
    // [목적] 내보내기는 이슈 본문을 파일로 내보내므로 목록 기본 응답이 summary로 바뀌어도 전체 필드를 요청한다.
    // [이유] summary 행은 description이 null이라 본문이 빈 채로 내보내진다. view를 모르는 현재 코드에서는 무시된다.
    const projectIssues = await issuesSvc.list(companyId, { projectId: match.id, view: "full" });
    for (const issue of projectIssues) {
      selectedIssues.set(issue.id, issue);
    }
  }

  if (include.projects && selectedProjects.size === 0) {
    for (const project of allProjects) {
      selectedProjects.set(project.id, project);
    }
  }

  if (include.issues && selectedIssues.size === 0) {
    // [목적] 같은 이유로 회사 전체 이슈 목록도 전체 필드를 요청한다(본문 포함 내보내기).
    const allIssues = await issuesSvc.list(companyId, { view: "full" });
    for (const issue of allIssues) {
      selectedIssues.set(issue.id, issue);
      if (issue.projectId) {
        const parentProject = projectById.get(issue.projectId);
        if (parentProject) selectedProjects.set(parentProject.id, parentProject);
      }
    }
  }

  const selectedProjectRows = Array.from(selectedProjects.values())
    .sort((left, right) => left.name.localeCompare(right.name));
  const selectedIssueRows = Array.from(selectedIssues.values())
    .filter((issue): issue is NonNullable<typeof issue> => issue != null)
    .sort((left, right) => (left.identifier ?? left.title).localeCompare(right.identifier ?? right.title));

  const taskSlugByIssueId = new Map<string, string>();
  const usedTaskSlugs = new Set<string>();
  for (const issue of selectedIssueRows) {
    const baseSlug = normalizeAgentUrlKey(issue.identifier ?? issue.title) ?? "task";
    taskSlugByIssueId.set(issue.id, uniqueSlug(baseSlug, usedTaskSlugs));
  }

  const projectSlugById = new Map<string, string>();
  const usedProjectSlugs = new Set<string>();
  for (const project of selectedProjectRows) {
    const baseSlug = deriveProjectUrlKey(project.name, project.name);
    projectSlugById.set(project.id, uniqueSlug(baseSlug, usedProjectSlugs));
  }

  const companyPath = "COMPANY.md";
  files[companyPath] = buildMarkdown(
    {
      name: company.name,
      description: company.description ?? null,
      schema: "agentcompanies/v1",
      slug: rootPath,
    },
    "",
  );

  if (include.company && company.logoAssetId) {
    if (!storage) {
      warnings.push("Skipped company logo from export because storage is unavailable.");
    } else {
      const logoAsset = await assetRecords.getById(company.logoAssetId);
      if (!logoAsset) {
        warnings.push(`Skipped company logo ${company.logoAssetId} because the asset record was not found.`);
      } else {
        try {
          const object = await storage.getObject(company.id, logoAsset.objectKey);
          const body = await streamToBuffer(object.stream);
          companyLogoPath = `images/${COMPANY_LOGO_FILE_NAME}${resolveCompanyLogoExtension(logoAsset.contentType, logoAsset.originalFilename)}`;
          files[companyLogoPath] = bufferToPortableBinaryFile(body, logoAsset.contentType);
        } catch (err) {
          warnings.push(`Failed to export company logo ${company.logoAssetId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  const paperclipAgentsOut: Record<string, Record<string, unknown>> = {};
  const paperclipProjectsOut: Record<string, Record<string, unknown>> = {};
  const paperclipTasksOut: Record<string, Record<string, unknown>> = {};

  const skillByReference = new Map<string, typeof companySkillRows[number]>();
  for (const skill of companySkillRows) {
    skillByReference.set(skill.id, skill);
    skillByReference.set(skill.key, skill);
    skillByReference.set(skill.slug, skill);
    skillByReference.set(skill.name, skill);
  }
  const selectedSkills = new Map<string, typeof companySkillRows[number]>();
  for (const selector of input.skills ?? []) {
    const trimmed = selector.trim();
    if (!trimmed) continue;
    const normalized = normalizeSkillKey(trimmed) ?? normalizeSkillSlug(trimmed) ?? trimmed;
    const match = skillByReference.get(trimmed) ?? skillByReference.get(normalized);
    if (!match) {
      warnings.push(`Skill selector "${selector}" was not found and was skipped.`);
      continue;
    }
    selectedSkills.set(match.id, match);
  }
  if (selectedSkills.size === 0) {
    for (const skill of companySkillRows) {
      selectedSkills.set(skill.id, skill);
    }
  }
  const selectedSkillRows = Array.from(selectedSkills.values())
    .sort((left, right) => left.key.localeCompare(right.key));

  const skillExportDirs = buildSkillExportDirMap(selectedSkillRows, company.issuePrefix);
  for (const skill of selectedSkillRows) {
    const packageDir = skillExportDirs.get(skill.key) ?? `skills/${normalizeSkillSlug(skill.slug) ?? "skill"}`;
    if (shouldReferenceSkillOnExport(skill, Boolean(input.expandReferencedSkills))) {
      files[`${packageDir}/SKILL.md`] = await buildReferencedSkillMarkdown(skill);
      continue;
    }

    for (const inventoryEntry of skill.fileInventory) {
      const fileDetail = await companySkills.readFile(companyId, skill.id, inventoryEntry.path).catch(() => null);
      if (!fileDetail) continue;
      const filePath = `${packageDir}/${inventoryEntry.path}`;
      files[filePath] = inventoryEntry.path === "SKILL.md"
        ? await withSkillSourceMetadata(skill, fileDetail.content, warnings)
        : fileDetail.content;
    }
  }

  if (include.agents) {
    for (const agent of agentRows) {
      const slug = idToSlug.get(agent.id)!;
      const exportedInstructions = await instructions.exportFiles(agent);
      warnings.push(...exportedInstructions.warnings);

      const envInputsStart = envInputs.length;
      const mergedAgentConfig = mergeAgentConfig(agent);
      const exportedEnvInputs = extractPortableEnvInputs(
        slug,
        mergedAgentConfig.env,
        warnings,
      );
      envInputs.push(...exportedEnvInputs);
      const adapterDefaultRules = ADAPTER_DEFAULT_RULES_BY_TYPE[agent.adapterType] ?? [];
      const portableAdapterConfig = pruneDefaultLikeValue(
        normalizePortableConfig(agent.adapterConfig),
        {
          dropFalseBooleans: true,
          defaultRules: adapterDefaultRules,
        },
      ) as Record<string, unknown>;
      const portableRuntimeConfig = pruneDefaultLikeValue(
        normalizePortableConfig(agent.runtimeConfig),
        {
          dropFalseBooleans: true,
          defaultRules: RUNTIME_DEFAULT_RULES,
        },
      ) as Record<string, unknown>;
      const portablePermissions = pruneDefaultLikeValue(agent.permissions ?? {}, { dropFalseBooleans: true }) as Record<string, unknown>;
      const agentEnvInputs = dedupeEnvInputs(
        envInputs
          .slice(envInputsStart)
          .filter((inputValue) => inputValue.agentSlug === slug),
      );
      const reportsToSlug = agent.reportsTo ? (idToSlug.get(agent.reportsTo) ?? null) : null;
      const desiredSkills = readPaperclipSkillSyncPreference(
        mergeAgentConfig(agent),
      ).desiredSkills;

      const commandValue = asString(portableAdapterConfig.command);
      if (commandValue && isAbsoluteCommand(commandValue)) {
        warnings.push(`Agent ${slug} command ${commandValue} was omitted from export because it is system-dependent.`);
        delete portableAdapterConfig.command;
      }
      for (const [relativePath, content] of Object.entries(exportedInstructions.files)) {
        const targetPath = `agents/${slug}/${relativePath}`;
        if (relativePath === exportedInstructions.entryFile) {
          files[targetPath] = buildMarkdown(
            stripEmptyValues({
              name: agent.name,
              title: agent.title ?? null,
              reportsTo: reportsToSlug,
              skills: desiredSkills.length > 0 ? desiredSkills : undefined,
            }) as Record<string, unknown>,
            content,
          );
        } else {
          files[targetPath] = content;
        }
      }

      const extension = stripEmptyValues({
        role: agent.role !== "agent" ? agent.role : undefined,
        icon: agent.icon ?? null,
        capabilities: agent.capabilities ?? null,
        adapter: {
          type: agent.adapterType,
          config: portableAdapterConfig,
        },
        runtime: portableRuntimeConfig,
        permissions: portablePermissions,
        budgetMonthlyCents: (agent.budgetMonthlyCents ?? 0) > 0 ? agent.budgetMonthlyCents : undefined,
        metadata: (agent.metadata as Record<string, unknown> | null) ?? null,
      });
      if (isPlainRecord(extension) && agentEnvInputs.length > 0) {
        extension.inputs = {
          env: buildEnvInputMap(agentEnvInputs),
        };
      }
      paperclipAgentsOut[slug] = isPlainRecord(extension) ? extension : {};
    }
  }

  for (const project of selectedProjectRows) {
    const slug = projectSlugById.get(project.id)!;
    const projectPath = `projects/${slug}/PROJECT.md`;
    files[projectPath] = buildMarkdown(
      {
        name: project.name,
        description: project.description ?? null,
        owner: project.leadAgentId ? (idToSlug.get(project.leadAgentId) ?? null) : null,
      },
      project.description ?? "",
    );
    const extension = stripEmptyValues({
      leadAgentSlug: project.leadAgentId ? (idToSlug.get(project.leadAgentId) ?? null) : null,
      targetDate: project.targetDate ?? null,
      color: project.color ?? null,
      status: project.status,
      executionWorkspacePolicy: project.executionWorkspacePolicy ?? undefined,
    });
    paperclipProjectsOut[slug] = isPlainRecord(extension) ? extension : {};
  }

  for (const issue of selectedIssueRows) {
    const taskSlug = taskSlugByIssueId.get(issue.id)!;
    const projectSlug = issue.projectId ? (projectSlugById.get(issue.projectId) ?? null) : null;
    // All tasks go in top-level tasks/ folder, never nested under projects/
    const taskPath = `tasks/${taskSlug}/TASK.md`;
    const assigneeSlug = issue.assigneeAgentId ? (idToSlug.get(issue.assigneeAgentId) ?? null) : null;
    files[taskPath] = buildMarkdown(
      {
        name: issue.title,
        project: projectSlug,
        assignee: assigneeSlug,
      },
      issue.description ?? "",
    );
    const extension = stripEmptyValues({
      identifier: issue.identifier,
      status: issue.status,
      priority: issue.priority,
      labelIds: issue.labelIds ?? undefined,
      billingCode: issue.billingCode ?? null,
      executionWorkspaceSettings: issue.executionWorkspaceSettings ?? undefined,
      assigneeAdapterOverrides: issue.assigneeAdapterOverrides ?? undefined,
    });
    paperclipTasksOut[taskSlug] = isPlainRecord(extension) ? extension : {};
  }

  const paperclipExtensionPath = ".paperclip.yaml";
  const paperclipAgents = Object.fromEntries(
    Object.entries(paperclipAgentsOut).filter(([, value]) => isPlainRecord(value) && Object.keys(value).length > 0),
  );
  const paperclipProjects = Object.fromEntries(
    Object.entries(paperclipProjectsOut).filter(([, value]) => isPlainRecord(value) && Object.keys(value).length > 0),
  );
  const paperclipTasks = Object.fromEntries(
    Object.entries(paperclipTasksOut).filter(([, value]) => isPlainRecord(value) && Object.keys(value).length > 0),
  );
  files[paperclipExtensionPath] = buildYamlFile(
    {
      schema: "paperclip/v1",
      company: stripEmptyValues({
        brandColor: company.brandColor ?? null,
        logoPath: companyLogoPath,
        requireBoardApprovalForNewAgents: company.requireBoardApprovalForNewAgents ? undefined : false,
      }),
      agents: Object.keys(paperclipAgents).length > 0 ? paperclipAgents : undefined,
      projects: Object.keys(paperclipProjects).length > 0 ? paperclipProjects : undefined,
      tasks: Object.keys(paperclipTasks).length > 0 ? paperclipTasks : undefined,
    },
    { preserveEmptyStrings: true },
  );

  let finalFiles = filterExportFiles(files, input.selectedFiles, paperclipExtensionPath);
  let resolved = buildManifestFromPackageFiles(finalFiles, {
    sourceLabel: {
      companyId: company.id,
      companyName: company.name,
    },
    lenientYaml: true,
  });
  resolved.manifest.includes = {
    company: resolved.manifest.company !== null,
    agents: resolved.manifest.agents.length > 0,
    projects: resolved.manifest.projects.length > 0,
    issues: resolved.manifest.issues.length > 0,
    skills: resolved.manifest.skills.length > 0,
  };
  resolved.manifest.envInputs = dedupeEnvInputs(envInputs);
  resolved.warnings.unshift(...warnings);

  // Generate org chart PNG from manifest agents
  if (resolved.manifest.agents.length > 0) {
    try {
      const orgNodes = buildOrgTreeFromManifest(resolved.manifest.agents);
      const pngBuffer = await renderOrgChartPng(orgNodes);
      finalFiles["images/org-chart.png"] = bufferToPortableBinaryFile(pngBuffer, "image/png");
    } catch {
      // Non-fatal: export still works without the org chart image
    }
  }

  if (!input.selectedFiles || input.selectedFiles.some((entry) => normalizePortablePath(entry) === "README.md")) {
    finalFiles["README.md"] = generateReadme(resolved.manifest, {
      companyName: company.name,
      companyDescription: company.description ?? null,
    });
  }

  resolved = buildManifestFromPackageFiles(finalFiles, {
    sourceLabel: {
      companyId: company.id,
      companyName: company.name,
    },
    lenientYaml: true,
  });
  resolved.manifest.includes = {
    company: resolved.manifest.company !== null,
    agents: resolved.manifest.agents.length > 0,
    projects: resolved.manifest.projects.length > 0,
    issues: resolved.manifest.issues.length > 0,
    skills: resolved.manifest.skills.length > 0,
  };
  resolved.manifest.envInputs = dedupeEnvInputs(envInputs);
  resolved.warnings.unshift(...warnings);

  return {
    rootPath,
    manifest: resolved.manifest,
    files: finalFiles,
    warnings: resolved.warnings,
    paperclipExtensionPath,
  };
}

export async function previewExport(
  deps: PortabilityExportDeps,
  companyId: string,
  input: CompanyPortabilityExport,
): Promise<CompanyPortabilityExportPreviewResult> {
  const previewInput: CompanyPortabilityExport = {
    ...input,
    include: {
      ...input.include,
      issues:
        input.include?.issues
        ?? Boolean((input.issues && input.issues.length > 0) || (input.projectIssues && input.projectIssues.length > 0))
        ?? false,
    },
  };
  if (previewInput.include && previewInput.include.issues === undefined) {
    previewInput.include.issues = false;
  }
  const exported = await exportBundle(deps, companyId, previewInput);
  return {
    ...exported,
    fileInventory: Object.keys(exported.files)
      .sort((left, right) => left.localeCompare(right))
      .map((filePath) => ({
        path: filePath,
        kind: classifyPortableFileKind(filePath),
      })),
    counts: {
      files: Object.keys(exported.files).length,
      agents: exported.manifest.agents.length,
      skills: exported.manifest.skills.length,
      projects: exported.manifest.projects.length,
      issues: exported.manifest.issues.length,
    },
  };
}

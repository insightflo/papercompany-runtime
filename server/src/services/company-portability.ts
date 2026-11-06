import path from "node:path";
import type { Db } from "@paperclipai/db";
import type {
  CompanyPortabilityExport,
  CompanyPortabilityFileEntry,
  CompanyPortabilityImport,
  CompanyPortabilityImportResult,
  CompanyPortabilityInclude,
  CompanyPortabilityPreview,
  CompanyPortabilityPreviewAgentPlan,
  CompanyPortabilityPreviewResult,
  CompanyPortabilitySkillManifestEntry,
} from "@paperclipai/shared";
import {
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  PROJECT_STATUSES,
  deriveProjectUrlKey,
  normalizeAgentUrlKey,
} from "@paperclipai/shared";
import { writePaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { notFound, unprocessable } from "../errors.js";
import type { StorageService } from "../storage/types.js";
import { accessService } from "./access.js";
import { agentService, mergeAgentConfig } from "./agents.js";
import { agentInstructionsService } from "./agent-instructions.js";
import { assetService } from "./assets.js";
import { companySkillService } from "./company-skills.js";
import { companyService } from "./companies.js";
import { issueService } from "./issues.js";
import { projectService } from "./projects.js";
import type {
  ImportBehaviorOptions,
  ImportPlanInternal,
  ResolvedSource,
} from "./company-portability-types.js";
import {
  DEFAULT_COLLISION_STRATEGY,
  resolveImportMode,
  resolveSkillConflictStrategy,
  uniqueNameBySlug,
  uniqueProjectName,
  normalizeInclude,
} from "./company-portability-naming.js";
import {
  normalizePortablePath,
  isPortableBinaryFile,
  readPortableTextFile,
  inferContentTypeFromPath,
  portableFileToBuffer,
  bufferToPortableBinaryFile,
  normalizeFileMap,
  pickTextFiles,
  ensureMarkdownPath,
} from "./company-portability-files.js";
import { parseGitHubSourceUrl, resolveRawGitHubUrl } from "./company-portability-github-source.js";
import { COMPANY_LOGO_CONTENT_TYPE_EXTENSIONS, asString } from "./company-portability-normalize.js";
import { normalizeSkillSlug } from "./company-portability-skill-export.js";
import { fetchText, fetchOptionalText, fetchBinary, fetchJson } from "./company-portability-skill-source.js";
import { readIncludeEntries, parsePackagedFrontmatter } from "./company-portability-package-helpers.js";
import {
  applySelectedFilesToSource,
  buildManifestFromPackageFiles,
} from "./company-portability-package-manifest.js";
import { exportBundle, previewExport, type PortabilityExportDeps } from "./company-portability-export.js";

export { parseGitHubSourceUrl } from "./company-portability-github-source.js";

export function companyPortabilityService(db: Db, storage?: StorageService) {
  const companies = companyService(db);
  const agents = agentService(db);
  const assetRecords = assetService(db);
  const instructions = agentInstructionsService();
  const access = accessService(db);
  const projects = projectService(db);
  const issues = issueService(db);
  const companySkills = companySkillService(db);
  const exportDeps: PortabilityExportDeps = { agents, assetRecords, companies, companySkills, db, instructions, storage };

  async function resolveSource(source: CompanyPortabilityPreview["source"]): Promise<ResolvedSource> {
    if (source.type === "inline") {
      return buildManifestFromPackageFiles(
        normalizeFileMap(source.files, source.rootPath),
      );
    }

    const parsed = parseGitHubSourceUrl(source.url);
    let ref = parsed.ref;
    const warnings: string[] = [];
    const companyRelativePath = parsed.companyPath === "COMPANY.md"
      ? [parsed.basePath, "COMPANY.md"].filter(Boolean).join("/")
      : parsed.companyPath;
    let companyMarkdown: string | null = null;
    try {
      companyMarkdown = await fetchOptionalText(
        resolveRawGitHubUrl(parsed.owner, parsed.repo, ref, companyRelativePath),
      );
    } catch (err) {
      if (ref === "main") {
        ref = "master";
        warnings.push("GitHub ref main not found; falling back to master.");
        companyMarkdown = await fetchOptionalText(
          resolveRawGitHubUrl(parsed.owner, parsed.repo, ref, companyRelativePath),
        );
      } else {
        throw err;
      }
    }
    if (!companyMarkdown) {
      throw unprocessable("GitHub company package is missing COMPANY.md");
    }

    const companyPath = parsed.companyPath === "COMPANY.md"
      ? "COMPANY.md"
      : normalizePortablePath(path.posix.relative(parsed.basePath || ".", parsed.companyPath));
    const files: Record<string, CompanyPortabilityFileEntry> = {
      [companyPath]: companyMarkdown,
    };
    const tree = await fetchJson<{ tree?: Array<{ path: string; type: string }> }>(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${ref}?recursive=1`,
    ).catch(() => ({ tree: [] }));
    const basePrefix = parsed.basePath ? `${parsed.basePath.replace(/^\/+|\/+$/g, "")}/` : "";
    const candidatePaths = (tree.tree ?? [])
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path)
      .filter((entry): entry is string => typeof entry === "string")
      .filter((entry) => {
        if (basePrefix && !entry.startsWith(basePrefix)) return false;
        const relative = basePrefix ? entry.slice(basePrefix.length) : entry;
        return (
          relative.endsWith(".md") ||
          relative.startsWith("skills/") ||
          relative === ".paperclip.yaml" ||
          relative === ".paperclip.yml"
        );
      });
    for (const repoPath of candidatePaths) {
      const relativePath = basePrefix ? repoPath.slice(basePrefix.length) : repoPath;
      if (files[relativePath] !== undefined) continue;
      files[normalizePortablePath(relativePath)] = await fetchText(
        resolveRawGitHubUrl(parsed.owner, parsed.repo, ref, repoPath),
      );
    }
    const companyDoc = parsePackagedFrontmatter(companyMarkdown, companyPath, warnings);
    const includeEntries = readIncludeEntries(companyDoc.frontmatter);
    for (const includeEntry of includeEntries) {
      const repoPath = [parsed.basePath, includeEntry.path].filter(Boolean).join("/");
      const relativePath = normalizePortablePath(includeEntry.path);
      if (files[relativePath] !== undefined) continue;
      if (!(repoPath.endsWith(".md") || repoPath.endsWith(".yaml") || repoPath.endsWith(".yml"))) continue;
      files[relativePath] = await fetchText(
        resolveRawGitHubUrl(parsed.owner, parsed.repo, ref, repoPath),
      );
    }

    const resolved = buildManifestFromPackageFiles(files);
    const companyLogoPath = resolved.manifest.company?.logoPath;
    if (companyLogoPath && !resolved.files[companyLogoPath]) {
      const repoPath = [parsed.basePath, companyLogoPath].filter(Boolean).join("/");
      try {
        const binary = await fetchBinary(
          resolveRawGitHubUrl(parsed.owner, parsed.repo, ref, repoPath),
        );
        resolved.files[companyLogoPath] = bufferToPortableBinaryFile(binary, inferContentTypeFromPath(companyLogoPath));
      } catch (err) {
        warnings.push(`Failed to fetch company logo ${companyLogoPath} from GitHub: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    resolved.warnings.unshift(...warnings);
    return resolved;
  }

  async function buildPreview(
    input: CompanyPortabilityPreview,
    options?: ImportBehaviorOptions,
  ): Promise<ImportPlanInternal> {
    const mode = resolveImportMode(options);
    const requestedInclude = normalizeInclude(input.include);
    const source = applySelectedFilesToSource(await resolveSource(input.source), input.selectedFiles);
    const manifest = source.manifest;
    const include: CompanyPortabilityInclude = {
      company: requestedInclude.company && manifest.company !== null,
      agents: requestedInclude.agents && manifest.agents.length > 0,
      projects: requestedInclude.projects && manifest.projects.length > 0,
      issues: requestedInclude.issues && manifest.issues.length > 0,
      skills: requestedInclude.skills && manifest.skills.length > 0,
    };
    const collisionStrategy = input.collisionStrategy ?? DEFAULT_COLLISION_STRATEGY;
    if (mode === "agent_safe" && collisionStrategy === "replace") {
      throw unprocessable("Safe import routes do not allow replace collision strategy.");
    }
    const warnings = [...source.warnings];
    const errors: string[] = [];

    if (include.company && !manifest.company) {
      errors.push("Manifest does not include company metadata.");
    }

    const selectedSlugs = include.agents
      ? (
          input.agents && input.agents !== "all"
            ? Array.from(new Set(input.agents))
            : manifest.agents.map((agent) => agent.slug)
        )
      : [];

    const selectedAgents = include.agents
      ? manifest.agents.filter((agent) => selectedSlugs.includes(agent.slug))
      : [];
    const selectedMissing = selectedSlugs.filter((slug) => !manifest.agents.some((agent) => agent.slug === slug));
    for (const missing of selectedMissing) {
      errors.push(`Selected agent slug not found in manifest: ${missing}`);
    }

    if (include.agents && selectedAgents.length === 0) {
      warnings.push("No agents selected for import.");
    }

    const availableSkillKeys = new Set(source.manifest.skills.map((skill) => skill.key));
    const availableSkillSlugs = new Map<string, CompanyPortabilitySkillManifestEntry[]>();
    for (const skill of source.manifest.skills) {
      const existing = availableSkillSlugs.get(skill.slug) ?? [];
      existing.push(skill);
      availableSkillSlugs.set(skill.slug, existing);
    }

    for (const agent of selectedAgents) {
      const filePath = ensureMarkdownPath(agent.path);
      const markdown = readPortableTextFile(source.files, filePath);
      if (typeof markdown !== "string") {
        errors.push(`Missing markdown file for agent ${agent.slug}: ${filePath}`);
        continue;
      }
      const parsed = parsePackagedFrontmatter(markdown, filePath, warnings);
      if (parsed.frontmatter.kind && parsed.frontmatter.kind !== "agent") {
        warnings.push(`Agent markdown ${filePath} does not declare kind: agent in frontmatter.`);
      }
      for (const skillRef of agent.skills) {
        const slugMatches = availableSkillSlugs.get(skillRef) ?? [];
        if (!availableSkillKeys.has(skillRef) && slugMatches.length !== 1) {
          warnings.push(`Agent ${agent.slug} references skill ${skillRef}, but that skill is not present in the package.`);
        }
      }
    }

    if (include.projects) {
      for (const project of manifest.projects) {
        const markdown = readPortableTextFile(source.files, ensureMarkdownPath(project.path));
        if (typeof markdown !== "string") {
          errors.push(`Missing markdown file for project ${project.slug}: ${project.path}`);
          continue;
        }
        const parsed = parsePackagedFrontmatter(markdown, project.path, warnings);
        if (parsed.frontmatter.kind && parsed.frontmatter.kind !== "project") {
          warnings.push(`Project markdown ${project.path} does not declare kind: project in frontmatter.`);
        }
      }
    }

    if (include.issues) {
      for (const issue of manifest.issues) {
        const markdown = readPortableTextFile(source.files, ensureMarkdownPath(issue.path));
        if (typeof markdown !== "string") {
          errors.push(`Missing markdown file for task ${issue.slug}: ${issue.path}`);
          continue;
        }
        const parsed = parsePackagedFrontmatter(markdown, issue.path, warnings);
        if (parsed.frontmatter.kind && parsed.frontmatter.kind !== "task") {
          warnings.push(`Task markdown ${issue.path} does not declare kind: task in frontmatter.`);
        }
        if (issue.recurrence) {
          warnings.push(`Task ${issue.slug} has recurrence metadata; Paperclip will import it as a one-time issue for now.`);
        }
      }
    }

    for (const envInput of manifest.envInputs) {
      if (envInput.portability === "system_dependent") {
        warnings.push(`Environment input ${envInput.key}${envInput.agentSlug ? ` for ${envInput.agentSlug}` : ""} is system-dependent and may need manual adjustment after import.`);
      }
    }

    let targetCompanyId: string | null = null;
    let targetCompanyName: string | null = null;

    if (input.target.mode === "existing_company") {
      const targetCompany = await companies.getById(input.target.companyId);
      if (!targetCompany) throw notFound("Target company not found");
      targetCompanyId = targetCompany.id;
      targetCompanyName = targetCompany.name;
    }

    const agentPlans: CompanyPortabilityPreviewAgentPlan[] = [];
    const existingSlugToAgent = new Map<string, { id: string; name: string }>();
    const existingSlugs = new Set<string>();
    const projectPlans: CompanyPortabilityPreviewResult["plan"]["projectPlans"] = [];
    const issuePlans: CompanyPortabilityPreviewResult["plan"]["issuePlans"] = [];
    const existingProjectSlugToProject = new Map<string, { id: string; name: string }>();
    const existingProjectSlugs = new Set<string>();

    if (input.target.mode === "existing_company") {
      const existingAgents = await agents.list(input.target.companyId);
      for (const existing of existingAgents) {
        const slug = normalizeAgentUrlKey(existing.name) ?? existing.id;
        if (!existingSlugToAgent.has(slug)) existingSlugToAgent.set(slug, existing);
        existingSlugs.add(slug);
      }
      const existingProjects = await projects.list(input.target.companyId);
      for (const existing of existingProjects) {
        if (!existingProjectSlugToProject.has(existing.urlKey)) {
          existingProjectSlugToProject.set(existing.urlKey, { id: existing.id, name: existing.name });
        }
        existingProjectSlugs.add(existing.urlKey);
      }

      const existingSkills = await companySkills.listFull(input.target.companyId);
      const existingSkillKeys = new Set(existingSkills.map((skill) => skill.key));
      const existingSkillSlugs = new Set(existingSkills.map((skill) => normalizeSkillSlug(skill.slug) ?? skill.slug));
      for (const skill of manifest.skills) {
        const skillSlug = normalizeSkillSlug(skill.slug) ?? skill.slug;
        if (existingSkillKeys.has(skill.key) || existingSkillSlugs.has(skillSlug)) {
          if (mode === "agent_safe") {
            warnings.push(`Existing skill "${skill.slug}" matched during safe import and will ${collisionStrategy === "skip" ? "be skipped" : "be renamed"} instead of overwritten.`);
          } else if (collisionStrategy === "replace") {
            warnings.push(`Existing skill "${skill.slug}" (${skill.key}) will be overwritten by import.`);
          }
        }
      }
    }

    for (const manifestAgent of selectedAgents) {
      const existing = existingSlugToAgent.get(manifestAgent.slug) ?? null;
      if (!existing) {
        agentPlans.push({
          slug: manifestAgent.slug,
          action: "create",
          plannedName: manifestAgent.name,
          existingAgentId: null,
          reason: null,
        });
        continue;
      }

      if (mode === "board_full" && collisionStrategy === "replace") {
        agentPlans.push({
          slug: manifestAgent.slug,
          action: "update",
          plannedName: existing.name,
          existingAgentId: existing.id,
          reason: "Existing slug matched; replace strategy.",
        });
        continue;
      }

      if (collisionStrategy === "skip") {
        agentPlans.push({
          slug: manifestAgent.slug,
          action: "skip",
          plannedName: existing.name,
          existingAgentId: existing.id,
          reason: "Existing slug matched; skip strategy.",
        });
        continue;
      }

      const renamed = uniqueNameBySlug(manifestAgent.name, existingSlugs);
      existingSlugs.add(normalizeAgentUrlKey(renamed) ?? manifestAgent.slug);
      agentPlans.push({
        slug: manifestAgent.slug,
        action: "create",
        plannedName: renamed,
        existingAgentId: existing.id,
        reason: "Existing slug matched; rename strategy.",
      });
    }

    if (include.projects) {
      for (const manifestProject of manifest.projects) {
        const existing = existingProjectSlugToProject.get(manifestProject.slug) ?? null;
        if (!existing) {
          projectPlans.push({
            slug: manifestProject.slug,
            action: "create",
            plannedName: manifestProject.name,
            existingProjectId: null,
            reason: null,
          });
          continue;
        }
        if (mode === "board_full" && collisionStrategy === "replace") {
          projectPlans.push({
            slug: manifestProject.slug,
            action: "update",
            plannedName: existing.name,
            existingProjectId: existing.id,
            reason: "Existing slug matched; replace strategy.",
          });
          continue;
        }
        if (collisionStrategy === "skip") {
          projectPlans.push({
            slug: manifestProject.slug,
            action: "skip",
            plannedName: existing.name,
            existingProjectId: existing.id,
            reason: "Existing slug matched; skip strategy.",
          });
          continue;
        }
        const renamed = uniqueProjectName(manifestProject.name, existingProjectSlugs);
        existingProjectSlugs.add(deriveProjectUrlKey(renamed, renamed));
        projectPlans.push({
          slug: manifestProject.slug,
          action: "create",
          plannedName: renamed,
          existingProjectId: existing.id,
          reason: "Existing slug matched; rename strategy.",
        });
      }
    }

    // Apply user-specified name overrides (keyed by slug)
    if (input.nameOverrides) {
      for (const ap of agentPlans) {
        const override = input.nameOverrides[ap.slug];
        if (override) {
          ap.plannedName = override;
        }
      }
      for (const pp of projectPlans) {
        const override = input.nameOverrides[pp.slug];
        if (override) {
          pp.plannedName = override;
        }
      }
      for (const ip of issuePlans) {
        const override = input.nameOverrides[ip.slug];
        if (override) {
          ip.plannedTitle = override;
        }
      }
    }

    // Warn about agents that will be overwritten/updated
    for (const ap of agentPlans) {
      if (ap.action === "update") {
        warnings.push(`Existing agent "${ap.plannedName}" (${ap.slug}) will be overwritten by import.`);
      }
    }

    // Warn about projects that will be overwritten/updated
    for (const pp of projectPlans) {
      if (pp.action === "update") {
        warnings.push(`Existing project "${pp.plannedName}" (${pp.slug}) will be overwritten by import.`);
      }
    }

    if (include.issues) {
      for (const manifestIssue of manifest.issues) {
        issuePlans.push({
          slug: manifestIssue.slug,
          action: "create",
          plannedTitle: manifestIssue.title,
          reason: manifestIssue.recurrence ? "Recurrence will not be activated on import." : null,
        });
      }
    }

    const preview: CompanyPortabilityPreviewResult = {
      include,
      targetCompanyId,
      targetCompanyName,
      collisionStrategy,
      selectedAgentSlugs: selectedAgents.map((agent) => agent.slug),
      plan: {
        companyAction: input.target.mode === "new_company"
          ? "create"
          : include.company && mode === "board_full"
            ? "update"
            : "none",
        agentPlans,
        projectPlans,
        issuePlans,
      },
      manifest,
      files: source.files,
      envInputs: manifest.envInputs ?? [],
      warnings,
      errors,
    };

    return {
      preview,
      source,
      include,
      collisionStrategy,
      selectedAgents,
    };
  }

  async function previewImport(
    input: CompanyPortabilityPreview,
    options?: ImportBehaviorOptions,
  ): Promise<CompanyPortabilityPreviewResult> {
    const plan = await buildPreview(input, options);
    return plan.preview;
  }

  async function importBundle(
    input: CompanyPortabilityImport,
    actorUserId: string | null | undefined,
    options?: ImportBehaviorOptions,
  ): Promise<CompanyPortabilityImportResult> {
    const mode = resolveImportMode(options);
    const plan = await buildPreview(input, options);
    if (plan.preview.errors.length > 0) {
      throw unprocessable(`Import preview has errors: ${plan.preview.errors.join("; ")}`);
    }
    if (
      mode === "agent_safe"
      && (
        plan.preview.plan.companyAction === "update"
        || plan.preview.plan.agentPlans.some((entry) => entry.action === "update")
        || plan.preview.plan.projectPlans.some((entry) => entry.action === "update")
      )
    ) {
      throw unprocessable("Safe import routes only allow create or skip actions.");
    }

    const sourceManifest = plan.source.manifest;
    const warnings = [...plan.preview.warnings];
    const include = plan.include;

    let targetCompany: { id: string; name: string } | null = null;
    let companyAction: "created" | "updated" | "unchanged" = "unchanged";

    if (input.target.mode === "new_company") {
      if (mode === "agent_safe" && !options?.sourceCompanyId) {
        throw unprocessable("Safe new-company imports require a source company context.");
      }
      if (mode === "agent_safe" && options?.sourceCompanyId) {
        const sourceMemberships = await access.listActiveUserMemberships(options.sourceCompanyId);
        if (sourceMemberships.length === 0) {
          throw unprocessable("Safe new-company import requires at least one active user membership on the source company.");
        }
      }
      const companyName =
        asString(input.target.newCompanyName) ??
        sourceManifest.company?.name ??
        sourceManifest.source?.companyName ??
        "Imported Company";
      const created = await companies.create({
        name: companyName,
        description: include.company ? (sourceManifest.company?.description ?? null) : null,
        brandColor: include.company ? (sourceManifest.company?.brandColor ?? null) : null,
        requireBoardApprovalForNewAgents: include.company
          ? (sourceManifest.company?.requireBoardApprovalForNewAgents ?? true)
          : true,
      });
      if (mode === "agent_safe" && options?.sourceCompanyId) {
        await access.copyActiveUserMemberships(options.sourceCompanyId, created.id);
      } else {
        await access.ensureMembership(created.id, "user", actorUserId ?? "board", "owner", "active");
      }
      targetCompany = created;
      companyAction = "created";
    } else {
      targetCompany = await companies.getById(input.target.companyId);
      if (!targetCompany) throw notFound("Target company not found");
      if (include.company && sourceManifest.company && mode === "board_full") {
        const updated = await companies.update(targetCompany.id, {
          name: sourceManifest.company.name,
          description: sourceManifest.company.description,
          brandColor: sourceManifest.company.brandColor,
          requireBoardApprovalForNewAgents: sourceManifest.company.requireBoardApprovalForNewAgents,
        });
        targetCompany = updated ?? targetCompany;
        companyAction = "updated";
      }
    }

    if (!targetCompany) throw notFound("Target company not found");

    if (include.company) {
      const logoPath = sourceManifest.company?.logoPath ?? null;
      if (!logoPath) {
        const cleared = await companies.update(targetCompany.id, { logoAssetId: null });
        targetCompany = cleared ?? targetCompany;
      } else {
        const logoFile = plan.source.files[logoPath];
        if (!logoFile) {
          warnings.push(`Skipped company logo import because ${logoPath} is missing from the package.`);
        } else if (!storage) {
          warnings.push("Skipped company logo import because storage is unavailable.");
        } else {
          const contentType = isPortableBinaryFile(logoFile)
            ? (logoFile.contentType ?? inferContentTypeFromPath(logoPath))
            : inferContentTypeFromPath(logoPath);
          if (!contentType || !COMPANY_LOGO_CONTENT_TYPE_EXTENSIONS[contentType]) {
            warnings.push(`Skipped company logo import for ${logoPath} because the file type is unsupported.`);
          } else {
            try {
              const body = portableFileToBuffer(logoFile, logoPath);
              const stored = await storage.putFile({
                companyId: targetCompany.id,
                namespace: "assets/companies",
                originalFilename: path.posix.basename(logoPath),
                contentType,
                body,
              });
              const createdAsset = await assetRecords.create(targetCompany.id, {
                provider: stored.provider,
                objectKey: stored.objectKey,
                contentType: stored.contentType,
                byteSize: stored.byteSize,
                sha256: stored.sha256,
                originalFilename: stored.originalFilename,
                createdByAgentId: null,
                createdByUserId: actorUserId ?? null,
              });
              const updated = await companies.update(targetCompany.id, {
                logoAssetId: createdAsset.id,
              });
              targetCompany = updated ?? targetCompany;
            } catch (err) {
              warnings.push(`Failed to import company logo ${logoPath}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }
    }

    const resultAgents: CompanyPortabilityImportResult["agents"] = [];
    const importedSlugToAgentId = new Map<string, string>();
    const existingSlugToAgentId = new Map<string, string>();
    const existingAgents = await agents.list(targetCompany.id);
    for (const existing of existingAgents) {
      existingSlugToAgentId.set(normalizeAgentUrlKey(existing.name) ?? existing.id, existing.id);
    }
    const importedSlugToProjectId = new Map<string, string>();
    const existingProjectSlugToId = new Map<string, string>();
    const existingProjects = await projects.list(targetCompany.id);
    for (const existing of existingProjects) {
      existingProjectSlugToId.set(existing.urlKey, existing.id);
    }

    const importedSkills = include.skills || include.agents
      ? await companySkills.importPackageFiles(targetCompany.id, pickTextFiles(plan.source.files), {
          onConflict: resolveSkillConflictStrategy(mode, plan.collisionStrategy),
        })
      : [];
    const desiredSkillRefMap = new Map<string, string>();
    for (const importedSkill of importedSkills) {
      desiredSkillRefMap.set(importedSkill.originalKey, importedSkill.skill.key);
      desiredSkillRefMap.set(importedSkill.originalSlug, importedSkill.skill.key);
      if (importedSkill.action === "skipped") {
        warnings.push(`Skipped skill ${importedSkill.originalSlug}; existing skill ${importedSkill.skill.slug} was kept.`);
      } else if (importedSkill.originalKey !== importedSkill.skill.key) {
        warnings.push(`Imported skill ${importedSkill.originalSlug} as ${importedSkill.skill.slug} to avoid overwriting an existing skill.`);
      }
    }

    if (include.agents) {
      for (const planAgent of plan.preview.plan.agentPlans) {
        const manifestAgent = plan.selectedAgents.find((agent) => agent.slug === planAgent.slug);
        if (!manifestAgent) continue;
        if (planAgent.action === "skip") {
          resultAgents.push({
            slug: planAgent.slug,
            id: planAgent.existingAgentId,
            action: "skipped",
            name: planAgent.plannedName,
            reason: planAgent.reason,
          });
          continue;
        }

        const bundlePrefix = `agents/${manifestAgent.slug}/`;
        const bundleFiles = Object.fromEntries(
          Object.entries(plan.source.files)
            .filter(([filePath]) => filePath.startsWith(bundlePrefix))
            .flatMap(([filePath, content]) => typeof content === "string"
              ? [[normalizePortablePath(filePath.slice(bundlePrefix.length)), content] as const]
              : []),
        );
        const markdownRaw = bundleFiles["AGENTS.md"] ?? readPortableTextFile(plan.source.files, manifestAgent.path);
        const fallbackPromptTemplate = asString(mergeAgentConfig(manifestAgent).promptTemplate) || "";
        if (!markdownRaw && fallbackPromptTemplate) {
          bundleFiles["AGENTS.md"] = fallbackPromptTemplate;
        }
        if (!markdownRaw && !fallbackPromptTemplate) {
          warnings.push(`Missing AGENTS markdown for ${manifestAgent.slug}; imported with an empty managed bundle.`);
        }

        // Apply adapter overrides from request if present
        const adapterOverride = input.adapterOverrides?.[planAgent.slug];
        const effectiveAdapterType = adapterOverride?.adapterType ?? manifestAgent.adapterType;
        const baseAdapterConfig = adapterOverride?.adapterConfig
          ? { ...adapterOverride.adapterConfig }
          : { ...manifestAgent.adapterConfig } as Record<string, unknown>;

        const desiredSkills = (manifestAgent.skills ?? []).map((skillRef) => desiredSkillRefMap.get(skillRef) ?? skillRef);
        const adapterConfigWithSkills = writePaperclipSkillSyncPreference(
          baseAdapterConfig,
          desiredSkills,
        );
        delete adapterConfigWithSkills.promptTemplate;
        delete adapterConfigWithSkills.bootstrapPromptTemplate;
        delete adapterConfigWithSkills.instructionsFilePath;
        delete adapterConfigWithSkills.instructionsBundleMode;
        delete adapterConfigWithSkills.instructionsRootPath;
        delete adapterConfigWithSkills.instructionsEntryFile;
        // cwd/agentsMdPath are NOT stripped here: the agent-level normalizer in
        // agentService.create/update routes them into agentConfig on persist.
        const patch = {
          name: planAgent.plannedName,
          role: manifestAgent.role,
          title: manifestAgent.title,
          icon: manifestAgent.icon,
          capabilities: manifestAgent.capabilities,
          reportsTo: null,
          adapterType: effectiveAdapterType,
          adapterConfig: adapterConfigWithSkills,
          runtimeConfig: manifestAgent.runtimeConfig,
          budgetMonthlyCents: manifestAgent.budgetMonthlyCents,
          permissions: manifestAgent.permissions,
          metadata: manifestAgent.metadata,
        };

        if (planAgent.action === "update" && planAgent.existingAgentId) {
          let updated = await agents.update(planAgent.existingAgentId, patch);
          if (!updated) {
            warnings.push(`Skipped update for missing agent ${planAgent.existingAgentId}.`);
            resultAgents.push({
              slug: planAgent.slug,
              id: null,
              action: "skipped",
              name: planAgent.plannedName,
              reason: "Existing target agent not found.",
            });
            continue;
          }
          try {
            const materialized = await instructions.materializeManagedBundle(updated, bundleFiles, {
              clearLegacyPromptTemplate: true,
              replaceExisting: true,
            });
            updated = await agents.update(updated.id, { adapterConfig: materialized.adapterConfig }) ?? updated;
          } catch (err) {
            warnings.push(`Failed to materialize instructions bundle for ${manifestAgent.slug}: ${err instanceof Error ? err.message : String(err)}`);
          }
          importedSlugToAgentId.set(planAgent.slug, updated.id);
          existingSlugToAgentId.set(normalizeAgentUrlKey(updated.name) ?? updated.id, updated.id);
          resultAgents.push({
            slug: planAgent.slug,
            id: updated.id,
            action: "updated",
            name: updated.name,
            reason: planAgent.reason,
          });
          continue;
        }

        let created = await agents.create(targetCompany.id, patch);
        await access.ensureMembership(targetCompany.id, "agent", created.id, "member", "active");
        await access.setPrincipalPermission(
          targetCompany.id,
          "agent",
          created.id,
          "tasks:assign",
          true,
          actorUserId ?? null,
        );
        try {
          const materialized = await instructions.materializeManagedBundle(created, bundleFiles, {
            clearLegacyPromptTemplate: true,
            replaceExisting: true,
          });
          created = await agents.update(created.id, { adapterConfig: materialized.adapterConfig }) ?? created;
        } catch (err) {
          warnings.push(`Failed to materialize instructions bundle for ${manifestAgent.slug}: ${err instanceof Error ? err.message : String(err)}`);
        }
        importedSlugToAgentId.set(planAgent.slug, created.id);
        existingSlugToAgentId.set(normalizeAgentUrlKey(created.name) ?? created.id, created.id);
        resultAgents.push({
          slug: planAgent.slug,
          id: created.id,
          action: "created",
          name: created.name,
          reason: planAgent.reason,
        });
      }

      // Apply reporting links once all imported agent ids are available.
      for (const manifestAgent of plan.selectedAgents) {
        const agentId = importedSlugToAgentId.get(manifestAgent.slug);
        if (!agentId) continue;
        const managerSlug = manifestAgent.reportsToSlug;
        if (!managerSlug) continue;
        const managerId = importedSlugToAgentId.get(managerSlug) ?? existingSlugToAgentId.get(managerSlug) ?? null;
        if (!managerId || managerId === agentId) continue;
        try {
          await agents.update(agentId, { reportsTo: managerId });
        } catch {
          warnings.push(`Could not assign manager ${managerSlug} for imported agent ${manifestAgent.slug}.`);
        }
      }
    }

    if (include.projects) {
      for (const planProject of plan.preview.plan.projectPlans) {
        const manifestProject = sourceManifest.projects.find((project) => project.slug === planProject.slug);
        if (!manifestProject) continue;
        if (planProject.action === "skip") continue;

        const projectLeadAgentId = manifestProject.leadAgentSlug
          ? importedSlugToAgentId.get(manifestProject.leadAgentSlug)
            ?? existingSlugToAgentId.get(manifestProject.leadAgentSlug)
            ?? null
          : null;
        const projectPatch = {
          name: planProject.plannedName,
          description: manifestProject.description,
          leadAgentId: projectLeadAgentId,
          targetDate: manifestProject.targetDate,
          color: manifestProject.color,
          status: manifestProject.status && PROJECT_STATUSES.includes(manifestProject.status as any)
            ? manifestProject.status as typeof PROJECT_STATUSES[number]
            : "backlog",
          executionWorkspacePolicy: manifestProject.executionWorkspacePolicy,
        };

        if (planProject.action === "update" && planProject.existingProjectId) {
          const updated = await projects.update(planProject.existingProjectId, projectPatch);
          if (!updated) {
            warnings.push(`Skipped update for missing project ${planProject.existingProjectId}.`);
            continue;
          }
          importedSlugToProjectId.set(planProject.slug, updated.id);
          existingProjectSlugToId.set(updated.urlKey, updated.id);
          continue;
        }

        const created = await projects.create(targetCompany.id, projectPatch);
        importedSlugToProjectId.set(planProject.slug, created.id);
        existingProjectSlugToId.set(created.urlKey, created.id);
      }
    }

    if (include.issues) {
      for (const manifestIssue of sourceManifest.issues) {
        const markdownRaw = readPortableTextFile(plan.source.files, manifestIssue.path);
        const parsed = markdownRaw ? parsePackagedFrontmatter(markdownRaw, manifestIssue.path, warnings) : null;
        const description = parsed?.body || manifestIssue.description || null;
        const assigneeAgentId = manifestIssue.assigneeAgentSlug
          ? importedSlugToAgentId.get(manifestIssue.assigneeAgentSlug)
            ?? existingSlugToAgentId.get(manifestIssue.assigneeAgentSlug)
            ?? null
          : null;
        const projectId = manifestIssue.projectSlug
          ? importedSlugToProjectId.get(manifestIssue.projectSlug)
            ?? existingProjectSlugToId.get(manifestIssue.projectSlug)
            ?? null
          : null;
        await issues.create(targetCompany.id, {
          projectId,
          title: manifestIssue.title,
          description,
          assigneeAgentId,
          status: manifestIssue.status && ISSUE_STATUSES.includes(manifestIssue.status as any)
            ? manifestIssue.status as typeof ISSUE_STATUSES[number]
            : "backlog",
          priority: manifestIssue.priority && ISSUE_PRIORITIES.includes(manifestIssue.priority as any)
            ? manifestIssue.priority as typeof ISSUE_PRIORITIES[number]
            : "medium",
          billingCode: manifestIssue.billingCode,
          assigneeAdapterOverrides: manifestIssue.assigneeAdapterOverrides,
          executionWorkspaceSettings: manifestIssue.executionWorkspaceSettings,
          labelIds: [],
        });
        if (manifestIssue.recurrence) {
          warnings.push(`Imported task ${manifestIssue.slug} as a one-time issue; recurrence metadata was not activated.`);
        }
      }
    }

    return {
      company: {
        id: targetCompany.id,
        name: targetCompany.name,
        action: companyAction,
      },
      agents: resultAgents,
      envInputs: sourceManifest.envInputs ?? [],
      warnings,
    };
  }

  return {
    exportBundle: (companyId: string, input: CompanyPortabilityExport) => exportBundle(exportDeps, companyId, input),
    previewExport: (companyId: string, input: CompanyPortabilityExport) => previewExport(exportDeps, companyId, input),
    previewImport,
    importBundle,
  };
}

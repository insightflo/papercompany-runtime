import { unprocessable } from "../errors.js";
import { isPlainRecord, buildMarkdown } from "./company-portability-yaml.js";
import { parseYamlFile, parseFrontmatterMarkdown } from "./company-portability-yaml-parse.js";
import type { CompanyPackageIncludeEntry } from "./company-portability-types.js";
import { resolvePortablePath } from "./company-portability-files.js";
import { asString, PORTABLE_CONFIG_STRIP_KEYS } from "./company-portability-normalize.js";
import { normalizeSkillKey } from "./company-portability-skill-export.js";

export function normalizePortableConfig(
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(input)) {
    if (PORTABLE_CONFIG_STRIP_KEYS.has(key)) continue;
    next[key] = entry;
  }

  return next;
}

export function filterCompanyMarkdownIncludes(
  companyPath: string,
  markdown: string,
  selectedFiles: Set<string>,
) {
  let parsed: ReturnType<typeof parseFrontmatterMarkdown>;
  try {
    parsed = parseFrontmatterMarkdown(markdown);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw unprocessable(`Company package file ${companyPath} has invalid YAML frontmatter: ${reason}`);
  }
  const includeEntries = readIncludeEntries(parsed.frontmatter);
  const filteredIncludes = includeEntries.filter((entry) =>
    selectedFiles.has(resolvePortablePath(companyPath, entry.path)),
  );
  const nextFrontmatter: Record<string, unknown> = { ...parsed.frontmatter };
  if (filteredIncludes.length > 0) {
    nextFrontmatter.includes = filteredIncludes.map((entry) => entry.path);
  } else {
    delete nextFrontmatter.includes;
  }
  return buildMarkdown(nextFrontmatter, parsed.body);
}

export function readCompanyApprovalDefault(_frontmatter: Record<string, unknown>) {
  return true;
}

export function readIncludeEntries(frontmatter: Record<string, unknown>): CompanyPackageIncludeEntry[] {
  const includes = frontmatter.includes;
  if (!Array.isArray(includes)) return [];
  return includes.flatMap((entry) => {
    if (typeof entry === "string") {
      return [{ path: entry }];
    }
    if (isPlainRecord(entry)) {
      const pathValue = asString(entry.path);
      return pathValue ? [{ path: pathValue }] : [];
    }
    return [];
  });
}

export function readAgentSkillRefs(frontmatter: Record<string, unknown>, warnings: string[], agentSlug: string) {
  const skills = frontmatter.skills;
  if (skills === undefined) return [];
  if (!Array.isArray(skills)) {
    warnings.push(`Agent ${agentSlug} has invalid skills; expected a list of non-empty strings. The value was ignored.`);
    return [];
  }
  if (skills.some((entry) => typeof entry !== "string" || !entry.trim())) {
    warnings.push(`Agent ${agentSlug} has invalid skills; non-string or empty entries were ignored, valid entries were kept.`);
  }
  return [...new Set(skills.filter((entry): entry is string => typeof entry === "string")
    .map((entry) => normalizeSkillKey(entry) ?? entry.trim()).filter(Boolean))];
}

// Parses packaged markdown frontmatter with the standard YAML parser. Malformed
// frontmatter rejects the request (422) instead of silently dropping metadata,
// and parser warnings (e.g. unresolved tags, non-mapping documents) are surfaced
// through the preview/import warnings list.
export function parsePackagedFrontmatter(
  markdown: string,
  filePath: string,
  warnings: string[],
): { frontmatter: Record<string, unknown>; body: string } {
  let parsed: ReturnType<typeof parseFrontmatterMarkdown>;
  try {
    parsed = parseFrontmatterMarkdown(markdown);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw unprocessable(`Company package file ${filePath} has invalid YAML frontmatter: ${reason}`);
  }
  for (const warning of parsed.yamlWarnings) {
    warnings.push(`Company package file ${filePath} ${warning}`);
  }
  return { frontmatter: parsed.frontmatter, body: parsed.body };
}

// Same guard as parsePackagedFrontmatter for plain YAML files such as
// .paperclip.yaml: parse errors reject the request (422) and parser warnings
// surface through the preview/import warnings list.
export function parsePackagedYamlFile(
  raw: string,
  filePath: string,
  warnings: string[],
): Record<string, unknown> {
  try {
    const parsed = parseYamlFile(raw);
    for (const warning of parsed.warnings) {
      warnings.push(`Company package file ${filePath} ${warning}`);
    }
    return parsed.value;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw unprocessable(`Company package file ${filePath} is not valid YAML: ${reason}`);
  }
}

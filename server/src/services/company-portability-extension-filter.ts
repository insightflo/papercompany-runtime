import type { CompanyPortabilityFileEntry } from "@paperclipai/shared";
import { normalizePortablePath } from "./company-portability-files.js";

function collectSelectedExportSlugs(selectedFiles: Set<string>) {
  const agents = new Set<string>();
  const projects = new Set<string>();
  const tasks = new Set<string>();
  for (const filePath of selectedFiles) {
    const agentMatch = filePath.match(/^agents\/([^/]+)\//);
    if (agentMatch) agents.add(agentMatch[1]!);
    const projectMatch = filePath.match(/^projects\/([^/]+)\//);
    if (projectMatch) projects.add(projectMatch[1]!);
    const taskMatch = filePath.match(/^tasks\/([^/]+)\//);
    if (taskMatch) tasks.add(taskMatch[1]!);
  }
  return { agents, projects, tasks };
}

function filterPortableExtensionYaml(yaml: string, selectedFiles: Set<string>) {
  const selected = collectSelectedExportSlugs(selectedFiles);
  const lines = yaml.split("\n");
  const out: string[] = [];
  const filterableSections = new Set(["agents", "projects", "tasks"]);

  let currentSection: string | null = null;
  let currentEntry: string | null = null;
  let includeEntry = true;
  let sectionHeaderLine: string | null = null;
  let sectionBuffer: string[] = [];

  const flushSection = () => {
    if (sectionHeaderLine !== null && sectionBuffer.length > 0) {
      out.push(sectionHeaderLine);
      out.push(...sectionBuffer);
    }
    sectionHeaderLine = null;
    sectionBuffer = [];
  };

  for (const line of lines) {
    const topMatch = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
    if (topMatch && !line.startsWith(" ")) {
      flushSection();
      currentEntry = null;
      includeEntry = true;

      const key = topMatch[1]!;
      if (filterableSections.has(key)) {
        currentSection = key;
        sectionHeaderLine = line;
        continue;
      }

      currentSection = null;
      out.push(line);
      continue;
    }

    if (currentSection && filterableSections.has(currentSection)) {
      const entryMatch = line.match(/^  ([\w][\w-]*):\s*(.*)$/);
      if (entryMatch && !line.startsWith("    ")) {
        const slug = entryMatch[1]!;
        currentEntry = slug;
        const sectionSlugs = selected[currentSection as keyof typeof selected];
        includeEntry = sectionSlugs.has(slug);
        if (includeEntry) sectionBuffer.push(line);
        continue;
      }

      if (currentEntry !== null) {
        if (includeEntry) sectionBuffer.push(line);
        continue;
      }

      sectionBuffer.push(line);
      continue;
    }

    out.push(line);
  }

  flushSection();
  let filtered = out.join("\n");
  const logoPathMatch = filtered.match(/^\s{2}logoPath:\s*["']?([^"'\n]+)["']?\s*$/m);
  if (logoPathMatch && !selectedFiles.has(logoPathMatch[1]!)) {
    filtered = filtered.replace(/^\s{2}logoPath:\s*["']?([^"'\n]+)["']?\s*\n?/m, "");
  }
  return filtered;
}

export function filterExportFiles(
  files: Record<string, CompanyPortabilityFileEntry>,
  selectedFilesInput: string[] | undefined,
  paperclipExtensionPath: string,
) {
  if (!selectedFilesInput || selectedFilesInput.length === 0) {
    return files;
  }

  const selectedFiles = new Set(
    selectedFilesInput
      .map((entry) => normalizePortablePath(entry))
      .filter((entry) => entry.length > 0),
  );
  const filtered: Record<string, CompanyPortabilityFileEntry> = {};
  for (const [filePath, content] of Object.entries(files)) {
    if (!selectedFiles.has(filePath)) continue;
    filtered[filePath] = content;
  }

  const extensionEntry = filtered[paperclipExtensionPath];
  if (selectedFiles.has(paperclipExtensionPath) && typeof extensionEntry === "string") {
    filtered[paperclipExtensionPath] = filterPortableExtensionYaml(extensionEntry, selectedFiles);
  }

  return filtered;
}

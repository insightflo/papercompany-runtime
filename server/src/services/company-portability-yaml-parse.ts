import { parseDocument } from "yaml";
import { isPlainRecord } from "./company-portability-yaml.js";

type MarkdownDoc = {
  frontmatter: Record<string, unknown>;
  body: string;
  yamlWarnings: string[];
};

type ParsedYaml = {
  value: Record<string, unknown>;
  warnings: string[];
};

// Parses YAML with the standard `yaml` parser so flow sequences (`skills: [a, b]`),
// comments, block scalars, and quoted URLs are read exactly as written, and any
// malformed input raises instead of silently producing an empty document.
// Parser-level warnings (e.g. unresolved tags) are returned so callers can surface
// them instead of dropping the affected values without notice.
function readYamlDocument(raw: string): ParsedYaml {
  const document = parseDocument(raw, { logLevel: "silent" });
  if (document.errors.length > 0) {
    throw new Error(
      document.errors
        .map((issue) => {
          const at = issue.linePos?.[0]
            ? `line ${issue.linePos[0].line}:${issue.linePos[0].col}: `
            : "";
          return `${at}${issue.message}`;
        })
        .join("; "),
    );
  }
  const warnings = document.warnings.map((issue) => `YAML warning: ${issue.message}`);
  const value = document.toJS();
  if (!isPlainRecord(value)) {
    if (document.contents !== null) {
      warnings.push("YAML document is not a mapping; its entries were not read.");
    }
    return { value: {}, warnings };
  }
  return { value, warnings };
}

export function parseYamlFile(raw: string): ParsedYaml {
  return readYamlDocument(raw);
}

export function parseFrontmatterMarkdown(raw: string): MarkdownDoc {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized.trim(), yamlWarnings: [] };
  }
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) {
    return { frontmatter: {}, body: normalized.trim(), yamlWarnings: [] };
  }
  const frontmatterRaw = normalized.slice(4, closing).trim();
  const body = normalized.slice(closing + 5).trim();
  const parsed = readYamlDocument(frontmatterRaw);
  return { frontmatter: parsed.value, body, yamlWarnings: parsed.warnings };
}

export type ValidationVerdict = "pass" | "request_changes";

export interface ReadExplicitValidationVerdictOptions {
  allowLeadingVerdict?: boolean;
}

const VERDICT_LABEL = String.raw`REQUEST[_\s-]?CHANGES|PASS`;

function normalizeVerdictLabel(label: string): ValidationVerdict {
  return /^PASS$/iu.test(label.trim()) ? "pass" : "request_changes";
}

function normalizeVerdictLine(line: string): string {
  return line
    .replace(/^[>\s-]*#+\s*/u, "")
    .replace(/^[>\s-]*[-*]\s*/u, "")
    .replace(/[`*_]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function readVerdictFromLine(line: string): ValidationVerdict | null {
  const compact = normalizeVerdictLine(line);
  if (!compact) return null;
  if (new RegExp(String.raw`^PASS\s+or\s+REQUEST[_\s-]?CHANGES\b`, "iu").test(compact)) return null;

  const patterns = [
    new RegExp(String.raw`^(${VERDICT_LABEL})(?:\b|[\s:：—–-])`, "iu"),
    new RegExp(String.raw`^(?:verdict|decision|outcome|status|QA\s+verdict|판정|결론)\s*[:：=-]\s*(${VERDICT_LABEL})\b`, "iu"),
    new RegExp(String.raw`^validation\s+complete\s*[:：=-]\s*(${VERDICT_LABEL})\b`, "iu"),
    new RegExp(String.raw`^mission\s+validation\s+gate\s*[:：=-]\s*(REQUEST[_\s-]?CHANGES)\b`, "iu"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(compact);
    const label = match?.[1];
    if (label) return normalizeVerdictLabel(label);
  }
  return null;
}

export function readExplicitValidationVerdict(
  value: string | null | undefined,
  options: ReadExplicitValidationVerdictOptions = {},
): ValidationVerdict | null {
  if (!value) return null;
  const lines = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;

  const terminalVerdict = readVerdictFromLine(lines[lines.length - 1]!);
  if (terminalVerdict) return terminalVerdict;

  if (options.allowLeadingVerdict) {
    return readVerdictFromLine(lines[0]!);
  }
  return null;
}

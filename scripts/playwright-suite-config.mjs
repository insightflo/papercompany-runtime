import path from "node:path";
import { existsSync } from "node:fs";

function normalizeSuiteName(suiteName) {
  return String(suiteName ?? "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.?\//, "");
}

export function getPlaywrightSuiteConfigCandidates(suiteName) {
  const normalizedSuiteName = normalizeSuiteName(suiteName);
  if (!normalizedSuiteName) {
    throw new Error("Suite name is required to resolve Playwright config.");
  }

  return [
    path.join("tests", normalizedSuiteName, "playwright.config.ts"),
    path.join("paperclip-orginal", "tests", normalizedSuiteName, "playwright.config.ts"),
  ];
}

export function resolvePlaywrightSuiteConfigPath({ suiteName, cwd = process.cwd(), fileExists = existsSync }) {
  const context = resolvePlaywrightSuiteExecutionContext({ suiteName, cwd, fileExists });
  return context?.configPath ?? null;
}

export function resolvePlaywrightSuiteExecutionContext({
  suiteName,
  cwd = process.cwd(),
  fileExists = existsSync,
}) {
  const candidates = getPlaywrightSuiteConfigCandidates(suiteName);
  for (const candidate of candidates) {
    const absoluteCandidate = path.resolve(cwd, candidate);
    if (!fileExists(absoluteCandidate)) {
      continue;
    }
    const candidateSegments = candidate.split(path.sep);
    const usesNestedWorkspace = candidateSegments[0] === "paperclip-orginal";
    const commandCwd = usesNestedWorkspace ? path.resolve(cwd, "paperclip-orginal") : cwd;

    return {
      configPath: absoluteCandidate,
      configArg: path.relative(commandCwd, absoluteCandidate),
      commandCwd,
    };
  }
  return null;
}

export function normalizeForwardedPlaywrightArgs(args) {
  if (!Array.isArray(args)) {
    return [];
  }
  return args[0] === "--" ? args.slice(1) : args;
}
